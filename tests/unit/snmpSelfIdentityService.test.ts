/**
 * tests/unit/snmpSelfIdentityService.test.ts
 *
 * Business rule 154 — the writer (services/snmpSelfIdentityService.ts).
 * Pinned:
 *
 *   - a reading lands through the `snmp-identity` AssetSource row and the
 *     projection, filling an empty asset silently (a first learn is no change);
 *   - an unchanged reading costs no DB call at all the second time;
 *   - an operator's hostname pin and OUI override are left alone;
 *   - a higher-ranked source keeps its value;
 *   - a real move audits: asset.model_detected for identity, and
 *     asset.firmware.changed for firmware.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  sources: new Map<string, Array<Record<string, unknown>>>(),
  assets: new Map<string, Record<string, unknown>>(),
  upserts: [] as Array<Record<string, unknown>>,
  assetUpdates: [] as Array<{ id: string; data: Record<string, unknown> }>,
  events: [] as Array<Record<string, unknown>>,
  calls: 0,
  ouiOverride: null as string | null,
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetSource: {
      findUnique: vi.fn(async ({ where }: any) => {
        h.calls++;
        const id = where.sourceKind_externalId.externalId;
        const row = (h.sources.get(id) ?? []).find((r) => r.sourceKind === "snmp-identity");
        return row ? { observed: row.observed } : null;
      }),
      upsert: vi.fn(async (args: any) => {
        h.calls++;
        h.upserts.push(args);
        const assetId = args.create.assetId as string;
        const rows = (h.sources.get(assetId) ?? []).filter((r) => r.sourceKind !== "snmp-identity");
        rows.push({ sourceKind: "snmp-identity", inferred: false, observed: args.create.observed, lastSeen: new Date() });
        h.sources.set(assetId, rows);
        return {};
      }),
      findMany: vi.fn(async ({ where }: any) => { h.calls++; return h.sources.get(where.assetId) ?? []; }),
    },
    asset: {
      findUnique: vi.fn(async ({ where }: any) => { h.calls++; return h.assets.get(where.id) ?? null; }),
      update: vi.fn(async ({ where, data }: any) => {
        h.calls++;
        h.assetUpdates.push({ id: where.id, data });
        h.assets.set(where.id, { ...(h.assets.get(where.id) ?? {}), ...data });
        return {};
      }),
    },
  },
}));

vi.mock("../../src/services/ouiService.js", () => ({
  lookupOuiOverride: vi.fn(async () => h.ouiOverride),
}));

vi.mock("../../src/services/eventLogService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/eventLogService.js")>();
  return { ...actual, logEvent: vi.fn(async (input: any) => { h.events.push(input); }) };
});

const { reconcileSnmpSelfIdentity, resetSnmpSelfIdentityCache, observedKey, sameVendor } =
  await import("../../src/services/snmpSelfIdentityService.js");

describe("sameVendor", () => {
  it("treats corporate spellings of one vendor as one", () => {
    expect(sameVendor("Cisco", "Cisco Systems, Inc.")).toBe(true);
    expect(sameVendor("Cisco Systems, Inc", "cisco")).toBe(true);
    expect(sameVendor("Dell Inc.", "Dell")).toBe(true);
  });

  it("keeps different vendors apart, and an empty side is never the same", () => {
    expect(sameVendor("Cisco", "Brocade")).toBe(false);
    expect(sameVendor("Cisco", null)).toBe(false);
    expect(sameVendor("Inc.", "Corp")).toBe(false);
  });
});

const READING = {
  hostname: "metro-9148s-1",
  model: "DS-C9148S-K9",
  serialNumber: "JAF1234ABCD",
  manufacturer: "Cisco Systems, Inc.",
  osVersion: "8.4(2c)",
};

function blankAsset(id: string, extra: Record<string, unknown> = {}) {
  h.assets.set(id, {
    hostname: null, hostnameOverride: null, serialNumber: null, manufacturer: "Cisco",
    model: null, osVersion: null, macAddress: "aa:bb:cc:dd:ee:ff", ...extra,
  });
  h.sources.set(id, [{ sourceKind: "fortigate-endpoint", inferred: false, observed: { hardwareVendor: "Cisco" }, lastSeen: new Date() }]);
}

beforeEach(() => {
  h.sources.clear();
  h.assets.clear();
  h.upserts.length = 0;
  h.assetUpdates.length = 0;
  h.events.length = 0;
  h.calls = 0;
  h.ouiOverride = null;
  resetSnmpSelfIdentityCache();
});

describe("reconcileSnmpSelfIdentity", () => {
  it("fills an empty asset through the source row, silently", async () => {
    blankAsset("a1");
    expect(await reconcileSnmpSelfIdentity("a1", READING)).toBe(true);
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0].create).toMatchObject({ sourceKind: "snmp-identity", externalId: "a1" });
    expect(h.assetUpdates[0].data).toEqual({
      hostname: "metro-9148s-1",
      serialNumber: "JAF1234ABCD",
      // No manufacturer: "Cisco Systems, Inc." is the "Cisco" already stored,
      // spelled the device's way — not a write, and not an audited move.
      model: "DS-C9148S-K9",
      osVersion: "8.4(2c)",
    });
    // A first learn is not a change: no identity or firmware Event.
    expect(h.events).toHaveLength(0);
  });

  it("costs no DB call for the same reading the second time", async () => {
    blankAsset("a1");
    await reconcileSnmpSelfIdentity("a1", READING);
    h.calls = 0;
    expect(await reconcileSnmpSelfIdentity("a1", { ...READING })).toBe(false);
    expect(h.calls).toBe(0);
  });

  it("does nothing for a reading that states nothing", async () => {
    expect(await reconcileSnmpSelfIdentity("a1", {})).toBe(false);
    expect(await reconcileSnmpSelfIdentity("a1", undefined)).toBe(false);
    expect(h.calls).toBe(0);
  });

  it("leaves an operator's hostname pin and OUI override alone", async () => {
    blankAsset("a1", { hostname: "typed-name", hostnameOverride: "typed-name", manufacturer: "Brocade" });
    h.ouiOverride = "Brocade";
    await reconcileSnmpSelfIdentity("a1", READING);
    const data = h.assetUpdates[0].data;
    expect(data.hostname).toBeUndefined();
    expect(data.manufacturer).toBeUndefined();
    expect(data.model).toBe("DS-C9148S-K9");
  });

  it("keeps a higher-ranked source's value", async () => {
    blankAsset("a1", { hostname: "S548DF-CORE", manufacturer: "Fortinet" });
    h.sources.set("a1", [{ sourceKind: "fortiswitch", inferred: false, observed: { switchId: "S548DF-CORE" }, lastSeen: new Date() }]);
    await reconcileSnmpSelfIdentity("a1", { hostname: "factory-name" });
    expect(h.assetUpdates).toHaveLength(0);
    expect(h.upserts).toHaveLength(1);
  });

  it("audits a real move of identity and of firmware", async () => {
    blankAsset("a1", { hostname: "metro-9148s-1", model: "DS-C9148S-K9", serialNumber: "JAF1234ABCD", osVersion: "8.4(2c)" });
    await reconcileSnmpSelfIdentity("a1", { ...READING, serialNumber: "JAF9999ZZZZ", osVersion: "9.4(1)" });
    const actions = h.events.map((e) => e.action).sort();
    expect(actions).toEqual(["asset.firmware.changed", "asset.model_detected"]);
    const moved = h.events.find((e) => e.action === "asset.model_detected")!;
    expect(String(moved.message)).toContain('serialNumber "JAF1234ABCD" → "JAF9999ZZZZ"');
  });

  it("re-checks the projection after a restart even when the stored row matches", async () => {
    blankAsset("a1");
    h.sources.get("a1")!.push({ sourceKind: "snmp-identity", inferred: false, observed: JSON.parse(observedKey(READING)), lastSeen: new Date() });
    expect(await reconcileSnmpSelfIdentity("a1", READING)).toBe(true);
    expect(h.upserts).toHaveLength(0);
    expect(h.assetUpdates[0].data.model).toBe("DS-C9148S-K9");
  });
});
