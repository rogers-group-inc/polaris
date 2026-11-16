/**
 * tests/unit/arcgisWriteBackService.test.ts — the I/O half of the cable-run
 * write-back (services/arcgisWriteBackService.ts, business rules 184 + 185):
 * reading a layer, creating a Polaris layer, the stop / status / retry verbs,
 * and the push itself — the run table as the queue, the Polaris-ID lookup that
 * prevents a second add, per-feature results, transient vs refusing errors,
 * the version-guarded success, batching and the advisory lock.
 *
 * The pure half (URL / config / layer checks, featureFor) is pinned by
 * tests/unit/arcgisWriteBack.test.ts. ArcGIS itself is mocked at
 * arcgisService's request + token boundary; `pg` (the lock's side
 * connection) is mocked at the module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  const pgQuery = vi.fn();
  const pgConnect = vi.fn(async () => undefined);
  const pgEnd = vi.fn(async () => undefined);
  class PgClient {
    opts: unknown;
    constructor(opts: unknown) { this.opts = opts; }
    connect() { return pgConnect(); }
    query(...a: unknown[]) { return pgQuery(...a); }
    end() { return pgEnd(); }
  }
  return {
    arcgisRequest: vi.fn(),
    getArcgisToken: vi.fn(),
    clearArcgisTokenCache: vi.fn(),
    directUrl: { value: "" },
    pgQuery, pgConnect, pgEnd, PgClient,
  };
});

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock("../../src/utils/dbConnections.js", () => ({ getDirectDatabaseUrl: () => h.directUrl.value }));
vi.mock("pg", () => ({ default: { Client: h.PgClient } }));
vi.mock("../../src/services/arcgisService.js", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return {
    ...real,
    arcgisRequest: h.arcgisRequest,
    getArcgisToken: h.getArcgisToken,
    clearArcgisTokenCache: h.clearArcgisTokenCache,
  };
});

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { ArcgisError } from "../../src/services/arcgisService.js";
import {
  readLayer, createPolarisLayer, writeBackIntegration, writeBackStopped, writeBackStatus,
  retryFailed, syncWriteBack, kickWriteBack, POLARIS_FIELD_MAP, type WriteBackConfig,
} from "../../src/services/arcgisWriteBackService.js";

const LAYER = "https://services.example.com/abc/arcgis/rest/services/Telecom/FeatureServer/3";

const CFG: WriteBackConfig = {
  writeBackEnabled: true, authMode: "apiKey", apiToken: "k",
  featureLayerUrl: LAYER, fieldMap: { polarisId: "PID", name: "NAME" },
};

const RAW_LAYER = {
  name: "Routes", geometryType: "esriGeometryPolyline", hasZ: false, objectIdField: "OBJECTID",
  capabilities: "Create, Update,Delete,Query",
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID", alias: "OBJECTID" },
    { name: "PID", type: "esriFieldTypeString", alias: "Polaris", length: 64 },
    { name: "NAME", type: "esriFieldTypeString", length: 120 },
  ],
};

type Run = {
  id: string; name: string; medium: string; placement: string; points: unknown; notes: string;
  lengthM: number; updatedAt: Date; version: number; arcgisObjectId: number | null;
  deletedAt: Date | null; site: { hostname: string | null } | null;
};

function run(id: string, over: Partial<Run> = {}): Run {
  return {
    id, name: `Run ${id}`, medium: "fiber", placement: "trench", points: [[-85.7, 37.9], [-85.71, 37.91]],
    notes: "", lengthM: 10, updatedAt: new Date("2026-11-01T00:00:00Z"), version: 1,
    arcgisObjectId: null, deletedAt: null, site: { hostname: "FGT-HQ" }, ...over,
  };
}

/** Route arcgisRequest by URL: the layer description, /query and /applyEdits. */
function stubLayer(opts: {
  layer?: unknown;
  query?: (params: Record<string, string>) => unknown;
  applyEdits?: (params: Record<string, string>) => unknown;
} = {}) {
  h.arcgisRequest.mockImplementation(async (_cfg: unknown, url: string, o: { params?: Record<string, string> } = {}) => {
    if (url === LAYER) return opts.layer ?? RAW_LAYER;
    if (url.endsWith("/query")) return opts.query ? opts.query(o.params ?? {}) : { features: [] };
    if (url.endsWith("/applyEdits")) return opts.applyEdits ? opts.applyEdits(o.params ?? {}) : {};
    throw new Error(`unexpected ArcGIS call ${url}`);
  });
}

function callsTo(suffix: string) {
  return h.arcgisRequest.mock.calls.filter((c) => String(c[1]).endsWith(suffix));
}

function updateManyCalls() {
  return stubbed(prisma.cableRun.updateMany).mock.calls.map((c) => c[0]);
}

