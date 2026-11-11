/**
 * src/services/notifications/severityBands.ts — severity bands — value-driven severity escalation (CQ-B063, moved verbatim from notificationEngine.ts): the tier a
 * reading has reached, met-since bookkeeping, severity levels.
 */

import { Prisma } from "../../generated/prisma/client.js";
import { type Trigger, type EscalationV2Config, type ResetConfig, type AutomationAction, type SeverityBand, type BandNotify, type Severity, severityForValue, type ResolvedTier, resolveTierLadder, normalizeEscalationToV2, numMeets, leadingRun, advanceRun } from "../notificationTypes.js";
import { type DbRule, type Reading } from "./ruleModel.js";
import { rulePrioritySubject, readingMeets, recoveredMeets } from "./readings.js";

// ─── Severity bands (value-driven severity escalation) ──────────────────────
// Tier 0 = rule.severity + trigger.threshold + rule.actions/escalation; bands
// stack higher tiers on top. The alert is ONE row per (rule,asset,dim); its
// severity climbs with the value (re-notifying per bandNotify) and clears below
// tier 0. See notificationTypes.severityForValue.

interface EffectiveTier {
  severity: string;
  actions: AutomationAction[];
  escalation: EscalationV2Config | null;
}

/** Whether this rule uses value-driven severity bands (numeric trigger only). */
export function ruleHasBands(rule: DbRule): boolean {
  return !!(rule.severityBands && rule.severityBands.length) &&
    (rule.trigger.type === "asset_metric" || rule.trigger.type === "host_metric");
}

/** The band severity for a numeric reading (null = below tier 0 / not firing).
 *  INSTANTANEOUS — ignores per-tier sustain; used for the "is the rule firing
 *  at all" decision (tier 0 membership). The severity the alert actually takes
 *  comes from sustainedSeverity over the tier ladder. */
export function bandSeverityFor(rule: DbRule, value: number | null): string | null {
  const t = rule.trigger;
  if (t.type !== "asset_metric" && t.type !== "host_metric") return null;
  return severityForValue(t.operator, t.threshold, rule.severity as Severity, rule.severityBands as SeverityBand[] | null, value);
}

/** The rule's effective tier ladder (base + bands), each tier's operator and
 *  sustained duration resolved. Built once per rule per tick. */
export function tierLadderFor(rule: DbRule): ResolvedTier[] | null {
  const t = rule.trigger;
  if (t.type !== "asset_metric" && t.type !== "host_metric") return null;
  return resolveTierLadder(
    t.operator,
    t.threshold,
    rule.severity as Severity,
    t.forDurationSec ?? 0,
    rule.severityBands as SeverityBand[] | null,
    (t as { forPolls?: number }).forPolls ?? null,
  );
}

/**
 * How many consecutive READINGS, ending with this one, satisfied `meets` —
 * `null` when the source carries no series and the caller must count
 * observations on the state row instead (advanceRun).
 *
 * The predicate is applied to the raw readings in `series`, so it answers the
 * question the operator asked ("three polls over 90") rather than the question
 * wall-clock answered ("the newest sample has read over 90 at every tick for
 * three cadences, whether or not any new sample arrived").
 */
function seriesRun(reading: Reading, meets: (v: number | string | boolean | null) => boolean): number | null {
  if (!reading.series) return null;
  return leadingRun(reading.series, meets);
}

/**
 * Both runs behind one reading — how many consecutive readings have MET the
 * trigger, and how many have RECOVERED from it — resolved for either family of
 * source. `stateful` says the numbers came from the state row rather than from
 * a series, and `advanced` whether this reading moved them (a repeat of the
 * same poll does not, which is what keeps the hot path transition-write-only).
 */
interface ReadingRuns { metRun: number; clearRun: number; stateful: boolean; advanced: boolean }

