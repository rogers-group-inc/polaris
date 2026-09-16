/**
 * tests/unit/profileResolverParity.test.ts — the swap changes nothing it did
 * not mean to.
 *
 * `pickDbProfile` replaces `pickVendorProfileMerged` as the collectors' source
 * of telemetry shape. The risk is not that the new resolver is wrong in an
 * obvious way — it is that it is quietly wrong for ONE seeded vendor on ONE
 * asset shape, on an install nobody is watching, and the charts just stop
 * filling. So both resolvers are driven over the same table of asset tuples
 * with the same rows, and every field the collectors read is compared.
 *
 * The rows here are the eight seeded vendor profiles AS THE PHASE 4 MIGRATION
 * LEAVES THEM — the seed job's output plus the migration's backfill. If the
 * migration and this file disagree, one of them is wrong; the migration is the
 * one that runs on an operator's database, so it is the one to trust.
 *
 * Four tuples are expected to DIFFER, each named with the bug it fixes. A
 * fifth kind of difference — any field not listed in DELTAS — fails the run.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  pickVendorProfileMerged,
  pickDbProfile,
  findDbProfile,
  resolveScopedMetric,
  modelIdentifiesDevice,
  clearProfileRegexCache,
  type ProfileSubject,
} from "../../src/services/profileResolver.js";
import type {
  ProfileFull,
  MetricRow,
  MetricOverrideRow,
} from "../../src/services/manufacturerProfileService.js";
import type { VendorTelemetryProfile } from "../../src/services/vendorTelemetryProfiles.js";

// ─── The seeded profiles, post-migration ──────────────────────────────────

let nextId = 0;
function ov(extra: Partial<MetricOverrideRow> = {}): MetricOverrideRow {
  return {
    id: `o-${nextId++}`, assetType: null, modelPattern: null, symbol: "", symbolB: null,
    mibId: null, mibStdKey: null, type: "scalar", transform: null,
    aggregate: "none", label: null, parsePattern: null, parseTemplate: null, order: 0, ...extra,
  };
}
function row(metricKey: MetricRow["metricKey"], extra: Partial<MetricRow> = {}): MetricRow {
  return {
    id: `m-${metricKey}-${nextId++}`, metricKey, defaultSymbol: null, defaultSymbolB: null,
    defaultMibId: null, defaultMibStdKey: null, defaultType: "scalar", defaultTransform: null,
    defaultAggregate: "none", defaultLabel: null, defaultParsePattern: null, defaultParseTemplate: null,
    overrides: [], ...extra,
  };
}
function profile(manufacturer: string, matchPattern: string | null, metrics: MetricRow[]): ProfileFull {
  return {
    id: `p-${manufacturer}`, manufacturer, matchPattern,
    createdBy: "system:seed", createdAt: "", updatedAt: "", widgets: [], metrics,
  };
}

// The FortiSwitch model query, exactly as the migration's two INSERTs stamp it.
const FS_PARSE = { parsePattern: "^(?!v\\d)(.+?)[-\\s]v\\d", parseTemplate: "FortiSwitch $1" };

// Fortinet: FortiOS defaults on the rows, FortiSwitch / FortiAP as model
// patterns, and beside each of those the device-type sibling the migration
// inserts (copied from the model row as the operator left it).
const FORTINET = profile("Fortinet", "fortinet|fortigate|fortios", [
  row("model", {
    overrides: [
      ov({ assetType: "switch", symbol: "fsSysVersion", ...FS_PARSE }),
      ov({ modelPattern: "FortiSwitch", symbol: "fsSysVersion", ...FS_PARSE }),
    ],
  }),
  row("cpu", {
    defaultSymbol: "fgSysCpuUsage",
    overrides: [
      ov({ modelPattern: "FortiSwitch", symbol: "fsSysCpuUsage" }),
      ov({ modelPattern: "FortiAP", symbol: "fapCpuUsage" }),
      ov({ assetType: "switch", symbol: "fsSysCpuUsage" }),
      ov({ assetType: "access_point", symbol: "fapCpuUsage" }),
    ],
  }),
  row("memory", {
    defaultSymbol: "fgSysMemUsage",
    overrides: [
      ov({ modelPattern: "FortiSwitch", symbol: "fsSysMemUsage", symbolB: "fsSysMemCapacity", type: "double_scalar", transform: "a_over_b_as_percent" }),
      ov({ modelPattern: "FortiAP", symbol: "fapMemoryUsage" }),
      ov({ assetType: "switch", symbol: "fsSysMemUsage", symbolB: "fsSysMemCapacity", type: "double_scalar", transform: "a_over_b_as_percent" }),
      ov({ assetType: "access_point", symbol: "fapMemoryUsage" }),
    ],
  }),
  // The umbrella temperature row seeded EMPTY (the FortiOS constant carries no
  // temperature block); the migration fills it with the sensor-table walk the
  // collector used to dispatch off `/fortinet/i.test(manufacturer)`.
  row("temperature", {
    defaultSymbol: "fgHwSensorTable", defaultType: "table",
    overrides: [
      ov({ modelPattern: "FortiAP", symbol: "fapTemperature", label: "System" }),
      ov({ assetType: "access_point", symbol: "fapTemperature", label: "System" }),
    ],
  }),
  row("storage", {
    overrides: [
      ov({ modelPattern: "FortiSwitch", symbol: "fsSysDiskUsage", symbolB: "fsSysDiskCapacity", type: "double_scalar", transform: "a_over_b_as_percent", label: "flash" }),
      ov({ assetType: "switch", symbol: "fsSysDiskUsage", symbolB: "fsSysDiskCapacity", type: "double_scalar", transform: "a_over_b_as_percent", label: "flash" }),
    ],
  }),
  row("interfaces"), row("lldp"), row("wirelessStations"),
]);

const CISCO = profile("Cisco", "cisco|ios-?xe|nx-?os", [
  row("model"),
  // walk-avg seeded as type="table"; the migration adds the aggregate.
  row("cpu", { defaultSymbol: "cpmCPUTotal5secRev", defaultType: "table", defaultAggregate: "avg" }),
  row("memory", {
    defaultSymbol: "ciscoMemoryPoolUsed", defaultSymbolB: "ciscoMemoryPoolFree",
    defaultType: "double_scalar", defaultTransform: "a_over_a_plus_b_as_percent",
    defaultAggregate: "sum",
  }),
  row("temperature"), row("storage"), row("interfaces"), row("lldp"), row("wirelessStations"),
]);

const JUNIPER = profile("Juniper", "juniper|junos", [
  row("model"),
  row("cpu", { defaultSymbol: "jnxOperatingCPU", defaultType: "table", defaultAggregate: "avg" }),
  row("memory", { defaultSymbol: "jnxOperatingBuffer", defaultAggregate: "avg" }),
  row("temperature"), row("storage"), row("interfaces"), row("lldp"), row("wirelessStations"),
]);

// MikroTik claims nothing: RouterOS answers CPU, memory and storage through
// HOST-RESOURCES-MIB, so every row is empty on purpose — the profile is an
// override layer and there is nothing there to override. (The `cpu` row used
// to read `mtxrSystemUserCPULoad`, a symbol that exists in no MikroTik MIB;
// see the seed job's MikroTik note.) Kept in the table so the tuple below
// still exercises "a profile exists but says nothing the collectors can use".
const MIKROTIK = profile("MikroTik", "mikrotik|routeros", [
  row("model"), row("cpu"), row("memory"), row("temperature"),
  row("storage"), row("interfaces"), row("lldp"), row("wirelessStations"),
]);

const HP = profile("HP", "aruba|hpe|hewlett|procurve|^hp\\b", [
  row("model"), row("cpu", { defaultSymbol: "hpSwitchCpuStat" }),
  row("memory"), row("temperature"), row("storage"), row("interfaces"), row("lldp"), row("wirelessStations"),
]);

const DELL = profile("Dell", "\\bdell\\b|powerconnect|force10", [
  row("model"), row("cpu", { defaultSymbol: "rlCpuUtilDuringLastMinute" }),
  row("memory"), row("temperature"), row("storage"), row("interfaces"), row("lldp"), row("wirelessStations"),
]);

const ALL = [CISCO, DELL, FORTINET, HP, JUNIPER, MIKROTIK];
const lookup = (m: string | null | undefined) =>
  ALL.find((p) => p.manufacturer.toLowerCase() === (m ?? "").toLowerCase()) ?? null;
const list = () => ALL;

// ─── The tuples ───────────────────────────────────────────────────────────

interface Tuple extends ProfileSubject { name: string }

const TUPLES: Tuple[] = [
  { name: "FortiGate",                manufacturer: "Fortinet", os: "FortiOS 7.4", model: "FortiGate-100F", assetType: "firewall" },
  { name: "FortiSwitch by model",     manufacturer: "Fortinet", os: null, model: "FortiSwitch S548DF", assetType: "switch" },
  { name: "FortiSwitch, no model",    manufacturer: "Fortinet", os: null, model: null, assetType: "switch" },
  { name: "FortiSwitch mis-typed",    manufacturer: "Fortinet", os: null, model: "FortiSwitch S548DF", assetType: "other" },
  { name: "FortiAP by model",         manufacturer: "Fortinet", os: null, model: "FortiAP-231F", assetType: "access_point" },
  { name: "FortiAP, no model",        manufacturer: "Fortinet", os: null, model: null, assetType: "access_point" },
  { name: "FortiAP typed as switch",  manufacturer: "Fortinet", os: null, model: "FortiAP-231F", assetType: "switch" },
  { name: "Cisco switch",             manufacturer: "Cisco",    os: "IOS-XE", model: "C9300-48P", assetType: "switch" },
  { name: "Cisco by OS only",         manufacturer: null,       os: "Cisco IOS 15.2", model: null, assetType: "switch" },
  { name: "Juniper switch",           manufacturer: "Juniper",  os: "Junos 21.4", model: "EX4300", assetType: "switch" },
  { name: "Mikrotik router",          manufacturer: "Mikrotik", os: "RouterOS 7", model: "CCR2004", assetType: "router" },
  { name: "HP ProCurve",              manufacturer: "HP",       os: "ProCurve", model: "2930F", assetType: "switch" },
  { name: "Aruba (alias spelling)",   manufacturer: "Aruba",    os: "ArubaOS-Switch", model: "2930F", assetType: "switch" },
  { name: "Dell PowerConnect",        manufacturer: "Dell",     os: null, model: "N3048", assetType: "switch" },
  { name: "unknown vendor",           manufacturer: "Ubiquiti", os: "EdgeOS", model: "ER-4", assetType: "router" },
  { name: "nothing known",            manufacturer: null,       os: null, model: null, assetType: null },
];

/**
 * The differences the swap is FOR. Anything else that differs fails.
 * Keyed `<tuple> · <field>`.
 */
