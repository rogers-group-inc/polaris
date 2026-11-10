/**
 * src/services/notifications/templating.ts — message + email templating (CQ-B063, moved verbatim from notificationEngine.ts): the
 * reading context an alert message carries, the follow-up policy, renderMessage, and the
 * context / asset-detail switches a rule or group asks for.
 */

import { triggerSummary, triggerTokenParts, pathConditionPhrase } from "../../utils/triggerSummary.js";
import { type AutomationAction, ruleHasAnyEscalation, allRuleActionRefs, type AlertMember, wholeGroupSubject, countNoun, type SpanCounts, activeMembers, primaryMember, renderMemberList, dimensionNounOf, followUpPolicy, forecastLevelsOf, allRepeatsOf } from "../notificationTypes.js";
import { renderNotificationTemplate, templateNeedsAsset, notificationsPageUrl, type TemplateContextParts } from "../../utils/notificationTemplate.js";
import { DbRule, Reading } from "./ruleModel.js";

// ─── Message + email templating ─────────────────────────────────────────────
// All interpolation goes through renderNotificationTemplate (single-brace
// {token} vocabulary from src/utils/notificationTemplate.ts) so the in-app
// messageTemplate, the email composition, and escalation overrides share one
// vocabulary. The built context is snapshotted onto Notification.templateCtx
// (when the rule has emailComposition/escalation) so escalation emails render
// later with fire-time values.

/** Fire-time detail for a composite trigger: what the message/tokens render. */
export interface CompositeFireInfo {
  /** Met-conditions summary with witness dims, e.g. "CPU utilization ≥ 90 (95) and Storage used ≥ 80 (/var = 94)". */
  summary: string;
  /** "k of n conditions met". */
  conditions: string;
}

