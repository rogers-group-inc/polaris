/**
 * src/services/vendorTelemetryProfiles.ts — Per-vendor SNMP telemetry shapes.
 *
 * Standard HOST-RESOURCES-MIB (used by `collectTelemetrySnmp`) returns null
 * CPU/memory on most network gear — those vendors expose telemetry only via
 * their proprietary MIBs. This file maps an asset's `manufacturer` (and `os`,
 * for cases where the manufacturer field is empty) to the symbolic OID names
 * that actually carry CPU% and memory bytes for that vendor. The names are
 * resolved by `oidRegistry` against whichever MIBs the operator has uploaded
 * — when a profile matches but the underlying MIB hasn't been uploaded yet,
 * the probe falls back to HOST-RESOURCES-MIB rather than failing.
 *
 * To probe a new vendor, an operator uploads the relevant MIB(s) to Server
 * Settings → Identification → MIB Database. No code change needed unless the
 * symbolic names below are wrong for that vendor — in which case extend this
 * file.
 *
 * Entries are matched in array order; first match wins.
 */

import { fortiswitchModelFromFsSysVersion, FORTISWITCH_MODEL_PARSE } from "../utils/fortiswitchModel.js";
import type { ModelParse } from "../utils/modelParse.js";

export interface CpuQuery {
  symbol: string;                       // symbolic OID name (resolved via oidRegistry)
  mode: "scalar" | "walk-avg";          // scalar = .0, walk-avg = walk subtree + average
}

export interface MemoryQuery {
  // CPU/memory profiles can supply EITHER bytes (used + free or used + total)
  // OR a single percentage. The probe coerces whichever form arrives back to
  // the AssetTelemetrySample {cpuPct, memPct, memUsedBytes, memTotalBytes}
  // shape, with bytes winning when both are present.
  usedBytesSymbol?: string;
  freeBytesSymbol?: string;             // used + free → total at probe time
  totalBytesSymbol?: string;
  pctSymbol?: string;
  walkSubtree?: boolean;                // walk + sum (Cisco memory pools have multiple rows)
}

/**
 * Vendor disk shape. Used when a device exposes disk used/total as proprietary
 * scalars rather than the standard HOST-RESOURCES-MIB hrStorageTable that
 * `collectSystemInfoSnmp` walks first. The collector falls back to the
 * profile's `disk` query when the HRM walk returns zero disk rows. Single
 * mountpoint per profile — vendors that expose multiple disks via a vendor
 * subtree (Cisco's `ciscoFlashTable`, Juniper's `jnxFilePartitionTable`, etc.)
 * need a different shape and aren't covered here yet.
 */
export interface DiskQuery {
  // Any TWO of the three complete the third. used+total is what every
  // hardcoded profile below states; the other two pairs exist because the
  // editable Manufacturer Profile's storage row may name a FREE-bytes OID
  // instead (see diskQueryFromMetricPick). `deriveDiskBytes` does that
  // arithmetic — a StorageSample carries BYTES, so the pair is COMPLETED
  // rather than reduced to the percent the profile row's combiner describes.
  usedBytesSymbol?:  string;
  totalBytesSymbol?: string;
  freeBytesSymbol?:  string;
  /** Display label for the synthesized StorageSample row. Defaults to "system" when omitted. */
  mountPath?: string;
}

/**
 * Vendor temperature shape. Used when a device exposes a single scalar Celsius
 * reading rather than the standard ENTITY-SENSOR-MIB (`entPhySensorType`=8)
 * walk that `collectTemperaturesSnmp` performs first. The collector falls back
 * to the profile's `temperature` query when both the ENTITY-SENSOR walk and
 * the named-fallback heuristic (Fortinet `fgHwSensorTable`) return zero rows
 * — typical on FortiAPs which publish only `fapTemperature` and don't
 * implement either of the table-based paths.
 */
export interface TemperatureQuery {
  symbol: string;                       // symbolic OID name resolved via oidRegistry
  // "scalar" = single .0 Celsius reading (FortiAP fapTemperature).
  // "table"  = operator pointed the Hardware Sensors metric at a sensor table
  //            (e.g. fgHwSensorTable); the SNMP collector runs the full
  //            hardware-table walk instead of a (broken) scalar GET.
  mode: "scalar" | "table";
  /** Display label for the synthesized hardware-sensor row. Defaults to "System" when omitted. */
  sensorName?: string;
}

