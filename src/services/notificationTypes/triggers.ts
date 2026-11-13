/**
 * src/services/notificationTypes/triggers.ts — the trigger vocabulary (CQ-B063, moved verbatim from notificationTypes.ts): severity
 * bands, per-tier sustained durations, poll-counted holds, and the asset-metric, path
 * monitor, asset-state, host-metric, change and composite (AND / OR) trigger schemas and
 * helpers. notificationTypes.ts re-exports every public name.
 */

import { z } from "zod";
import { isValidIpAddress } from "../../utils/cidr.js";
import { EVENT_LEVELS, COMPARATORS, AGGREGATIONS, type Severity, type Comparator, severityRank, type ScopeConditionRule, scopeSchema } from "./scopeConditions.js";

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
 * POLL-GROUP AGGREGATION (business rule 66): the readings that produced a value
 * are cut into DISJOINT groups of N, newest-first, and each group is aggregated
 * into one reading.
 *
 * `values` arrives newest-first and may be holed — a failed probe writes a row
 * with a NULL value, and for `responseTimeMs` that is the only thing a NULL
 * means. The holes are DROPPED rather than filled, which is what makes the
 * window a count of measurements instead of a count of opportunities: a device
 * dropping three quarters of its packets still averages its last N real
 * responses, over more wall-clock time than a healthy one. Neither a shrinking
 * denominator (the time window's failure) nor an invented value (0 ms flatters
 * a dying device, the timeout turns a latency metric into a loss alarm) can
 * arise, because a miss contributes nothing to a window it is not counted in.
 *
 * The RESULT is itself a series, newest-first, of DISJOINT group aggregates:
 * `out[0]` covers the newest N values, `out[1]` the N before those, and so on.
 * Each group is an independent look at the device, which is what lets a hold
 * above it mean something — `leadingRun` over this answers "how many groups in
 * a row came out over the line", and three groups agreeing is three separate
 * measurements agreeing. (Stepping by 1 instead of N would make consecutive
 * entries overlap by N-1 samples, so "sustained for 3" would be three
 * near-identical numbers and barely stronger than one. That is why the groups
 * do not slide.) It also makes the wall clock legible: time to alert is
 * groupSize x sustained polls, not groupSize + sustained - 1.
 *
 * Returns EMPTY when fewer than N values exist, and DROPS a trailing partial
 * group. An aggregate over a partial group is a different statistic wearing the
 * same threshold, and the one thing a rule must not do is fire off a number it
 * did not describe — so a device that has not yet answered N times simply has
 * no reading, exactly as one that has not answered at all does.
 */
export function rollingAggregate(
  values: readonly (number | null)[],
  windowPolls: number,
  aggregation: string,
): number[] {
  const n = Math.max(1, Math.round(windowPolls));
  const vals: number[] = [];
  for (const v of values) if (v !== null && v !== undefined && Number.isFinite(v)) vals.push(v);
  if (vals.length < n) return [];
  const out: number[] = [];
  // DISJOINT groups, newest-first: [0..n), [n..2n), [2n..3n). Stepping by n
  // rather than by 1 is the whole difference between a poll GROUP and a rolling
  // average, and it is what makes the hold above mean something. Consecutive
  // ROLLING windows overlap by n-1 samples, so three of them agreeing is three
  // near-identical numbers agreeing — almost no more evidence than one. Three
  // disjoint groups are three INDEPENDENT looks at the device, which is what an
  // operator means by "it has been slow for a while", and it makes the time to
  // alert exactly groupSize x sustained instead of groupSize + sustained - 1.
  //
  // A trailing partial group is dropped for the same reason a partial window is
  // (the aggregate would be a different statistic under the same threshold), so
  // the series is floor(vals.length / n) long.
  for (let k = 0; k + n <= vals.length; k += n) {
    out.push(aggregateOver(vals.slice(k, k + n), aggregation));
  }
  return out;
}

/** The five aggregations over a non-empty slice. `latest` is the newest member,
 *  which is what it means everywhere else — a count window of 1 under any
 *  aggregation is therefore the raw reading, not a special case. */
function aggregateOver(slice: readonly number[], aggregation: string): number {
  switch (aggregation) {
    case "avg": return slice.reduce((a, b) => a + b, 0) / slice.length;
    case "median": {
      const s = [...slice].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
    }
    case "min": return Math.min(...slice);
    case "max": return Math.max(...slice);
    default: return slice[0]!; // latest
  }
}