const DELTAS: Record<string, string> = {
  // The merge hardcoded walkSubtree:false on the double_scalar path, so a
  // seeded Cisco did a scalar GET of a table column and fell to HRM. Only the
  // asset that FINDS the DB profile was affected: "Cisco by OS only" reaches
  // no DB profile under the old resolver, gets the hardcoded entry untouched,
  // and so already had walkSubtree true — it is parity, not a delta.
  "Cisco switch · memory": "walkSubtree now true — the row's aggregate says the pools are walked and summed",
  // The merge overwrote temperature with {symbol, mode} and dropped the
  // hardcoded sensorName, so a FortiAP's one reading lost its "System" label.
  "FortiAP by model · temperature": "sensorName restored from the row's label",
  "FortiAP, no model · temperature": "sensorName restored from the row's label",
  "FortiAP typed as switch · temperature": "sensorName restored from the row's label",
};

function telemetryOf(p: VendorTelemetryProfile | null) {
  return {
    cpu:         p?.cpu ?? null,
    memory:      p?.memory ?? null,
    temperature: p?.temperature ?? null,
    disk:        p?.disk ?? null,
    modelSymbol: p?.model?.symbol ?? null,
  };
}

// The regex cache is module-level and keyed by pattern text, so nothing here
// needs it cleared for correctness — it is cleared anyway so that a future
// test which edits a pattern in place cannot leak a stale compile into the
// next one.
beforeEach(() => clearProfileRegexCache());

