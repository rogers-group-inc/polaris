/**
 * src/services/notificationTypes.ts
 *
 * Central vocabulary for the notification rules engine: the discriminated
 * `trigger` union, the asset `scope` selector, severities, clear behaviors,
 * and the operator/metric/field catalogs. Shared by the rule routes
 * (validation), the engine (evaluation), the rule service (scope match), and
 * the schema endpoint that drives the builder UI — so the vocabulary lives in
 * exactly one place and the frontend never hardcodes it.
 */

import { z } from "zod";
import { isValidCidr, isValidIpAddress, ipInCidr } from "../utils/cidr.js";
import { compileWildcard } from "../utils/wildcard.js";
import { TEMPLATE_VARIABLES } from "../utils/notificationTemplate.js";
import { defaultAlertEmailTemplate } from "../utils/alertEmailTemplate.js";
import { SENSOR_CLASS_UNITS } from "../utils/hardwareSensors.js";
import { POE_STATUS_VALUES } from "../utils/poePorts.js";
import {
  quietConfigSchema,
  describeQuietTime,
  MAX_QUIET_WINDOWS,
  type QuietConfig,
} from "../utils/quietTime.js";
// The wizard picks quiet windows in the SERVER's wall clock and has no
// business asking the maintenance router for the time — that route is gated on
// maintenanceManagement:read, which an automation author needn't hold.
import { serverClockInfo } from "../utils/maintenanceRecurrence.js";

// Notification severity (rule.severity → notification.severity). Ordered
// least → most severe. NOTE: distinct from EVENT_LEVELS below — that's the
// audit-Event level vocabulary the `event` trigger's minLevel filters against.
export const SEVERITIES = ["notice", "informational", "warning", "serious", "critical"] as const;
// Audit-Event levels (logEvent), used only by the event-trigger minLevel filter.
export const EVENT_LEVELS = ["info", "warning", "error"] as const;
export const CLEAR_BEHAVIORS = ["manual", "auto", "timed"] as const;
export const COMPARATORS = [">", ">=", "<", "<=", "==", "!="] as const;
export const AGGREGATIONS = ["latest", "avg", "median", "min", "max"] as const;

export type Severity = (typeof SEVERITIES)[number];
export type Comparator = (typeof COMPARATORS)[number];

/** Rank of a severity (higher = more severe); -1 for an unknown string. */
export function severityRank(s: string): number {
  return (SEVERITIES as readonly string[]).indexOf(s);
}

// ─── Severity bands (value-driven severity escalation) ──────────────────────
// One automation can escalate severity by value: a base trigger threshold +
// severity (tier 0) plus higher tiers ("bands"). severityForValue walks the
// effective tiers [tier0, ...bands] and returns the MOST-severe tier a value
// satisfies (or null when it satisfies none — below tier 0 = not firing). Bands
// live at the rule level alongside actions/reset/escalation; each also carries
// its own actions + escalation (see severityBandSchema).

/** The value/severity part of a band tier that severityForValue reads. A full
 *  band (severityBandSchema) additionally carries actions + escalation. */
export interface SeverityTier {
  threshold: number;
  severity: Severity;
  /** Per-tier comparison operator (falls back to the base trigger's). */
  operator?: Comparator;
  /**
   * Per-tier sustained duration (falls back to the base trigger's
   * forDurationSec). See resolveTierLadder / sustainedSeverity. The BUILDER no
   * longer writes one — every tier shares the trigger's hold (business rule 19)
   * — but an API-authored band may still carry it, and a band that does keeps
   * the wall-clock path even when the trigger counts readings: a per-tier count
   * would need a per-tier run map on the state row for a shape the wizard
   * cannot produce.
   */
  forDurationSec?: number;
}

/**
 * THE six-way numeric comparator for automation thresholds. Exported so the
 * engine's trigger evaluation uses the SAME function as band evaluation
 * here — the two carried byte-identical private copies until the 2026-08
 * audit, and threshold semantics must never diverge between them.
 */
export function numMeets(value: number, operator: Comparator | string, threshold: number): boolean {
  switch (operator) {
    case ">": return value > threshold;
    case ">=": return value >= threshold;
    case "<": return value < threshold;
    case "<=": return value <= threshold;
    case "==": return value === threshold;
    case "!=": return value !== threshold;
    default: return false;
  }
}

/**
 * The severity a numeric value lands in. Effective tiers are the base
 * `{baseThreshold, baseSeverity}` plus `bands`; returns the most-severe tier the
 * value satisfies under `operator`, or null when it satisfies none. A no-band
 * trigger returns `baseSeverity` (when met) or null — identical to the pre-band
 * fire/clear decision.
 */
export function severityForValue(
  operator: Comparator,
  baseThreshold: number,
  baseSeverity: Severity,
  bands: SeverityTier[] | null | undefined,
  value: number | null | undefined,
): Severity | null {
  if (value == null || Number.isNaN(value)) return null;
  const tiers: SeverityTier[] = [{ threshold: baseThreshold, severity: baseSeverity }, ...(bands ?? [])];
  let best: Severity | null = null;
  let bestRank = -1;
  for (const tier of tiers) {
    const r = severityRank(tier.severity);
    // Tiers share the base sampling (aggregation/window/dimensionFilter) but may
    // carry their own comparison operator; fall back to the base operator.
    if (r > bestRank && numMeets(value, tier.operator ?? operator, tier.threshold)) {
      best = tier.severity;
      bestRank = r;
    }
  }
  return best;
}

// ─── Per-tier sustained durations ───────────────────────────────────────────
// "Sustained for" is per TIER, not per rule: warning may need 30 minutes while
// critical pages after 5. One shared conditionMetSince can't express that (a
// value that climbs from warning into critical has been critical for seconds
// but above the base threshold for half an hour), so the engine keeps a per-tier
// "continuously satisfied since" map on the state row and resolves the alert's
// severity from it. The three functions below are the whole decision, kept pure
// here beside severityForValue so the engine and the tests share them.

/** A tier with its comparison + sustain resolved (no inheritance left). */
export interface ResolvedTier {
  threshold: number;
  severity: Severity;
  operator: Comparator;
  forDurationSec: number;
  /** The hold as READINGS, inherited from the trigger. When set it is the
   *  authority and `forDurationSec` is only its mirror (see FOR_POLLS_NOTE);
   *  absent on a tier carrying its own wall-clock duration. */
  forPolls?: number;
}

/**
 * The effective tier ladder `[base, ...bands]` with each tier's operator and
 * sustained duration resolved. A band inherits the base trigger's operator /
 * `forDurationSec` when it carries none — which is exactly how rules authored
 * before per-band sustain existed keep behaving.
 */
export function resolveTierLadder(
  operator: Comparator,
  baseThreshold: number,
  baseSeverity: Severity,
  baseForDurationSec: number,
  bands: SeverityTier[] | null | undefined,
  baseForPolls?: number | null,
): ResolvedTier[] {
  const polls = typeof baseForPolls === "number" && baseForPolls > 0 ? Math.round(baseForPolls) : undefined;
  const base: ResolvedTier = { threshold: baseThreshold, severity: baseSeverity, operator, forDurationSec: Math.max(0, baseForDurationSec || 0), forPolls: polls };
  const rest = (bands ?? []).map((b) => ({
    threshold: b.threshold,
    severity: b.severity,
    operator: b.operator ?? operator,
    forDurationSec: Math.max(0, b.forDurationSec ?? baseForDurationSec ?? 0),
    // A band with a hold of its OWN is a wall-clock band: it stated seconds, so
    // it is measured in seconds. One that inherits inherits both spellings.
    forPolls: b.forDurationSec == null ? polls : undefined,
  }));
  return [base, ...rest];
}

/**
 * Roll the per-tier met-since map forward for one reading. A tier the value
 * satisfies KEEPS its existing timestamp (the run continues) or starts one at
 * `nowMs`; a tier it no longer satisfies drops out, so its next entry restarts
 * the clock. Severities are unique across the ladder (validateSeverityBands
 * enforces strictly-increasing tiers), so severity is a safe key.
 */
export function updateTierMetSince(
  prev: Record<string, number> | null | undefined,
  tiers: ResolvedTier[],
  value: number | null | undefined,
  nowMs: number,
): Record<string, number> {
  const next: Record<string, number> = {};
  if (value == null || Number.isNaN(value)) return next;
  for (const tier of tiers) {
    if (!numMeets(value, tier.operator, tier.threshold)) continue;
    const since = prev?.[tier.severity];
    // A stored timestamp in the future (clock step) restarts rather than
    // locking the tier out forever.
    next[tier.severity] = typeof since === "number" && Number.isFinite(since) && since <= nowMs ? since : nowMs;
  }
  return next;
}

/**
 * The severity the alert should be at: the MOST-SEVERE tier whose own run has
 * lasted at least its own `forDurationSec`. Null = nothing has sustained yet
 * (the alert stays pending, or an already-firing alert holds its severity).
 */
export function sustainedSeverity(
  metSince: Record<string, number> | null | undefined,
  tiers: ResolvedTier[],
  nowMs: number,
): Severity | null {
  let best: Severity | null = null;
  let bestRank = -1;
  for (const tier of tiers) {
    const since = metSince?.[tier.severity];
    if (typeof since !== "number" || !Number.isFinite(since)) continue;
    if (nowMs - since < tier.forDurationSec * 1000) continue;
    const rank = severityRank(tier.severity);
    if (rank > bestRank) {
      best = tier.severity;
      bestRank = rank;
    }
  }
  return best;
}

// ─── Poll-counted holds ─────────────────────────────────────────────────────
// The reading-counting counterpart of the met-since machinery above. A hold
// written as `forPolls` is satisfied by N consecutive qualifying READINGS, not
// by N × cadence seconds of engine ticks — see FOR_POLLS_NOTE for why that
// distinction is the whole point.
//
// Two shapes reach the engine, because two shapes of source exist:
//  - a SERIES source (every sample table, and the Polaris host's own metrics)
//    hands over its recent readings newest-first, and the run is computed from
//    them here — stateless, so it is exact whatever the engine's tick spacing
//    is, and a device that stopped reporting simply has no readings to count.
//  - a CURRENT-STATE source (the Asset columns, the SD-WAN rule table, and the
//    windowed-ratio metrics that are recomputed per tick) has no series at all,
//    so the engine counts observations on the state row instead, advancing only
//    when that stream's own poll anchor moved. `advanceRun` is that rule.

/**
 * How many of the leading (newest-first) readings satisfy `meets`. Stops at the
 * first one that doesn't — a run is CONSECUTIVE by definition, so one reading
 * back under the line resets it to zero however long the run before it was.
 */
export function leadingRun<T>(readings: readonly T[], meets: (v: T) => boolean): number {
  let n = 0;
  for (const r of readings) {
    if (!meets(r)) break;
    n += 1;
  }
  return n;
}

/**
 * One step of a current-state source's run counter. `readingAt` is the poll
 * anchor for this reading; `lastAt` is the anchor that last advanced it.
 *
 * Three properties, all load-bearing:
 *  - **A repeat is not a reading.** An anchor that hasn't moved means the
 *    engine is looking at the same poll again (its 60s tick against a 5-minute
 *    cadence), so the run is returned unchanged and the caller writes nothing.
 *  - **An unknown anchor counts once.** A source with no anchor at all (null)
 *    still has to make progress, or its hold could never be satisfied.
 *  - **A qualifying reading extends, a non-qualifying one zeroes.** There is no
 *    decay: this is a consecutive run, not the leaky bucket the probe loop
 *    keeps for down detection (business rule 30), which is counting something
 *    else — misses outstanding, not a condition holding.
 */
export function advanceRun(
  run: number,
  meets: boolean,
  readingAt: Date | null | undefined,
  lastAt: Date | null | undefined,
): { run: number; advanced: boolean } {
  const cur = Number.isFinite(run) && run > 0 ? Math.round(run) : 0;
  if (readingAt && lastAt && readingAt.getTime() <= lastAt.getTime()) return { run: cur, advanced: false };
  return { run: meets ? cur + 1 : 0, advanced: true };
}

/**
 * The severity the alert should be at when the ladder counts READINGS: the
 * most-severe tier whose OWN run has reached its OWN `forPolls`. `runs` is per
 * severity, computed by the caller from the series (each tier tests its own
 * threshold, so a value climbing into critical starts critical's run at 1 while
 * warning's keeps climbing).
 *
 * A tier carrying no `forPolls` is skipped — it is a wall-clock tier and
 * `sustainedSeverity` owns it. A tier whose count is 0 fires on its first
 * qualifying reading, matching a 0-second hold.
 */
export function sustainedSeverityByRun(
  runs: Record<string, number> | null | undefined,
  tiers: ResolvedTier[],
): Severity | null {
  let best: Severity | null = null;
  let bestRank = -1;
  for (const tier of tiers) {
    if (tier.forPolls == null) continue;
    const run = runs?.[tier.severity] ?? 0;
    if (run < Math.max(1, tier.forPolls)) continue;
    const rank = severityRank(tier.severity);
    if (rank > bestRank) {
      best = tier.severity;
      bestRank = rank;
    }
  }
  return best;
}

/** The hold this trigger states as a COUNT, or 0 when it states one in seconds
 *  (or none at all). The one place the "count wins where present" rule lives. */
export function triggerHoldPolls(trigger: { forPolls?: number | null } | null | undefined): number {
  const n = trigger?.forPolls;
  return typeof n === "number" && n > 0 ? Math.round(n) : 0;
}

/** The reset's clear-sustain as a COUNT, same contract. */
export function resetSustainPolls(reset: { sustainPolls?: number | null } | null | undefined): number {
  const n = reset?.sustainPolls;
  return typeof n === "number" && n > 0 ? Math.round(n) : 0;
}

/** Whether two met-since maps differ — the engine only writes the state row
 *  when they do, keeping the hot path transition-write-only. */
export function tierMetSinceChanged(
  a: Record<string, number> | null | undefined,
  b: Record<string, number> | null | undefined,
): boolean {
  const ak = Object.keys(a ?? {});
  const bk = Object.keys(b ?? {});
  if (ak.length !== bk.length) return true;
  return ak.some((k) => (a as Record<string, number>)[k] !== (b ?? {})[k]);
}

// ─── Asset-metric trigger ───────────────────────────────────────────────────
// Numeric thresholds over the telemetry / sample tables. `dimensionFilter`
// narrows multi-row streams (interfaces, sensors, mounts, SD-WAN members).
export const ASSET_METRICS = [
  "cpuPct", "memPct", "memUsedBytes", "sessionCount", "responseTimeMs", "uptimeSec", "probeLossPct",
  "hwSensorValue", "hwSensorAlarm", "storageUsedPct", "storageUsedBytes", "storageDaysUntilFull",
  "ifInErrorRate", "ifOutErrorRate", "ifInBps", "ifOutBps",
  "sdwanLatencyMs", "sdwanJitterMs", "sdwanPacketLoss", "ipsecThroughputBps",
  "customWidgetValue", "customStateValue",
] as const;

/**
 * Metrics whose readings are BOOLEAN (0/1) rather than a magnitude — see
 * AssetStateSample / utils/stateProbes. They live in ASSET_METRICS because the
 * engine's whole threshold/debounce/reset machine already does exactly the right
 * thing on a 0/1 value compared with "==", and duplicating that as a third
 * trigger type would mean a second copy of hysteresis, sustained-duration and
 * per-dimension state.
 *
 * What they must NOT get is the numeric surfaces: severity bands (a strictly
 * increasing threshold ladder over two possible values is meaningless), the
 * chart's threshold shading, and the value/unit hints. Everything that offers
 * those checks this set rather than testing metric names inline.
 */
export const BOOLEAN_METRICS = ["customStateValue", "hwSensorAlarm"] as const;

export function isBooleanMetric(metric: string | null | undefined): boolean {
  return !!metric && (BOOLEAN_METRICS as readonly string[]).includes(metric);
}

/**
 * Operator-facing names for a boolean metric's two states, so the builder can
 * render "is Alarm" instead of "== 1" and the sentence reads in the device's own
 * terms. `customStateValue` is absent on purpose: its labels are per-probe and
 * come from the probe registry (`/schema.stateProbes`), which is strictly better
 * information than a metric-wide default. `trueIsProblem` picks the value the
 * builder pre-selects.
 */
export const BOOLEAN_METRIC_LABELS: Record<string, { trueLabel: string; falseLabel: string; trueIsProblem: boolean }> = {
  hwSensorAlarm: { trueLabel: "Alarm", falseLabel: "OK", trueIsProblem: true },
};

// ─── Asset-state trigger ────────────────────────────────────────────────────
// Current Asset (or current-state child row) field conditions.
export const ASSET_STATE_FIELDS = [
  "monitorStatus", "status", "consecutiveFailures", "dependencySuppressed", "quarantined",
  "ifOperStatus", "ifAdminStatus", "ifIpAddress", "poeStatus", "ipsecStatus", "sdwanRuleStatus", "sdwanSelectedMember",
] as const;

// ─── Host-metric trigger ────────────────────────────────────────────────────
// Polaris host health from HostMetricsSample.
export const HOST_METRICS = [
  "cpuPct", "memUsedPct", "memUsedBytes", "loadAvg1", "loadAvg5", "loadAvg15", "procRssBytes",
] as const;

// ─── Change trigger ─────────────────────────────────────────────────────────
// Sugar over emitted change-Events from the persist* functions.
export const CHANGE_TYPES = [
  "lldp_neighbor_added", "lldp_neighbor_removed",
  "process_started", "process_stopped",
  "sdwan_failover", "mclag_peer_lost", "wireless_station_connected",
  "firmware_changed", "switch_port_changed", "wireless_ap_changed", "gateway_firewall_changed",
] as const;

// Map a change type → the audit Event action the persist functions emit and
// the event path matches on. Single source of truth for both ends.
//
// Two families here, and the difference matters when adding one. The `change.*`
// rows are emitted through maybeEmitChangeEvents, which writes NOTHING unless a
// rule subscribes (isChangeActionSubscribed) — they'd flood otherwise. The
// `asset.*.changed` rows are written UNCONDITIONALLY by their write sites
// (eventLogService's build*ChangedEvent builders): they're edge-triggered and
// rare, and the operator wants them in the audit log whether or not an
// automation watches. Their entry here only gives the wizard a picker over an
// event that's always present.
export const CHANGE_TYPE_ACTIONS: Record<(typeof CHANGE_TYPES)[number], string> = {
  lldp_neighbor_added: "change.lldp.neighbor_added",
  lldp_neighbor_removed: "change.lldp.neighbor_removed",
  process_started: "change.process.started",
  process_stopped: "change.process.stopped",
  sdwan_failover: "change.sdwan.failover",
  mclag_peer_lost: "change.mclag.peer_lost",
  wireless_station_connected: "change.wireless.station_connected",
  firmware_changed: "asset.firmware.changed",
  switch_port_changed: "asset.switch_port.changed",
  wireless_ap_changed: "asset.wireless_ap.changed",
  gateway_firewall_changed: "asset.gateway_firewall.changed",
};

const dimensionFilterSchema = z
  .object({
    ifNamePattern: z.string().max(200).optional(),
    // ── Device-identifier dimensions (DEVICE_FILTER_DIMENSIONS below) ──────
    // The asset's own identity — hostname / IP / MAC / manufacturer / model —
    // available on EVERY asset metric and asset-state field. They narrow the
    // ASSET SET (the engine's applyDeviceFilters), which is what lets one
    // composite tree mix device-specific branches ("interface down on CORE-SW
    // OR storage full on BACKUP-01"); a single-condition automation can say
    // the same thing with rules on the Devices step, and the engine treats
    // the two identically. The wizard authors these as "+ Condition" FILTER
    // ROWS (compiled into sibling conditions' dimensionFilter at save), never
    // as inline inputs. All ride triggerSignature like every other dimension,
    // so two automations on the same metric with different device filters
    // never carve each other out. hostname/manufacturer/model are plain
    // substring; IP and MAC have their own matchers (ipDimensionMatch /
    // macDimensionMatch — CIDR/prefix-aware and separator-insensitive
    // respectively, because substring over those value shapes lies).
    hostnamePattern: z.string().max(200).optional(),
    ipPattern: z.string().max(200).optional(),
    macPattern: z.string().max(200).optional(),
    manufacturerPattern: z.string().max(200).optional(),
    modelPattern: z.string().max(200).optional(),
    // Closed enum — must stay in lockstep with HardwareSensorClass in
    // src/utils/hardwareSensors.ts. A class missing here is unselectable in the
    // wizard even once samples carry it, which is what makes "alert on optics"
    // impossible to author.
    sensorClass: z.enum(["temperature", "fan", "voltage", "current", "optical", "poe", "power", "disk", "other"]).optional(),
    // One NAMED sensor rather than a whole class: a firewall reports a dozen
    // temperature sensors ("CPU ON-DIE Temperature", "TMP1 External
    // Temperature", per-PHY dies), and an operator alerting on the CPU die does
    // not want the PHYs alerting too. Substring-matched like the other
    // *Pattern dimensions, and ANDs with sensorClass when both are set.
    sensorNamePattern: z.string().max(200).optional(),
    mountPathPattern: z.string().max(200).optional(),
    // Which SD-WAN service RULE (sdwanRuleStatus / sdwanSelectedMember alert
    // per ruleName dimension; this narrows to the named rule[s]). Substring-
    // matched like every other *Pattern dimension.
    sdwanRulePattern: z.string().max(200).optional(),
    healthCheck: z.string().max(200).optional(),
    link: z.string().max(200).optional(),
    tunnelName: z.string().max(200).optional(),
    widgetId: z.string().max(200).optional(),
    processNamePattern: z.string().max(200).optional(),
    // ── State probes (customStateValue) ──────────────────────────────────
    // Which probe (a ManufacturerCustomWidget id — an exact match, since it's a
    // registry key rather than a device-reported string) and which of its rows.
    stateProbeId: z.string().max(200).optional(),
    // Substring-matched against the row's resolved LABEL, like every other
    // *Pattern dimension: blank = every row the probe reports, each alerting on
    // its own. Matching on the label rather than the OID index is the point of
    // resolving labels at all — an operator knows "PSU 2", not ".14".
    stateRowPattern: z.string().max(200).optional(),
  })
  .strict()
  .optional();

