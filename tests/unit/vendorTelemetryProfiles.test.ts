/**
 * tests/unit/vendorTelemetryProfiles.test.ts — CQ-T010: the built-in vendor
 * SNMP telemetry registry and its translators.
 *
 * fortinetClassHint.test.ts pins the Fortinet class hint and vendorDiskQuery
 * the disk-row arithmetic in depth; sensorTableColumns.test.ts pins the
 * FortiGate sensor columns against their migration. This file pins the rest:
 *
 *   - pickVendorProfile: first-match-wins over `manufacturer os model hint`,
 *     the FortiSwitch / FortiAP entries ordered ahead of generic FortiOS,
 *     OS-only and model-only matches, the empty haystack;
 *   - the registry's own shape (every entry's symbols are names, not numeric
 *     OIDs — the vendor-SNMP boundary; MikroTik deliberately carries nothing;
 *     the FortiGate sensor row is a `table`, rule 132);
 *   - memoryQueryToDoubleScalar for every hardcoded memory block, and the
 *     disk translators as a round trip.
 */

import { describe, it, expect } from "vitest";
import {
  VENDOR_TELEMETRY_PROFILES,
  FORTIGATE_SENSOR_COLUMNS,
  pickVendorProfile,
  fortinetClassHint,
  memoryQueryToDoubleScalar,
  diskQueryFromMetricPick,
  diskQueryToDoubleScalar,
  deriveDiskBytes,
  type DiskQuery,
} from "../../src/services/vendorTelemetryProfiles.js";

const vendorOf = (...args: Parameters<typeof pickVendorProfile>) => pickVendorProfile(...args)?.vendor ?? null;
const byVendor = (needle: string) => {
  const p = VENDOR_TELEMETRY_PROFILES.find((x) => x.vendor.includes(needle));
  if (!p) throw new Error(`no profile ${needle}`);
  return p;
};

// ─── pickVendorProfile ──────────────────────────────────────────────────────

