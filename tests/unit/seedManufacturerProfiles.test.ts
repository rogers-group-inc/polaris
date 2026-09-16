/**
 * tests/unit/seedManufacturerProfiles.test.ts — a fresh install gets what the
 * Phase 4 migration gives an upgraded one.
 *
 * These are the two halves of one pair, and they are NOT interchangeable. On
 * a fresh install `prisma migrate deploy` runs BEFORE this job, so every
 * backfill UPDATE in `20260915020000_manufacturer_profile_resolver_swap`
 * matches zero rows and only what the seed writes survives. That asymmetry is
 * invisible to anyone developing against an existing database, and since the
 * resolver swap made these rows the only source of vendor telemetry OIDs, a
 * column the seed forgets is a vendor that silently stops collecting on every
 * new install — the deployment shape we are least likely to be running.
 *
 * It already happened once: Phase 4 added the `model` metric key, this job
 * kept its own hardcoded copy of METRIC_KEYS, and fresh installs got no
 * identity query at all — which is the prod FortiSwitch deadlock (a switch
 * whose model is empty can never fill it in) coming straight back.
 *
 * So the expectations below are written as the MIGRATION's end state, vendor
 * by vendor, and are meant to be diffed against that SQL by eye. Prisma is
 * mocked; what is asserted is the payloads the job would write.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  profiles: [] as Array<Record<string, any>>,
  metrics: [] as Array<Record<string, any>>,
  overrides: [] as Array<Record<string, any>>,
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    $transaction: vi.fn(async (ops: unknown[]) => ops),
    manufacturerProfile: {
      create: vi.fn(({ data }: any) => { h.profiles.push(data); return data; }),
      findUnique: vi.fn(async () => null),
    },
    manufacturerProfileMetric: {
      create: vi.fn(({ data }: any) => { h.metrics.push(data); return data; }),
    },
    manufacturerProfileMetricOverride: {
      create: vi.fn(async ({ data }: any) => { h.overrides.push(data); return data; }),
    },
    setting: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
    mibFile: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("../../src/jobs/_runOnce.js", () => ({
  hasRunMarker: vi.fn(async () => false),
  stampRunMarker: vi.fn(async () => {}),
}));

vi.mock("../../src/services/manufacturerProfileService.js", async (orig) => {
  // Keep METRIC_KEYS real — it is half of what this test is checking — but
  // stub the cache refresh, which would reach Prisma for no benefit here.
  const actual = await orig<typeof import("../../src/services/manufacturerProfileService.js")>();
  return { ...actual, refreshProfileCache: vi.fn(async () => {}), emitProfileReadinessEvents: vi.fn(async () => 0) };
});

const { seedManufacturerProfiles } = await import("../../src/jobs/seedManufacturerProfiles.js");
const { METRIC_KEYS } = await import("../../src/services/manufacturerProfileService.js");

beforeEach(async () => {
  h.profiles = [];
  h.metrics = [];
  h.overrides = [];
  await seedManufacturerProfiles();
});

const profile = (mfr: string) => h.profiles.find((p) => p.manufacturer === mfr);
const metric = (mfr: string, key: string) => {
  const p = profile(mfr);
  return h.metrics.find((m) => m.profileId === p?.id && m.metricKey === key);
};
const override = (mfr: string, key: string, scope: { assetType?: string | null; modelPattern?: string | null }) => {
  const m = metric(mfr, key);
  return h.overrides.find((o) =>
    o.metricRowId === m?.id &&
    (o.assetType ?? null) === (scope.assetType ?? null) &&
    (o.modelPattern ?? null) === (scope.modelPattern ?? null));
};

describe("every profile gets a row per metric key", () => {
  it("uses the service's METRIC_KEYS, not a copy of it", () => {
    // The copy is exactly what went wrong: Phase 4 added `model` to the
    // service's list and this job never heard about it.
    expect(METRIC_KEYS).toContain("model");
    for (const p of h.profiles) {
      const keys = h.metrics.filter((m) => m.profileId === p.id).map((m) => m.metricKey);
      expect(keys.sort(), `${p.manufacturer} is missing a metric row`).toEqual([...METRIC_KEYS].sort());
    }
  });

  it("seeds the six vendors the constant describes", () => {
    expect(h.profiles.map((p) => p.manufacturer).sort())
      .toEqual(["Cisco", "Dell", "Fortinet", "HP", "Juniper", "Mikrotik"]);
  });
});

describe("matchPattern — the migration's per-vendor UPDATEs", () => {
  it("stamps each umbrella entry's own regex", () => {
    // Compare to the six UPDATE statements in the migration; they are these
    // strings verbatim, because both come from the constant's `match`.
    expect(profile("Cisco")!.matchPattern).toBe("cisco|ios-?xe|nx-?os");
    expect(profile("Juniper")!.matchPattern).toBe("juniper|junos");
    expect(profile("Mikrotik")!.matchPattern).toBe("mikrotik|routeros");
    expect(profile("Fortinet")!.matchPattern).toBe("fortinet|fortigate|fortios");
    expect(profile("HP")!.matchPattern).toBe("aruba|hpe|hewlett|procurve|^hp\\b");
    expect(profile("Dell")!.matchPattern).toBe("\\bdell\\b|powerconnect|force10");
  });
});

describe("aggregate — how a walked subtree collapses", () => {
  it("sums Cisco's memory pools and averages its CPU table", () => {
    // The delta the whole swap exists for: the old merge hardcoded
    // walkSubtree=false on the pair path, so a seeded Cisco did a scalar GET
    // of a table column and fell to HOST-RESOURCES-MIB.
    expect(metric("Cisco", "memory")).toMatchObject({
      defaultSymbol: "ciscoMemoryPoolUsed", defaultSymbolB: "ciscoMemoryPoolFree",
      defaultType: "double_scalar", defaultAggregate: "sum",
    });
    expect(metric("Cisco", "cpu")).toMatchObject({ defaultType: "table", defaultAggregate: "avg" });
  });

  it("averages Juniper's per-entity readings, both of them", () => {
    expect(metric("Juniper", "cpu")).toMatchObject({ defaultSymbol: "jnxOperatingCPU", defaultAggregate: "avg" });
    expect(metric("Juniper", "memory")).toMatchObject({ defaultSymbol: "jnxOperatingBuffer", defaultAggregate: "avg" });
  });

  it("leaves a shape that walks nothing at none", () => {
    expect(metric("Fortinet", "cpu")!.defaultAggregate).toBe("none");
    expect(metric("Mikrotik", "cpu")!.defaultAggregate).toBe("none");
    expect(override("Fortinet", "memory", { modelPattern: "FortiSwitch" })!.aggregate).toBe("none");
  });
});

describe("label — the synthesized sample row's name", () => {
  it("labels FortiSwitch storage flash and a FortiAP's one sensor System", () => {
    // Both are keys an operator's pins and thresholds attach to; a row that
    // seeds without them comes back as the collector's default ("system")
    // and an existing pin stops matching.
    expect(override("Fortinet", "storage", { modelPattern: "FortiSwitch" })!.label).toBe("flash");
    expect(override("Fortinet", "temperature", { modelPattern: "FortiAP" })!.label).toBe("System");
  });
});

describe("the Fortinet umbrella temperature row", () => {
  it("names the sensor TABLE, so the walk is the profile's fact and not the collector's", () => {
    // This block did not exist in the constant until 2026-09 — the walk was
    // dispatched by /fortinet/i inside collectHardwareSensorsSnmp, so the row
    // seeded empty and a fresh install collected no FortiGate sensors.
    expect(metric("Fortinet", "temperature")).toMatchObject({
      defaultSymbol: "fgHwSensorTable", defaultType: "table",
    });
  });
});

describe("the model identity query", () => {
  it("seeds FortiSwitch's symbol WITH its parse, under both keyings", () => {
    // A symbol with no parse would stamp raw firmware strings onto
    // Asset.model; the migration inserts the pair twice, once per keying.
    const expected = {
      symbol: "fsSysVersion",
      parsePattern: "^(?!v\\d)(.+?)[-\\s]v\\d",
      parseTemplate: "FortiSwitch $1",
    };
    expect(override("Fortinet", "model", { modelPattern: "FortiSwitch" })).toMatchObject(expected);
    expect(override("Fortinet", "model", { assetType: "switch" })).toMatchObject(expected);
  });

  it("leaves every other vendor's model row empty — none of them has an identity query", () => {
    for (const mfr of ["Cisco", "Juniper", "Mikrotik", "HP", "Dell"]) {
      expect(metric(mfr, "model")!.defaultSymbol, `${mfr} model row`).toBeNull();
    }
  });
});

describe("device-type siblings — the family said as data", () => {
  it("gives every FortiSwitch/FortiAP model row a type default beside it", () => {
    // The model regex only matches an asset whose model STATES the family. A
    // Fortinet switch discovered with an empty model (the managed-switch CMDB
    // has no model field) reached these symbols only through the
    // Fortinet-specific `fortinetClassHint` before Phase 4.
    for (const key of ["cpu", "memory", "storage"]) {
      const byModel = override("Fortinet", key, { modelPattern: "FortiSwitch" });
      const byType = override("Fortinet", key, { assetType: "switch" });
      if (!byModel) continue; // FortiAP has no storage block
      expect(byType, `switch default for ${key}`).toBeTruthy();
      expect(byType!.symbol).toBe(byModel.symbol);
      expect(byType!.symbolB ?? null).toBe(byModel.symbolB ?? null);
      expect(byType!.type).toBe(byModel.type);
    }
    expect(override("Fortinet", "cpu", { assetType: "access_point" })!.symbol).toBe("fapCpuUsage");
    expect(override("Fortinet", "temperature", { assetType: "access_point" })!.label).toBe("System");
  });

  it("never scopes a row to neither half — the DB CHECK constraint would reject it", () => {
    for (const o of h.overrides) {
      expect(Boolean(o.assetType) || Boolean(o.modelPattern), JSON.stringify(o)).toBe(true);
    }
  });

  it("keeps at most one type default per (metric row, type) — the partial unique index", () => {
    const seen = new Set<string>();
    for (const o of h.overrides) {
      if (o.modelPattern) continue;
      const key = `${o.metricRowId}:${o.assetType}`;
      expect(seen.has(key), `duplicate type default ${key}`).toBe(false);
      seen.add(key);
    }
  });
});
