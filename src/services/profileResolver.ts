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
 * TWO resolvers live here, and only one of them has a caller:
 *
 *   `pickDbProfile` — what the four SNMP collectors call. Reads the
 *   operator-editable ManufacturerProfile ROWS ALONE. The hardcoded
 *   VENDOR_TELEMETRY_PROFILES constant is not consulted on this path at all.
 *
 *   `pickVendorProfileMerged` — the resolver it replaced: pick the hardcoded
 *   entry by regex over `manufacturer + os + model + fortinetClassHint`, then
 *   LAYER the rows over a clone of it for cpu / memory / temperature /
 *   storage. It has NO production caller. It stays so that
 *   profileResolverParity.test.ts can keep driving both over the same rows
 *   and proving the answers still match, which is the whole argument that the
 *   swap was safe; it goes when the constant does.
 */

import {
  pickVendorProfile,
  fortinetClassHint,
  diskQueryFromMetricPick,
  type VendorTelemetryProfile,
} from "./vendorTelemetryProfiles.js";
import {
  getProfileFor,
  listCachedProfiles,
  type Aggregate,
  type MetricKey,
  type MetricOverrideRow,
  type MetricRow,
  type ProfileFull,
} from "./manufacturerProfileService.js";
import { applyModelParse } from "../utils/modelParse.js";
import { clampRegexSubject } from "../utils/regexSafety.js";
import { normalizeAssetTypeName } from "../utils/assetTypes.js";
import { metricRowTransforms, type TransformKind } from "../utils/symbolTransforms.js";

/**
 * The unary transform the temperature collector should apply for this pick,
 * or undefined. Filtered through `metricRowTransforms` rather than trusted:
 * a row stored before the write path narrowed (a Celsius→Fahrenheit value,
 * or any transform on a table row) must not start doing something now that
 * the collector reads the field.
 */
function temperatureTransform(pick: DbMetricPick): TransformKind | undefined {
  const allowed = metricRowTransforms("temperature", pick.type);
  return allowed.find((k) => k === pick.transform);
}

/** Manufacturer → cached profile. Injected so tests run without a database. */
export type ProfileLookup = (manufacturer: string | null | undefined) => ProfileFull | null;

/** Every cached profile, for the `matchPattern` scan. Injected for the same reason. */
export type ProfileList = () => ProfileFull[];

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
  /** How a walked subtree collapses. "none" on every pre-Phase-4 row. */
  aggregate:     Aggregate;
  /** Sample-row label (StorageSample.mountPath / hardware sensorName). */
  label:         string | null;
  /** `model` metric only — the declarative parse, see src/utils/modelParse.ts. */
  parsePattern:  string | null;
  parseTemplate: string | null;
}

/** The pre-Phase-4 fields only; the four new ones take their "row said nothing" value. */
function pickFromRowDefaults(metric: MetricRow): DbMetricPick {
  return {
    symbol:        metric.defaultSymbol ?? null,
    symbolB:       metric.defaultSymbolB ?? null,
    type:          metric.defaultType,
    transform:     metric.defaultTransform ?? null,
    aggregate:     metric.defaultAggregate ?? "none",
    label:         metric.defaultLabel ?? null,
    parsePattern:  metric.defaultParsePattern ?? null,
    parseTemplate: metric.defaultParseTemplate ?? null,
  };
}

function pickFromOverride(o: MetricOverrideRow): DbMetricPick {
  return {
    symbol:        o.symbol || null,
    symbolB:       o.symbolB ?? null,
    type:          o.type,
    transform:     o.transform ?? null,
    aggregate:     o.aggregate ?? "none",
    label:         o.label ?? null,
    parsePattern:  o.parsePattern ?? null,
    parseTemplate: o.parseTemplate ?? null,
  };
}