function stubQueue(runs: Run[], cfg: WriteBackConfig = CFG) {
  stubbed(prisma.integration.findMany).mockResolvedValue([{ id: "intg-1", name: "GIS", config: cfg }]);
  stubbed(prisma.cableRun.findMany).mockResolvedValue(runs);
  stubbed(prisma.cableRun.updateMany).mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) => ({
    count: args?.where?.id?.in ? args.where.id.in.length : 1,
  }));
  stubbed(prisma.cableRun.deleteMany).mockResolvedValue({ count: 1 });
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  h.arcgisRequest.mockReset();
  h.getArcgisToken.mockReset();
  h.getArcgisToken.mockResolvedValue("tok");
  h.clearArcgisTokenCache.mockReset();
  h.pgQuery.mockReset();
  h.pgConnect.mockClear();
  h.pgEnd.mockClear();
  h.directUrl.value = "";
});

// ─── readLayer ─────────────────────────────────────────────────────────────

describe("readLayer", () => {
  it("refuses an unusable layer URL with a 400 before any request", async () => {
    await expect(readLayer({ featureLayerUrl: "http://x.example.com/arcgis/rest/services/a/FeatureServer/0" }))
      .rejects.toMatchObject({ httpStatus: 400 });
    await expect(readLayer({})).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.arcgisRequest).not.toHaveBeenCalled();
    expect(h.getArcgisToken).not.toHaveBeenCalled();
  });

  it("trims a trailing slash and sends the integration's token", async () => {
    stubLayer();
    await readLayer({ ...CFG, featureLayerUrl: `  ${LAYER}/ ` });
    expect(h.arcgisRequest).toHaveBeenCalledWith(expect.anything(), LAYER, { token: "tok" });
  });

  it("maps fields: OID / GlobalID / editable:false are read-only, coded domains kept, nameless fields dropped", async () => {
    stubLayer({
      layer: {
        ...RAW_LAYER,
        fields: [
          { name: "OBJECTID", type: "esriFieldTypeOID" },
          { name: "GID", type: "esriFieldTypeGlobalID" },
          { name: "LOCKED", type: "esriFieldTypeString", editable: false },
          { name: "METHOD", type: "esriFieldTypeString", alias: "Method", length: 4,
            domain: { type: "codedValue", codedValues: [{ code: "UG", name: "Underground" }] } },
          { name: "RANGE", type: "esriFieldTypeInteger", domain: { type: "range" } },
          { type: "esriFieldTypeString" },
        ],
      },
    });
    const info = await readLayer(CFG);
    expect(info.fields.map((f) => f.name)).toEqual(["OBJECTID", "GID", "LOCKED", "METHOD", "RANGE"]);
    const by = Object.fromEntries(info.fields.map((f) => [f.name, f]));
    expect(by.OBJECTID.editable).toBe(false);
    expect(by.GID.editable).toBe(false);
    expect(by.LOCKED.editable).toBe(false);
    expect(by.METHOD).toEqual({ name: "METHOD", type: "esriFieldTypeString", alias: "Method", length: 4, editable: true,
      codedValues: [{ code: "UG", name: "Underground" }] });
    expect(by.RANGE.codedValues).toBeNull();
    expect(by.RANGE.length).toBeNull();
    expect(by.RANGE.alias).toBe("RANGE");
  });

  it("splits and trims capabilities, reads geometry and z", async () => {
    stubLayer({ layer: { ...RAW_LAYER, hasZ: true } });
    const info = await readLayer(CFG);
    expect(info.capabilities).toEqual(["Create", "Update", "Delete", "Query"]);
    expect(info.geometryType).toBe("esriGeometryPolyline");
    expect(info.hasZ).toBe(true);
    expect(info.name).toBe("Routes");
  });

  it("finds the object-id field from the field list, else falls back to OBJECTID", async () => {
    stubLayer({ layer: { ...RAW_LAYER, objectIdField: undefined, fields: [{ name: "FID", type: "esriFieldTypeOID" }] } });
    expect((await readLayer(CFG)).objectIdField).toBe("FID");
    stubLayer({ layer: { ...RAW_LAYER, objectIdField: undefined, fields: [] } });
    expect((await readLayer(CFG)).objectIdField).toBe("OBJECTID");
  });

  it("prefers the source spatial reference and its latestWkid; null when the layer names none", async () => {
    stubLayer({ layer: { ...RAW_LAYER, extent: { spatialReference: { wkid: 4326 } }, sourceSpatialReference: { wkid: 102100, latestWkid: 3857 } } });
    expect((await readLayer(CFG)).wkid).toBe(3857);
    stubLayer({ layer: { ...RAW_LAYER, extent: { spatialReference: { wkid: 4326 } } } });
    expect((await readLayer(CFG)).wkid).toBe(4326);
    stubLayer({ layer: { ...RAW_LAYER } });
    expect((await readLayer(CFG)).wkid).toBeNull();
  });

  it("an empty description reads as no geometry, no fields, no capabilities", async () => {
    stubLayer({ layer: {} });
    const info = await readLayer(CFG);
    expect(info).toEqual({ name: "", geometryType: "", hasZ: false, wkid: null, objectIdField: "OBJECTID", capabilities: [], fields: [] });
  });
});

