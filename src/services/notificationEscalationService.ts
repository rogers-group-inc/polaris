/**
 * src/services/notificationEscalationService.ts
 *
 * The escalation sweep behind the escalateNotifications job (60s): while a
 * notification stays unhandled, run each of its rule's escalation tiers when
 * the tier's delay elapses (optionally repeating every repeatEveryMin up to
 * maxRepeats). "Unhandled" is per chain stopOn: "acknowledge" stops on
 * acknowledge OR clear; "clear" ignores acknowledgment and only stops on clear.
 *
 * PER-ACTION ESCALATION: chains live at the rule/band LEVEL (key "" — bare
 * numeric tier state keys, unchanged from pre-feature rows) and on individual
 * actions (key "a<i>" — state keys "a<i>:t<j>"). escalationChainsForSeverity
 * (notificationTypes) selects the chains active at the alert's current
 * severity: the band's level chain + its actions' chains, with the engine's
 * empty-band fallback to the base actions mirrored here.
 *
 * ESCALATION V2: a tier carries ACTIONS (notify / api_call / script), not just
 * an email — every due tier fans out through automationActionService.
 * executeActions with `exec.escalation` set. Legacy email tiers (pre-wizard
 * rules) normalize to single-notify-action tiers via normalizeEscalationToV2,
 * and the notify arm's escalation composition (per-FIELD tier→rule fallback,
 * always-composed, "[ESCALATION n]" default-subject prefix) reproduces the
 * pre-v2 emails byte-for-byte.
 *
 * REPEATS: the same sweep also re-sends an alert's own notifications while it
 * stays unhandled (`NotificationRule.repeat`). Only escalation TIERS could
 * repeat before — the engine's fire() sends the base actions once and never
 * revisits them, so an alert nobody acknowledged went quiet after one email.
 * Reused rather than given its own job because this function already owns
 * unhandled-detection, the maintenance/dependency suppression pause, per-key
 * state on escalationState, templateCtx rendering and batched state writes; a
 * second job would re-load every enabled rule and re-query the unhandled set
 * every minute for nothing.
 *
 * Two properties of a repeat differ from a tier, deliberately: it re-runs
 * NOTIFY actions only (REPEATABLE_ACTION_TYPES — unbounded re-execution of a
 * ticket-creating webhook or a registry script is not symmetric with an extra
 * email), and it is UNBOUNDED unless the operator sets `stopAfterHours`, which
 * is why it cannot reuse tierIsDue (that resolves maxRepeats ?? 5).
 *
 * Repeats land on the 60s tick, so real spacing is everyMin + up to 60s of
 * jitter. That is fine at a 5-minute floor — don't "fix" the drift.
 *
 * QUIET TIME (business rule 44): a reminder due inside one of the repeat
 * config's quiet windows is HELD, not skipped — `lastSentAt` is deliberately
 * not advanced, so the reminder stays due and goes out on the first sweep
 * after the window ends. That is the whole mechanism, and it is why nothing
 * here needs to know when the window ends in order to schedule anything: a
 * held reminder is simply an overdue one. The hold is recorded on
 * `escalationState.quietHeldSince` / `quietHeldCount`, and that stamp is what
 * lets the reminder which follows say how long the alert has been active
 * ({repeat.quiet}, plus the "· ACTIVE 9h 12m" subject marker) — the operator's
 * question after a silent night is "how long has this been going on", not
 * "which reminder number is this". Quiet applies to the repeat pass ONLY:
 * escalation tiers run through a quiet window untouched.
 *
 * Rendering context = the fire-time Notification.templateCtx snapshot (exact
 * fire-time metric/asset values, survives asset deletion) plus the live
 * {escalation.tier}/{escalation.elapsed} tokens. Per-tier progress lives on
 * Notification.escalationState — a tier counts as SENT only when at least one
 * of its actions executed (empty recipients / dead channels retry next sweep).
 */

