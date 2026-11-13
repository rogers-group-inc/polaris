/**
 * src/services/notifications/ruleModel.ts — an automation rule as the engine evaluates it (CQ-B063, moved verbatim from notificationEngine.ts): the DB rule shape
 * (normalized to v2), the scope-asset row, a Reading, the comparators, and the lookback
 * windows a trigger needs (lookbackMsFor / fireLookbackMsFor / withRecoveryLookback).
 */

import { type Trigger, type RuleScope, type EmailComposition, type EscalationV2Config, type ResetConfig, type RepeatConfig, type AutomationAction, type EscalatableAction, type SeverityBand, type BandNotify, numMeets, downRecoveryConsumesSustain, triggerHoldPolls, triggerWindowPolls, resetSustainPolls, type CompositeLeaf, type TriggerConditionGroup, isTriggerLeaf } from "../notificationTypes.js";
import { type ScopeAsset } from "../notificationRuleService.js";

export const DEFAULT_LOOKBACK_MS = 15 * 60 * 1000;
 // window to find the "latest" sample
/** Most recent readings kept per (asset, dimension) for run counting. A hold is
 *  capped at 100 polls, so this covers the longest one with room to spare while
 *  bounding what a chatty dimension costs in memory on a 2000-asset tick. */
export const SERIES_CAP = 200;

/**
 * How far back a trigger's samples must be fetched. Normally the 15-minute
 * "find the latest sample" window (or the aggregation's own window), but a
 * poll-counted hold has to SEE its N readings: `forDurationSec` is the
 * wall-clock mirror of that count (polls × the scope's cadence at authoring
 * time), so twice it covers N readings with room for jitter and a missed poll.
 * Capped at 6 hours — past that this stops being an interactive query, and a
 * hold that long is a wall-clock question anyway.
 */
const HOLD_LOOKBACK_CAP_MS = 6 * 60 * 60 * 1000;

/**
 * A COUNT window needs its readings to have HAPPENED, and a lossy device
 * produces them slower than the cadence suggests — the whole point of counting
 * measurements instead of minutes (business rule 66). The groups are DISJOINT,
 * so a hold of M groups needs groupSize x M readings behind it — the PRODUCT of
 * the two counts, not their sum — which is `windowSec` (the group's wall-clock
 * mirror) times the hold. Then doubled.
 *
 * TWO, not more, and the reason is fleet scale rather than correctness. Doubling
 * covers a device losing half its probes; past that the query would have to grow
 * without bound on the 60s tick, and at 2000 assets this fetch is already the
 * heaviest thing an automation does. A device worse than 50% simply produces too
 * few readings to fill the window, which `rollingAggregate` reports as NO
 * READING rather than as an average of whatever it happened to find — and that
 * is the right answer twice over: the operator asked for the last N responses
 * and there are not N of them, and a device at that loss rate is a packet-loss
 * and down-detection problem which those metrics already own (business rule 29,
 * business rule 36).
 *
 * A rule that states counts but NO wall-clock mirror gets the full cap. Only an
 * API-authored rule can be in that state — the builder always writes the mirror
 * — and guessing a cadence the trigger never stated would silently under-fetch
 * and hold an alert open forever waiting for readings the query excluded.
 */
const COUNT_WINDOW_LOOKBACK_FACTOR = 2;

type LookbackTrigger = {
  windowSec?: number; forDurationSec?: number; forPolls?: number | null;
  windowPolls?: number | null; aggregation?: string;
  /** Stamped by `withRecoveryLookback`, never stored: the reset's own span. */
  recoveryLookbackMs?: number;
};

export function lookbackMsFor(trigger: LookbackTrigger): number {
  return Math.max(fireLookbackMsFor(trigger), trigger.recoveryLookbackMs ?? 0);
}

/**
 * The FIRE side's lookback alone — the window a time-windowed aggregate is
 * taken over. Kept apart from `lookbackMsFor` because a reset that counts polls
 * may widen the fetch (so its run can see N readings), and an "avg over 15
 * minutes" must not quietly become an average over the wider span.
 */
export function fireLookbackMsFor(trigger: LookbackTrigger): number {
  const base = Math.max((trigger.windowSec ?? 0) * 1000, DEFAULT_LOOKBACK_MS);
  if (triggerWindowPolls(trigger)) {
    const groups = Math.max(1, triggerHoldPolls(trigger));
    const span = (trigger.windowSec ?? 0) * 1000 * groups;
    if (span <= 0) return HOLD_LOOKBACK_CAP_MS;
    return Math.max(base, Math.min(span * COUNT_WINDOW_LOOKBACK_FACTOR, HOLD_LOOKBACK_CAP_MS));
  }
  if (!triggerHoldPolls(trigger)) return base;
  return Math.max(base, Math.min((trigger.forDurationSec ?? 0) * 2000, HOLD_LOOKBACK_CAP_MS));
}

