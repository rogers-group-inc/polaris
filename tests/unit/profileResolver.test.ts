/**
 * tests/unit/profileResolver.test.ts — what `pickVendorProfileMerged` answers
 * TODAY, pinned before the resolver swap changes its source of truth.
 *
 * Phase 4 of uniform SNMP replaces this merge (hardcoded constant + DB rows
 * layered over it) with a DB-only pick. These cases are the "before" half of
 * that parity argument: an in-memory profile shaped exactly the way the seed
 * job writes it, driven through the injected lookup, asserting the shape the
 * collectors receive. Two of them pin BEHAVIOUR THE SWAP WILL CHANGE ON
 * PURPOSE and say so — a test that silently agreed with a bug would make the
 * parity table meaningless.
 */

import { describe, it, expect } from "vitest";
import { pickDbProfile, pickVendorProfileMerged, resolveDbMetric } from "../../src/services/profileResolver.js";
import type { ProfileFull, MetricRow, MetricOverrideRow } from "../../src/services/manufacturerProfileService.js";

function ov(modelPattern: string, symbol: string, extra: Partial<MetricOverrideRow> = {}): MetricOverrideRow {
  return {
    id: `o-${symbol}`, assetType: null, modelPattern, symbol, symbolB: null, mibId: null, mibStdKey: null, type: "scalar", transform: null,
    aggregate: "none", label: null, parsePattern: null, parseTemplate: null, order: 0, ...extra,
  };
}
function row(metricKey: MetricRow["metricKey"], extra: Partial<MetricRow> = {}): MetricRow {
  return {
    id: `m-${metricKey}`, metricKey, defaultSymbol: null, defaultSymbolB: null, defaultMibId: null, defaultMibStdKey: null, defaultType: "scalar", defaultTransform: null,
    defaultAggregate: "none", defaultLabel: null, defaultParsePattern: null, defaultParseTemplate: null, overrides: [], ...extra,
  };
}

// The Fortinet profile exactly as the seed stamps it: FortiOS defaults on the
// rows, FortiSwitch / FortiAP as model-pattern overrides.
const FORTINET: ProfileFull = {
  id: "p-fortinet", manufacturer: "Fortinet", matchPattern: null, createdBy: "system:seed", createdAt: "", updatedAt: "", widgets: [],
  metrics: [
    row("cpu", { defaultSymbol: "fgSysCpuUsage", overrides: [ov("FortiSwitch", "fsSysCpuUsage"), ov("FortiAP", "fapCpuUsage")] }),
    row("memory", { defaultSymbol: "fgSysMemUsage", overrides: [
      ov("FortiSwitch", "fsSysMemUsage", { symbolB: "fsSysMemCapacity", type: "double_scalar", transform: "a_over_b_as_percent" }),
      ov("FortiAP", "fapMemoryUsage"),
    ] }),
    row("temperature", { overrides: [ov("FortiAP", "fapTemperature")] }),
    row("storage", { overrides: [ov("FortiSwitch", "fsSysDiskUsage", { symbolB: "fsSysDiskCapacity", type: "double_scalar", transform: "a_over_b_as_percent" })] }),
    row("interfaces"), row("lldp"), row("wirelessStations"),
  ],
};
const CISCO: ProfileFull = {
  id: "p-cisco", manufacturer: "Cisco", matchPattern: null, createdBy: "system:seed", createdAt: "", updatedAt: "", widgets: [],
  metrics: [
    row("cpu", { defaultSymbol: "cpmCPUTotal5secRev", defaultType: "table" }),
    row("memory", { defaultSymbol: "ciscoMemoryPoolUsed", defaultSymbolB: "ciscoMemoryPoolFree", defaultType: "double_scalar", defaultTransform: "a_over_a_plus_b_as_percent" }),
    row("temperature"), row("storage"), row("interfaces"), row("lldp"), row("wirelessStations"),
  ],
};
const lookup = (m: string | null | undefined) => {
  const k = (m ?? "").toLowerCase();
  return k === "fortinet" ? FORTINET : k === "cisco" ? CISCO : null;
};

