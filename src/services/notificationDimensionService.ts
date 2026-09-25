/**
 * src/services/notificationDimensionService.ts
 *
 * "What do THESE devices actually report?" for the automation builder's
 * dimensionFilter inputs (sensor class, interface, mount path, SD-WAN
 * health-check / member, IPsec tunnel).
 *
 * Why this exists: those inputs used to be free text, so an operator typed
 * "Temperature" (or "temp", or a sensor NAME) into a field the server validates
 * as the strict enum `temperature|fan|voltage|power|disk|other` — the save 400s,
 * or worse, a pattern field silently matches nothing and the automation never
 * fires. The picker reads back the values the DRAFT'S OWN device scope has
 * reported recently, so the offered options are always both spelled right and
 * present on the selected devices; an empty result is itself the answer ("these
 * devices report no hardware sensors").
 *
 * Scope resolution is `loadScopeAssetIds(scope, { monitoredOnly: true })` from
 * the engine — the same monitored-gated loadScopeAssets the evaluation tick
 * uses (business rule 37), so the picker can't offer a value
 * from a device the automation wouldn't evaluate.
 *
 * Scale (100 vs 2000 assets): this is an INTERACTIVE call on a hypertable, so
 * both axes are bounded — a short lookback window (`RECENT_WINDOW_HOURS`) and a
 * cap on how many scoped assets are queried (`ASSET_SAMPLE_CAP`), since the
 * default scope is "all assets". Every query is a Postgres-side GROUP BY over
 * `(value, assetId)` on an `(assetId, …, timestamp)` index — aggregate output
 * only, never per-sample rows. `sampledAssets` < `scopedAssets` tells the caller
 * the list came from a subset so it can say so.
 */

import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/errors.js";
import { triggerDimensionApplicable, type RuleScope } from "./notificationTypes.js";
import { poeIsFault } from "../utils/poePorts.js";
import { loadScopeAssetIds } from "./notificationEngine.js";
import { listStateProbes } from "./manufacturerProfileService.js";

/** Lookback for "currently reported". Long enough to catch any realistic
 *  telemetry cadence (minutes; an hourly cadence still lands ≥3 samples),
 *  short enough that the scan stays interactive. */
const RECENT_WINDOW_HOURS = 3;
/** Widened retry used ONLY when the recent window found nothing at all, so the
 *  "these devices report no sensors" message can't be a cadence artifact. Paired
 *  with a tighter asset cap to keep the worst case bounded. */
const FALLBACK_WINDOW_HOURS = 48;
const FALLBACK_ASSET_CAP = 100;
/** Assets queried per call. The default scope is every asset, and the answer
 *  ("which classes exist here") saturates long before 250 devices. */
const ASSET_SAMPLE_CAP = 250;
/** Cap on distinct values returned — an interface list on a big switch stack is
 *  long, and the control is a picker, not an inventory. */
const MAX_VALUES = 300;

/** One reported value + how many of the sampled devices report it. */
export interface DimensionValueOption {
  value: string;
  assetCount: number;
  /**
   * Operator-facing name when the stored value isn't one — a state probe's
   * dimension value is its registry UUID, which no operator recognizes, so the
   * picker shows this and stores `value`. Absent on every device-reported
   * dimension, where the value IS the name.
   */
  label?: string;
}

export interface DimensionValuesResult {
  metric: string;
  dimension: string;
  /** True when the server validates this dimension as a closed enum, so the UI
   *  must offer a select rather than a free-text box with suggestions. */
  strict: boolean;
  /** What this dimension names, for the empty-state sentence ("no hardware
   *  sensors"). */
  noun: string;
  /** Tail describing the sibling narrowing applied (" of class temperature"),
   *  "" when none — so "reported no hardware sensors" can't be read as "none at
   *  all" when it really means "none of that class". */
  narrowLabel: string;
  values: DimensionValueOption[];
  /** Devices the draft's scope resolves to (before the sample cap). */
  scopedAssets: number;
  /** Effective coverage: equals scopedAssets when every device that COULD
   *  report the dimension was queried (candidateWhere narrowed the set under
   *  the cap — the values list is complete); less than scopedAssets only when
   *  the cap genuinely truncated, which is what tells the UI to disclose a
   *  partial list. */
  sampledAssets: number;
  /** Of the sampled devices, how many reported ANY value for this dimension.
   *  0 with scopedAssets > 0 is the "selected devices report none of these" case. */
  assetsWithData: number;
  windowHours: number;
}