describe("pickVendorProfile — matching", () => {
  it("returns null when every identity field is empty", () => {
    expect(pickVendorProfile(null, null)).toBeNull();
    expect(pickVendorProfile("", "", "", null)).toBeNull();
    expect(pickVendorProfile(undefined, "  ", undefined)).toBeNull();
  });

  it("returns null for a vendor with no profile — the caller falls back to HOST-RESOURCES-MIB", () => {
    expect(pickVendorProfile("Ubiquiti", "EdgeOS", "ER-4")).toBeNull();
    expect(pickVendorProfile("Microsoft", "Windows Server 2022")).toBeNull();
  });

  it.each([
    ["Cisco Systems", null, "Cisco IOS / IOS-XE / NX-OS"],
    ["cisco", null, "Cisco IOS / IOS-XE / NX-OS"],
    [null, "IOS-XE 17.9", "Cisco IOS / IOS-XE / NX-OS"],
    [null, "NX-OS 10.2", "Cisco IOS / IOS-XE / NX-OS"],
    ["Juniper Networks", null, "Juniper Junos"],
    [null, "JUNOS 22.4R1", "Juniper Junos"],
    ["MikroTik", null, "Mikrotik RouterOS"],
    [null, "RouterOS 7.14", "Mikrotik RouterOS"],
    ["Aruba Networks", null, "HP / Aruba ProCurve"],
    ["Hewlett Packard Enterprise", null, "HP / Aruba ProCurve"],
    ["HPE", null, "HP / Aruba ProCurve"],
    ["HP", "ProCurve J9727A", "HP / Aruba ProCurve"],
    ["Dell", null, "Dell PowerConnect / Networking"],
    [null, "PowerConnect 6248", "Dell PowerConnect / Networking"],
    ["Force10", null, "Dell PowerConnect / Networking"],
    ["Fortinet", "FortiOS 7.4.3", "Fortinet FortiOS (SNMP path)"],
    ["Fortinet", null, "Fortinet FortiOS (SNMP path)"],
  ] as const)("%s / %s → %s", (mfr, os, vendor) => {
    expect(vendorOf(mfr, os)).toBe(vendor);
  });

  it("the HP pattern is anchored: 'hp' only matches at the very start of the haystack", () => {
    expect(vendorOf("HP", null)).toBe("HP / Aruba ProCurve");
    expect(vendorOf("Ship Co", null)).toBeNull();
    expect(vendorOf("Acme", "HP switch")).toBeNull(); // "hp" not at the start
    // A haystack that STARTS with an OS (manufacturer empty) is trimmed, so the anchor still sees it.
    expect(vendorOf(null, "hp-ux")).toBe("HP / Aruba ProCurve");
  });

  it("'Dell' needs a word boundary — it is not found inside another word", () => {
    expect(vendorOf("Modelling Inc", null)).toBeNull();
    expect(vendorOf("Dell Inc.", null)).toBe("Dell PowerConnect / Networking");
  });

  it("FortiSwitch wins over generic FortiOS — matched on the model literal", () => {
    expect(vendorOf("Fortinet", null, "FortiSwitch 148F")).toBe("Fortinet FortiSwitch (SNMP path)");
    expect(vendorOf("Fortinet", null, "FortiSwitchRugged-112D-POE")).toBe("Fortinet FortiSwitch (SNMP path)");
  });

  it("FortiAP wins over generic FortiOS — matched on the model literal", () => {
    expect(vendorOf("Fortinet", null, "FortiAP-231F")).toBe("Fortinet FortiAP (SNMP path)");
  });

  it("a modelless Fortinet switch / AP reaches its class through assetType", () => {
    expect(vendorOf("Fortinet", null, null, "switch")).toBe("Fortinet FortiSwitch (SNMP path)");
    expect(vendorOf("Fortinet", null, "", "access_point")).toBe("Fortinet FortiAP (SNMP path)");
    expect(vendorOf("Fortinet", null, null, "firewall")).toBe("Fortinet FortiOS (SNMP path)");
  });

  it("a stated model outranks the type hint", () => {
    expect(vendorOf("Fortinet", null, "FortiAP-231F", "switch")).toBe("Fortinet FortiAP (SNMP path)");
  });

  it("a model alone is enough to match", () => {
    expect(vendorOf(null, null, "FortiSwitch 424E")).toBe("Fortinet FortiSwitch (SNMP path)");
  });

  it("first match wins in array order: Cisco is checked before the Fortinet entries", () => {
    // A contrived haystack carrying both vendors' words resolves to the earlier entry.
    expect(vendorOf("Fortinet", "cisco-compatible")).toBe("Cisco IOS / IOS-XE / NX-OS");
  });

  it("returns the registry's own object, not a copy", () => {
    expect(pickVendorProfile("Juniper", null)).toBe(byVendor("Juniper"));
  });
});

describe("fortinetClassHint — the cases its own suite leaves out", () => {
  it("recognizes 'FortiGate' and 'FortiOS' as Fortinet manufacturers too", () => {
    expect(fortinetClassHint("FortiGate", null, "switch")).toBe("FortiSwitch");
    expect(fortinetClassHint("fortios", "", "access_point")).toBe("FortiAP");
  });

  it("a model naming either class suppresses the hint, case-insensitively", () => {
    expect(fortinetClassHint("Fortinet", "fortiswitch", "access_point")).toBeNull();
    expect(fortinetClassHint("Fortinet", "FORTIAP-221E", "switch")).toBeNull();
  });

  it("null manufacturer yields nothing", () => {
    expect(fortinetClassHint(null, null, "switch")).toBeNull();
  });
});

// ─── Registry shape ─────────────────────────────────────────────────────────