/**
 * Vendor model-identity shape. Used when the device's real hardware model is
 * only reachable via a vendor SNMP scalar (FortiSwitch fsSysVersion — the
 * FMG/FortiGate managed-switch CMDB has no model field, so discovery stamps
 * the generic literal "FortiSwitch"). Consumed by `collectSystemInfoSnmp` on
 * the heavy pass: one scalar GET, run through `parse` to strip whatever
 * non-model payload the raw string carries (firmware suffix etc.), surfaced
 * as `SystemInfoSample.detectedModel` and adopted onto `Asset.model` by
 * `recordSystemInfoResult` when the stored model is still generic.
 */
export interface ModelQuery {
  symbol: string;                       // symbolic OID name resolved via oidRegistry
  /** Extract the display model from the raw scalar; null = unrecognized (nothing stamped). */
  parse: (raw: string) => string | null;
  /**
   * The ROW-SHAPED form of `parse` — the same rule as a regex + `$1` template
   * (`utils/modelParse.ts`). `parse` is a function and a function cannot be
   * seeded, so without this the `model` metric row would be created empty on a
   * fresh install and the vendor's identity query would exist only in code.
   * Keep the two in step: `parse` should be `applyModelParse(raw, rowParse)`.
   */
  rowParse: ModelParse;
}

export interface VendorTelemetryProfile {
  vendor: string;                       // human-readable label, used in logs
  match: RegExp;                        // case-insensitive regex tested against `${manufacturer} ${os}`
  cpu?: CpuQuery;
  memory?: MemoryQuery;
  /**
   * Vendor disk scalars. Consumed by `collectSystemInfoSnmp` as a fallback
   * when HOST-RESOURCES-MIB `hrStorageTable` returns no disk rows — typical
   * on devices whose SNMP agents don't implement HRM's storage view
   * (FortiSwitches, some Cisco access points, etc.).
   */
  disk?: DiskQuery;
  /**
   * Vendor temperature scalar. Consumed by `collectTemperaturesSnmp` as a
   * fallback when neither ENTITY-SENSOR-MIB nor the Fortinet sensor-name
   * heuristic produced any rows — typical on FortiAPs.
   */
  temperature?: TemperatureQuery;
  /**
   * Vendor model-identity scalar. Consumed by `collectSystemInfoSnmp`; see
   * ModelQuery. Not part of the editable ManufacturerProfile surface — the
   * hardcoded profile is its only source.
   */
  model?: ModelQuery;
}

/**
 * Built-in profile registry. Patterns intentionally err on the wide side so
 * that variations like "Cisco Systems", "Cisco IOS-XE", "cisco" all match the
 * same profile. The `match` regex is tested against the concatenation of
 * `manufacturer` + " " + `os`, so OS-only matches (e.g. an asset with no
 * manufacturer set but `os = "Cisco IOS"`) still hit.
 */