describe("pickDbProfile vs pickVendorProfileMerged — field-by-field parity", () => {
  for (const t of TUPLES) {
    it(`${t.name}`, () => {
      const before = pickVendorProfileMerged(t.manufacturer, t.os, t.model, t.assetType, lookup);
      const after  = pickDbProfile(t, lookup, list);
      const a = telemetryOf(before);
      const b = telemetryOf(after);

      for (const field of ["cpu", "memory", "temperature", "disk", "modelSymbol"] as const) {
        const key = `${t.name} · ${field}`;
        if (key in DELTAS) {
          expect(b[field], `${key} was declared a delta but did not change: ${DELTAS[key]}`).not.toEqual(a[field]);
          continue;
        }
        expect(b[field], `${key} changed and is not a declared delta`).toEqual(a[field]);
      }
    });
  }
});

describe("the deltas, stated as what they now do", () => {
  it("Cisco memory walks and sums — the row's aggregate, not the merge's hardcoded false", () => {
    const p = pickDbProfile(
      { manufacturer: "Cisco", os: "IOS-XE", model: "C9300-48P", assetType: "switch" }, lookup, list,
    )!;
    expect(p.memory).toEqual({
      usedBytesSymbol: "ciscoMemoryPoolUsed", freeBytesSymbol: "ciscoMemoryPoolFree", walkSubtree: true,
    });
    expect(p.cpu).toEqual({ symbol: "cpmCPUTotal5secRev", mode: "walk-avg" });
  });

  it("a FortiAP's single temperature reading keeps its System label", () => {
    const p = pickDbProfile(
      { manufacturer: "Fortinet", os: null, model: "FortiAP-231F", assetType: "access_point" }, lookup, list,
    )!;
    expect(p.temperature).toEqual({ symbol: "fapTemperature", mode: "scalar", sensorName: "System" });
  });

  it("a FortiGate's hardware sensors come from the profile row, as they already did", () => {
    // Not a delta: the FortiOS constant carries no temperature block, so the
    // sensor-table walk used to be dispatched by `/fortinet/i.test(...)` in
    // the collector — but the MIGRATION, not the resolver, is what turned it
    // into a row, and the old merge reads that row too. Pinned here because
    // it is the one metric whose source moved without its value changing.
    const p = pickDbProfile(
      { manufacturer: "Fortinet", os: "FortiOS 7.4", model: "FortiGate-100F", assetType: "firewall" }, lookup, list,
    )!;
    expect(p.temperature).toEqual({ symbol: "fgHwSensorTable", mode: "table" });
  });
});