/** One response-time probe as the count window sees it, newest-first. */
export interface ProbeEntry {
  /** The measured RTT, or null when the probe failed. */
  responseTimeMs: number | null;
  /** How long the failed probe waited. Null on a success, and on any failure
   *  recorded before the column existed. */
  timeoutMs: number | null;
  /** True when this failed probe is the one that declared (or continued) an
   *  outage — `AssetMonitorSample.assetDown`, business rule 29h. */
  assetDown: boolean;
}

/**
 * RESPONSE TIME'S OWN WINDOW (business rule 67), applied before the rolling
 * aggregate turns it into readings.
 *
 * Two things happen here that no other metric wants, and both exist because a
 * response-time poll has a failure mode with a DURATION attached:
 *
 *  1. **A miss that did not put the asset Down is the timeout.** The probe
 *     genuinely waited that long and heard nothing, so the honest reading is
 *     "at least this slow" — not a gap (which would let a device answering once
 *     an hour read as fast as one answering every minute) and not a zero (which
 *     would make the worst device on the network look like the best). A failure
 *     with no recorded timeout is a row written before the column existed;
 *     those are EXCLUDED, which is exactly the pre-feature behaviour and
 *     self-heals within one window.
 *
 *  2. **An outage RESETS the window.** Walking newest-first, everything at and
 *     before the most recent `assetDown` probe is discarded. Without this, the
 *     timeouts of an outage would sit in the window for ten polls after the
 *     device came back, so a recovered device would keep alerting about a
 *     slowness that was really the outage the down automation already owns —
 *     the same failure rule 29h exists to stop for packet loss, in the metric
 *     next door. It is also what keeps (1) safe: filling misses with the
 *     timeout is only honest while the device is still considered reachable.
 *
 * The consequence is deliberate: a device that has just recovered has NO
 * reading until its window refills, because `rollingAggregate` refuses a
 * partial window. At a 60s cadence that is ten quiet minutes after every
 * outage — a settling period, not a blind spot, since `down` is a different
 * automation's subject the whole time.
 */
export function prepareResponseTimeWindow(entries: readonly ProbeEntry[]): Array<number | null> {
  const out: Array<number | null> = [];
  for (const e of entries) {
    if (e.assetDown) break; // the outage ends the window; everything older is its
    if (e.responseTimeMs !== null && e.responseTimeMs !== undefined) { out.push(e.responseTimeMs); continue; }
    // A miss. Worth the timeout it waited, or nothing at all if we never
    // recorded one — `rollingAggregate` drops the nulls.
    out.push(typeof e.timeoutMs === "number" && e.timeoutMs > 0 ? e.timeoutMs : null);
  }
  return out;
}

/** The measurement window as a COUNT OF READINGS, or 0 when the trigger states
 *  a wall-clock window instead. Only ever set alongside a real aggregation:
 *  `latest` has nothing to measure over, and a windowed ratio's window IS its
 *  reading (business rule 29f), so neither accepts one. */
