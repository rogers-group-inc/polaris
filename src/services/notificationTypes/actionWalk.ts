/**
 * src/services/notificationTypes/actionWalk.ts — walking a rule's actions (CQ-B063, moved verbatim from notificationTypes.ts): the canonical action walk and
 * escalation-chain selection, reset actions that match a trigger action (business rule 145),
 * and the follow-up policy.
 */

import { quietTimeConfigSchema, describeQuietTime } from "../../utils/quietTime.js";
import { type Trigger } from "./triggers.js";
import { escalationResetKey, type RepeatConfig, type EscalatableAction, type SeverityBand, type BandNotify, type NotifyAction, type AutomationAction, type EscalationV2Config } from "./actions.js";
import { normalizeEscalationToV2, REPEATABLE_ACTION_TYPES } from "./ruleSchema.js";

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
  /** Where it runs: on a fire (rule or band actions), on an escalation tier,
   *  on a severity band's all-clear, or on reset. A reboot is refused on the
   *  last two (business rule 115(c)). */
  where: "fire" | "tier" | "resolved" | "reset";
}

export function allRuleActionRefs(rule: RuleActionCarrier): RuleActionRef[] {
  const out: RuleActionRef[] = [];
  const addTiers = (esc: unknown, prefix: string) => {
    (normalizeEscalationToV2(esc)?.tiers ?? []).forEach((t, ti) => {
      t.actions.forEach((a) => out.push({ action: a, label: `${prefix} escalation tier ${ti + 1}`, where: "tier" }));
    });
  };
  const addActions = (list: EscalatableAction[] | null | undefined, prefix: string) => {
    (list ?? []).forEach((a, i) => {
      out.push({ action: a, label: `${prefix} ${i + 1}`, where: "fire" });
      addTiers(actionEscalation(a), `${prefix} ${i + 1}`);
    });
  };
  addActions(rule.actions, "Action");
  addTiers(rule.escalation, "Rule");
  for (const b of rule.severityBands ?? []) {
    addActions(b.actions, `${b.severity} band action`);
    addTiers(b.escalation, `${b.severity} band`);
  }
  (rule.bandNotify?.resolvedActions ?? []).forEach((a, i) => out.push({ action: a, label: `Resolved action ${i + 1}`, where: "resolved" }));
  (rule.resetActions ?? []).forEach((a, i) => {
    out.push({ action: a, label: `Reset action ${i + 1}`, where: "reset" });
    // Escalation-reset overrides (business rule 145) deliver like any reset
    // notify, so they get the same channel / recipient / permission checks.
    if (a.type === "notify") {
      for (const [key, list] of Object.entries(a.resetEscalation?.custom ?? {})) {
        list.forEach((o) => out.push({ action: o, label: `Reset action ${i + 1} escalation reset ${key}`, where: "reset" }));
      }
    }
  });
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
 *
 * This bare key is now the LEGACY one — it is what a notification carries from
 * before reminders became per-action, when one clock re-sent every notify
 * action together. `repeatStateKey(i)` is what the sweep writes; the legacy key
 * is still READ as the seed for an inheriting action, so an alert that is live
 * across the upgrade keeps its clock instead of firing a fresh reminder at
 * everyone the moment the new code starts sweeping.
 */
export const REPEAT_STATE_KEY = "repeat";

/** One action's reminder progress: `a<i>:repeat`, beside that action's
 *  escalation tiers (`a<i>:t<j>`) and collision-free against both those and the
 *  level chain's bare numerics. */
export function repeatStateKey(actionIdx: number): string {
  return `a${actionIdx}:${REPEAT_STATE_KEY}`;
}

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
function effectiveActionsForSeverity(
  rule: RuleActionCarrier & { severity: string },
  severity: string,
): EscalatableAction[] {
  if (severity !== rule.severity) {
    const band = (rule.severityBands ?? []).find((b) => b.severity === severity);
    if (band?.actions?.length) return band.actions;
  }
  return rule.actions ?? [];
}

/**
 * Does acknowledging at this severity need a note?
 *
 * The SAME resolution `effectiveActionsForSeverity` performs, and it has to be:
 * the demand made of whoever closes an alert out has to be the one the severity
 * they are looking at makes. The band test is PRESENCE, not truthiness (see
 * `bandFollowUpSchema`) — a band declaring `requireAckNote: false` is saying
 * "not here", which is a different answer from a pre-feature band that says
 * nothing and inherits whatever the rule does.
 */
export function effectiveAckNoteForSeverity(
  rule: { severity: string; severityBands?: SeverityBand[] | null; requireAckNote?: boolean | null },
  severity: string,
): boolean {
  if (severity !== rule.severity) {
    const band = (rule.severityBands ?? []).find((b) => b.severity === severity);
    if (band?.followUp) return band.followUp.requireAckNote === true;
  }
  return rule.requireAckNote === true;
}

/**
 * The reminder clock for ONE action: its own when it states one, else the
 * rule's.
 *
 * PRESENCE, not truthiness, for the same reason the band test is: `repeat:
 * null` on an action means "this one does not chase", while an action carrying
 * no `repeat` key at all is every automation authored before reminders became
 * per-action, and must keep running on `NotificationRule.repeat`. The builder
 * writes an explicit answer onto every notify action it saves and clears the
 * rule-level column as it does, so a re-saved automation carries no inheritance
 * at all — but nothing is migrated behind the operator's back, and a rule the
 * builder has not touched keeps behaving exactly as it did.
 */
function repeatForAction(
  rule: { repeat?: RepeatConfig | null },
  action: { type: string; repeat?: RepeatConfig | null },
): RepeatConfig | null {
  if (action.repeat !== undefined) return action.repeat ?? null;
  return rule.repeat ?? null;
}

/**
 * The repeatable actions in force at a severity, each with its resolved clock
 * and its INDEX in that severity's action list.
 *
 * The index travels with the action because it keys that action's reminder
 * state (`repeatStateKey`) — two notify actions chasing on different clocks
 * need two independent `lastSentAt`s, and the position in the effective list is
 * the same identity per-action escalation chains already key on.
 */
export function repeatingActionsForSeverity(
  rule: RuleActionCarrier & { severity: string; repeat?: RepeatConfig | null },
  severity: string,
): { index: number; action: EscalatableAction; repeat: RepeatConfig }[] {
  const repeatable = new Set<string>(REPEATABLE_ACTION_TYPES);
  const out: { index: number; action: EscalatableAction; repeat: RepeatConfig }[] = [];
  effectiveActionsForSeverity(rule, severity).forEach((action, index) => {
    if (!repeatable.has(action.type)) return;
    const repeat = repeatForAction(rule, action as { type: string; repeat?: RepeatConfig | null });
    if (repeat) out.push({ index, action, repeat });
  });
  return out;
}

/** Every repeat config a rule can present — the rule-level one plus each
 *  action's own, top-level and per band. Used for rule inclusion in the sweep
 *  and for the due-candidate cutoff, both of which run BEFORE any notification
 *  is looked at and so must see an automation whose only reminder lives on one
 *  action of one band. */
export function allRepeatsOf(
  rule: { severityBands?: SeverityBand[] | null; repeat?: RepeatConfig | null; actions?: readonly { type: string }[] | null },
): RepeatConfig[] {
  const out: RepeatConfig[] = [];
  if (rule.repeat) out.push(rule.repeat);
  // `repeat` rides only the notify member of the action union, so the walk is
  // typed on what every member HAS and reads the key off the ones that carry it.
  const fromActions = (list: readonly { type: string }[] | null | undefined) => {
    for (const a of list ?? []) {
      const own = (a as { repeat?: RepeatConfig | null }).repeat;
      if (own) out.push(own);
    }
  };
  fromActions(rule.actions);
  for (const b of rule.severityBands ?? []) fromActions(b.actions);
  return out;
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

// ─── Reset actions that match a trigger action (business rule 145) ──────────

/** One escalation tier that SENT for an alert — `Notification.escalationFired`. */
export interface EscalationFiredRecord {
  /** The alert's severity when the tier sent (selects the chain). */
  severity: string;
  /** Chain key: "" = the severity's level chain, "a<i>" = a per-action chain. */
  chain: string;
  /** 0-based tier index within that chain. */
  tier: number;
  at: string;
}

/** Tolerant read of `Notification.escalationFired`. */
export function parseEscalationFired(v: unknown): EscalationFiredRecord[] {
  if (!Array.isArray(v)) return [];
  return v.filter((r): r is EscalationFiredRecord =>
    !!r && typeof r === "object" &&
    typeof (r as EscalationFiredRecord).severity === "string" &&
    typeof (r as EscalationFiredRecord).chain === "string" &&
    Number.isInteger((r as EscalationFiredRecord).tier));
}

/** Append a fired tier unless that (severity, chain, tier) is already listed. */
export function appendEscalationFired(list: EscalationFiredRecord[], rec: EscalationFiredRecord): EscalationFiredRecord[] {
  return list.some((r) => r.severity === rec.severity && r.chain === rec.chain && r.tier === rec.tier) ? list : [...list, rec];
}

/** A notify action as it EXECUTES: the linking / chain / reminder fields dropped. */
function plainNotify(a: AutomationAction): AutomationAction {
  if (a.type !== "notify") return a;
  const { id: _id, matchActionId: _m, customized: _c, resetEscalation: _r, ...rest } = a as NotifyAction;
  const out = { ...rest } as Record<string, unknown>;
  delete out["escalation"];
  delete out["repeat"];
  return out as AutomationAction;
}

/** The trigger Notify a reset action points at, and the severity section that
 *  holds it (null = the base list). */
function findTriggerNotify(
  rule: RuleActionCarrier,
  id: string,
): { action: AutomationAction; section: string | null } | null {
  const hit = (rule.actions ?? []).find((a) => a.type === "notify" && a.id === id);
  if (hit) return { action: hit as AutomationAction, section: null };
  for (const b of rule.severityBands ?? []) {
    const bh = (b.actions ?? []).find((a) => a.type === "notify" && a.id === id);
    if (bh) return { action: bh as AutomationAction, section: b.severity };
  }
  return null;
}

/**
 * The severities a trigger action RUNS at: its own band, or — for a base
 * action — the base severity plus every band with no actions of its own
 * (effectiveActionsForSeverity's fallback). The escalation reset covers the
 * tiers that sent at any of them.
 */
export function severitiesRunningSection(rule: RuleActionCarrier & { severity: string }, section: string | null): string[] {
  if (section) return [section];
  return [rule.severity, ...(rule.severityBands ?? []).filter((b) => !b.actions?.length).map((b) => b.severity)];
}

/**
 * Whose level chain an alert at `severity` escalates on: the band's own when it
 * declares one, else the base severity's (escalationChainsForSeverity's rule).
 * Two severities sharing one chain share its tiers, so the escalation reset
 * keys — and dedupes — on this, not on the alert's severity.
 */
export function levelChainOwner(rule: RuleActionCarrier & { severity: string }, severity: string): string {
  if (severity === rule.severity) return severity;
  const band = (rule.severityBands ?? []).find((b) => b.severity === severity);
  return (normalizeEscalationToV2(band?.escalation)?.tiers.length ?? 0) > 0 ? severity : rule.severity;
}

/**
 * What an alert's reset actually SENDS (business rule 145).
 *
 *  - A reset Notify with `matchActionId` and no `customized` delivers as the
 *    trigger Notify it points at, read NOW — an edit to the trigger action
 *    reaches its reset without anyone re-saving the reset side. If the target
 *    is gone the stored snapshot sends instead.
 *  - With `resetEscalation`, every escalation tier that SENT for this alert
 *    (`fired`) at a severity the matched action runs at also gets a reset:
 *    the tier's own Notify actions, or the override stored for it. A tier that
 *    never sent is skipped — nobody there was told. Each tier is sent once per
 *    reset however many reset actions ask for it.
 *  - Everything else passes through untouched.
 */
export function expandResetActions(
  rule: RuleActionCarrier & { severity: string },
  fired: EscalationFiredRecord[],
): AutomationAction[] {
  const out: AutomationAction[] = [];
  const seenTiers = new Set<string>();
  for (const a of rule.resetActions ?? []) {
    if (a.type !== "notify" || (!a.matchActionId && !a.resetEscalation)) { out.push(a); continue; }
    const src = a.matchActionId ? findTriggerNotify(rule, a.matchActionId) : null;
    out.push(plainNotify(src && !a.customized ? src.action : a));
    if (!a.resetEscalation || !src) continue;
    const severities = severitiesRunningSection(rule, src.section);
    for (const f of fired) {
      if (!severities.includes(f.severity)) continue;
      const chain = escalationChainsForSeverity(rule, f.severity).find((c) => c.key === f.chain);
      const tier = chain?.escalation.tiers[f.tier];
      if (!tier) continue;
      // A per-action chain (pre-2026-08 rules) belongs to ONE action: only
      // that action's reset answers for it.
      if (f.chain !== "") {
        const idx = effectiveActionsForSeverity(rule, f.severity).findIndex((x) => x.type === "notify" && x.id === a.matchActionId);
        if (f.chain !== `a${idx}`) continue;
      }
      const owner = f.chain === "" ? levelChainOwner(rule, f.severity) : f.severity;
      const dedupe = `${owner}|${f.chain}|${f.tier}`;
      if (seenTiers.has(dedupe)) continue;
      seenTiers.add(dedupe);
      const override = f.chain === "" ? a.resetEscalation.custom?.[escalationResetKey(owner, f.tier)] : undefined;
      const list = override ?? tier.actions.filter((x) => x.type === "notify");
      for (const x of list) out.push(plainNotify(x as AutomationAction));
    }
  }
  return out;
}

/**
 * Refresh a rule's matched reset rows to the trigger actions they point at
 * (save-time, business rule 145): the stored copy is what every reader that
 * doesn't resolve links (the Addresses column, Test delivery, export) sees,
 * so it is kept equal to what the link would send. A row whose target is gone
 * keeps its copy and loses the link.
 */
export function refreshMatchedResetSnapshots<T extends RuleActionCarrier>(rule: T): T {
  if (!rule.resetActions?.length) return rule;
  const resetActions = rule.resetActions.map((a) => {
    if (a.type !== "notify" || !a.matchActionId) return a;
    const src = findTriggerNotify(rule, a.matchActionId);
    if (!src) {
      const { matchActionId: _m, customized: _c, resetEscalation: _r, ...rest } = a;
      return rest as AutomationAction;
    }
    if (a.customized) return a;
    return {
      ...(plainNotify(src.action) as NotifyAction),
      matchActionId: a.matchActionId,
      ...(a.resetEscalation ? { resetEscalation: a.resetEscalation } : {}),
    } as AutomationAction;
  });
  return { ...rule, resetActions };
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
  rule: RuleActionCarrier & { severity: string; repeat?: RepeatConfig | null; quietTime?: unknown },
  severity: string,
): FollowUpPolicy {
  let repeat = "";
  // SOONEST across every repeating action at this severity — exactly the rule
  // the escalation half below already follows, and for the same reason. One
  // alert carries ONE of these sentences (it is snapshotted into templateCtx,
  // not composed per delivery), while its notify actions may chase on different
  // clocks; the honest answer to "when will this come back at me" is whichever
  // reminder arrives first, not whichever action happens to be listed first.
  const r = repeatingActionsForSeverity(rule, severity)
    .map((x) => x.repeat)
    .filter((x) => x.everyMin > 0)
    .sort((a, b) => a.everyMin - b.everyMin)[0];
  if (r && r.everyMin > 0) {
    // The cut-off is stated because it is the difference between "this will
    // chase you until you deal with it" and "this goes quiet at 8 hours",
    // and a reader planning their night needs the second one.
    // The quiet time is stated in the SAME sentence rather than a row of its
    // own: "every 15 minutes" and "paused overnight" are one answer to one
    // question ("when will this chase me again?"), and a reader who sees only
    // the cadence plans their night around a reminder that isn't coming.
    // The windows are the AUTOMATION's quiet time now (business rule 92);
    // a legacy `repeat.quiet` is read only when nothing was promoted.
    const ownQuiet = quietTimeConfigSchema.safeParse(rule.quietTime ?? null);
    const quiet = describeQuietTime(ownQuiet.success ? ownQuiet.data : r.quiet);
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
const ASSET_SCOPED_TRIGGER_TYPES = ["asset_metric", "asset_state", "change"] as const;

/** Whether a trigger selects devices via `scope` (composite depends on kind). */
export function isAssetScopedTrigger(trigger: Trigger): boolean {
  if (trigger.type === "composite") return trigger.kind === "asset";
  return (ASSET_SCOPED_TRIGGER_TYPES as readonly string[]).includes(trigger.type);
}
