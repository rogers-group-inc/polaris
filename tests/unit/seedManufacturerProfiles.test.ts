/**
 * tests/unit/seedManufacturerProfiles.test.ts — what a FRESH install's
 * manufacturer profiles are, and which vendors get one at all.
 *
 * Two separable things, tested separately because they change for different
 * reasons:
 *
 * 1. **The shape** each vendor's rows take — `profileToMetricSeeds`, a pure
 *    translation of the hardcoded vendor entry. This is the fresh-install half
 *    of a pair with the `20260915020000_manufacturer_profile_resolver_swap`
 *    migration: on a fresh install `prisma migrate deploy` runs BEFORE this
 *    job, so every backfill UPDATE in that migration matches zero rows and only
 *    what the seed writes survives. The expectations are written as that
 *    migration's end state so the two can be diffed by eye. It already went
 *    wrong once — Phase 4 added the `model` metric key, this job kept a private
 *    copy of METRIC_KEYS, and fresh installs got no identity query at all,
 *    which is the FortiSwitch deadlock (a switch whose model is empty can never
 *    fill it in) coming straight back.
 *
 *    These cases run for EVERY vendor regardless of which are seeded, because
 *    the translation is what the operator's own profile will be built from
 *    whether Polaris seeds it or not.
 *
 * 2. **Which vendors are seeded** — `PROFILE_SEEDED_MANUFACTURERS`, which is
 *    expected to move as vendors are added. A profile is an OVERRIDE layer
 *    over what the generic MIBs already do, so a vendor earns one only when
 *    Polaris also seeds its MIB (`jobs/seedVendorMibs.ts`) AND it has
 *    something the standard MIBs cannot say.
 *
 * Prisma is mocked; what is asserted is the payloads the job would write.
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

const {
  seedManufacturerProfiles, profileToMetricSeeds, SEED_MAP, PROFILE_SEEDED_MANUFACTURERS,
} = await import("../../src/jobs/seedManufacturerProfiles.js");
const { METRIC_KEYS } = await import("../../src/services/manufacturerProfileService.js");
const { VENDOR_TELEMETRY_PROFILES } = await import("../../src/services/vendorTelemetryProfiles.js");

beforeEach(async () => {
  h.profiles = [];
  h.metrics = [];
  h.overrides = [];
  await seedManufacturerProfiles();
});

/** The metric seeds for one vendor entry, by its human label. */
function seedsFor(vendorLabel: string) {
  const entry = VENDOR_TELEMETRY_PROFILES.find((p) => p.vendor === vendorLabel);
  if (!entry) throw new Error(`no vendor entry named "${vendorLabel}"`);
  return profileToMetricSeeds(entry);
}
const metricSeed = (vendorLabel: string, key: string) =>
  seedsFor(vendorLabel).find((s) => s.metricKey === key);

// ─── 1. The shape — every vendor, bundled or not ─────────────────────────

describe("aggregate — how a walked subtree collapses", () => {
  it("sums Cisco's memory pools and averages its CPU table", () => {
    // The delta the whole Phase 4 swap exists for: the old merge hardcoded
    // walkSubtree=false on the pair path, so a seeded Cisco did a scalar GET
    // of a table column and fell to HOST-RESOURCES-MIB.
    expect(metricSeed("Cisco IOS / IOS-XE / NX-OS", "memory")).toMatchObject({
      symbol: "ciscoMemoryPoolUsed", symbolB: "ciscoMemoryPoolFree",
      type: "double_scalar", aggregate: "sum",
    });
    expect(metricSeed("Cisco IOS / IOS-XE / NX-OS", "cpu")).toMatchObject({ type: "table", aggregate: "avg" });
  });

  it("averages Juniper's per-entity readings, both of them", () => {
    expect(metricSeed("Juniper Junos", "cpu")).toMatchObject({ symbol: "jnxOperatingCPU", aggregate: "avg" });
    expect(metricSeed("Juniper Junos", "memory")).toMatchObject({ symbol: "jnxOperatingBuffer", aggregate: "avg" });
  });

  it("leaves a shape that walks nothing at none", () => {
    expect(metricSeed("Fortinet FortiOS (SNMP path)", "cpu")!.aggregate).toBe("none");
    expect(metricSeed("Fortinet FortiSwitch (SNMP path)", "memory")!.aggregate).toBe("none");
  });
});

describe("MikroTik claims nothing, because there is nothing it can honestly claim", () => {
  it("seeds no rows at all", () => {
    // RouterOS answers CPU, memory and storage through HOST-RESOURCES-MIB,
    // which Polaris already reads — a profile exists to OVERRIDE the generic
    // path and there is nothing here to override. The one thing MIKROTIK-MIB
    // adds, the mtxrHealth temperature sensor, is DISPLAY-HINT "d-1" and needs
    // scaling at COLLECTION, which nothing performs.
    expect(seedsFor("Mikrotik RouterOS")).toEqual([]);
  });

  it("does not name mtxrSystemUserCPULoad — it does not exist in MIKROTIK-MIB", () => {
    // The constant claimed this symbol until 2026-09-16. It appears nowhere in
    // MikroTik's own MIB (checked against their download and the LibreNMS
    // mirror), so the row never resolved on any install and never could.
    expect(JSON.stringify(seedsFor("Mikrotik RouterOS"))).not.toContain("mtxrSystemUserCPULoad");
  });
});