export function triggerWindowPolls(
  trigger: { windowPolls?: number | null; aggregation?: string } | null | undefined,
): number {
  const n = trigger?.windowPolls;
  if (typeof n !== "number" || !(n > 0)) return 0;
  if (!trigger?.aggregation || trigger.aggregation === "latest") return 0;
  return Math.round(n);
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

/** Key prefix, inside `bandMetSince`, of a wall-clock descent timer: when the
 *  value first stopped satisfying the band the live alert sits at. Never a
 *  severity name, so `sustainedSeverity` ignores it. */
export const BAND_DESCENT_KEY_PREFIX = "descent:";

/**
 * Business rule 19(a) — a band is LEFT on the same hold it was ENTERED on.
 *
 * A firing banded alert asked to ease from `current` down to a lower severity
 * steps down only once the value has stayed OUT of `current`'s tier for that
 * tier's own hold: `forPolls` consecutive readings off the series when the
 * tier counts readings and the source has one, else `forDurationSec` of wall
 * clock timed from a `descent:<severity>` entry carried in the met-since map.
 *
 * Without it, one reading under a band's line eased the alert and the next N
 * readings over it escalated it again — and every escalation re-runs the
 * band's notify actions (`bandNotify.onIncrease`), so a metric idling at a
 * band threshold (memory at 95-97% against a 95% critical band) emailed every
 * few minutes from an alert that never cleared.
 *
 * Returns whether the descent is due now and the met-since map to persist
 * (with the descent entry set while one is pending, dropped otherwise). A
 * current severity that is not on the ladder, or a hold of zero, descends at
 * once — the pre-19(a) behaviour.
 */
export function bandDescent(opts: {
  tiers: ResolvedTier[];
  current: string;
  value: number | null | undefined;
  series: readonly (number | string | boolean | null)[] | null | undefined;
  /** Counted per-tier runs this tick (null = no series / wall-clock ladder). */
  countsReadings: boolean;
  /** This tick's rolled-forward met-since map (tier keys only). */
  metSince: Record<string, number> | null | undefined;
  /** The map stored on the state row before this tick (carries the timer). */
  prevMetSince: Record<string, number> | null | undefined;
  nowMs: number;
}): { due: boolean; metSince: Record<string, number> } {
  const base: Record<string, number> = { ...(opts.metSince ?? {}) };
  const tier = opts.tiers.find((t) => t.severity === opts.current);
  if (!tier) return { due: true, metSince: base };
  const inTier = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && numMeets(v, tier.operator, tier.threshold);

  if (opts.countsReadings && tier.forPolls != null && opts.series) {
    const out = leadingRun(opts.series, (v) => !inTier(v));
    return { due: out >= Math.max(1, tier.forPolls), metSince: base };
  }

  const holdMs = Math.max(0, tier.forDurationSec) * 1000;
  if (holdMs === 0 || inTier(opts.value)) return { due: holdMs === 0, metSince: base };
  const key = BAND_DESCENT_KEY_PREFIX + tier.severity;
  const prev = opts.prevMetSince?.[key];
  const since = typeof prev === "number" && Number.isFinite(prev) && prev <= opts.nowMs ? prev : opts.nowMs;
  if (opts.nowMs - since >= holdMs) return { due: true, metSince: base };
  return { due: false, metSince: { ...base, [key]: since } };
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
  // cpuCorePct is per-core CPU (AssetTelemetrySample.cpuCorePcts — Polaris
  // Agent, vCenter, and Unraid / TrueNAS hosts), for finding a single-threaded application: its
  // hold is counted PER CORE (the same core over the line for N polls). One
  // alert per device naming the cores, superseded on a device while that
  // device carries a live all-cores cpuPct alert (business rule 89).
  "cpuPct", "cpuCorePct", "memPct", "memUsedBytes", "memDaysUntilFull", "memForecastPct", "sessionCount", "responseTimeMs", "uptimeSec", "probeLossPct",
  "hwSensorValue", "hwSensorAlarm", "storageUsedPct", "storageUsedBytes", "storageDaysUntilFull",
  "ifInErrorRate", "ifOutErrorRate", "ifInBps", "ifOutBps",
  // A pinned fibre-channel port's fcIfErrorTable counters as a rate per
  // minute, one metric per counter (business rule 159a, FC_RATE_METRICS).
  "fcCrcErrorRate", "fcLinkFailureRate", "fcSyncLossRate", "fcSignalLossRate", "fcInvalidTxWordRate",
  "sdwanLatencyMs", "sdwanJitterMs", "sdwanPacketLoss", "ipsecThroughputBps",
  "customWidgetValue", "customStateValue",
  // A custom widget's own level (business rule 180): 0 normal, 1 warning,
  // 2 critical, against the warningAt / criticalAt set on the widget — so one
  // automation covers every widget with levels, each at its own thresholds.
  "customWidgetLevel",
  // Agent-run path checks — the asset is the AGENT HOST and the
  // dimension is the check (`checkId`). pathOk is the 0/1 verdict,
  // pathFailurePct the windowed ratio, the rest gauges off the same samples
  // (pathHopCount off the traceroutes).
  "pathLatencyMs", "pathHttpStatus", "pathOk", "pathFailurePct", "pathHopCount", "pathTlsDaysLeft",
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
export const BOOLEAN_METRICS = ["customStateValue", "hwSensorAlarm", "pathOk"] as const;

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
  // 1 = the run met every expectation (status, body, TLS, connect / echo).
  pathOk: { trueLabel: "Reachable", falseLabel: "Unreachable", trueIsProblem: false },
};

// ─── Path Monitor (business rule 85, 2026-10-05 addendum) ───────────────────
// The path* metrics and the traceroute change are STORED as `asset_metric` /
// `change` triggers — they ride the same threshold, hold, band and hysteresis
// machinery as every other metric, and every consumer keyed on the stored type
// (cadence, charts, the Alerts tab, portability) keeps working unchanged. What
// makes them their own kind of automation is everything AROUND the condition:
//  - the wizard authors them under their own trigger category, "Path Monitor",
//    and the Device category no longer offers them;
//  - the devices they are about are only ever agent hosts — the rule's device
//    conditions are ANDed with "Polaris Agent installed" (pathMonitorScope), so
//    the preview counts and the engine both read the pool the operator meant;
//  - the Polaris server's own run of a check is a source too, opted in per
//    automation with `includeServer`. It has no asset row (it never is one —
//    see narrative-85 "The Polaris server as a source"), so it is evaluated as
//    a pseudo subject and its alert carries no assetId, exactly like a
//    Polaris-host metric alert.
// A composite tree is either all path conditions or none — a path reading is
// about a path from an agent, a device reading about the device, and an AND
// across the two would be evaluated over two different device pools.
export const PATH_METRICS = [
  "pathLatencyMs", "pathHttpStatus", "pathOk", "pathFailurePct", "pathHopCount", "pathTlsDaysLeft",
] as const;

export const PATH_CHANGE_TYPES = ["path_check_path_changed"] as const;

/** What the server's readings are called ({asset}, the alert's hostname). */
export const PATH_SERVER_LABEL = "Polaris server";

export function isPathMetric(metric: string | null | undefined): boolean {
  return !!metric && (PATH_METRICS as readonly string[]).includes(metric);
}

/** Is this a Path Monitor automation — a path metric, the path change, or a
 *  composite of path metrics only? Tolerant of raw JSON (stored rows). */
export function isPathTrigger(trigger: unknown): boolean {
  const t = trigger as { type?: string; metric?: string; changeType?: string; children?: unknown[] } | null | undefined;
  if (!t || typeof t !== "object") return false;
  if (t.type === "asset_metric") return isPathMetric(t.metric);
  if (t.type === "change") return (PATH_CHANGE_TYPES as readonly string[]).includes(t.changeType ?? "");
  if (t.type === "composite" && Array.isArray(t.children)) {
    const leaves = collectTriggerLeaves(t as { children: (TriggerConditionGroup | CompositeLeaf)[] });
    return leaves.length > 0 && leaves.every((l) => l.type === "asset_metric" && isPathMetric(l.metric));
  }
  return false;
}

/** Does this automation also watch the Polaris server's own run of its checks?
 *  Only a single-condition path trigger can: a composite is evaluated per
 *  device row and the server has none. */
export function pathTriggerIncludesServer(trigger: unknown): boolean {
  const t = trigger as { type?: string; includeServer?: boolean } | null | undefined;
  if (!t || (t.type !== "asset_metric" && t.type !== "change")) return false;
  return t.includeServer === true && isPathTrigger(t);
}

/** The scope condition every Path Monitor automation is ANDed with. */
export const AGENT_INSTALLED_RULE: ScopeConditionRule = { field: "agentInstalled", operator: "equals", value: "yes" };

/** A scope narrowed to agent hosts — the pool a Path Monitor automation's
 *  device conditions choose from. Never stored: applied at read time, so an
 *  operator's own conditions stay exactly what they wrote. */
export function pathMonitorScope(scope: RuleScope | null | undefined): RuleScope {
  const base = scope ?? {};
  const own = base.condition && base.condition.children.length > 0 ? base.condition : null;
  // A scope that selects nothing (no dimension, not "all devices") must keep
  // selecting nothing — the added condition would otherwise count as the
  // dimension that makes it select every agent host.
  const lists = [base.assetTypes, base.tags, base.assetIds, base.integrationIds, base.manufacturers, base.models, base.subnetCidrs];
  if (!base.allAssets && !own && !lists.some((l) => l && l.length > 0)) return base;
  return {
    ...base,
    condition: { op: "and", children: own ? [AGENT_INSTALLED_RULE, own] : [AGENT_INSTALLED_RULE] },
  };
}

/**
 * Does a server-side path change (`path_check.path_changed` with resourceType
 * "path-check" — the Polaris server's own traceroute) fire this automation?
 * true / false decide it; null = not that case, apply the device filter as
 * usual. `includeServer` decides when set. Absent (every rule authored before
 * the flag) keeps what the event tail always did: an unfiltered automation
 * matched it, a filtered one could not.
 */
export function eventMatchesPathServer(
  trigger: { type: string; changeType?: string; includeServer?: boolean },
  scoped: boolean,
  resourceType: string | null | undefined,
): boolean | null {
  if (trigger.type !== "change" || !isPathTrigger(trigger) || resourceType !== "path-check") return null;
  if (trigger.includeServer != null) return trigger.includeServer;
  return !scoped;
}

/** The scope the engine resolves for a rule: its own, narrowed to agent hosts
 *  for a Path Monitor trigger. */
export function scopeForTrigger(scope: RuleScope, trigger: unknown): RuleScope {
  return isPathTrigger(trigger) ? pathMonitorScope(scope) : scope;
}

// ─── Asset-state trigger ────────────────────────────────────────────────────
// Current Asset (or current-state child row) field conditions.
export const ASSET_STATE_FIELDS = [
  "monitorStatus", "status", "consecutiveFailures", "dependencySuppressed", "quarantined",
  // Controller link state for a FortiGate-managed switch / AP — business rule
  // 58. "up" | "down" | "unknown", and null on every asset that isn't
  // FortiGate-managed. Deliberately a SEPARATE field from monitorStatus rather
  // than a value inside it: the two can disagree, and the disagreement is the
  // whole point. A switch reading monitorStatus=up with fortilinkStatus=down
  // is answering ICMP while its FortiLink session to the gate is dead, which
  // is a fault the monitor loop cannot see because it is asking the switch.
  "fortilinkStatus",
  // How a switch / access point's running firmware stands against the
  // PRIMARY image the Repository holds for its platform — business rule 87.
  // "current" | "older" | "newer", and NO READING (not null) for a device the
  // Repository cannot place: not a switch / AP, no usable serial, no readable
  // version, no primary for its platform. Resolved from one findMany over the
  // image table per evaluation, never one query per asset.
  "firmwareVsPrimary",
  // How long a heavy stream's polls have been FAILING, in whole minutes —
  // business rule 118. Measured from the first failed attempt of the current
  // run to the latest attempt, so the reading freezes if attempts stop rather
  // than climbing on a device nobody is asking. 0 while the stream is healthy;
  // NO READING for a stream never attempted (unsupported, disabled, or a
  // method with no collector). Not the response-time probe's business: a
  // device that answers ping/SNMP but whose REST pull fails reads up on
  // monitorStatus and >0 here, which is exactly the case these exist for.
  "telemetryFailingMinutes", "systemInfoFailingMinutes",
  // Whether the asset carries ONE named tag. The tag is the rule's `value`; the
  // operator says which way: `== prod` is "is tagged prod", `!= prod` is "is
  // not tagged prod". A fact Polaris holds about the device (Asset.tags), so it
  // reads the scope row like `status` does and survives the device going down.
  "tag",
  "ifOperStatus", "ifAdminStatus", "ifIpAddress", "poeStatus", "ipsecStatus", "sdwanRuleStatus", "sdwanSelectedMember",
  // Whether ONE WAN member of ONE performance-SLA health check is alive, as the
  // FortiGate itself judges it (AssetPerfSlaSample.state, normalized from the
  // health-check response's status/alive). Separate from every interface field
  // for the reason an operator reaches for it: a cable-modem WAN port stays
  // oper-up while the ISP behind it degrades, and it is the health check — not
  // the link — that declares the member dead. The engine reports it per
  // (health check, WAN member), so it is the member that gets named in the
  // alert rather than the gate.
  "sdwanMemberState",
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
  "fortilink_changed",
  "path_check_path_changed",
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
  // The one `asset.*.changed` row that is NOT unconditional: roams are
  // anything but rare, so its writers emit it only while a rule subscribes
  // (notificationChangeEvents.wirelessRoamEventsWanted, 2026-11-09).
  wireless_ap_changed: "asset.wireless_ap.changed",
  gateway_firewall_changed: "asset.gateway_firewall.changed",
  // The `asset.*.changed` family: written unconditionally by the sweep, so
  // this entry only gives the wizard a picker over an Event that is already in
  // the log. The asset_state field is the better route for "notify me WHILE
  // the link is down" (it has a reading, so it gets auto-reset and a forPolls
  // hold); this one is for "tell me each time it moves".
  fortilink_changed: "asset.fortilink.changed",
  // Written unconditionally by pathCheckIngestService when an agent's
  // traceroute for a check takes a different hop sequence than the last one
  // (10-minute floor per host and check). Names the agent HOST as its asset.
  path_check_path_changed: "path_check.path_changed",
};

const dimensionFilterSchema = z
  .object({
    // One interface, or several joined by "|" — any-of, each term a substring
    // of the interface's name OR its description (interfacePatternMatch). As
    // long as the SD-WAN pair below because it holds a list too.
    ifNamePattern: z.string().max(1000).optional(),
    // INTERFACE TAG (business rule 133(g)): one tag name, or several joined by
    // "|" — any-of, each matched whole and case-insensitively against the
    // port's AssetInterfaceTag rows (interfaceTagMatch). Narrows the readings
    // of the interface conditions without keying them, like sdwanMemberIp, so
    // it is in no *_DIMENSIONS list. Valid only on INTERFACE_TAG_TARGETS.
    ifTag: z.string().max(1000).optional(),
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
    // SD-WAN pair: one value, or several joined by "|" — any-of, each term a
    // substring (utils/sdwanDimensions). Longer than the single-pattern
    // dimensions because it holds a list.
    healthCheck: z.string().max(1000).optional(),
    link: z.string().max(1000).optional(),
    // SD-WAN MEMBER IP ADDRESS (business rule 98): "== <ip>" or "!= <ip>",
    // compared with the member interface's CURRENT address. A comparison, not
    // a *Pattern — so it is stored as one and parsed by parseMemberIpFilter.
    // Valid only on SDWAN_MEMBER_IP_TARGETS (validateMemberIpFilter).
    sdwanMemberIp: z.string().max(100).refine((v) => parseMemberIpFilter(v) !== null, {
      message: 'SD-WAN member IP address must be "== <address>" or "!= <address>"',
    }).optional(),
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
    // ── Path checks (path*) ──────────────────────────────────────
    // Which check — a PathCheck id, matched exactly (a registry key,
    // like stateProbeId). Blank = every check the host runs, one alert each.
    checkId: z.string().max(200).optional(),
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

/**
 * THE MEASUREMENT WINDOW AS A COUNT OF READINGS (business rule 66).
 *
 * `windowSec` measures over a period of TIME and takes whatever samples landed
 * in it, so a device that answered four times in the hour is averaged over four
 * readings and one that answered sixty over sixty — the same rule describing two
 * different statistics depending on how well the device happens to be working.
 * `windowPolls` measures over the last N readings that produced a value, so the
 * sample size is the thing the operator fixed and the WALL CLOCK is what
 * stretches when the device gets lossy.
 *
 * Set alongside it, `forPolls` stops meaning "N raw samples over the line" and
 * starts meaning "N consecutive recalculations of this window over the line" —
 * the two compose, which they deliberately do not for a time window (there the
 * window IS the period, and a hold on top would be two clocks doing one job).
 *
 * Capped at 100 like every other count that defines rather than filters a
 * condition. The cap is also what keeps `windowPolls + forPolls - 1` inside the
 * engine's 200-reading `SERIES_CAP`, which is the series a hold is counted off.
 */
const WINDOW_POLLS_FIELD = z.number().int().min(1).max(100).optional();

const assetMetricTrigger = z.object({
  type: z.literal("asset_metric"),
  metric: z.enum(ASSET_METRICS),
  aggregation: z.enum(AGGREGATIONS).default("latest"),
  windowSec: z.number().int().min(0).max(86400).default(0),
  /** The measurement window as a COUNT OF READINGS — see WINDOW_POLLS_FIELD.
   *  Wins over `windowSec`, which stays written as its wall-clock mirror. */
  windowPolls: WINDOW_POLLS_FIELD,
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
   * Offered for packet loss only (SATURATION_CEILING_METRICS), where the top of
   * the scale stops describing the thing the metric is named after. Inert on
   * every other metric — a path check's failure rate included. 100% loss is an
   * outage, which the down automation already owns; and since the loss anchor
   * was removed (business rule 29) a device coming back from a 55-minute outage
   * genuinely reads ~92% for the rest of the window, so an operator who does not
   * want an alert trailing every outage sets this to 90.
   *
   * Defaults to 100 when absent, which suppresses only a total outage and
   * leaves every pre-existing rule behaving as it always has.
   */
  ignoreAtOrAbove: z.number().min(0).max(100).optional(),
  /** PATH MONITOR — also evaluate the Polaris server's own run of the check
   *  (see PATH_METRICS). Path metrics only; absent = agent hosts only, which
   *  is every automation authored before the server could alert. */
  includeServer: z.boolean().optional(),
  /** FORECAST HORIZON (days) — see FORECAST_HORIZON_METRICS. The reading is
   *  the level the metric is projected to reach this many days out, so each
   *  severity tier's threshold is the level it is about. Inert on every other
   *  metric; absent = FORECAST_DAYS_DEFAULT. */
  forecastDays: z.number().int().min(1).max(365).optional(),
  /** LINKED LEVELS — a forecast metric's levels taken from another
   *  automation (see FORECAST_LEVEL_SOURCE_METRICS): its threshold, operator,
   *  base severity and severity bands, re-read at every evaluation so an edit
   *  there moves the forecast too (`linkForecastLevels`). Inert on every other
   *  metric. */
  levelsFromRuleId: z.string().min(1).max(64).optional(),
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
  /**
   * SPEAK FOR A SILENCED DEVICE (business rule 78) — valid only on
   * `monitorStatus == down`, like `missedPolls`. A device behind a down switch
   * or firewall is dependency-suppressed (Dep. Down) and normally alerts
   * nothing (rules 16 and 37). With this on, THIS automation still raises its
   * alert the moment such a device turns Dep. Down, and the alert says so and
   * names the upstream device that is actually down. Read only through
   * `ruleAlertsWhenDependencyDown`, never off the raw key.
   *
   * Optional, absent on every automation authored before the key existed —
   * absence is the pre-feature behaviour (silence), and an operator who never
   * asked to be told about a parent's outage keeps not being told.
   */
  alertWhenDependencyDown: z.boolean().optional(),
});

const hostMetricTrigger = z.object({
  type: z.literal("host_metric"),
  metric: z.enum(HOST_METRICS),
  aggregation: z.enum(AGGREGATIONS).default("latest"),
  windowSec: z.number().int().min(0).max(86400).default(0),
  /** The measurement window as a COUNT OF READINGS — see WINDOW_POLLS_FIELD.
   *  The host samples itself every 30s, so a reading here is 30s. */
  windowPolls: WINDOW_POLLS_FIELD,
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
  /** PATH MONITOR — `path_check_path_changed` only: also fire on a change in
   *  the Polaris server's own traceroute (an Event naming the CHECK, not a
   *  host). Absent keeps the pre-flag behaviour — see eventMatchesPathServer. */
  includeServer: z.boolean().optional(),
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

type TriggerGroupOp = (typeof TRIGGER_GROUP_OPS)[number];

// Leaves are the existing threshold conditions minus the hold in BOTH its
// spellings (the sustain applies to the whole composite, not per leaf) — a leaf
// that kept `forPolls` would be a second hold the tree's own count already owns.
const compositeAssetMetricLeaf = assetMetricTrigger.omit({ forDurationSec: true, forPolls: true, includeServer: true });

const compositeAssetStateLeaf = assetStateTrigger.omit({ forDurationSec: true, forPolls: true });

const compositeHostMetricLeaf = hostMetricTrigger.omit({ forDurationSec: true, forPolls: true });

const compositeLeafSchema = z.discriminatedUnion("type", [
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
  const allLeaves = collectTriggerLeaves(trigger);
  const pathLeaves = allLeaves.filter((l) => l.type === "asset_metric" && isPathMetric(l.metric)).length;
  if (pathLeaves > 0 && pathLeaves < allLeaves.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["trigger"],
      message: "Path Monitor conditions cannot be combined with device conditions — make them separate automations",
    });
  }
  const badLeaf = allLeaves.find((l) =>
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

export type Trigger = z.infer<typeof triggerSchema>;

export type RuleScope = z.infer<typeof scopeSchema>;

export interface MemberIpFilter { operator: "==" | "!="; ip: string }

/** "!= 0.0.0.0" → {operator, ip}; null for anything else. Whitespace-tolerant;
 *  the address must be a real IPv4/IPv6 address (0.0.0.0 included). */
export function parseMemberIpFilter(raw: string | null | undefined): MemberIpFilter | null {
  const m = /^\s*(==|!=)\s*(\S+)\s*$/.exec(String(raw ?? ""));
  if (!m) return null;
  const ip = m[2]!;
  if (!isValidIpAddress(ip)) return null;
  return { operator: m[1] as "==" | "!=", ip };
}
