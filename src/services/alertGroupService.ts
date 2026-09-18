/**
 * src/services/alertGroupService.ts
 *
 * The AlertGroup registry (business rule 74, second half): a named set of
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
import { triggerCanJoinGroup, type Trigger } from "./notificationTypes.js";

export interface AlertGroupInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
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
  id: true, name: true, description: true, enabled: true,
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
export async function listJoinableRules(forGroupId?: string) {
  const rules = await prisma.notificationRule.findMany({
    select: { id: true, name: true, enabled: true, severity: true, trigger: true, alertGroupId: true, alertGroup: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
  return rules.map((r) => {
    const t = r.trigger as unknown as Trigger;
    const eligible = triggerCanJoinGroup(t);
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
        ? reasonCannotJoin(t)
        : takenByOther
          ? `Already delivers through "${r.alertGroup?.name ?? "another group"}" — an automation belongs to at most one group.`
          : null,
    };
  });
}

function reasonCannotJoin(trigger: Trigger | null | undefined): string {
  const type = (trigger as { type?: string })?.type;
  if (type === "host_metric") return "Watches the Polaris server itself, so there is no device to group its alerts by.";
  if (type === "event" || type === "change") {
    return "Fires on an instant rather than on a reading it keeps watching, so Polaris cannot tell when its part in a shared alert has ended.";
  }
  return "Reports once per device already, so there is nothing for a group to fold.";
}

export async function createGroup(input: AlertGroupInput, actor?: string) {
  await assertMembership(input.ruleIds ?? [], undefined);
  const group = await prisma.alertGroup.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled !== false,
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
  await assertMembership(input.ruleIds ?? [], id);
  const jsonOrClear = (v: unknown) => (v === undefined ? undefined : v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));
  const group = await prisma.alertGroup.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled !== false,
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

  // DISABLING a group hands delivery back to the member automations, which is
  // a change of owner mid-life — the same reason joining and leaving retire
  // alerts. Retire them so the next tick re-raises them under whoever owns
  // them now, rather than leaving alerts escalating on a chain nobody can see.
  if (existing.enabled && input.enabled === false) {
    await retireGroupAlerts(id, "system:group-disabled");
  }

  await logEvent({
    action: "alert_group.updated",
    resourceType: "alert-group",
    resourceId: id,
    resourceName: group.name,
    actor,
    message: `Alert group "${group.name}" updated`,
    details: { enabled: input.enabled !== false, ruleIds: input.ruleIds ?? null },
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
async function assertMembership(ruleIds: string[], forGroupId: string | undefined): Promise<void> {
  if (!ruleIds.length) return;
  const rules = await prisma.notificationRule.findMany({
    where: { id: { in: ruleIds } },
    select: { id: true, name: true, trigger: true, alertGroupId: true, alertGroup: { select: { name: true } } },
  });
  if (rules.length !== ruleIds.length) throw new AppError(400, "One or more automations no longer exist");
  for (const r of rules) {
    if (!triggerCanJoinGroup(r.trigger as unknown as Trigger)) {
      throw new AppError(400, `"${r.name}" cannot join a group — ${reasonCannotJoin(r.trigger as unknown as Trigger)}`);
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