export const VENDOR_TELEMETRY_PROFILES: VendorTelemetryProfile[] = [
  {
    vendor: "Cisco IOS / IOS-XE / NX-OS",
    match: /cisco|ios-?xe|nx-?os/i,
    // CISCO-PROCESS-MIB::cpmCPUTotal5secRev — table walk; one row per CPU,
    // averaged at probe time. The `Rev` variant is on every IOS/IOS-XE since
    // 12.x; older boxes that only expose the non-Rev form will fall back.
    // Seeded into oidRegistry so the probe works without uploading
    // CISCO-PROCESS-MIB.
    cpu: { symbol: "cpmCPUTotal5secRev", mode: "walk-avg" },
    // CISCO-MEMORY-POOL-MIB::ciscoMemoryPoolUsed / Free — multiple pools
    // (processor, I/O, fast, …); summed at probe time. Seeded into
    // oidRegistry so the probe works without uploading CISCO-MEMORY-POOL-MIB.
    memory: {
      usedBytesSymbol: "ciscoMemoryPoolUsed",
      freeBytesSymbol: "ciscoMemoryPoolFree",
      walkSubtree: true,
    },
  },
  {
    vendor: "Juniper Junos",
    match: /juniper|junos/i,
    // JUNIPER-MIB::jnxOperatingCPU — table indexed by physical entity; we
    // average the CPU rows (REs + linecards). Could refine to RE-only later.
    // Seeded into oidRegistry so the probe works without uploading JUNIPER-MIB.
    cpu: { symbol: "jnxOperatingCPU", mode: "walk-avg" },
    // JUNIPER-MIB::jnxOperatingBuffer — 1-100 percent, no byte equivalent
    // exposed via SNMP. Same seed as the CPU symbol.
    memory: { pctSymbol: "jnxOperatingBuffer", walkSubtree: true },
  },
  {
    vendor: "Mikrotik RouterOS",
    match: /mikrotik|routeros/i,
    // MIKROTIK-MIB::mtxrSystemUserCPULoad — scalar percent
    cpu: { symbol: "mtxrSystemUserCPULoad", mode: "scalar" },
    // Mikrotik exposes RAM bytes via HOST-RESOURCES-MIB only, so leave the
    // memory profile empty and let the HRM fallback handle it.
  },
  {
    // FortiSwitch sits BEFORE the generic Fortinet entry so FortiSwitches
    // (manufacturer "Fortinet", model "FortiSwitch") don't fall into the
    // FortiGate profile — its OIDs are under the FortiGate root (12356.101)
    // which FortiSwitches don't expose. Matched on the model literal stamped
    // by FMG/FortiGate discovery; haystack is `${manufacturer} ${os} ${model}`.
    vendor: "Fortinet FortiSwitch (SNMP path)",
    match: /fortiswitch/i,
    // FORTINET-FORTISWITCH-MIB shape:
    //   fsSysCpuUsage    @ 12356.106.4.1.2 → scalar percent (0..100)
    //   fsSysMemUsage    @ 12356.106.4.1.3 → bytes USED  (not a percent — distinct
    //                                                     from FortiGate's fgSysMemUsage)
    //   fsSysMemCapacity @ 12356.106.4.1.4 → bytes TOTAL
    // collectMemoryVendor derives memPct from used/total. All three symbols
    // are seeded into oidRegistry so the probe works without uploading
    // FORTINET-FORTISWITCH-MIB.
    cpu: { symbol: "fsSysCpuUsage", mode: "scalar" },
    memory: {
      usedBytesSymbol:  "fsSysMemUsage",
      totalBytesSymbol: "fsSysMemCapacity",
    },
    // FORTINET-FORTISWITCH-MIB exposes flash storage as scalars under the
    // same fsSystem subtree. FortiSwitches don't implement HRM's
    // hrStorageTable, so the standard HRM path in collectSystemInfoSnmp
    // returns nothing — the disk-fallback kicks in and emits one
    // StorageSample row for the system flash.
    //   fsSysDiskUsage    @ 12356.106.4.1.5 → bytes USED
    //   fsSysDiskCapacity @ 12356.106.4.1.6 → bytes TOTAL
    disk: {
      usedBytesSymbol:  "fsSysDiskUsage",
      totalBytesSymbol: "fsSysDiskCapacity",
      mountPath:        "flash",
    },
    // fsSysVersion @ 12356.106.4.1.1 carries the real hardware model, but as
    // a combined string with the firmware version appended after the model
    // token ("S548DF-v7.2.5-build0453,230511 (GA)"). The parse strips the
    // firmware suffix and prefixes "FortiSwitch " — that prefix keeps this
    // very profile matching (`match` is tested against a haystack that
    // includes the model, and FortiSwitch assets have no `os` to match on).
    // Discovery can't supply the model: the managed-switch CMDB has no model
    // field, so the asset sits at the generic "FortiSwitch" until this reads.
    model: { symbol: "fsSysVersion", parse: fortiswitchModelFromFsSysVersion, rowParse: FORTISWITCH_MODEL_PARSE },
  },
  {
    // FortiAP sits BEFORE the generic Fortinet entry so FortiAPs (manufacturer
    // "Fortinet", model "FortiAP-*") don't fall into the FortiGate profile —
    // its OIDs live under the FortiGate root (12356.101) which FortiAPs don't
    // expose. Matched on the model literal stamped by FMG/FortiGate discovery;
    // haystack is `${manufacturer} ${os} ${model}`.
    vendor: "Fortinet FortiAP (SNMP path)",
    match: /fortiap/i,
    // FORTINET-FORTIAP-MIB shape (single-scalar form throughout, like
    // FortiGate but distinct OID root @ 12356.120):
    //   fapCpuUsage    @ 12356.120.3.41 → scalar percent (0..100)
    //   fapMemoryUsage @ 12356.120.3.42 → scalar percent (0..100, NOT bytes —
    //                                                    unlike FortiSwitch's
    //                                                    fsSysMemUsage which is bytes)
    //   fapTemperature @ 12356.120.3.44 → scalar Celsius (single sensor)
    // All three symbols are seeded into oidRegistry so the probe works without
    // uploading FORTINET-FORTIAP-MIB. The temperature scalar is consumed by
    // collectTemperaturesSnmp as a third fallback after ENTITY-SENSOR-MIB +
    // the Fortinet sensor-name heuristic both return zero rows (FortiAPs
    // implement neither).
    cpu: { symbol: "fapCpuUsage", mode: "scalar" },
    memory: { pctSymbol: "fapMemoryUsage" },
    temperature: { symbol: "fapTemperature", mode: "scalar", sensorName: "System" },
  },
  {
    vendor: "Fortinet FortiOS (SNMP path)",
    match: /fortinet|fortigate|fortios/i,
    // FORTINET-FORTIGATE-MIB::fgSysCpuUsage / fgSysMemUsage — both scalars,
    // both 0-100 percent. Used for FortiGates monitored as plain SNMP rather
    // than via the FortiOS REST monitorType path.
    cpu: { symbol: "fgSysCpuUsage", mode: "scalar" },
    memory: { pctSymbol: "fgSysMemUsage" },
    // The hardware-sensor table. This block did not exist until 2026-09: the
    // walk was dispatched by `/fortinet/i.test(manufacturer)` inside
    // `collectHardwareSensorsSnmp` instead, so the fact lived in the collector
    // and the seeded `temperature` row came out EMPTY. The Phase 4 migration
    // fills that row on an existing install; this block is what gives a FRESH
    // one the same thing.
    temperature: { symbol: "fgHwSensorTable", mode: "table" },
  },
  {
    vendor: "HP / Aruba ProCurve",
    match: /aruba|hpe|hewlett|procurve|^hp\b/i,
    // STATISTICS-MIB::hpSwitchCpuStat — scalar percent. Seeded into
    // oidRegistry so the probe works without uploading STATISTICS-MIB.
    cpu: { symbol: "hpSwitchCpuStat", mode: "scalar" },
  },
  {
    vendor: "Dell PowerConnect / Networking",
    match: /\bdell\b|powerconnect|force10/i,
    // RADLAN-rndMng::rlCpuUtilDuringLastMinute — scalar percent. The RADLAN
    // platform underlies Dell PowerConnect / Force10 switches and lives under
    // enterprise 89, not Dell's own (674). Seeded into oidRegistry so the
    // probe works without uploading the RADLAN MIB.
    cpu: { symbol: "rlCpuUtilDuringLastMinute", mode: "scalar" },
  },
];