type ValuePair = { value: string | null; assetId: string };

/**
 * Sibling dimension values already chosen on the same condition row, used to
 * narrow the list. A firewall reports temperature, fan AND voltage sensors, so
 * once the operator picks class=temperature the sensor-NAME list must not offer
 * "FAN1" — picking it would build a filter that matches nothing.
 */
export interface DimensionNarrow {
  sensorClass?: string;
  healthCheck?: string;
  stateProbeId?: string;
  /**
   * The COMPARISON the condition row is making, not a sibling dimension value —
   * the only narrowing input that isn't. It exists for one case: `poeStatus ==
   * fault` reads every PoE-capable port while every other PoE comparison stays
   * pinned-only (business rule 57's carve-out, `poeFaultCoversUnpinned`), so
   * the interface list depends on the operator and value as well as the field.
   * Sent by the wizard only for a `poeStatus` row, so no other picker re-fetches
   * when an operator edits a threshold.
   */
  stateOperator?: string;
  stateValue?: string;
}

interface DimensionSource {
  /** Plural noun for operator-facing messaging. */
  noun: string;
  /** Closed value set (select-only) vs a substring/pattern field (suggestions). */
  strict: boolean;
  /**
   * Which assets can REPORT this dimension at all, as a cheap indexed Asset
   * where — applied before the interactive sample cap whenever the scope
   * exceeds it. Without it the cap sampled the scoped ids BLINDLY, and at
   * fleet scale that answer was a lie: 250 of ~14,500 scoped devices almost
   * never contains the few FortiGates that report SD-WAN, so the picker said
   * "these devices report no health checks" about a fleet that does (prod
   * 2026-08-21). Absent = every scoped asset is a candidate (the identity
   * dimensions, where that is true).
   */
  candidateWhere?: Prisma.AssetWhereInput;
  pairs: (ids: string[], since: Date, narrow: DimensionNarrow) => Promise<ValuePair[]>;
  /** Human tail describing the narrowing that was applied ("of class temperature"),
   *  so the empty-state message says WHICH slice came back empty. */
  narrowLabel?: (narrow: DimensionNarrow) => string;
  /** Builds a value→display-name lookup, for dimensions whose stored value is an
   *  opaque id. Called once per request (not per value) so the implementation can
   *  index a registry up front. */
  labelOf?: () => ((value: string) => string | undefined) | Promise<(value: string) => string | undefined>;
}

/**
 * Per-dimension value source. Keys MUST match the dimensionFilter field names in
 * notificationTypes (METRIC_DIMENSIONS lists which apply per metric).
 *
 * `strict` mirrors the dimensionFilter Zod schema: sensorClass is the only
 * closed enum there — the rest are matched with `substringMatch`, so an operator
 * may legitimately type a partial ("port", "/var") and the picker only suggests.
 * Keep the two in lockstep: making a dimension an enum server-side without
 * flipping this leaves the UI offering a box that now rejects free text.
 *
 * `widgetId` (customWidgetValue's numeric-widget dimension) is deliberately
 * absent: it stays a plain input. `stateProbeId` IS here despite also being an
 * opaque UUID, because it carries a `labelOf` that resolves the probe's name out
 * of the registry — the picker shows the name and stores the id.
 */
