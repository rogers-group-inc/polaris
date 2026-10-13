/**
 * src/services/rebootScheduleCancel.ts — a booked reboot is withdrawn once the
 * device has rebooted some other way (business rule 115(b)).
 *
 * A booking exists to get the device rebooted. When it reboots first — an
 * operator's reboot-now succeeded, or monitoring saw its uptime reset (a
 * crash, a power cut, a flash, a reboot from its own console) — the booking
 * has nothing left to do, and firing it would take the device down a second
 * time for no reason. So the pending booking (at most one per asset: the
 * partial unique index on `reboot_schedules`) is cancelled with a reason, and
 * an `asset.reboot_schedule_cancelled` Event says why.
 *
 * Its own module, importing only the database and the Event log, because
 * monitoringService calls it from the probe path and must not pull in the
 * booking service's email and delivery graph.
 *
 * Scale: called only on a reboot (rare) — one indexed read, and a conditional
 * update only when a booking exists.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";

export type RebootCancelCause = "manual" | "detected";

export interface CancelAfterRebootInput {
  assetId: string;
  cause: RebootCancelCause;
  /** Who rebooted it (`manual`), or "system:monitor" (`detected`). */
  actor: string;
  resourceName?: string;
  /** The reboot run that did it (`manual`). */
  runId?: string;
  now?: Date;
}

/** Cancel the asset's pending reboot booking, if any. Never throws. Returns how many were cancelled. */
export async function cancelPendingRebootAfterReboot(input: CancelAfterRebootInput): Promise<number> {
  try {
    const pending = await prisma.rebootSchedule.findMany({
      where: { assetId: input.assetId, status: "pending" },
      select: { id: true, scheduledFor: true },
    });
    if (pending.length === 0) return 0;
    const now = input.now ?? new Date();
    const why = input.cause === "manual"
      ? `the device was rebooted by ${input.actor}`
      : "monitoring detected the device rebooted (its uptime reset)";
    let cancelled = 0;
    for (const p of pending) {
      // Conditional: a booking the scheduler claimed in the meantime is
      // already running and is not ours to cancel.
      const res = await prisma.rebootSchedule.updateMany({
        where: { id: p.id, status: "pending" },
        data: { status: "cancelled", cancelledBy: input.cause === "manual" ? input.actor : "system:reboot", cancelledAt: now, error: `Cancelled: ${why}` },
      });
      if (res.count === 0) continue;
      cancelled++;
      await logEvent({
        action: "asset.reboot_schedule_cancelled",
        resourceType: "asset",
        resourceId: input.assetId,
        resourceName: input.resourceName,
        actor: "system:reboot",
        level: "info",
        message: `Scheduled reboot (${p.scheduledFor.toISOString()}) cancelled: ${why}, so it is no longer needed`,
        details: { scheduleId: p.id, scheduledFor: p.scheduledFor.toISOString(), automatic: true, cause: input.cause, rebootedBy: input.actor, runId: input.runId ?? null },
      });
    }
    return cancelled;
  } catch (err) {
    logger.warn({ err, assetId: input.assetId }, "could not cancel the booked reboot after the device rebooted");
    return 0;
  }
}