/** The reading-derived template parts (sans assetDetail/message, added by callers). */
export function readingContextParts(
  rule: DbRule,
  reading: Reading,
  now: Date,
  composite?: CompositeFireInfo,
  /** The contributions on a GROUPED alert (business rule 75). When present,
   *  {dimension} names the whole set rather than this one reading's component
   *  — the alert IS about all of them, and a sentence naming one of eight
   *  faulted ports would be the storm's problem in a single message. */
  members?: AlertMember[] | null,
  /** The alert's true size on a multi-device alert (spanCounts) — the members
   *  stop at MAX_GROUP_MEMBERS, so a count taken from them stops at 64. */
  counts?: SpanCounts | null,
): TemplateContextParts {
  const trigger = rule.trigger;
  // A subnet-folded alert is about the SUBNET; its members are the devices. An
  // automation-folded one spans devices with nothing else to name them by, so
  // {asset} counts them — "Monitor down on {asset}" reads "… on 5 devices".
  // One split per path check is about that CHECK, the way a subnet fold is
  // about its subnet, and its subject tag is the count rather than the hosts:
  // "[CRITICAL] Salesforce HTTPS · 3 devices — Path check down". A whole-group
  // alert counts both: "[CRITICAL] 3 path checks · 80 devices — <name>".
  const subnetLabel = members?.find((m) => m.subnet)?.subnet;
  const pathCheck = members?.find((m) => m.component)?.component;
  const group = members?.find((m) => m.group)?.group;
  const spansDevices = !!members?.some((m) => m.assetId);
  const deviceCount = counts?.devices ?? (spansDevices ? new Set(activeMembers(members!).map((m) => m.assetId)).size : 0);
  const devices = countNoun(deviceCount, "device");
  const whole = group && counts ? wholeGroupSubject(counts) : "";
  // What is wrong, said where {asset} names the check(s): "Truck Scale Central
  // is down · 1 device", "3 path checks are down · 80 devices". Only there —
  // after a host name ("GRYCRT-S2212 is down") it would claim the device is.
  const condition = pathCheck && spansDevices
    ? pathConditionPhrase(trigger as never)
    : whole && counts?.pathOnly && counts.condition
      ? (counts.checks === 1 ? counts.condition.one : counts.condition.many)
      : null;
  const base = {
    asset: subnetLabel || pathCheck || whole
      || (spansDevices ? devices : "")
      || reading.hostname || reading.assetId || "host",
    ...(pathCheck || whole ? { dimensionSuffix: ` · ${devices}` } : {}),
    ...(condition ? { conditionSuffix: ` ${condition}` } : {}),
    dimension: members?.length ? renderMemberList(members) : (reading.dimLabel || ""),
    // What that component IS, so the email can label it rather than leaving the
    // port name buried mid-sentence: "Interface — port12 (Indoor AP)". Blank on
    // a whole-device alert, where the row prunes itself away.
    //
    // A GROUPED alert names several components of the same KIND (they all came
    // from the same per-dimension trigger), so the noun still applies — and it
    // reads correctly in the plural position the list puts it in.
    dimensionNoun: spansDevices ? "Devices" : (members?.length || reading.dimLabel) ? dimensionNounOf(trigger) : "",
    severity: rule.severity,
    time: now,
    link: notificationsPageUrl(),
    // A whole-group alert spanning several automations is the GROUP's, so it
    // is named for the group; with one automation in it, for that automation.
    ruleName: group && counts && counts.automations > 1 ? group : rule.name,
    ruleDescription: rule.description,
    // "Response time (median over 5 minutes) is 760 ms" — the wizard's own
    // "When should it fire?" wording with the observed value in it, so the
    // alert email says what the number means instead of "responseTimeMs = 760".
    // A path alert about the CHECK leads with the check and says where it is
    // failing from — "Truck Scale Central is down from GRYCRT-S2212", "3 path
    // checks are down from 80 devices" — where the generic sentence put the
    // hosts in the component's place ("Path check result on GRYCRT-S2212 is
    // 0"). refreshMemberContext keeps both current as the alert changes.
    triggerSummary: condition && pathCheck
      ? `${pathCheck} ${condition} from ${renderMemberList(members)}`
      : condition && whole
        ? `${whole} ${condition} from ${devices}`
        : triggerSummary({
          trigger: trigger as never,
          value: reading.value,
          // On a grouped alert the sentence names every affected component, for
          // the same reason {dimension} does.
          dimensionLabel: members?.length ? renderMemberList(members) : (reading.dimLabel || null),
        }),
    // Grouped-alert tokens. Present on every alert so a template is never
    // broken by them, and "1" / the single component's own label on an
    // ungrouped one — which is exactly what they mean there.
    dimensionCount: String(members?.length ? activeMembers(members).length : (reading.dimLabel ? 1 : 0)),
    dimensionFirst: members?.length
      ? (primaryMember(members)?.label ?? "")
      : (reading.dimLabel || ""),
    dimensionList: members?.length ? renderMemberList(members, Number.MAX_SAFE_INTEGER) : (reading.dimLabel || ""),
  };
  if (trigger.type === "composite") {
    // No single metric/value/threshold exists — {metric} carries the
    // met-conditions summary, {conditions} the "k of n" count.
    return { ...base, metric: composite?.summary ?? "conditions met", value: "", threshold: "", conditions: composite?.conditions ?? "" };
  }
  const metric = trigger.type === "asset_metric" || trigger.type === "host_metric" ? trigger.metric
    : trigger.type === "asset_state" ? trigger.field : trigger.type;
  const threshold = trigger.type === "asset_metric" || trigger.type === "host_metric" ? String(trigger.threshold)
    : trigger.type === "asset_state" ? String(trigger.value) : "";
  const valueStr = reading.value === null ? "n/a" : typeof reading.value === "number" ? round2(reading.value) : String(reading.value);
  const readable = triggerTokenParts(trigger as never, reading.value);
  return {
    ...base, metric: String(metric), value: valueStr, threshold,
    metricLabel: readable.metricLabel, valueDisplay: readable.valueDisplay, thresholdDisplay: readable.thresholdDisplay,
    // A memory forecast counts down to a LEVEL; which one depends on the
    // severity the caller sets next, so the trend and the levels ride along
    // and buildTemplateContext resolves "Days until Serious: 6".
    ...(reading.forecast && trigger.type === "asset_metric"
      ? { forecast: { ...reading.forecast, levels: forecastLevelsOf(trigger, rule.severity, rule.severityBands) } }
      : {}),
  };
}

/**
 * The two "what happens if nobody acts" sentences, as context parts.
 *
 * A thin wrapper over the pure followUpPolicy so the three FIRE sites can't
 * drift — and so the boundary stays visible: recovery (fireResolved), reset
 * (fireReset) and the authoring preview deliberately DON'T call it. An alert
 * that has already ended has no follow-up left to describe, and a body that
 * still promised reminders under a green "resolved" header would be telling
 * the reader to expect messages that will never come.
 */
export function followUpParts(rule: DbRule, severity: string): Pick<TemplateContextParts, "repeatPolicy" | "escalationPolicy"> {
  const p = followUpPolicy(rule, severity);
  return { repeatPolicy: p.repeat, escalationPolicy: p.escalation };
}

/** In-place form, for the sites that mutate a parts object they already built. */
export function applyFollowUpPolicy(parts: TemplateContextParts, rule: DbRule, severity: string): void {
  Object.assign(parts, followUpParts(rule, severity));
}