describe("a device is ONE family — the type tier never fills a model's gaps", () => {
  it("a FortiAP mis-typed as a switch gets no storage rather than the FortiSwitch flash OIDs", () => {
    // Every metric the FortiAP model rows cover resolves as a FortiAP. Storage
    // is the gap: the Fortinet profile has no FortiAP storage row. Falling
    // through to the SWITCH type default would hand this AP fsSysDiskUsage and
    // chart a flash partition it does not have.
    const ap: ProfileSubject = { manufacturer: "Fortinet", os: null, model: "FortiAP-231F", assetType: "switch" };
    const p = pickDbProfile(ap, lookup, list)!;
    expect(p.cpu?.symbol).toBe("fapCpuUsage");
    expect(p.memory).toMatchObject({ pctSymbol: "fapMemoryUsage" });
    expect(p.disk).toBeUndefined();
    expect(p.model).toBeUndefined();
  });

  it("the same asset with no model DOES read the switch defaults — nothing states otherwise", () => {
    const p = pickDbProfile({ manufacturer: "Fortinet", os: null, model: null, assetType: "switch" }, lookup, list)!;
    expect(p.cpu?.symbol).toBe("fsSysCpuUsage");
    expect(p.disk).toMatchObject({ usedBytesSymbol: "fsSysDiskUsage", mountPath: "flash" });
  });

  it("modelIdentifiesDevice ignores a row scoped under a device type", () => {
    // A row with BOTH halves is an exception reachable only through its type;
    // it says nothing about what the device IS, so it must not suppress the
    // type defaults that are its own siblings.
    const p = profile("X", null, [
      row("cpu", { overrides: [ov({ assetType: "switch", modelPattern: "S548", symbol: "scoped" })] }),
    ]);
    expect(modelIdentifiesDevice(p, "S548DF")).toBe(false);
    expect(modelIdentifiesDevice(FORTINET, "FortiAP-231F")).toBe(true);
    expect(modelIdentifiesDevice(FORTINET, "FortiGate-100F")).toBe(false);
    expect(modelIdentifiesDevice(FORTINET, "")).toBe(false);
  });
});

