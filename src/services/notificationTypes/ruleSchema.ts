/**
 * src/services/notificationTypes/ruleSchema.ts — the rule input schema and read-path normalizer (CQ-B063, moved verbatim from notificationTypes.ts): the Zod
 * schema that accepts v2 and legacy bodies (canonical output v2), and the DB row → v2 view.
 */

import { z } from "zod";
import { quietTimeConfigSchema, quietTimeIgnoreGlobalSchema, type QuietTimeConfig, type RuleQuietTime, MAX_QUIET_WINDOWS } from "../../utils/quietTime.js";
import { SEVERITIES, CLEAR_BEHAVIORS, type Severity, severityRank, scopeSchema } from "./scopeConditions.js";
import { isBooleanMetric, isPathTrigger, triggerSchema, triggerConditionStats, collapseCompositeTrigger, validateCompositeTrigger, collectTriggerLeaves, type Trigger, type RuleScope } from "./triggers.js";
import { deliveryTargetSchema, emailCompositionSchema, escalationSchema, type ResetMode, triggerTypeAllowsResetCondition, triggerTypeAllowsResetEvent, resetSchema, notifyChannelIds, actionSchema, escalationV2Schema, repeatConfigSchema, type RepeatConfig, escalatableActionSchema, type EscalatableAction, severityBandSchema, type SeverityBand, bandNotifySchema, type BandNotify, type DeliveryTarget, type EmailComposition, type EscalationConfig, type ResetConfig, type NotifyAction, type AutomationAction, type EscalationV2Config } from "./actions.js";
import { isDownDetectionTrigger } from "./specificity.js";
import { SDWAN_MEMBER_IP_TARGETS, INTERFACE_TAG_TARGETS, triggerIsPerDimension } from "./dimensions.js";

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
  // Consolidate this automation's per-component alerts into ONE alert per
  // device (business rule 75): eight faulted PoE ports become one alert naming
  // all eight, one email, one acknowledge. Refused by validateGrouping on any
  // trigger that does not report per component — there would be nothing to
  // fold, and a checkbox that silently does nothing is worse than none.
  groupByAsset: z.boolean().optional(),
  // Business rule 136(e): the alert takes the severity of the HIGHEST Priority
  // tag on the device (monitor status is down) or on the port (interface oper
  // status is down); an untagged device / port does not alert. Refused by
  // validatePrioritySeverity on any other trigger or beside severity bands.
  severityFromPriorityTag: z.boolean().optional(),
  channels: z.array(z.string().max(50)).max(50).default(["in_app"]),
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
  // This automation's OWN quiet time (business rule 92). Three settings, as the
  // wizard's step 6 offers them: absent/null = Off, the global schedules apply;
  // `{ignoreGlobal: true}` = no quiet time at all, this automation always
  // sends; a full policy = windows during which every people-facing send of
  // its alerts is held and a summary goes out afterwards, the global schedules
  // ignored. `alertKinds` is a global-schedule filter and is refused here —
  // the automation IS the kind.
  quietTime: z
    .union([
      quietTimeIgnoreGlobalSchema,
      quietTimeConfigSchema.superRefine((q, ctx) => {
        if (q.alertKinds) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["alertKinds"], message: "An automation's quiet time has no alert-kind filter" });
        for (const s of q.severities ?? []) {
          if (!(SEVERITIES as readonly string[]).includes(s)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["severities"], message: `Unknown severity "${s}"` });
          }
        }
        for (const s of Object.keys(q.held ?? {})) {
          if (!(SEVERITIES as readonly string[]).includes(s)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["held", s], message: `Unknown severity "${s}"` });
          }
        }
        // Recipient exceptions (business rule 120) key their own map by severity.
        (q.recipients ?? []).forEach((r, i) => {
          for (const s of Object.keys(r.held)) {
            if (!(SEVERITIES as readonly string[]).includes(s)) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recipients", i, "held", s], message: `Unknown severity "${s}"` });
            }
          }
        });
      }),
    ])
    .optional()
    .nullable(),
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
  /** Fold this automation's per-component alerts into one alert per device
   *  (business rule 75). Per-dimension triggers only. */
  groupByAsset: boolean;
  /** Severity follows the device's / port's Priority tag (business rule 136(e)). */
  severityFromPriorityTag: boolean;
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
  /** The automation's own quiet time (business rule 92): null = global schedules apply,
   *  `{ignoreGlobal: true}` = none at all, a policy = its own windows. */
  quietTime: RuleQuietTime | null;
}