/**
 * A reset that clears after N consecutive recovered readings (`sustainPolls`)
 * counts them off the SAME fetched series the fire side reads — so the fetch
 * has to be wide enough to hold N of them. Sized from the trigger alone, it
 * was not: a 15-poll clear on a 900s window at a one-minute cadence fetched
 * ~15 samples, and whether all 15 landed inside the window depended on the
 * phase between the collector and the engine tick. A phase that left the
 * oldest a few seconds outside held the alert open indefinitely with the
 * condition long gone (an SD-WAN packet-loss alert on 2026-10-08 sat for
 * hours at 0% loss).
 *
 * Same sizing as a poll-counted hold: `sustainSec` is the wall-clock mirror
 * of `sustainPolls`, doubled for jitter and a missed poll, capped at 6 hours;
 * a count with no mirror (API-authored) gets the cap rather than a guess.
 * Returns the trigger unchanged when the reset counts nothing.
 */
export function withRecoveryLookback<T extends Trigger>(trigger: T, reset: ResetConfig | null | undefined): T {
  // engineSustainPolls' carve-out too: a down rule whose sustain the monitor
  // state machine consumed counts nothing here, so it fetches nothing extra.
  if (!reset || engineSustainPolls({ trigger, reset }) <= 0) return trigger;
  const sustainSec = (reset as { sustainSec?: unknown }).sustainSec;
  const mirror = typeof sustainSec === "number" && sustainSec > 0 ? sustainSec : 0;
  const recoveryLookbackMs = mirror > 0
    ? Math.min(mirror * 1000 * COUNT_WINDOW_LOOKBACK_FACTOR, HOLD_LOOKBACK_CAP_MS)
    : HOLD_LOOKBACK_CAP_MS;
  return { ...trigger, recoveryLookbackMs };
}

/**
 * Business rule 178: the span a TIME-windowed aggregate covers — the window
 * the rule states. 0 when the rule has none: `latest`, a window counted in
 * readings (rule 66), or no `windowSec`.
 *
 * Until 2026-11-13 the aggregate covered the whole FETCH, which is floored at
 * DEFAULT_LOOKBACK_MS (15 min): "average CPU over 5 minutes" — the High CPU,
 * High memory, Slow response and temperature baselines — averaged 15.
 */
export function timeWindowMs(trigger: LookbackTrigger): number {
  if (!trigger.windowSec || trigger.windowSec <= 0) return 0;
  if (!trigger.aggregation || trigger.aggregation === "latest") return 0;
  if (triggerWindowPolls(trigger)) return 0;
  return trigger.windowSec * 1000;
}

/**
 * The oldest sample a time-windowed aggregate may include: the window the
 * rule states (rule 178); else the fire side's window when a reset widened
 * the fetch past it; else no bound — everything fetched IS the window.
 */
export function aggregateSinceMs(trigger: LookbackTrigger, nowMs: number): number {
  const stated = timeWindowMs(trigger);
  if (stated > 0) return nowMs - stated;
  const fire = fireLookbackMsFor(trigger);
  return lookbackMsFor(trigger) > fire ? nowMs - fire : -Infinity;
}

/**
 * Rule 178: when the stated window holds no reading — a window shorter than
 * the device's polling interval — the newest reading stands in for it, if it
 * is no older than the fire side's lookback (the span the aggregate used to
 * cover, so nothing older than before is ever read). -Infinity when the rule
 * has no stated window, meaning "no stand-in": the old behaviour.
 */
export function aggregateFallbackSinceMs(trigger: LookbackTrigger, nowMs: number): number {
  return timeWindowMs(trigger) > 0 ? nowMs - fireLookbackMsFor(trigger) : -Infinity;
}

// probeLossPct is a windowed RATIO, so its window is the measurement rather than
// a lookback (business rule 29). The resolution (configured window floored at 5
// min, defaulted to 15) lives in notificationTypes as `probeLossWindowSec`,
// SHARED with the alert-email loss chart so the chart's window can never
// disagree with the window the alert was measured over.