/**
 * Pick the first profile whose `match` regex hits the given identity tuple.
 * Returns null when no profile matches — caller falls through to
 * HOST-RESOURCES-MIB.
 */
/**
 * The Fortinet device CLASS, derived from what the asset actually is rather
 * than from what its model string happens to say.
 *
 * Profile matching is a regex over `manufacturer + os + model`, so a
 * FortiSwitch is recognized only when the word survives in one of those. A
 * managed switch has no `os`, and `MODEL_RULES` in utils/assetProjection.ts
 * deliberately skips the fortiswitch source's model (the observed blob says
 * the useless literal "FortiSwitch") on the assumption that the asset row
 * already carries that literal from the legacy create path. An asset where it
 * doesn't — `Asset.model` empty, manufacturer "Fortinet" — matches nothing but
 * the generic FortiOS entry and gets pointed at `fgSysCpuUsage` /
 * `fgSysMemUsage` under the FortiGate root 12356.101, which a FortiSwitch does
 * not publish. That was a DEADLOCK, not just a miss: the FortiOS profile
 * carries no `model` query, so `fsSysVersion` is never read, so
 * `adoptDetectedModel` never gets a value, so the model stays empty forever —
 * and every reading charted a confident 0% (prod 2026-08-31, FSR-112D-POE;
 * the flat zero came from `snmpVbToNumber`, see its note).
 *
 * `assetType` is the signal that was reliable the whole time: Fortinet makes no
 * switch that isn't a FortiSwitch and no AP that isn't a FortiAP. Deliberately
 * yields nothing when the model ALREADY names a class — a model is operator- or
 * device-stated and outranks an inference from a type that may be misclassified,
 * and blindly appending would let a "FortiAP-231F" typed on a switch-typed row
 * match the FortiSwitch profile first (it is ordered ahead).
 *
 * `firewall` needs no hint — a FortiGate matches the FortiOS entry on the
 * manufacturer alone, which is exactly the fallback that swallowed the others.
 */
