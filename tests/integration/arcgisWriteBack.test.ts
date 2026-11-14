/**
 * tests/integration/arcgisWriteBack.test.ts — cable runs written one way to an
 * ArcGIS layer (business rule 185) against a real database, with ArcGIS played
 * by the arcgisService request seam. Pins:
 *   - turning write-back on queues every run; a push adds new features, updates
 *     known ones, deletes tombstones and drops them;
 *   - a run whose add landed without an answer is found by its Polaris ID and
 *     updated, never added twice;
 *   - a per-feature refusal marks that run failed with ArcGIS's message; Retry
 *     failed queues it again;
 *   - a transport failure leaves runs pending;
 *   - write-back turned off puts every run back to off and drops tombstones;
 *   - only one integration may write; the config needs the Polaris ID mapped.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.POLARIS_SECRET_KEY ||= "ab".repeat(32); });

import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { _setRequestImplForTests, type ArcgisHttpRequest } from "../../src/services/arcgisService.js";
import { syncWriteBack } from "../../src/services/arcgisWriteBackService.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "it-arcgis-wb";
const LAYER = "https://services.example.com/org/arcgis/rest/services/Telecom/FeatureServer/0";
let siteId = "";
let intgId = "";

const POLE = (name: string) => ({
  name, medium: "fiber", placement: "electric_pole", notes: "",
  points: [[-85.7001, 37.9801], [-85.7002, 37.9811]],
});

/** A tiny feature layer: features by object id, and every request seen. */
function fakeLayer(opts: { refuseName?: string; down?: boolean } = {}) {
  const features = new Map<number, Record<string, unknown>>();
  let nextOid = 1;
  const calls: ArcgisHttpRequest[] = [];
  _setRequestImplForTests(async (req) => {
    calls.push(req);
    if (opts.down) throw new Error("connect ECONNREFUSED");
    const url = new URL(req.url);
    const json = (b: unknown) => ({ status: 200, body: JSON.stringify(b) });
    if (url.pathname.endsWith("/FeatureServer/0")) {
      return json({
        name: "Telecom Routes", geometryType: "esriGeometryPolyline", hasZ: false, objectIdField: "OBJECTID",
        capabilities: "Create,Delete,Query,Update,Editing", extent: { spatialReference: { wkid: 4326 } },
        fields: [
          { name: "OBJECTID", type: "esriFieldTypeOID" },
          { name: "EXT_ID", type: "esriFieldTypeString", length: 64 },
          { name: "ROUTE_NAME", type: "esriFieldTypeString", length: 120 },
        ],
      });
    }
    if (url.pathname.endsWith("/query")) {
      const ids = [...String(req.form?.where ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
      return json({ features: [...features.entries()].filter(([, a]) => ids.includes(String(a.EXT_ID))).map(([oid, a]) => ({ attributes: { OBJECTID: oid, EXT_ID: a.EXT_ID } })) });
    }
    if (url.pathname.endsWith("/applyEdits")) {
      const adds = JSON.parse(req.form?.adds || "[]") as Array<{ attributes: Record<string, unknown> }>;
      const updates = JSON.parse(req.form?.updates || "[]") as Array<{ attributes: Record<string, unknown> }>;
      const deletes = (req.form?.deletes || "").split(",").filter(Boolean).map(Number);
      return json({
        addResults: adds.map((f) => {
          if (opts.refuseName && f.attributes.ROUTE_NAME === opts.refuseName) return { success: false, error: { code: 1000, description: "ROUTE_NAME is longer than 120" } };
          const oid = nextOid++;
          features.set(oid, f.attributes);
          return { objectId: oid, success: true };
        }),
        updateResults: updates.map((f) => {
          const oid = Number(f.attributes.OBJECTID);
          features.set(oid, f.attributes);
          return { objectId: oid, success: true };
        }),
        deleteResults: deletes.map((oid) => { features.delete(oid); return { objectId: oid, success: true }; }),
      });
    }
    return { status: 404, body: "{}" };
  });
  return { features, calls, seed: (attrs: Record<string, unknown>) => { const oid = nextOid++; features.set(oid, attrs); return oid; } };
}

async function cleanup(): Promise<void> {
  await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
  await cleanup();
  await prisma.cableRun.deleteMany({});
  siteId = (await prisma.asset.create({ data: { hostname: `${PFX}-fg`, assetType: "firewall", status: "active" } })).id;
});
afterEach(() => _setRequestImplForTests(null));
afterAll(async () => { if (dbReachable) { await prisma.cableRun.deleteMany({}); await cleanup(); } });

async function draw(names: string[]): Promise<Record<string, string>> {
  const { agent, csrf } = await authedAgent(app);
  const res = await agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", csrf).send({ upserts: names.map(POLE) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return Object.fromEntries(res.body.runs.map((r: { name: string; id: string }) => [r.name, r.id]));
}

d("ArcGIS cable-run write-back (rule 185)", () => {
  it("refuses write-back without the Polaris ID mapped, and a second writer", async () => {
    const { agent, csrf } = await authedAgent(app);
    const base = { type: "arcgis", config: { authMode: "apiKey", apiToken: "k-not-real", writeBackEnabled: true, featureLayerUrl: LAYER } };
    const bad = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send({ ...base, name: `${PFX} bad` });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/Polaris ID/);

    const ok = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf)
      .send({ ...base, name: `${PFX} one`, config: { ...base.config, fieldMap: { polarisId: "EXT_ID", name: "ROUTE_NAME" } } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    intgId = ok.body.id;
    const two = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf)
      .send({ ...base, name: `${PFX} two`, config: { ...base.config, fieldMap: { polarisId: "EXT_ID" } } });
    expect(two.status).toBe(409);
  });

  it("queues every run, adds new features, updates known ones, deletes tombstones", async () => {
    const layer = fakeLayer();
    const ids = await draw(["wb-a", "wb-b"]);
    // wb-b's add landed before, but its answer was lost: it is already in the layer.
    const preexisting = layer.seed({ EXT_ID: ids["wb-b"], ROUTE_NAME: "old" });

    const first = await syncWriteBack();
    expect(first).toMatchObject({ sent: 2, failed: 0 });
    expect(layer.features.size).toBe(2); // wb-b updated, not added twice
    const b = await prisma.cableRun.findUniqueOrThrow({ where: { id: ids["wb-b"] } });
    expect(b).toMatchObject({ syncStatus: "synced", arcgisObjectId: preexisting });
    expect(layer.features.get(preexisting)?.ROUTE_NAME).toBe("wb-b");

    // An edit sends it again; a delete leaves a tombstone, then removes the feature.
    const { agent, csrf } = await authedAgent(app);
    await agent.put(`/api/v1/map/sites/${siteId}/cable-runs`).set("X-CSRF-Token", csrf)
      .send({ upserts: [{ ...POLE("wb-a2"), id: ids["wb-a"] }], deletes: [ids["wb-b"]] });
    expect((await prisma.cableRun.findUniqueOrThrow({ where: { id: ids["wb-b"] } })).deletedAt).not.toBeNull();
    const second = await syncWriteBack();
    expect(second).toMatchObject({ sent: 1, deleted: 1 });
    expect(await prisma.cableRun.findUnique({ where: { id: ids["wb-b"] } })).toBeNull();
    expect(layer.features.has(preexisting)).toBe(false);
    expect([...layer.features.values()].map((a) => a.ROUTE_NAME)).toEqual(["wb-a2"]);
  });

  it("marks a refused run failed with ArcGIS's message; Retry failed queues it again", async () => {
    fakeLayer({ refuseName: "wb-refused" });
    const ids = await draw(["wb-refused"]);
    const r = await syncWriteBack();
    expect(r.failed).toBe(1);
    expect(await prisma.cableRun.findUniqueOrThrow({ where: { id: ids["wb-refused"] } }))
      .toMatchObject({ syncStatus: "failed", syncError: "ROUTE_NAME is longer than 120" });

    const { agent, csrf } = await authedAgent(app);
    const status = await agent.get(`/api/v1/integrations/${intgId}/arcgis/write-back`);
    expect(status.body).toMatchObject({ writing: true, lastError: "ROUTE_NAME is longer than 120" });
    expect(status.body.counts.failed).toBe(1);
    const retry = await agent.post(`/api/v1/integrations/${intgId}/arcgis/retry-failed`).set("X-CSRF-Token", csrf);
    expect(retry.body.queued).toBe(1);
    expect((await prisma.cableRun.findUniqueOrThrow({ where: { id: ids["wb-refused"] } })).syncStatus).toBe("pending");
  });

  it("leaves runs pending when ArcGIS cannot be reached", async () => {
    fakeLayer({ down: true });
    await draw(["wb-offline"]);
    const r = await syncWriteBack();
    expect(r.failed).toBe(0);
    const run = await prisma.cableRun.findFirstOrThrow({ where: { name: "wb-offline" } });
    expect(run.syncStatus).toBe("pending");
    expect(run.syncError).toMatch(/Could not reach/);
  });

  it("turned off, every run goes back to off and tombstones are dropped", async () => {
    await prisma.cableRun.updateMany({ where: { name: "wb-offline" }, data: { deletedAt: new Date(), arcgisObjectId: 99 } });
    const { agent, csrf } = await authedAgent(app);
    const off = await agent.put(`/api/v1/integrations/${intgId}`).set("X-CSRF-Token", csrf).send({ config: { writeBackEnabled: false } });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(await prisma.cableRun.count({ where: { syncStatus: { not: "off" } } })).toBe(0);
    expect(await prisma.cableRun.count({ where: { deletedAt: { not: null } } })).toBe(0);
    expect(await prisma.cableRun.count({ where: { arcgisObjectId: { not: null } } })).toBe(0);
    expect(await prisma.event.count({ where: { action: "cable_run.write_back_stopped" } })).toBeGreaterThan(0);
    expect(await syncWriteBack()).toMatchObject({ skipped: "off" });
  });
});
