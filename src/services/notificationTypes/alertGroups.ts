/**
 * src/services/notificationTypes/alertGroups.ts — grouped alerts and delivery ownership (business rule 75; CQ-B063, moved verbatim from notificationTypes.ts):
 * the group schema and fold modes, joinability, and who owns an alert's delivery.
 */

import { TEMPLATE_VARIABLES, TEMPLATE_VARIABLE_SECTIONS, formatElapsed } from "../../utils/notificationTemplate.js";
import { defaultAlertEmailTemplate } from "../../utils/alertEmailTemplate.js";
import { SENSOR_CLASS_UNITS } from "../../utils/hardwareSensors.js";
import { PRIORITY_TAGS } from "../../utils/priorityTags.js";
import { MAX_QUIET_WINDOWS } from "../../utils/quietTime.js";
// The wizard picks quiet windows in the SERVER's wall clock and has no
// business asking the maintenance router for the time — that route is gated on
// maintenanceManagement:read, which an automation author needn't hold.
import { serverClockInfo } from "../../utils/maintenanceRecurrence.js";
import { SEVERITIES, EVENT_LEVELS, CLEAR_BEHAVIORS, COMPARATORS, AGGREGATIONS, severityRank, SCOPE_FIELD_OPS } from "./scopeConditions.js";
import { ASSET_METRICS, BOOLEAN_METRICS, BOOLEAN_METRIC_LABELS, PATH_METRICS, PATH_CHANGE_TYPES, PATH_SERVER_LABEL, AGENT_INSTALLED_RULE, ASSET_STATE_FIELDS, HOST_METRICS, CHANGE_TYPES, TRIGGER_GROUP_OPS, type Trigger } from "./triggers.js";
import { RECIPIENT_ROUTED_TYPES, CHANNEL_TYPE_META, RESET_MODES, RESET_EVENT_SUGGESTIONS, API_CALL_METHODS, SCRIPT_RUN_TARGETS, SCRIPT_INTERPRETERS, REBOOT_WHEN, type RepeatConfig, type EscalatableAction, type SeverityBand, type EmailComposition, type EscalationConfig, type AutomationAction, type EscalationV2Config } from "./actions.js";
import { DEFAULT_MISSED_POLLS, DEVICE_FILTER_DIMENSIONS } from "./specificity.js";
import { METRIC_DIMENSIONS, FIELD_DIMENSIONS, SDWAN_MEMBER_IP_TARGETS, INTERFACE_TAG_TARGETS, STATE_FIELD_DIMENSIONS, triggerIsPerDimension } from "./dimensions.js";
import { REPEATABLE_ACTION_TYPES } from "./ruleSchema.js";
import { WINDOWED_RATIO_METRICS, SATURATION_CEILING_METRICS, FORECAST_HORIZON_METRICS, FORECAST_DAYS_DEFAULT, FORECAST_LEVEL_SOURCE_METRICS, DEFAULT_READING_CEILING_PCT, METRIC_META, FIELD_META, CHANGE_TYPE_META } from "./metricMeta.js";

// CQ-B063 — the condition-tree builder vocabulary (builderVocabulary.ts).
import { scopeConditionMeta } from "./builderVocabulary.js";
export { scopeConditionMeta } from "./builderVocabulary.js";


// ─── Grouped alerts (business rule 75) ──────────────────────────────────────
//
// A CONTRIBUTION is (automation, component) on a device. A grouped alert owns
// a set of them. Everything below is PURE — the engine does the I/O, these
// decide. That split is deliberate and matches the poll-counted-hold helpers
// (`leadingRun` / `advanceRun` / `sustainedSeverityByRun`): tests/unit is a
// pure-function suite, so a decision that lives inside the engine's DB path
// can only be covered by the integration suite, and the folds below are
// exactly the part that must never drift.

/** A contribution to a grouped alert, as snapshotted onto Notification.members.
 *
 *  This is a RENDER snapshot. The live truth is the NotificationRuleState rows
 *  pointing at the alert — never ask this array whether a contribution is still
 *  firing. It exists because the email renders at DELIVERY time and the alert
 *  page renders after the clear, both long after those rows were released. */
export interface AlertMember {
  /** The engine's dimensionKey — ifName / sensorName / mountPath / "hc|link".
   *  "" for a whole-device contribution (a composite, or an ungrouped field). */
  key: string;
  /** What a human reads: `interfaceDimLabel` output, so "port12 (AP-1)" rather
   *  than "port12". The label is the whole reason members is JSON and not a
   *  String[] of keys. */
  label: string;
  /** Which automation contributed. Always the one rule while a single
   *  automation folds its own components; several once alert groups land. */
  ruleId: string;
  ruleName: string;
  /** The severity THIS contribution resolved to, from its own rule's bands. */
  severity: string;
  /** Its reading when it joined or last changed, for the email's member table. */
  value?: string;
  /** ISO. Preserved across re-merges — a contribution that is still firing has
   *  joined once, however many ticks have rewritten the snapshot since. */
  joinedAt: string;
  /** ISO. Set when the contribution recovered or left; the row is KEPT, because
   *  what this alert covered is the history the snapshot exists to carry. */
  leftAt?: string;
  /** Set ONLY on a subnet- or automation-folded alert, where contributions come from several
   *  devices: the device this one is about. It joins the identity, because two
   *  hosts both "down" are two findings with the same (rule, key). */
  assetId?: string;
  /** Set only on a subnet-folded alert: the subnet it is about, as a human
   *  reads it — "Plant A (10.1.0.0/24)". What {asset} renders as there. */
  subnet?: string;
  /** Set only on an automation-folded alert split per COMPONENT (a Path
   *  Monitor automation: one alert per path check): the component every
   *  device on the alert shares, as a human reads it — the check's name. */
  component?: string;
  /** Set only on a WHOLE-GROUP alert (foldBy `deviceAutomation`): the group's
   *  name. Every device and every member automation share that one alert. */
  group?: string;
}