describe("the model query survives the move from a function to a row", () => {
  // The vectors fortiswitchModel.test.ts pins against real fsSysVersion
  // strings. Both resolvers must produce the same Asset.model for each.
  const RAW = [
    "S548DF-v7.2.5-build0453,230511 (GA)",
    "S124EP-v7.0.6-build0366,221202 (GA)",
    "FortiSwitchRugged-112D-POE-v6.4.11-build0511,220830 (GA)",
    "v7.2.5-build0453,230511 (GA)",
  ];

  it("parses every vector the same way the hardcoded parse did", () => {
    const subject: ProfileSubject = { manufacturer: "Fortinet", os: null, model: "FortiSwitch S548DF", assetType: "switch" };
    const before = pickVendorProfileMerged(subject.manufacturer, subject.os, subject.model, subject.assetType, lookup)!;
    const after  = pickDbProfile(subject, lookup, list)!;
    expect(after.model?.symbol).toBe(before.model?.symbol);
    for (const raw of RAW) {
      expect(after.model!.parse(raw), `parse mismatch on ${raw}`).toBe(before.model!.parse(raw));
    }
  });

  it("a modelless switch gets the query through the device-type tier", () => {
    const p = pickDbProfile({ manufacturer: "Fortinet", os: null, model: null, assetType: "switch" }, lookup, list)!;
    expect(p.model?.symbol).toBe("fsSysVersion");
    expect(p.model!.parse("S548DF-v7.2.5-build0453,230511 (GA)")).toBe("FortiSwitch S548DF");
  });
});

