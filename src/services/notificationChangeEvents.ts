/**
 * src/services/notificationChangeEvents.ts
 *
 * Bridge between the current-state persist* functions (LLDP / processes /
 * SD-WAN rules / MCLAG / wireless) and the notification engine's event path.
 * When at least one enabled `change` rule subscribes to a change type, the
 * persist function calls maybeEmitChangeEvents() with the diffed items and we
 * write one audit Event per change (action = CHANGE_TYPE_ACTIONS[...]). The
 * engine's event-tail then turns matching events into notifications.
 *
 * Gated by isChangeActionSubscribed so there's ZERO cost (no Event writes,
 * no extra work) when no change rule exists — the common case.
 */

import { logEventsBatch } from "./eventLogService.js";
import { isChangeActionSubscribed } from "./notificationRuleService.js";
import { CHANGE_TYPE_ACTIONS } from "./notificationTypes.js";

/**
 * Should a wireless client's roam to another AP (`asset.wireless_ap.changed`)
 * be written at all? Only while an enabled automation uses the "Wireless AP
 * changed (roam)" trigger — the same subscription gate the `change.*` events
 * use. Operator decision 2026-11-09: roams are edge-triggered like the other
 * `asset.*.changed` events but nothing like as rare — every client moving
 * between APs writes one — and unconditionally they dominated the Events log.
 * The asset's own `lastSeenAp` still updates on every roam; only the Event is
 * gated. Asked once per batch by each writer (the wireless scrape in
 * monitoringService, the upstream-chain sweep, discovery's change-event
 * flush). A failed lookup answers false: an audit row is never worth failing
 * the write it rides on.
 */
export async function wirelessRoamEventsWanted(): Promise<boolean> {
  try {
    return await isChangeActionSubscribed(CHANGE_TYPE_ACTIONS.wireless_ap_changed);
  } catch {
    return false;
  }
}

export interface ChangeItem {
  /** Short human label for the changed thing (interface, neighbor, process). */
  label: string;
  /** Optional structured context stored on the Event.details. */
  details?: Record<string, unknown>;
}

/**
 * Emit one audit Event per change item IF a change rule subscribes to `action`.
 * resourceType="asset" + resourceId=assetId so the engine can resolve the
 * notification's asset (and region scope). Best-effort; never throws.
 */
export async function maybeEmitChangeEvents(
  action: string,
  assetId: string,
  assetName: string | null,
  items: ChangeItem[],
): Promise<void> {
  if (items.length === 0) return;
  try {
    if (!(await isChangeActionSubscribed(action))) return;
    await logEventsBatch(
      items.map((it) => ({
        action,
        resourceType: "asset",
        resourceId: assetId,
        resourceName: assetName ?? it.label,
        actor: "system:change-detector",
        level: "info" as const,
        message: `${action}: ${it.label}`,
        details: { ...it.details, change: action },
      })),
    );
  } catch {
    // change detection is best-effort; never break the scrape
  }
}