// ─── createPolarisLayer ────────────────────────────────────────────────────

describe("createPolarisLayer", () => {
  const SERVICE = "https://services.example.com/abc/arcgis/rest/services/Polaris_Runs/FeatureServer";

  function stubPortal(opts: { user?: string | null; created?: Record<string, unknown> } = {}) {
    h.arcgisRequest.mockImplementation(async (_c: unknown, url: string) => {
      if (url.endsWith("/portals/self")) return opts.user === null ? {} : { user: { username: opts.user ?? "gis admin" } };
      if (url.endsWith("/createService")) return opts.created ?? { encodedServiceURL: SERVICE, serviceurl: "https://other/rest/services/x/FeatureServer", itemId: "item-9", success: true };
      if (url.endsWith("/addToDefinition")) return { success: true };
      throw new Error(`unexpected ${url}`);
    });
  }

  it("refuses a bad service name with a 400 before signing in", async () => {
    for (const bad of ["1abc", "ab", "has-dash", "has space", "a".repeat(61), "  "]) {
      await expect(createPolarisLayer(CFG, bad)).rejects.toMatchObject({ httpStatus: 400 });
    }
    expect(h.getArcgisToken).not.toHaveBeenCalled();
  });

  it("needs a sign-in (no token is a 400)", async () => {
    h.getArcgisToken.mockResolvedValue(null);
    await expect(createPolarisLayer(CFG, "Polaris_Runs")).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.arcgisRequest).not.toHaveBeenCalled();
  });

  it("needs a user to own the layer (400 when portals/self names none)", async () => {
    stubPortal({ user: null });
    await expect(createPolarisLayer(CFG, "Polaris_Runs")).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/no user/) });
  });

  it("creates the service under the user, adds the z-enabled polyline layer, and returns layer 0 with the Polaris field map", async () => {
    stubPortal();
    const out = await createPolarisLayer({ ...CFG, portalUrl: "https://gis.example.com/portal/" }, " Polaris_Runs ");
    const urls = h.arcgisRequest.mock.calls.map((c) => c[1]);
    expect(urls).toEqual([
      "https://gis.example.com/portal/sharing/rest/portals/self",
      "https://gis.example.com/portal/sharing/rest/content/users/gis%20admin/createService",
      "https://services.example.com/abc/arcgis/rest/admin/services/Polaris_Runs/FeatureServer/addToDefinition",
    ]);
    const createParams = JSON.parse(h.arcgisRequest.mock.calls[1][2].params.createParameters);
    expect(createParams).toMatchObject({ name: "Polaris_Runs", spatialReference: { wkid: 4326 } });
    expect(h.arcgisRequest.mock.calls[1][2]).toMatchObject({ method: "POST", token: "tok" });
    const def = JSON.parse(h.arcgisRequest.mock.calls[2][2].params.addToDefinition);
    const layer = def.layers[0];
    expect(layer).toMatchObject({ id: 0, geometryType: "esriGeometryPolyline", hasZ: true, objectIdField: "OBJECTID" });
    expect(layer.fields.map((f: { name: string }) => f.name)).toEqual(["OBJECTID", ...Object.values(POLARIS_FIELD_MAP)]);
    expect(layer.fields.find((f: { name: string }) => f.name === "LENGTH_M").length).toBeUndefined();
    expect(layer.fields.find((f: { name: string }) => f.name === "POLARIS_ID").length).toBe(64);
    expect(out).toEqual({ featureLayerUrl: `${SERVICE}/0`, itemId: "item-9", fieldMap: POLARIS_FIELD_MAP });
    expect(out.fieldMap).not.toBe(POLARIS_FIELD_MAP);
  });

  it("falls back to serviceurl, and a null item id", async () => {
    stubPortal({ created: { serviceurl: `${SERVICE}/` } });
    const out = await createPolarisLayer(CFG, "Polaris_Runs");
    expect(out.featureLayerUrl).toBe(`${SERVICE}/0`);
    expect(out.itemId).toBeNull();
  });

  it("an answer with no usable service address is an ArcgisError, and nothing is added", async () => {
    stubPortal({ created: { success: true } });
    await expect(createPolarisLayer(CFG, "Polaris_Runs")).rejects.toBeInstanceOf(ArcgisError);
    stubPortal({ created: { serviceurl: "https://x.example.com/not-a-service" } });
    await expect(createPolarisLayer(CFG, "Polaris_Runs")).rejects.toBeInstanceOf(ArcgisError);
    expect(callsTo("/addToDefinition")).toHaveLength(0);
  });
});

