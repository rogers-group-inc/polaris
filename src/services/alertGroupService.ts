/**
 * src/services/alertGroupService.ts
 *
 * The AlertGroup registry (business rule 75, second half): a named set of
 * automations whose alerts about ONE device fold into a single alert.
 *
 * ── The split this service exists to hold ────────────────────────────────────
 *
 * A group owns DELIVERY — one set of notify actions, one escalation chain, one
 * reminder cadence, one acknowledge-note policy. Its member automations own
 * DETECTION — trigger, scope, holds, severity bands, reset — and stop
 * delivering on their own while grouped.
 *
 * That is the only split with a coherent answer. Escalation tiers and reminder
 * cadence are per-automation, so an alert raised by three of them has three
 * answers to "when does this page someone?" and no way to choose between them.
 * Letting whichever automation fired FIRST own delivery was rejected because it
 * makes the recipients depend on which check happened to notice first; unioning
 * the recipients answers the To line and leaves escalation exactly as ambiguous.
 *
 * ── Membership ───────────────────────────────────────────────────────────────
 *
 * At most ONE group per automation (a fire must have a single alert to join),
 * and only triggers that can contribute: `asset_metric` / `asset_state` (per
 * component) and `composite` (one whole-device contribution). `host_metric` has
 * no device to group by, and `event`/`change` write no NotificationRuleState
 * row — so there would be nothing for the "was that the last contribution?"
 * count to see, and the alert could never learn their part in it had ended.
 *
 * Joining or leaving RETIRES the automation's live alerts (the shape of its
 * alerts changes, and a live one cannot be reshaped in place), so the next
 * engine tick re-raises them under the new owner.
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { assertActionRefs } from "./notificationRuleService.js";
import { restoreMaskedActionHeaders } from "../utils/actionHeaderMask.js";
import { triggerCanJoinGroup, normalizeRuleToV2, type Trigger, type AlertGroupFoldBy } from "./notificationTypes.js";

export interface AlertGroupInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
  /** Which devices this group governs — narrows where the fold applies, never
   *  what a member watches. Null / allAssets = every device its members cover. */
  scope?: unknown;
  /** "device" (default) or "subnet" — what one alert is per. */
  foldBy?: AlertGroupFoldBy;
  messageTemplate?: string | null;
  requireAckNote?: boolean;
  emailComposition?: unknown;
  actions?: unknown;
  resetActions?: unknown;
  escalation?: unknown;
  repeat?: unknown;
  /** The automations that deliver through this group. Replaces the membership
   *  wholesale — the editor always posts the complete list. */
  ruleIds?: string[];
}

const GROUP_SELECT = {
  id: true, name: true, description: true, enabled: true, scope: true, foldBy: true,
  messageTemplate: true, requireAckNote: true, emailComposition: true,
  actions: true, resetActions: true, escalation: true, repeat: true,
  createdBy: true, createdAt: true, updatedAt: true,
  rules: { select: { id: true, name: true, enabled: true, severity: true, trigger: true }, orderBy: { name: "asc" } },
} as const;

export async function listGroups() {
  return prisma.alertGroup.findMany({ select: GROUP_SELECT, orderBy: { name: "asc" } });
}

export async function getGroup(id: string) {
  const row = await prisma.alertGroup.findUnique({ where: { id }, select: GROUP_SELECT });
  if (!row) throw new AppError(404, "Alert group not found");
  return row;
}

/**
 * Which automations may join, and why each of the rest may not.
 *
 * The refusals are returned rather than merely filtered out: an operator
 * looking for "Agent disconnected" in the picker needs to be told it cannot be
 * grouped and why, or they will conclude the list is broken.
 */