const DIMENSION_SOURCES: Record<string, DimensionSource> = {
  sensorClass: {
    noun: "hardware sensors",
    strict: true,
    // Sensor samples only come from polled devices — the doctrine the whole
    // builder follows (values from monitored devices only).
    candidateWhere: { monitored: true },
    pairs: async (ids, since) =>
      (await prisma.assetHardwareSensorSample.groupBy({
        by: ["sensorClass", "assetId"],
        where: { assetId: { in: ids }, timestamp: { gte: since } },
      })).map((r) => ({ value: r.sensorClass, assetId: r.assetId })),
  },
  // Individual named sensors ("CPU ON-DIE Temperature"), narrowed to the class
  // the row already filters on so a temperature condition isn't offered fan names.
  sensorNamePattern: {
    noun: "hardware sensors",
    strict: false,
    candidateWhere: { monitored: true },
    narrowLabel: (n) => (n.sensorClass ? ` of class ${n.sensorClass}` : ""),
    pairs: async (ids, since, narrow) =>
      (await prisma.assetHardwareSensorSample.groupBy({
        by: ["sensorName", "assetId"],
        where: {
          assetId: { in: ids },
          timestamp: { gte: since },
          ...(narrow.sensorClass ? { sensorClass: narrow.sensorClass } : {}),
        },
      })).map((r) => ({ value: r.sensorName, assetId: r.assetId })),
  },
  // ── Device-identifier dimensions ─────────────────────────────────────────
  // The scoped devices' own identity columns — Asset rows, not a sample table,
  // so `since` is unused (an identity has no cadence). The per-value counts
  // still matter because the filters are patterns and "SW-" legitimately
  // selects a fleet; manufacturer/model naturally fold many devices per value.
  hostnamePattern: {
    noun: "device hostnames",
    strict: false,
    pairs: async (ids) =>
      (await prisma.asset.findMany({
        where: { id: { in: ids } },
        select: { id: true, hostname: true },
      })).map((a) => ({ value: a.hostname, assetId: a.id })),
  },
  ipPattern: {
    noun: "device IP addresses",
    strict: false,
    pairs: async (ids) =>
      (await prisma.asset.findMany({
        where: { id: { in: ids } },
        select: { id: true, ipAddress: true },
      })).map((a) => ({ value: a.ipAddress, assetId: a.id })),
  },
  macPattern: {
    noun: "device MAC addresses",
    strict: false,
    pairs: async (ids) =>
      (await prisma.asset.findMany({
        where: { id: { in: ids } },
        select: { id: true, macAddress: true },
      })).map((a) => ({ value: a.macAddress, assetId: a.id })),
  },
  manufacturerPattern: {
    noun: "manufacturers",
    strict: false,
    pairs: async (ids) =>
      (await prisma.asset.findMany({
        where: { id: { in: ids } },
        select: { id: true, manufacturer: true },
      })).map((a) => ({ value: a.manufacturer, assetId: a.id })),
  },
  modelPattern: {
    noun: "models",
    strict: false,
    pairs: async (ids) =>
      (await prisma.asset.findMany({
        where: { id: { in: ids } },
        select: { id: true, model: true },
      })).map((a) => ({ value: a.model, assetId: a.id })),
  },
  ifNamePattern: {
    // Reads the PIN SET (`Asset.monitoredInterfaces`), which is what every
    // interface resolver gates on (notificationEngine's interfaceIsPinned), so
    // the picker offers exactly the interfaces a rule can actually fire about —
    // offering an unpinned port would offer a filter that never matches. The
    // pin set rather than the `AssetInterface` inventory for the same reason it
    // isn't the sample table: a pin can exist before either has data (auto-
    // monitor pins the cycle before the first scrape), and the operator's own
    // selection is the thing being matched. `since` is unused — a pin has no
    // time dimension. The noun says "monitored" so every operator-facing
    // message the wizard builds from it ("report no monitored interfaces")
    // names the gate instead of reading as "this device has no ports".
    noun: "monitored interfaces",
    strict: false,
    candidateWhere: { monitoredInterfaces: { isEmpty: false } },
    pairs: async (ids) =>
      (await prisma.asset.findMany({
        where: { id: { in: ids } },
        select: { id: true, monitoredInterfaces: true },
      })).flatMap((a) => a.monitoredInterfaces.map((ifName) => ({ value: ifName, assetId: a.id }))),
  },
  mountPathPattern: {
    // The operator-pinned set (`Asset.monitoredStorage`), mirroring
    // ifNamePattern — and since 2026-09 for the same reason rather than a
    // weaker one (business rule 57): all three storage resolvers gate on
    // `storageIsPinned`, so an unpinned mount is a filter that can never fire.
    // The sample table is not
    // the source for the usual reason (it carries every mountpath the device
    // reports — unpinned rows ride `cadence:"slow"`, 24h, never rolled up, so
    // reading it would offer mounts that neither fire nor keep enough history
    // for a 7-day average) and because a pin can exist before the first scrape.
    noun: "monitored storage mounts",
    strict: false,
    candidateWhere: { monitoredStorage: { isEmpty: false } },
    pairs: async (ids) =>
      (await prisma.asset.findMany({
        where: { id: { in: ids } },
        select: { id: true, monitoredStorage: true },
      })).flatMap((a) => a.monitoredStorage.map((mountPath) => ({ value: mountPath, assetId: a.id }))),
  },
  healthCheck: {
    noun: "SD-WAN health checks",
    strict: false,
    // SD-WAN SLA samples come only from FortiGate firewalls (collectSdwan-
    // Fortinet) — the case that motivated candidateWhere: a fleet-wide scope's
    // blind sample missed every gate and read as "no health checks".
    candidateWhere: { assetType: "firewall" },
    pairs: async (ids, since) =>
      (await prisma.assetPerfSlaSample.groupBy({
        by: ["healthCheck", "assetId"],
        where: { assetId: { in: ids }, timestamp: { gte: since } },
      })).map((r) => ({ value: r.healthCheck, assetId: r.assetId })),
  },
  link: {
    noun: "SD-WAN WAN members",
    strict: false,
    candidateWhere: { assetType: "firewall" },
    narrowLabel: (n) => (n.healthCheck ? ` for health check ${n.healthCheck}` : ""),
    pairs: async (ids, since, narrow) =>
      (await prisma.assetPerfSlaSample.groupBy({
        by: ["link", "assetId"],
        where: {
          assetId: { in: ids },
          timestamp: { gte: since },
          // substringMatch semantics, mirroring how the engine filters it.
          ...(narrow.healthCheck ? { healthCheck: { contains: narrow.healthCheck, mode: "insensitive" as const } } : {}),
        },
      })).map((r) => ({ value: r.link, assetId: r.assetId })),
  },
  tunnelName: {
    // The pin set (`Asset.monitoredIpsecTunnels`), mirroring ifNamePattern:
    // both IPsec resolvers now gate on it (notificationEngine's
    // tunnelIsPinned), so an unpinned tunnel is a filter that can never fire —
    // the sample table still carries every tunnel the gate reports (unpinned
    // rows ride cadence="slow"), which is why the picker must not read it.
    // The noun says "monitored" so the wizard's empty-state message names the
    // gate instead of reading as "this gate has no tunnels".
    noun: "monitored IPsec tunnels",
    strict: false,
    candidateWhere: { monitoredIpsecTunnels: { isEmpty: false } },
    pairs: async (ids) =>
      (await prisma.asset.findMany({
        where: { id: { in: ids } },
        select: { id: true, monitoredIpsecTunnels: true },
      })).flatMap((a) => a.monitoredIpsecTunnels.map((t) => ({ value: t, assetId: a.id }))),
  },
  // SD-WAN service rules (sdwanRuleStatus / sdwanSelectedMember alert per
  // ruleName; this dimension narrows to the named rule). Current-state table
  // delete-replaced per scrape, so `since` is unused — like the pin arrays.
  sdwanRulePattern: {
    noun: "SD-WAN rules",
    strict: false,
    candidateWhere: { assetType: "firewall" },
    pairs: async (ids) =>
      (await prisma.assetSdwanRule.findMany({
        where: { assetId: { in: ids } },
        select: { assetId: true, ruleName: true },
      })).map((r) => ({ value: r.ruleName, assetId: r.assetId })),
  },
  // Which state probe (Manufacturer Profile → state widget). Strict: the stored
  // value is a registry id matched exactly by the engine, not a pattern, so free
  // text here could only ever be a typo that matches nothing. Values are UUIDs,
  // so `labelOf` supplies the probe name for display — see listStateProbes.
  stateProbeId: {
    noun: "state probes",
    strict: true,
    candidateWhere: { monitored: true },
    labelOf: () => {
      const byId = new Map(listStateProbes().map((p) => [p.id, `${p.name} (${p.manufacturer})`]));
      return (value: string) => byId.get(value);
    },
    pairs: async (ids, since) =>
      (await prisma.assetStateSample.groupBy({
        by: ["probeId", "assetId"],
        where: { assetId: { in: ids }, timestamp: { gte: since } },
      })).map((r) => ({ value: r.probeId, assetId: r.assetId })),
  },
  // Individual rows of a state probe ("PSU 2", "CPU ON-DIE Temperature"),
  // narrowed to the probe the row already filters on — offering every probe's
  // rows would let an operator build probe+row combinations that match nothing.
  stateRowPattern: {
    noun: "state probe rows",
    strict: false,
    candidateWhere: { monitored: true },
    narrowLabel: (n) => {
      if (!n.stateProbeId) return "";
      const probe = listStateProbes().find((p) => p.id === n.stateProbeId);
      return probe ? ` for probe ${probe.name}` : "";
    },
    pairs: async (ids, since, narrow) =>
      (await prisma.assetStateSample.groupBy({
        by: ["rowLabel", "assetId"],
        where: {
          assetId: { in: ids },
          timestamp: { gte: since },
          ...(narrow.stateProbeId ? { probeId: narrow.stateProbeId } : {}),
        },
      })).map((r) => ({ value: r.rowLabel, assetId: r.assetId })),
  },
  // Which agent-run path check (path* metrics). Strict like
  // stateProbeId — an exact registry id, so free text could only be a typo —
  // and labelled by the check's name. Pairs come from MEMBERSHIP
  // (path_check_sources), not the samples: the pin-set reasoning — a
  // host is a source the moment it is reconciled, before its first result,
  // and the membership is exactly what the engine's readings can come from.
  checkId: {
    noun: "path checks",
    strict: true,
    candidateWhere: { managedAgent: { is: { installStatus: "active" } } },
    labelOf: async () => {
      const rows = await prisma.pathCheck.findMany({ select: { id: true, name: true, kind: true } });
      const byId = new Map(rows.map((r) => [r.id, `${r.name} (${r.kind.toUpperCase()})`]));
      return (value: string) => byId.get(value);
    },
    pairs: async (ids) =>
      (await prisma.pathCheckSource.findMany({
        where: { assetId: { in: ids } },
        select: { assetId: true, checkId: true },
      })).map((r) => ({ value: r.checkId, assetId: r.assetId })),
  },
};