// ─── A rule as loaded from the DB (normalized to shape v2) ──────────────────
export interface DbRule {
  id: string;
  name: string;
  description: string | null;
  severity: string;
  trigger: Trigger;
  scope: RuleScope;
  /** v2 reset semantics (legacy clearBehavior/clearAfterSec normalized in). */
  reset: ResetConfig;
  /** v2 unified action list (legacy targets normalized in); actions may carry
   *  their own escalation chain (per-action escalation). */
  actions: EscalatableAction[];
  cooldownSec: number | null;
  messageTemplate: string | null;
  emailComposition: EmailComposition | null;
  /** Escalation as v2 tiers-of-actions (legacy tiers converted by the normalizer). */
  escalation: EscalationV2Config | null;
  /** Severity bands (numeric triggers only); null = single-severity. */
  severityBands: SeverityBand[] | null;
  /** Band-transition notify policy; null = defaults (increase + resolved/reuse). */
  bandNotify: BandNotify | null;
  /** Actions to run when the alert ENDS; null = nothing happens on reset. */
  resetActions: AutomationAction[] | null;
  /** Re-send while unhandled; null = never repeats. Read by ruleWantsContext —
   *  a repeat-only rule still needs its templateCtx snapshot. */
  repeat: RepeatConfig | null;
  /** Consolidate this rule's per-component alerts into one alert per device
   *  (business rule 75). Never read directly — go through `ruleGroupsByAsset`,
   *  which also checks the trigger actually reports per component. */
  groupByAsset: boolean;
  /** Business rule 136(e): severity follows the device's / port's Priority
   *  tag. Optional so a rule built without it reads as off. Read through
   *  `rulePrioritySubject`, which also checks the trigger qualifies. */
  severityFromPriorityTag?: boolean;
  /** The AlertGroup this rule delivers through, or null. Membership implies
   *  the per-component fold AND folds this rule's alerts together with every
   *  other member's on the same device. */
  alertGroupId: string | null;
  /** That group's fold axis — one of ALERT_GROUP_FOLD_BY. Null
   *  with no group. Optional so a rule built without it reads as "device". */
  alertGroupFoldBy?: string | null;
  /** That group's name — what a whole-group alert is named for. */
  alertGroupName?: string | null;
}

// Extends ScopeAsset (which extends notificationTypes.ScopeConditionAsset), so
// the condition-tree fields (manufacturer/model/os — SCOPE_SELECT populates
// them; optional so the pseudo-host row can omit them) are inherited and the
// three layers can't drift.
export interface ScopeAssetRow extends ScopeAsset {
  hostname: string | null;
  monitorStatus: string | null;
  status: string;
  consecutiveFailures: number;
  dependencySuppressed: boolean;
  quarantinedAt: Date | null;
  ipAddress: string | null;
  // Controller link state + when the controller last answered about this
  // device (business rule 59). The timestamp is the READING ANCHOR for the
  // field, not decoration — see the resolver.
  fortilinkStatus: string | null;
  fortilinkCheckedAt: Date | null;
  // Read by the firmwareVsPrimary resolver (business rule 87) alongside
  // manufacturer / model / assetType — the four facts the Repository matches
  // an image on.
  serialNumber?: string | null;
  osVersion?: string | null;
  // Read by the device-identifier dimension filters (applyDeviceFilters).
  macAddress?: string | null;
  // Read by every interface resolver — state trio AND counter metrics — for
  // the pinned-interface gate (interfaceIsPinned).
  monitoredInterfaces?: string[];
  // Read by both IPsec resolvers (ipsecStatus / ipsecThroughputBps) for the
  // pinned-tunnel gate (tunnelIsPinned).
  monitoredIpsecTunnels?: string[];
  // Read by all three storage resolvers (storageUsedBytes / storageUsedPct /
  // storageDaysUntilFull) for the pinned-mount gate (storageIsPinned).
  monitoredStorage?: string[];
  // Poll anchors for the current-state readings (see SCOPE_SELECT).
  lastMonitorAt?: Date | null;
  lastSystemInfoAt?: Date | null;
  // The two stream-failing fields (business rule 118): each stream's last
  // attempt (the reading anchor) and the start of its open failure run.
  lastTelemetryAttemptAt?: Date | null;
  telemetryFailingSince?: Date | null;
  lastSystemInfoAttemptAt?: Date | null;
  systemInfoFailingSince?: Date | null;
  // Read ONLY by the builder's device-list preview (optional so the pseudo-host
  // row can omit it). The engine never filters on it — see SCOPE_SELECT.
  monitored?: boolean;
}

