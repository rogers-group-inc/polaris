/**
 * tests/unit/snmpProfileIdentity.test.ts — business rule 171: a manufacturer
 * profile's `model` / `serial` rows read a device's own identity, recorded as
 * the `snmp-profile` enrichment source.
 *
 * The case (2026-11-12): an APC Smart-UPS. ENTITY-MIB answers nothing, the
 * sysDescr `SN:` is the management card's (rule 161), so the asset's General
 * tab had no serial at all; its serial is `upsAdvIdentSerialNumber`, which only
 * a profile row can name. Pinned:
 *
 *   - the resolver turns a `serial` row into `profile.serial`;
 *   - `snmp-profile` ranks above ENTITY-MIB and below the sysDescr parse, for
 *     model and serial, and is enrichment, never a claim of existence;
 *   - the writer records its own source row (never the `snmp-identity` one),
 *     applies through the projection, drops a placeholder serial, records
 *     nothing for an empty reading, and costs no DB call when unchanged.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  sources: new Map<string, Array<Record<string, unknown>>>(),
  assets: new Map<string, Record<string, unknown>>(),
  upserts: [] as Array<Record<string, unknown>>,
  calls: 0,
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetSource: {
      findUnique: vi.fn(async ({ where }: any) => {
        h.calls++;
        const { sourceKind, externalId } = where.sourceKind_externalId;
        const row = (h.sources.get(externalId) ?? []).find((r) => r.sourceKind === sourceKind);
        return row ? { observed: row.observed } : null;
      }),
      upsert: vi.fn(async (args: any) => {
        h.calls++;
        h.upserts.push(args);
        const { assetId, sourceKind, observed } = args.create;
        const rows = (h.sources.get(assetId) ?? []).filter((r) => r.sourceKind !== sourceKind);
        rows.push({ sourceKind, inferred: false, observed, lastSeen: new Date() });
        h.sources.set(assetId, rows);
        return {};
      }),
      findMany: vi.fn(async ({ where }: any) => { h.calls++; return h.sources.get(where.assetId) ?? []; }),
    },
    asset: {
      findUnique: vi.fn(async ({ where }: any) => { h.calls++; return h.assets.get(where.id) ?? null; }),
      update: vi.fn(async ({ where, data }: any) => {
        h.calls++;
        h.assets.set(where.id, { ...(h.assets.get(where.id) ?? {}), ...data });
        return {};
      }),
    },
  },
}));

vi.mock("../../src/services/ouiService.js", () => ({ lookupOuiOverride: vi.fn(async () => null) }));
vi.mock("../../src/services/eventLogService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/eventLogService.js")>();
  return { ...actual, logEvent: vi.fn(async () => {}) };
});

const { reconcileSnmpProfileIdentity, reconcileSnmpSelfIdentity, resetSnmpSelfIdentityCache } =
  await import("../../src/services/snmpSelfIdentityService.js");
const { projectAssetFromSources, ENRICHMENT_SOURCE_KINDS } = await import("../../src/utils/assetProjection.js");
const { pickDbProfile } = await import("../../src/services/profileResolver.js");

const src = (sourceKind: string, observed: Record<string, unknown>) => ({ sourceKind, inferred: false, observed, lastSeen: new Date() });
const EMPTY_ASSET = { hostname: "Datacenter UPS", hostnameOverride: null, serialNumber: null, manufacturer: "APC", model: null, osVersion: null, macAddress: null };

beforeEach(() => {
  h.sources.clear();
  h.assets.clear();
  h.upserts.length = 0;
  h.calls = 0;
  resetSnmpSelfIdentityCache();
});

describe("the resolver", () => {
  const profile = (serialSymbol: string | null) => ({
    id: "p", manufacturer: "APC", matchPattern: null, widgetLayout: null, createdBy: null, createdAt: "", updatedAt: "", widgets: [],
    metrics: [
      { metricKey: "serial", defaultSymbol: serialSymbol, defaultSymbolB: null, defaultType: "scalar", defaultTransform: null,
        defaultAggregate: "none", defaultLabel: null, defaultParsePattern: null, defaultParseTemplate: null, defaultSensorColumns: null, overrides: [] },
    ],
  });

  it("turns a serial row into profile.serial", () => {
    const p = pickDbProfile({ manufacturer: "APC", os: null, model: null, assetType: "power" }, () => profile("upsAdvIdentSerialNumber") as never, () => []);
    expect(p?.serial).toEqual({ symbol: "upsAdvIdentSerialNumber" });
  });

  it("an empty serial row says nothing", () => {
    const p = pickDbProfile({ manufacturer: "APC", os: null, model: null, assetType: "power" }, () => profile(null) as never, () => []);
    expect(p).toBeNull();
  });
});

describe("where snmp-profile ranks", () => {
  it("beats ENTITY-MIB for model and serial", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("snmp-identity", { model: "ENTITY-MODEL", serialNumber: "ENTITY-SERIAL" }),
      src("snmp-profile", { model: "Smart-UPS 3000", serialNumber: "AS1234567890" }),
    ]);
    expect(projected.model).toBe("Smart-UPS 3000");
    expect(projected.serialNumber).toBe("AS1234567890");
    expect(provenance.serialNumber).toBe("snmp-profile");
  });

  it("loses to the vendor-format sysDescr parse (a rack PDU's own card, rule 161)", () => {
    const { projected } = projectAssetFromSources([
      src("snmp-profile", { model: "X", serialNumber: "PROFILE-SN-1" }),
      src("snmp-sysdescr", { model: "AP8870", serialNumber: "ZA2406030655" }),
    ]);
    expect(projected.model).toBe("AP8870");
    expect(projected.serialNumber).toBe("ZA2406030655");
  });

  it("is enrichment, never a claim that the device exists", () => {
    expect(ENRICHMENT_SOURCE_KINDS).toContain("snmp-profile");
  });
});

describe("reconcileSnmpProfileIdentity", () => {
  it("records its own source row and fills the empty asset", async () => {
    h.assets.set("u1", { ...EMPTY_ASSET });
    expect(await reconcileSnmpProfileIdentity("u1", { model: "Smart-UPS 3000", serialNumber: " AS1234567890 " })).toBe(true);
    expect(h.upserts).toHaveLength(1);
    expect((h.upserts[0] as any).create.sourceKind).toBe("snmp-profile");
    expect((h.upserts[0] as any).create.observed).toEqual({ model: "Smart-UPS 3000", serialNumber: "AS1234567890" });
    expect(h.assets.get("u1")).toMatchObject({ model: "Smart-UPS 3000", serialNumber: "AS1234567890" });
  });

  it("costs no DB call when the reading is unchanged", async () => {
    h.assets.set("u1", { ...EMPTY_ASSET });
    await reconcileSnmpProfileIdentity("u1", { serialNumber: "AS1234567890" });
    h.calls = 0;
    expect(await reconcileSnmpProfileIdentity("u1", { serialNumber: "AS1234567890" })).toBe(false);
    expect(h.calls).toBe(0);
  });

  it("drops a placeholder serial and records nothing for an empty reading", async () => {
    h.assets.set("u1", { ...EMPTY_ASSET });
    expect(await reconcileSnmpProfileIdentity("u1", { serialNumber: "0" })).toBe(false);
    expect(await reconcileSnmpProfileIdentity("u1", { model: null, serialNumber: null })).toBe(false);
    expect(h.upserts).toHaveLength(0);
  });

  it("does not trade values with the ENTITY-MIB source: both rows live side by side", async () => {
    h.assets.set("u1", { ...EMPTY_ASSET });
    await reconcileSnmpSelfIdentity("u1", { hostname: "ups-a3" });
    await reconcileSnmpProfileIdentity("u1", { serialNumber: "AS1234567890" });
    const kinds = (h.sources.get("u1") ?? []).map((r) => r.sourceKind).sort();
    expect(kinds).toEqual(["snmp-identity", "snmp-profile"]);
    expect(h.assets.get("u1")).toMatchObject({ hostname: "ups-a3", serialNumber: "AS1234567890" });
  });
});