/**
 * THE HOLD IS A COUNT OF READINGS, and `forDurationSec` is its mirror.
 *
 * A threshold can only be tested when a reading arrives, so "sustained for 3"
 * has always meant three readings — and expressing it in seconds made it a
 * different number of readings on a device polled every 5 minutes than on one
 * polled every 30 seconds. Worse, the engine measured those seconds on ITS OWN
 * 60-second tick against the newest sample, so a device that stopped reporting
 * mid-spike had its last over-threshold sample re-presented every tick and the
 * hold "elapsed" on ONE reading.
 *
 * `forPolls` is therefore the authority wherever it is set: the engine counts
 * consecutive qualifying READINGS and fires on the Nth. `forDurationSec` stays
 * written as the lossless wall-clock mirror (polls × the scope's cadence at
 * authoring time) — it is what the sentences, the alert email and every
 * pre-cutover rule read, and it is what sizes the sample window the engine has
 * to fetch to see N readings. A rule carrying only seconds keeps the old
 * time-based behaviour exactly; nothing is migrated.
 *
 * Capped at 100 like `missedPolls` (business rule 36), the other count that IS
 * the definition of a condition rather than a filter on one.
 */
const FOR_POLLS_FIELD = z.number().int().min(0).max(100).optional();

const assetMetricTrigger = z.object({
  type: z.literal("asset_metric"),
  metric: z.enum(ASSET_METRICS),
  aggregation: z.enum(AGGREGATIONS).default("latest"),
  windowSec: z.number().int().min(0).max(86400).default(0),
  operator: z.enum(COMPARATORS),
  threshold: z.number(),
  forDurationSec: z.number().int().min(0).max(86400).default(0),
  /** The hold as a COUNT OF READINGS — see FOR_POLLS_NOTE. */
  forPolls: FOR_POLLS_FIELD,
  dimensionFilter: dimensionFilterSchema,
  /**
   * SATURATION CEILING: a reading at or above this produces no reading at all,
   * and clears any alert this rule already had on that asset.
   *
   * Offered for the windowed-ratio metrics (packet loss), where the top of the
   * scale stops describing the thing the metric is named after. 100% loss is an
   * outage, which the down automation already owns; and since the loss anchor
   * was removed (business rule 29) a device coming back from a 55-minute outage
   * genuinely reads ~92% for the rest of the window, so an operator who does not
   * want an alert trailing every outage sets this to 90.
   *
   * Defaults to 100 when absent, which suppresses only a total outage and
   * leaves every pre-existing rule behaving as it always has.
   */
  ignoreAtOrAbove: z.number().min(0).max(100).optional(),
});

const assetStateTrigger = z.object({
  type: z.literal("asset_state"),
  field: z.enum(ASSET_STATE_FIELDS),
  operator: z.enum(COMPARATORS),
  // string for enum-like fields (monitorStatus), number for counters, bool for flags
  value: z.union([z.string().max(200), z.number(), z.boolean()]),
  forDurationSec: z.number().int().min(0).max(86400).default(0),
  /** The hold as a COUNT OF READINGS — see FOR_POLLS_NOTE. */
  forPolls: FOR_POLLS_FIELD,
  dimensionFilter: dimensionFilterSchema,
  /**
   * DOWN-DETECTION AUTHORITY — valid only on `monitorStatus == down`, where it
   * is not a filter on the reading but the DEFINITION of it: the number of
   * consecutive missed polls after which recordProbeResult flips this
   * automation's devices to "down". An asset covered by no down-detection
   * automation is never judged and reads "passive".
   *
   * Optional in the schema, required by the wizard. Optional because a
   * pre-upgrade client's POST must not 400, and because the pre-cutover
   * baseline "Asset down" row carries none — such a rule still governs its
   * devices, at DEFAULT_MISSED_POLLS.
   */
  missedPolls: z.number().int().min(1).max(100).optional(),
});

const hostMetricTrigger = z.object({
  type: z.literal("host_metric"),
  metric: z.enum(HOST_METRICS),
  aggregation: z.enum(AGGREGATIONS).default("latest"),
  windowSec: z.number().int().min(0).max(86400).default(0),
  operator: z.enum(COMPARATORS),
  threshold: z.number(),
  forDurationSec: z.number().int().min(0).max(86400).default(0),
  /** The hold as a COUNT OF READINGS — see FOR_POLLS_NOTE. The Polaris host
   *  samples itself every 30s (hostMetricsCollector), so a poll here is 30s. */
  forPolls: FOR_POLLS_FIELD,
});

const eventTrigger = z.object({
  type: z.literal("event"),
  actionPattern: z.string().min(1).max(200), // glob, e.g. "integration.test.*"
  resourceType: z.string().max(100).optional(),
  minLevel: z.enum(EVENT_LEVELS).optional(),
  detailsMatch: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const changeTrigger = z.object({
  type: z.literal("change"),
  changeType: z.enum(CHANGE_TYPES),
  dimensionFilter: dimensionFilterSchema,
});

// ─── Composite trigger (nested AND/OR over metric/state leaves) ─────────────
// The wizard's multi-condition trigger: a tree of the threshold-ish leaf
// conditions above (event/change have no continuous reading to compose).
// Evaluated PER ASSET — a multi-dimension leaf (sensors, mounts, interfaces)
// counts as met when ANY of its dimensions meets, and the whole rule fires one
// alert per asset (dimensionKey "") instead of per dimension. Only and/or are
// allowed at group level: negation combinators would fire on missing data and
// on every healthy asset; single-condition negation is already expressible via
// the inverse comparator.
//
// Invariant (enforced by collapseCompositeTrigger in the input transforms):
// a stored composite always has ≥2 leaves — a single-leaf composite collapses
// to the legacy single trigger, keeping per-dimension alerting + hysteresis
// for the common case regardless of which client authored the rule.

export const TRIGGER_GROUP_OPS = ["and", "or"] as const;
export type TriggerGroupOp = (typeof TRIGGER_GROUP_OPS)[number];

// Leaves are the existing threshold conditions minus the hold in BOTH its
// spellings (the sustain applies to the whole composite, not per leaf) — a leaf
// that kept `forPolls` would be a second hold the tree's own count already owns.
const compositeAssetMetricLeaf = assetMetricTrigger.omit({ forDurationSec: true, forPolls: true });
const compositeAssetStateLeaf = assetStateTrigger.omit({ forDurationSec: true, forPolls: true });
const compositeHostMetricLeaf = hostMetricTrigger.omit({ forDurationSec: true, forPolls: true });
export const compositeLeafSchema = z.discriminatedUnion("type", [
  compositeAssetMetricLeaf,
  compositeAssetStateLeaf,
  compositeHostMetricLeaf,
]);
export type CompositeLeaf = z.infer<typeof compositeLeafSchema>;

export interface TriggerConditionGroup {
  op: TriggerGroupOp;
  children: (TriggerConditionGroup | CompositeLeaf)[];
}

/** A tree node is a leaf iff it carries the discriminator (groups are strict
 *  {op, children} objects and never have `type`). */
export function isTriggerLeaf(node: TriggerConditionGroup | CompositeLeaf): node is CompositeLeaf {
  return "type" in node;
}

export const triggerConditionGroupSchema: z.ZodType<TriggerConditionGroup> = z.lazy(() =>
  z
    .object({
      op: z.enum(TRIGGER_GROUP_OPS),
      children: z.array(z.union([compositeLeafSchema, triggerConditionGroupSchema])).min(1).max(10),
    })
    .strict(),
) as z.ZodType<TriggerConditionGroup>;

// Plain ZodObject (no superRefine — discriminated-union members must be), so
// the depth/leaf/kind caps live in validateCompositeTrigger, called from
// validateRuleV2 on both the save and preview paths.
const compositeTrigger = z.object({
  type: z.literal("composite"),
  // asset = asset_metric/asset_state leaves (scope-selected devices);
  // host = host_metric leaves (the Polaris host). Never mixed.
  kind: z.enum(["asset", "host"]),
  op: z.enum(TRIGGER_GROUP_OPS),
  children: z.array(z.union([compositeLeafSchema, triggerConditionGroupSchema])).min(1).max(10),
  forDurationSec: z.number().int().min(0).max(86400).default(0),
  /** The hold as a COUNT OF READINGS — see FOR_POLLS_NOTE. One hold over the
   *  whole tree, counted on the leaves' own readings. */
  forPolls: FOR_POLLS_FIELD,
});

export const triggerSchema = z.discriminatedUnion("type", [
  assetMetricTrigger,
  assetStateTrigger,
  hostMetricTrigger,
  eventTrigger,
  changeTrigger,
  compositeTrigger,
]);
export type CompositeTrigger = z.infer<typeof compositeTrigger>;

/** Depth (root group = 1) + leaf count for a composite trigger tree. */
export function triggerConditionStats(node: { op: TriggerGroupOp; children: (TriggerConditionGroup | CompositeLeaf)[] }): {
  depth: number;
  leaves: number;
} {
  let leaves = 0;
  const depthOf = (g: { children: (TriggerConditionGroup | CompositeLeaf)[] }): number =>
    1 + Math.max(0, ...g.children.map((c) => {
      if (isTriggerLeaf(c)) { leaves++; return 0; }
      return depthOf(c);
    }));
  const depth = depthOf(node);
  return { depth, leaves };
}

/**
 * Canonicalize a composite trigger: unwrap single-child group wrappers, and
 * collapse a single-leaf tree to the legacy single trigger with forDurationSec
 * hoisted onto it. Applied in the input transforms so the "≥2 leaves ⇒
 * composite, 1 leaf ⇒ per-dimension legacy" invariant holds for every author
 * (wizard or raw API).
 */
export function collapseCompositeTrigger(trigger: Trigger): Trigger {
  if (trigger.type !== "composite") return trigger;
  let op = trigger.op;
  let children = trigger.children;
  while (children.length === 1 && !isTriggerLeaf(children[0])) {
    const g = children[0] as TriggerConditionGroup;
    op = g.op;
    children = g.children;
  }
  if (children.length === 1 && isTriggerLeaf(children[0])) {
    // The count rides down with its mirror — a collapsed single-leaf trigger
    // that kept only the seconds would silently fall back to the time path.
    return { ...(children[0] as CompositeLeaf), forDurationSec: trigger.forDurationSec, forPolls: trigger.forPolls } as Trigger;
  }
  return { ...trigger, op, children };
}

const COMPOSITE_MAX_DEPTH = 3;
const COMPOSITE_MAX_LEAVES = 10;

/** Structural caps + kind coherence for a composite trigger (save + preview). */
export function validateCompositeTrigger(trigger: CompositeTrigger, ctx: z.RefinementCtx): void {
  const stats = triggerConditionStats(trigger);
  if (stats.depth > COMPOSITE_MAX_DEPTH) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trigger"], message: `condition groups nest at most ${COMPOSITE_MAX_DEPTH} deep` });
  }
  if (stats.leaves > COMPOSITE_MAX_LEAVES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trigger"], message: `at most ${COMPOSITE_MAX_LEAVES} conditions per trigger` });
  }
  if (stats.leaves < 2) {
    // collapseCompositeTrigger should have folded this to a single trigger; a
    // composite reaching validation with <2 leaves means a raw caller bypassed
    // the transform — reject rather than store a degenerate tree.
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trigger"], message: "a composite trigger needs at least 2 conditions" });
  }
  const badLeaf = collectTriggerLeaves(trigger).find((l) =>
    trigger.kind === "host" ? l.type !== "host_metric" : l.type === "host_metric",
  );
  if (badLeaf) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["trigger"],
      message:
        trigger.kind === "host"
          ? "host composite triggers may only contain Polaris-host metric conditions"
          : "device composite triggers may not contain Polaris-host metric conditions",
    });
  }
}

/** Flatten a composite tree's leaves in document order. */
export function collectTriggerLeaves(node: { children: (TriggerConditionGroup | CompositeLeaf)[] }): CompositeLeaf[] {
  const out: CompositeLeaf[] = [];
  for (const c of node.children) {
    if (isTriggerLeaf(c)) out.push(c);
    else out.push(...collectTriggerLeaves(c));
  }
  return out;
}

// ─── Scope condition tree (nested AND/OR device filtering) ──────────────────
// `scope.condition` is a nested group of per-field rules — the wizard's
// SolarWinds-style builder. Group combinators:
//   and    = all children must be satisfied
//   or     = at least one child must be satisfied
//   none   = all children must NOT be satisfied      (¬or)
//   notAll = at least one child must NOT be satisfied (¬and)
// Rules are (field, operator, value) over asset identity columns; evaluation
// is the pure `evaluateScopeCondition` below — used by the in-memory matcher
// AND the engine's post-SQL filter, so the semantics can't drift.

export const SCOPE_GROUP_OPS = ["and", "or", "none", "notAll"] as const;
export type ScopeGroupOp = (typeof SCOPE_GROUP_OPS)[number];

const STRING_OPS = ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"] as const;
export const SCOPE_FIELD_OPS: Record<string, readonly string[]> = {
  assetType: ["equals", "notEquals"],
  manufacturer: STRING_OPS,
  model: STRING_OPS,
  hostname: STRING_OPS,
  os: STRING_OPS,
  tag: ["has", "notHas"],
  subnet: ["inCidr", "notInCidr"],
  // "Device interface" — matched against the device's CURRENT-STATE interface
  // inventory (AssetInterface.ifName), so a rule pairs naturally with a device
  // type ("switches that have a fortilink port"). Multi-valued like
  // `fortigate`: a positive operator is satisfied by ANY interface, a negative
  // one has to hold for every one of them.
  //
  // Deliberately NOT restricted to PINNED interfaces the way every interface
  // TRIGGER is: a trigger reads a metric, which only exists for a pinned
  // interface, whereas this asks what the device HAS. Note the consequence —
  // a device whose interface stream is never collected reports no interfaces
  // at all, so a positive rule never selects it.
  interfaceName: STRING_OPS,
  // "Broadcast SSID" — matched against the SSIDs the device is currently
  // broadcasting (AssetApVap.ssid), so it selects ACCESS POINTS: "every AP
  // carrying GUEST". The second relation-backed field, and it follows
  // interfaceName exactly — multi-valued (a positive operator is satisfied
  // by ANY SSID, a negative one must hold for every one), resolved in SQL by
  // scopeRelationIndex at fleet scale and by the joined relation on the
  // single-asset paths. Same consequence, too: an AP whose radios have not
  // been discovered reports no SSIDs, so a positive rule never selects it.
  ssid: STRING_OPS,
  status: ["equals", "notEquals"],
  assetId: ["equals", "notEquals"],
};
export const SCOPE_FIELDS = Object.keys(SCOPE_FIELD_OPS);

/**
 * Shell-style wildcard comparison ("PLV*-61F-?"), compiled by the shared
 * utils/wildcard.ts. Offered only in the DEVICE_FILTER vocabulary below: the
 * flat tag-criteria builder has always had it, so without it a stored contact
 * filter couldn't fold forward into a tree without losing a rule.
 */
const WILDCARD_OP = "matches";

/** String ops plus the wildcard — the device-filter flavour of STRING_OPS. */
const STRING_OPS_WITH_WILDCARD = [...STRING_OPS, WILDCARD_OP] as const;

/**
 * The DEVICE-FILTER vocabulary: a strict SUPERSET of the automations scope
 * fields, used by the address book's "devices this contact is responsible for".
 *
 * Contacts share the automations tree — the same builder, the same evaluator,
 * the same stored shape — but they came from the flat `TagCriteria` builder,
 * which carried four fields and a wildcard operator the automations scope never
 * had. Dropping them in the swap would be a regression in exactly the dimension
 * device OWNERSHIP cares about ("whoever looks after the Ashfield switches"),
 * so the vocabulary widens rather than the feature narrowing.
 *
 * Why a second map instead of widening SCOPE_FIELD_OPS: `fortigate` reads the
 * sighting relation, and the notification engine's scope filter runs over the
 * whole fleet on every tick — putting that join on the hot path would cost far
 * more than the field is worth there. The three plain columns are withheld from
 * automations for the same reason the map exists at all: one surface asked for
 * them. `matchScopeRule` evaluates the superset, so a caller that validates
 * against SCOPE_FIELD_OPS simply can't produce the extra fields.
 */
export const DEVICE_FILTER_FIELD_OPS: Record<string, readonly string[]> = {
  ...Object.fromEntries(
    Object.entries(SCOPE_FIELD_OPS).map(([field, ops]) => [
      field,
      // Only the free-string fields take a wildcard; assetType / status / tag /
      // subnet are closed or CIDR-shaped, and the flat builder never offered a
      // pattern there either.
      ops.includes("contains") ? STRING_OPS_WITH_WILDCARD : ops,
    ]),
  ),
  osVersion: STRING_OPS_WITH_WILDCARD,
  department: STRING_OPS_WITH_WILDCARD,
  location: STRING_OPS_WITH_WILDCARD,
  // "Behind FortiGate" — matched against Asset.learnedLocation OR any
  // AssetFortigateSighting device name, so `contains` on a site prefix covers
  // every gate at the site. Mirrors the tagAssignmentService rule of the same
  // name; a negative operator means NONE of those names satisfy it.
  fortigate: STRING_OPS_WITH_WILDCARD,
};
export const DEVICE_FILTER_FIELDS = Object.keys(DEVICE_FILTER_FIELD_OPS);

/** Fields the extended vocabulary adds — the ones automations can't produce. */
export const DEVICE_FILTER_ONLY_FIELDS = DEVICE_FILTER_FIELDS.filter((f) => !SCOPE_FIELDS.includes(f));

export interface ScopeConditionRule {
  field: string;
  operator: string;
  value: string;
}
export interface ScopeConditionGroup {
  op: ScopeGroupOp;
  children: (ScopeConditionGroup | ScopeConditionRule)[];
}

/**
 * Build a condition-tree schema over one field vocabulary. Parameterized so the
 * automations scope and the wider device filter validate the SAME tree shape
 * against different field sets — the evaluator handles the superset, and which
 * fields a surface may actually store is decided here.
 */
function makeScopeConditionSchema(
  fieldOps: Record<string, readonly string[]>,
): z.ZodType<ScopeConditionGroup> {
  const ruleSchema = z
    .object({
      field: z.enum(Object.keys(fieldOps) as [string, ...string[]]),
      operator: z.string().min(1).max(30),
      value: z.string().min(1).max(200),
    })
    .strict()
    .superRefine((r, ctx) => {
      const ops = fieldOps[r.field] ?? [];
      if (!ops.includes(r.operator)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `operator "${r.operator}" is not valid for field "${r.field}"` });
      }
      if (r.field === "subnet" && !isValidCidr(r.value) && !isValidIpAddress(r.value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${r.value}" must be a CIDR (e.g. 10.20.0.0/16) or an IP address` });
      }
      // A malformed wildcard must be a 400 at save time, not a throw inside the
      // fire-time matcher — the same reason tag criteria compile theirs on write.
      if (r.operator === WILDCARD_OP) {
        try {
          compileWildcard(r.value);
        } catch (err) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error)?.message || `"${r.value}" is not a valid wildcard` });
        }
      }
    });

  const groupSchema: z.ZodType<ScopeConditionGroup> = z.lazy(() =>
    z
      .object({
        op: z.enum(SCOPE_GROUP_OPS),
        children: z.array(z.union([ruleSchema, groupSchema])).max(50),
      })
      .strict(),
  ) as z.ZodType<ScopeConditionGroup>;
  return groupSchema;
}

/** Automations `scope.condition` — the narrow vocabulary. */
export const scopeConditionSchema: z.ZodType<ScopeConditionGroup> = makeScopeConditionSchema(SCOPE_FIELD_OPS);

/** Contact device ownership — the same tree over DEVICE_FILTER_FIELD_OPS. */
export const deviceFilterConditionSchema: z.ZodType<ScopeConditionGroup> =
  makeScopeConditionSchema(DEVICE_FILTER_FIELD_OPS);

/**
 * Depth + rule caps for a condition tree. Exported because the published
 * builder catalog states them and the schema enforces them — two copies of the
 * number is how the builder comes to allow a nesting the server refuses.
 */
export const SCOPE_CONDITION_MAX_DEPTH = 5;
export const SCOPE_CONDITION_MAX_RULES = 100;

/** Depth/size guard for a condition tree (defense against pathological input). */
export function scopeConditionStats(cond: ScopeConditionGroup): { depth: number; rules: number } {
  let rules = 0;
  const depthOf = (g: ScopeConditionGroup): number =>
    1 + Math.max(0, ...g.children.map((c) => {
      if ("op" in c) return depthOf(c as ScopeConditionGroup);
      rules++;
      return 0;
    }));
  const depth = depthOf(cond);
  return { depth, rules };
}

/**
 * Every field a tree actually references. Lets a caller decide what to SELECT
 * before evaluating — the contact preview only joins the FortiGate sighting
 * relation when a rule asks about it (the 2000-asset rule; the flat
 * vocabulary's buildCandidateSelect does the same thing).
 */
export function conditionFields(cond: ScopeConditionGroup): Set<string> {
  const out = new Set<string>();
  const walk = (g: ScopeConditionGroup): void => {
    for (const c of g.children) {
      if ("op" in c) walk(c as ScopeConditionGroup);
      else out.add((c as ScopeConditionRule).field);
    }
  };
  walk(cond);
  return out;
}

/**
 * The condition fields backed by a RELATION rather than a column, mapped to
 * the Asset relation and column each one reads. Every loader decides its join
 * (or its prefetch) from this table instead of spelling field names itself —
 * which is what kept the fleet-scale SQL path and the single-asset in-memory
 * path answering the same question when the second such field arrived.
 */
export const RELATION_CONDITION_FIELDS: Record<string, { relation: "interfaces" | "apVaps"; column: "ifName" | "ssid" }> = {
  interfaceName: { relation: "interfaces", column: "ifName" },
  ssid:          { relation: "apVaps",     column: "ssid" },
};
export const RELATION_CONDITION_FIELD_NAMES = Object.keys(RELATION_CONDITION_FIELDS);

/** Does this tree ask about the interface inventory? */
export function conditionNeedsInterfaces(cond: ScopeConditionGroup | null | undefined): boolean {
  return !!cond && conditionFields(cond).has("interfaceName");
}

/** Does this tree ask about the broadcast-SSID inventory? */
export function conditionNeedsApVaps(cond: ScopeConditionGroup | null | undefined): boolean {
  return !!cond && conditionFields(cond).has("ssid");
}

/**
 * The asset fields the condition evaluator reads (matcher + engine select).
 *
 * The last four back DEVICE_FILTER_FIELD_OPS only, and are optional for a
 * reason: the notification engine never selects them, so an automations rule —
 * which can't carry those fields past its own schema — costs nothing for them
 * being here.
 */