import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { logger } from "../utils/logger.js";
import {
  buildTemplateContext,
  formatElapsed,
  notificationsPageUrl,
} from "../utils/notificationTemplate.js";
import { isQuietNow, quietResumesAt } from "../utils/quietTime.js";
import { formatLocalIsoMinute } from "../utils/maintenanceRecurrence.js";
import { logEvent } from "./eventLogService.js";
import { isSuppressedForNotifications } from "./notificationEngine.js";
import { executeActions } from "./automationActionService.js";
import { scopeRegionTagsOf } from "./notificationRecipientService.js";
import {
  normalizeRuleToV2,
  effectiveActionsForSeverity,
  REPEAT_STATE_KEY,
  REPEATABLE_ACTION_TYPES,
  type RepeatConfig,
  normalizeEscalationToV2,
  escalationChainsForSeverity,
  escalationTierStateKey,
  type EmailComposition,
  type EscalationV2Config,
  type EscalatableAction,
  type SeverityBand,
  type RuleScope,
} from "./notificationTypes.js";

const DEFAULT_MAX_REPEATS = 5;

interface EscalationRule {
  id: string;
  name: string;
  description: string | null;
  scope: RuleScope;
  emailComposition: EmailComposition | null;
  /** Base severity (tier 0). */
  severity: string;
  /** v2 action list — actions may carry their own escalation chain. */
  actions: EscalatableAction[];
  /** Rule-level escalation chain, or null. */
  escalation: EscalationV2Config | null;
  /** Severity bands — band-level chains + per-band-action chains. */
  severityBands: SeverityBand[] | null;
  /** Re-send while unhandled; null = never repeats. */
  repeat: RepeatConfig | null;
}

/** Every escalation chain a rule can present — rule-level, per-action,
 *  band-level, and band-per-action — for rule inclusion + the minAfterMin
 *  candidate cutoff. */
function allEscalationsOf(rule: EscalationRule): EscalationV2Config[] {
  const out: EscalationV2Config[] = [];
  const add = (esc: unknown) => {
    const e = normalizeEscalationToV2(esc);
    if (e && e.tiers.length > 0) out.push(e);
  };
  add(rule.escalation);
  for (const a of rule.actions) if (a.type !== "event") add(a.escalation);
  for (const b of rule.severityBands ?? []) {
    add(b.escalation);
    for (const a of b.actions ?? []) if (a.type !== "event") add(a.escalation);
  }
  return out;
}

interface TierState {
  firstSentAt: string;
  lastSentAt: string;
  count: number;
}

// bandSince (severity bands): when the alert entered its current band, so a
// newly-entered band's escalation timers restart from band-entry rather than
// the original fire. Absent for single-severity alerts (timers run off
// triggeredAt). Stamped by the engine's applyBandTransition.
//
// quietHeldSince / quietHeldCount (business rule 44): when the first reminder
// of the CURRENT hold was withheld for quiet time, and how many have been.
// Present only while a hold is open — cleared by the reminder that finally
// goes out. Top-level rather than inside the repeat TierState because a hold
// is not a send: TierState's three fields all describe a delivery that
// happened, and overloading `lastSentAt` with "would have sent" is exactly
// what would make the reminder clock drift.
type EscalationState = {
  tiers: Record<string, TierState>;
  bandSince?: string;
  quietHeldSince?: string;
  quietHeldCount?: number;
};

function stateOf(raw: unknown): EscalationState {
  const o = raw && typeof raw === "object" ? (raw as any) : {};
  const tiers = o.tiers && typeof o.tiers === "object" ? o.tiers : {};
  return {
    tiers: { ...tiers },
    ...(typeof o.bandSince === "string" ? { bandSince: o.bandSince } : {}),
    ...(typeof o.quietHeldSince === "string" ? { quietHeldSince: o.quietHeldSince } : {}),
    ...(typeof o.quietHeldCount === "number" ? { quietHeldCount: o.quietHeldCount } : {}),
  };
}

/** Is this tier due to run now? (first run after afterMin; repeats per
 *  repeatEveryMin up to maxRepeats.) Structural tier type so both the legacy
 *  and v2 tier shapes fit. */
export function tierIsDue(
  tier: { afterMin: number; repeatEveryMin?: number | null; maxRepeats?: number | null },
  triggeredAt: Date,
  tierState: TierState | undefined,
  now: Date,
): boolean {
  if (now.getTime() - triggeredAt.getTime() < tier.afterMin * 60_000) return false;
  if (!tierState) return true;
  if (!tier.repeatEveryMin) return false; // run-once tier already ran
  const max = tier.maxRepeats ?? DEFAULT_MAX_REPEATS;
  if (tierState.count >= max) return false;
  return now.getTime() - new Date(tierState.lastSentAt).getTime() >= tier.repeatEveryMin * 60_000;
}