describe("findDbProfile — the manufacturer key first, matchPattern second", () => {
  it("a keyed manufacturer never reaches the pattern scan", () => {
    // "HP"'s pattern would also match a Cisco-ish haystack if it were ever
    // consulted first; the keyed hit is what must win.
    expect(findDbProfile({ manufacturer: "Cisco", os: "IOS-XE", model: null, assetType: null }, lookup, list))
      .toBe(CISCO);
  });

  it("an alias spelling the seed did not key resolves through the pattern", () => {
    // The gap profileResolver.test.ts named: the alias map canonicalizes
    // "Aruba Networks" to "Aruba", and the seed keyed one profile "HP".
    expect(lookup("Aruba")).toBeNull();
    expect(findDbProfile({ manufacturer: "Aruba", os: "ArubaOS-Switch", model: null, assetType: null }, lookup, list))
      .toBe(HP);
  });

  it("OS-only identity resolves — SNMP reported a version string and no vendor", () => {
    expect(findDbProfile({ manufacturer: null, os: "Cisco IOS 15.2", model: null, assetType: null }, lookup, list))
      .toBe(CISCO);
  });

  it("a pinned MIB module is the third field of the haystack", () => {
    expect(findDbProfile(
      { manufacturer: null, os: null, model: null, assetType: null, mibModule: "FORTINET-FORTIGATE-MIB" }, lookup, list,
    )).toBe(FORTINET);
  });

  it("no signal at all, and a vendor nothing claims, both resolve to nothing", () => {
    expect(findDbProfile({ manufacturer: null, os: null, model: null, assetType: null }, lookup, list)).toBeNull();
    expect(findDbProfile({ manufacturer: "Ubiquiti", os: "EdgeOS", model: "ER-4", assetType: null }, lookup, list)).toBeNull();
    expect(pickDbProfile({ manufacturer: "Ubiquiti", os: "EdgeOS", model: "ER-4", assetType: null }, lookup, list)).toBeNull();
  });

  it("a profile with rows but nothing the collectors read answers null, not an empty shell", () => {
    const bare = profile("Bare", null, [row("interfaces"), row("lldp")]);
    const only = () => [bare];
    expect(pickDbProfile({ manufacturer: "Bare", os: null, model: null, assetType: null }, () => bare, only)).toBeNull();
  });
});

describe("resolveScopedMetric — most-specific-first", () => {
  const m = row("cpu", {
    defaultSymbol: "row-default",
    overrides: [
      ov({ assetType: "switch", modelPattern: "S548", symbol: "type+model", order: 0 }),
      ov({ modelPattern: "S548", symbol: "model-only", order: 1 }),
      ov({ assetType: "switch", symbol: "type-default", order: 2 }),
    ],
  });

  it("walks the four tiers in order", () => {
    expect(resolveScopedMetric(m, "switch", "S548DF")?.symbol).toBe("type+model");
    expect(resolveScopedMetric(m, "router", "S548DF")?.symbol).toBe("model-only");
    expect(resolveScopedMetric(m, "switch", "C9300")?.symbol).toBe("type-default");
    expect(resolveScopedMetric(m, "router", "C9300")?.symbol).toBe("row-default");
  });

  it("a stated model outranks an inferred type — tier 2 beats tier 3", () => {
    // The asset is typed `switch` but its model names another family. The
    // model-only row wins over this type's default, so an asset discovery
    // mis-typed still routes by what it says it is.
    const mis = row("cpu", {
      defaultSymbol: "row-default",
      overrides: [
        ov({ modelPattern: "FortiAP", symbol: "fapCpuUsage", order: 0 }),
        ov({ assetType: "switch", symbol: "fsSysCpuUsage", order: 1 }),
      ],
    });
    expect(resolveScopedMetric(mis, "switch", "FortiAP-231F")?.symbol).toBe("fapCpuUsage");
    expect(resolveScopedMetric(mis, "switch", "")?.symbol).toBe("fsSysCpuUsage");
  });

  it("device types compare case- and whitespace-insensitively", () => {
    expect(resolveScopedMetric(m, " Switch ", "C9300")?.symbol).toBe("type-default");
  });

  it("an unconfigured row and a missing row are both null", () => {
    expect(resolveScopedMetric(row("cpu"), "switch", "anything")).toBeNull();
    expect(resolveScopedMetric(undefined, "switch", "anything")).toBeNull();
  });

  it("a malformed pattern is skipped, not thrown, and the next tier answers", () => {
    const bad = row("cpu", {
      defaultSymbol: "row-default",
      overrides: [ov({ modelPattern: "([unclosed", symbol: "never", order: 0 })],
    });
    expect(resolveScopedMetric(bad, null, "anything")?.symbol).toBe("row-default");
  });
});