describe("no seeded row carries a transform nothing would apply", () => {
  it("leaves unary transforms off cpu / temperature / storage rows", () => {
    // `applyTransform` has ONE call site in src/ — the custom-widget collector.
    // A unary transform on a profile METRIC row is stored, displayed in the
    // Transform column, and never applied. Seeding one would ship a row whose
    // readings are silently in the wrong unit, which is exactly how a MikroTik
    // sensor row nearly shipped charting 315 °C instead of 31.5.
    //
    // `memory` and `storage` double_scalar rows are exempt: their `transform`
    // is a CombinerKind read as a statement of WHICH PAIR the two symbols are,
    // not as arithmetic to perform.
    for (const entry of VENDOR_TELEMETRY_PROFILES) {
      for (const s of profileToMetricSeeds(entry)) {
        if (s.type === "double_scalar") continue;
        expect(s.transform, `${entry.vendor} ${s.metricKey} carries an inert transform`).toBeNull();
      }
    }
  });
});

describe("label — the synthesized sample row's name", () => {
  it("labels FortiSwitch storage flash and a FortiAP's one sensor System", () => {
    // Both are keys an operator's pins and thresholds attach to; a row that
    // seeds without them comes back as the collector's default ("system") and
    // an existing pin stops matching.
    expect(metricSeed("Fortinet FortiSwitch (SNMP path)", "storage")!.label).toBe("flash");
    expect(metricSeed("Fortinet FortiAP (SNMP path)", "temperature")!.label).toBe("System");
  });
});

describe("the Fortinet umbrella temperature row", () => {
  it("names the sensor TABLE, so the walk is the profile's fact and not the collector's", () => {
    // This block did not exist in the constant until 2026-09 — the walk was
    // dispatched by /fortinet/i inside collectHardwareSensorsSnmp, so the row
    // seeded empty and a fresh install collected no FortiGate sensors.
    expect(metricSeed("Fortinet FortiOS (SNMP path)", "temperature")).toMatchObject({
      symbol: "fgHwSensorTable", type: "table",
    });
  });
});

describe("the model identity query", () => {
  it("carries FortiSwitch's symbol WITH its parse", () => {
    // A symbol with no parse would stamp raw firmware strings onto Asset.model.
    expect(metricSeed("Fortinet FortiSwitch (SNMP path)", "model")).toMatchObject({
      symbol: "fsSysVersion",
      parsePattern: "^(?!v\\d)(.+?)[-\\s]v\\d",
      parseTemplate: "FortiSwitch $1",
    });
  });

  it("is absent for every vendor with no identity query", () => {
    for (const label of ["Cisco IOS / IOS-XE / NX-OS", "Juniper Junos", "Mikrotik RouterOS",
                         "HP / Aruba ProCurve", "Dell PowerConnect / Networking"]) {
      expect(metricSeed(label, "model"), `${label} has a model seed`).toBeUndefined();
    }
  });

  it("never seeds a model symbol without a parse", () => {
    for (const entry of VENDOR_TELEMETRY_PROFILES) {
      const m = profileToMetricSeeds(entry).find((s) => s.metricKey === "model");
      if (!m) continue;
      expect(m.parsePattern, `${entry.vendor} model seed has no parse`).toBeTruthy();
    }
  });
});

describe("matchPattern is the vendor entry's own regex, never retyped", () => {
  it("matches the migration's six literal UPDATEs", () => {
    // Both sides come from `match`, which is why they agree.
    const src = (label: string) => VENDOR_TELEMETRY_PROFILES.find((p) => p.vendor === label)!.match.source;
    expect(src("Cisco IOS / IOS-XE / NX-OS")).toBe("cisco|ios-?xe|nx-?os");
    expect(src("Juniper Junos")).toBe("juniper|junos");
    expect(src("Mikrotik RouterOS")).toBe("mikrotik|routeros");
    expect(src("Fortinet FortiOS (SNMP path)")).toBe("fortinet|fortigate|fortios");
    expect(src("HP / Aruba ProCurve")).toBe("aruba|hpe|hewlett|procurve|^hp\\b");
    expect(src("Dell PowerConnect / Networking")).toBe("\\bdell\\b|powerconnect|force10");
  });
});

// ─── 2. Which vendors are seeded ─────────────────────────────────────────