export async function listJoinableRules(forGroupId?: string, foldBy?: AlertGroupFoldBy) {
  // The picker asks for the mode it is SHOWING, which may not be saved yet;
  // without one, the group's stored mode decides.
  const mode = foldBy ?? (forGroupId
    ? (await prisma.alertGroup.findUnique({ where: { id: forGroupId }, select: { foldBy: true } }))?.foldBy
    : undefined) ?? "device";
  const rules = await prisma.notificationRule.findMany({
    select: { id: true, name: true, enabled: true, severity: true, trigger: true, alertGroupId: true, alertGroup: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
  return rules.map((r) => {
    const t = r.trigger as unknown as Trigger;
    const eligible = triggerCanJoinGroup(t, mode);
    const takenByOther = !!r.alertGroupId && r.alertGroupId !== forGroupId;
    return {
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      severity: r.severity,
      triggerType: (t as { type?: string })?.type ?? null,
      member: r.alertGroupId === forGroupId && !!forGroupId,
      selectable: eligible && !takenByOther,
      reason: !eligible
        ? reasonCannotJoin(t, mode)
        : takenByOther
          ? `Already delivers through "${r.alertGroup?.name ?? "another group"}" — an automation belongs to at most one group.`
          : null,
    };
  });
}

function reasonCannotJoin(trigger: Trigger | null | undefined, foldBy: string = "device"): string {
  const type = (trigger as { type?: string })?.type;
  if (type === "host_metric") return "Watches the Polaris server itself, so there is no device to group its alerts by.";
  if (type === "event" || type === "change") {
    return "Fires on an instant rather than on a reading it keeps watching, so Polaris cannot tell when its part in a shared alert has ended.";
  }
  if (foldBy !== "subnet" && (type === "asset_state" || type === "asset_metric")) {
    return "Reports once per device already, so there is nothing for a device group to fold. Set the group to fold by subnet to combine it across the devices of one subnet.";
  }
  return "Reports once per device already, so there is nothing for a group to fold.";
}

export async function createGroup(input: AlertGroupInput, actor?: string) {
  await assertMembership(input.ruleIds ?? [], undefined, input.foldBy ?? "device");
  // The same save-time reference checks an automation's actions get (rule 114(a)).
  restoreMaskedActionHeaders(input, null);
  await assertActionRefs(input as never);
  const group = await prisma.alertGroup.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled !== false,
      scope: (input.scope ?? undefined) as Prisma.InputJsonValue | undefined,
      foldBy: input.foldBy ?? "device",
      messageTemplate: input.messageTemplate ?? null,
      requireAckNote: input.requireAckNote === true,
      emailComposition: (input.emailComposition ?? undefined) as Prisma.InputJsonValue | undefined,
      actions: (input.actions ?? undefined) as Prisma.InputJsonValue | undefined,
      resetActions: (input.resetActions ?? undefined) as Prisma.InputJsonValue | undefined,
      escalation: (input.escalation ?? undefined) as Prisma.InputJsonValue | undefined,
      repeat: (input.repeat ?? undefined) as Prisma.InputJsonValue | undefined,
      createdBy: actor ?? null,
    },
    select: { id: true, name: true },
  });
  await setMembership(group.id, input.ruleIds ?? []);
  if (input.actions === undefined) await seedDeliveryFromMembers(group.id, input.ruleIds ?? [], actor);
  await logEvent({
    action: "alert_group.created",
    resourceType: "alert-group",
    resourceId: group.id,
    resourceName: group.name,
    actor,
    message: `Alert group "${group.name}" created`,
    details: { ruleIds: input.ruleIds ?? [] },
  });
  return getGroup(group.id);
}

