/**
 * src/services/notifications/alertActions.ts — running an alert's actions (CQ-B063, moved verbatim from notificationEngine.ts):
 * executeActionsSafe, enqueueAlertActions, and the rule-owner lookups that decide whose
 * actions an alert runs (groupOwnersOf / groupOwnerOf / ownerActions).
 */

import { prisma } from "../../db.js";
import { logEvent } from "../eventLogService.js";
import { type AutomationAction, alertOwnerOf, type DeliveryOwner } from "../notificationTypes.js";
import { scopeRegionTagsOf } from "../notificationRecipientService.js";
import { executeActions, type ActionExecContext } from "../automationActionService.js";
import { type DbRule, type Reading } from "./ruleModel.js";
import { regionSnapshot } from "./scope.js";

/** Best-effort action fan-out — never breaks rule evaluation. (executeActions
 *  is already best-effort per action; this guards the fan-out itself.) */
export async function executeActionsSafe(notificationId: string, actions: AutomationAction[], ctx: Record<string, string>, exec: ActionExecContext): Promise<void> {
  if (!actions || actions.length === 0) return;
  try {
    await executeActions(notificationId, actions, ctx, exec);
  } catch (err) {
    await logEvent({
      action: "notification.delivery_expand_error",
      resourceType: "notification",
      resourceId: notificationId,
      actor: "system:notification-engine",
      level: "warning",
      message: "Failed to execute automation actions",
      details: { err: (err as Error)?.message },
    }).catch(() => {});
  }
}

/** Fan the alert's actions out to the delivery pipeline (shared by initial fire
 *  + band escalation/de-escalation + resolved). */
export async function enqueueAlertActions(
  notifId: string,
  actions: AutomationAction[],
  ctx: Record<string, string>,
  rule: DbRule,
  reading: Reading,
  /** Set when this send UPDATES a grouped alert that gained a contribution
   *  (business rule 75) rather than opening one. */
  growth?: { growth: true; count: number; change?: string },
  /** The AlertGroup delivering this alert, when one governs it (business rule
   *  75). Supplies the email layout; the caller has already swapped in its
   *  actions. Provenance (ruleId, ruleName) stays the AUTOMATION's. */
  owner?: DeliveryOwner | null,
): Promise<void> {
  await executeActionsSafe(notifId, actions, ctx, {
    ...(growth ? { growth: { count: growth.count, ...(growth.change ? { change: growth.change } : {}) } } : {}),
    scopeRegionTags: scopeRegionTagsOf(rule.scope),
    // The triggering asset's own region tags (stripped) — recipientDeviceRegion
    // routing. Same snapshot fire() writes to Notification.regionTags.
    assetRegionTags: regionSnapshot(reading.tags),
    assetId: reading.assetId || null,
    ruleId: rule.id,
    ruleName: rule.name,
    ruleEmailComposition: owner ? owner.emailComposition : rule.emailComposition,
    actor: "system:notification-engine",
  });
}

/** What `alertOwnerOf` needs of an AlertGroup to answer for its delivery. */
const GROUP_OWNER_SELECT = {
  id: true, name: true, enabled: true, requireAckNote: true,
  actions: true, escalation: true, repeat: true, emailComposition: true, resetActions: true, messageTemplate: true,
} as const;

/**
 * The AlertGroup that DELIVERS these alerts, per alert, or nothing (business
 * rule 75: a group owns delivery, its members own detection).
 *
 * Asked of the ALERT, never of the automation: `alertGroupId` is stamped only
 * where the group governs the device, so a member firing on a device outside
 * the group's scope still delivers on its own — and a disabled group owns
 * nothing (`alertOwnerOf`). Zero queries for an automation in no group, which
 * is every automation in an install that has not made one; one query for a
 * whole drain pass otherwise.
 */
export async function groupOwnersOf(notificationIds: string[]): Promise<Map<string, DeliveryOwner>> {
  const out = new Map<string, DeliveryOwner>();
  if (notificationIds.length === 0) return out;
  const rows = await prisma.notification.findMany({
    where: { id: { in: notificationIds }, alertGroupId: { not: null } },
    select: { id: true, severity: true, alertGroup: { select: GROUP_OWNER_SELECT } },
  });
  for (const r of rows) {
    const owner = alertOwnerOf({ severity: r.severity, alertGroup: r.alertGroup });
    if (owner?.kind === "group") out.set(r.id, owner);
  }
  return out;
}

export async function groupOwnerOf(rule: DbRule, notificationId: string): Promise<DeliveryOwner | null> {
  if (!rule.alertGroupId) return null;
  return (await groupOwnersOf([notificationId])).get(notificationId) ?? null;
}

/** The owner's own actions, for a send it delivers. `EscalatableAction` is a
 *  superset of the plain action shape; the chains on it run from the sweep. */
export function ownerActions(owner: DeliveryOwner): AutomationAction[] {
  return (owner.actions ?? []) as AutomationAction[];
}