export function readingRuns(
  reading: Reading,
  st: { metRun?: number; clearRun?: number; lastReadingAt?: Date | null } | undefined,
  trigger: Trigger,
  reset: ResetConfig,
  meets: boolean,
  recovered: boolean,
): ReadingRuns {
  const met = seriesRun(reading, (v) => readingMeets(trigger, v));
  if (met !== null) {
    const clearOf = reading.clearSeries ? { ...reading, series: reading.clearSeries } : reading;
    const clear = seriesRun(clearOf, (v) => recoveredMeets(trigger, reset, v)) ?? 0;
    return { metRun: met, clearRun: clear, stateful: false, advanced: false };
  }
  const m = advanceRun(st?.metRun ?? 0, meets, reading.readingAt, st?.lastReadingAt);
  const c = advanceRun(st?.clearRun ?? 0, recovered, reading.readingAt, st?.lastReadingAt);
  return { metRun: m.run, clearRun: c.run, stateful: true, advanced: m.advanced };
}

/**
 * Per-tier runs for a banded rule: each tier tests its OWN threshold against
 * the same series, so a value climbing into critical starts critical's run at 1
 * while warning's keeps counting. Null when the source has no series — the
 * windowed-ratio metrics are the only banded triggers that can hit that, and
 * they keep the wall-clock ladder (there is no series of ratios to count).
 */
export function tierRuns(reading: Reading, tiers: ResolvedTier[]): Record<string, number> | null {
  if (!reading.series) return null;
  const out: Record<string, number> = {};
  for (const tier of tiers) {
    out[tier.severity] = leadingRun(reading.series, (v) => typeof v === "number" && numMeets(v, tier.operator, tier.threshold));
  }
  return out;
}

/**
 * What a row returning to `clear` stores for its poll-counted runs. Zeroed
 * TOGETHER with the timers, and not optional: a stale `metRun` left behind by a
 * cleared alert would let the very next qualifying reading fire immediately,
 * skipping the hold entirely (advanceRun counts up from whatever it finds).
 */
export const CLEARED_RUNS = { metRun: 0, clearRun: 0, lastReadingAt: null } as const;

/** Per-tier met-since map → the Json column value (empty map stores as SQL
 *  NULL so a cleared row reads the same as a pre-feature one). */
export function metSinceJson(map: Record<string, number> | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return map && Object.keys(map).length ? (map as Prisma.InputJsonValue) : Prisma.DbNull;
}

/** The stored per-tier met-since map on a state row (Json column). */
export function metSinceOf(st: { bandMetSince?: unknown } | undefined | null): Record<string, number> | null {
  const raw = st?.bandMetSince;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** The actions + escalation for a resolved severity. A band uses its OWN
 *  actions/escalation when it carries any, else falls back to the base tier's
 *  (severity tiers usually carry none — the alert re-notifies with the base
 *  Actions-step actions + base escalation at the tier's severity). */
export function tierForSeverity(rule: DbRule, severity: string): EffectiveTier {
  if (severity !== rule.severity) {
    const band = (rule.severityBands ?? []).find((b) => b.severity === severity);
    if (band) {
      const bandEsc = normalizeEscalationToV2(band.escalation);
      return {
        severity,
        actions: band.actions && band.actions.length ? band.actions : rule.actions,
        escalation: bandEsc ?? rule.escalation,
      };
    }
    // A severity no band names: the Priority tag's (business rule 136(e)).
    // It keeps the severity it was asked for, with the base actions — every
    // priority shares the automation's own actions and escalation.
    if (rulePrioritySubject(rule)) return { severity, actions: rule.actions, escalation: rule.escalation };
  }
  return { severity: rule.severity, actions: rule.actions, escalation: rule.escalation };
}

/** Normalized band-notify policy with defaults. */
export function bandNotifyOf(rule: DbRule): { onIncrease: boolean; onDecrease: boolean; onResolved: boolean; resolvedMode: "reuse" | "dedicated"; resolvedActions: AutomationAction[] } {
  const b: BandNotify | null = rule.bandNotify;
  return {
    onIncrease: b?.onIncrease ?? true,
    onDecrease: b?.onDecrease ?? false,
    onResolved: b?.onResolved ?? true,
    resolvedMode: b?.resolvedMode ?? "reuse",
    resolvedActions: b?.resolvedActions ?? [],
  };
}

export function severityLevel(severity: string): "error" | "warning" | "info" {
  return severity === "critical" || severity === "serious" ? "error" : severity === "warning" ? "warning" : "info";
}
