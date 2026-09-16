/**
 * src/services/profileResolver.ts — which vendor telemetry shape an asset gets.
 *
 * Extracted verbatim from monitoringService.ts in Phase 4 step 1 of uniform
 * SNMP so that the resolver is a pure module with an INJECTED profile lookup:
 * the parity test (tests/unit/profileResolverParity.test.ts) feeds in-memory
 * rows to both this — today's merge over the hardcoded constant — and its
 * successor, and proves the swap changes nothing it did not mean to. Nothing
 * here touches Prisma; `getProfileFor` is the default lookup and reads the
 * warm cache.
 *
 * What it does today: pick the hardcoded VENDOR_TELEMETRY_PROFILES entry by
 * regex over `manufacturer + os + model + fortinetClassHint`, then LAYER the
 * operator-editable ManufacturerProfile rows over a clone of it for the four
 * metric keys the collectors read (cpu / memory / temperature / storage).
 * The constant is still the fallback and the source of the fields the DB
 * cannot express (`walkSubtree`, `mountPath`, `model.parse`). Step 6 of the
 * phase replaces this with a DB-only pick.
 */

import {
  pickVendorProfile,
  fortinetClassHint,
  diskQueryFromMetricPick,
  type VendorTelemetryProfile,
} from "./vendorTelemetryProfiles.js";
import {
  getProfileFor,
  type MetricKey,
  type MetricRow,
  type ProfileFull,
} from "./manufacturerProfileService.js";

/** Manufacturer → cached profile. Injected so tests run without a database. */
export type ProfileLookup = (manufacturer: string | null | undefined) => ProfileFull | null;

// Per-asset metric resolution from the editable Manufacturer Profile.
// Walks the profile's per-model overrides in `order` and picks the first whose
// `modelPattern` regex matches `Asset.model`; falls back to the metric row's
// defaults. Returns null when the DB has no opinion — the caller then uses
// the hardcoded `VENDOR_TELEMETRY_PROFILES` entry unchanged.
//
// `type="double_scalar"` carries TWO OIDs (`symbol` + `symbolB`) and a
// `transform` that is a CombinerKind; the caller decides how to map that
// onto the runtime probe shape (memory walks both OIDs and computes a
// percent via the combiner's semantics).
export interface DbMetricPick {
  symbol:    string | null;
  symbolB:   string | null;
  type:      "scalar" | "double_scalar" | "table";
  transform: string | null; // TransformKind on scalar/table; CombinerKind on double_scalar
}

export function resolveDbMetric(metric: MetricRow | undefined, model: string | null | undefined): DbMetricPick | null {
  if (!metric) return null;
  const modelStr = model ?? "";
  for (const o of (metric.overrides || [])) {
    // A device-type default (assetType set, no pattern) is a Phase 4 row this
    // pre-swap resolver does not read; `pickDbProfile` does. Skip, don't match.
    if (!o.modelPattern) continue;
    try {
      if (new RegExp(o.modelPattern, "i").test(modelStr)) {
        return {
          symbol:    o.symbol || null,
          symbolB:   o.symbolB ?? null,
          type:      o.type,
          transform: o.transform ?? null,
        };
      }
    } catch { /* malformed regex; skip — write-path validates so this is defensive only */ }
  }
  if (metric.defaultSymbol || metric.defaultSymbolB) {
    return {
      symbol:    metric.defaultSymbol ?? null,
      symbolB:   metric.defaultSymbolB ?? null,
      type:      metric.defaultType,
      transform: metric.defaultTransform ?? null,
    };
  }
  return null;
}