/** Preview input = RuleInput with trigger optional (scope-only preview mode).
 *  `id` (when editing) lets the carve-out preview exclude the rule itself. */
export type PreviewRuleInput = Omit<RuleInput, "trigger" | "name"> & {
  name: string;
  trigger?: Trigger;
  id?: string;
  /** Device-list preview only (no `trigger`): the draft's trigger, used solely
   *  to apply the precedence carve-out (business rule 18) to the listed
   *  devices. It is never evaluated — the Devices step may run before the
   *  trigger step is finished. */
  carveOutTrigger?: Trigger;
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
    // Legacy body (targets, no actions) folded forward. The audit Event is the
    // engine's own (business rule 146), not an action.
    actions: raw.actions ?? targetsToNotifyActions(raw.targets, raw.emailComposition ?? null),
    cooldownSec: raw.cooldownSec ?? null,
    messageTemplate: raw.messageTemplate ?? null,
    requireAckNote: raw.requireAckNote === true,
    groupByAsset: raw.groupByAsset === true,
    severityFromPriorityTag: raw.severityFromPriorityTag === true,
    channels: raw.channels,
    emailComposition: raw.emailComposition ?? null,
    escalation: raw.escalation ?? null,
    severityBands: raw.severityBands?.length ? raw.severityBands : null,
    bandNotify: raw.bandNotify ?? null,
    // Anything not copied here is silently dropped by the transform.
    resetActions: raw.resetActions?.length ? raw.resetActions : null,
    repeat: raw.repeat ?? null,
    quietTime: raw.quietTime ?? legacyQuietTimeOf(raw),
  };
}

/**
 * A body written BEFORE quiet time was its own policy (business rule 92) may
 * still carry windows inside a `repeat.quiet` — an export file from an older
 * build, or an API client that never moved. Those windows become the
 * automation's quiet time in the `followUps` mode (reminders and escalation
 * tiers pause, the first alert still sends), the same promotion
 * `migrateRepeatQuietToQuietTime` applied to stored rows, so an old file
 * imports into the same policy it would have had on an upgraded install. The
 * stale `quiet` keys themselves are harmless: nothing reads them.
 */