export interface ScopeConditionAsset {
  id: string;
  assetType?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  hostname?: string | null;
  os?: string | null;
  tags?: string[];
  ipAddress?: string | null;
  status?: string | null;
  osVersion?: string | null;
  department?: string | null;
  location?: string | null;
  learnedLocation?: string | null;
  fortigateSightings?: { fortigateDevice: string | null }[];
  /** Current-state interface inventory, for the `interfaceName` field. Joined
   *  ONLY when a tree actually references it (conditionNeedsInterfaces) — at
   *  2000 assets this relation is an order of magnitude larger than the row it
   *  hangs off, which is why only the SINGLE-asset paths read it this way. */
  interfaces?: { ifName: string }[];
  /** Current-state broadcast-SSID inventory, for the `ssid` field. Joined on
   *  the same terms as `interfaces` above — only when a tree asks for it,
   *  and only on the SINGLE-asset paths. */
  apVaps?: { ssid: string | null }[];
  /** The fleet-scale alternative for EVERY relation-backed field:
   *  `relationLeafKey(leaf)` -> did this asset satisfy that leaf, resolved in
   *  SQL by decorateRelationLeafHits rather than by shipping the relation.
   *  Stamped onto the row so every existing call site (scopeMatchesAsset, the
   *  carve-out peer predicates, the contact preview) keeps working with no
   *  extra parameter to thread. A key that is ABSENT was never prefetched and
   *  means unknown, not false. */
  relationLeafHits?: ReadonlyMap<string, boolean>;
}

/** The asset value a string-op rule compares against, lower-cased. */
function scopeStringField(field: string, asset: ScopeConditionAsset): string {
  const raw =
    field === "manufacturer" ? asset.manufacturer
      : field === "model" ? asset.model
        : field === "hostname" ? asset.hostname
          : field === "os" ? asset.os
            : field === "osVersion" ? asset.osVersion
              : field === "department" ? asset.department
                : field === "location" ? asset.location
                  : null;
  return (raw ?? "").toLowerCase();
}

/**
 * Every name that could identify the FortiGate an asset sits behind: its
 * projected learnedLocation plus each recorded sighting. Mirrors the
 * tagAssignmentService `fortigate` rule — `contains` on a site prefix is meant
 * to cover every gate at that site.
 */
function fortigateNames(asset: ScopeConditionAsset): string[] {
  const out: string[] = [];
  if (asset.learnedLocation) out.push(asset.learnedLocation.toLowerCase());
  for (const s of asset.fortigateSightings ?? []) {
    if (s.fortigateDevice) out.push(s.fortigateDevice.toLowerCase());
  }
  return out;
}

/** Apply one string operator. `matches` is a shell-style wildcard. */
function compareString(operator: string, haystack: string, needle: string): boolean {
  switch (operator) {
    case "equals": return haystack === needle;
    case "notEquals": return haystack !== needle;
    case "contains": return haystack.includes(needle);
    case "notContains": return !haystack.includes(needle);
    case "startsWith": return haystack.startsWith(needle);
    case "endsWith": return haystack.endsWith(needle);
    case WILDCARD_OP: {
      // compileWildcard memoizes per pattern — this is reached per asset per
      // rule per engine tick via loadScopeAssets, not just the one-asset
      // contact path it was written for. A bad pattern was already refused at
      // save, so this can only throw on a row written before the operator was
      // validated — false, not an exception.
      try { return compileWildcard(needle).test(haystack); } catch { return false; }
    }
    default: return false;
  }
}

/** Is `operator` one that asserts ABSENCE? Those must hold for every candidate. */
function isNegativeStringOp(operator: string): boolean {
  return operator === "notEquals" || operator === "notContains";
}

/**
 * The POSITIVE form of a string operator. `notEquals` / `notContains` assert the
 * absence of a match, so both halves of a pair are answered by the same test —
 * which is what lets a prefetching loader ask the database once for "assets with
 * an interface equal to port9" and serve both.
 */
export function positiveStringOp(operator: string): string {
  return operator === "notEquals" ? "equals" : operator === "notContains" ? "contains" : operator;
}

/**
 * Prefetch/lookup key for one relation-backed leaf — the FIELD plus the
 * positive operator plus the value, so `equals port9` and `notEquals port9`
 * share one entry (both are answered by the same query, inverted) while
 * `interfaceName equals GUEST` and `ssid equals GUEST` never collide now that
 * two relations share one map. `scopeRelationIndex.ts` builds the map;
 * `matchScopeRule` reads it.
 */
export function relationLeafKey(rule: ScopeConditionRule): string {
  return rule.field + "|" + leafOpValueKey(rule);
}

/** The operator+value half of the key — the part both halves of a negative
 *  pair share. Separate only so the field can be prefixed above. */
function leafOpValueKey(rule: ScopeConditionRule): string {
  return positiveStringOp(rule.operator) + "\u0000" + rule.value.toLowerCase();
}

/**
 * One rule against SEVERAL values on the same asset — the shape both
 * multi-valued fields need (`fortigate`'s gate names, `interfaceName`'s
 * interface inventory).
 *
 * A positive operator is satisfied by ANY value; a negative one has to hold for
 * ALL of them, or "not behind CENTRALFMG1" would be true for a device sighted
 * behind it as soon as it was also sighted somewhere else, and "has no interface
 * named port9" would be true for a switch carrying both port9 and port10.
 *
 * With nothing known at all — no sightings, no interface inventory — a positive
 * claim fails and an absence claim holds, the same reading `notHas` gives an
 * untagged asset.
 */
function matchMultiValue(rule: ScopeConditionRule, values: string[], needle: string): boolean {
  if (values.length === 0) return isNegativeStringOp(rule.operator);
  return isNegativeStringOp(rule.operator)
    ? values.every((n) => compareString(rule.operator, n, needle))
    : values.some((n) => compareString(rule.operator, n, needle));
}

/** Every interface name the asset currently reports, lower-cased. */
function interfaceNames(asset: ScopeConditionAsset): string[] {
  const out: string[] = [];
  for (const i of asset.interfaces ?? []) {
    if (i.ifName) out.push(i.ifName.toLowerCase());
  }
  return out;
}

/** Every SSID the asset is currently broadcasting, lower-cased. One SSID is
 *  commonly broadcast by several VAPs (one per radio), so this deduplicates —
 *  otherwise a negative operator has to hold against the same name twice,
 *  which is harmless, and a positive one short-circuits anyway. */
function broadcastSsids(asset: ScopeConditionAsset): string[] {
  const out = new Set<string>();
  for (const v of asset.apVaps ?? []) {
    if (v.ssid) out.add(v.ssid.toLowerCase());
  }
  return Array.from(out);
}

function matchScopeRule(rule: ScopeConditionRule, asset: ScopeConditionAsset): boolean {
  const v = rule.value.toLowerCase();
  const str = (raw: string | null | undefined): string => (raw ?? "").toLowerCase();
  switch (rule.field) {
    case "assetType": {
      const eq = str(asset.assetType) === v;
      return rule.operator === "notEquals" ? !eq : eq;
    }
    case "status": {
      const eq = str(asset.status) === v;
      return rule.operator === "notEquals" ? !eq : eq;
    }
    case "assetId": {
      const eq = (asset.id ?? "") === rule.value;
      return rule.operator === "notEquals" ? !eq : eq;
    }
    case "tag": {
      const has = (asset.tags ?? []).some((t) => t.toLowerCase() === v);
      return rule.operator === "notHas" ? !has : has;
    }
    case "subnet": {
      const ip = asset.ipAddress ?? "";
      let inside = false;
      if (ip) {
        try { inside = ipInCidr(ip, scopeCidrOf(rule.value)); } catch { inside = false; }
      }
      return rule.operator === "notInCidr" ? !inside : inside;
    }
    case "fortigate": return matchMultiValue(rule, fortigateNames(asset), v);
    case "interfaceName":
    case "ssid": {
      // Two ways in, one predicate, for both relation-backed fields. A
      // fleet-scale loader resolves each leaf in SQL and stamps the verdict
      // onto the row (decorateRelationLeafHits), so 2000 devices worth of port
      // names never reach this process; the single-asset paths join the
      // relation and compare it here. Both answer "does ANY value satisfy the
      // positive form", inverted for a negative operator, and both read an
      // empty inventory the same way.
      //
      // has() rather than get() is the load-bearing part: a leaf the decoration
      // did not prefetch is UNKNOWN, not false, and falls through to the
      // relation instead of silently answering no.
      const pre = asset.relationLeafHits;
      const key = relationLeafKey(rule);
      if (pre && pre.has(key)) {
        const hit = pre.get(key) === true;
        return isNegativeStringOp(rule.operator) ? !hit : hit;
      }
      const values = rule.field === "ssid" ? broadcastSsids(asset) : interfaceNames(asset);
      return matchMultiValue(rule, values, v);
    }
    default: { // manufacturer / model / hostname / os (+ the device-filter
      // extras: osVersion / department / location) — string ops
      return compareString(rule.operator, scopeStringField(rule.field, asset), v);
    }
  }
}

/**
 * Evaluate a condition tree against an asset. Empty-group semantics follow
 * boolean identities (and([])=true, or([])=false, none=¬or, notAll=¬and) —
 * the wizard converts an empty ROOT group to allAssets, so stored trees
 * always carry at least one rule.
 */
export function evaluateScopeCondition(cond: ScopeConditionGroup, asset: ScopeConditionAsset): boolean {
  const results = cond.children.map((c) =>
    "op" in c ? evaluateScopeCondition(c as ScopeConditionGroup, asset) : matchScopeRule(c as ScopeConditionRule, asset),
  );
  switch (cond.op) {
    case "and": return results.every(Boolean);
    case "or": return results.some(Boolean);
    case "none": return !results.some(Boolean);
    case "notAll": return !results.every(Boolean);
    default: return false;
  }
}

export const scopeSchema = z
  .object({
    allAssets: z.boolean().optional(),
    assetTypes: z.array(z.string().max(100)).max(100).optional(),
    tags: z.array(z.string().max(100)).max(200).optional(),
    assetIds: z.array(z.string().max(100)).max(2000).optional(),
    integrationIds: z.array(z.string().max(100)).max(200).optional(),
    // Case-insensitive CONTAINS match per entry ("Cisco" matches
    // "Cisco Systems, Inc."), OR within the list — same AND-across/OR-within
    // semantics as the other dimensions.
    manufacturers: z.array(z.string().min(1).max(100)).max(100).optional(),
    models: z.array(z.string().min(1).max(100)).max(100).optional(),
    // CIDRs (or bare IPs = /32, /128 for v6) the asset's primary IP must fall
    // inside. Validated at save; matched in memory (ipInCidr) after the SQL pass.
    subnetCidrs: z
      .array(
        z.string().min(1).max(100).refine((c) => isValidCidr(c) || isValidIpAddress(c), {
          message: "must be a CIDR (e.g. 10.20.0.0/16) or an IP address",
        }),
      )
      .max(100)
      .optional(),
    // Nested AND/OR condition tree (the wizard's device-filter builder).
    // Authoritative when present; the flat dimensions above remain for
    // API-written and pre-builder rules (both AND together if combined).
    condition: scopeConditionSchema.optional().nullable(),
  })
  .strict()
  .superRefine((sc, ctx) => {
    if (sc.condition) {
      const { depth, rules } = scopeConditionStats(sc.condition);
      if (depth > SCOPE_CONDITION_MAX_DEPTH) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["condition"], message: `condition groups nest at most ${SCOPE_CONDITION_MAX_DEPTH} deep` });
      if (rules > SCOPE_CONDITION_MAX_RULES) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["condition"], message: `at most ${SCOPE_CONDITION_MAX_RULES} rules per condition tree` });
    }
  });

/** Bare IP → host CIDR so scope subnet entries accept either form. */
export function scopeCidrOf(entry: string): string {
  return isValidIpAddress(entry) ? entry + (entry.includes(":") ? "/128" : "/32") : entry;
}