/** A `{dimension.suffix}` carrying the device count (" · 80 devices") rather
 *  than a component list — set by readingContextParts on a path-check split
 *  and on a whole-group alert. */
const DEVICE_COUNT_TAG = /^ · \d+ devices?$/;

/** Render the in-app message from a built context (default string when no template). */
export function renderMessage(
  rule: DbRule,
  reading: Reading,
  ctx: Record<string, string>,
  /** The contributions on a grouped alert — the default sentence then names
   *  the set and says how many, instead of naming one of them. */
  members?: AlertMember[] | null,
  /** The alert's true size on a multi-device alert (spanCounts). */
  counts?: SpanCounts | null,
): string {
  if (rule.messageTemplate && rule.messageTemplate.trim()) {
    const own = renderNotificationTemplate(rule.messageTemplate, ctx);
    // Business rule 78 — a custom template cannot have anticipated this alert,
    // so the notice is APPENDED rather than replacing the operator's words.
    // It has to reach the message and not just the email body: push, Slack,
    // Teams and Pushbullet all send `Notification.message` and nothing else,
    // so a template like "{asset} is down" would page the plant with the one
    // fact they already knew and none of the reason. Skipped when their own
    // template already renders the notice (it is a catalogued token).
    if (reading.dependencyDown && ctx["dependency.tag"] && !own.includes("DEPENDENCY DOWN")) {
      return `${own} — ${ctx["dependency.headline"] || "DEPENDENCY DOWN"}`;
    }
    return own;
  }
  if (members?.length && members.some((m) => m.subnet)) {
    // A subnet fold: the members are devices, so say how many and where, then
    // which. The dependency headline (rule 78) rides along when the leading
    // device is dependency-down — the usual reason a whole subnet goes at once.
    const active = activeMembers(members);
    const n = active.length;
    const dep = reading.dependencyDown && ctx["dependency.headline"] ? ` — ${ctx["dependency.headline"]}` : "";
    return `${rule.name}: ${n} device${n === 1 ? "" : "s"} in ${ctx["asset"]} — ${renderMemberList(members)}${dep}`;
  }
  if (members?.length && members.some((m) => m.assetId)) {
    // An automation fold: one automation across devices. {asset} already
    // reads "5 devices"; then which, and the same dependency headline.
    const dep = reading.dependencyDown && ctx["dependency.headline"] ? ` — ${ctx["dependency.headline"]}` : "";
    // A whole-group alert: "<name>: 3 path checks · 80 devices — <host — check>, …".
    // The count rides in {dimension.suffix} when {asset} names something else.
    const countTag = DEVICE_COUNT_TAG.test(ctx["dimension.suffix"] ?? "") ? ctx["dimension.suffix"]! : "";
    const list = renderMemberList(members);
    if (members.some((m) => m.group)) {
      // Every automation in it saying the same thing about its checks: say it —
      // "3 path checks are down from 80 devices — <host — check>, …".
      if (counts?.pathOnly && counts.condition && countTag) {
        return `${ctx["asset"]} ${counts.checks === 1 ? counts.condition.one : counts.condition.many} from ${countTag.slice(3)} — ${list}${dep}`;
      }
      return `${ctx["rule"]}: ${ctx["asset"]}${countTag} — ${list}${dep}`;
    }
    // Split per path check: the check is the subject, named once — and it is
    // {asset} there, so the count is the subject tag. The sentence says what
    // is wrong with it: "Salesforce HTTPS is down from 3 devices — …".
    const component = members.find((m) => m.component)?.component;
    const phrase = component ? pathConditionPhrase(rule.trigger as never) : null;
    if (component && phrase && countTag) return `${component} ${phrase} from ${countTag.slice(3)} — ${list}${dep}`;
    const devices = component ? countTag.slice(3) : ctx["asset"];
    return `${rule.name}${component ? ` — ${component}` : ""}: ${devices} — ${list}${dep}`;
  }
  if (members?.length) {
    const active = activeMembers(members);
    const noun = active.length === 1 ? "" : ` (${active.length})`;
    const list = renderMemberList(members);
    const where = list ? ` [${list}]${noun}` : "";
    return `${rule.name}: ${ctx["asset"]}${where} — ${ctx["metric"]} = ${ctx["value"]} (threshold ${ctx["threshold"]})`;
  }
  const dim = reading.dimLabel ? ` [${reading.dimLabel}]` : "";
  if (rule.trigger.type === "composite") {
    // {metric} holds the met-conditions summary — no "= (threshold )" artifacts.
    const count = ctx["conditions"] ? ` (${ctx["conditions"]})` : "";
    return `${rule.name}: ${ctx["asset"]} — ${ctx["metric"]}${count}`;
  }
  // Business rule 78 — the whole dependency sentence, which already names the
  // device and the upstream: "monitorStatus = down (threshold down)" would be
  // the one thing this alert is NOT saying. This is what the in-app card, push
  // and chat bodies show, so it carries the name on every surface.
  if (reading.dependencyDown && ctx["dependency.summary"]) {
    return `${rule.name}: ${ctx["dependency.summary"]}`;
  }
  // Per-core CPU (business rule 89): the label already prints each hot core
  // with its own reading, so "cpuCorePct = 6.6" would repeat one of them.
  if (reading.dimLabel && rule.trigger.type === "asset_metric" && rule.trigger.metric === "cpuCorePct") {
    return `${rule.name}: ${ctx["asset"]}${dim} (threshold ${ctx["threshold"]})`;
  }
  // A memory forecast says what it is counting down to: the device, then the
  // days until its next level — "COWAN-61F-1 — Days until Serious: 6". The
  // projected percentage behind it is an engine detail, not the news.
  if (ctx["forecast.level"] && ctx["forecast.days"]) {
    return `${ctx["asset"]} — Days until ${ctx["forecast.level"]}: ${ctx["forecast.days"]}`;
  }
  return `${rule.name}: ${ctx["asset"]}${dim} — ${ctx["metric"]} = ${ctx["value"]} (threshold ${ctx["threshold"]})`;
}