/** Dimensions this service can populate — the wizard reads it off /schema so it
 *  knows which inputs become pickers without hardcoding the list. */
/**
 * `ifNamePattern` for a PoE FAULT condition — the one interface rule that fires
 * on unpinned ports (business rule 57's carve-out, `poeFaultCoversUnpinned`).
 * Offering the pin set there would be the picker's usual mistake in the other
 * direction: hiding the very ports the rule exists to catch, on switches where
 * nothing is pinned at all.
 *
 * Source is `AssetInterface`, not the pin array and not the sample table —
 * `poeStatus IS NOT NULL` is what "this port has a PSE behind it" means, and
 * the current-state table is the only place an unpinned port is recorded. A
 * port with no PSE is left out even when it IS pinned: a PoE condition can
 * never fire about it, which is the same contract the pin-set source keeps.
 *
 * A VARIANT, not an entry in DIMENSION_SOURCES: it is reachable only through
 * `sourceFor`, so it can't be named as a dimension by a client and can't leak
 * into `dimensionPickerMeta` as a picker the wizard would try to render.
 */
const IF_NAME_POE_FAULT_SOURCE: DimensionSource = {
  noun: "PoE-capable interfaces",
  strict: false,
  candidateWhere: { interfaces: { some: { poeStatus: { not: null } } } },
  pairs: async (ids) =>
    (await prisma.assetInterface.findMany({
      where: { assetId: { in: ids }, poeStatus: { not: null } },
      select: { assetId: true, ifName: true },
    })).map((r) => ({ value: r.ifName, assetId: r.assetId })),
};