function legacyQuietTimeOf(raw: { repeat?: RepeatConfig | null; actions?: unknown; severityBands?: unknown }): QuietTimeConfig | null {
  const windows: unknown[] = [];
  const seen = new Set<string>();
  const take = (rep: unknown) => {
    const q = (rep as { quiet?: { windows?: unknown[] } | null } | null | undefined)?.quiet;
    for (const w of q?.windows ?? []) {
      const key = JSON.stringify(w);
      if (!seen.has(key)) { seen.add(key); windows.push(w); }
    }
  };
  take(raw.repeat);
  for (const a of Array.isArray(raw.actions) ? raw.actions : []) take((a as { repeat?: unknown })?.repeat);
  for (const b of Array.isArray(raw.severityBands) ? raw.severityBands : []) {
    for (const a of Array.isArray((b as { actions?: unknown[] })?.actions) ? (b as { actions: unknown[] }).actions : []) take((a as { repeat?: unknown })?.repeat);
  }
  if (windows.length === 0) return null;
  const parsed = quietTimeConfigSchema.safeParse({ windows: windows.slice(0, MAX_QUIET_WINDOWS), holds: "followUps" });
  return parsed.success ? parsed.data : null;
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
 *
 * This is about the RULE-LEVEL `repeat` only. A repeat that rides a notify
 * action needs no such check — the action it is attached to is the notify
 * action, by construction: the schema puts the key on nothing else.
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
 * `groupByAsset` applies only where there is something to fold.
 *
 * The refusal is deliberate rather than a silent no-op: a checkbox that saves
 * and then changes nothing is the same failure mode as an ASSET_STATE_FIELDS
 * entry with no engine resolver — it validates, it persists, it renders, and
 * the automation quietly never does what it says. Each message names WHY this
 * trigger has nothing to fold, because "invalid" tells an operator nothing
 * about which of their choices to change.
 */
function validateGrouping(
  v: { trigger?: Trigger | null; groupByAsset?: boolean | null },
  ctx: z.RefinementCtx,
): void {
  if (v.groupByAsset !== true) return;
  const trigger = v.trigger;
  if (!trigger) return; // the trigger's own validation already failed
  const refuse = (message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["groupByAsset"], message });

  if (trigger.type === "composite") {
    refuse(
      "This automation already raises one alert per device — a composite condition folds its readings " +
      "across components before it fires, so there is nothing left to consolidate.",
    );
    return;
  }
  if (trigger.type === "host_metric") {
    refuse(
      "Consolidating per device needs a device. A host-metric automation is about the Polaris server itself, " +
      "so its alerts are already one.",
    );
    return;
  }
  if (trigger.type === "event" || trigger.type === "change") {
    refuse(
      `An ${trigger.type} automation fires on an instant rather than on a reading it keeps watching, ` +
      "so Polaris has no per-component state to fold or to know when a part of it has ended.",
    );
    return;
  }
  if (!triggerIsPerDimension(trigger)) {
    const what = trigger.type === "asset_metric" ? trigger.metric : trigger.field;
    refuse(
      `"${what}" is reported once per device, so this automation already raises one alert per device. ` +
      "Consolidating applies to an automation that alerts per interface, sensor, storage mount, tunnel or SD-WAN member.",
    );
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
    // Same shape, same reason (business rule 78): the dependency-down toggle
    // is a property of the down verdict, so it has no meaning anywhere else.
    if (trigger.alertWhenDependencyDown != null && !isDownDetectionTrigger(trigger)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trigger", "alertWhenDependencyDown"],
        message:
          'alerting while dependency-down only applies to a "monitor status is down" automation — it is that verdict the silenced device is being spoken for',
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
    const depOffender = collectTriggerLeaves(trigger).find(
      (l) => l.type === "asset_state" && (l as { alertWhenDependencyDown?: boolean }).alertWhenDependencyDown != null,
    );
    if (depOffender) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trigger", "children"],
        message:
          "alerting while dependency-down cannot sit inside a multi-condition trigger — a silenced device reports nothing the other conditions could read. Put it on an automation whose only condition is \"monitor status is down\".",
      });
    }
  }
}

/** `includeServer` is a Path Monitor flag: a path metric or the path change. */
/**
 * `dimensionFilter.sdwanMemberIp` only means something on the conditions that
 * read one SD-WAN member per reading (SDWAN_MEMBER_IP_TARGETS). Anywhere else
 * it would save, render and filter nothing — so it is refused rather than kept
 * inert. Checked on the bare trigger and on every leaf of a composite.
 */
/**
 * A tag condition names the tag in `value`, so a blank or non-string value would
 * save and then match nothing (or, negated, every device). Only is / is-not mean
 * anything about a tag. Checked on the bare trigger and on every composite leaf.
 */
function validateTagCondition(trigger: Trigger | undefined, ctx: z.RefinementCtx): void {
  if (!trigger) return;
  const leaves: Array<{ type: string; field?: string; operator?: string; value?: unknown }> =
    trigger.type === "composite" ? (collectTriggerLeaves(trigger) as never) : [trigger as never];
  const offender = leaves.find((l) => {
    if (l.type !== "asset_state" || l.field !== "tag") return false;
    return typeof l.value !== "string" || l.value.trim() === "" || (l.operator !== "==" && l.operator !== "!=");
  });
  if (offender) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: trigger.type === "composite" ? ["trigger", "children"] : ["trigger", "value"],
      message: 'an asset tag condition needs a tag name, and compares it with "is" or "is not"',
    });
  }
}