// ─── Delivery channels + targets ─────────────────────────────────────────────
// Channels are operator-configured delivery integrations (NotificationChannel
// registry, Notifications → Delivery tab). A rule's `targets[]` reference a
// channel by id. In-app is always implicit (every fire writes a Notification);
// targets route the same fire out through the configured channels.
//
// `transport` is the dispatch family the drain switches on; multiple channel
// `type`s can share one transport (slack + teams → webhook).
export const CHANNEL_TYPES = ["smtp", "oauth_m365", "pushbullet", "slack", "teams", "web_push"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const CHANNEL_TRANSPORT: Record<ChannelType, "email" | "webhook" | "web_push" | "pushbullet"> = {
  smtp: "email",
  oauth_m365: "email",
  pushbullet: "pushbullet",
  slack: "webhook",
  teams: "webhook",
  web_push: "web_push",
};
/** Channel types whose target routes to recipients (tags / addresses); the rest
 *  post to the channel's own fixed destination (URL / token). */
export const RECIPIENT_ROUTED_TYPES: ChannelType[] = ["smtp", "oauth_m365", "web_push"];

// Display metadata for the Delivery-tab add/edit modal: per-type label + the
// config fields (key, label, kind, whether it's a masked secret).
export interface ChannelFieldDef {
  key: string;
  label: string;
  kind: "text" | "number" | "password" | "select";
  secret?: boolean;
  options?: string[];
  placeholder?: string;
}
export const CHANNEL_TYPE_META: Record<ChannelType, { label: string; transport: string; singleton?: boolean; help?: string; fields: ChannelFieldDef[] }> = {
  smtp: {
    label: "Email — SMTP", transport: "email",
    fields: [
      { key: "host", label: "SMTP host", kind: "text", placeholder: "smtp.example.com" },
      // Security sits above Port: picking a security level auto-fills the
      // conventional port (none→25, starttls→587, ssl→465) in the UI.
      { key: "security", label: "Security", kind: "select", options: ["none", "starttls", "ssl"] },
      { key: "port", label: "Port", kind: "number" },
      { key: "username", label: "Username", kind: "text" },
      { key: "password", label: "Password", kind: "password", secret: true },
      { key: "from", label: "From address", kind: "text", placeholder: "polaris@example.com" },
    ],
  },
  oauth_m365: {
    label: "Email — Microsoft 365 (OAuth)", transport: "email",
    help: "Add the Mail.Send application permission to this app's Enterprise application in Azure (App registration → API permissions → Microsoft Graph → Application permissions → Mail.Send) and grant admin consent. The send-as user must be a licensed Exchange Online mailbox.",
    fields: [
      { key: "tenantId", label: "Tenant ID", kind: "text" },
      { key: "clientId", label: "Client ID", kind: "text" },
      { key: "clientSecret", label: "Client secret", kind: "password", secret: true },
      { key: "fromUserId", label: "Send-as user (UPN or object ID)", kind: "text", placeholder: "alerts@example.com" },
    ],
  },
  pushbullet: {
    label: "Pushbullet", transport: "pushbullet",
    fields: [
      { key: "accessToken", label: "Access token", kind: "password", secret: true },
    ],
  },
  slack: {
    label: "Slack", transport: "webhook",
    fields: [
      { key: "webhookUrl", label: "Incoming webhook URL", kind: "password", secret: true, placeholder: "https://hooks.slack.com/services/…" },
    ],
  },
  teams: {
    label: "Microsoft Teams", transport: "webhook",
    fields: [
      { key: "webhookUrl", label: "Incoming webhook URL", kind: "password", secret: true, placeholder: "https://outlook.office.com/webhook/…" },
    ],
  },
  web_push: {
    label: "Web Push (browser & mobile)", transport: "web_push", singleton: true,
    fields: [
      { key: "subject", label: "Contact subject (mailto: or https:)", kind: "text", placeholder: "mailto:admin@example.com" },
      // publicKey + privateKey are generated server-side, not free-typed.
    ],
  },
};

/**
 * How far OUT a notify action may reach from the triggering device's own
 * region. 8 is a ceiling, not an expectation: an install with more than eight
 * levels of nested regions has a drawing problem, not a routing one.
 */
export const MAX_DEVICE_REGION_LEVELS = 8;

export const deliveryTargetSchema = z.object({
  channelId: z.string().min(1).max(100),
  // Recipient sources (combine freely; only meaningful for recipient-routed
  // channel types — email + web_push). Chat/Pushbullet ignore these.
  recipientUserIds: z.array(z.string().max(100)).max(500).optional(), // specific Polaris users → their email / push subs
  addresses: z.array(z.string().email().max(320)).max(100).optional(), // custom email addresses (email channels)
  recipientScopeRegion: z.boolean().optional(), // users whose region tags match the rule's scope region tag(s)
  recipientDeviceRegion: z.boolean().optional(), // users whose region tags match the TRIGGERING asset's region: tag(s)
  // Route to users whose region tags match the triggering asset's regions at
  // specific ASSET-RELATIVE levels: 1 = the device's own innermost region,
  // 2 = the division containing it, and so on outward. Independent of
  // recipientDeviceRegion (which stays "every region the asset carries, any
  // level") rather than a modifier of it, so no stored rule changes meaning and
  // the two can sit on DIFFERENT actions — a region-users trigger and an
  // L2-users escalation, which is the whole point.
  //
  // NOT asked as a global level: levels count outward from the leaves and have
  // gaps on an uneven tree, so filtering on a global level would reach nobody
  // for a device whose branch skips it. See regionHierarchyService.
  recipientDeviceRegionLevels: z
    .array(z.number().int().min(1).max(MAX_DEVICE_REGION_LEVELS))
    .max(MAX_DEVICE_REGION_LEVELS)
    .optional(),
  recipientAssetContacts: z.boolean().optional(), // address-book contacts owning the TRIGGERING asset (email only)
  // Every user holding one of these ROLES. Stored as role IDS, not names: a
  // role can be renamed, and User.roleId / ApiToken / GroupMapping all key on
  // the id already. Resolves to users, so it works on email AND web_push.
  recipientRoles: z.array(z.string().max(100)).max(50).optional(),
  // Broadcast modes — web_push only (rejected on other channel types at rule
  // save). recipientAllUsers = every user account; recipientAllRegions = every
  // user carrying at least one region tag; recipientRegions = users in the
  // NAMED regions. Names are stored BARE ("Atlanta"), matching how
  // User/Role/GroupMapping.regionTags are stored — the `region:` prefix only
  // exists on ASSET tags.
  recipientAllUsers: z.boolean().optional(),
  recipientAllRegions: z.boolean().optional(),
  recipientRegions: z.array(z.string().max(100)).max(200).optional(),
  // Registry tag NAMES → every user whose effective tag scope carries one.
  // Authored from the address book's Tags list (and the recipient typeahead),
  // which offers the tag registry minus the Map Regions category — those
  // rows are the region catalogue under another name and route through
  // recipientRegions, which matches region tags ONLY. This one matches the
  // FLATTENED region-plus-other scope (resolveRecipientUsers), the semantics it
  // has always had as the back-compat field it started life as.
  recipientTags: z.array(z.string().max(100)).max(200).optional(),
  // Deliver only to recipients whose own notification preference accepts this
  // channel's transport (business rule 39). Carried on the TARGET as well as
  // on the notify action because actionsToTargets is the runtime path, not
  // just the legacy mirror — a field the action holds and the target drops
  // validates, persists, renders in the wizard and changes nothing at all.
  respectUserPreference: z.boolean().optional(),
});

// ─── Rule-level email composition + escalation ──────────────────────────────
// emailComposition customizes the OUTBOUND EMAIL a rule's email targets send
// (subject / text / HTML bodies + Cc/Bcc). Templates render through
// renderNotificationTemplate (src/utils/notificationTemplate.ts) — single-brace
// {token} vocabulary, cataloged in TEMPLATE_VARIABLES. When set, each email
// target sends ONE message (full To list + Cc + Bcc) instead of the default
// one-email-per-To-address fan-out. NULL = pre-feature default behavior.
// Email-only: chat/pushbullet/web_push channels ignore it.

const emailRecipientsSchema = z
  .object({
    recipientUserIds: z.array(z.string().max(100)).max(500).optional(), // Polaris users → their emails
    addresses: z.array(z.string().email().max(320)).max(100).optional(), // custom email addresses
    recipientRoles: z.array(z.string().max(100)).max(50).optional(), // Role IDS → every user holding them
    // Map-region NAMES → every user tagged with one. Here as well as on the
    // action because the To/Cc/Bcc token fields treat a pill the same wherever
    // it is dropped — the same reason roles are resolvable in Cc/Bcc.
    recipientRegions: z.array(z.string().max(100)).max(200).optional(),
    // Registry tag names, same story: the picker lets a tag pill be dropped in
    // Cc as readily as in To, and this schema is `.strict()` — a shape the
    // builder can produce but the parser rejects fails the whole save with an
    // unrecognized-key error naming a field the operator never typed.
    recipientTags: z.array(z.string().max(100)).max(200).optional(),
  })
  .strict();

export const emailCompositionSchema = z
  .object({
    subjectTemplate: z.string().max(500).optional().nullable(),
    bodyTextTemplate: z.string().max(10000).optional().nullable(),
    bodyHtmlTemplate: z.string().max(20000).optional().nullable(),
    cc: emailRecipientsSchema.optional().nullable(),
    bcc: emailRecipientsSchema.optional().nullable(),
  })
  .strict();

// Escalation: ordered tiers of follow-up emails while the notification stays
// unhandled (stopOn: "acknowledge" stops on ack OR clear; "clear" ignores ack).
// Tier channels must be email-type (validated at rule save). Tier subject/body
// overrides fall back to the rule's emailComposition, then the defaults.
// Swept by the escalateNotifications job (60s).
export const escalationTierSchema = z
  .object({
    afterMin: z.number().int().min(1).max(10080), // ≤ 1 week
    channelId: z.string().min(1).max(100),
    to: emailRecipientsSchema.refine(
      (r) => (r.recipientUserIds?.length ?? 0) + (r.addresses?.length ?? 0) > 0,
      { message: "Escalation tier needs at least one To recipient" },
    ),
    cc: emailRecipientsSchema.optional().nullable(),
    bcc: emailRecipientsSchema.optional().nullable(),
    subjectTemplate: z.string().max(500).optional().nullable(),
    bodyTextTemplate: z.string().max(10000).optional().nullable(),
    bodyHtmlTemplate: z.string().max(20000).optional().nullable(),
    repeatEveryMin: z.number().int().min(5).max(1440).optional().nullable(),
    maxRepeats: z.number().int().min(1).max(20).optional().nullable(), // default 5 when repeating
  })
  .strict();

export const escalationSchema = z
  .object({
    stopOn: z.enum(["acknowledge", "clear"]).default("acknowledge"),
    tiers: z.array(escalationTierSchema).min(1).max(5),
  })
  .strict();

// ─── Rule shape v2: reset + unified actions (Automations redesign) ──────────
// `reset` supersedes clearBehavior/clearAfterSec (auto gains hysteresis +
// clear-sustain); `actions` supersedes `targets` as the unified fired-outcome
// list (notify | api_call | script). Legacy columns stay stored as a lossless
// mirror (legacyMirrorOfV2) and legacy INPUT stays accepted — the transform on
// ruleInputSchema folds old POST bodies into v2, so pre-rename API clients and
// the pre-wizard UI keep working against the alias paths.

export const RESET_MODES = ["manual", "auto", "timed", "condition", "event"] as const;
export type ResetMode = (typeof RESET_MODES)[number];

/**
 * Trigger types a custom reset CONDITION tree can be attached to: the ones that
 * evaluate a continuous reading, so "what has to become true again" is a
 * question with an answer. `event` / `change` fire on an instant and carry no
 * reading to recover — they reset on a timer or by hand.
 *
 * Owned here (not spelled out at each call site) because three places have to
 * agree on it: validateRuleV2, the wizard-facing `resetModesByTriggerType`
 * catalog, and the engine's decision to run the reset-tree pass at all.
 */
export const TRIGGER_TYPES_WITH_RESET_CONDITIONS = ["asset_metric", "asset_state", "host_metric", "composite"] as const;

export function triggerTypeAllowsResetCondition(type: string): boolean {
  return (TRIGGER_TYPES_WITH_RESET_CONDITIONS as readonly string[]).includes(type);
}

/**
 * The mirror image: trigger types a reset EVENT can be attached to — the two
 * that fire on an instant. An event automation has no reading to recover, but
 * it usually has a counterpart event that says the thing came back
 * (`agent.disconnected` → `agent.connected`), and that is a far better answer
 * than "clear it in four hours and hope".
 *
 * Deliberately the COMPLEMENT of TRIGGER_TYPES_WITH_RESET_CONDITIONS rather
 * than an addition to it: a continuous trigger already recovers on its own
 * reading, and letting an unrelated Event clear a live threshold alert would
 * hide a device that is still over the line.
 */
export const TRIGGER_TYPES_WITH_RESET_EVENT = ["event", "change"] as const;

export function triggerTypeAllowsResetEvent(type: string): boolean {
  return (TRIGGER_TYPES_WITH_RESET_EVENT as readonly string[]).includes(type);
}

/**
 * Known recovery counterparts, keyed by the TRIGGER's action pattern. Published
 * in the builder catalog so the wizard can prefill the reset pattern instead of
 * asking an operator to remember which verb Polaris writes on the way back up.
 *
 * A suggestion only — every entry is editable, and a pattern that isn't in the
 * map leaves the field blank. Each pair is a real `logEvent` call site.
 */
export const RESET_EVENT_SUGGESTIONS: Record<string, string> = {
  "agent.disconnected": "agent.connected",
  "agent.upgrade_failed": "agent.upgrade_succeeded",
  "agent.install_failed": "agent.installed",
  "agent.uninstall_failed": "agent.uninstalled",
  "agent.build.failed": "agent.build.completed",
  "integration.discover.error": "integration.discover.completed",
  "platform.lifecycle_changed": "platform.lifecycle_recovered",
};

export const resetEventSchema = z
  .object({
    // Glob over Event.action, same vocabulary as the event trigger.
    actionPattern: z.string().min(1).max(200),
    // Optional narrowing, mirroring the event trigger's own field.
    resourceType: z.string().max(60).optional().nullable(),
  })
  .strict();

export const resetSchema = z
  .object({
    mode: z.enum(RESET_MODES).default("manual"),
    // auto only — hysteresis: the alert recovers when the value no longer
    // meets `trigger.operator clearThreshold` (a fire at cpu >= 90 with
    // clearThreshold 80 clears at < 80). Omit = recover at the fire threshold.
    clearThreshold: z.number().optional().nullable(),
    // auto + condition — clear-sustain: the recovery must hold this long
    // before the alert auto-clears. 0/omit = clear on first recovered tick.
    sustainSec: z.number().int().min(0).max(86400).optional().nullable(),
    // The same clear-sustain as a COUNT OF READINGS, and the authority when
    // set (`sustainSec` is its wall-clock mirror — see FOR_POLLS_NOTE): the
    // recovery must hold across this many consecutive readings. "Down after 3
    // missed, reset after 5 received" already meant readings on the down path
    // (business rule 36); this is the same sentence for every other condition.
    sustainPolls: z.number().int().min(0).max(100).optional().nullable(),
    // timed only (the old clearAfterSec).
    afterSec: z.number().int().min(1).max(2592000).optional().nullable(),
    // condition only — a custom AND/OR reset tree (same leaf vocabulary as the
    // composite trigger). While the alert is firing, this tree is the sole
    // recovery authority. Allowed on ANY continuous trigger (single metric /
    // state as well as composite), restricted to leaves of the trigger's own
    // kind by validateRuleV2; the wizard seeds it with the trigger INVERTED so
    // the starting point is what the automatic reset would have done.
    condition: triggerConditionGroupSchema.optional().nullable(),
    // event only (event/change triggers) — clear when the counterpart Event
    // arrives for the SAME subject the alert is about. Same-subject is not
    // configurable: one agent reconnecting says nothing about another, and the
    // subject key is the one the alert already stores (assetId, else the
    // resource label).
    resetEvent: resetEventSchema.optional().nullable(),
  })
  .strict();

export const API_CALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const SCRIPT_RUN_TARGETS = ["server", "agent"] as const;
// Interpreter vocabulary for the AutomationScript registry (owned here — the
// vocabulary file — so the catalog, the script service, and the routes never
// drift; the Go agent mirrors this list in scriptexec).
export const SCRIPT_INTERPRETERS = ["bash", "sh", "powershell", "cmd", "python3"] as const;
export type ScriptInterpreter = (typeof SCRIPT_INTERPRETERS)[number];

export const notifyActionSchema = z
  .object({
    type: z.literal("notify"),
    // The action's PRIMARY channel, and the lossless single-channel mirror of
    // `channelIds` — every pre-multi-channel reader (the legacy targets
    // column, the escalation-tier converter, the automations list's recipient
    // groups) still names a channel through this field, so it must always
    // equal channelIds[0]. Enforced below rather than repaired silently: a
    // payload whose two views disagree is a client bug, and guessing which one
    // the operator meant is how an alert goes to the wrong place.
    channelId: z.string().min(1).max(100),
    // Every channel this ONE action delivers through. Absent (or a single
    // entry) is the pre-feature shape. Multiple channels exist so an operator
    // can say "page this person by email AND push" once — and, with
    // respectUserPreference below, so ONE action can carry both methods and
    // let each recipient's own preference pick which of them reaches them.
    // Resolved through notifyChannelIds(); expands to one DeliveryTarget per
    // channel, so nothing downstream needs to know an action can be plural.
    channelIds: z.array(z.string().min(1).max(100)).min(1).max(10).optional(),
    // Deliver through only the channel(s) matching each recipient's own
    // notification preference (User.notificationPreference). Business rule 39.
    //
    // Consulted ONLY when the action group actually offers both methods — an
    // action group with email alone would otherwise silently drop every
    // push-preferring recipient, i.e. the preference would delete the alert
    // rather than route it. The group test lives at execution time
    // (automationActionService), not here, because the group is the actions[]
    // list being run, which a single action cannot see.
    respectUserPreference: z.boolean().optional(),
    // Recipient sources — same semantics as deliveryTargetSchema (meaningful
    // for recipient-routed channel types only; chat/pushbullet ignore them).
    recipientUserIds: z.array(z.string().max(100)).max(500).optional(),
    addresses: z.array(z.string().email().max(320)).max(100).optional(),
    recipientScopeRegion: z.boolean().optional(),
    // Route to users whose region tags match the TRIGGERING asset's region:
    // tag(s) — works with any device filter (no region: tag needed on the
    // scope). The engine threads the asset's stripped region snapshot into
    // the expander (Notification.regionTags on the escalation sweep).
    recipientDeviceRegion: z.boolean().optional(),
    // Asset-relative level routing — see deliveryTargetSchema for why levels
    // are counted outward from the DEVICE rather than globally.
    recipientDeviceRegionLevels: z
      .array(z.number().int().min(1).max(MAX_DEVICE_REGION_LEVELS))
      .max(MAX_DEVICE_REGION_LEVELS)
      .optional(),
    // Route to the address-book contacts RESPONSIBLE for the triggering asset
    // (Contact.assetCriteria ∪ Contact.assetIds). Same union semantics as
    // recipientDeviceRegion and works with any device filter — the difference
    // is that ownership is stated once on the contact instead of per rule.
    // Email transports only: a contact is an address, not an account, so there
    // is no push subscription to reach.
    recipientAssetContacts: z.boolean().optional(),
    // Every user holding one of these ROLES (role ids — see deliveryTargetSchema).
    recipientRoles: z.array(z.string().max(100)).max(50).optional(),
    // Broadcast modes — see deliveryTargetSchema. web_push only; validated at
    // rule save so the model can never hold a state the builder won't render.
    recipientAllUsers: z.boolean().optional(),
    recipientAllRegions: z.boolean().optional(),
    recipientRegions: z.array(z.string().max(100)).max(200).optional(),
    recipientTags: z.array(z.string().max(100)).max(200).optional(),
    // Per-action email composition override; falls back to the rule-level
    // emailComposition, then the pre-feature defaults. Email transports only.
    emailComposition: emailCompositionSchema.optional().nullable(),
  })
  // NOT superRefine()d, deliberately: this schema is a member of the `action`
  // discriminated union AND is .extend()ed into the escalatable variant, and
  // both refuse a ZodEffects. The channelId === channelIds[0] coherence check
  // therefore lives in assertActionRefs (notificationRuleService), which
  // already walks every action location through allRuleActionRefs.
  .strict();

/**
 * Every channel one notify action delivers through, deduped, primary first.
 *
 * THE single reader of the channelId/channelIds pair — validation, the action
 * executor, the wizard's mirror and the recipient-group renderer all go
 * through it, so "an action has one channel" survives nowhere as an
 * assumption. Falls back to the primary alone, which is what every stored
 * pre-feature action and every legacy-converted tier carries.
 */
export function notifyChannelIds(a: { channelId: string; channelIds?: string[] | null }): string[] {
  const list = a.channelIds?.length ? a.channelIds : [a.channelId];
  return Array.from(new Set(list.filter(Boolean)));
}

// SECURITY: headers are stored UNMASKED on the rule (and echoed onto delivery
// rows) — the catalog + docs tell operators never to put credentials here.
// The URL is static (no {token}s) so the SSRF host check at save time checks
// what actually gets fetched; only bodyTemplate takes template tokens.
export const apiCallActionSchema = z
  .object({
    type: z.literal("api_call"),
    method: z.enum(API_CALL_METHODS).default("POST"),
    url: z
      .string()
      .max(2000)
      .url()
      .refine((u) => /^https?:\/\//i.test(u), { message: "api_call URL must be http(s)" }),
    headers: z
      .record(z.string().max(1000))
      .refine((h) => Object.keys(h).length <= 20, { message: "at most 20 headers" })
      .refine((h) => Object.keys(h).every((k) => k.length >= 1 && k.length <= 100), {
        message: "header names must be 1–100 characters",
      })
      .optional(),
    bodyTemplate: z.string().max(10000).optional().nullable(), // {token} vocabulary
    timeoutSec: z.number().int().min(1).max(60).default(15),
  })
  .strict();

export const scriptActionSchema = z
  .object({
    type: z.literal("script"),
    scriptId: z.string().min(1).max(100), // AutomationScript registry id
    runOn: z.enum(SCRIPT_RUN_TARGETS),
    argsTemplate: z.string().max(2000).optional().nullable(), // {token} vocabulary
    timeoutSec: z.number().int().min(1).max(600).optional().nullable(), // overrides the script default
  })
  .strict();

// Write the `notification.triggered` audit Event on every fire. Present by
// default (a migration appended it to every pre-existing rule, and the legacy
// normalizer injects it) so nothing silently stops auditing; removing it is an
// explicit operator choice for a noisy automation.
//
// This does NOT govern the in-app Alert. The Notification row is structural —
// every NotificationDelivery hangs off its id, as do the escalation sweep,
// acknowledge/clear and the rule state machine — so a notify/api_call action
// could not exist without it. Only the audit Event is optional.
export const eventActionSchema = z
  .object({
    type: z.literal("event"),
  })
  .strict();

export const actionSchema = z.discriminatedUnion("type", [
  notifyActionSchema,
  apiCallActionSchema,
  scriptActionSchema,
  eventActionSchema,
]);

// Escalation v2: tiers of ACTIONS (any type), superseding the email-only tier
// shape. The stored/input escalation stays on the legacy schema until the
// escalation-v2 phase flips the sweep onto executeActions; the v2 schema +
// normalizeEscalationToV2 land now so the conversion is testable and shared.
export const escalationTierV2Schema = z
  .object({
    afterMin: z.number().int().min(1).max(10080),
    actions: z.array(actionSchema).min(1).max(10),
    repeatEveryMin: z.number().int().min(5).max(1440).optional().nullable(),
    maxRepeats: z.number().int().min(1).max(20).optional().nullable(),
  })
  .strict();

export const escalationV2Schema = z
  .object({
    stopOn: z.enum(["acknowledge", "clear"]).default("acknowledge"),
    tiers: z.array(escalationTierV2Schema).min(1).max(5),
  })
  .strict();

/**
 * Repeat the alert's notifications while it stays unhandled.
 *
 * `stopOn` mirrors escalation's: "acknowledge" stops on acknowledge OR clear;
 * "clear" ignores acknowledgement and only stops when the alert clears.
 *
 * There is deliberately NO maxRepeats — unbounded-until-handled is the point.
 * `stopAfterHours` is an optional, blank-by-default absolute cut-off so an
 * unacknowledged holiday weekend doesn't require an emergency edit to a live
 * automation.
 *
 * `quiet` is the recurring stretches during which a DUE reminder is held
 * rather than sent (business rule 44) — server-local wall clock, the same
 * recurrence shapes the Maintenance scheduler uses (utils/quietTime.ts). It
 * lives INSIDE the repeat config, not beside it, because it is the reminder
 * clock it modifies and nothing else: the first alert always sends, and
 * escalation tiers keep running through a quiet window on purpose (a tier
 * exists to chase a specific person harder, and silencing it would quietly
 * weaken an escalation the operator configured somewhere they weren't
 * looking).
 */
export const repeatConfigSchema = z
  .object({
    everyMin: z.number().int().min(5).max(1440),
    stopOn: z.enum(["acknowledge", "clear"]).default("acknowledge"),
    stopAfterHours: z.number().int().min(1).max(720).optional().nullable(),
    quiet: quietConfigSchema.optional().nullable(),
  })
  .strict();

export type RepeatConfig = z.infer<typeof repeatConfigSchema>;

/** Re-exported so the sweep and the schema route can name the quiet-time
 *  shape without reaching past this module for half of one config. */
export type { QuietConfig };

// ─── Per-action escalation (escalatable actions) ────────────────────────────
// A rule's top-level actions and each severity band's actions may carry their
// OWN escalation chain — "notify team A, and if unhandled 15 min later notify
// their manager" — instead of (or alongside) the rule/band-level chain. The
// chain shape is the same escalation config; accepts legacy email tiers too
// (readers normalize via normalizeEscalationToV2). ONE level only: actions
// INSIDE escalation tiers (and bandNotify.resolvedActions) stay on the bare
// actionSchema, so a nested `escalation` key fails .strict() parsing — no
// chains-of-chains. Escalation state keys are derived per chain:
// escalationTierStateKey("", j) = "j" (the rule/band-level chain — unchanged
// from pre-feature rows) and escalationTierStateKey("a<i>", j) = "a<i>:t<j>".
const perActionEscalation = z.union([escalationSchema, escalationV2Schema]).optional().nullable();

export const notifyActionEscalatableSchema = notifyActionSchema.extend({ escalation: perActionEscalation });
export const apiCallActionEscalatableSchema = apiCallActionSchema.extend({ escalation: perActionEscalation });
export const scriptActionEscalatableSchema = scriptActionSchema.extend({ escalation: perActionEscalation });

export const escalatableActionSchema = z.discriminatedUnion("type", [
  notifyActionEscalatableSchema,
  apiCallActionEscalatableSchema,
  scriptActionEscalatableSchema,
  // No per-action escalation: an audit Event is instantaneous, so there is
  // nothing to chase if it goes "unhandled".
  eventActionSchema,
]);
export type EscalatableAction = z.infer<typeof escalatableActionSchema>;

// ─── Severity bands (value-driven severity escalation) ──────────────────────
// Higher tiers stacked on the base trigger (tier 0 = rule.severity +
// trigger.threshold + rule.actions + rule.escalation). Each band carries its
// OWN actions (run when the alert enters that band) and its own time-based
// escalation (per-band, swept band-aware). Cross-field ordering (thresholds
// monotonic in the operator direction, severities strictly increasing above
// the base) is enforced in validateRuleV2 (discriminated-union members can't
// carry a superRefine, and the base severity lives on the rule).
export const severityBandSchema = z
  .object({
    threshold: z.number(),
    severity: z.enum(SEVERITIES),
    // Per-tier comparison operator (falls back to the trigger's). Tiers share
    // the trigger's sampling — aggregation / window / dimensionFilter — so only
    // the comparison + threshold + severity + sustain vary per tier.
    operator: z.enum(COMPARATORS).optional(),
    // Per-tier sustained duration: how long the value must hold IN THIS BAND
    // before the alert takes this severity. Omitted = inherit the base
    // trigger's forDurationSec (every pre-feature band); 0 = apply immediately.
    forDurationSec: z.number().int().min(0).max(86400).optional(),
    actions: z.array(escalatableActionSchema).max(20).default([]),
    // Per-band time escalation (same shape as rule-level; accepts legacy or v2).
    escalation: z.union([escalationSchema, escalationV2Schema]).optional().nullable(),
  })
  .strict();
export type SeverityBand = z.infer<typeof severityBandSchema>;

// Per-automation policy: which band transitions notify, and how a resolved
// (below tier 0) alert notifies. onIncrease/onResolved default on; onDecrease
// off (page when it worsens, not when it eases). resolvedMode picks whether the
// all-clear reuses the last-fired band's actions or a dedicated list.
export const bandNotifySchema = z
  .object({
    onIncrease: z.boolean().default(true),
    onDecrease: z.boolean().default(false),
    onResolved: z.boolean().default(true),
    resolvedMode: z.enum(["reuse", "dedicated"]).default("reuse"),
    resolvedActions: z.array(actionSchema).max(20).optional().nullable(),
  })
  .strict();
export type BandNotify = z.infer<typeof bandNotifySchema>;

export type Trigger = z.infer<typeof triggerSchema>;
export type RuleScope = z.infer<typeof scopeSchema>;
export type DeliveryTarget = z.infer<typeof deliveryTargetSchema>;
export type EmailRecipients = z.infer<typeof emailRecipientsSchema>;
export type EmailComposition = z.infer<typeof emailCompositionSchema>;
export type EscalationTier = z.infer<typeof escalationTierSchema>;
export type EscalationConfig = z.infer<typeof escalationSchema>;
export type ResetConfig = z.infer<typeof resetSchema>;
export type NotifyAction = z.infer<typeof notifyActionSchema>;
export type ApiCallAction = z.infer<typeof apiCallActionSchema>;
export type ScriptAction = z.infer<typeof scriptActionSchema>;
export type AutomationAction = z.infer<typeof actionSchema>;
export type EscalationTierV2 = z.infer<typeof escalationTierV2Schema>;
export type EscalationV2Config = z.infer<typeof escalationV2Schema>;

// ─── Specificity ranking (automation precedence / carve-out) ────────────────
// A more-specific automation carves the assets it covers out of a less-specific
// one that watches the SAME trigger (triggerSignature). Specificity = the
// most-specific scope dimension an automation positively constrains, on this
// ladder (least → most). Lifecycle status + asset id are deliberately absent —
// status is a state qualifier, not an identity dimension, and asset id is no
// longer offered in the builder.
export const SCOPE_RANK = {
  allAssets: 0,
  assetType: 1,
  os: 2,
  manufacturer: 3,
  model: 4,
  tag: 5,
  region: 6,
  subnet: 7,
  hostname: 8,
} as const;

/** Ladder for the wizard's "Specificity: …" indicator (least → most). */
export const SCOPE_RANK_LADDER: { key: keyof typeof SCOPE_RANK; label: string }[] = [
  { key: "allAssets", label: "All assets" },
  { key: "assetType", label: "Device type" },
  { key: "os", label: "Operating system" },
  { key: "manufacturer", label: "Manufacturer" },
  { key: "model", label: "Model" },
  { key: "tag", label: "Tag" },
  { key: "region", label: "Region" },
  { key: "subnet", label: "Subnet" },
  { key: "hostname", label: "Hostname" },
];

/** Human label for a numeric specificity rank (the ladder rung at or below it). */
export function scopeRankLabel(rank: number): string {
  let label = SCOPE_RANK_LADDER[0].label;
  for (const rung of SCOPE_RANK_LADDER) {
    if (SCOPE_RANK[rung.key] <= rank) label = rung.label;
  }
  return label;
}

// Condition-rule operators that POSITIVELY narrow to specific assets. Negative
// operators (notEquals/notHas/…) and none/notAll groups broaden rather than
// target, so they never raise specificity.
const POSITIVE_SCOPE_OPS = new Set(["equals", "contains", "startsWith", "endsWith", "has", "inCidr"]);

function isRegionTagValue(v: string): boolean {
  return v.trim().toLowerCase().startsWith("region:");
}

function conditionRuleRank(rule: ScopeConditionRule): number {
  if (!POSITIVE_SCOPE_OPS.has(rule.operator)) return 0;
  switch (rule.field) {
    case "assetType": return SCOPE_RANK.assetType;
    case "os": return SCOPE_RANK.os;
    case "manufacturer": return SCOPE_RANK.manufacturer;
    case "model": return SCOPE_RANK.model;
    case "tag": return isRegionTagValue(rule.value) ? SCOPE_RANK.region : SCOPE_RANK.tag;
    case "subnet": return SCOPE_RANK.subnet;
    case "hostname": return SCOPE_RANK.hostname;
    // status / assetId / interfaceName — not on the ladder. An interface is a
    // COMPONENT of a device, not a way of saying WHICH devices an automation is
    // about, so "switches with a fortilink port" is exactly as specific as
    // "switches" and the two tie rather than carving each other up.
    default: return 0;
  }
}

function conditionTreeRank(group: ScopeConditionGroup): number {
  // Only AND/OR subtrees positively target; none/notAll invert to "must NOT".
  if (group.op !== "and" && group.op !== "or") return 0;
  let rank = 0;
  for (const child of group.children) {
    rank = Math.max(
      rank,
      "op" in child ? conditionTreeRank(child as ScopeConditionGroup) : conditionRuleRank(child as ScopeConditionRule),
    );
  }
  return rank;
}

/**
 * Specificity rank of a scope = the most-specific dimension it positively
 * constrains, across BOTH the flat dimensions and the condition tree. 0 =
 * all-assets / unconstrained.
 */
export function scopeRank(scope: RuleScope): number {
  let rank = 0;
  if (scope.assetTypes?.length) rank = Math.max(rank, SCOPE_RANK.assetType);
  if (scope.manufacturers?.length) rank = Math.max(rank, SCOPE_RANK.manufacturer);
  if (scope.models?.length) rank = Math.max(rank, SCOPE_RANK.model);
  if (scope.subnetCidrs?.length) rank = Math.max(rank, SCOPE_RANK.subnet);
  for (const t of scope.tags ?? []) {
    rank = Math.max(rank, isRegionTagValue(t) ? SCOPE_RANK.region : SCOPE_RANK.tag);
  }
  if (scope.condition) rank = Math.max(rank, conditionTreeRank(scope.condition));
  return rank;
}

/**
 * Minimal asset shape needed to evaluate scope membership. Extends the
 * condition-evaluator's field vocabulary (notificationTypes.ScopeConditionAsset)
 * so the flat-scope matcher and the condition tree can never drift apart —
 * this layer just requires the dimensions the flat matcher always reads.
 */
export interface ScopeAsset extends ScopeConditionAsset {
  assetType: string | null;
  tags: string[];
  discoveredByIntegrationId: string | null;
}

/**
 * Does this scope narrow anything at all? `{allAssets:true}` says so outright;
 * a bare `{}` is the same answer arrived at differently — it is what the wizard
 * WROTE for every event automation before device filters reached that trigger
 * type (business rule 46), and what an API caller who omits `scope` gets. Both
 * mean "any device", so a caller that filters on scope must ask this FIRST:
 * `scopeMatchesAsset({}, …)` is false (it matches nothing), which is the right
 * answer for a builder-authored scope and exactly the wrong one for those rows.
 */
export function scopeIsUnconstrained(scope: RuleScope | null | undefined): boolean {
  if (!scope) return true;
  if (scope.allAssets) return true;
  const lists = [scope.assetTypes, scope.tags, scope.assetIds, scope.integrationIds, scope.manufacturers, scope.models, scope.subnetCidrs];
  if (lists.some((l) => l && l.length > 0)) return false;
  // An empty tree ANDs to true for every asset, so it selects nothing either.
  return !(scope.condition && scope.condition.children.length > 0);
}

/**
 * Does `scope` select `asset`? AND across the provided dimensions, OR within
 * each list. `allAssets` short-circuits true. A scope with no dimensions and
 * allAssets unset matches NOTHING (the builder requires an explicit selection).
 * KEEP IN LOCKSTEP with the engine's SQL `scopeWhere` + loadScopeAssets
 * subnet post-filter (notificationEngine.ts) — this is the in-memory twin.
 */
export function scopeMatchesAsset(scope: RuleScope, asset: ScopeAsset): boolean {
  if (scope.allAssets) return true;
  let anyDimension = false;

  if (scope.assetTypes && scope.assetTypes.length > 0) {
    anyDimension = true;
    if (!scope.assetTypes.includes(asset.assetType ?? "")) return false;
  }
  if (scope.tags && scope.tags.length > 0) {
    anyDimension = true;
    const set = new Set(asset.tags.map((t) => t.toLowerCase()));
    if (!scope.tags.some((t) => set.has(t.toLowerCase()))) return false;
  }
  if (scope.assetIds && scope.assetIds.length > 0) {
    anyDimension = true;
    if (!scope.assetIds.includes(asset.id)) return false;
  }
  if (scope.integrationIds && scope.integrationIds.length > 0) {
    anyDimension = true;
    if (!scope.integrationIds.includes(asset.discoveredByIntegrationId ?? "")) return false;
  }
  if (scope.manufacturers && scope.manufacturers.length > 0) {
    anyDimension = true;
    const mfr = (asset.manufacturer ?? "").toLowerCase();
    if (!mfr || !scope.manufacturers.some((m) => mfr.includes(m.toLowerCase()))) return false;
  }
  if (scope.models && scope.models.length > 0) {
    anyDimension = true;
    const model = (asset.model ?? "").toLowerCase();
    if (!model || !scope.models.some((m) => model.includes(m.toLowerCase()))) return false;
  }
  if (scope.subnetCidrs && scope.subnetCidrs.length > 0) {
    anyDimension = true;
    const ip = asset.ipAddress ?? "";
    if (!ip) return false;
    const inAny = scope.subnetCidrs.some((c) => {
      try { return ipInCidr(ip, scopeCidrOf(c)); } catch { return false; }
    });
    if (!inAny) return false;
  }
  // Nested condition tree (the wizard's builder). ANDs with any flat
  // dimensions above when both are present.
  if (scope.condition) {
    anyDimension = true;
    if (!evaluateScopeCondition(scope.condition, asset)) return false;
  }
  return anyDimension;
}

// ─── Trigger signature (carve-out "same trigger" key) ───────────────────────
// Two automations carve-out only when they watch the SAME thing. The signature
// is the metric/field + its dimension filter (strict: a sensor-class filter and
// no filter are different things and never shadow each other — erring toward an
// extra alert over a wrongly-silenced one). Returns null for triggers that
// don't participate in carve-out (host has no asset scope; composite watches
// many things; event/change are per-event, not per-asset thresholds).
function stableDimFilter(df: Record<string, unknown> | undefined | null): string {
  if (!df) return "";
  const keys = Object.keys(df).filter((k) => df[k] !== undefined && df[k] !== null && df[k] !== "").sort();
  return keys.map((k) => `${k}=${String(df[k])}`).join(",");
}

export function triggerSignature(trigger: Trigger): string | null {
  if (trigger.type === "asset_metric") return `am:${trigger.metric}:${stableDimFilter(trigger.dimensionFilter)}`;
  if (trigger.type === "asset_state") {
    // monitorStatus is the one state field that is a SINGLE per-asset column
    // with no reading dimensions of its own (neither FIELD_DIMENSIONS nor
    // STATE_FIELD_DIMENSIONS carries an entry for it), so the only
    // dimensionFilter it can legally hold is a DEVICE filter — one that narrows
    // the asset SET rather than the reading. Two automations watching
    // "monitorStatus == down" with different device filters are therefore still
    // watching the same one thing on overlapping devices, and must be able to
    // carve each other out; keying on the filter would put them in different
    // groups and let both claim authority over the same asset. Hence: filter
    // dropped, and the compared VALUE added in its place, because "== down" and
    // "== warning" genuinely ARE different things to watch — and only
    // "== down" carries down-detection authority (see downDetectionService).
    //
    // The device filter does NOT stop mattering; it moves to where coverage is
    // actually tested (isAssetShadowed / carveOutAggregate both AND
    // deviceFilterMatch into their scope test), so a filtered peer only shadows
    // the assets it can genuinely fire on.
    if (trigger.field === "monitorStatus") {
      return `as:monitorStatus:${trigger.operator}${String(trigger.value).toLowerCase()}`;
    }
    return `as:${trigger.field}:${stableDimFilter(trigger.dimensionFilter)}`;
  }
  return null;
}

/**
 * The missed-poll count applied to a device governed by a down-detection
 * automation that carries no explicit count — the pre-cutover baseline row, or
 * a body from a client older than the field.
 *
 * MUST track `HARDCODED_FLOOR.failureThreshold` in monitoringService: it is the
 * same number, and the point of the default is that such a rule keeps behaving
 * exactly as it did before the count became operator-visible. Defined here
 * rather than in downDetectionService because the schema catalog needs it and
 * importing the service would close a cycle.
 */
export const DEFAULT_MISSED_POLLS = 3;

/**
 * Does this trigger DEFINE what "down" means for the devices it covers?
 *
 * A `monitorStatus == down` automation is no longer just a reader of the column
 * — its `missedPolls` count is what `recordProbeResult` compares
 * consecutiveFailures against for every asset it governs (most-specific-wins,
 * business rule 18's ladder). An asset covered by no such automation is never
 * judged at all: it reads `passive`.
 *
 * Lives here rather than in downDetectionService because the schema layer
 * (validateRuleV2) needs it and importing the service would close a cycle.
 */
export function isDownDetectionTrigger(trigger: Trigger): boolean {
  return (
    trigger.type === "asset_state" &&
    trigger.field === "monitorStatus" &&
    trigger.operator === "==" &&
    String(trigger.value).toLowerCase() === "down"
  );
}

/**
 * The reset sustain, in seconds, when it is a RECOVERY COUNT and not merely the
 * alert's clock — i.e. an automatic reset that asks the recovery to hold.
 *
 * On a down-detection automation the wizard's reset step already asks the
 * question in polls ("N received polls before reset"), and rule 36 made the
 * automation the authority on what `down` means. The two together mean the
 * count has to reach the STATE MACHINE, not just the alert row: an operator who
 * writes "down after 3 missed, reset after 5 received" is describing the pill,
 * and a device that went green at 3 while the alert sat firing for another 5
 * was Polaris disagreeing with itself in the one place an operator watches
 * probe by probe (the asset's intermittency strip).
 *
 * Null for every other reset mode. `manual` / `timed` / `condition` / `event`
 * say nothing about how many probes must answer, and a `condition` tree in
 * particular is its own recovery authority (business rule 32a) — layering a
 * poll count under it would give one alert two clocks that disagree.
 *
 * Takes `unknown` so the down-detection index can hand it a raw Prisma JSON
 * column without parsing the whole rule first; it is on the index BUILD path
 * (once per TTL), never the per-probe path.
 */
export function downRecoverySustainSec(reset: unknown): number | null {
  const r = reset as { mode?: unknown; sustainSec?: unknown } | null | undefined;
  if (!r || typeof r !== "object" || r.mode !== "auto") return null;
  return typeof r.sustainSec === "number" && r.sustainSec > 0 ? r.sustainSec : null;
}

/**
 * The same recovery hold as the COUNT the operator actually stated
 * (`reset.sustainPolls`), which is what `recoveryPollsFor` should use when it
 * has one: dividing the seconds mirror by the asset's cadence returns their
 * number only when the cadence hasn't changed since they typed it, and rounds
 * to something else when it has. Null when the reset states only seconds — the
 * pre-count shape, and the one the division exists for.
 */
export function downRecoveryPolls(reset: unknown): number | null {
  const r = reset as { mode?: unknown; sustainPolls?: unknown } | null | undefined;
  if (!r || typeof r !== "object" || r.mode !== "auto") return null;
  return typeof r.sustainPolls === "number" && r.sustainPolls > 0 ? Math.round(r.sustainPolls) : null;
}

/**
 * Has this rule's reset sustain been CONSUMED by the monitor state machine?
 *
 * True exactly when a down-detection trigger carries an auto reset with a hold:
 * `recordProbeResult` is holding the asset in `recovering` until the count is
 * met, so the engine must not charge the same wait a second time — and it must
 * not treat `recovering` as recovered, or the alert would clear on the FIRST
 * answered packet, which is earlier than it cleared before this existed.
 * `notificationEngine.recoveredMeets` is the single reader.
 */
export function downRecoveryConsumesSustain(trigger: Trigger, reset: ResetConfig): boolean {
  // Either spelling counts: a reset that states only a COUNT is still a hold
  // the monitor state machine is serving, and missing that would let the engine
  // charge the wait a second time.
  return isDownDetectionTrigger(trigger) && (downRecoverySustainSec(reset) !== null || downRecoveryPolls(reset) !== null);
}

/**
 * The monitor states a `monitorStatus == down` alert stays FIRING through when
 * its sustain is consumed by the state machine. `down` is the obvious one;
 * `recovering` is the corridor the asset climbs on its way back, and the whole
 * point of the count is that the corridor is not yet a recovery. `warning`
 * belongs here too — a device that answered once and then missed again is
 * further from recovered than one that is climbing, and letting it clear the
 * alert would reward flapping.
 */
export const DOWN_ALERT_HOLDING_STATES: readonly string[] = ["down", "recovering", "warning"];

// ─── Input schema (accepts v2 AND legacy bodies; canonical output is v2) ────

const ruleInputBaseSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional().nullable(),
  enabled: z.boolean().default(true),
  severity: z.enum(SEVERITIES).default("warning"),
  trigger: triggerSchema,
  scope: scopeSchema.default({}),
  // v2 canonical fields:
  reset: resetSchema.optional().nullable(),
  actions: z.array(escalatableActionSchema).max(20).optional(),
  // Legacy fields, folded into v2 by the transform (v2 wins when both given):
  clearBehavior: z.enum(CLEAR_BEHAVIORS).optional(),
  clearAfterSec: z.number().int().min(1).max(2592000).optional().nullable(),
  targets: z.array(deliveryTargetSchema).max(50).optional(),
  // Shared fields:
  cooldownSec: z.number().int().min(0).max(2592000).optional().nullable(),
  messageTemplate: z.string().max(2000).optional().nullable(),
  // Acknowledging an alert from this automation requires a note. Rides the
  // in-app alert card in the wizard because that is what it is about — the
  // alert record — and is enforced in acknowledgeNotifications, so the emailed
  // ack link and the push action obey it too.
  requireAckNote: z.boolean().optional(),
  channels: z.array(z.string().max(50)).default(["in_app"]),
  emailComposition: emailCompositionSchema.optional().nullable(),
  // Accepts BOTH shapes: legacy email tiers (pre-wizard UI) and v2 tiers of
  // actions. Stored as given; every reader normalizes via
  // normalizeEscalationToV2 (part of normalizeRuleToV2).
  escalation: z.union([escalationSchema, escalationV2Schema]).optional().nullable(),
  // Severity bands + notify policy (value-driven severity escalation). Bands
  // are numeric-metric-trigger only (enforced in validateRuleV2).
  severityBands: z.array(severityBandSchema).max(4).optional().nullable(),
  bandNotify: bandNotifySchema.optional().nullable(),
  // Actions that run when the alert ENDS — auto / timed / custom-condition
  // reset, or an operator clearing it by hand. Plain actions, not escalatable:
  // there is nothing to chase about a recovery (same reason bandNotify's
  // resolvedActions stay bare). Absent/null = nothing happens on reset, which
  // is what every stored automation keeps until someone edits and saves it.
  resetActions: z.array(actionSchema).max(20).optional().nullable(),
  // Re-send this alert's notifications while it stays unhandled. Absent/null =
  // never repeats, which is every pre-feature automation.
  repeat: repeatConfigSchema.optional().nullable(),
});