export function round2(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

/** Does this rule need the fire-time template context (composition/escalation/asset tokens)?
 *  ANY escalation chain counts — rule-level, per-action, band-level, or
 *  band-per-action — since the sweep renders from the templateCtx snapshot. */
export function ruleWantsContext(rule: DbRule): boolean {
  // `repeat` is in here for a reason that is easy to miss: the sweep renders a
  // reminder from Notification.templateCtx, and without this a repeat-only
  // automation snapshots nothing — so every reminder would fall back to the
  // minimal context built from the row and silently lose {value}, {threshold},
  // {trigger.summary} and every {asset.*} token. The reminder would not look
  // like the email it is reminding you about.
  // allRepeatsOf, not `rule.repeat`: an automation that repeats ONLY at one
  // severity band has a null rule-level repeat and still needs the snapshot.
  return !!(rule.emailComposition || ruleHasAnyEscalation(rule) || allRepeatsOf(rule).length > 0);
}

/** A grouped alert's snapshot answers to its GROUP's delivery too (business
 *  rule 75): the group may escalate, remind or compose an email where its
 *  member would not, and the sweep renders those from `templateCtx`. Whether
 *  the group governs this device is only settled at delivery, so an automation
 *  in any group snapshots; the cost stays on grouped alerts. */
export function groupWantsContext(rule: DbRule): boolean {
  return !!rule.alertGroupId || ruleWantsContext(rule);
}

/** Same reasoning for `{asset.*}`: the group's email layout may name them. */
export function groupWantsAssetDetail(rule: DbRule): boolean {
  return !!rule.alertGroupId || ruleWantsAssetDetail(rule);
}

export function ruleWantsAssetDetail(rule: DbRule): boolean {
  const comp = rule.emailComposition;
  // Action-level templates can reference {asset.*} too: per-action email
  // composition, api_call bodies, script args — walked over EVERY place
  // actions live (top-level + per-action tiers + rule tiers + band actions +
  // band tiers + resolved actions) via the canonical allRuleActionRefs.
  const templatesOf = (a: AutomationAction) =>
    a.type === "notify"
      ? [a.emailComposition?.subjectTemplate, a.emailComposition?.bodyTextTemplate, a.emailComposition?.bodyHtmlTemplate]
      : a.type === "api_call"
        ? [a.bodyTemplate]
        : a.type === "script"
          ? [a.argsTemplate]
          : []; // event, reboot — no templates of its own
  const refs = allRuleActionRefs(rule);
  const actionTemplates = refs.flatMap((r) => templatesOf(r.action));
  // Any notify action can end up on an email channel, and the DEFAULT alert
  // body quotes the device (IP, connected switch/AP, location, model) without
  // the operator typing a single {asset.*} token — so template-sniffing alone
  // would mail blank facts for every automation that never customized
  // anything. Channel types aren't visible here, so this deliberately
  // over-fetches for a push- or chat-only rule: the lookup is per FIRE (which
  // is transition-guarded and rare) and served from the per-tick cache.
  const hasNotify = refs.some((r) => r.action.type === "notify");
  return (
    hasNotify ||
    ruleWantsContext(rule) ||
    templateNeedsAsset([rule.messageTemplate, comp?.subjectTemplate, comp?.bodyTextTemplate, comp?.bodyHtmlTemplate, ...actionTemplates])
  );
}