/**
 * `dimensionFilter.ifTag` only means something on a condition that reads one
 * interface per reading (INTERFACE_TAG_TARGETS) — business rule 133(g). Refused
 * anywhere else rather than kept inert, the way the member-IP filter is.
 */
function validateInterfaceTagFilter(trigger: Trigger | undefined, ctx: z.RefinementCtx): void {
  if (!trigger) return;
  const leaves: Array<{ type: string; metric?: string; field?: string; dimensionFilter?: { ifTag?: string } }> =
    trigger.type === "composite" ? (collectTriggerLeaves(trigger) as never) : [trigger as never];
  const offender = leaves.find((l) => {
    if (!l.dimensionFilter?.ifTag) return false;
    const target = l.type === "asset_state" ? l.field : l.type === "asset_metric" ? l.metric : undefined;
    return !INTERFACE_TAG_TARGETS.has(target ?? "");
  });
  if (offender) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: trigger.type === "composite" ? ["trigger", "children"] : ["trigger", "dimensionFilter", "ifTag"],
      message:
        "an interface tag filter only applies to the interface conditions — oper / admin status, IP address, PoE status, throughput and errors",
    });
  }
}

/**
 * Business rule 136(e). Which Priority tag a trigger's severity can follow:
 * the DEVICE's for "monitor status is down", the PORT's for "interface oper
 * status is down", null for anything else. Bare triggers only — a composite
 * folds several leaves per device, and which leaf's subject would own the tag
 * has no single answer.
 */
export function priorityTagSubjectOf(trigger: unknown): "device" | "interface" | null {
  const t = trigger as { type?: string; field?: string; operator?: string; value?: unknown } | null | undefined;
  if (!t || t.type !== "asset_state" || t.operator !== "==" || t.value !== "down") return null;
  if (t.field === "monitorStatus") return "device";
  if (t.field === "ifOperStatus") return "interface";
  return null;
}

function validatePrioritySeverity(
  v: { trigger?: Trigger; severityBands?: SeverityBand[] | null; severityFromPriorityTag?: boolean | null },
  ctx: z.RefinementCtx,
): void {
  if (v.severityFromPriorityTag !== true) return;
  if (!priorityTagSubjectOf(v.trigger)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["severityFromPriorityTag"],
      message: 'severity can follow the Priority tag only on "monitor status is down" or "interface oper status is down"',
    });
  }
  if (v.severityBands && v.severityBands.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["severityFromPriorityTag"],
      message: "an automation's severity follows the Priority tag or its severity bands, not both",
    });
  }
}

function validateMemberIpFilter(trigger: Trigger | undefined, ctx: z.RefinementCtx): void {
  if (!trigger) return;
  const leaves: Array<{ type: string; metric?: string; field?: string; dimensionFilter?: { sdwanMemberIp?: string } }> =
    trigger.type === "composite" ? (collectTriggerLeaves(trigger) as never) : [trigger as never];
  const offender = leaves.find((l) => {
    if (!l.dimensionFilter?.sdwanMemberIp) return false;
    const target = l.type === "asset_state" ? l.field : l.type === "asset_metric" ? l.metric : undefined;
    return !SDWAN_MEMBER_IP_TARGETS.has(target ?? "");
  });
  if (offender) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: trigger.type === "composite" ? ["trigger", "children"] : ["trigger", "dimensionFilter", "sdwanMemberIp"],
      message:
        "SD-WAN member IP address only applies to the SD-WAN member conditions — member state, latency, jitter and packet loss",
    });
  }
}