describe("pickVendorProfileMerged — today's merge", () => {
  it("routes a modelless Fortinet switch to the FortiSwitch symbols AND keeps the model query", () => {
    // The prod deadlock case (fortinetClassHint.test.ts): empty model, typed
    // switch. The hint puts "FortiSwitch" in the haystack, the override
    // matches, and the hardcoded base's `model` query survives the clone.
    const p = pickVendorProfileMerged("Fortinet", null, null, "switch", lookup)!;
    expect(p.cpu?.symbol).toBe("fsSysCpuUsage");
    expect(p.memory).toMatchObject({ usedBytesSymbol: "fsSysMemUsage", totalBytesSymbol: "fsSysMemCapacity" });
    expect(p.disk).toMatchObject({ usedBytesSymbol: "fsSysDiskUsage", totalBytesSymbol: "fsSysDiskCapacity", mountPath: "flash" });
    expect(p.model?.symbol).toBe("fsSysVersion");
  });

  it("a stated model beats an inferred type — FortiAP-231F typed as a switch is a FortiAP", () => {
    const p = pickVendorProfileMerged("Fortinet", null, "FortiAP-231F", "switch", lookup)!;
    expect(p.cpu?.symbol).toBe("fapCpuUsage");
    expect(p.temperature).toMatchObject({ symbol: "fapTemperature", mode: "scalar" });
  });

  it("a FortiGate gets the FortiOS defaults", () => {
    const p = pickVendorProfileMerged("Fortinet", "FortiOS 7.4", "FortiGate-100F", "firewall", lookup)!;
    expect(p.cpu?.symbol).toBe("fgSysCpuUsage");
    expect(p.memory).toMatchObject({ pctSymbol: "fgSysMemUsage" });
    expect(p.model).toBeUndefined();
  });

  it("KNOWN DELTA #1 — Cisco memory walks NOTHING today (walkSubtree hardcoded false on the pair path)", () => {
    // The hardcoded Cisco entry says walkSubtree: true (memory pools are
    // walked and summed). The merge writes `walkSubtree: false` on every
    // double_scalar pick, so a seeded install does a scalar GET of a table
    // column, gets noSuchInstance, and falls to HOST-RESOURCES-MIB. The swap
    // fixes this via the row's `aggregate`; the parity test lists it.
    const p = pickVendorProfileMerged("Cisco", "IOS-XE", "C9300-48P", "switch", lookup)!;
    expect(p.memory).toMatchObject({ usedBytesSymbol: "ciscoMemoryPoolUsed", freeBytesSymbol: "ciscoMemoryPoolFree", walkSubtree: false });
    expect(p.cpu).toMatchObject({ symbol: "cpmCPUTotal5secRev", mode: "walk-avg" });
  });

  it("KNOWN DELTA #2 — the mis-typed asset with a stated model still routes by the model", () => {
    // A Fortinet asset typed `other` whose model says FortiSwitch: the model
    // regex matches, so it gets the FortiSwitch symbols. The swap keeps a
    // model-pattern row for exactly this case beside the new type default.
    const p = pickVendorProfileMerged("Fortinet", null, "FortiSwitch S548DF", "other", lookup)!;
    expect(p.cpu?.symbol).toBe("fsSysCpuUsage");
  });

  it("falls back to the hardcoded entry when the DB has no profile, and to null when neither has one", () => {
    const juniper = pickVendorProfileMerged("Juniper", "Junos 21.4", "EX4300", "switch", lookup)!;
    expect(juniper.cpu?.symbol).toBe("jnxOperatingCPU");
    expect(juniper.memory).toMatchObject({ pctSymbol: "jnxOperatingBuffer", walkSubtree: true });
    expect(pickVendorProfileMerged("Ubiquiti", "EdgeOS", "ER-4", "router", lookup)).toBeNull();
    expect(pickVendorProfileMerged(null, null, null, null, lookup)).toBeNull();
  });

  it("KNOWN GAP — an alias-canonical spelling the seed did not key finds no DB profile", () => {
    // "Aruba" is what the alias map canonicalizes "Aruba Networks" to, but
    // the seed keyed one profile "HP". Today the hardcoded regex still
    // catches it; the swap gives the profile a `matchPattern` for this.
    const p = pickVendorProfileMerged("Aruba", "ArubaOS-Switch", "2930F", "switch", lookup)!;
    expect(p.cpu?.symbol).toBe("hpSwitchCpuStat");
    expect(lookup("Aruba")).toBeNull();
  });
});