/**
 * Is a repeat due now?
 *
 * A SIBLING of tierIsDue rather than a reuse of it, and that matters: tierIsDue
 * resolves `tier.maxRepeats ?? DEFAULT_MAX_REPEATS`, so driving repeats through
 * a synthetic tier would silently stop after 5 — exactly the cap this feature
 * was asked NOT to have.
 *
 * The initial notification IS the first send, so repeat #1 is due one interval
 * after `startAt` (band-entry when banded, else the fire time) and each
 * subsequent one an interval after the last.
 */
export function repeatIsDue(
  repeat: { everyMin: number; stopAfterHours?: number | null },
  startAt: Date,
  state: TierState | undefined,
  now: Date,
): boolean {
  if (repeat.stopAfterHours && now.getTime() - startAt.getTime() >= repeat.stopAfterHours * 3_600_000) {
    return false;
  }
  const since = state ? new Date(state.lastSentAt).getTime() : startAt.getTime();
  return now.getTime() - since >= repeat.everyMin * 60_000;
}

/**
 * The fire-time token context a follow-up renders from. Shared by the tier and
 * repeat passes so a reminder can't end up describing the alert differently
 * from an escalation of the same alert.
 *
 * Pre-feature notifications (and any rule that snapshotted none) fall back to a
 * minimal context built from the row — see ruleWantsContext in the engine,
 * which is why `repeat` had to be threaded into DbRule.
 */
function followUpContext(
  n: { templateCtx: unknown; assetHostname: string | null; severity: string; triggeredAt: Date; message: string },
  rule: EscalationRule,
): Record<string, string> {
  return n.templateCtx && typeof n.templateCtx === "object"
    ? (n.templateCtx as Record<string, string>)
    : buildTemplateContext({
        asset: n.assetHostname ?? "",
        severity: n.severity,
        time: n.triggeredAt,
        link: notificationsPageUrl(),
        message: n.message,
        ruleName: rule.name,
        ruleDescription: rule.description,
      });
}

/** One sweep pass. Returns the number of follow-up executions (escalation tiers
 *  plus repeats) that ran at least one action. */