/** A single evaluated reading for a (asset, dimension). */
export interface Reading {
  assetId: string;
  hostname: string | null;
  tags: string[];
  dimKey: string;
  dimLabel: string;
  value: number | string | boolean | null;
  /**
   * The recent readings behind `value`, NEWEST FIRST — present only for a
   * SERIES source (every sample table, plus the Polaris host's own metrics).
   * A poll-counted hold is resolved from this statelessly (leadingRun), which
   * is what makes "3 polls" mean three readings whatever the engine's tick
   * spacing is, and what stops a device that has stopped reporting from
   * satisfying a hold with one stale sample re-read at every tick.
   */
  series?: (number | string | boolean | null)[];
  /**
   * The series the RECOVERY run is counted off, when it is not `series` — set
   * only by cpuCorePct (business rule 89), whose `series` is a per-core
   * envelope that counts one core's run and would read a single recovered poll
   * as a whole run of them. Newest first, like `series`.
   */
  clearSeries?: (number | string | boolean | null)[];
  /**
   * When this reading was taken: the newest sample's timestamp for a series
   * source, that stream's poll anchor on the Asset for a current-state one
   * (`lastMonitorAt` for the probe-backed fields; the SD-WAN rule readings
   * use the rule row's own `updatedAt`, written only by a successful read). The current-state path counts observations on the state row
   * and uses this to tell a NEW poll from the same one seen again.
   */
  readingAt?: Date | null;
  /**
   * Business rule 78 — this reading was SYNTHESIZED for a dependency-suppressed
   * device on a down automation that opted to speak for it: `value` is "down"
   * because the device's upstream is, not because its own probe said so (that
   * verdict is `ownMonitorStatus`). Everything downstream of the reading — the
   * fire, the message, the stored alert — carries the flavour, and a firing row
   * whose alert has the OTHER flavour is handed off rather than kept.
   */
  dependencyDown?: boolean;
  ownMonitorStatus?: string | null;
  /** A forecast reading's trend (memForecastPct): the newest day's memory in
   *  use and the fitted growth per day — what the message turns into "Days
   *  until Serious: 6" once the alert's severity names the level. */
  forecast?: { usedPct: number; slopePerDay: number };
}

// ─── Comparators ────────────────────────────────────────────────────────────
// Delegates to notificationTypes.numMeets — trigger evaluation and severity-
// band evaluation must share one comparator.

export const compareNum = numMeets;

export function compareValue(value: number | string | boolean | null, op: string, target: number | string | boolean): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number" && typeof target === "number") return compareNum(value, op, target);
  // string / boolean: only equality comparisons are meaningful
  const a = String(value).toLowerCase();
  const b = String(target).toLowerCase();
  if (op === "==") return a === b;
  if (op === "!=") return a !== b;
  // allow numeric comparison if both coerce to numbers (e.g. consecutiveFailures)
  const na = Number(value);
  const nb = Number(target);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return compareNum(na, op, nb);
  return false;
}

/** The clear-sustain as a COUNT, with the same down-detection carve-out
 *  `engineSustainSec` applies to its wall-clock twin (business rule 36). */
export function engineSustainPolls(rule: { trigger: Trigger; reset: ResetConfig }): number {
  if (downRecoveryConsumesSustain(rule.trigger, rule.reset)) return 0;
  return resetSustainPolls(rule.reset);
}

// ─── Composite trigger evaluation ───────────────────────────────────────────
// Composite rules evaluate PER ASSET: every metric/state leaf resolves its
// readings through the UNCHANGED single-trigger resolvers (one query per
// DISTINCT leaf shape), a multi-dimension leaf counts as met when ANY of its
// dimensions meets, and the AND/OR tree folds leaf truths into one outcome
// per asset. The state machine runs at dimensionKey "" — one alert per
// device. A deliberately separate path from evaluateThresholdRule (sharing
// only the fire/recover/upsertState write layer) so the legacy per-dimension
// path stays byte-identical.

export interface LeafRef {
  /** Tree-path id ("0", "1.2") — stable across trigger and preview so the
   *  wizard can highlight its builder rows. */
  leafId: string;
  leaf: CompositeLeaf;
}

export function collectLeafRefs(node: { children: (TriggerConditionGroup | CompositeLeaf)[] }, prefix = ""): LeafRef[] {
  const out: LeafRef[] = [];
  node.children.forEach((c, i) => {
    const id = prefix ? `${prefix}.${i}` : String(i);
    if (isTriggerLeaf(c)) out.push({ leafId: id, leaf: c });
    else out.push(...collectLeafRefs(c, id));
  });
  return out;
}