export function fortinetClassHint(
  manufacturer: string | null | undefined,
  model: string | null | undefined,
  assetType?: string | null | undefined,
): string | null {
  if (!/fortinet|fortigate|fortios/i.test(manufacturer ?? "")) return null;
  if (/fortiswitch|fortiap/i.test(model ?? "")) return null;
  if (assetType === "switch")       return "FortiSwitch";
  if (assetType === "access_point") return "FortiAP";
  return null;
}

export function pickVendorProfile(
  manufacturer: string | null | undefined,
  os: string | null | undefined,
  model?: string | null | undefined,
  assetType?: string | null | undefined,
): VendorTelemetryProfile | null {
  const hint = fortinetClassHint(manufacturer, model, assetType);
  const haystack = `${manufacturer ?? ""} ${os ?? ""} ${model ?? ""} ${hint ?? ""}`.trim();
  if (!haystack) return null;
  for (const p of VENDOR_TELEMETRY_PROFILES) {
    if (p.match.test(haystack)) return p;
  }
  return null;
}

/**
 * Translate a hardcoded `MemoryQuery` into the editable Manufacturer Profile's
 * double-scalar shape (`{ type, symbol, symbolB, transform }`). Used by the
 * seed job to stamp memory rows onto fresh installs AND by the backfill job
 * to retrofit existing installs that ran the seed before this shape existed.
 * Returns null when the vendor's memory shape doesn't map cleanly (e.g.
 * empty `memory` block).
 *
 * Mapping rules:
 *   - usedBytes + totalBytes  → double_scalar, symbol=used,  symbolB=total, transform=a_over_b_as_percent
 *   - usedBytes + freeBytes   → double_scalar, symbol=used,  symbolB=free,  transform=a_over_a_plus_b_as_percent
 *   - pctSymbol               → scalar,        symbol=pct,   symbolB=null,  transform=null
 */
export function memoryQueryToDoubleScalar(mem: MemoryQuery | undefined): {
  type:      "scalar" | "double_scalar";
  symbol:    string;
  symbolB:   string | null;
  transform: string | null;
} | null {
  if (!mem) return null;
  if (mem.usedBytesSymbol && mem.totalBytesSymbol) {
    return {
      type:      "double_scalar",
      symbol:    mem.usedBytesSymbol,
      symbolB:   mem.totalBytesSymbol,
      transform: "a_over_b_as_percent",
    };
  }
  if (mem.usedBytesSymbol && mem.freeBytesSymbol) {
    return {
      type:      "double_scalar",
      symbol:    mem.usedBytesSymbol,
      symbolB:   mem.freeBytesSymbol,
      transform: "a_over_a_plus_b_as_percent",
    };
  }
  if (mem.pctSymbol) {
    return { type: "scalar", symbol: mem.pctSymbol, symbolB: null, transform: null };
  }
  return null;
}