// ─── writeBackIntegration / stopped / status / retry ───────────────────────

describe("writeBackIntegration", () => {
  it("returns the enabled arcgis integration whose config has write-back strictly on", async () => {
    stubbed(prisma.integration.findMany).mockResolvedValue([
      { id: "a", name: "Basemap only", config: { writeBackEnabled: false } },
      { id: "b", name: "Odd", config: { writeBackEnabled: "true" } },
      { id: "n", name: "Null", config: null },
      { id: "c", name: "Writer", config: { writeBackEnabled: true, featureLayerUrl: LAYER } },
    ]);
    expect(await writeBackIntegration()).toEqual({ id: "c", name: "Writer", config: { writeBackEnabled: true, featureLayerUrl: LAYER } });
    expect(stubbed(prisma.integration.findMany).mock.calls[0][0].where).toEqual({ type: "arcgis", enabled: true });
  });

  it("is null when none writes, and excludes the integration being saved", async () => {
    stubbed(prisma.integration.findMany).mockResolvedValue([]);
    expect(await writeBackIntegration("self")).toBeNull();
    expect(stubbed(prisma.integration.findMany).mock.calls[0][0].where).toEqual({ type: "arcgis", enabled: true, id: { not: "self" } });
  });
});

describe("writeBackStopped", () => {
  it("resets live runs to off without object ids, drops tombstones, and writes one Event naming the orphans", async () => {
    stubbed(prisma.cableRun.findMany).mockResolvedValue([{ arcgisObjectId: 5 }, { arcgisObjectId: null }]);
    stubbed(prisma.cableRun.updateMany).mockResolvedValue({ count: 3 });
    stubbed(prisma.cableRun.deleteMany).mockResolvedValue({ count: 2 });
    await writeBackStopped("turned off", "alice");
    expect(stubbed(prisma.cableRun.updateMany).mock.calls[0][0]).toEqual({
      where: { deletedAt: null, OR: [{ syncStatus: { not: "off" } }, { arcgisObjectId: { not: null } }] },
      data: { syncStatus: "off", syncError: null, arcgisObjectId: null },
    });
    expect(stubbed(prisma.cableRun.deleteMany).mock.calls[0][0]).toEqual({ where: { deletedAt: { not: null } } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ action: "cable_run.write_back_stopped", resourceType: "integration", actor: "alice" });
    expect(ev.message).toMatch(/turned off/);
    expect(ev.message).toMatch(/3 run\(s\)/);
    expect(ev.message).toMatch(/2 deleted run\(s\)/);
    expect(ev.details).toEqual({ reason: "turned off", reset: 3, orphanedObjectIds: [5] });
  });

  it("writes no Event when there was nothing to reset or drop", async () => {
    stubbed(prisma.cableRun.findMany).mockResolvedValue([]);
    stubbed(prisma.cableRun.updateMany).mockResolvedValue({ count: 0 });
    stubbed(prisma.cableRun.deleteMany).mockResolvedValue({ count: 0 });
    await writeBackStopped("deleted", "bob");
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("an Event for runs reset only leaves the orphan clause out", async () => {
    stubbed(prisma.cableRun.findMany).mockResolvedValue([]);
    stubbed(prisma.cableRun.updateMany).mockResolvedValue({ count: 1 });
    stubbed(prisma.cableRun.deleteMany).mockResolvedValue({ count: 0 });
    await writeBackStopped("layer moved", "bob");
    expect(eventLog.logEvent.mock.calls[0][0].message).not.toMatch(/deleted run/);
  });

  it("caps the orphan list at 200 ids", async () => {
    stubbed(prisma.cableRun.findMany).mockResolvedValue(Array.from({ length: 250 }, (_, i) => ({ arcgisObjectId: i + 1 })));
    stubbed(prisma.cableRun.updateMany).mockResolvedValue({ count: 0 });
    stubbed(prisma.cableRun.deleteMany).mockResolvedValue({ count: 250 });
    await writeBackStopped("deleted", "bob");
    expect((eventLog.logEvent.mock.calls[0][0].details as { orphanedObjectIds: unknown[] }).orphanedObjectIds).toHaveLength(200);
  });
});

describe("writeBackStatus", () => {
  it("counts runs by sync state (every state present, zero when absent) and reports the latest failure", async () => {
    stubbed(prisma.cableRun.groupBy).mockResolvedValue([
      { syncStatus: "pending", _count: { _all: 4 } },
      { syncStatus: "failed", _count: { _all: 1 } },
    ]);
    stubbed(prisma.cableRun.findFirst).mockResolvedValue({ syncError: "Field NAME too long" });
    expect(await writeBackStatus()).toEqual({ counts: { off: 0, pending: 4, synced: 0, failed: 1 }, lastError: "Field NAME too long" });
    expect(stubbed(prisma.cableRun.findFirst).mock.calls[0][0]).toMatchObject({ where: { syncStatus: "failed" }, orderBy: { updatedAt: "desc" } });
  });

  it("lastError is null with no failed run", async () => {
    stubbed(prisma.cableRun.groupBy).mockResolvedValue([]);
    stubbed(prisma.cableRun.findFirst).mockResolvedValue(null);
    expect(await writeBackStatus()).toEqual({ counts: { off: 0, pending: 0, synced: 0, failed: 0 }, lastError: null });
  });
});

describe("retryFailed", () => {
  it("re-queues every failed run, clears its error and audits it", async () => {
    stubbed(prisma.cableRun.updateMany).mockResolvedValue({ count: 2 });
    expect(await retryFailed("carol")).toBe(2);
    expect(stubbed(prisma.cableRun.updateMany).mock.calls[0][0]).toEqual({ where: { syncStatus: "failed" }, data: { syncStatus: "pending", syncError: null } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "cable_run.write_back_retry", actor: "carol", resourceType: "integration" });
    expect(eventLog.logEvent.mock.calls[0][0].message).toMatch(/^2 cable run/);
  });

  it("writes no Event when nothing had failed", async () => {
    stubbed(prisma.cableRun.updateMany).mockResolvedValue({ count: 0 });
    expect(await retryFailed("carol")).toBe(0);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

// ─── syncWriteBack ─────────────────────────────────────────────────────────

describe("syncWriteBack — the queue", () => {
  it("skips as off when no integration writes, touching no run", async () => {
    stubbed(prisma.integration.findMany).mockResolvedValue([]);
    expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 0, failed: 0, skipped: "off" });
    expect(prisma.cableRun.updateMany).not.toHaveBeenCalled();
    expect(prisma.cableRun.findMany).not.toHaveBeenCalled();
  });

  it("first turns every live off run pending, then reads ≤ 1000 pending runs oldest first", async () => {
    stubQueue([]);
    expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 0, failed: 0 });
    expect(updateManyCalls()[0]).toEqual({ where: { syncStatus: "off", deletedAt: null }, data: { syncStatus: "pending" } });
    expect(stubbed(prisma.cableRun.findMany).mock.calls[0][0]).toMatchObject({ where: { syncStatus: "pending" }, orderBy: { updatedAt: "asc" }, take: 1000 });
    expect(h.arcgisRequest).not.toHaveBeenCalled();
  });
});

describe("syncWriteBack — adds, updates, deletes", () => {
  it("looks a run with no object id up by its Polaris ID, adds it when absent, and records the new object id", async () => {
    stubQueue([run("r1", { version: 3 })]);
    stubLayer({ applyEdits: () => ({ addResults: [{ success: true, objectId: 77 }], updateResults: [], deleteResults: [] }) });
    const out = await syncWriteBack();
    expect(out).toEqual({ sent: 1, deleted: 0, failed: 0 });

    const [q] = callsTo("/query");
    expect(q[1]).toBe(`${LAYER}/query`);
    expect(q[2]).toMatchObject({ method: "POST", token: "tok", params: { where: "PID IN ('r1')", outFields: "OBJECTID,PID", returnGeometry: "false" } });

    const [edit] = callsTo("/applyEdits");
    const params = edit[2].params;
    const adds = JSON.parse(params.adds);
    expect(adds).toHaveLength(1);
    expect(adds[0].attributes).toEqual({ PID: "r1", NAME: "Run r1" });
    expect(adds[0].attributes.OBJECTID).toBeUndefined();
    expect(adds[0].geometry).toEqual({ paths: [[[-85.7, 37.9], [-85.71, 37.91]]], spatialReference: { wkid: 4326 } });
    expect(params.updates).toBe("[]");
    expect(params.deletes).toBe("");
    expect(params.rollbackOnFailure).toBe("false");

    const calls = updateManyCalls();
    expect(calls).toContainEqual(expect.objectContaining({
      where: { id: "r1", version: 3, deletedAt: null },
      data: expect.objectContaining({ syncStatus: "synced", syncError: null, arcgisObjectId: 77, syncedAt: expect.any(Date) }),
    }));
    // The object id is remembered even if the version moved.
    expect(calls).toContainEqual({ where: { id: "r1", arcgisObjectId: null }, data: { arcgisObjectId: 77 } });
  });

  it("never adds twice: a run whose feature the query finds is UPDATED with that object id", async () => {
    stubQueue([run("r1")]);
    stubLayer({
      query: () => ({ features: [{ attributes: { PID: "r1", OBJECTID: 55 } }, { attributes: { PID: 9, OBJECTID: "x" } }] }),
      applyEdits: () => ({ updateResults: [{ success: true, objectId: 55 }] }),
    });
    expect(await syncWriteBack()).toEqual({ sent: 1, deleted: 0, failed: 0 });
    const params = callsTo("/applyEdits")[0][2].params;
    expect(JSON.parse(params.adds)).toEqual([]);
    const updates = JSON.parse(params.updates);
    expect(updates[0].attributes).toEqual({ PID: "r1", NAME: "Run r1", OBJECTID: 55 });
    expect(updateManyCalls()).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ syncStatus: "synced", arcgisObjectId: 55 }) }));
    expect(updateManyCalls()).toContainEqual({ where: { id: "r1", arcgisObjectId: null }, data: { arcgisObjectId: 55 } });
  });

  it("a run that already knows its object id is updated without a query", async () => {
    stubQueue([run("r1", { arcgisObjectId: 12 })]);
    stubLayer({ applyEdits: () => ({ updateResults: [{ success: true }] }) });
    expect(await syncWriteBack()).toEqual({ sent: 1, deleted: 0, failed: 0 });
    expect(callsTo("/query")).toHaveLength(0);
    // No second "remember the id" write: it was known.
    expect(updateManyCalls().filter((c) => c.where?.arcgisObjectId === null)).toHaveLength(0);
  });

  it("a feature ArcGIS refuses fails THAT run with ArcGIS's description, version-guarded", async () => {
    stubQueue([run("r1", { version: 2 }), run("r2", { arcgisObjectId: 8, version: 5 })]);
    stubLayer({
      applyEdits: () => ({
        addResults: [{ success: false, error: { code: 1000, description: "Field NAME too long" } }],
        updateResults: [{ success: true }],
      }),
    });
    expect(await syncWriteBack()).toEqual({ sent: 1, deleted: 0, failed: 1 });
    expect(updateManyCalls()).toContainEqual({ where: { id: "r1", version: 2 }, data: { syncStatus: "failed", syncError: "Field NAME too long" } });
    expect(updateManyCalls()).toContainEqual(expect.objectContaining({ where: { id: "r2", version: 5, deletedAt: null } }));
  });

  it("a refused update keeps the object id the query found; a missing result says ArcGIS did not accept it", async () => {
    stubQueue([run("r1", { version: 2 })]);
    stubLayer({ query: () => ({ features: [{ attributes: { PID: "r1", OBJECTID: 41 } }] }), applyEdits: () => ({}) });
    expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 0, failed: 1 });
    expect(updateManyCalls()).toContainEqual({
      where: { id: "r1", version: 2 },
      data: { syncStatus: "failed", syncError: "ArcGIS did not accept this run", arcgisObjectId: 41 },
    });
  });

  it("truncates ArcGIS's description to 500 characters", async () => {
    stubQueue([run("r1")]);
    stubLayer({ applyEdits: () => ({ addResults: [{ success: false, error: { description: "x".repeat(900) } }] }) });
    await syncWriteBack();
    const failed = updateManyCalls().find((c) => c.data?.syncStatus === "failed");
    expect(failed.data.syncError).toHaveLength(500);
  });

  it("deletes a tombstone's feature, then the tombstone", async () => {
    stubQueue([run("r1", { arcgisObjectId: 9, deletedAt: new Date() }), run("r2", { arcgisObjectId: 10, deletedAt: new Date() })]);
    stubLayer({ applyEdits: () => ({ deleteResults: [{ success: true }, { success: true }] }) });
    expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 2, failed: 0 });
    expect(callsTo("/applyEdits")[0][2].params.deletes).toBe("9,10");
    expect(stubbed(prisma.cableRun.deleteMany).mock.calls.map((c) => c[0])).toEqual([
      { where: { id: "r1", deletedAt: { not: null } } },
      { where: { id: "r2", deletedAt: { not: null } } },
    ]);
  });

  it("a feature already gone from the layer counts as deleted; any other refusal fails the tombstone", async () => {
    stubQueue([
      run("a", { arcgisObjectId: 1, deletedAt: new Date() }),
      run("b", { arcgisObjectId: 2, deletedAt: new Date() }),
      run("c", { arcgisObjectId: 3, deletedAt: new Date() }),
    ]);
    stubLayer({
      applyEdits: () => ({
        deleteResults: [
          { success: false, error: { code: 1000, description: "x" } },
          { success: false, error: { code: 1019, description: "Object does not exist" } },
          { success: false, error: { code: 1017, description: "Edit rejected" } },
        ],
      }),
    });
    expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 2, failed: 1 });
    expect(updateManyCalls()).toContainEqual({ where: { id: "c" }, data: { syncStatus: "failed", syncError: "Edit rejected" } });
  });

  it("a tombstone the query cannot find is dropped without an applyEdits call", async () => {
    stubQueue([run("r1", { deletedAt: new Date() })]);
    stubLayer();
    expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 1, failed: 0 });
    expect(callsTo("/query")).toHaveLength(1);
    expect(callsTo("/applyEdits")).toHaveLength(0);
    expect(stubbed(prisma.cableRun.deleteMany).mock.calls[0][0]).toEqual({ where: { id: { in: ["r1"] }, deletedAt: { not: null } } });
  });

  it("a tombstone the query DOES find is deleted by that object id", async () => {
    stubQueue([run("r1", { deletedAt: new Date() })]);
    stubLayer({ query: () => ({ features: [{ attributes: { PID: "r1", OBJECTID: 66 } }] }), applyEdits: () => ({ deleteResults: [{ success: true }] }) });
    expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 1, failed: 0 });
    expect(callsTo("/applyEdits")[0][2].params.deletes).toBe("66");
  });

  it("sends z for a z-enabled layer", async () => {
    stubQueue([run("r1", { points: [[1, 2, 300], [3, 4]] })]);
    stubLayer({ layer: { ...RAW_LAYER, hasZ: true }, applyEdits: () => ({ addResults: [{ success: true, objectId: 1 }] }) });
    await syncWriteBack();
    const geom = JSON.parse(callsTo("/applyEdits")[0][2].params.adds)[0].geometry;
    expect(geom).toEqual({ paths: [[[1, 2, 300], [3, 4, 0]]], spatialReference: { wkid: 4326 }, hasZ: true });
  });

  it("sends at most 100 operations per applyEdits call", async () => {
    const runs = Array.from({ length: 150 }, (_, i) => run(`r${i}`, { arcgisObjectId: i + 1 }));
    stubQueue(runs);
    stubLayer({ applyEdits: (p) => ({ updateResults: JSON.parse(p.updates).map(() => ({ success: true })) }) });
    expect(await syncWriteBack()).toEqual({ sent: 150, deleted: 0, failed: 0 });
    const sizes = callsTo("/applyEdits").map((c) => JSON.parse(c[2].params.updates).length);
    expect(sizes).toEqual([100, 50]);
  });
});