describe("a profile is seeded only for a vendor whose MIB Polaris bundles", () => {
  it("seeds exactly the bundled manufacturers, and nothing else", () => {
    expect(h.profiles.map((p) => p.manufacturer).sort())
      .toEqual([...PROFILE_SEEDED_MANUFACTURERS].sort());
  });

  it("keeps every vendor in SEED_MAP regardless — that is where the symbol names live", () => {
    // Removing a vendor from SEED_MAP would discard the knowledge of WHICH
    // symbol is the CPU. That is not vendor-OID ownership, it is the part the
    // docs table and Phase 6's profile packs are written from.
    expect(SEED_MAP.map((s) => s.manufacturer)).toEqual(
      expect.arrayContaining(["Cisco", "Juniper", "MikroTik", "Fortinet", "HP", "Dell"]),
    );
    for (const row of SEED_MAP) {
      expect(
        VENDOR_TELEMETRY_PROFILES.some((p) => p.vendor === row.vendorLabel),
        `SEED_MAP names "${row.vendorLabel}", which no vendor entry matches`,
      ).toBe(true);
    }
  });

  it("names every manufacturer in its CANONICAL form, so seeding never depends on cache warmth", async () => {
    // `normalizeManufacturer` returns its input UNCHANGED while the alias map
    // is unloaded (`if (!map) return trimmed`), and the startup jobs' IIFEs are
    // fire-and-forget, so whether the alias refresh has landed when this job
    // runs is a race. Observed 2026-09-16: the same boot wrote the MIB row as
    // "MikroTik" (normalized) and the profile as "Mikrotik" (not), because the
    // two touched the map either side of it being filled.
    //
    // Writing the canonical spelling here makes the outcome identical either
    // way — a fixed point of the map is unchanged whether or not it is loaded.
    const { setAliasMap } = await import("../../src/utils/manufacturerNormalize.js");
    const { DEFAULT_ALIASES } = await import("../../src/services/manufacturerAliasService.js");
    setAliasMap(DEFAULT_ALIASES.map((a) => [a.alias.toLowerCase(), a.canonical] as [string, string]));
    const { normalizeManufacturer } = await import("../../src/utils/manufacturerNormalize.js");

    for (const row of SEED_MAP) {
      expect(
        normalizeManufacturer(row.manufacturer),
        `SEED_MAP has "${row.manufacturer}" but the alias map canonicalizes it`,
      ).toBe(row.manufacturer);
    }
    for (const mfr of PROFILE_SEEDED_MANUFACTURERS) {
      expect(normalizeManufacturer(mfr), `PROFILE_SEEDED_MANUFACTURERS has "${mfr}"`).toBe(mfr);
    }
  });

  it("every bundled manufacturer is one SEED_MAP actually knows", () => {
    // A typo here would seed nothing and say nothing about it.
    for (const mfr of PROFILE_SEEDED_MANUFACTURERS) {
      expect(SEED_MAP.some((s) => s.manufacturer === mfr), `${mfr} is not in SEED_MAP`).toBe(true);
    }
  });

  it("writes no override for an unseeded manufacturer", () => {
    const seededIds = new Set(h.metrics.map((m) => m.id));
    for (const o of h.overrides) {
      expect(seededIds.has(o.metricRowId), "override on a metric row no seeded profile owns").toBe(true);
    }
  });
});

// ─── The structural rules, for whatever IS seeded ────────────────────────

describe("the rows a seeded profile writes", () => {
  it("uses the service's METRIC_KEYS, not a copy of it", () => {
    // The copy is exactly what went wrong: Phase 4 added `model` to the
    // service's list and this job never heard about it.
    expect(METRIC_KEYS).toContain("model");
    for (const p of h.profiles) {
      const keys = h.metrics.filter((m) => m.profileId === p.id).map((m) => m.metricKey);
      expect(keys.sort(), `${p.manufacturer} is missing a metric row`).toEqual([...METRIC_KEYS].sort());
    }
  });

  it("stamps each profile's matchPattern from its umbrella entry", () => {
    for (const p of h.profiles) {
      const row = SEED_MAP.find((s) => s.manufacturer === p.manufacturer && s.modelPattern === null);
      const entry = VENDOR_TELEMETRY_PROFILES.find((v) => v.vendor === row?.vendorLabel);
      expect(p.matchPattern, `${p.manufacturer}`).toBe(entry!.match.source);
    }
  });

  it("never scopes an override to neither half — the DB CHECK constraint would reject it", () => {
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

  it("gives every sub-family model row a device-type sibling", () => {
    // The model regex only matches an asset whose model STATES the family. A
    // Fortinet switch discovered with an empty model (the managed-switch CMDB
    // has no model field) reached these symbols only through the
    // Fortinet-specific `fortinetClassHint` before Phase 4.
    const byModel = h.overrides.filter((o) => o.modelPattern && !o.assetType);
    for (const m of byModel) {
      const row = SEED_MAP.find((s) => s.modelPattern === m.modelPattern);
      if (!row?.assetType) continue;
      const sibling = h.overrides.find(
        (o) => o.metricRowId === m.metricRowId && o.assetType === row.assetType && !o.modelPattern,
      );
      expect(sibling, `no ${row.assetType} default beside ${m.modelPattern}/${m.symbol}`).toBeTruthy();
      expect(sibling!.symbol).toBe(m.symbol);
    }
  });
});
