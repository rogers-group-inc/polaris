/**
 * src/jobs/resolveStaleReservationConflicts.ts
 *
 * One-shot startup cleanup. Finds pending reservation Conflict rows whose
 * stored proposed values now match the live Reservation values — i.e. the
 * conflict was raised by an old discovery run when hostnames/owner/projectRef
 * differed, but the values have since come back into sync (operator updated
 * the manual reservation, asset hostname was renormalized, etc.). The inline
 * fix in `upsertConflict` stops new conflicts of this kind from lingering;
 * this job mops up the legacy ones that pre-date the fix.
 *
 * Match rule: a conflict is "stale" iff every field listed in conflictFields
 * (hostname / owner / projectRef) has the same value on the proposed side as
 * on the live reservation. If any one of them still differs, the conflict
 * stays open.
 *
 * Idempotent: re-running on a clean database is a no-op.
 *
 * Import this module from src/app.ts to activate it.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import { conflictValuesEqual } from "../utils/conflictValue.js";

async function resolveStaleReservationConflicts(): Promise<void> {
  try {
    await runInstrumentedJob("resolveStaleReservationConflicts", async () => {
    const candidates = await prisma.conflict.findMany({
      where: { status: "pending", entityType: "reservation" },
      include: {
        reservation: {
          select: { id: true, hostname: true, owner: true, projectRef: true },
        },
      },
    });

    if (candidates.length === 0) return;

    const stale: string[] = [];
    for (const c of candidates) {
      if (!c.reservation) continue;
      const fields = c.conflictFields || [];
      if (fields.length === 0) {
        stale.push(c.id);
        continue;
      }
      // Same comparison discovery raises with (utils/conflictValue.ts), so a
      // card raised under the old byte-level compare — a trailing space, an
      // NBSP, a case-only hostname difference — closes on the next restart.
      const stillDiffers = fields.some((f) => {
        if (f === "hostname") return !conflictValuesEqual(f, c.proposedHostname, c.reservation!.hostname);
        if (f === "owner") return !conflictValuesEqual(f, c.proposedOwner, c.reservation!.owner);
        if (f === "projectRef") return !conflictValuesEqual(f, c.proposedProjectRef, c.reservation!.projectRef);
        return true;
      });
      if (!stillDiffers) stale.push(c.id);
    }

    if (stale.length === 0) return;

    const result = await prisma.conflict.updateMany({
      where: { id: { in: stale }, status: "pending" },
      data: { status: "rejected", resolvedBy: "auto", resolvedAt: new Date() },
    });

    if (result.count > 0) {
      logger.info(
        { resolved: result.count, scanned: candidates.length },
        "Auto-resolved stale reservation conflicts at startup",
      );
    }
    });
  } catch (err) {
    logger.error(err, "Error running resolveStaleReservationConflicts startup job");
  }
}

setTimeout(resolveStaleReservationConflicts, 5_000);