describe("VENDOR_TELEMETRY_PROFILES — registry invariants", () => {
  const symbolsOf = (p: (typeof VENDOR_TELEMETRY_PROFILES)[number]): string[] => [
    p.cpu?.symbol, p.memory?.usedBytesSymbol, p.memory?.freeBytesSymbol, p.memory?.totalBytesSymbol, p.memory?.pctSymbol,
    p.disk?.usedBytesSymbol, p.disk?.totalBytesSymbol, p.disk?.freeBytesSymbol, p.temperature?.symbol,
    p.temperature?.columns?.nameSymbol, p.temperature?.columns?.alarmSymbol, p.model?.symbol, p.serial?.symbol,
  ].filter((s): s is string => typeof s === "string");

  it("every symbol is a MIB NAME, never a numeric OID — the vendor-SNMP boundary", () => {
    for (const p of VENDOR_TELEMETRY_PROFILES) {
      for (const s of symbolsOf(p)) expect(s, `${p.vendor}: ${s}`).toMatch(/^[a-zA-Z][A-Za-z0-9]*$/);
    }
  });

  it("vendor labels are unique and every entry's match regex is case-insensitive", () => {
    const labels = VENDOR_TELEMETRY_PROFILES.map((p) => p.vendor);
    expect(new Set(labels).size).toBe(labels.length);
    for (const p of VENDOR_TELEMETRY_PROFILES) expect((p.match as RegExp).flags).toContain("i");
  });

  it("FortiSwitch and FortiAP are ordered ahead of the generic Fortinet entry", () => {
    const idx = (n: string) => VENDOR_TELEMETRY_PROFILES.findIndex((p) => p.vendor.includes(n));
    expect(idx("FortiSwitch")).toBeLessThan(idx("FortiOS"));
    expect(idx("FortiAP")).toBeLessThan(idx("FortiOS"));
  });

  it("no hardcoded entry carries profileManufacturer — that is set by pickDbProfile", () => {
    for (const p of VENDOR_TELEMETRY_PROFILES) expect(p.profileManufacturer).toBeUndefined();
  });

  it("MikroTik claims nothing: RouterOS already reports through HOST-RESOURCES-MIB", () => {
    const p = byVendor("Mikrotik");
    expect(p.cpu).toBeUndefined();
    expect(p.memory).toBeUndefined();
    expect(p.disk).toBeUndefined();
    expect(p.temperature).toBeUndefined();
  });

  it("table-walked CPUs are averaged (walk-avg); single-value CPUs are scalars", () => {
    expect(byVendor("Cisco").cpu).toEqual({ symbol: "cpmCPUTotal5secRev", mode: "walk-avg" });
    expect(byVendor("Juniper").cpu).toEqual({ symbol: "jnxOperatingCPU", mode: "walk-avg" });
    expect(byVendor("FortiSwitch").cpu?.mode).toBe("scalar");
    expect(byVendor("FortiAP").cpu?.mode).toBe("scalar");
    expect(byVendor("FortiOS").cpu?.mode).toBe("scalar");
  });

  it("FortiSwitch memory is BYTES (used/total); FortiAP and FortiGate memory is a percent", () => {
    expect(byVendor("FortiSwitch").memory).toEqual({ usedBytesSymbol: "fsSysMemUsage", totalBytesSymbol: "fsSysMemCapacity" });
    expect(byVendor("FortiAP").memory).toEqual({ pctSymbol: "fapMemoryUsage" });
    expect(byVendor("FortiOS").memory).toEqual({ pctSymbol: "fgSysMemUsage" });
  });

  it("the FortiGate sensor row is a table naming its sibling columns (rule 132)", () => {
    const t = byVendor("FortiOS").temperature;
    expect(t).toMatchObject({ symbol: "fgHwSensorEntValue", mode: "table" });
    expect(t?.columns).toBe(FORTIGATE_SENSOR_COLUMNS);
    expect(FORTIGATE_SENSOR_COLUMNS).toMatchObject({
      nameSymbol: "fgHwSensorEntName",
      alarmSymbol: "fgHwSensorEntAlarmStatus",
      sensorClass: null,
      transform: null,
    });
    // FortiOS's alarm bit: any nonzero value is the problem state.
    expect(FORTIGATE_SENSOR_COLUMNS.alarmMap).toMatchObject({ mode: "nonzero", values: [], trueIsProblem: true });
  });

  it("the FortiAP temperature is a single scalar labelled System", () => {
    expect(byVendor("FortiAP").temperature).toEqual({ symbol: "fapTemperature", mode: "scalar", sensorName: "System" });
  });

  it("the FortiSwitch disk is the flash, used/total", () => {
    expect(byVendor("FortiSwitch").disk).toEqual({ usedBytesSymbol: "fsSysDiskUsage", totalBytesSymbol: "fsSysDiskCapacity", mountPath: "flash" });
  });
});