describe("syncWriteBack — errors", () => {
  it("a transport / 5xx / 429 error leaves the batch pending with the error noted", async () => {
    for (const err of [new ArcgisError("Could not reach host"), new ArcgisError("busy", 503), new ArcgisError("slow down", 429), new TypeError("boom")]) {
      resetDbStub();
      stubQueue([run("r1", { arcgisObjectId: 4 })]);
      h.arcgisRequest.mockReset();
      stubLayer({ applyEdits: () => { throw err; } });
      expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 0, failed: 0 });
      expect(updateManyCalls()).toContainEqual({ where: { id: { in: ["r1"] }, syncStatus: "pending" }, data: { syncError: err.message } });
      expect(updateManyCalls().some((c) => c.data?.syncStatus === "failed")).toBe(false);
    }
  });

  it("an expired token (498 / 499) leaves the batch pending and forgets the cached token", async () => {
    for (const code of [498, 499]) {
      resetDbStub();
      h.clearArcgisTokenCache.mockClear();
      stubQueue([run("r1", { arcgisObjectId: 4 })]);
      stubLayer({ applyEdits: () => { throw new ArcgisError("Invalid token", code); } });
      expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 0, failed: 0 });
      expect(h.clearArcgisTokenCache).toHaveBeenCalledTimes(1);
    }
  });

  it("a non-transient ArcGIS error on a batch fails every run in it", async () => {
    stubQueue([run("r1", { arcgisObjectId: 4 }), run("r2", { arcgisObjectId: 5 })]);
    stubLayer({ applyEdits: () => { throw new ArcgisError("Invalid parameters", 400); } });
    expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 0, failed: 2 });
    expect(updateManyCalls()).toContainEqual({ where: { id: { in: ["r1", "r2"] }, syncStatus: "pending" }, data: { syncStatus: "failed", syncError: "Invalid parameters" } });
  });

  it("a failed batch does not stop the next one", async () => {
    const runs = Array.from({ length: 101 }, (_, i) => run(`r${i}`, { arcgisObjectId: i + 1 }));
    stubQueue(runs);
    let n = 0;
    stubLayer({ applyEdits: () => { if (n++ === 0) throw new ArcgisError("busy", 500); return { updateResults: [{ success: true }] }; } });
    expect(await syncWriteBack()).toEqual({ sent: 1, deleted: 0, failed: 0 });
  });

  it("a config that cannot run fails every queued run with the reason, without calling ArcGIS", async () => {
    stubQueue([run("r1"), run("r2")], { ...CFG, fieldMap: { name: "NAME" } });
    stubLayer();
    expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 0, failed: 2 });
    expect(h.arcgisRequest).not.toHaveBeenCalled();
    const failed = updateManyCalls().find((c) => c.data?.syncStatus === "failed");
    expect(failed.data.syncError).toMatch(/Polaris ID/);
  });

  it("a layer that refuses outright (not lines, no Update) fails every queued run with why", async () => {
    stubQueue([run("r1")]);
    stubLayer({ layer: { ...RAW_LAYER, geometryType: "esriGeometryPoint", capabilities: "Query,Create,Delete" } });
    expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 0, failed: 1 });
    const failed = updateManyCalls().find((c) => c.data?.syncStatus === "failed");
    expect(failed.data.syncError).toMatch(/not lines; The layer does not allow Update/);
    expect(callsTo("/applyEdits")).toHaveLength(0);
  });

  it("a layer that cannot be read for a transient reason leaves every run pending", async () => {
    stubQueue([run("r1")]);
    h.arcgisRequest.mockRejectedValue(new ArcgisError("unavailable", 503));
    expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 0, failed: 0 });
    expect(updateManyCalls()).toContainEqual({ where: { id: { in: ["r1"] }, syncStatus: "pending" }, data: { syncError: "unavailable" } });
  });

  it("a layer read the service refuses (403) fails every run", async () => {
    stubQueue([run("r1")]);
    h.arcgisRequest.mockRejectedValue(new ArcgisError("You do not have permissions", 403));
    expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 0, failed: 1 });
  });

  // Was a bug until 2026-11-14: pushPending — when the LAYER READ (readLayer, which runs first on every
  // tick) answers 498 / 499 "Invalid token", the batch is left pending but the
  // cached token is NOT forgotten (clearArcgisTokenCache is only called in the
  // per-batch catch). Every following tick re-reads the layer with the same
  // dead cached token and stops there, so write-back stalls until the token's
  // natural expiry (up to TOKEN_LIFETIME_MIN = 120 min). Right: a 498 / 499 at
  // the layer read clears the cache exactly as one at applyEdits does.
  it("an expired token on the layer read also forgets the cached token", async () => {
    stubQueue([run("r1")]);
    h.arcgisRequest.mockRejectedValue(new ArcgisError("Invalid token", 498));
    expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 0, failed: 0 });
    expect(h.clearArcgisTokenCache).toHaveBeenCalled();
  });
});

