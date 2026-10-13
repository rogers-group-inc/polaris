/**
 * src/services/holdRecoveryWait.ts — keep a rule-80 maintenance hold open
 * until the device answers Polaris's OWN monitoring again.
 *
 * Shared by the two operations that reboot a device on purpose: a firmware
 * flash (business rule 87, kind `firmware-upgrade`) and a reboot (business
 * rule 114, kind `device-reboot`). Both prove the device back over a channel
 * of their own — its web UI, its controller, its agent — and that routinely
 * answers minutes before the SNMP / ICMP / REST collectors the status machine
 * and every automation read (a FortiAP's HTTPS answered while its SNMP agent
 * was still silent, and the misses landed just outside the window).
 *
 * So the wait is for the first SUCCESSFUL `AssetMonitorSample` recorded after
 * `since` — written by whichever process polls the device (the monitor role
 * on a split-role host), which is why this reads the table rather than
 * asking. No hold (an unmonitored device — openMaintenanceHold declined)
 * means nothing polls it, so there is nothing to wait for. The hold's own
 * expiry is pushed out to cover the wait, and the wait is capped by
 * `recoveryWaitMs`: a device that never answers ends the window at the cap
 * and is judged normally.
 *
 * Scale: one indexed point query per `recoveryPollMs`, per live run.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import type { MaintenanceHoldKind } from "./maintenanceScheduleService.js";

export interface HoldRecoveryRun {
  /** Called once, when the wait actually starts (a hold exists). */
  onWaiting: () => void;
  push: (level: "info" | "warn" | "error", msg: string) => void;
  flush: (force?: boolean) => Promise<void>;
}

/** True when monitoring answered within the cap; false on the cap or with no hold. */
export async function holdUntilMonitorAnswers(
  assetId: string,
  kind: MaintenanceHoldKind,
  timeouts: { recoveryWaitMs: number; recoveryPollMs: number },
  run: HoldRecoveryRun,
): Promise<boolean> {
  const hold = await prisma.maintenanceHold.findUnique({
    where: { assetId_kind: { assetId, kind } },
    select: { expiresAt: true },
  }).catch(() => null);
  if (!hold) return false;

  const since = new Date();
  const deadline = since.getTime() + timeouts.recoveryWaitMs;
  const mustLast = new Date(deadline + 60_000);
  if (hold.expiresAt < mustLast) {
    await prisma.maintenanceHold.update({
      where: { assetId_kind: { assetId, kind } },
      data: { expiresAt: mustLast },
    }).catch((err) => logger.warn({ err, assetId, kind }, "could not extend the maintenance hold for the recovery wait"));
  }
  run.onWaiting();
  run.push("info", `waiting for Polaris's own monitoring to answer before ending the maintenance window (up to ${Math.round(timeouts.recoveryWaitMs / 60_000)} min)`);
  await run.flush(true);

  while (Date.now() < deadline) {
    const answered = await prisma.assetMonitorSample.findFirst({
      where: { assetId, success: true, timestamp: { gt: since } },
      orderBy: { timestamp: "asc" },
      select: { timestamp: true },
    }).catch(() => null);
    if (answered) {
      run.push("info", `monitoring answered ${Math.max(0, Math.round((answered.timestamp.getTime() - since.getTime()) / 1000))} s after the device came back; ending the maintenance window`);
      return true;
    }
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(timeouts.recoveryPollMs, deadline - Date.now()))));
    await run.flush();
  }
  run.push("warn", `monitoring did not answer within ${Math.round(timeouts.recoveryWaitMs / 60_000)} min of the device coming back; ending the maintenance window anyway — check the device`);
  return false;
}