function validateIncludeServer(trigger: Trigger | undefined, reset: ResetConfig, ctx: z.RefinementCtx): void {
  if (!trigger || (trigger.type !== "asset_metric" && trigger.type !== "change")) return;
  if (trigger.includeServer != null && !isPathTrigger(trigger)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["trigger", "includeServer"],
      message: "including the Polaris server only applies to Path Monitor conditions",
    });
  }
  // A custom reset tree is resolved per DEVICE row, and the server has none —
  // its alert could never recover. Refused rather than left to hang.
  if (trigger.includeServer === true && reset.mode === "condition") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reset", "mode"],
      message: "a custom reset condition can't watch the Polaris server — reset automatically, or leave the server out",
    });
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
    groupByAsset?: boolean | null;
    severityFromPriorityTag?: boolean | null;
  },
  ctx: z.RefinementCtx,
): void {
  const { trigger, reset } = v;
  if (trigger?.type === "composite") validateCompositeTrigger(trigger, ctx);
  validateSeverityBands(v, ctx);
  validateRepeat(v, ctx);
  validateMissedPolls(trigger, ctx);
  validateGrouping(v, ctx);
  validateIncludeServer(trigger, reset, ctx);
  validateMemberIpFilter(trigger, ctx);
  validateInterfaceTagFilter(trigger, ctx);
  validatePrioritySeverity(v, ctx);
  validateTagCondition(trigger, ctx);
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
/**
 * Business rule 146: the audit Event is no longer something an automation
 * chooses — every fire, escalation and end writes one on its own. The retired
 * `event` action is still ACCEPTED (stored rules, exports and API clients carry
 * it) but is dropped from the lists that fire and reset, so saved rules
 * converge on the shape the builder shows. An escalation tier keeps one: a
 * tier needs at least one action, and there it was always inert.
 */
function withoutEventActions<T extends {
  actions: EscalatableAction[];
  severityBands?: SeverityBand[] | null;
  resetActions?: AutomationAction[] | null;
}>(core: T): T {
  const drop = <A extends { type: string }>(list: A[] | null | undefined): A[] | null | undefined =>
    list ? list.filter((a) => a.type !== "event") : list;
  const resetActions = drop(core.resetActions);
  return {
    ...core,
    actions: drop(core.actions) as EscalatableAction[],
    ...(core.severityBands ? { severityBands: core.severityBands.map((b) => ({ ...b, actions: drop(b.actions) as EscalatableAction[] })) } : {}),
    ...(core.resetActions !== undefined ? { resetActions: resetActions?.length ? resetActions : null } : {}),
  };
}

export const ruleInputSchema = ruleInputBaseSchema
  .transform((raw): RuleInput => ({
    trigger: collapseCompositeTrigger(raw.trigger),
    ...withoutEventActions(normalizeRuleInputCore(raw)),
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
    // Device-list preview: the draft's trigger, for the carve-out only.
    carveOutTrigger: triggerSchema.optional(),
  })
  .transform((raw): PreviewRuleInput => ({
    trigger: raw.trigger ? collapseCompositeTrigger(raw.trigger) : undefined,
    id: raw.id,
    ...(raw.carveOutTrigger ? { carveOutTrigger: raw.carveOutTrigger } : {}),
    ...withoutEventActions(normalizeRuleInputCore(raw)),
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
    // forward. The audit Event needs no action (business rule 146).
    const targets = Array.isArray(row.targets) ? (row.targets as DeliveryTarget[]) : [];
    actions = targetsToNotifyActions(targets, emailComposition) as EscalatableAction[];
  }

  const severityBands = parseSeverityBands(row.severityBands);
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
 * The `severityBands` JSON column → typed bands, dropping any a schema change
 * has outgrown rather than throwing (the same posture normalizeRuleToV2 takes
 * with every other JSON column: a row the reader can't fully understand still
 * has to render).
 *
 * Exported because the ack surfaces need the bands WITHOUT normalizing a whole
 * rule — they select two columns off `rule`, not the dozen normalizeRuleToV2
 * wants.
 */
export function parseSeverityBands(raw: unknown): SeverityBand[] | null {
  if (!Array.isArray(raw)) return null;
  const bands = raw
    .map((b) => severityBandSchema.safeParse(b))
    .filter((r): r is { success: true; data: SeverityBand } => r.success)
    .map((r) => r.data);
  return bands.length ? bands : null;
}