// Layer the editable Manufacturer Profile on top of the hardcoded vendor
// profile. The DB owns operator-edited symbols + per-model exceptions; when
// the DB has a non-null choice we swap the primary symbol on a CLONE of the
// hardcoded profile so the rest of the probe shape (walk-avg mode for
// Cisco, etc.) survives unchanged.
//
// Memory supports a richer Shape: when the DB row is `type="double_scalar"`
// (replaces the legacy memory-only `composition` blob), the combiner tells
// us which multi-OID memory shape to emit:
//   transform="a_over_b_as_percent"        → { usedBytesSymbol, totalBytesSymbol }
//   transform="a_over_a_plus_b_as_percent" → { usedBytesSymbol, freeBytesSymbol }
// `collectMemoryVendor` then walks both OIDs and computes the percent —
// matching what the hardcoded FortiSwitch baseline already does. Scalar
// memory rows fall back to the single-symbol pctSymbol shape.
//
// Storage reads the same way through `diskQueryFromMetricPick`, with one
// difference: the collector emits a StorageSample carrying BYTES and every
// reader derives its own percent, so the combiner is read as a statement of
// which two of used/total/free the row's symbols are rather than as
// arithmetic to perform.
//
// Returns the hardcoded profile unchanged when the DB cache hasn't loaded yet
// OR no matching DB profile exists.
export function pickVendorProfileMerged(
  manufacturer: string | null | undefined,
  os: string | null | undefined,
  model: string | null | undefined,
  assetType?: string | null | undefined,
  lookup: ProfileLookup = getProfileFor,
): VendorTelemetryProfile | null {
  const base = pickVendorProfile(manufacturer, os, model, assetType);
  const dbProfile = lookup(manufacturer);
  if (!dbProfile) return base;

  // Pluck the metric rows the SNMP collectors consult. `interfaces` / `lldp` /
  // `wirelessStations` are deliberately absent: those are table walks with no
  // symbol to swap, so their rows on the profile page stay descriptive.
  const cpuRow         = dbProfile.metrics.find((m) => m.metricKey === ("cpu" as MetricKey));
  const memoryRow      = dbProfile.metrics.find((m) => m.metricKey === ("memory" as MetricKey));
  const temperatureRow = dbProfile.metrics.find((m) => m.metricKey === ("temperature" as MetricKey));
  const storageRow     = dbProfile.metrics.find((m) => m.metricKey === ("storage" as MetricKey));

  // The DB row's `modelPattern` is matched against the MODEL ALONE, while the
  // hardcoded pick above matches a haystack that also carries `os` and the
  // class hint. Without the hint here the two layers disagree on the same
  // asset: `pickVendorProfile` correctly picks FortiSwitch, then the Fortinet
  // profile's model-pattern overrides ("FortiSwitch" / "FortiAP") miss an empty
  // model, `resolveDbMetric` falls back to that profile's manufacturer-wide
  // DEFAULT (`fgSysCpuUsage`), and the merge below overwrites the correct symbol
  // with it — a vendor-wide default silently outranking a more specific match.
  const matchModel = [model, fortinetClassHint(manufacturer, model, assetType)].filter(Boolean).join(" ");
  const cpuPick  = resolveDbMetric(cpuRow,         matchModel);
  const memPick  = resolveDbMetric(memoryRow,      matchModel);
  const tempPick = resolveDbMetric(temperatureRow, matchModel);
  const diskPick = resolveDbMetric(storageRow,     matchModel);

  // Nothing operator-overridden? Skip the clone allocation entirely.
  if (!cpuPick && !memPick && !tempPick && !diskPick) return base;

  // Clone shallowly so we can swap fields without mutating the shared
  // VENDOR_TELEMETRY_PROFILES array entry.
  const merged: VendorTelemetryProfile = base
    ? { ...base, cpu: base.cpu && { ...base.cpu }, memory: base.memory && { ...base.memory }, temperature: base.temperature && { ...base.temperature }, disk: base.disk && { ...base.disk } }
    : { vendor: dbProfile.manufacturer, match: /__db_profile__/, cpu: undefined, memory: undefined, temperature: undefined, disk: undefined };

  if (cpuPick && cpuPick.symbol) {
    merged.cpu = { symbol: cpuPick.symbol, mode: cpuPick.type === "table" ? "walk-avg" : "scalar" };
  }
  if (memPick) {
    if (memPick.type === "double_scalar" && memPick.symbol && memPick.symbolB) {
      // Map combiner → runtime memory shape. The runtime collector walks
      // both OIDs identically; only the field name signals which pair we're
      // dealing with (used+total vs used+free).
      if (memPick.transform === "a_over_b_as_percent") {
        merged.memory = {
          usedBytesSymbol:  memPick.symbol,
          totalBytesSymbol: memPick.symbolB,
          walkSubtree:      false,
        };
      } else if (memPick.transform === "a_over_a_plus_b_as_percent") {
        merged.memory = {
          usedBytesSymbol: memPick.symbol,
          freeBytesSymbol: memPick.symbolB,
          walkSubtree:     false,
        };
      }
      // Other combiners aren't memory-meaningful; fall through to base.
    } else if (memPick.type === "scalar" && memPick.symbol) {
      // Single-symbol percent path. walkSubtree is on for vendors whose
      // pctSymbol comes from a walked table (Juniper jnxOperatingBuffer,
      // Cisco ciscoMemoryPool*Free, etc.) — we infer that from the
      // hardcoded baseline since the DB row no longer carries walkSubtree.
      const baseWalk = base?.memory?.walkSubtree === true;
      merged.memory = { pctSymbol: memPick.symbol, walkSubtree: baseWalk };
    }
  }
  if (tempPick && tempPick.symbol) {
    // `table` makes the SNMP hardware-sensor collector walk the named sensor
    // table (e.g. fgHwSensorTable) instead of a single scalar GET — the
    // operator-facing "Hardware Sensors" metric. `scalar` keeps the
    // single-reading path (FortiAP fapTemperature).
    merged.temperature = { symbol: tempPick.symbol, mode: tempPick.type === "table" ? "table" : "scalar" };
  }
  if (diskPick) {
    // The operator-facing "Storage" metric. It feeds the vendor disk fallback
    // that runs when HOST-RESOURCES-MIB's hrStorageTable came back with no
    // disk rows — which on a FortiSwitch is every pass, since the FortiSwitch
    // agent doesn't implement HRM's storage view at all. `mountPath` is not a
    // profile field, so the base profile's label is carried over (a
    // FortiSwitch keeps "flash") and only the OIDs come from the DB.
    //
    // A row that can't produce a used/total byte pair resolves to null and
    // leaves `merged.disk` at the hardcoded baseline rather than clearing it:
    // a half-finished edit must not cost an install its storage collection.
    const disk = diskQueryFromMetricPick(diskPick, base?.disk?.mountPath);
    if (disk) merged.disk = disk;
  }
  return merged;
}