type RuleInputRaw = z.infer<typeof ruleInputBaseSchema>;

/** Canonical (v2) rule input — what the service layer persists. */
export interface RuleInput {
  name: string;
  description: string | null;
  enabled: boolean;
  severity: (typeof SEVERITIES)[number];
  trigger: Trigger;
  scope: RuleScope;
  reset: ResetConfig;
  actions: EscalatableAction[];
  cooldownSec: number | null;
  messageTemplate: string | null;
  /** Refuse an acknowledgement with no note (enforced server-side). */
  requireAckNote: boolean;
  channels: string[];
  emailComposition: EmailComposition | null;
  /** As posted (legacy email tiers OR v2 tiers-of-actions) — stored verbatim;
   *  readers normalize through normalizeEscalationToV2. */
  escalation: EscalationConfig | EscalationV2Config | null;
  /** Severity bands (numeric triggers only); null = single-severity. */
  severityBands: SeverityBand[] | null;
  /** Band-transition notify policy; null = defaults. */
  bandNotify: BandNotify | null;
  /** Actions to run when the alert ENDS; null = nothing happens on reset. */
  resetActions: AutomationAction[] | null;
  /** Re-send while unhandled; null = never repeats. */
  repeat: RepeatConfig | null;
}

/** Preview input = RuleInput with trigger optional (scope-only preview mode).
 *  `id` (when editing) lets the carve-out preview exclude the rule itself. */
export type PreviewRuleInput = Omit<RuleInput, "trigger" | "name"> & {
  name: string;
  trigger?: Trigger;
  id?: string;
};

/** clearBehavior/clearAfterSec → v2 reset. Also sanitizes a provided reset:
 *  mode-irrelevant fields are stripped so stored shapes stay canonical. */
export function normalizeReset(
  reset: ResetConfig | null | undefined,
  clearBehavior?: string | null,
  clearAfterSec?: number | null,
): ResetConfig {
  if (reset) {
    if (reset.mode === "auto") {
      return { mode: "auto", clearThreshold: reset.clearThreshold ?? null, sustainSec: reset.sustainSec ?? null, sustainPolls: reset.sustainPolls ?? null };
    }
    if (reset.mode === "condition") {
      return { mode: "condition", condition: reset.condition ?? null, sustainSec: reset.sustainSec ?? null, sustainPolls: reset.sustainPolls ?? null };
    }
    if (reset.mode === "timed") return { mode: "timed", afterSec: reset.afterSec ?? null };
    if (reset.mode === "event") {
      // A missing pattern is kept as a null resetEvent rather than quietly
      // rewritten to "manual": the caller asked for a mode, and validateRuleV2
      // is where they get told it needs a pattern. Silently storing a different
      // reset than the one that was posted is the worse failure.
      return {
        mode: "event",
        resetEvent: reset.resetEvent?.actionPattern
          ? { actionPattern: reset.resetEvent.actionPattern, resourceType: reset.resetEvent.resourceType ?? null }
          : null,
      };
    }
    return { mode: "manual" };
  }
  const mode: ResetMode = clearBehavior === "auto" || clearBehavior === "timed" ? clearBehavior : "manual";
  if (mode === "timed") return { mode: "timed", afterSec: clearAfterSec ?? null };
  return mode === "auto" ? { mode: "auto" } : { mode: "manual" };
}

/** Legacy delivery targets → notify actions. The rule-level emailComposition
 *  is copied onto every converted action (the executor applies it only on
 *  email transports — matching the legacy behavior where non-email channels
 *  ignored it). */
export function targetsToNotifyActions(
  targets: DeliveryTarget[] | null | undefined,
  emailComposition: EmailComposition | null,
): AutomationAction[] {
  return (targets ?? []).map((t) => ({
    type: "notify" as const,
    channelId: t.channelId,
    ...(t.recipientUserIds?.length ? { recipientUserIds: t.recipientUserIds } : {}),
    ...(t.addresses?.length ? { addresses: t.addresses } : {}),
    ...(t.recipientScopeRegion !== undefined ? { recipientScopeRegion: t.recipientScopeRegion } : {}),
    ...(t.recipientDeviceRegion !== undefined ? { recipientDeviceRegion: t.recipientDeviceRegion } : {}),
    ...(t.recipientDeviceRegionLevels?.length ? { recipientDeviceRegionLevels: t.recipientDeviceRegionLevels } : {}),
    ...(t.recipientAssetContacts !== undefined ? { recipientAssetContacts: t.recipientAssetContacts } : {}),
    ...(t.recipientRoles?.length ? { recipientRoles: t.recipientRoles } : {}),
    ...(t.recipientAllUsers !== undefined ? { recipientAllUsers: t.recipientAllUsers } : {}),
    ...(t.recipientAllRegions !== undefined ? { recipientAllRegions: t.recipientAllRegions } : {}),
    ...(t.recipientRegions?.length ? { recipientRegions: t.recipientRegions } : {}),
    ...(t.recipientTags?.length ? { recipientTags: t.recipientTags } : {}),
    ...(t.respectUserPreference !== undefined ? { respectUserPreference: t.respectUserPreference } : {}),
    emailComposition: emailComposition ?? null,
  }));
}

/** notify actions → legacy delivery targets (per-action emailComposition is
 *  dropped — it has no legacy representation; the rule-level column carries
 *  the shared composition). api_call/script actions have no legacy mirror.
 *
 *  A MULTI-CHANNEL notify action expands to one target per channel, which is
 *  what lets a single action deliver by email and push at once without any
 *  reader below this line knowing an action can be plural — expandDeliveries
 *  sees exactly the shape it always saw. It is also why `channelIds` cannot
 *  repeat: two identical targets would be deduped by expandDeliveries' `seen`
 *  key anyway, but only after resolving their recipients twice. */
export function actionsToTargets(actions: AutomationAction[]): DeliveryTarget[] {
  return actions
    .filter((a): a is NotifyAction => a.type === "notify")
    .flatMap((a) => notifyChannelIds(a).map((channelId) => ({
      channelId,
      ...(a.recipientUserIds?.length ? { recipientUserIds: a.recipientUserIds } : {}),
      ...(a.addresses?.length ? { addresses: a.addresses } : {}),
      ...(a.recipientScopeRegion !== undefined ? { recipientScopeRegion: a.recipientScopeRegion } : {}),
      ...(a.recipientDeviceRegion !== undefined ? { recipientDeviceRegion: a.recipientDeviceRegion } : {}),
      // Without this line the field validates, persists, renders in the wizard
      // and routes to NOBODY — expandDeliveries only ever sees the target shape.
      ...(a.recipientDeviceRegionLevels?.length ? { recipientDeviceRegionLevels: a.recipientDeviceRegionLevels } : {}),
      ...(a.recipientAssetContacts !== undefined ? { recipientAssetContacts: a.recipientAssetContacts } : {}),
      ...(a.recipientRoles?.length ? { recipientRoles: a.recipientRoles } : {}),
      ...(a.recipientAllUsers !== undefined ? { recipientAllUsers: a.recipientAllUsers } : {}),
      ...(a.recipientAllRegions !== undefined ? { recipientAllRegions: a.recipientAllRegions } : {}),
      ...(a.recipientRegions?.length ? { recipientRegions: a.recipientRegions } : {}),
      ...(a.recipientTags?.length ? { recipientTags: a.recipientTags } : {}),
      ...(a.respectUserPreference !== undefined ? { respectUserPreference: a.respectUserPreference } : {}),
    })));
}

/** The lossless legacy projection of a v2 rule, kept mirrored on the legacy
 *  columns at save time so pre-wizard UIs and restored backups stay coherent. */
export function legacyMirrorOfV2(
  reset: ResetConfig,
  actions: AutomationAction[],
): { clearBehavior: (typeof CLEAR_BEHAVIORS)[number]; clearAfterSec: number | null; targets: DeliveryTarget[] } {
  return {
    // "condition" and "event" have no legacy representation — "auto" is the
    // closest semantic (clears without operator action) for pre-wizard readers.
    clearBehavior: reset.mode === "condition" || reset.mode === "event" ? "auto" : reset.mode,
    clearAfterSec: reset.mode === "timed" ? (reset.afterSec ?? null) : null,
    targets: actionsToTargets(actions),
  };
}