/** The true size of a multi-device alert, read from its state rows.
 *
 *  The members snapshot is capped at MAX_GROUP_MEMBERS, so a count taken from
 *  it stops at 64 — "64 devices" in the subject of an 80-device outage. These
 *  are counted over every FIRING contribution instead. */
export interface SpanCounts {
  /** Distinct devices. */
  devices: number;
  /** Distinct path checks among the Path Monitor contributions. */
  checks: number;
  /** Distinct automations. */
  automations: number;
  /** Every contribution is a Path Monitor one. */
  pathOnly: boolean;
  /** What every contributing automation's condition says about a check
   *  (pathConditionPhrase), when they all say the same thing — "is down" /
   *  "are down". Absent when they differ or any is not a Path Monitor one. */
  condition?: { one: string; many: string } | null;
}

/** "3 devices", "1 path check". */
export function countNoun(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** What a whole-group alert is about, before its " · N devices": the path
 *  checks when every contribution is a Path Monitor one, the automations when
 *  there are several, else nothing (one automation reads as "N devices" alone,
 *  as an automation fold does). */
export function wholeGroupSubject(c: SpanCounts): string {
  if (c.pathOnly) return countNoun(c.checks, "path check");
  return c.automations > 1 ? countNoun(c.automations, "automation") : "";
}

/** A 48-port switch plus its SFPs. Past this an alert has stopped being about
 *  components and is about the device, and a body listing 200 of them is not a
 *  message anyone reads. The cap drops the OLDEST departed entries first, then
 *  refuses new ones. */
export const MAX_GROUP_MEMBERS = 64;

/** How many contributions a one-line summary (a message, a subject) names
 *  before it says "and N more". Bounded because `{dimension}` reaches the email
 *  SUBJECT on a rule that templates it there. */
export const GROUP_LABEL_CAP = 6;

/** The identity of a live grouped alert.
 *
 *  Prefixed by scope so the two kinds can never collide in the partial unique
 *  index: an automation folding its own components keys on itself, and (once
 *  alert groups land) a group keys on the group. A rule joining or leaving a
 *  group therefore changes its key, which is what keeps the old episode's row
 *  and the new one from fighting over it. */
export function groupKeyOf(scope: "rule" | "grp", id: string, target: string): string {
  // `target` is the asset id, or the fold's own target on a group that folds
  // another way (subnetFoldTarget / automationFoldTarget /
  // WHOLE_GROUP_FOLD_TARGET).
  return `${scope}:${id}|${target}`;
}

/** Does this rule consolidate its alerts into one per device?
 *
 *  The single gate the engine branches on — everything grouping-related is
 *  behind it, which is what makes the feature cost exactly nothing for every
 *  rule in an install that has not opted in. */
export function ruleGroupsByAsset(rule: {
  groupByAsset?: boolean | null;
  /** Membership of an AlertGroup IMPLIES the fold: joining a group means one
   *  alert per device, components included. An operator who put an automation
   *  in a group and still got eight alerts per switch would reasonably call
   *  that broken. */
  alertGroupId?: string | null;
  /** The group's fold axis. A SUBNET or AUTOMATION group also takes
   *  whole-device triggers (monitor status is down), so membership alone no
   *  longer settles it. */
  alertGroupFoldBy?: string | null;
  trigger: Trigger;
}): boolean {
  if (rule.alertGroupId) return triggerCanJoinGroup(rule.trigger, rule.alertGroupFoldBy);
  return rule.groupByAsset === true && triggerIsPerDimension(rule.trigger);
}

/** What an AlertGroup folds its members' alerts by.
 *
 *  `device` — one alert per device, its components and automations folded in
 *  (the original shape). `automation` — one alert per member AUTOMATION: every
 *  device the group governs that trips it shares that automation's one alert,
 *  each device a member. `deviceAutomation` — BOTH folds at once: one alert for
 *  the WHOLE group, every device and every member automation in it ("3 path
 *  checks · 80 devices"). Until 2026-10-27 it meant the opposite — one alert
 *  per device per automation — and the migration that redefined it retired the
 *  alerts raised under that meaning. `subnet` — one alert per
 *  registry SUBNET: every device the group governs whose primary IP falls in
 *  the same subnet (the most specific non-deprecated Subnet row containing it)
 *  shares one alert, so a switch dropping twelve hosts behind it is one page,
 *  not twelve. A device in no registry subnet still alerts, on its own. */
export const ALERT_GROUP_FOLD_BY = ["device", "automation", "deviceAutomation", "subnet"] as const;

export type AlertGroupFoldBy = (typeof ALERT_GROUP_FOLD_BY)[number];

/** Does this fold put SEVERAL devices into one alert? Its members then carry
 *  their device (`AlertMember.assetId`), which joins their identity. */
export function foldSpansDevices(foldBy: string | null | undefined): boolean {
  return foldBy === "subnet" || foldBy === "automation" || foldBy === "deviceAutomation";
}

/** The `groupKey` target of a subnet-folded alert. Prefixed so it can never be
 *  mistaken for an asset id in the same group's key space. */
export function subnetFoldTarget(subnetId: string): string {
  return `subnet:${subnetId}`;
}

/** The `groupKey` target of an automation-folded alert: one per member
 *  automation, whatever devices it covers. */
export function automationFoldTarget(ruleId: string, componentKey?: string | null): string {
  // A Path Monitor automation splits per path check: `auto:<rule>/<checkId>`.
  return componentKey ? `auto:${ruleId}/${componentKey}` : `auto:${ruleId}`;
}

/** The `groupKey` target of a whole-group (`deviceAutomation`) alert: the one
 *  alert the group keeps, whatever devices and automations it covers. */
export const WHOLE_GROUP_FOLD_TARGET = "all";

/**
 * May this trigger contribute to an AlertGroup?
 *
 * Wider than `triggerIsPerDimension` by exactly one case: a COMPOSITE fires
 * once per device at dimensionKey "" — redundant as a per-rule fold, which is
 * why the checkbox refuses it, but a perfectly good whole-device contribution
 * to a group. "Switch health" wanting a composite beside a PoE-fault automation
 * is the obvious case, not an exotic one.
 *
 * Refused: `host_metric` (no device to group by) and `event`/`change` — and
 * that refusal is structural rather than cautious. The event tail writes no
 * `NotificationRuleState` row at all, so there would be nothing for the "was
 * that the last contribution?" count to see, and the alert could never learn
 * that the event's part in it had ended. Revisit only with a state row for them.
 */
export function triggerCanJoinGroup(
  trigger: Trigger | null | undefined,
  /** A SUBNET, AUTOMATION or WHOLE-GROUP fold holds DEVICES, so a whole-device
   *  trigger — "monitor status is down" above all — has something to fold
   *  there, where a device group would only ever hold one contribution per
   *  alert. */
  foldBy?: string | null,
): boolean {
  if (!trigger) return false;
  if (trigger.type === "composite") return trigger.kind !== "host";
  if (foldSpansDevices(foldBy)) return trigger.type === "asset_metric" || trigger.type === "asset_state";
  return triggerIsPerDimension(trigger);
}

/** Where a rule's grouped alerts live: its group when it has one, else itself.
 *
 *  The two scopes can never collide in the partial unique index, and a rule
 *  joining or leaving a group CHANGES its key — which is what stops the old
 *  episode's alert and the new one fighting over the same row. */
export function alertScopeOf(
  rule: { id: string; alertGroupId?: string | null },
  /** Whether the group GOVERNS this particular device.
   *
   *  A group may carry a scope of its own, which narrows where the fold
   *  applies without touching what any member watches (detection stays the
   *  automation's — business rule 75). On a device the group does not govern,
   *  the member falls back to its OWN key and delivers as an ungrouped
   *  automation would. Defaults true so every caller that has no group, or a
   *  group with no scope, behaves exactly as before. */
  groupGoverns = true,
): { scope: "rule" | "grp"; id: string } {
  return rule.alertGroupId && groupGoverns
    ? { scope: "grp", id: rule.alertGroupId }
    : { scope: "rule", id: rule.id };
}

/** The contributions that have NOT recovered. */
export function activeMembers(members: AlertMember[] | null | undefined): AlertMember[] {
  return (members ?? []).filter((m) => !m.leftAt);
}

/**
 * Fold this tick's live contributions into the stored snapshot.
 *
 * Three properties the callers depend on:
 *  - a contribution already present keeps its ORIGINAL `joinedAt` (it joined
 *    once; every later tick merely re-renders the snapshot) and clears any
 *    `leftAt` — a port that faults, recovers and faults again inside one alert
 *    is the same contribution returning, not a second one;
 *  - a stored contribution absent from `live` is NOT dropped. It is left
 *    exactly as it is: departure is stamped by `markMemberLeft` on the recovery
 *    transition, because only the state rows know the difference between "this
 *    recovered" and "this tick produced no reading for it" (a collection gap
 *    must never read as a recovery — the same rule the engine's no-readings
 *    freeze enforces one layer down);
 *  - order is stable: existing entries keep their position, new ones append.
 *    A re-render that reshuffled the list would rewrite the message on a tick
 *    where nothing happened.
 */
export function mergeMembers(
  prev: AlertMember[] | null | undefined,
  live: AlertMember[],
  now: Date,
): AlertMember[] {
  const out = [...(prev ?? [])];
  const byKey = new Map<string, number>();
  out.forEach((m, i) => byKey.set(memberIdentity(m), i));
  const stamp = now.toISOString();
  for (const m of live) {
    const at = byKey.get(memberIdentity(m));
    if (at === undefined) {
      out.push({ ...m, joinedAt: m.joinedAt || stamp });
      byKey.set(memberIdentity(m), out.length - 1);
      continue;
    }
    const existing = out[at]!;
    out[at] = {
      ...existing,
      label: m.label,
      ruleName: m.ruleName,
      severity: m.severity,
      value: m.value,
      // Re-joining is the same contribution returning — keep the original
      // joinedAt so "since" on the alert does not jump backwards.
      joinedAt: existing.joinedAt,
      leftAt: undefined,
    };
  }
  return capMembers(out);
}

/** Stamp a contribution as recovered/departed, keeping its row for the history. */
export function markMemberLeft(
  members: AlertMember[] | null | undefined,
  ruleId: string,
  key: string,
  now: Date,
  /** The contribution's device — consulted only for a member that carries one. */
  assetId?: string | null,
): AlertMember[] {
  return (members ?? []).map((m) =>
    memberMatches(m, ruleId, key, assetId) && !m.leftAt ? { ...m, leftAt: now.toISOString() } : m,
  );
}

/** What one later contribution did to a grouped alert: arrived for the first
 *  time, or came back after recovering inside the same alert. */
export interface GroupChange {
  label: string;
  /** "joined": never on this alert before. "returned": it recovered (its
   *  member row carries `leftAt`) and has faulted again. "recovered": it was
   *  on the alert and has come good while others still have not. */
  kind: "joined" | "returned" | "recovered";
  /** How long it had been recovered, for a "returned" contribution. */
  awayMs?: number;
}

/**
 * Classify the contributions joining an alert against the snapshot they join.
 *
 * Read BEFORE `mergeMembers`, which clears `leftAt` and so erases the very
 * difference this reports. A contribution already active in the snapshot is
 * not a change and is left out.
 */
export function classifyGroupChanges(
  prev: AlertMember[] | null | undefined,
  joining: AlertMember[],
  now: Date,
): GroupChange[] {
  const byId = new Map((prev ?? []).map((m) => [memberIdentity(m), m]));
  const out: GroupChange[] = [];
  for (const m of joining) {
    const before = byId.get(memberIdentity(m));
    if (!before) { out.push({ label: m.label || m.key, kind: "joined" }); continue; }
    if (!before.leftAt) continue;
    const left = Date.parse(before.leftAt);
    out.push({
      label: m.label || m.key,
      kind: "returned",
      ...(Number.isNaN(left) ? {} : { awayMs: Math.max(0, now.getTime() - left) }),
    });
  }
  return out;
}

/** How many components an update's subject tag names before "+N more". The
 *  subject already carries the device and the automation; past three names it
 *  stops being readable on a phone. */
const CHANGE_SUBJECT_CAP = 3;

/**
 * What an `[UPDATED]` email says changed — the `{alert.change}` sentence and
 * the short tag the default subject carries.
 *
 * Exists because an update used to be byte-identical to the first send apart
 * from the count, and a port that recovers and faults again inside one alert
 * leaves the count where it was: the reader got the same email again with
 * nothing to say why. Null when there is nothing to report.
 */
export function describeGroupChanges(
  changes: GroupChange[],
  opts: { reopenedFrom?: string | null } = {},
): { sentence: string; subjectTag: string } | null {
  if (!changes.length) return null;
  const joined = changes.filter((c) => c.kind === "joined");
  const returned = changes.filter((c) => c.kind === "returned");
  const recovered = changes.filter((c) => c.kind === "recovered");
  const clauses: string[] = [];
  if (joined.length) {
    clauses.push(`${listLabels(joined.map((c) => c.label))} joined this alert`);
  }
  if (recovered.length) {
    clauses.push(`${listLabels(recovered.map((c) => c.label))} recovered`);
  }
  for (const c of returned) {
    clauses.push(c.awayMs !== undefined
      ? `${c.label} is in fault again after recovering for ${formatElapsed(c.awayMs)}`
      : `${c.label} is in fault again after recovering`);
  }
  let sentence = `Update: ${clauses.join("; ")}.`;
  if (opts.reopenedFrom !== undefined) {
    sentence += ` Re-opened — ${opts.reopenedFrom || "someone"} had acknowledged it.`;
  }
  const tags = changes.map((c) => (c.kind === "joined" ? `+${c.label}` : c.kind === "recovered" ? `−${c.label}` : `${c.label} back`));
  const subjectTag = tags.length > CHANGE_SUBJECT_CAP
    ? `${tags.slice(0, CHANGE_SUBJECT_CAP).join(", ")} +${tags.length - CHANGE_SUBJECT_CAP} more`
    : tags.join(", ");
  return { sentence, subjectTag };
}

/**
 * Fold one batch of changes into those already waiting to be sent, so an
 * update email names each component once with its LATEST state (business rule
 * 75, the update cadence). A component that joined and recovered inside the
 * same interval was never worth an email and drops out; one that recovered and
 * faulted again reads as "back"; later states replace earlier ones otherwise.
 */
export function mergeGroupChanges(pending: GroupChange[] | null | undefined, incoming: GroupChange[]): GroupChange[] {
  const out = new Map<string, GroupChange>();
  for (const c of pending ?? []) out.set(c.label, c);
  for (const c of incoming) {
    const before = out.get(c.label);
    if (before?.kind === "joined" && c.kind === "recovered") { out.delete(c.label); continue; }
    if (before?.kind === "recovered" && (c.kind === "returned" || c.kind === "joined")) {
      out.set(c.label, { ...c, kind: "returned" });
      continue;
    }
    out.set(c.label, c);
  }
  return [...out.values()];
}

/** What `Notification.pendingChanges` holds: the changes since the last send,
 *  and who had acknowledged the alert when a change re-opened it. */
export interface PendingGroupChanges {
  changes: GroupChange[];
  reopenedFrom?: string;
}

/**
 * The next value of `Notification.pendingChanges` after `incoming` (and,
 * when this change re-opened an acknowledged alert, who had acknowledged it),
 * or null when there is nothing new to queue — the column is then left alone.
 */
export function queueGroupChanges(
  stored: unknown,
  incoming: GroupChange[],
  reopenedFrom?: string,
): PendingGroupChanges | null {
  if (!incoming.length && reopenedFrom === undefined) return null;
  const prev = stored && typeof stored === "object" ? (stored as Partial<PendingGroupChanges>) : {};
  const changes = mergeGroupChanges(Array.isArray(prev.changes) ? prev.changes : [], incoming);
  const reopened = prev.reopenedFrom ?? reopenedFrom;
  return { changes, ...(reopened !== undefined ? { reopenedFrom: reopened } : {}) };
}

/**
 * Refresh the member-derived keys of a stored template context so an update
 * sent from it — a recovery carries no reading to rebuild one from — names the
 * alert as it stands now: {dimension} and its siblings, {asset} on an alert
 * spanning devices that names no subnet, the message, and the component list
 * inside {trigger.summary}. Returns a NEW object; the stored one is untouched.
 */
export function refreshMemberContext(
  ctx: Record<string, string>,
  members: AlertMember[],
  message: string | null,
  /** The alert's true size (state rows) on a multi-device alert. Without it
   *  the counts come from the members, which stop at MAX_GROUP_MEMBERS. */
  counts?: SpanCounts | null,
): Record<string, string> {
  const out = { ...ctx };
  const before = out["dimension"] ?? "";
  const list = renderMemberList(members);
  const active = activeMembers(members);
  out["dimension"] = list;
  out["dimension.count"] = String(active.length);
  out["dimension.first"] = primaryMember(members)?.label ?? "";
  out["dimension.list"] = renderMemberList(members, Number.MAX_SAFE_INTEGER);
  out["dimension.suffix"] = list ? ` · ${list}` : "";
  if (members.some((m) => m.assetId) && !members.some((m) => m.subnet)) {
    const devices = countNoun(counts?.devices ?? new Set(active.map((m) => m.assetId)).size, "device");
    const group = members.find((m) => m.group)?.group;
    const whole = group && counts ? wholeGroupSubject(counts) : "";
    if (group) {
      // A whole-group alert (readingContextParts): "3 path checks · 80 devices",
      // named for its one automation or, once there are several, the group.
      if (whole) {
        out["asset"] = whole;
        out["dimension.suffix"] = ` · ${devices}`;
        // The problem agrees with the new count — "1 path check is down" became
        // "2 path checks are down" (readingContextParts' {condition.suffix}).
        out["condition.suffix"] = counts?.pathOnly && counts.condition
          ? ` ${counts.checks === 1 ? counts.condition.one : counts.condition.many}`
          : "";
        // The headline restates both counts ("3 path checks are down from 80
        // devices"), which the host-list replace below cannot reach.
        if (out["condition.suffix"]) out["trigger.summary"] = `${whole}${out["condition.suffix"]} from ${devices}`;
      }
      else out["asset"] = devices;
      if (counts) out["rule"] = counts.automations === 1 ? (active[0]?.ruleName ?? out["rule"] ?? "") : group;
    } else if (members.some((m) => m.component)) {
      // A split per path check keeps the check as {asset}; the count is its
      // subject tag (readingContextParts).
      out["dimension.suffix"] = ` · ${devices}`;
    } else out["asset"] = devices;
  }
  if (before && out["trigger.summary"]?.includes(before)) out["trigger.summary"] = out["trigger.summary"].replace(before, list);
  if (message !== null) out["message"] = message;
  return out;
}

/** "a", "a and b", "a, b and c" — capped at GROUP_LABEL_CAP like the message. */
function listLabels(labels: string[]): string {
  const shown = labels.slice(0, GROUP_LABEL_CAP);
  const extra = labels.length - shown.length;
  if (extra > 0) return `${shown.join(", ")} and ${extra} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** A contribution is identified by (automation, component), not by component
 *  alone — two automations may both be about port12 and they are two findings. */
function memberIdentity(m: AlertMember): string {
  return memberIdentityOf(m.ruleId, m.key, m.assetId);
}

/** Does this stored member stand for THIS contribution? The device is compared
 *  only when the member carries one (a subnet- or automation-folded alert), so every member
 *  stored before subnet folding existed matches exactly as it did. */
export function memberMatches(m: AlertMember, ruleId: string, key: string, assetId?: string | null): boolean {
  return m.ruleId === ruleId && m.key === key && (!m.assetId || m.assetId === assetId);
}

/** The identity pair, flattened.
 *
 *  `|` is unambiguous here even though a dimension key may contain one (the
 *  SD-WAN keys are "<healthCheck>|<link>"): a rule id is a UUID, so the FIRST
 *  separator is always the boundary and nothing in the left half can imitate
 *  it. Splitting is never needed anyway — this string is only ever compared. */
function memberIdentityOf(ruleId: string, key: string, assetId?: string): string {
  // The device only on a multi-device fold's members, so every member stored
  // before that existed keeps exactly the identity it had.
  return assetId ? `${ruleId}|@${assetId}|${key}` : `${ruleId}|${key}`;
}

/** Hold the snapshot to MAX_GROUP_MEMBERS, shedding DEPARTED entries oldest
 *  first. An active contribution is never dropped for a departed one — the
 *  history is what gives way, never the live finding. */
function capMembers(members: AlertMember[]): AlertMember[] {
  if (members.length <= MAX_GROUP_MEMBERS) return members;
  const departed = members
    .map((m, i) => ({ m, i }))
    .filter((e) => e.m.leftAt)
    .sort((a, b) => String(a.m.leftAt).localeCompare(String(b.m.leftAt)));
  const drop = new Set<number>();
  for (const e of departed) {
    if (members.length - drop.size <= MAX_GROUP_MEMBERS) break;
    drop.add(e.i);
  }
  const kept = members.filter((_, i) => !drop.has(i));
  // Still over: the alert genuinely has more live contributions than the cap.
  // Keep the FIRST ones — they are the oldest findings, and the count on the
  // alert still reports the true total.
  return kept.length <= MAX_GROUP_MEMBERS ? kept : kept.slice(0, MAX_GROUP_MEMBERS);
}

/** The alert's severity: the worst of what is still wrong.
 *
 *  Over ACTIVE contributions only — a recovered critical port must not hold the
 *  alert at critical. Falls back to the rule's base severity when nothing is
 *  active, which is the moment before the last contribution's clear lands. */
export function groupSeverity(members: AlertMember[] | null | undefined, base: string): string {
  const active = activeMembers(members);
  if (!active.length) return base;
  let best = active[0]!.severity;
  for (const m of active) if (severityRank(m.severity) > severityRank(best)) best = m.severity;
  return best;
}

/**
 * The contribution the alert LEADS with — what `Notification.dimension` and
 * `Notification.metric` are stamped from, and therefore which component the
 * email's charts and LLDP block are about.
 *
 * Worst severity first, then a natural sort of the key, so port2 precedes
 * port10 (the same ordering nocDashboardService and the asset Alerts tab
 * already apply to per-port alerts). Deterministic on purpose: a tie broken by
 * array order would let a re-render swap the alert's primary component, and
 * with it the graph in the email.
 */
export function primaryMember(members: AlertMember[] | null | undefined): AlertMember | null {
  const active = activeMembers(members);
  const pool = active.length ? active : (members ?? []);
  if (!pool.length) return null;
  return [...pool].sort((a, b) => {
    const d = severityRank(b.severity) - severityRank(a.severity);
    if (d !== 0) return d;
    return naturalCompare(a.key, b.key) || naturalCompare(a.label, b.label);
  })[0]!;
}

/** "port2" before "port10" — digits compared as numbers, not as text. */
export function naturalCompare(a: string, b: string): number {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * The contribution list a sentence names: "port12 (AP-1), port14 and 5 more".
 *
 * Labels, never keys — `interfaceDimLabel` exists so an alert says
 * "port12 (Indoor AP)" and an operator does not have to go and look up which
 * port that is. Active contributions only, in primary-first order, so the
 * worst thing leads the sentence.
 */
export function renderMemberList(
  members: AlertMember[] | null | undefined,
  cap = GROUP_LABEL_CAP,
): string {
  const active = activeMembers(members);
  if (!active.length) return "";
  const ordered = [...active].sort((a, b) => {
    const d = severityRank(b.severity) - severityRank(a.severity);
    if (d !== 0) return d;
    return naturalCompare(a.key, b.key) || naturalCompare(a.label, b.label);
  });
  const shown = ordered.slice(0, Math.max(1, cap)).map((m) => m.label || m.key).filter(Boolean);
  const extra = ordered.length - shown.length;
  if (extra <= 0) return shown.join(", ");
  return `${shown.join(", ")} and ${extra} more`;
}

// ─── Who owns an alert's delivery (business rule 75, second half) ───────────

/**
 * The delivery policy behind a live alert: its AlertGroup when it has one, else
 * its automation.
 *
 * Deliberately RULE-SHAPED. Every existing resolver —
 * `effectiveAckNoteForSeverity`, `escalationChainsForSeverity`,
 * `allEscalationsOf`, `allRepeatsOf`, `effectiveActionsForSeverity` — takes a
 * rule-ish object, and handing them one keeps the whole grouped path on the
 * same code as the ungrouped one rather than growing a parallel set that can
 * drift. `kind` exists for the surfaces that must SAY which it was (the alert
 * page's "Automation" row, the widget's title), not for branching on policy.
 *
 * A group carries no `severityBands`: a grouped alert's severity is the max of
 * its active contributions, each resolved by its own automation's bands. That
 * falls out correctly — every band-aware resolver reads an empty ladder and
 * answers from the base, which is the group's own policy.
 */
export interface DeliveryOwner {
  kind: "rule" | "group";
  id: string;
  name: string;
  severity: string;
  severityBands: SeverityBand[] | null;
  requireAckNote: boolean;
  actions: EscalatableAction[] | null;
  escalation: EscalationV2Config | EscalationConfig | null;
  repeat: RepeatConfig | null;
  emailComposition: EmailComposition | null;
  resetActions: AutomationAction[] | null;
  messageTemplate: string | null;
}

/** The shapes `alertOwnerOf` reads — a notification with its relations joined. */
export interface AlertOwnerSources {
  severity?: string | null;
  rule?: {
    // id/name are optional because several callers select only the policy
    // columns — the owner's identity matters to the surfaces that NAME it, not
    // to the ones that only ask what it requires.
    // `severity` likewise: it is the rule's BASE severity, which only the
    // ack-note resolver's "is the alert sitting at the base?" test consults.
    // A caller selecting only reset actions has no use for it, and falling
    // back to the alert's own severity makes that test answer yes — which is
    // the right answer when there are no bands to consult anyway.
    id?: string; name?: string; severity?: string;
    severityBands?: unknown; requireAckNote?: boolean | null;
    actions?: unknown; escalation?: unknown; repeat?: unknown;
    emailComposition?: unknown; resetActions?: unknown; messageTemplate?: string | null;
  } | null;
  alertGroup?: {
    id: string; name: string; enabled?: boolean;
    requireAckNote?: boolean | null;
    actions?: unknown; escalation?: unknown; repeat?: unknown;
    emailComposition?: unknown; resetActions?: unknown; messageTemplate?: string | null;
  } | null;
}

/**
 * Resolve an alert's delivery owner. Null when there is neither — a test alert
 * or one whose automation was deleted, which every caller already treats as
 * "no policy left to enforce".
 *
 * A DISABLED group does not own anything: its member automations go back to
 * delivering on their own, so an alert that outlives the group being switched
 * off falls back to the rule rather than losing its escalation entirely.
 */
export function alertOwnerOf(n: AlertOwnerSources | null | undefined): DeliveryOwner | null {
  const g = n?.alertGroup;
  if (g && g.enabled !== false) {
    return {
      kind: "group",
      id: g.id,
      name: g.name,
      // The alert's own severity is the max of its contributions; the group has
      // no base of its own, so it reports what the alert is sitting at. That is
      // what makes `effectiveAckNoteForSeverity`'s "is this the base?" test
      // answer yes and fall through to the group's own flag.
      severity: n?.severity ?? "warning",
      severityBands: null,
      requireAckNote: g.requireAckNote === true,
      actions: (g.actions ?? null) as EscalatableAction[] | null,
      escalation: (g.escalation ?? null) as EscalationV2Config | EscalationConfig | null,
      repeat: (g.repeat ?? null) as RepeatConfig | null,
      emailComposition: (g.emailComposition ?? null) as EmailComposition | null,
      resetActions: (g.resetActions ?? null) as AutomationAction[] | null,
      messageTemplate: g.messageTemplate ?? null,
    };
  }
  const r = n?.rule;
  if (!r) return null;
  return {
    kind: "rule",
    id: r.id ?? "",
    name: r.name ?? "",
    severity: r.severity ?? n?.severity ?? "warning",
    severityBands: (r.severityBands ?? null) as SeverityBand[] | null,
    requireAckNote: r.requireAckNote === true,
    actions: (r.actions ?? null) as EscalatableAction[] | null,
    escalation: (r.escalation ?? null) as EscalationV2Config | EscalationConfig | null,
    repeat: (r.repeat ?? null) as RepeatConfig | null,
    emailComposition: (r.emailComposition ?? null) as EmailComposition | null,
    resetActions: (r.resetActions ?? null) as AutomationAction[] | null,
    messageTemplate: r.messageTemplate ?? null,
  };
}

/** What one dimension of a reading IS, in an operator's words — so a surface can
 *  say "one alert per interface" without hardcoding the vocabulary. */
const DIMENSION_NOUNS: Record<string, string> = {
  ifNamePattern: "interface",
  sensorClass: "sensor",
  sensorNamePattern: "sensor",
  mountPathPattern: "storage mount",
  healthCheck: "SD-WAN health check",
  sdwanRulePattern: "SD-WAN rule",
  link: "WAN member",
  tunnelName: "IPsec tunnel",
  widgetId: "custom widget",
  stateProbeId: "state probe",
  stateRowPattern: "state-probe row",
  checkId: "path check",
};

/**
 * The dimension VOCABULARY a trigger or leaf speaks — its dimension keys,
 * sorted and joined — or null when it is a whole-device thing (CPU,
 * monitorStatus, an event).
 *
 * It exists to answer one question the reset-tree lookup has to get right:
 * "does this leaf report about the same KIND of component the firing alert is
 * about?" Two leaves in the same space (a `poeStatus` trigger and an
 * `ifOperStatus` reset leaf, both `["ifNamePattern"]`) index their readings by
 * the same dimension key, so a missing reading for one port is a missing
 * reading, never a licence to answer from another port. Two leaves in
 * DIFFERENT spaces (a per-port trigger and a device-wide CPU leaf) cannot
 * index each other's keys at all, and the device-wide answer is the only one
 * there is — which is the mixed-tree case resolveResetTruths exists to serve.
 *
 * The key SET is the identity on purpose: `sdwanRuleStatus` (`["sdwanRulePattern"]`)
 * and `sdwanMemberState` (`["healthCheck", "link"]`) are both SD-WAN, but their
 * readings are keyed differently, so a member-state leaf genuinely cannot
 * answer about a rule-status dimension and the two are correctly separate.
 */
export function dimensionSpaceOf(
  t: { type?: string; metric?: string; field?: string } | null | undefined,
): string | null {
  if (!t) return null;
  const keys = t.type === "asset_metric"
    ? METRIC_DIMENSIONS[t.metric ?? ""]
    : t.type === "asset_state" ? STATE_FIELD_DIMENSIONS[t.field ?? ""] : null;
  return keys && keys.length ? [...keys].sort().join(",") : null;
}

/** What a per-component alert CALLS its component, for the one line of an email
 *  or a page that has to label it ("Interface", "Sensor", "IPsec tunnel").
 *  Empty for a whole-device trigger, which has no component to name. */
export function dimensionNounOf(
  t: { type?: string; metric?: string; field?: string } | null | undefined,
): string {
  if (!t) return "";
  const keys = t.type === "asset_metric"
    ? METRIC_DIMENSIONS[t.metric ?? ""]
    : t.type === "asset_state" ? STATE_FIELD_DIMENSIONS[t.field ?? ""] : null;
  const noun = keys?.length
    ? DIMENSION_NOUNS[keys[0]!]
    : t.type === "asset_metric" ? METRIC_COMPONENT_NOUNS[t.metric ?? ""] : undefined;
  return noun ? noun.charAt(0).toUpperCase() + noun.slice(1) : "";
}

/**
 * A WHOLE-DEVICE metric whose alert still names components: cpuCorePct raises
 * one alert per device (dimension key "") but labels it with the cores that are
 * over the line, so the email's component row reads "CPU cores — Core 3 (97%)".
 * Deliberately not a METRIC_DIMENSIONS entry: that would give the metric a
 * dimension space and a filter input, and there is one alert per device here.
 */
const METRIC_COMPONENT_NOUNS: Record<string, string> = {
  cpuCorePct: "CPU cores",
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
    // The conditions that take the SD-WAN member IP address filter (business
    // rule 98). Absent on a pre-upgrade server; the wizard then offers no row.
    sdwanMemberIpTargets: Array.from(SDWAN_MEMBER_IP_TARGETS),
    // The conditions that take the interface tag filter (business rule
    // 133(g)). Absent on a pre-upgrade server; the wizard then offers no row.
    interfaceTagTargets: Array.from(INTERFACE_TAG_TARGETS),
    // Business rule 136(e): which triggers may take their severity from the
    // Priority tag, and the tag → severity ladder the wizard explains. Absent
    // on a pre-upgrade server; the wizard then offers no switch.
    prioritySeverity: {
      triggers: [
        { field: "monitorStatus", operator: "==", value: "down", subject: "device" },
        { field: "ifOperStatus", operator: "==", value: "down", subject: "interface" },
      ],
      tags: PRIORITY_TAGS.map((p) => ({ name: p.name, severity: p.severity })),
    },
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
      // Business rule 78 — the toggle that lets this automation speak for a
      // dependency-suppressed device. Served as data for the same reason as
      // the count: a wizard talking to a pre-upgrade server must not render a
      // control whose key the API would refuse.
      dependencyDownKey: "alertWhenDependencyDown",
      dependencyDownLabel: "Also alert when the device is dependency-down",
      dependencyDownHelp:
        "A device behind a down switch or firewall is normally silenced (Dep. Down). " +
        "With this on, this automation still raises its alert the moment the device turns Dep. Down, " +
        "and the message names the upstream device that is actually down. " +
        "One notification only — reminders and escalation wait until the upstream device is back. " +
        "A maintenance window still silences it, on the device or on anything above it.",
    },
    // Per-dimension alerting vocabulary — which state fields report per
    // dimension, and what one dimension is called. The reset step reads both to
    // say whether a custom reset condition clears one alert or every alert on
    // the device (see the resolveResetTruths note in notificationEngine).
    stateFieldDimensions: STATE_FIELD_DIMENSIONS,
    dimensionNouns: DIMENSION_NOUNS,
    // Consolidating per device (business rule 75). Published as a capability so
    // a pre-upgrade client simply renders no checkbox rather than posting a
    // field the server would reject — the same degradation posture every other
    // catalog flag takes. The wizard decides WHEN to show it from
    // stateFieldDimensions / metricDimensions above, and names the thing being
    // folded from dimensionNouns, so the copy follows the vocabulary instead of
    // repeating it.
    alertGrouping: {
      supported: true,
      labelCap: GROUP_LABEL_CAP,
      help:
        "Raise one alert per device instead of one per component. Every affected component is named on " +
        "the alert, one acknowledgement covers all of them, and the alert stays up until the last one " +
        "recovers. {dimension} then renders the list rather than a single name.",
    },
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
    // ...and which of them the ceiling applies to at all (packet loss, not a
    // path check's failure rate — see SATURATION_CEILING_METRICS).
    saturationCeilingMetrics: SATURATION_CEILING_METRICS,
    // Metrics read as a projection over the trigger's `forecastDays` (memory
    // forecast), so the builder gives the condition a "within N days" box
    // instead of an aggregation, prefilled with the server's default.
    forecastHorizonMetrics: FORECAST_HORIZON_METRICS,
    // ...and which metric's automations a forecast may take its levels from
    // (a memory forecast follows a memory-utilization automation).
    forecastLevelSources: FORECAST_LEVEL_SOURCE_METRICS,
    forecastDaysDefault: FORECAST_DAYS_DEFAULT,
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
    // The order and names of the variable list's sections (TemplateVariable.section).
    templateSections: TEMPLATE_VARIABLE_SECTIONS,
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
    // The Path Monitor category (see PATH_METRICS): which stored metrics and
    // change types the wizard files under it rather than under Device / Change,
    // and the scope rule its pool is ANDed with — served so the client's
    // preview narrows exactly as the engine does.
    pathMonitor: {
      metrics: PATH_METRICS,
      changeTypes: PATH_CHANGE_TYPES,
      agentRule: AGENT_INSTALLED_RULE,
      serverLabel: PATH_SERVER_LABEL,
    },
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
      { type: "reboot", label: "Reboot the device", requires: null, permission: "assets" },
    ],
    rebootMeta: {
      whenOptions: REBOOT_WHEN,
      defaultAt: "02:00",
      defaultMinGapHours: 24,
      maxMinGapHours: 720,
      help: "Books a reboot of the device that raised the alert, through the same scheduler and opt-ins as Reboot in the asset's Status row (credential, integration or agent must allow reboots; HA FortiGates are refused). Skipped when a reboot is already booked for the device or it rebooted within the minimum gap. Never runs on reset or from a Test button. A human must review any automation that reboots production equipment.",
    },
    apiCallMeta: {
      allowedMethods: API_CALL_METHODS,
      urlSchemes: ["https", "http"],
      maxBodyBytes: 10000,
      maxHeaders: 20,
      maxTimeoutSec: 60,
      help: "Header values are treated as secrets: encrypted at rest and shown masked. Saving keeps a masked value only while the URL is unchanged — change the URL and enter the header again.",
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
      ifTag: "on interfaces tagged {value}",
      hostnamePattern: "on devices whose hostname matches {value}",
      ipPattern: "on devices whose IP matches {value}",
      macPattern: "on devices whose MAC matches {value}",
      manufacturerPattern: "on devices whose manufacturer matches {value}",
      modelPattern: "on devices whose model matches {value}",
      mountPathPattern: "on mounts matching {value}",
      sdwanRulePattern: "on SD-WAN rules matching {value}",
      healthCheck: "for health check {value}",
      link: "on member {value}",
      // {value} is the stored comparison; the wizard words its operator
      // ("!= 0.0.0.0" → "is not 0.0.0.0") before substituting.
      sdwanMemberIp: "on members whose IP address {value}",
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