export async function updateGroup(id: string, input: AlertGroupInput, actor?: string) {
  const existing = await getGroup(id);
  const foldBy = input.foldBy ?? (existing.foldBy as AlertGroupFoldBy);
  // Checked against the members it will HAVE: the posted list, or the current
  // one when only the mode changed — a device group cannot keep a down
  // automation that only a subnet group can fold.
  await assertMembership(input.ruleIds ?? existing.rules.map((r) => r.id), id, foldBy);
  restoreMaskedActionHeaders(input, existing);
  await assertActionRefs(input as never);
  const jsonOrClear = (v: unknown) => (v === undefined ? undefined : v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));
  const group = await prisma.alertGroup.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled !== false,
      scope: jsonOrClear(input.scope),
      foldBy,
      messageTemplate: input.messageTemplate ?? null,
      requireAckNote: input.requireAckNote === true,
      emailComposition: jsonOrClear(input.emailComposition),
      actions: jsonOrClear(input.actions),
      resetActions: jsonOrClear(input.resetActions),
      escalation: jsonOrClear(input.escalation),
      repeat: jsonOrClear(input.repeat),
    },
    select: { id: true, name: true },
  });
  if (input.ruleIds) await setMembership(id, input.ruleIds);
  if (input.ruleIds && input.actions === undefined) await seedDeliveryFromMembers(id, input.ruleIds, actor);

  // DISABLING a group hands delivery back to the member automations, which is
  // a change of owner mid-life — the same reason joining and leaving retire
  // alerts. Retire them so the next tick re-raises them under whoever owns
  // them now, rather than leaving alerts escalating on a chain nobody can see.
  if (existing.enabled && input.enabled === false) {
    await retireGroupAlerts(id, "system:group-disabled");
  }

  // A SCOPE change moves devices into or out of the group's governance, which
  // changes who delivers their alerts — the same change of owner that joining
  // and leaving are, just expressed as a filter. A live alert cannot be
  // reshaped in place (its recipients and escalation chain would swap under
  // whoever is reading it), so retire and let the next tick re-raise each one
  // under whoever owns it now.
  //
  // Compared as JSON rather than by identity: the editor posts a rebuilt tree
  // on every save, so a reference check would retire every alert on every
  // save of an unrelated field.
  if (JSON.stringify(existing.scope ?? null) !== JSON.stringify(input.scope ?? null)) {
    await retireGroupAlerts(id, "system:group-rescoped");
  } else if (existing.foldBy !== foldBy) {
    // Device <-> subnet changes what ONE alert is: a live alert per device
    // cannot become a member of one per subnet in place. Same retire-and-
    // re-raise as every other reshape.
    await retireGroupAlerts(id, "system:group-refolded");
  }

  await logEvent({
    action: "alert_group.updated",
    resourceType: "alert-group",
    resourceId: id,
    resourceName: group.name,
    actor,
    message: `Alert group "${group.name}" updated`,
    details: { enabled: input.enabled !== false, foldBy, ruleIds: input.ruleIds ?? null },
  });
  return getGroup(id);
}

export async function deleteGroup(id: string, actor?: string) {
  const existing = await getGroup(id);
  // Retire the live alerts FIRST. `alertGroupId` is SetNull, so after the
  // delete nothing connects them to the policy that was escalating them — the
  // same reason deleteRule pre-clears its own.
  await retireGroupAlerts(id, "system:group-deleted");
  // The automations survive: they go back to delivering on their own. Their
  // live alerts are retired by the sweep above, so the next tick re-raises
  // them under their own actions.
  await prisma.notificationRule.updateMany({ where: { alertGroupId: id }, data: { alertGroupId: null } });
  await prisma.alertGroup.delete({ where: { id } });
  await logEvent({
    action: "alert_group.deleted",
    resourceType: "alert-group",
    resourceId: id,
    resourceName: existing.name,
    actor,
    message: `Alert group "${existing.name}" deleted — ${existing.rules.length} automation(s) returned to delivering on their own`,
    details: { ruleIds: existing.rules.map((r) => r.id) },
  });
}

/** What deleting this group would affect, for the confirm dialog — mirroring
 *  `GET /automations/:id/removal-impact`. An operator deleting a group is
 *  changing who gets paged about every one of its automations. */
export async function groupRemovalImpact(id: string) {
  const group = await getGroup(id);
  const liveAlerts = await prisma.notification.count({ where: { alertGroupId: id, cleared: false } });
  return {
    id: group.id,
    name: group.name,
    rules: group.rules.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled })),
    liveAlerts,
    /** Every member automation with NO notify action of its own would go
     *  silent on delete, since the group was doing the telling. */
    rulesWithNoOwnDelivery: await rulesWithoutNotify(group.rules.map((r) => r.id)),
  };
}

async function rulesWithoutNotify(ruleIds: string[]): Promise<{ id: string; name: string }[]> {
  if (!ruleIds.length) return [];
  const rows = await prisma.notificationRule.findMany({
    where: { id: { in: ruleIds } },
    select: { id: true, name: true, actions: true },
  });
  return rows
    .filter((r) => !Array.isArray(r.actions) || !(r.actions as { type?: string }[]).some((a) => a?.type === "notify"))
    .map((r) => ({ id: r.id, name: r.name }));
}