/**
 * Translate an editable Manufacturer Profile **storage** row into a
 * `DiskQuery`. The runtime counterpart of `memoryQueryToDoubleScalar`, which
 * goes the other way for the seed job.
 *
 * The row's combiner is NOT arithmetic here. A `StorageSample` carries the
 * used/total byte pair and every reader derives its own percent, so the
 * combiner is read as a statement of WHAT THE TWO SYMBOLS MEAN:
 *
 *   a_over_b_as_percent / a_over_b_ratio  → A = used,  B = total
 *   a_over_a_plus_b_as_percent / a_plus_b → A = used,  B = free
 *   b_minus_a_over_b_as_percent           → A = free,  B = total
 *   a_minus_b                             → A = total, B = free
 *
 * Returns null — leaving the hardcoded profile in place — for a row that
 * cannot produce a byte pair: a `scalar` row (a lone percentage is not a
 * StorageSample; there is no total to render or to alert a threshold
 * against), a `table` row (HOST-RESOURCES-MIB is already the table path and
 * runs first), a row missing either symbol, or a combiner with no role
 * mapping. Null is the honest answer in each case, and it is why an operator
 * who half-fills the row keeps the behavior they had rather than losing
 * storage collection to a partial edit.
 */
export function diskQueryFromMetricPick(pick: {
  type:      "scalar" | "double_scalar" | "table";
  symbol:    string | null;
  symbolB:   string | null;
  transform: string | null;
}, mountPath?: string): DiskQuery | null {
  if (pick.type !== "double_scalar") return null;
  const a = pick.symbol;
  const b = pick.symbolB;
  if (!a || !b) return null;
  const base = mountPath ? { mountPath } : {};
  switch (pick.transform) {
    case "a_over_b_as_percent":
    case "a_over_b_ratio":
      return { ...base, usedBytesSymbol: a, totalBytesSymbol: b };
    case "a_over_a_plus_b_as_percent":
    case "a_plus_b":
      return { ...base, usedBytesSymbol: a, freeBytesSymbol: b };
    case "b_minus_a_over_b_as_percent":
      return { ...base, freeBytesSymbol: a, totalBytesSymbol: b };
    case "a_minus_b":
      return { ...base, totalBytesSymbol: a, freeBytesSymbol: b };
    default:
      return null;
  }
}

/**
 * Complete the used/total byte pair from whichever two of the three readings
 * a `DiskQuery` collected. Both outputs are derived from the RAW inputs — never
 * from each other — so a null in one place can't propagate into a fabricated
 * value in the other. A negative used (free reported larger than total, which
 * some agents do transiently across a resize) clamps to null rather than
 * charting a below-zero bar.
 */
export function deriveDiskBytes(readings: {
  used?:  number | null;
  total?: number | null;
  free?:  number | null;
}): { usedBytes: number | null; totalBytes: number | null } {
  const used  = readings.used  ?? null;
  const total = readings.total ?? null;
  const free  = readings.free  ?? null;
  let usedBytes  = used;
  let totalBytes = total;
  if (usedBytes  == null && total != null && free != null) usedBytes  = total - free;
  if (totalBytes == null && used  != null && free != null) totalBytes = used  + free;
  if (usedBytes  != null && (!Number.isFinite(usedBytes)  || usedBytes  < 0)) usedBytes  = null;
  if (totalBytes != null && (!Number.isFinite(totalBytes) || totalBytes < 0)) totalBytes = null;
  return { usedBytes, totalBytes };
}

/**
 * The inverse of `diskQueryFromMetricPick`: express a hardcoded `DiskQuery` in
 * the editable profile's row shape so the seed job can stamp it. Mirrors
 * `memoryQueryToDoubleScalar`. Returns null when the block names fewer than
 * two symbols (nothing to seed).
 */
export function diskQueryToDoubleScalar(disk: DiskQuery | undefined): {
  type:      "double_scalar";
  symbol:    string;
  symbolB:   string;
  transform: string;
} | null {
  if (!disk) return null;
  if (disk.usedBytesSymbol && disk.totalBytesSymbol) {
    return { type: "double_scalar", symbol: disk.usedBytesSymbol, symbolB: disk.totalBytesSymbol, transform: "a_over_b_as_percent" };
  }
  if (disk.usedBytesSymbol && disk.freeBytesSymbol) {
    return { type: "double_scalar", symbol: disk.usedBytesSymbol, symbolB: disk.freeBytesSymbol, transform: "a_over_a_plus_b_as_percent" };
  }
  if (disk.totalBytesSymbol && disk.freeBytesSymbol) {
    return { type: "double_scalar", symbol: disk.totalBytesSymbol, symbolB: disk.freeBytesSymbol, transform: "a_minus_b" };
  }
  return null;
}