describe("FortiSwitch model identity (fsSysVersion)", () => {
  const model = byVendor("FortiSwitch").model!;

  it("strips the firmware suffix and prefixes FortiSwitch", () => {
    expect(model.symbol).toBe("fsSysVersion");
    expect(model.parse("S548DF-v7.2.5-build0453,230511 (GA)")).toBe("FortiSwitch S548DF");
  });

  it("keeps a hyphenated model token whole up to the first version marker", () => {
    const out = model.parse("FortiSwitchRugged-112D-POE v7.4.8-build0123");
    expect(out).toContain("112D-POE");
    expect(out).not.toMatch(/v7/);
  });

  it("answers null for a string with no firmware marker (nothing stamped)", () => {
    expect(model.parse("garbage")).toBeNull();
  });

  it("the row-shaped parse is the same rule as the function", () => {
    expect(model.rowParse.template).toBe("FortiSwitch $1");
    const re = new RegExp(model.rowParse.pattern);
    const m = re.exec("S424E-v7.0.1-build0100");
    expect(m?.[1]).toBe("S424E");
  });

  it("only the FortiSwitch entry carries a model query", () => {
    expect(VENDOR_TELEMETRY_PROFILES.filter((p) => p.model).map((p) => p.vendor)).toEqual(["Fortinet FortiSwitch (SNMP path)"]);
  });

  it("a parsed model keeps the profile matching — the 'FortiSwitch ' prefix is load-bearing", () => {
    const parsed = model.parse("S548DF-v7.2.5-build0453,230511 (GA)");
    expect(vendorOf("Fortinet", null, parsed)).toBe("Fortinet FortiSwitch (SNMP path)");
  });
});

// ─── memoryQueryToDoubleScalar ──────────────────────────────────────────────

describe("memoryQueryToDoubleScalar", () => {
  it("null for an absent or empty memory block", () => {
    expect(memoryQueryToDoubleScalar(undefined)).toBeNull();
    expect(memoryQueryToDoubleScalar({})).toBeNull();
    expect(memoryQueryToDoubleScalar({ walkSubtree: true })).toBeNull();
  });

  it("used + total → double_scalar a_over_b_as_percent", () => {
    expect(memoryQueryToDoubleScalar({ usedBytesSymbol: "u", totalBytesSymbol: "t" }))
      .toEqual({ type: "double_scalar", symbol: "u", symbolB: "t", transform: "a_over_b_as_percent" });
  });

  it("used + free → double_scalar a_over_a_plus_b_as_percent", () => {
    expect(memoryQueryToDoubleScalar({ usedBytesSymbol: "u", freeBytesSymbol: "f" }))
      .toEqual({ type: "double_scalar", symbol: "u", symbolB: "f", transform: "a_over_a_plus_b_as_percent" });
  });

  it("used + total wins when all three byte symbols are present", () => {
    expect(memoryQueryToDoubleScalar({ usedBytesSymbol: "u", freeBytesSymbol: "f", totalBytesSymbol: "t" })?.symbolB).toBe("t");
  });

  it("a percent alone → scalar with no second symbol and no transform", () => {
    expect(memoryQueryToDoubleScalar({ pctSymbol: "p" })).toEqual({ type: "scalar", symbol: "p", symbolB: null, transform: null });
  });

  it("bytes win over a percent when both are present", () => {
    expect(memoryQueryToDoubleScalar({ usedBytesSymbol: "u", totalBytesSymbol: "t", pctSymbol: "p" })?.type).toBe("double_scalar");
  });

  it("a lone used (or free, or total) symbol cannot be mapped", () => {
    expect(memoryQueryToDoubleScalar({ usedBytesSymbol: "u" })).toBeNull();
    expect(memoryQueryToDoubleScalar({ freeBytesSymbol: "f", totalBytesSymbol: "t" })).toBeNull();
  });

  it("maps every hardcoded memory block", () => {
    expect(memoryQueryToDoubleScalar(byVendor("Cisco").memory)).toEqual({
      type: "double_scalar", symbol: "ciscoMemoryPoolUsed", symbolB: "ciscoMemoryPoolFree", transform: "a_over_a_plus_b_as_percent",
    });
    expect(memoryQueryToDoubleScalar(byVendor("Juniper").memory)).toEqual({ type: "scalar", symbol: "jnxOperatingBuffer", symbolB: null, transform: null });
    expect(memoryQueryToDoubleScalar(byVendor("FortiSwitch").memory)?.transform).toBe("a_over_b_as_percent");
    for (const p of VENDOR_TELEMETRY_PROFILES.filter((x) => x.memory)) {
      expect(memoryQueryToDoubleScalar(p.memory), p.vendor).not.toBeNull();
    }
  });
});