/**
 * The value source for one (dimension, metric, comparison). Everything reads
 * its source by dimension alone except the interface list, which has to know
 * whether the condition is the PoE fault carve-out — the one comparison whose
 * readings don't come from the pin set.
 */
function sourceFor(dimension: string, metric: string, narrow: DimensionNarrow): DimensionSource | undefined {
  if (
    dimension === "ifNamePattern"
    && metric === "poeStatus"
    && narrow.stateOperator === "=="
    && poeIsFault(narrow.stateValue)
  ) {
    return IF_NAME_POE_FAULT_SOURCE;
  }
  return DIMENSION_SOURCES[dimension];
}

export function dimensionPickerMeta(): Record<string, { strict: boolean; noun: string }> {
  const out: Record<string, { strict: boolean; noun: string }> = {};
  for (const [dim, src] of Object.entries(DIMENSION_SOURCES)) {
    out[dim] = { strict: src.strict, noun: src.noun };
  }
  return out;
}

/** Fold (value, assetId) pairs into per-value device counts, most-reported
 *  first then alphabetical. `labelOf` names values that aren't self-describing
 *  (a state probe's UUID); sorting still keys on the stored value so the order
 *  is stable whether or not labels resolve. Pure — unit-tested. */
export function foldValuePairs(
  pairs: ValuePair[],
  labelOf?: (value: string) => string | undefined,
): { values: DimensionValueOption[]; assetsWithData: number } {
  const byValue = new Map<string, Set<string>>();
  const assets = new Set<string>();
  for (const p of pairs) {
    if (p.value == null || p.value === "") continue;
    assets.add(p.assetId);
    let set = byValue.get(p.value);
    if (!set) { set = new Set(); byValue.set(p.value, set); }
    set.add(p.assetId);
  }
  const values = Array.from(byValue, ([value, set]) => {
    const label = labelOf?.(value);
    return label ? { value, assetCount: set.size, label } : { value, assetCount: set.size };
  })
    .sort((a, b) => b.assetCount - a.assetCount || a.value.localeCompare(b.value))
    .slice(0, MAX_VALUES);
  return { values, assetsWithData: assets.size };
}

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3600_000);
}