/** Refuse a membership that could never work, naming the automation. */
async function assertMembership(ruleIds: string[], forGroupId: string | undefined, foldBy: string = "device"): Promise<void> {
  if (!ruleIds.length) return;
  const rules = await prisma.notificationRule.findMany({
    where: { id: { in: ruleIds } },
    select: { id: true, name: true, trigger: true, alertGroupId: true, alertGroup: { select: { name: true } } },
  });
  if (rules.length !== ruleIds.length) throw new AppError(400, "One or more automations no longer exist");
  for (const r of rules) {
    if (!triggerCanJoinGroup(r.trigger as unknown as Trigger, foldBy)) {
      throw new AppError(400, `"${r.name}" cannot join a group — ${reasonCannotJoin(r.trigger as unknown as Trigger, foldBy)}`);
    }
    if (r.alertGroupId && r.alertGroupId !== forGroupId) {
      throw new AppError(400, `"${r.name}" already delivers through "${r.alertGroup?.name ?? "another group"}" — an automation belongs to at most one group.`);
    }
  }
}

/**
 * Replace the group's membership, retiring the live alerts of every automation
 * that joined OR left.
 *
 * Both directions matter. An automation joining must stop delivering on its own
 * and start folding into the group's alert; one leaving must go back to its own
 * actions. Either way its live alerts were raised under the other owner, and an
 * alert cannot change owner mid-life — a reader would see its recipients,
 * template and escalation chain swap under them.
 */
async function setMembership(groupId: string, ruleIds: string[]): Promise<void> {
  const current = await prisma.notificationRule.findMany({ where: { alertGroupId: groupId }, select: { id: true } });
  const currentIds = new Set(current.map((r) => r.id));
  const wanted = new Set(ruleIds);
  const joining = ruleIds.filter((id) => !currentIds.has(id));
  const leaving = [...currentIds].filter((id) => !wanted.has(id));
  if (!joining.length && !leaving.length) return;

  if (leaving.length) {
    await prisma.notificationRule.updateMany({ where: { id: { in: leaving } }, data: { alertGroupId: null } });
  }
  if (joining.length) {
    await prisma.notificationRule.updateMany({ where: { id: { in: joining } }, data: { alertGroupId: groupId } });
  }

  const changed = [...joining, ...leaving];
  await prisma.notification.updateMany({
    where: { ruleId: { in: changed }, cleared: false },
    data: { cleared: true, clearedBy: "system:rule-regrouped", clearedAt: new Date() },
  });
  // Release the state rows so the next tick re-fires cleanly under the new
  // owner. Deleting them (rather than clearing) is what updateRule does on the
  // same kind of reshape, and it is what makes the re-fire unconditional.
  await prisma.notificationRuleState.deleteMany({ where: { ruleId: { in: changed } } });
}

/**
 * Give a group with no delivery of its own the delivery of its first member.
 *
 * A group OWNS delivery (business rule 75): while an automation is in one, the
 * engine sends that automation's alerts through the group's actions and never
 * through its own. The Groups tab edits membership, reminders, the ack-note
 * policy and the alert text, but not recipients or escalation chains — so a
 * group created there would own delivery and deliver to nobody. Instead it
 * takes over what the FIRST automation added (in the posted order) that has
 * any actions was already doing: its actions, escalation chain, email layout
 * and reset actions, copied ONCE.
 *
 * Only while the group has no actions of its own, and only into fields the
 * group has not set, so a later save never overwrites recipients set through
 * the API, and editing the member afterwards does not change the group. Read
 * through `normalizeRuleToV2`, so a pre-v2 automation's legacy targets seed
 * the same actions the engine would have sent for it.
 */
/**
 * Business rule 114(a), re-scan F56: the delivery a group will RUN after a
 * create / update — the request's actions, escalation and reset actions where
 * it sends them, the stored ones where it omits them, and the member actions
 * `seedDeliveryFromMembers` would copy in when the group has none. The route
 * runs the script / reboot gate over this, not just over the request body:
 * otherwise adding your automation to a group that already runs a script (or
 * seeding one from a member) attaches that script to alerts you control.
 */