// ─── Disk translators as a round trip ───────────────────────────────────────

describe("disk translators — round trip", () => {
  const blocks: DiskQuery[] = [
    { usedBytesSymbol: "u", totalBytesSymbol: "t" },
    { usedBytesSymbol: "u", freeBytesSymbol: "f" },
    { totalBytesSymbol: "t", freeBytesSymbol: "f" },
  ];

  it.each(blocks)("seeding then reading back %o returns the same roles", (block) => {
    const row = diskQueryToDoubleScalar(block)!;
    expect(row.type).toBe("double_scalar");
    expect(diskQueryFromMetricPick(row)).toEqual(block);
  });

  it("the mountPath rides through the read side only — the row has no such field", () => {
    const row = diskQueryToDoubleScalar({ usedBytesSymbol: "u", totalBytesSymbol: "t", mountPath: "flash" })!;
    expect(row).not.toHaveProperty("mountPath");
    expect(diskQueryFromMetricPick(row, "flash")).toEqual({ usedBytesSymbol: "u", totalBytesSymbol: "t", mountPath: "flash" });
    expect(diskQueryFromMetricPick(row, "")).not.toHaveProperty("mountPath");
  });

  it("used + total wins when a block names all three", () => {
    expect(diskQueryToDoubleScalar({ usedBytesSymbol: "u", totalBytesSymbol: "t", freeBytesSymbol: "f" })?.symbolB).toBe("t");
  });

  it("nothing to seed from an absent block", () => {
    expect(diskQueryToDoubleScalar(undefined)).toBeNull();
    expect(diskQueryToDoubleScalar({ mountPath: "x" })).toBeNull();
  });
});

describe("deriveDiskBytes — readings the collector hands back", () => {
  it("free larger than total (a transient resize) yields no used, but keeps the stated total", () => {
    expect(deriveDiskBytes({ total: 100, free: 150 })).toEqual({ usedBytes: null, totalBytes: 100 });
  });

  it("all three stated: used and total are believed as stated, free is ignored", () => {
    expect(deriveDiskBytes({ used: 10, total: 100, free: 1 })).toEqual({ usedBytes: 10, totalBytes: 100 });
  });

  it("a single reading cannot complete the pair", () => {
    expect(deriveDiskBytes({ free: 5 })).toEqual({ usedBytes: null, totalBytes: null });
    expect(deriveDiskBytes({ used: 5 })).toEqual({ usedBytes: 5, totalBytes: null });
  });

  it("a negative stated total is refused rather than charted", () => {
    expect(deriveDiskBytes({ used: 5, total: -1 })).toEqual({ usedBytes: 5, totalBytes: null });
  });
});