function normalizeRuleInputCore(raw: Omit<RuleInputRaw, "trigger">): Omit<RuleInput, "trigger"> {
  return {
    name: raw.name,
    description: raw.description ?? null,
    enabled: raw.enabled,
    severity: raw.severity,
    scope: raw.scope,
    reset: normalizeReset(raw.reset, raw.clearBehavior, raw.clearAfterSec),
    // Legacy body (targets, no actions) folded forward. The audit-Event action
    // is added by withEventAction() at the call sites, which know the trigger.
    actions: raw.actions ?? targetsToNotifyActions(raw.targets, raw.emailComposition ?? null),
    cooldownSec: raw.cooldownSec ?? null,
    messageTemplate: raw.messageTemplate ?? null,
    requireAckNote: raw.requireAckNote === true,
    channels: raw.channels,
    emailComposition: raw.emailComposition ?? null,
    escalation: raw.escalation ?? null,
    severityBands: raw.severityBands?.length ? raw.severityBands : null,
    bandNotify: raw.bandNotify ?? null,
    // Anything not copied here is silently dropped by the transform.
    resetActions: raw.resetActions?.length ? raw.resetActions : null,
    repeat: raw.repeat ?? null,
  };
}

/** Cross-field validation over the NORMALIZED v2 shape. */
/** Severity-band cross-field validation: numeric ordered trigger only, band
 *  thresholds monotonic in the operator direction, severities strictly
 *  increasing above the base. */
function validateSeverityBands(
  v: { trigger?: Trigger; severity?: Severity; severityBands?: SeverityBand[] | null },
  ctx: z.RefinementCtx,
): void {
  const bands = v.severityBands;
  if (!bands || bands.length === 0) return;
  const t = v.trigger;
  if (!t || (t.type !== "asset_metric" && t.type !== "host_metric")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["severityBands"], message: "severity bands apply only to numeric metric triggers (asset metric / Polaris host)" });
    return;
  }
  // A boolean metric has exactly two possible values, so a "strictly increasing
  // threshold ladder" over it can't mean anything — caught explicitly (rather
  // than falling through to the ordered-operator message below) because an
  // operator who wrote `>= 1` on a state flag needs to be told the metric is the
  // problem, not the comparator.
  if (t.type === "asset_metric" && isBooleanMetric(t.metric)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["severityBands"], message: "severity bands don't apply to a 0/1 state metric — it has only two values; use separate automations for different severities" });
    return;
  }
  if (t.operator === "==" || t.operator === "!=") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["severityBands"], message: "severity bands need an ordered operator (>, >=, <, <=)" });
    return;
  }
  // Severities must STRICTLY INCREASE tier-over-tier (the "only increase
  // severity" rule). Tiers may carry their own ordered operator (they share the
  // trigger's sampling); the value is compared to each tier and the most-severe
  // MET tier wins, so per-tier thresholds need not be monotonic.
  let prevRank = severityRank(v.severity ?? "warning");
  bands.forEach((b, i) => {
    const rank = severityRank(b.severity);
    if (rank <= prevRank) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["severityBands", i, "severity"], message: "each added severity must be higher than the one before it" });
    }
    if (b.operator && (b.operator === "==" || b.operator === "!=")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["severityBands", i, "operator"], message: "severity tiers need an ordered operator (>, >=, <, <=)" });
    }
    prevRank = rank;
  });
}

/**
 * A repeat only ever re-runs NOTIFY actions (REPEATABLE_ACTION_TYPES), so an
 * automation that has none anywhere would save a repeat interval that can never
 * send anything — a dead setting that looks alive in the wizard. Refuse it at
 * save rather than letting an operator discover the silence during an incident.
 *
 * Band actions count: a banded automation whose notifies live only on its
 * severity bands still has something to re-send once it is firing in a band.
 */
function validateRepeat(
  v: { repeat?: RepeatConfig | null; actions?: AutomationAction[] | null; severityBands?: SeverityBand[] | null },
  ctx: z.RefinementCtx,
): void {
  if (!v.repeat) return;
  const repeatable = new Set<string>(REPEATABLE_ACTION_TYPES);
  const hasNotify =
    (v.actions ?? []).some((a) => repeatable.has(a.type)) ||
    (v.severityBands ?? []).some((b) => (b.actions ?? []).some((a) => repeatable.has(a.type)));
  if (!hasNotify) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["repeat"],
      message:
        "Repeating an alert re-sends its notifications, so the automation needs at least one Notify action. " +
        "API calls and scripts deliberately run only once, when the alert first fires.",
    });
  }
}

/**
 * `missedPolls` is down-detection AUTHORITY, so it may only sit where the
 * monitoring layer will actually read it: a bare `monitorStatus == down`
 * trigger. Two rejections, both because the alternative is a number that looks
 * configured and silently governs nothing:
 *
 *  - on any other state field / comparator / value (e.g. `== warning`), where
 *    recordProbeResult would never consult it;
 *  - inside a multi-leaf COMPOSITE, where "down" would be defined partly by a
 *    condition the probe path cannot evaluate (a CPU reading, another device's
 *    state). Note a SINGLE-leaf composite is not rejected — it has already
 *    collapsed to a bare trigger by the time this runs (collapseCompositeTrigger
 *    in the input transform), which is exactly how the wizard submits.
 */
function validateMissedPolls(trigger: Trigger | undefined, ctx: z.RefinementCtx): void {
  if (!trigger) return;
  if (trigger.type === "asset_state") {
    if (trigger.missedPolls != null && !isDownDetectionTrigger(trigger)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trigger", "missedPolls"],
        message:
          'a missed-poll count only applies to a "monitor status is down" automation — it is the definition of down for the devices that automation covers',
      });
    }
    return;
  }
  if (trigger.type === "composite") {
    const offender = collectTriggerLeaves(trigger).find(
      (l) => l.type === "asset_state" && (l as { missedPolls?: number }).missedPolls != null,
    );
    if (offender) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trigger", "children"],
        message:
          "a missed-poll count cannot sit inside a multi-condition trigger — down detection is decided by the probe loop, which can only see whether the device answered. Put the count on an automation whose only condition is \"monitor status is down\".",
      });
    }
  }
}

function validateRuleV2(
  v: {
    trigger?: Trigger;
    reset: ResetConfig;
    severity?: Severity;
    severityBands?: SeverityBand[] | null;
    bandNotify?: BandNotify | null;
    actions?: AutomationAction[] | null;
    repeat?: RepeatConfig | null;
  },
  ctx: z.RefinementCtx,
): void {
  const { trigger, reset } = v;
  if (trigger?.type === "composite") validateCompositeTrigger(trigger, ctx);
  validateSeverityBands(v, ctx);
  validateRepeat(v, ctx);
  validateMissedPolls(trigger, ctx);
  if (reset.mode === "timed" && reset.afterSec == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reset", "afterSec"], message: "timed reset requires afterSec" });
  }
  if (reset.mode === "event") {
    // The counterpart-Event reset is the answer for the two trigger types that
    // fire on an instant, and only those — see TRIGGER_TYPES_WITH_RESET_EVENT.
    if (!reset.resetEvent?.actionPattern?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reset", "resetEvent", "actionPattern"], message: "an event reset requires the action pattern of the event that clears it" });
    }
    if (trigger && !triggerTypeAllowsResetEvent(trigger.type)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reset", "resetEvent"],
        message: `resetting on an audit event only applies to event and change triggers — a ${trigger.type} trigger recovers on its own reading`,
      });
    }
  }
  if (reset.mode === "condition") {
    // A custom reset tree needs a trigger with a CONTINUOUS condition to
    // recover from: event/change fire on an instant and carry no reading, so
    // there would be nothing for the tree to watch (their reset modes are
    // timed/manual only). Every other trigger type is eligible — a single
    // metric/state trigger as much as a composite, since the tree is just a
    // more expressive spelling of "the trigger is no longer true".
    if (!reset.condition) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reset", "condition"], message: "condition reset requires a condition tree" });
    } else if (trigger && !triggerTypeAllowsResetCondition(trigger.type)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reset", "condition"],
        message: `a custom reset condition needs a trigger with a continuous condition — an ${trigger.type} trigger resets on a timer or by hand`,
      });
    } else {
      const stats = triggerConditionStats(reset.condition);
      if (stats.depth > 3) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reset", "condition"], message: "reset condition groups nest at most 3 deep" });
      }
      if (stats.leaves > 10) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reset", "condition"], message: "at most 10 conditions per reset tree" });
      }
      // Kind coherence: a Polaris-host trigger recovers on host readings and a
      // device trigger on device readings. Mixing them has the engine resolve a
      // leaf against assets that can never report it, so the tree reads as
      // permanently false — an alert that could only ever be cleared by hand.
      if (trigger) {
        const triggerIsHost = trigger.type === "host_metric" || (trigger.type === "composite" && trigger.kind === "host");
        const badLeaf = collectTriggerLeaves(reset.condition).find((l) =>
          triggerIsHost ? l.type !== "host_metric" : l.type === "host_metric",
        );
        if (badLeaf) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["reset", "condition"],
            message: "reset conditions must match the trigger's kind (device vs Polaris-host conditions)",
          });
        }
      }
    }
  }
  if (reset.mode === "auto" && reset.clearThreshold != null && trigger) {
    if (trigger.type !== "asset_metric" && trigger.type !== "host_metric") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reset", "clearThreshold"],
        message: "a clear threshold (hysteresis) only applies to numeric metric triggers",
      });
      return;
    }
    const op = trigger.operator;
    const t = trigger.threshold;
    const c = reset.clearThreshold;
    if (op === "==" || op === "!=") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reset", "clearThreshold"],
        message: `a clear threshold cannot be combined with the ${op} operator`,
      });
    } else if ((op === ">" || op === ">=") && c > t) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reset", "clearThreshold"],
        message: `clear threshold must be at or below the fire threshold (${t}) for operator ${op}`,
      });
    } else if ((op === "<" || op === "<=") && c < t) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reset", "clearThreshold"],
        message: `clear threshold must be at or above the fire threshold (${t}) for operator ${op}`,
      });
    }
  }
}

/**
 * Re-add the audit-Event action to a body that arrived WITHOUT an actions array
 * — a legacy shape, or a minimal API create. Before the Event became an action
 * such a rule still wrote `notification.triggered`, so omitting it here would
 * silently drop auditing for those callers.
 *
 * An EXPLICIT `actions: []` is respected (`??` only fires on undefined), which
 * is how an API caller opts out. Skipped for event/change triggers, matching
 * migration 20260810120000_event_action: the event tail writes no Events, so
 * the action would be dead weight the builder then warns about.
 */
function withEventAction<T extends { actions: EscalatableAction[] }>(
  core: T,
  rawActions: unknown,
  trigger: unknown,
): T {
  if (rawActions !== undefined) return core;
  if (isEventDrivenTrigger(trigger)) return core;
  return { ...core, actions: [...core.actions, { type: "event" as const }] };
}

export const ruleInputSchema = ruleInputBaseSchema
  .transform((raw): RuleInput => ({
    trigger: collapseCompositeTrigger(raw.trigger),
    ...withEventAction(normalizeRuleInputCore(raw), raw.actions, raw.trigger),
  }))
  .superRefine(validateRuleV2);

// Preview accepts partial drafts: name defaulted, trigger optional (a
// scope-only body lists the matched devices — the wizard's Step-2 preview).
export const previewInputSchema = ruleInputBaseSchema
  .extend({
    name: z.string().min(1).max(200).default("Draft automation"),
    trigger: triggerSchema.optional(),
    // When editing, the rule's own id so the carve-out preview excludes itself.
    id: z.string().max(100).optional(),
  })
  .transform((raw): PreviewRuleInput => ({
    trigger: raw.trigger ? collapseCompositeTrigger(raw.trigger) : undefined,
    id: raw.id,
    ...withEventAction(normalizeRuleInputCore(raw), raw.actions, raw.trigger),
  }))
  .superRefine(validateRuleV2);

// ─── Read-path normalizer (DB row → v2 view) ────────────────────────────────

/** The v2 view of a stored rule row. */
export interface RuleV2View {
  reset: ResetConfig;
  actions: EscalatableAction[];
  /** Escalation as v2 tiers-of-actions (legacy tiers converted); null when unset. */
  escalation: EscalationV2Config | null;
  /** Severity bands (numeric triggers); null = single-severity. */
  severityBands: SeverityBand[] | null;
  /** Band-transition notify policy; null = defaults. */
  bandNotify: BandNotify | null;
  /** Actions to run when the alert ENDS; null = nothing happens on reset. */
  resetActions: AutomationAction[] | null;
  /** Re-send while unhandled; null = never repeats. */
  repeat: RepeatConfig | null;
}

/** Legacy escalation tier → v2 tier of one notify action. Tier-level template
 *  overrides become the action's emailComposition (only the fields the tier
 *  set — per-field fallback to the rule composition stays with the executor). */
export function normalizeEscalationToV2(escalation: unknown): EscalationV2Config | null {
  if (!escalation || typeof escalation !== "object") return null;
  const raw = escalation as { stopOn?: unknown; tiers?: unknown };
  if (!Array.isArray(raw.tiers) || raw.tiers.length === 0) return null;
  // Already v2? (tiers carry actions[])
  if ((raw.tiers[0] as { actions?: unknown })?.actions !== undefined) {
    const parsed = escalationV2Schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }
  const parsedLegacy = escalationSchema.safeParse(raw);
  if (!parsedLegacy.success) return null;
  return {
    stopOn: parsedLegacy.data.stopOn,
    tiers: parsedLegacy.data.tiers.map((t) => {
      const hasComposition =
        t.subjectTemplate != null || t.bodyTextTemplate != null || t.bodyHtmlTemplate != null || t.cc != null || t.bcc != null;
      return {
        afterMin: t.afterMin,
        repeatEveryMin: t.repeatEveryMin ?? null,
        maxRepeats: t.maxRepeats ?? null,
        actions: [
          {
            type: "notify" as const,
            channelId: t.channelId,
            ...(t.to.recipientUserIds?.length ? { recipientUserIds: t.to.recipientUserIds } : {}),
            ...(t.to.addresses?.length ? { addresses: t.to.addresses } : {}),
            emailComposition: hasComposition
              ? {
                  subjectTemplate: t.subjectTemplate ?? null,
                  bodyTextTemplate: t.bodyTextTemplate ?? null,
                  bodyHtmlTemplate: t.bodyHtmlTemplate ?? null,
                  cc: t.cc ?? null,
                  bcc: t.bcc ?? null,
                }
              : null,
          },
        ],
      };
    }),
  };
}

/**
 * Normalize a stored rule row to the v2 view. Prefers the persisted v2
 * columns; falls back to converting the legacy columns (pre-v2 rows, restored
 * backups). Every reader — engine, escalation sweep, routes — goes through
 * this so v1 and v2 rows behave identically.
 */
/** event/change triggers — the engine's event tail writes no audit Events. */
function isEventDrivenTrigger(trigger: unknown): boolean {
  const t = (trigger as { type?: string } | null | undefined)?.type;
  return t === "event" || t === "change";
}

export function normalizeRuleToV2(row: {
  clearBehavior?: string | null;
  clearAfterSec?: number | null;
  /** Read only to decide whether the injected audit-Event action belongs —
   *  the event tail writes no Events, so an event/change rule must not get one. */
  trigger?: unknown;
  targets?: unknown;
  emailComposition?: unknown;
  escalation?: unknown;
  reset?: unknown;
  actions?: unknown;
  severityBands?: unknown;
  bandNotify?: unknown;
  resetActions?: unknown;
  repeat?: unknown;
}): RuleV2View {
  const storedReset = row.reset ? resetSchema.safeParse(row.reset) : null;
  const reset = storedReset?.success
    ? normalizeReset(storedReset.data)
    : normalizeReset(null, row.clearBehavior, row.clearAfterSec);

  const emailComposition = row.emailComposition
    ? (emailCompositionSchema.safeParse(row.emailComposition).success
        ? (row.emailComposition as EmailComposition)
        : null)
    : null;

  let actions: EscalatableAction[];
  if (Array.isArray(row.actions)) {
    actions = row.actions
      .map((a) => escalatableActionSchema.safeParse(a))
      .filter((r): r is { success: true; data: EscalatableAction } => r.success)
      .map((r) => r.data);
  } else {
    // Pre-v2 row (or a restored pre-upgrade backup): fold legacy targets
    // forward and re-add the audit Event the engine now gates on, so an
    // un-migrated row keeps behaving exactly as it did. Mirrors migration
    // 20260810120000_event_action, carve-out included — an event/change
    // automation is driven BY Events and the tail writes none.
    const targets = Array.isArray(row.targets) ? (row.targets as DeliveryTarget[]) : [];
    actions = targetsToNotifyActions(targets, emailComposition) as EscalatableAction[];
    if (!isEventDrivenTrigger(row.trigger)) actions = [...actions, { type: "event" as const }];
  }

  const bands = Array.isArray(row.severityBands)
    ? row.severityBands
        .map((b) => severityBandSchema.safeParse(b))
        .filter((r): r is { success: true; data: SeverityBand } => r.success)
        .map((r) => r.data)
    : [];
  const severityBands = bands.length ? bands : null;
  const bandNotify = row.bandNotify && bandNotifySchema.safeParse(row.bandNotify).success
    ? bandNotifySchema.parse(row.bandNotify)
    : null;

  // Reset actions have no legacy counterpart (like resolvedActions), so an
  // un-migrated row simply has none and stays silent on reset.
  const resetParsed = Array.isArray(row.resetActions)
    ? row.resetActions
        .map((a) => actionSchema.safeParse(a))
        .filter((r): r is { success: true; data: AutomationAction } => r.success)
        .map((r) => r.data)
    : [];
  const resetActions = resetParsed.length ? resetParsed : null;

  // Defensive parse, like the bands above: a hand-edited or restored row that
  // no longer matches the schema reads as "never repeats" rather than throwing
  // on the engine's hot path.
  //
  // A malformed QUIET blob is the one part that retries without it. Quiet time
  // only ever PAUSES reminders, so letting a bad window take the whole repeat
  // config down would turn "reminders pause overnight" into "this alert never
  // reminds anyone again" — the opposite of what the operator asked for, and
  // invisible until someone missed an outage. Dropping the windows fails in
  // the loud direction instead: reminders come at their normal cadence and
  // the automation's own page shows no quiet time, which is a bug an operator
  // can see.
  const repeatParsed = row.repeat ? repeatConfigSchema.safeParse(row.repeat) : null;
  let repeat = repeatParsed?.success ? repeatParsed.data : null;
  if (
    repeatParsed &&
    !repeatParsed.success &&
    typeof row.repeat === "object" &&
    !Array.isArray(row.repeat) &&
    row.repeat !== null &&
    "quiet" in (row.repeat as Record<string, unknown>)
  ) {
    const { quiet: _dropped, ...withoutQuiet } = row.repeat as Record<string, unknown>;
    const retry = repeatConfigSchema.safeParse(withoutQuiet);
    if (retry.success) repeat = retry.data;
  }

  return { reset, actions, escalation: normalizeEscalationToV2(row.escalation), severityBands, bandNotify, resetActions, repeat };
}

// ─── Canonical action walk + escalation-chain selection ─────────────────────
// Actions live in EIGHT places on a rule: top-level actions, each top-level
// action's escalation tiers, the rule-level escalation tiers, each severity
// band's actions, each band action's escalation tiers, each band-level
// escalation tiers, bandNotify.resolvedActions, and resetActions (what runs
// when the alert ends). Every consumer that must
// see ALL of them (the automationScripts route gate, assertActionRefs'
// channel/SSRF/script checks, ruleWantsAssetDetail) walks through
// allRuleActionRefs so a new action location can't silently escape a gate.

/** The minimal rule shape the walk needs — RuleInput and normalized rows both fit. */
export interface RuleActionCarrier {
  actions?: EscalatableAction[] | null;
  escalation?: unknown;
  severityBands?: SeverityBand[] | null;
  bandNotify?: BandNotify | null;
  resetActions?: AutomationAction[] | null;
}

/**
 * An action's own escalation chain, or undefined for types that can't carry
 * one. `event` has no `escalation` key at all (an audit Event is instantaneous
 * — nothing to chase if it goes unhandled), so the discriminated union makes a
 * bare `a.escalation` a type error. This is the single place that narrows.
 */
function actionEscalation(a: EscalatableAction): unknown {
  return "escalation" in a ? a.escalation : undefined;
}

export interface RuleActionRef {
  action: AutomationAction;
  /** Human label for save-time validation errors ("Action 2 escalation tier 1: …"). */
  label: string;
}

export function allRuleActionRefs(rule: RuleActionCarrier): RuleActionRef[] {
  const out: RuleActionRef[] = [];
  const addTiers = (esc: unknown, prefix: string) => {
    (normalizeEscalationToV2(esc)?.tiers ?? []).forEach((t, ti) => {
      t.actions.forEach((a) => out.push({ action: a, label: `${prefix} escalation tier ${ti + 1}` }));
    });
  };
  const addActions = (list: EscalatableAction[] | null | undefined, prefix: string) => {
    (list ?? []).forEach((a, i) => {
      out.push({ action: a, label: `${prefix} ${i + 1}` });
      addTiers(actionEscalation(a), `${prefix} ${i + 1}`);
    });
  };
  addActions(rule.actions, "Action");
  addTiers(rule.escalation, "Rule");
  for (const b of rule.severityBands ?? []) {
    addActions(b.actions, `${b.severity} band action`);
    addTiers(b.escalation, `${b.severity} band`);
  }
  (rule.bandNotify?.resolvedActions ?? []).forEach((a, i) => out.push({ action: a, label: `Resolved action ${i + 1}` }));
  (rule.resetActions ?? []).forEach((a, i) => out.push({ action: a, label: `Reset action ${i + 1}` }));
  return out;
}

/** Whether ANY escalation chain exists anywhere on the rule (rule-level,
 *  per-action, band-level, or band-per-action). Drives ruleWantsContext —
 *  a rule with any chain needs the templateCtx snapshot for the sweep. */
export function ruleHasAnyEscalation(rule: RuleActionCarrier): boolean {
  const has = (esc: unknown) => (normalizeEscalationToV2(esc)?.tiers.length ?? 0) > 0;
  if (has(rule.escalation)) return true;
  if ((rule.actions ?? []).some((a) => has(actionEscalation(a)))) return true;
  return (rule.severityBands ?? []).some((b) => has(b.escalation) || (b.actions ?? []).some((a) => has(actionEscalation(a))));
}

/** One due-sweepable escalation chain: the rule/band-LEVEL chain (key "") or a
 *  per-action chain (key "a<i>", i = index in the severity's effective action
 *  list). Tier state in Notification.escalationState.tiers is keyed by
 *  escalationTierStateKey(chain.key, tierIdx). */
export interface EscalationChain {
  key: string;
  escalation: EscalationV2Config;
}

/** Escalation-state key for a tier: the level chain keeps the bare numeric
 *  keys pre-feature rows already carry; per-action chains use "a<i>:t<j>". */
export function escalationTierStateKey(chainKey: string, tierIdx: number): string {
  return chainKey ? `${chainKey}:t${tierIdx}` : String(tierIdx);
}