/**
 * Values the draft's scoped devices have reported for one metric dimension.
 * Throws 400 when the dimension isn't one this metric takes (so a stale client
 * can't quietly get an empty list that reads as "no sensors").
 */
export async function listDimensionValues(
  metric: string,
  dimension: string,
  scope: RuleScope,
  narrow: DimensionNarrow = {},
): Promise<DimensionValuesResult> {
  // `metric` may also name an asset_state FIELD (ifOperStatus …) — the wizard's
  // filter rows and state leaves ask through the same endpoint, and the two
  // namespaces are disjoint by construction (ASSET_METRICS vs
  // ASSET_STATE_FIELDS share no name). Device-identifier dimensions are valid
  // against any asset metric/field — triggerDimensionApplicable owns the rule.
  if (!triggerDimensionApplicable(metric, dimension)) {
    throw new AppError(400, `"${dimension}" is not a dimension of metric "${metric}"`);
  }
  const source = sourceFor(dimension, metric, narrow);
  if (!source) throw new AppError(400, `No value source for dimension "${dimension}"`);

  // Monitored-only: a value only an unmonitored device reports is a filter that
  // can never produce an alert (business rule 37). candidateWhere below is an
  // optimization that only kicks in above the sample cap, so it can't be the
  // gate — this is.
  const scopedIds = await loadScopeAssetIds(scope, { monitoredOnly: true });
  // Deterministic subset so repeated opens of the picker agree with each other.
  let sorted = [...scopedIds].sort();
  const base = {
    metric,
    dimension,
    strict: source.strict,
    noun: source.noun,
    narrowLabel: source.narrowLabel?.(narrow) || "",
    scopedAssets: scopedIds.length,
  };
  if (sorted.length === 0) {
    return { ...base, values: [], sampledAssets: 0, assetsWithData: 0, windowHours: RECENT_WINDOW_HOURS };
  }

  // Narrow to the devices that can actually REPORT this dimension before the
  // interactive cap bites (see candidateWhere). Only worth a roundtrip when
  // the scope exceeds the cap — below it everything gets queried regardless.
  // When the narrowed set fits under the cap, the answer is EXHAUSTIVE over
  // every capable device, so sampledAssets reports the full scope and the
  // wizard's "Sampled X of Y" partial-list disclosure stays silent — the
  // per-noun line ("Reported by N of M devices — the rest report no …")
  // remains true as stated.
  let exhaustive = sorted.length <= ASSET_SAMPLE_CAP;
  if (!exhaustive && source.candidateWhere) {
    const rows = await prisma.asset.findMany({
      where: { AND: [{ id: { in: sorted } }, source.candidateWhere] },
      select: { id: true },
    });
    sorted = rows.map((r) => r.id).sort();
    exhaustive = sorted.length <= ASSET_SAMPLE_CAP;
  }

  // Built once per request, not per value.
  const labelOf = source.labelOf ? await source.labelOf() : undefined;

  const ids = sorted.slice(0, ASSET_SAMPLE_CAP);
  const sampledAssets = exhaustive ? scopedIds.length : ids.length;
  const recent = foldValuePairs(await source.pairs(ids, hoursAgo(RECENT_WINDOW_HOURS), narrow), labelOf);
  if (recent.values.length > 0) {
    return { ...base, ...recent, sampledAssets, windowHours: RECENT_WINDOW_HOURS };
  }

  // Nothing in the recent window: widen once before telling the operator these
  // devices have none, so a slow cadence or a paused poller doesn't read as
  // "unsupported hardware".
  const fallbackIds = ids.slice(0, FALLBACK_ASSET_CAP);
  const older = foldValuePairs(await source.pairs(fallbackIds, hoursAgo(FALLBACK_WINDOW_HOURS), narrow), labelOf);
  return {
    ...base,
    ...older,
    sampledAssets: exhaustive && ids.length <= FALLBACK_ASSET_CAP ? scopedIds.length : fallbackIds.length,
    windowHours: FALLBACK_WINDOW_HOURS,
  };
}