export async function deliveryAfterChange(
  groupId: string | null,
  input: Pick<AlertGroupInput, "actions" | "escalation" | "resetActions" | "ruleIds">,
): Promise<{ actions: unknown; escalation: unknown; resetActions: unknown }> {
  const stored = groupId
    ? await prisma.alertGroup.findUnique({ where: { id: groupId }, select: { actions: true, escalation: true, resetActions: true } })
    : null;
  const pick = (sent: unknown, have: unknown) => (sent === undefined ? have ?? null : sent);
  let actions = pick(input.actions, stored?.actions);
  let escalation = pick(input.escalation, stored?.escalation);
  let resetActions = pick(input.resetActions, stored?.resetActions);
  const empty = !Array.isArray(actions) || actions.length === 0;
  if (input.ruleIds?.length && input.actions === undefined && empty) {
    const rows = await prisma.notificationRule.findMany({
      where: { id: { in: input.ruleIds } },
      select: {
        id: true, name: true, trigger: true, clearBehavior: true, clearAfterSec: true, targets: true,
        emailComposition: true, escalation: true, reset: true, actions: true, severityBands: true,
        bandNotify: true, resetActions: true, repeat: true,
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const rid of input.ruleIds) {
      const r = byId.get(rid);
      if (!r) continue;
      const v2 = normalizeRuleToV2(r);
      if (!v2.actions.length) continue;
      actions = v2.actions;
      if (escalation == null && v2.escalation) escalation = v2.escalation;
      if (resetActions == null && v2.resetActions?.length) resetActions = v2.resetActions;
      break;
    }
  }
  return { actions, escalation, resetActions };
}

async function seedDeliveryFromMembers(groupId: string, ruleIds: string[], actor?: string): Promise<void> {
  if (!ruleIds.length) return;
  const group = await prisma.alertGroup.findUnique({
    where: { id: groupId },
    select: { name: true, actions: true, escalation: true, emailComposition: true, resetActions: true },
  });
  if (!group || (Array.isArray(group.actions) && group.actions.length > 0)) return;

  const rows = await prisma.notificationRule.findMany({
    where: { id: { in: ruleIds } },
    select: {
      id: true, name: true, trigger: true, clearBehavior: true, clearAfterSec: true, targets: true,
      emailComposition: true, escalation: true, reset: true, actions: true, severityBands: true,
      bandNotify: true, resetActions: true, repeat: true,
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  let source: { id: string; name: string; v2: ReturnType<typeof normalizeRuleToV2>; emailComposition: unknown } | null = null;
  for (const rid of ruleIds) {
    const r = byId.get(rid);
    if (!r) continue;
    const v2 = normalizeRuleToV2(r);
    if (v2.actions.length) { source = { id: r.id, name: r.name, v2, emailComposition: r.emailComposition }; break; }
  }
  if (!source) return;

  const json = (v: unknown) => v as Prisma.InputJsonValue;
  await prisma.alertGroup.update({
    where: { id: groupId },
    data: {
      actions: json(source.v2.actions),
      ...(group.escalation == null && source.v2.escalation ? { escalation: json(source.v2.escalation) } : {}),
      ...(group.emailComposition == null && source.emailComposition != null ? { emailComposition: json(source.emailComposition) } : {}),
      ...(group.resetActions == null && source.v2.resetActions?.length ? { resetActions: json(source.v2.resetActions) } : {}),
    },
  });
  await logEvent({
    action: "alert_group.seeded",
    resourceType: "alert-group",
    resourceId: groupId,
    resourceName: group.name,
    actor,
    message: `Alert group "${group.name}" took its recipients from "${source.name}"`,
    details: { fromRuleId: source.id, actions: source.v2.actions.length, escalation: !!source.v2.escalation },
  });
}

/** Retire every live alert this group owns, releasing the state rows behind
 *  them so the next tick re-raises under whoever owns them now. */
async function retireGroupAlerts(groupId: string, reason: string): Promise<void> {
  const live = await prisma.notification.findMany({
    where: { alertGroupId: groupId, cleared: false },
    select: { id: true },
  });
  if (!live.length) return;
  const ids = live.map((n) => n.id);
  await prisma.notification.updateMany({
    where: { id: { in: ids } },
    data: { cleared: true, clearedBy: reason, clearedAt: new Date() },
  });
  await prisma.notificationRuleState.updateMany({
    where: { notificationId: { in: ids } },
    data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null, bandMetSince: Prisma.DbNull },
  });
}