export function resolveDbMetric(metric: MetricRow | undefined, model: string | null | undefined): DbMetricPick | null {
  if (!metric) return null;
  const modelStr = model ?? "";
  for (const o of (metric.overrides || [])) {
    // A device-type default (assetType set, no pattern) is a Phase 4 row this
    // pre-swap resolver does not read; `pickDbProfile` does. Skip, don't match.
    if (!o.modelPattern) continue;
    try {
      if (new RegExp(o.modelPattern, "i").test(clampRegexSubject(modelStr))) return pickFromOverride(o);
    } catch { /* malformed regex; skip — write-path validates so this is defensive only */ }
  }
  if (metric.defaultSymbol || metric.defaultSymbolB) return pickFromRowDefaults(metric);
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
    const transform = temperatureTransform(tempPick);
    merged.temperature = {
      symbol: tempPick.symbol,
      mode: tempPick.type === "table" ? "table" : "scalar",
      ...(transform ? { transform } : {}),
    };
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

// ─── The DB-only pick (Phase 4, the swap) ─────────────────────────────────
//
// `pickVendorProfileMerged` above layers rows over the hardcoded constant.
// Everything below reads rows ALONE. It is the same answer for every seeded
// install — the parity test pins that tuple by tuple — with the four
// differences the phase set out to make, each of them a bug the constant's
// shape forced:
//
//   1. Cisco memory walks again. The merge hardcoded `walkSubtree: false` on
//      the double_scalar path, so a seeded Cisco did a scalar GET of a table
//      column, got nothing, and fell to HOST-RESOURCES-MIB. `aggregate` is
//      the row that says otherwise.
//   2. A device-type default resolves. The constant could only key a family
//      off a model regex, which matched an empty model through
//      `fortinetClassHint` and nothing else; a Fortinet-shaped vendor with no
//      such hint had no way to say "every switch under me".
//   3. A profile the operator MADE now behaves like a seeded one. Before, a
//      manufacturer with no hardcoded entry got `base = null` and only the
//      four merged metrics; the model query, the sensor label and the mount
//      path were unreachable to it.
//   4. An alias spelling resolves through `matchPattern` instead of through
//      the constant's regex.

/** Everything the resolver knows about the asset in front of it. */
export interface ProfileSubject {
  manufacturer: string | null | undefined;
  os:           string | null | undefined;
  model:        string | null | undefined;
  assetType:    string | null | undefined;
  /**
   * The module name of the MIB pinned on this asset, when it has one — the
   * third field of the `matchPattern` haystack and part of the model haystack.
   * An asset whose only vendor signal is "it speaks FORTINET-FORTISWITCH-MIB"
   * is a real case on gear that reports no manufacturer over SNMP.
   */
  mibModule?:   string | null;
}

// Regexes come from the DB and are re-tested on every probe of every asset.
// Compiling per call is the kind of cost that only shows up at 2000 monitored
// assets, and the pattern set is small (one per profile plus one per scoped
// row), so it is cached by pattern text for the life of the process. A
// pattern that does not compile caches as null and is skipped — the write
// path validates, so this is defensive only, and caching the failure keeps a
// malformed row from re-throwing on every pass.
//
// Keyed by pattern TEXT, so an edited pattern is a new key and a stale entry
// can never be read; the only cost of not invalidating on write is one dead
// entry per edited pattern, which is why nothing calls the clear below in
// production. (A service → resolver import for that would also be a cycle.)
const regexCache = new Map<string, RegExp | null>();

function compiled(pattern: string): RegExp | null {
  const hit = regexCache.get(pattern);
  if (hit !== undefined) return hit;
  let re: RegExp | null = null;
  try { re = new RegExp(pattern, "i"); } catch { re = null; }
  regexCache.set(pattern, re);
  return re;
}

/** Drop every compiled pattern. Call after a profile write; tests use it to isolate. */
export function clearProfileRegexCache(): void {
  regexCache.clear();
}

/**
 * Which profile governs this asset.
 *
 * The canonical manufacturer is the primary key and the only lookup that
 * runs for an asset the alias map already folds into a profile's name. Only
 * when that misses does `matchPattern` get its turn, tested against
 * `manufacturer os mibModule` — so a profile's "also applies when" can never
 * steal an asset from the profile actually keyed by its manufacturer.
 */
export function findDbProfile(
  subject: ProfileSubject,
  lookup: ProfileLookup = getProfileFor,
  list: ProfileList = listCachedProfiles,
): ProfileFull | null {
  const keyed = lookup(subject.manufacturer);
  if (keyed) return keyed;

  // Device-supplied SNMP text, matched against an operator's regex once per
  // asset per poll — clamped so subject length can never be the thing that
  // makes a pattern expensive. See utils/regexSafety.ts.
  const haystack = clampRegexSubject(
    [subject.manufacturer, subject.os, subject.mibModule].filter(Boolean).join(" ").trim(),
  );
  if (!haystack) return null;
  for (const p of list()) {
    if (!p.matchPattern) continue;
    const re = compiled(p.matchPattern);
    if (re && re.test(haystack)) return p;
  }
  return null;
}

/**
 * The effective row for one metric, most-specific-first:
 *
 *   1. this device type AND a matching model pattern
 *   2. a matching model pattern, any device type
 *   3. this device type's default (no pattern)
 *   4. the metric row's own defaults
 *
 * A stated model outranks an inferred type deliberately (2 above 3): an asset
 * mis-typed by discovery whose model names its family still routes by the
 * model. Inside a tier the row `order` decides, and the rows arrive sorted by
 * it — which is why the profile page must render them in that same order.
 */
export function resolveScopedMetric(
  metric: MetricRow | undefined,
  assetType: string | null | undefined,
  modelHaystack: string,
  skipTypeDefaults = false,
): DbMetricPick | null {
  if (!metric) return null;
  const type = assetType ? normalizeAssetTypeName(assetType) : null;
  const rows = metric.overrides || [];

  const modelHit = (o: MetricOverrideRow): boolean => matchesModel(o, modelHaystack);
  const typeHit = (o: MetricOverrideRow): boolean =>
    !!type && !!o.assetType && normalizeAssetTypeName(o.assetType) === type;

  const tiers: Array<(o: MetricOverrideRow) => boolean> = [
    (o) => typeHit(o) && modelHit(o),
    (o) => !o.assetType && modelHit(o),
  ];
  if (!skipTypeDefaults) tiers.push((o) => typeHit(o) && !o.modelPattern);

  for (const inTier of tiers) {
    const hit = rows.find(inTier);
    if (hit) return pickFromOverride(hit);
  }
  if (metric.defaultSymbol || metric.defaultSymbolB) return pickFromRowDefaults(metric);
  return null;
}

function matchesModel(o: MetricOverrideRow, modelHaystack: string): boolean {
  if (!o.modelPattern) return false;
  const re = compiled(o.modelPattern);
  return !!re && re.test(clampRegexSubject(modelHaystack));
}

/**
 * Does this device's MODEL name its family, anywhere in this profile?
 *
 * The question is asked once per device, not once per metric, and it decides
 * whether the device-type tier is consulted at all. A mis-typed FortiAP —
 * model "FortiAP-231F", `assetType: "switch"` — matches the FortiAP model
 * rows for cpu / memory / temperature, but the Fortinet profile has no
 * FortiAP STORAGE row, so a per-metric walk would fall through to the SWITCH
 * type default and hand a FortiAP the FortiSwitch flash OIDs. The device
 * would be reading half its telemetry as one family and half as another,
 * which the hardcoded constant could not do — it picked ONE entry for the
 * whole device.
 *
 * So: a matching row that states a model and NO device type (the "this model,
 * whatever it is typed as" tier) settles the device's identity, and the
 * type defaults are skipped for every metric. A metric that family has
 * nothing to say about then reads the profile default or nothing at all —
 * the same silence the constant produced.
 *
 * A row carrying BOTH halves does not settle anything: it is an exception
 * scoped UNDER a device type and is only reachable through that type.
 */
export function modelIdentifiesDevice(profile: ProfileFull, modelHaystack: string): boolean {
  if (!modelHaystack) return false;
  return profile.metrics.some((m) =>
    (m.overrides || []).some((o) => !o.assetType && matchesModel(o, modelHaystack)),
  );
}

/** `aggregate` is the row's word for "this symbol names a subtree, walk it". */
function walks(pick: DbMetricPick): boolean {
  return pick.aggregate === "avg" || pick.aggregate === "sum";
}

/**
 * Build the runtime telemetry shape for an asset from its profile rows alone.
 * Returns null when no profile governs the asset, or when one does but has
 * nothing configured for any metric the collectors read — both mean "this
 * install has no vendor opinion here", and the collectors already treat a
 * null profile as "use the standard MIBs".
 */
export function pickDbProfile(
  subject: ProfileSubject,
  lookup: ProfileLookup = getProfileFor,
  list: ProfileList = listCachedProfiles,
): VendorTelemetryProfile | null {
  const profile = findDbProfile(subject, lookup, list);
  if (!profile) return null;

  // `fortinetClassHint` is carried into the model haystack for compatibility,
  // not because the resolver still needs it: the device-type tier is its
  // general replacement, and the Phase 4 migration gives every seeded
  // FortiSwitch / FortiAP model row a type-default sibling. What it still
  // covers is a Fortinet profile an operator built BY HAND whose rows use a
  // model pattern the migration's `IN ('FortiSwitch','FortiAP')` guard did
  // not recognize — dropping the hint would silently stop collecting on that
  // install. Removable once those rows are gone; nothing else depends on it.
  const modelHaystack = [
    subject.model,
    subject.mibModule,
    fortinetClassHint(subject.manufacturer, subject.model, subject.assetType),
  ].filter(Boolean).join(" ");

  // Asked once for the device, not once per metric — see modelIdentifiesDevice.
  const byModel = modelIdentifiesDevice(profile, modelHaystack);

  const row = (key: MetricKey) => profile.metrics.find((m) => m.metricKey === key);
  const pick = (key: MetricKey) => resolveScopedMetric(row(key), subject.assetType, modelHaystack, byModel);

  const cpuPick   = pick("cpu" as MetricKey);
  const memPick   = pick("memory" as MetricKey);
  const tempPick  = pick("temperature" as MetricKey);
  const diskPick  = pick("storage" as MetricKey);
  const modelPick = pick("model" as MetricKey);

  const out: VendorTelemetryProfile = {
    vendor: profile.manufacturer,
    // The runtime never re-tests this; `findDbProfile` has already decided.
    // The profile's own "also applies when" is the honest value where there
    // is one, and a sentinel that matches nothing where there is not.
    match: (profile.matchPattern && compiled(profile.matchPattern)) || /__db_profile__/,
  };

  if (cpuPick?.symbol) {
    // walk-avg is the only walked CPU shape the collector implements, so a
    // row that says `sum` still walks — it averages. Worth knowing if a
    // vendor ever needs a summed CPU; today none does.
    out.cpu = {
      symbol: cpuPick.symbol,
      mode: cpuPick.type === "table" || walks(cpuPick) ? "walk-avg" : "scalar",
    };
  }

  if (memPick) {
    if (memPick.type === "double_scalar" && memPick.symbol && memPick.symbolB) {
      // The combiner says which pair the two symbols are; it is not arithmetic
      // to perform here. `walkSubtree` is now the row's own word rather than
      // the hardcoded baseline's — which is the Cisco fix.
      if (memPick.transform === "a_over_b_as_percent") {
        out.memory = { usedBytesSymbol: memPick.symbol, totalBytesSymbol: memPick.symbolB, walkSubtree: walks(memPick) };
      } else if (memPick.transform === "a_over_a_plus_b_as_percent") {
        out.memory = { usedBytesSymbol: memPick.symbol, freeBytesSymbol: memPick.symbolB, walkSubtree: walks(memPick) };
      }
      // Any other combiner is not memory-meaningful — leave memory unset
      // rather than emit a shape the collector would misread.
    } else if (memPick.type !== "double_scalar" && memPick.symbol) {
      out.memory = { pctSymbol: memPick.symbol, walkSubtree: walks(memPick) };
    }
  }

  if (tempPick?.symbol) {
    const transform = temperatureTransform(tempPick);
    out.temperature = {
      symbol: tempPick.symbol,
      mode: tempPick.type === "table" ? "table" : "scalar",
      ...(tempPick.label ? { sensorName: tempPick.label } : {}),
      ...(transform ? { transform } : {}),
    };
  }

  if (diskPick) {
    // A row that cannot produce a used/total byte pair resolves to null and
    // leaves disk unset — a half-finished edit costs this metric, not the pass.
    const disk = diskQueryFromMetricPick(diskPick, diskPick.label ?? undefined);
    if (disk) out.disk = disk;
  }

  if (modelPick?.symbol && modelPick.parsePattern) {
    // `rowParse` is the operator's row itself, and `parse` is that row
    // applied — the same relationship the hardcoded entry has, read in the
    // other direction (there the function is authored and the row derived
    // from it for seeding; here the row is the source).
    const rowParse = { pattern: modelPick.parsePattern, template: modelPick.parseTemplate };
    out.model = { symbol: modelPick.symbol, rowParse, parse: (raw: string) => applyModelParse(raw, rowParse) };
  }

  // A profile row exists but says nothing the collectors can use. Reporting
  // null rather than an empty shell keeps "no opinion" a single condition for
  // every caller.
  if (!out.cpu && !out.memory && !out.temperature && !out.disk && !out.model) return null;
  return out;
}