/**
 * Where the repeat pass keeps its progress inside
 * `Notification.escalationState.tiers`.
 *
 * Shares that map with the escalation tiers, and is collision-free by
 * construction: the level chain produces bare numerics ("0", "1"), per-action
 * chains produce "a<i>:t<j>", and neither can ever be this string.
 */
export const REPEAT_STATE_KEY = "repeat";

/**
 * Which action types a REPEAT re-runs.
 *
 * Notify only, and the asymmetry with escalation is deliberate. An escalation
 * tier's actions were authored AS a follow-up; the base action list was
 * authored as "what happens when this fires", and in this codebase that list
 * routinely contains "open a ticket" (api_call) and "run the remediation
 * script" (script — the Polaris service account on the server, LocalSystem or
 * the agent user on the device). Repeats are unbounded, so re-running those
 * every N minutes on an alert nobody has looked at yet is how a weekend
 * produces 300 tickets and 300 script executions. The blast radius is not
 * symmetric with an extra email.
 *
 * `event` is excluded too, and would be a no-op anyway: executeActions treats
 * it as one (the engine's fire path owns the audit Event), so including it would
 * only mislead a reader.
 */
export const REPEATABLE_ACTION_TYPES = ["notify"] as const;

/**
 * All escalation chains active at a given alert severity — mirrors the
 * engine's tierForSeverity band semantics: at a band severity, the band's
 * actions (else the base actions — the band fallback) carry the per-action
 * chains, and the band's own level chain (else the rule's) is the "" chain.
 * Shared by the escalation sweep; band transitions reset escalationState, so
 * per-action keys never collide across bands.
 */
/**
 * The action list in force at a given alert severity: a band's own actions when
 * it has any, else the rule's.
 *
 * Extracted because the repeat pass needs exactly this rule too, and the band
 * fallback ("only when band.actions is non-empty") was already written out in
 * more than one place. A second copy is how a reminder would come to notify a
 * different set of people than the alert did.
 */
export function effectiveActionsForSeverity(
  rule: RuleActionCarrier & { severity: string },
  severity: string,
): EscalatableAction[] {
  if (severity !== rule.severity) {
    const band = (rule.severityBands ?? []).find((b) => b.severity === severity);
    if (band?.actions?.length) return band.actions;
  }
  return rule.actions ?? [];
}

export function escalationChainsForSeverity(
  rule: RuleActionCarrier & { severity: string },
  severity: string,
): EscalationChain[] {
  const effActions = effectiveActionsForSeverity(rule, severity);
  let levelEsc = normalizeEscalationToV2(rule.escalation);
  if (severity !== rule.severity) {
    const band = (rule.severityBands ?? []).find((b) => b.severity === severity);
    const bandEsc = band ? normalizeEscalationToV2(band.escalation) : null;
    if (bandEsc?.tiers.length) levelEsc = bandEsc;
  }
  const chains: EscalationChain[] = [];
  if (levelEsc?.tiers.length) chains.push({ key: "", escalation: levelEsc });
  effActions.forEach((a, i) => {
    const esc = normalizeEscalationToV2(actionEscalation(a));
    if (esc?.tiers.length) chains.push({ key: `a${i}`, escalation: esc });
  });
  return chains;
}

// ─── Follow-up policy (what happens if nobody acts) ─────────────────────────

/**
 * What an alert's own notification should tell its reader about what happens
 * NEXT — whether it will keep reminding them, and whether it will go over
 * their head if they leave it.
 *
 * WHY THIS IS IN THE ALERT AT ALL. Repeat and escalation are the two settings
 * that change what IGNORING an alert costs, and until now they were visible
 * only to whoever edited the automation. The person holding the phone at
 * 3am is usually not that person, and the two questions they actually have —
 * "will this stop bothering me on its own?" and "is my manager about to get
 * this?" — had no answer anywhere in the message. Both change what a
 * reasonable reader does next, which is what earns them a line in the body.
 *
 * SEVERITY-RESOLVED, not rule-level. A banded alert's escalation is the
 * band's when the band declares one (escalationChainsForSeverity), so the
 * sentence has to be built for the severity the alert actually fired at or a
 * critical alert would advertise the warning tier's chain.
 *
 * SNAPSHOT, not a live read. These strings are built at fire time into
 * Notification.templateCtx alongside every other token, so a reminder or an
 * escalation of the same alert re-renders the policy the alert was RAISED
 * under. An operator who edits the automation mid-incident changes what
 * happens next but not what the already-sent messages claimed — which is the
 * honest reading of an email that has already left.
 *
 * Both are "" when not configured, so the default bodies' rows prune away
 * (pruneEmptyRows / pruneEmptyTextLines) and an alert with no follow-up says
 * nothing rather than saying "none".
 */
export interface FollowUpPolicy {
  /** e.g. "Reminders every 15 minutes until acknowledged." */
  repeat: string;
  /** e.g. "Escalates in 30 minutes if not acknowledged." */
  escalation: string;
}

/** "1 minute" / "15 minutes" / "2 hours" — whole hours read as hours because
 *  an escalation set at 120 minutes was configured as two hours. */
function humanMinutes(min: number): string {
  if (min >= 60 && min % 60 === 0) {
    const h = min / 60;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  return min === 1 ? "1 minute" : `${min} minutes`;
}

/** "acknowledged" / "cleared" — the word the operator picked in the builder. */
const stopWord = (stopOn: string): string => (stopOn === "clear" ? "cleared" : "acknowledged");

export function followUpPolicy(
  rule: RuleActionCarrier & { severity: string; repeat?: RepeatConfig | null },
  severity: string,
): FollowUpPolicy {
  let repeat = "";
  const r = rule.repeat;
  if (r && r.everyMin > 0) {
    // The cut-off is stated because it is the difference between "this will
    // chase you until you deal with it" and "this goes quiet at 8 hours",
    // and a reader planning their night needs the second one.
    // The quiet time is stated in the SAME sentence rather than a row of its
    // own: "every 15 minutes" and "paused overnight" are one answer to one
    // question ("when will this chase me again?"), and a reader who sees only
    // the cadence plans their night around a reminder that isn't coming.
    const quiet = describeQuietTime(r.quiet);
    repeat = `Reminders every ${humanMinutes(r.everyMin)} until ${stopWord(r.stopOn)}` +
      (quiet ? `, paused ${quiet}` : "") +
      (r.stopAfterHours ? `, for up to ${r.stopAfterHours === 1 ? "1 hour" : `${r.stopAfterHours} hours`}.` : ".");
  }

  // EARLIEST first tier across every chain that applies — rule-level, band-level
  // and per-action chains all run independently, so the honest answer to "when
  // does this go over my head" is whichever fires first, not the rule-level
  // one. Tiers within a chain are not ordered by the schema, hence the min.
  let escalation = "";
  const chains = escalationChainsForSeverity(rule, severity);
  if (chains.length > 0) {
    let firstMin = Infinity;
    let stopOn = "acknowledge";
    let steps = 0;
    for (const c of chains) {
      steps += c.escalation.tiers.length;
      for (const t of c.escalation.tiers) {
        if (t.afterMin < firstMin) { firstMin = t.afterMin; stopOn = c.escalation.stopOn; }
      }
    }
    if (Number.isFinite(firstMin)) {
      escalation = `Escalates in ${humanMinutes(firstMin)} if not ${stopWord(stopOn)}` +
        (steps > 1 ? `, then through ${steps - 1} more step${steps - 1 === 1 ? "" : "s"}.` : ".");
    }
  }
  return { repeat, escalation };
}

/** Trigger categories whose SUBJECT is an asset the scope selects (vs. event/host).
 *  Composite triggers are scoped iff kind="asset" — use isAssetScopedTrigger.
 *
 *  `event` is deliberately absent even though an event automation may now carry
 *  a device filter (business rule 46). This list answers "is this automation
 *  ABOUT a device", which is what the asset-details Alerts tab asks — and an
 *  all-assets `integration.discover.error` automation is about an integration,
 *  not about each of 2000 devices it would otherwise be listed under. */
export const ASSET_SCOPED_TRIGGER_TYPES = ["asset_metric", "asset_state", "change"] as const;

/** Whether a trigger selects devices via `scope` (composite depends on kind). */
export function isAssetScopedTrigger(trigger: Trigger): boolean {
  if (trigger.type === "composite") return trigger.kind === "asset";
  return (ASSET_SCOPED_TRIGGER_TYPES as readonly string[]).includes(trigger.type);
}

// ─── Display metadata (builder UI only; engine validates via the Zod schemas) ──
// Human label + unit per metric, for both asset_metric and host_metric.
/**
 * Metrics that are a RATIO OVER A WINDOW rather than a reading with an optional
 * aggregation — the window is the measurement itself. The builder uses this to
 * relabel its base time field as "History", hide the (ignored) aggregation
 * control, and offer a SEPARATE optional "Sustained for" hold (2026-08-20 —
 * History and sustain are two axes: how long each reading measures over, and
 * how long readings must stay over the threshold; severity tiers keep their own
 * holds per rule 19). The engine uses the window exactly instead of applying
 * its `latest`-sample lookback floor. Exposed on /automations/schema as
 * `windowedRatioMetrics`.
 */
export const WINDOWED_RATIO_METRICS = ["probeLossPct"] as const;

/**
 * The probe-loss measurement window, resolved exactly the way the engine
 * measures it: the configured `windowSec` floored at the 5-minute minimum (a
 * ratio always needs a few probes behind it), defaulted to 15 minutes when the
 * trigger carries none — pre-History rules, where the minutes went to
 * `forDurationSec` instead, and hand-written ones. Shared by the engine's
 * `probeLossPct` resolver and the alert-email loss chart, so the chart's window
 * can never disagree with the window the alert was measured over.
 */
export const PROBE_LOSS_DEFAULT_WINDOW_SEC = 15 * 60;
export const PROBE_LOSS_MIN_WINDOW_SEC = 5 * 60;

/**
 * The saturation ceiling a trigger uses when it states none. 100 means only a
 * TOTAL outage is suppressed, so a rule authored before the control existed
 * behaves exactly as it did.
 */
export const DEFAULT_READING_CEILING_PCT = 100;

/**
 * Is this reading at or above the trigger's saturation ceiling, i.e. should it
 * be treated as no reading at all?
 *
 * ">= " rather than "> " on purpose: the operator-facing control reads "ignore
 * at or above", and a ceiling of 100 has to suppress a reading of exactly 100 —
 * suppressing only what EXCEEDS 100 would make the default do nothing.
 *
 * Only continuous asset-metric triggers have one. A non-numeric reading is not
 * saturated, it is unmeasurable, and the caller decides what that means.
 */
export function readingAtOrAboveCeiling(trigger: unknown, value: number | null): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const t = trigger as { type?: string; ignoreAtOrAbove?: unknown } | null;
  if (!t || t.type !== "asset_metric") return false;
  const ceiling = typeof t.ignoreAtOrAbove === "number" && Number.isFinite(t.ignoreAtOrAbove)
    ? t.ignoreAtOrAbove
    : DEFAULT_READING_CEILING_PCT;
  return value >= ceiling;
}

export function probeLossWindowSec(windowSec: number | null | undefined): number {
  return typeof windowSec === "number" && windowSec > 0
    ? Math.max(windowSec, PROBE_LOSS_MIN_WINDOW_SEC)
    : PROBE_LOSS_DEFAULT_WINDOW_SEC;
}

/**
 * The History window of a stored rule's probe-loss condition, in seconds — or
 * null when the trigger has no such condition (then a loss chart in its email,
 * if any, keeps the default last-hour window). Walks the raw stored `trigger`
 * JSON tolerantly: a flat `asset_metric` trigger or any `probeLossPct` leaf of
 * a composite tree (the widest window wins when a tree improbably carries two).
 * Never throws — this runs on the delivery drain, best-effort by contract.
 */
export function probeLossWindowSecFromTrigger(trigger: unknown): number | null {
  let found: number | null = null;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n.type === "asset_metric" && n.metric === "probeLossPct") {
      const w = probeLossWindowSec(typeof n.windowSec === "number" ? n.windowSec : null);
      found = found === null ? w : Math.max(found, w);
    } else if (n.type === "composite" && Array.isArray(n.children)) {
      for (const c of n.children) visit(c);
    } else if (Array.isArray(n.children)) {
      // A nested group inside a composite tree has no `type` of its own.
      for (const c of n.children) visit(c);
    }
  };
  visit(trigger);
  return found;
}

export const METRIC_META: Record<string, { label: string; unit: string }> = {
  // asset_metric
  cpuPct: { label: "CPU utilization", unit: "%" },
  memPct: { label: "Memory utilization", unit: "%" },
  memUsedBytes: { label: "Memory used", unit: "bytes" },
  sessionCount: { label: "Active sessions", unit: "" },
  responseTimeMs: { label: "Response time", unit: "ms" },
  uptimeSec: { label: "Uptime", unit: "sec" },
  // Probe-failure ratio over the trigger window (failed probes / total probes),
  // the same computation as the dashboard Packet Loss widget — works for ANY
  // monitored asset (switch/AP/server), not just SD-WAN. Windowed ratio: the
  // window is the measurement interval, so aggregation doesn't apply. Alert
  // with ">", e.g. > 25%. This metric reports ONLY on a device that is
  // currently answering (monitorStatus up/warning), and only from its first
  // successful probe inside the window — an outage is the asset-down condition,
  // not packet loss, so one outage raises one alert (business rule 29).
  probeLossPct: { label: "Packet loss (probe)", unit: "%" },
  hwSensorValue: { label: "Hardware sensor value", unit: "(sensor unit)" },
  // The device's OWN alarm bit for the sensor, not a threshold Polaris
  // invents — `AssetHardwareSensorSample.alarmStatus`, already collected by the
  // FortiOS REST sensor-info and SNMP fgHwSensorTable paths and shown as the
  // System tab's STATUS column. Alerting on it beats a threshold on the reading:
  // the device knows its own per-model limits, and for a fan tray or a PSU the
  // health is IN this bit rather than in any comparable number.
  hwSensorAlarm: { label: "Hardware sensor alarm", unit: "" },
  storageUsedPct: { label: "Storage used", unit: "%" },
  storageUsedBytes: { label: "Storage used", unit: "bytes" },
  // Forecast metric: projected days until each growing filesystem fills
  // (30-day trend, ≥7 daily points; non-growing mounts produce no reading —
  // see storageForecastService). Alert with "<=", e.g. ≤ 14 days.
  storageDaysUntilFull: { label: "Days until storage full", unit: "days" },
  ifInErrorRate: { label: "Interface in-error rate", unit: "errors/s" },
  ifOutErrorRate: { label: "Interface out-error rate", unit: "errors/s" },
  ifInBps: { label: "Interface inbound", unit: "bps" },
  ifOutBps: { label: "Interface outbound", unit: "bps" },
  sdwanLatencyMs: { label: "SD-WAN latency", unit: "ms" },
  sdwanJitterMs: { label: "SD-WAN jitter", unit: "ms" },
  sdwanPacketLoss: { label: "SD-WAN packet loss", unit: "%" },
  ipsecThroughputBps: { label: "IPsec throughput", unit: "bps" },
  customWidgetValue: { label: "Custom widget value", unit: "" },
  // 0/1 reading from an operator-defined state probe (Manufacturer Profile →
  // state widget). Compared with "==" against 1 (the probe's true state) or 0;
  // the builder renders the probe's own labels ("Alarm" / "OK") instead of the
  // numbers, and there's no unit because there's no magnitude.
  customStateValue: { label: "Device state flag (0/1)", unit: "" },
  // host_metric
  memUsedPct: { label: "Memory utilization", unit: "%" },
  loadAvg1: { label: "Load average (1m)", unit: "" },
  loadAvg5: { label: "Load average (5m)", unit: "" },
  loadAvg15: { label: "Load average (15m)", unit: "" },
  procRssBytes: { label: "Process RSS", unit: "bytes" },
};

// Asset-state field metadata: label + input kind + (for enum/bool) valid values.
//
// `placeholder` is the hint the builder's free-text value box shows; it exists
// because the default ("e.g. up / down") is a lie on a field whose values are
// not statuses. `equalityOnly` withholds the ordered comparators from the
// operator select: the engine's compareValue can only answer == / != about a
// non-numeric string, so offering ">=" there builds a rule that is silently
// false forever.
//
// `integralDimension` names the dimension a reading of this field IS ABOUT,
// as opposed to one that narrows a set of them: the builder keeps that
// dimension's picker on the condition row itself (and never lifts it out into
// a group filter row), so the operator can say WHICH component the comparison
// names. Everything else in FIELD_DIMENSIONS is offered as a filter row —
// which is the right shape for "narrow every condition in this group", and the
// wrong one for a field whose reading is meaningless until one component is
// named.
export const FIELD_META: Record<string, { label: string; kind: "enum" | "bool" | "number" | "dynamic"; values?: string[]; placeholder?: string; equalityOnly?: boolean; integralDimension?: string }> = {
  // "passive" = no down-detection automation covers the device, so Polaris
  // renders no verdict for it. It is still polled and still charted — the
  // counters keep advancing, they are simply never compared to a threshold.
  monitorStatus: { label: "Monitor status", kind: "enum", values: ["up", "warning", "recovering", "down", "passive", "unknown"] },
  status: { label: "Lifecycle status", kind: "enum", values: ["active", "maintenance", "decommissioned", "storage", "disabled", "quarantined"] },
  // Not a run length since the leaky-bucket change (business rule 30): a miss
  // adds one, an answer takes one back. The KEY is unchanged because stored
  // automations reference it, but the label had to stop saying "consecutive" —
  // a rule reading `>= 5` now fires on five misses outstanding, which a flapping
  // device can reach without ever missing five in a row.
  consecutiveFailures: { label: "Missed polls outstanding", kind: "number" },
  dependencySuppressed: { label: "Dependency-suppressed", kind: "bool", values: ["true", "false"] },
  quarantined: { label: "Quarantined", kind: "bool", values: ["true", "false"] },
  ifOperStatus: { label: "Interface oper status", kind: "dynamic" },
  ifAdminStatus: { label: "Interface admin status", kind: "dynamic" },
  // The port's CURRENT L3 address, compared as a string. Its reason for
  // existing is the negative form: `!= 0.0.0.0` is how an operator says "this
  // interface actually has an address", which is the gate a rule about
  // something riding that interface needs — an SD-WAN overlay's health check
  // reports total packet loss whenever its underlay WAN port is unaddressed,
  // and that is the underlay's outage to alert about, not the overlay's. The
  // engine normalizes both sides through `bareInterfaceIp`, so the mask-
  // carrying shapes ("0.0.0.0 0.0.0.0") compare equal to the bare address.
  //
  // The interface is INTEGRAL here (see the header): a comparison against an
  // address is about one port, and with no port named the leaf reads "any
  // monitored interface" — which a composite folds per device through the
  // engine's ANY fold (leafTruthByAsset), so `!= 0.0.0.0` would be true of
  // every addressed device and the gate this field exists to be would gate
  // nothing.
  ifIpAddress: { label: "Interface IP address", kind: "dynamic", placeholder: "e.g. 0.0.0.0", equalityOnly: true, integralDimension: "ifNamePattern" },
  // Closed enum rather than "dynamic" (which ifOperStatus uses): every value
  // POWER-ETHERNET-MIB can report is known up front, so the wizard offers a
  // picker and a typo cannot silently produce a rule that never matches.
  poeStatus: { label: "Interface PoE status", kind: "enum", values: [...POE_STATUS_VALUES] },
  ipsecStatus: { label: "IPsec tunnel status", kind: "dynamic" },
  sdwanRuleStatus: { label: "SD-WAN rule status", kind: "dynamic" },
  sdwanSelectedMember: { label: "SD-WAN selected member", kind: "dynamic" },
};

export const CHANGE_TYPE_META: Record<string, string> = {
  lldp_neighbor_added: "LLDP neighbor appeared",
  lldp_neighbor_removed: "LLDP neighbor disappeared",
  process_started: "Process started",
  process_stopped: "Process stopped",
  sdwan_failover: "SD-WAN failover (member changed)",
  mclag_peer_lost: "MCLAG peer lost",
  wireless_station_connected: "Wireless station connected",
  firmware_changed: "Firmware / OS version changed",
  switch_port_changed: "Switch port changed",
  wireless_ap_changed: "Wireless AP changed (roam)",
  gateway_firewall_changed: "Gateway FortiGate changed",
};

// Which dimensionFilter inputs are relevant per asset_metric metric, so the
// builder only shows the applicable ones.
/** Case-insensitive substring test used by every `*Pattern` dimension filter.
 *  An unset needle matches everything (the filter is optional). */