describe("syncWriteBack — the advisory lock", () => {
  beforeEach(() => { h.directUrl.value = "postgres://direct/db"; });

  it("returns locked, touching no run, when another process holds the lock", async () => {
    stubQueue([run("r1")]);
    h.pgQuery.mockResolvedValue({ rows: [{ locked: false }] });
    expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 0, failed: 0, skipped: "locked" });
    expect(h.pgQuery.mock.calls[0]).toEqual(["SELECT pg_try_advisory_lock($1, $2) AS locked", [0x504c4157, 1]]);
    expect(prisma.cableRun.updateMany).not.toHaveBeenCalled();
    expect(h.pgEnd).toHaveBeenCalledTimes(1);
  });

  it("pushes under the lock, then unlocks and closes the side connection", async () => {
    stubQueue([]);
    h.pgQuery.mockResolvedValue({ rows: [{ locked: true }] });
    expect(await syncWriteBack()).toEqual({ sent: 0, deleted: 0, failed: 0 });
    expect(h.pgQuery.mock.calls.map((c) => c[0])).toEqual([
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      "SELECT pg_advisory_unlock($1, $2)",
    ]);
    expect(h.pgEnd).toHaveBeenCalledTimes(1);
  });

  it("unlocks and closes even when the push throws", async () => {
    stubQueue([]);
    stubbed(prisma.cableRun.updateMany).mockRejectedValue(new Error("db down"));
    h.pgQuery.mockResolvedValue({ rows: [{ locked: true }] });
    await expect(syncWriteBack()).rejects.toThrow("db down");
    expect(h.pgQuery.mock.calls.map((c) => c[0])).toContain("SELECT pg_advisory_unlock($1, $2)");
    expect(h.pgEnd).toHaveBeenCalledTimes(1);
  });

  it("with no direct database URL it pushes without a lock", async () => {
    h.directUrl.value = "";
    stubQueue([]);
    await syncWriteBack();
    expect(h.pgConnect).not.toHaveBeenCalled();
    expect(prisma.cableRun.updateMany).toHaveBeenCalled();
  });
});

describe("kickWriteBack", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("debounces: several kicks inside 500 ms run one push", async () => {
    stubbed(prisma.integration.findMany).mockResolvedValue([]);
    kickWriteBack();
    kickWriteBack();
    kickWriteBack();
    expect(prisma.integration.findMany).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(prisma.integration.findMany).toHaveBeenCalledTimes(1);
    // A kick after that one fired schedules another.
    kickWriteBack();
    await vi.advanceTimersByTimeAsync(500);
    expect(prisma.integration.findMany).toHaveBeenCalledTimes(2);
  });

  it("never throws: a failed push is logged and swallowed", async () => {
    stubbed(prisma.integration.findMany).mockRejectedValue(new Error("db down"));
    expect(() => kickWriteBack()).not.toThrow();
    await vi.advanceTimersByTimeAsync(500);
    expect(prisma.integration.findMany).toHaveBeenCalledTimes(1);
  });
});