export async function runEscalationSweep(now = new Date()): Promise<number> {
  // Escalation rules are few — load enabled rules and filter in memory (same
  // posture as the engine's per-tick rule load). Normalize through the v2
  // view so legacy email tiers and v2 action tiers sweep identically.
  const dbRules = await prisma.notificationRule.findMany({
    where: { enabled: true },
    select: {
      id: true, name: true, description: true, scope: true, emailComposition: true, severity: true,
      escalation: true, targets: true, clearBehavior: true, clearAfterSec: true, reset: true, actions: true,
      severityBands: true, repeat: true,
    },
  });
  const rules = new Map<string, EscalationRule>();
  for (const r of dbRules) {
    const v2 = normalizeRuleToV2(r);
    const rule: EscalationRule = {
      id: r.id,
      name: r.name,
      description: r.description,
      scope: (r.scope ?? {}) as RuleScope,
      emailComposition: r.emailComposition as EmailComposition | null,
      severity: r.severity,
      actions: v2.actions,
      escalation: v2.escalation,
      severityBands: v2.severityBands,
      repeat: v2.repeat,
    };
    // Include the rule if ANY chain exists (rule-level, per-action, or band)
    // OR it repeats — a repeat-only automation has no chains at all.
    if (allEscalationsOf(rule).length > 0 || rule.repeat) rules.set(r.id, rule);
  }
  if (rules.size === 0) return 0;

  // Candidates: uncleared notifications of escalation rules past the earliest
  // tier delay (across tier 0 + every band). Bounded by the active-unhandled
  // set, not fleet size.
  // Both kinds of follow-up contribute a delay. Math.min() of NOTHING is
  // Infinity, and `new Date(now - Infinity)` is an Invalid Date that makes the
  // Prisma filter useless — reachable as soon as a repeat-only rule is the only
  // rule, so the empty case is guarded rather than assumed away.
  const dueMins = [
    ...Array.from(rules.values()).flatMap((r) => allEscalationsOf(r).flatMap((e) => e.tiers.map((t) => t.afterMin))),
    ...Array.from(rules.values()).flatMap((r) => (r.repeat ? [r.repeat.everyMin] : [])),
  ];
  if (dueMins.length === 0) return 0;
  const minAfterMin = Math.min(...dueMins);
  const notifs = await prisma.notification.findMany({
    where: {
      cleared: false,
      ruleId: { in: Array.from(rules.keys()) },
      triggeredAt: { lte: new Date(now.getTime() - minAfterMin * 60_000) },
    },
    select: {
      id: true, ruleId: true, assetId: true, assetHostname: true, severity: true, message: true,
      triggeredAt: true, acknowledged: true, templateCtx: true, escalationState: true,
      // The fire-time asset-region snapshot (already region:-stripped) —
      // recipientDeviceRegion routing; survives asset deletion.
      regionTags: true,
    },
  });
  if (notifs.length === 0) return 0;

  // Maintenance / dependency suppression: escalation pauses while the
  // notification's asset is silenced (tier timers keep running off
  // triggeredAt — a still-unhandled notification resumes escalating after
  // the window ends).
  const notifAssetIds = Array.from(new Set(notifs.map((n) => n.assetId).filter((id): id is string => !!id)));
  const suppressedAssetIds = new Set<string>();
  if (notifAssetIds.length > 0) {
    const assetRows = await prisma.asset.findMany({
      where: { id: { in: notifAssetIds } },
      select: { id: true, status: true, dependencySuppressed: true },
    });
    for (const a of assetRows) {
      if (isSuppressedForNotifications({ status: String(a.status), dependencySuppressed: a.dependencySuppressed })) {
        suppressedAssetIds.add(a.id);
      }
    }
  }

  const stateUpdates: { id: string; state: EscalationState }[] = [];
  let tierRuns = 0;
  let repeatRuns = 0;

  // Is each repeating rule quiet at THIS instant? Per rule, not per
  // notification: the answer is a property of the rule's windows and `now`
  // alone, and an all-assets automation with hundreds of live alerts would
  // otherwise re-evaluate the same recurrence for every one of them.
  const quietRules = new Map<string, boolean>();
  for (const r of rules.values()) {
    if (r.repeat?.quiet) quietRules.set(r.id, isQuietNow(r.repeat.quiet, now));
  }
  /** Reminders whose hold STARTED this sweep — one Event each, written after
   *  the loop so the notification pass stays free of extra awaits. */
  const quietPausedEvents: {
    notificationId: string;
    ruleName: string;
    assetHostname: string | null;
    resumesAt: string | null;
  }[] = [];

  for (const n of notifs) {
    const rule = rules.get(n.ruleId!);
    if (!rule) continue;
    // SUPPRESSION FIRST. It applies to both kinds of follow-up, and the chain
    // check below used to sit above it with an early `continue` — which a
    // repeat-only automation (no chains at all) would hit, silently disabling
    // the whole feature. Nothing may early-continue between the two passes.
    if (n.assetId && suppressedAssetIds.has(n.assetId)) continue; // silenced — resumes post-window

    // Value-driven escalation: the alert's CURRENT band (its severity) selects
    // which chains apply — the band's level chain + its actions' chains (empty
    // band → the base actions' chains, matching the engine's action fallback).
    // The engine resets escalationState on every band change, so a newly-
    // entered band's tiers start their timers fresh.
    const chains = escalationChainsForSeverity(rule, n.severity);

    const state = stateOf(n.escalationState);
    // Timers run from band-entry when banded (bandSince), else the fire time.
    const startAt = state.bandSince ? new Date(state.bandSince) : n.triggeredAt;
    let dirty = false;

    for (const chain of chains) {
      // stopOn is per chain: an acknowledged alert stops "acknowledge" chains
      // while its "clear" chains keep escalating until the alert clears.
      if (chain.escalation.stopOn !== "clear" && n.acknowledged) continue;

      for (const [idx, tier] of chain.escalation.tiers.entries()) {
        // Level chain ("") keeps the bare numeric keys pre-feature rows carry;
        // per-action chains key as "a<i>:t<j>".
        const tierKey = escalationTierStateKey(chain.key, idx);
        if (!tierIsDue(tier, startAt, state.tiers[tierKey], now)) continue;

        // Context: fire-time snapshot + live escalation tokens. Pre-feature
        // notifications (no templateCtx) get a minimal context from the row.
        const base = followUpContext(n, rule);
        const prev = state.tiers[tierKey];
        const attempt = (prev?.count ?? 0) + 1;
        const ctx: Record<string, string> = {
          ...base,
          "escalation.tier": String(idx + 1),
          "escalation.elapsed": formatElapsed(now.getTime() - n.triggeredAt.getTime()),
        };

        const { executed } = await executeActions(n.id, tier.actions, ctx, {
          scopeRegionTags: scopeRegionTagsOf(rule.scope),
          assetRegionTags: n.regionTags,
          assetId: n.assetId,
          ruleId: rule.id,
          ruleName: rule.name,
          ruleEmailComposition: rule.emailComposition,
          escalation: { tier: idx + 1, attempt },
          actor: "system:notification-escalation",
        });

        // A tier counts as sent only when something actually ran — a tier whose
        // recipients resolved empty / channel is disabled retries next sweep
        // (same behavior as the pre-v2 sweep).
        if (executed > 0) {
          state.tiers[tierKey] = {
            firstSentAt: prev?.firstSentAt ?? now.toISOString(),
            lastSentAt: now.toISOString(),
            count: attempt,
          };
          dirty = true;
          tierRuns++;
        }
      }
    }

    // ── Repeat pass ────────────────────────────────────────────────────────
    // Independent of the chains above: an automation may repeat, escalate, or
    // both, and at everyMin 15 with a tier at afterMin 30 the T+30 sweep sends
    // BOTH. The reminder is deliberately NOT suppressed in that sweep —
    // skipping it would drift the clock and make "every 15 minutes" a lie. The
    // wizard warns about the pairing at authoring time instead.
    if (rule.repeat) {
      // stopOn mirrors escalation's: "acknowledge" stops on ack OR clear (the
      // query already excludes cleared), "clear" ignores acknowledgement.
      const stopsOnAck = rule.repeat.stopOn !== "clear";
      const prevRepeat = state.tiers[REPEAT_STATE_KEY];
      if (!(stopsOnAck && n.acknowledged) && repeatIsDue(rule.repeat, startAt, prevRepeat, now)) {
        // QUIET TIME. Resolved once per rule per sweep (quietRules), because a
        // recurrence answer is per rule and per instant — nothing about it
        // varies by notification, and an all-assets automation with 400 live
        // alerts must not evaluate the same windows 400 times.
        if (quietRules.get(rule.id)) {
          // HELD, not skipped: `lastSentAt` stays where it was, so this
          // reminder is still due on the first sweep after the window ends.
          const held = (state.quietHeldCount ?? 0) + 1;
          if (!state.quietHeldSince) {
            state.quietHeldSince = now.toISOString();
            // ONE Event per hold, not one per withheld sweep: an eight-hour
            // quiet window ticks 480 times, and 480 identical rows would bury
            // the timeline of the outage they describe. The resume time is the
            // detail worth having — it is the answer to "why has this alert
            // gone silent", and it is not derivable from the row.
            const resumesAt = quietResumesAt(rule.repeat.quiet, now);
            quietPausedEvents.push({
              notificationId: n.id,
              ruleName: rule.name,
              assetHostname: n.assetHostname,
              resumesAt: resumesAt ? formatLocalIsoMinute(resumesAt) : null,
            });
          }
          state.quietHeldCount = held;
          dirty = true;
        } else {
          const attempt = (prevRepeat?.count ?? 0) + 1;
          const elapsed = formatElapsed(now.getTime() - n.triggeredAt.getTime());
          // The reminder that ENDS a hold says so, and says how long the alert
          // has been active — the question someone reads it to answer. Carried
          // as a token rather than prepended to the body so an operator's own
          // template can place it, and so the push body gets the same sentence
          // through followUpLine.
          const resumedFromQuiet = !!state.quietHeldSince;
          const ctx: Record<string, string> = {
            ...followUpContext(n, rule),
            "repeat.attempt": String(attempt),
            "repeat.elapsed": elapsed,
            "repeat.quiet": resumedFromQuiet
              ? `Reminders resumed after a quiet period — this alert has been active for ${elapsed}.`
              : "",
          };
          // NOTIFY only — see REPEATABLE_ACTION_TYPES. validateRuleV2 refuses a
          // repeat on an automation with no notify action anywhere, so an empty
          // list here means the alert is in a band whose own actions are all
          // api_call/script, which is a real state and simply sends nothing.
          const repeatable = new Set<string>(REPEATABLE_ACTION_TYPES);
          const actions = effectiveActionsForSeverity(rule, n.severity).filter((a) => repeatable.has(a.type));
          if (actions.length > 0) {
            const { executed } = await executeActions(n.id, actions, ctx, {
              scopeRegionTags: scopeRegionTagsOf(rule.scope),
              assetRegionTags: n.regionTags,
              assetId: n.assetId,
              ruleId: rule.id,
              ruleName: rule.name,
              ruleEmailComposition: rule.emailComposition,
              repeat: { attempt, elapsed, ...(resumedFromQuiet ? { quietResumed: true } : {}) },
              actor: "system:notification-repeat",
            });
            if (executed > 0) {
              state.tiers[REPEAT_STATE_KEY] = {
                firstSentAt: prevRepeat?.firstSentAt ?? now.toISOString(),
                lastSentAt: now.toISOString(),
                count: attempt,
              };
              // The hold is closed by the SEND, not by the window ending: a
              // reminder whose channel was dead retries next sweep and must
              // still be the one that reports the silence.
              delete state.quietHeldSince;
              delete state.quietHeldCount;
              dirty = true;
              repeatRuns++;
            }
          }
        }
      }
    }

    if (dirty) stateUpdates.push({ id: n.id, state });
  }

  // NOT `tierRuns === 0 && repeatRuns === 0`: a quiet hold produces a state
  // update and no execution at all, and returning early on the counters alone
  // would drop the very stamp that lets the post-quiet reminder report the
  // silence — the whole feature, lost to an optimization for the common case.
  if (stateUpdates.length === 0 && quietPausedEvents.length === 0) return 0;

  if (stateUpdates.length > 0) {
    await prisma.$transaction(
      stateUpdates.map((u) =>
        prisma.notification.update({ where: { id: u.id }, data: { escalationState: u.state as unknown as Prisma.InputJsonValue } }),
      ),
    );
  }

  for (const q of quietPausedEvents) {
    await logEvent({
      action: "notification.reminders_paused",
      resourceType: "notification",
      resourceId: q.notificationId,
      resourceName: q.ruleName,
      actor: "system:notification-repeat",
      level: "info",
      message:
        `Reminders paused for quiet time${q.assetHostname ? ` on ${q.assetHostname}` : ""}` +
        (q.resumesAt ? ` — next reminder at ${q.resumesAt}` : ""),
      details: { resumesAt: q.resumesAt, assetHostname: q.assetHostname },
    }).catch(() => {});
  }

  if (tierRuns > 0) {
    await logEvent({
      action: "notification.escalated",
      resourceType: "notification",
      actor: "system:notification-escalation",
      level: "info",
      message: `Escalation: ${tierRuns} tier run(s) executed for ${stateUpdates.length} unhandled notification(s)`,
      details: { tierRuns, notifications: stateUpdates.length },
    }).catch(() => {});
  }

  // A SEPARATE action from notification.escalated on purpose: sharing one
  // string would inflate every "how much did we escalate?" query and make a
  // reminder indistinguishable from an escalation in the audit log.
  if (repeatRuns > 0) {
    await logEvent({
      action: "notification.repeated",
      resourceType: "notification",
      actor: "system:notification-repeat",
      level: "info",
      message: `Reminders: ${repeatRuns} unhandled alert(s) re-notified`,
      details: { repeatRuns },
    }).catch(() => {});
  }

  logger.debug(
    { tierRuns, repeatRuns, quietHolds: quietPausedEvents.length, notifications: stateUpdates.length },
    "escalation sweep",
  );
  return tierRuns + repeatRuns;
}