export function dimensionSubstringMatch(haystack: string | null | undefined, needle?: string | null): boolean {
  if (!needle) return true;
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

/**
 * Does a hwSensorValue dimension filter select this sensor? Shared by the
 * engine's reading resolver AND the asset chart's severity-tier lookup — the
 * chart colors a line by the thresholds that would actually fire on it, so a
 * second, subtly different copy of this predicate would paint a sensor with
 * bands belonging to some other sensor.
 */
export function hwSensorFilterMatches(
  df: { sensorClass?: string; sensorNamePattern?: string } | null | undefined,
  sensor: { sensorName?: string | null; sensorClass?: string | null },
): boolean {
  if (!df) return true;
  if (df.sensorClass && df.sensorClass !== (sensor.sensorClass ?? "")) return false;
  return dimensionSubstringMatch(sensor.sensorName, df.sensorNamePattern);
}

export const METRIC_DIMENSIONS: Record<string, string[]> = {
  hwSensorValue: ["sensorClass", "sensorNamePattern"],
  hwSensorAlarm: ["sensorClass", "sensorNamePattern"],
  storageUsedPct: ["mountPathPattern"],
  storageUsedBytes: ["mountPathPattern"],
  storageDaysUntilFull: ["mountPathPattern"],
  ifInErrorRate: ["ifNamePattern"],
  ifOutErrorRate: ["ifNamePattern"],
  ifInBps: ["ifNamePattern"],
  ifOutBps: ["ifNamePattern"],
  sdwanLatencyMs: ["healthCheck", "link"],
  sdwanJitterMs: ["healthCheck", "link"],
  sdwanPacketLoss: ["healthCheck", "link"],
  ipsecThroughputBps: ["tunnelName"],
  customWidgetValue: ["widgetId"],
  customStateValue: ["stateProbeId", "stateRowPattern"],
};
// Which dimensionFilter inputs apply per asset_state FIELD — the state twin of
// METRIC_DIMENSIONS. The engine has honored ifNamePattern on the interface
// state trio and tunnelName on ipsecStatus since the pin-gate work, but the
// builder never rendered an input for them, so "Interface oper status is down
// on interfaces matching wan" was expressible only through the raw API. The
// SD-WAN pair carries no name filter because the engine has none for it (rules
// alert per ruleName dimension already). Device-identifier dimensions are NOT
// listed per metric/field — DEVICE_FILTER_DIMENSIONS below applies to every
// asset leaf uniformly.
export const FIELD_DIMENSIONS: Record<string, string[]> = {
  ifOperStatus: ["ifNamePattern"],
  ifAdminStatus: ["ifNamePattern"],
  ifIpAddress: ["ifNamePattern"],
  poeStatus: ["ifNamePattern"],
  ipsecStatus: ["tunnelName"],
  sdwanRuleStatus: ["sdwanRulePattern"],
  sdwanSelectedMember: ["sdwanRulePattern"],
};

// ── Device-identifier dimensions ─────────────────────────────────────────────
// Applicable to EVERY asset_metric and asset_state trigger (never host_metric —
// there is no asset). They filter the ASSET SET before any sample query runs
// (notificationEngine.applyDeviceFilters); the wizard authors them as filter
// rows in the condition tree. See the dimensionFilterSchema note above.
export const DEVICE_FILTER_DIMENSIONS = [
  "hostnamePattern", "ipPattern", "macPattern", "manufacturerPattern", "modelPattern",
] as const;

/**
 * IP dimension matcher. Substring over dotted quads lies ("10.1.1.5" is inside
 * "110.1.1.55"), so the pattern is: a CIDR ("/" present) → containment; a
 * trailing-dot prefix ("10.4.1.") → startsWith; otherwise exact address OR an
 * octet-boundary prefix ("10.4" matches 10.4.x.x, never 10.40.x.x). MIRRORED
 * client-side by the wizard's match cue — keep the two in lockstep.
 */
export function ipDimensionMatch(ip: string | null | undefined, pattern?: string | null): boolean {
  if (!pattern) return true;
  const value = (ip ?? "").trim();
  if (!value) return false;
  const p = pattern.trim();
  if (!p) return true;
  if (p.includes("/")) {
    try { return ipInCidr(value, p); } catch { return false; }
  }
  if (p.endsWith(".")) return value.startsWith(p);
  return value === p || value.startsWith(p + ".");
}

/**
 * MAC dimension matcher: separator-insensitive substring — "aa-bb-cc",
 * "aabb.cc" and "AA:BB:CC" all select the same devices, because operators
 * paste MACs in whatever shape their last tool printed. MIRRORED client-side
 * by the wizard's match cue — keep the two in lockstep.
 */
export function macDimensionMatch(mac: string | null | undefined, pattern?: string | null): boolean {
  if (!pattern) return true;
  const strip = (v: string) => v.toLowerCase().replace(/[^0-9a-f]/g, "");
  const needle = strip(pattern);
  if (!needle) return true;
  return strip(mac ?? "").includes(needle);
}

/** The asset fields the device-identifier dimensions read. */
export interface DeviceFilterAsset {
  hostname?: string | null;
  ipAddress?: string | null;
  macAddress?: string | null;
  manufacturer?: string | null;
  model?: string | null;
}

/**
 * Does a trigger's dimensionFilter select this DEVICE? One predicate shared by
 * the engine's asset-set narrowing (applyDeviceFilters) and the chart-shading
 * lookup (getMetricSeverityTiers) — a second copy is how a chart comes to
 * shade with thresholds that can't fire on that asset. No filter = everything.
 */
export function deviceFilterMatch(
  df: { hostnamePattern?: string; ipPattern?: string; macPattern?: string; manufacturerPattern?: string; modelPattern?: string } | null | undefined,
  asset: DeviceFilterAsset,
): boolean {
  if (!df) return true;
  if (!dimensionSubstringMatch(asset.hostname, df.hostnamePattern)) return false;
  if (!ipDimensionMatch(asset.ipAddress, df.ipPattern)) return false;
  if (!macDimensionMatch(asset.macAddress, df.macPattern)) return false;
  if (!dimensionSubstringMatch(asset.manufacturer, df.manufacturerPattern)) return false;
  return dimensionSubstringMatch(asset.model, df.modelPattern);
}

/**
 * Is `dimension` a valid dimensionFilter input for `metricOrField` (an
 * ASSET_METRICS name, an ASSET_STATE_FIELDS name — the two share no name)?
 * The dimension-values endpoint validates through this so a stale client gets
 * a 400 rather than an empty list that reads as "these devices report none".
 */
export function triggerDimensionApplicable(metricOrField: string, dimension: string): boolean {
  if (METRIC_DIMENSIONS[metricOrField]?.includes(dimension)) return true;
  if (FIELD_DIMENSIONS[metricOrField]?.includes(dimension)) return true;
  return (
    (DEVICE_FILTER_DIMENSIONS as readonly string[]).includes(dimension) &&
    ((ASSET_METRICS as readonly string[]).includes(metricOrField) ||
      (ASSET_STATE_FIELDS as readonly string[]).includes(metricOrField))
  );
}

/**
 * Which asset-STATE fields the engine reports per dimension rather than once
 * per device — the state-side counterpart of METRIC_DIMENSIONS. Derived from the
 * resolvers in notificationEngine: the interface trio walks AssetInterface rows,
 * ipsecStatus the tunnels, the SD-WAN pair the rules, and everything else
 * (monitorStatus, status, quarantined …) is one reading for the whole asset.
 *
 * The builder renders no dimensionFilter inputs for a state leaf, so unlike
 * METRIC_DIMENSIONS this isn't a form-field list — it exists so a surface can
 * ask "does this trigger raise one alert per interface?", which is what decides
 * whether a custom reset condition clears one alert or all of them.
 */
export const STATE_FIELD_DIMENSIONS: Record<string, string[]> = {
  ifOperStatus: ["ifNamePattern"],
  ifAdminStatus: ["ifNamePattern"],
  ifIpAddress: ["ifNamePattern"],
  poeStatus: ["ifNamePattern"],
  ipsecStatus: ["tunnelName"],
  sdwanRuleStatus: ["healthCheck"],
  sdwanSelectedMember: ["healthCheck"],
};

/** What one dimension of a reading IS, in an operator's words — so a surface can
 *  say "one alert per interface" without hardcoding the vocabulary. */
export const DIMENSION_NOUNS: Record<string, string> = {
  ifNamePattern: "interface",
  sensorClass: "sensor",
  sensorNamePattern: "sensor",
  mountPathPattern: "storage mount",
  healthCheck: "SD-WAN health check",
  link: "WAN member",
  tunnelName: "IPsec tunnel",
  widgetId: "custom widget",
  stateProbeId: "state probe",
  stateRowPattern: "state-probe row",
};

/**
 * The catalog the builder UI reads from GET /notification-rules/schema, so the
 * frontend renders the right inputs per trigger type without hardcoding. The
 * `*Meta` maps add display labels / units / valid values / applicable dimension
 * filters; the engine ignores them (it validates via the Zod schemas above).
 */
export function buildSchemaCatalog() {
  return {
    // v2 capability marker — the wizard gates its data-driven surfaces on it.
    schemaVersion: 2,
    severities: SEVERITIES,
    eventLevels: EVENT_LEVELS,
    clearBehaviors: CLEAR_BEHAVIORS,
    comparators: COMPARATORS,
    aggregations: AGGREGATIONS,
    metricMeta: METRIC_META,
    fieldMeta: FIELD_META,
    changeTypeMeta: CHANGE_TYPE_META,
    metricDimensions: METRIC_DIMENSIONS,
    // The asset_state twin — which dimension inputs each state field takes
    // (interface for the ifOper/ifAdmin/poe trio, tunnel for ipsecStatus).
    // Absent on a pre-upgrade server; the wizard treats that as "state leaves
    // take no dimensions", the old behavior.
    fieldDimensions: FIELD_DIMENSIONS,
    // Device-identifier dimensions, valid on every asset metric/state leaf —
    // the wizard's "+ Condition → Device identifier" filter rows. Absent on a
    // pre-upgrade server; the wizard then offers no identifier rows.
    deviceFilterDimensions: DEVICE_FILTER_DIMENSIONS,
    // Down-detection authority: which leaf shape carries the missed-poll count,
    // and what an uncovered device reads instead. Sent as data rather than
    // hardcoded in the wizard so the count control, its bounds and the "passive"
    // vocabulary can't drift from what the server enforces — and so a
    // pre-upgrade server (no key) degrades to the old value-only state row
    // instead of rendering a control the API would reject.
    downDetection: {
      field: "monitorStatus",
      operator: "==",
      value: "down",
      countKey: "missedPolls",
      min: 1,
      max: 100,
      default: DEFAULT_MISSED_POLLS,
      passiveStatus: "passive",
      help:
        "How many polls in a row a device must miss before Polaris calls it down. " +
        "This automation owns that number for every device it covers — the most specific automation wins. " +
        "A device no down automation covers is never called down: it stays Passive, still polled and still charted.",
    },
    // Per-dimension alerting vocabulary — which state fields report per
    // dimension, and what one dimension is called. The reset step reads both to
    // say whether a custom reset condition clears one alert or every alert on
    // the device (see the resolveResetTruths note in notificationEngine).
    stateFieldDimensions: STATE_FIELD_DIMENSIONS,
    dimensionNouns: DIMENSION_NOUNS,
    // Metrics whose reading is a 0/1 flag, so the builder renders a state picker
    // instead of a threshold box and hides the numeric-only surfaces (severity
    // bands, hysteresis, unit hints).
    booleanMetrics: BOOLEAN_METRICS,
    // Metrics that ARE a ratio over their window (packet loss), so the builder
    // labels its one time field "History", drops the meaningless aggregation
    // control, and gives severity tiers no hold clock of their own.
    windowedRatioMetrics: WINDOWED_RATIO_METRICS,
    // The saturation ceiling the wizard prefills for those metrics, served
    // rather than hardcoded client-side so the two cannot drift.
    readingCeilingDefault: DEFAULT_READING_CEILING_PCT,
    // Per-metric state names, so a boolean metric with no probe behind it still
    // renders "is Alarm" rather than "is true".
    booleanMetricLabels: BOOLEAN_METRIC_LABELS,
    // hwSensorValue's unit depends on the sensor class in the dimension filter
    // (metricMeta carries the "(sensor unit)" placeholder). Class → display
    // unit, sourced from the same map the sample classifier writes with.
    sensorClassUnits: SENSOR_CLASS_UNITS,
    channelTypes: CHANNEL_TYPE_META,
    recipientRoutedTypes: RECIPIENT_ROUTED_TYPES,
    templateVariables: TEMPLATE_VARIABLES,
    // The default alert email, verbatim. The wizard prefills a new Notify
    // action with these strings so the operator sees — and can edit — exactly
    // what Polaris will send; a rule that leaves them alone renders through
    // the same template server-side (buildComposedEmail).
    defaultEmailTemplate: defaultAlertEmailTemplate(),
    triggerTypes: [
      { type: "asset_metric", label: "Asset metric threshold", scoped: true, metrics: ASSET_METRICS },
      { type: "asset_state", label: "Asset state", scoped: true, fields: ASSET_STATE_FIELDS },
      { type: "host_metric", label: "Polaris host health", scoped: false, metrics: HOST_METRICS },
      // Scoped since 2026-09 (business rule 46): the device filter selects
      // which SUBJECTS an event automation fires about. It stays optional in
      // spirit — "All assets" is the unconstrained answer — but the wizard now
      // saves what the operator picked instead of discarding it.
      { type: "event", label: "Audit event match", scoped: true },
      { type: "change", label: "Change detection", scoped: true, changeTypes: CHANGE_TYPES },
      { type: "composite", label: "Multiple conditions (AND/OR)", scoped: true },
    ],
    // Composite-trigger builder vocabulary (the wizard's trigger tree).
    compositeMeta: {
      kinds: ["asset", "host"],
      groupOps: TRIGGER_GROUP_OPS,
      groupOpLabels: {
        and: "All conditions must be met (AND)",
        or: "At least one condition must be met (OR)",
      },
      maxDepth: 3,
      maxLeaves: 10,
      // Multi-dimension leaves (sensors, mounts, interfaces …) count as met
      // when ANY dimension crosses; composite automations alert once per
      // device, not per dimension.
      anyDimensionNote:
        "With multiple conditions, an automation alerts once per device; a per-sensor/per-interface condition counts as met when any of them crosses.",
    },
    // ── Rule-shape v2 vocabulary (reset + actions), wizard-facing ──────────
    resetModes: RESET_MODES,
    resetModeMeta: {
      auto: { label: "Automatically", help: "Clears when the condition recovers — optionally with a separate clear threshold (hysteresis) and a recovered-for duration." },
      condition: { label: "When custom conditions are met", help: "Clears when a separate AND/OR condition tree becomes true. Starts as the trigger inverted — edit it to recover on a different value, a different metric, or several at once. While the alert is active these conditions are the only recovery authority, so set a re-notify cooldown if the trigger and reset conditions can both be true at once." },
      event: { label: "When a matching event arrives", help: "Clears when the counterpart audit event is written for the same device or resource — the reconnect that answers the disconnect. The alert stays up until it happens, so a device that never comes back keeps its alert." },
      timed: { label: "After a fixed time", help: "Clears after the configured duration, even without a recovery reading." },
      manual: { label: "Manually only", help: "Stays active until someone clears it." },
    },
    // Which reset modes make sense per trigger type (event/change have no
    // continuous condition to auto-clear, hence no "auto" and no "condition"
    // — see TRIGGER_TYPES_WITH_RESET_CONDITIONS; they get "event" instead,
    // which is the recovery they DO have) + the wizard's default per type. Order is the order the wizard renders the non-auto radios in, so
    // "condition" leads: unchecking "reset when the trigger is no longer true"
    // lands on the trigger-inverted tree, which is the customizable spelling of
    // the box that was just unchecked.
    resetModesByTriggerType: {
      asset_metric: ["auto", "condition", "timed", "manual"],
      asset_state: ["auto", "condition", "timed", "manual"],
      host_metric: ["auto", "condition", "timed", "manual"],
      event: ["event", "timed", "manual"],
      change: ["event", "timed", "manual"],
      composite: ["auto", "condition", "timed", "manual"],
    },
    // Trigger action pattern → the pattern that says it recovered, prefilled
    // by the wizard when the operator picks the event reset.
    resetEventSuggestions: RESET_EVENT_SUGGESTIONS,
    resetDefaults: {
      asset_metric: { mode: "auto", sustainSec: 0 },
      asset_state: { mode: "auto" },
      host_metric: { mode: "auto", sustainSec: 0 },
      event: { mode: "timed", afterSec: 3600 },
      change: { mode: "timed", afterSec: 3600 },
      composite: { mode: "auto", sustainSec: 0 },
    },
    actionTypes: [
      { type: "notify", label: "Send a notification", requires: "channels", permission: null },
      { type: "api_call", label: "Call an API (HTTP request)", requires: null, permission: null },
      { type: "script", label: "Run a script", requires: "scripts", permission: "automationScripts" },
      { type: "event", label: "Create an Event", requires: null, permission: null },
    ],
    apiCallMeta: {
      allowedMethods: API_CALL_METHODS,
      urlSchemes: ["https", "http"],
      maxBodyBytes: 10000,
      maxHeaders: 20,
      maxTimeoutSec: 60,
      help: "Headers are stored unmasked on the automation — never paste API keys, tokens, or other credentials into them.",
    },
    scriptMeta: {
      runOnOptions: SCRIPT_RUN_TARGETS,
      maxTimeoutSec: 600,
      languages: SCRIPT_INTERPRETERS,
      help: "Scripts execute as the Polaris service account on the server, or as root/LocalSystem on the triggering asset's agent. A human must review every script before enabling it in production.",
    },
    // perAction: escalation chains attach to individual actions (top-level +
    // per-band); tier actions themselves can't nest another chain.
    escalationMeta: { maxTiers: 5, minRepeatEveryMin: 5, maxActionsPerTier: 10, perAction: true },
    // The repeat-until-handled control's vocabulary. `unbounded: true` and the
    // action-type list are here rather than hardcoded in the wizard because
    // both are things its COPY has to state — an operator must be told that
    // reminders never stop on their own, and that API calls and scripts are not
    // re-run.
    repeatMeta: {
      minEveryMin: 5,
      maxEveryMin: 1440,
      unbounded: true,
      actionTypes: REPEATABLE_ACTION_TYPES,
      stopOnOptions: ["acknowledge", "clear"],
      maxStopAfterHours: 720,
      // Quiet time (business rule 44). `serverClock` is the load-bearing one:
      // every window is SERVER-local wall clock, so a browser prefilling
      // 22:00 from its own clock would save a window that opens hours off at
      // the site (the same trap maintenanceRecurrence.serverClockInfo exists
      // for). `holds` states what quiet does NOT stop, because that is the
      // thing an operator assumes wrongly.
      quietMeta: {
        maxWindows: MAX_QUIET_WINDOWS,
        holds: ["reminder"],
        serverClock: serverClockInfo(),
        help: "Reminders due inside a quiet period are held, not skipped: when it ends, the next reminder goes out immediately and states how long the alert has been active. The first alert, escalations and reset notifications are never quiet.",
      },
    },
    // Severity-band vocabulary for the wizard's per-severity action sections.
    bandMeta: {
      maxBands: 4,
      maxActionsPerBand: 20,
      emptyBandNote: "A severity tier with no actions of its own runs the base actions when entered.",
      sustainNote: "Each severity level has its own “sustained for”: the value must hold in that band for that long before the alert takes the severity.",
    },
    // Sentence-builder vocabulary (server-owned wording; the wizard renders
    // the live plain-English trigger/reset summary from these).
    comparatorPhrases: {
      ">": "is above", ">=": "is at or above",
      "<": "is below", "<=": "is at or below",
      "==": "equals", "!=": "is not",
    },
    inverseComparators: { ">": "<=", ">=": "<", "<": ">=", "<=": ">", "==": "!=", "!=": "==" },
    aggregationPhrases: { latest: "", avg: "avg over", median: "median over", min: "min over", max: "max over" },
    dimensionPhrases: {
      sensorClass: "for sensors of class {value}",
      sensorNamePattern: "on sensors matching {value}",
      ifNamePattern: "on interfaces matching {value}",
      hostnamePattern: "on devices whose hostname matches {value}",
      ipPattern: "on devices whose IP matches {value}",
      macPattern: "on devices whose MAC matches {value}",
      manufacturerPattern: "on devices whose manufacturer matches {value}",
      modelPattern: "on devices whose model matches {value}",
      mountPathPattern: "on mounts matching {value}",
      sdwanRulePattern: "on SD-WAN rules matching {value}",
      healthCheck: "for health check {value}",
      link: "on member {value}",
      tunnelName: "on tunnel {value}",
      widgetId: "for widget {value}",
      processNamePattern: "for processes matching {value}",
      // The probe id is resolved to its NAME by the wizard before the phrase is
      // rendered (a UUID in a sentence is noise); this is the fallback wording.
      stateProbeId: "for probe {value}",
      stateRowPattern: "on rows matching {value}",
    },
    // ── Scope condition-tree vocabulary (the device-filter builder) ────────
    scopeCondition: scopeConditionMeta(SCOPE_FIELD_OPS),
  };
}

// ─── Condition-tree builder vocabulary (published to the UI) ────────────────

/**
 * Per-field presentation: the label the builder shows and which option list
 * feeds its value suggestions ("assetTypes" | "manufacturers" | "models" |
 * "tags" | "subnets" from /scope-options + the registry; null = free text).
 *
 * One catalog for both vocabularies so "Behind FortiGate" can't come out named
 * one thing in the address book and another in the wizard.
 */
const SCOPE_FIELD_META: Record<string, { label: string; optionsFrom: string | null; values?: string[] }> = {
  assetType: { label: "Device type", optionsFrom: "assetTypes" },
  manufacturer: { label: "Manufacturer", optionsFrom: "manufacturers" },
  model: { label: "Model", optionsFrom: "models" },
  hostname: { label: "Hostname", optionsFrom: null },
  os: { label: "Operating system", optionsFrom: null },
  tag: { label: "Tag", optionsFrom: "tags" },
  subnet: { label: "Subnet / IP", optionsFrom: "subnets" },
  interfaceName: { label: "Device interface", optionsFrom: "interfaceNames" },
  ssid: { label: "Broadcast SSID", optionsFrom: "ssids" },
  status: {
    label: "Lifecycle status",
    optionsFrom: null,
    values: ["active", "maintenance", "decommissioned", "storage", "disabled", "quarantined"],
  },
  osVersion: { label: "OS version", optionsFrom: null },
  department: { label: "Department", optionsFrom: null },
  location: { label: "Location", optionsFrom: null },
  fortigate: { label: "Behind FortiGate", optionsFrom: null },
  // NOTE: `assetId` remains a valid field for saved rules (SCOPE_FIELD_OPS +
  // matchScopeRule still handle it) but is deliberately absent here, so it is
  // not offered as a new builder choice — a raw id targets one device with no
  // precedence meaning; use hostname instead.
};

/**
 * The builder catalog for one field vocabulary. `specificity` is meaningful only
 * for automations (it drives the carve-out ladder), so it rides the caller's
 * choice of field set rather than being unconditional.
 */
export function scopeConditionMeta(fieldOps: Record<string, readonly string[]>) {
  return {
    groupOps: SCOPE_GROUP_OPS,
    groupOpLabels: {
      and: "All child conditions must be satisfied (AND)",
      or: "At least one child condition must be satisfied (OR)",
      none: "All child conditions must NOT be satisfied",
      notAll: "At least one child condition must NOT be satisfied",
    },
    operatorLabels: {
      equals: "is equal to",
      notEquals: "is not equal to",
      contains: "contains",
      notContains: "does not contain",
      startsWith: "starts with",
      endsWith: "ends with",
      has: "is applied",
      notHas: "is not applied",
      inCidr: "is in subnet",
      notInCidr: "is not in subnet",
      [WILDCARD_OP]: "matches (wildcard *)",
    },
    fields: Object.keys(fieldOps)
      .filter((field) => SCOPE_FIELD_META[field])
      .map((field) => ({
        field,
        label: SCOPE_FIELD_META[field]!.label,
        ops: fieldOps[field],
        optionsFrom: SCOPE_FIELD_META[field]!.optionsFrom,
        ...(SCOPE_FIELD_META[field]!.values ? { values: SCOPE_FIELD_META[field]!.values } : {}),
      })),
    maxDepth: SCOPE_CONDITION_MAX_DEPTH,
    maxRules: SCOPE_CONDITION_MAX_RULES,
    // Precedence ladder (least → most specific). Drives the wizard's
    // "Specificity" indicator; the carve-out engine ranks scopes by it. Only
    // automations have a precedence model, so it's omitted elsewhere.
    ...(fieldOps === SCOPE_FIELD_OPS ? { specificity: SCOPE_RANK_LADDER } : {}),
  };
}