describe("temperature transform — only what the collector applies reaches it", () => {
  // A MikroTik-shaped profile: one scalar sensor row whose raw integer is
  // tenths of a degree (DISPLAY-HINT "d-1").
  const mikrotik = (extra: Partial<MetricRow>): ProfileFull => ({
    id: "p-mikrotik", manufacturer: "MikroTik", matchPattern: null, createdBy: "admin", createdAt: "", updatedAt: "", widgets: [],
    metrics: [row("temperature", { defaultSymbol: "mtxrHlTemperature", ...extra })],
  });
  const subject = { manufacturer: "MikroTik", os: null, model: "CCR2004", assetType: "router" };
  const pick = (p: ProfileFull) => pickDbProfile(subject, () => p, () => [p]);

  it("carries tenths_to_units from a scalar row onto the temperature query", () => {
    expect(pick(mikrotik({ defaultTransform: "tenths_to_units" }))?.temperature)
      .toMatchObject({ symbol: "mtxrHlTemperature", mode: "scalar", transform: "tenths_to_units" });
  });

  it("drops a transform stored before the write path narrowed — Celsius→Fahrenheit converts nothing", () => {
    // The 2026-09-16 prod row. Now that the collector reads the field, a stale
    // value must not suddenly start rewriting stored temperatures.
    expect(pick(mikrotik({ defaultTransform: "celsius_to_fahrenheit" }))?.temperature?.transform).toBeUndefined();
    expect(pick(mikrotik({ defaultTransform: "bytes_to_mb" }))?.temperature?.transform).toBeUndefined();
  });

  it("drops a transform on a table row — the sensor-table walk takes none", () => {
    expect(pick(mikrotik({ defaultType: "table", defaultTransform: "tenths_to_units" }))?.temperature)
      .toMatchObject({ mode: "table" });
    expect(pick(mikrotik({ defaultType: "table", defaultTransform: "tenths_to_units" }))?.temperature?.transform).toBeUndefined();
  });

  it("the retired merge resolver agrees, so the parity table stays honest", () => {
    const p = mikrotik({ defaultTransform: "tenths_to_units" });
    expect(pickVendorProfileMerged("MikroTik", null, "CCR2004", "router", () => p)?.temperature?.transform).toBe("tenths_to_units");
  });
});

describe("resolveDbMetric — today's override walk", () => {
  it("first matching override in order wins, else the row default, else null", () => {
    // Two overrides that BOTH match the FortiSwitch model: the first in
    // `order` wins. A FortiGate matches neither and gets the row default.
    const m = row("cpu", { defaultSymbol: "fgSysCpuUsage", overrides: [ov("FortiSwitch", "fsSysCpuUsage"), ov("S548DF", "never")] });
    expect(resolveDbMetric(m, "FortiSwitch S548DF")?.symbol).toBe("fsSysCpuUsage");
    expect(resolveDbMetric(m, "FortiGate-60F")?.symbol).toBe("fgSysCpuUsage");
    expect(resolveDbMetric(row("cpu"), "anything")).toBeNull();
    expect(resolveDbMetric(undefined, "anything")).toBeNull();
  });
});
