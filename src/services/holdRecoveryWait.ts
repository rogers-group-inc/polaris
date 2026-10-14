/**
 * src/services/holdRecoveryWait.ts — keep a rule-80 maintenance hold open
 * until the device answers Polaris's OWN monitoring again.
 *
 * Shared by the two operations that reboot a device on purpose: a firmware
 * flash (business rule 87, kind `firmware-upgrade`) and a reboot (business
 * rule 115, kind `device-reboot`). Both prove the device back over a channel
 * of their own — its web UI, its controller, its agent — and that routinely
 * answers minutes before the SNMP / ICMP / REST collectors the status machine
 * and every automation read (a FortiAP's HTTPS answered while its SNMP agent
 * was still silent, and the misses landed just outside the window).
 *
 * So the wait is for the first SUCCESSFUL `AssetMonitorSample` recorded after
 * `since`. NOTHING SCHEDULED WRITES ONE while the wait runs: the hold itself
 * parks the asset at status "maintenance", and MONITOR_CANDIDATE_WHERE drops
 * that status from every server-driven poll. Waiting on the scheduler alone
 * therefore sat out the full cap on every agentless device and then warned
 * that monitoring "did not answer" — it had never been asked. So each poll of
 * the wait runs the device's own response-time probe here (`probeAsset`, the
 * one Poll Now runs, through the same four-tier polling method) and records a
 * SUCCESS through `recordProbeResult` — the same sample, status-machine and
 * uptime/reboot path the scheduled pass uses. A failed probe is not recorded:
 * the device is mid-recovery, inside the window that exists so it is not
 * judged yet, and at the cap normal polling resumes and judges it. The table
 * is still the signal, not the probe's return value: an agent-polled host's
 * probe is a synthetic no-op (its real samples arrive by push), and the
 * sample buffer flushes a recorded success a few seconds later. No hold (an
 * unmonitored device — openMaintenanceHold declined) means nothing polls it,
 * so there is nothing to wait for. The hold's own expiry is pushed out to
 * cover the wait, and the wait is capped by `recoveryWaitMs`: a device that
 * never answers ends the window at the cap and is judged normally.
 *
 * `rebootSince` (business rule 115(a)): a reboot Polaris asked for must not
 * raise the "Device recently rebooted" alert, and that alert is driven by the
 * `device.reboot` Event monitoring writes when the device's uptime drops — on
 * the first probe that READS uptime after the boot, which can be later than
 * the first probe that answers. So with `rebootSince` the window stays open
 * until monitoring has recorded that reboot (`Asset.lastRebootAt` past
 * `rebootSince`, stamped in the same tick as the Event and flushed after it),
 * or — once monitoring has answered — until it is clear monitoring reads no
 * uptime for this device at all (`lastUptimeSec` null: no Event can come).
 * Still capped by `recoveryWaitMs`.
 *
 * Scale: one probe plus one or two indexed point queries per `recoveryPollMs`
 * (15 s), per live run — a handful of devices at a time, not the fleet.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import type { MaintenanceHoldKind } from "./maintenanceScheduleService.js";
import { probeAsset, recordProbeResult } from "./monitoringService.js";

/**
 * Ask the device the way scheduled monitoring would, and record the reading
 * only when it answered. Never throws: a probe that cannot run leaves the wait
 * reading the table, exactly as before.
 */
async function probeWhileHeld(assetId: string): Promise<void> {
  try {
    const out: NonNullable<Parameters<typeof probeAsset>[1]> = {};
    const result = await probeAsset(assetId, out);
    if (!result.success || result.skipped || result.duplicate) return;
    await recordProbeResult(assetId, result, out.snapshot, { timeoutMs: out.timeoutMs });
  } catch (err) {
    logger.warn({ err, assetId }, "recovery-wait probe failed");
  }
}

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
  rebootSince?: Date,
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

  let answeredAt: Date | null = null;
  let toldWaiting = false;
  while (Date.now() < deadline) {
    if (rebootSince) {
      const a = await prisma.asset.findUnique({ where: { id: assetId }, select: { lastRebootAt: true, lastUptimeSec: true } }).catch(() => null);
      if (a?.lastRebootAt && a.lastRebootAt > rebootSince) {
        run.push("info", "monitoring recorded the reboot; ending the maintenance window");
        return true;
      }
      if (answeredAt && a && a.lastUptimeSec === null) {
        run.push("info", "monitoring answered and reads no uptime for this device, so it cannot report the reboot; ending the maintenance window");
        return true;
      }
    }
    // The hold keeps the scheduler off this asset, so this is the only poll it
    // gets until the window ends. Its sample (and, for a reboot, its uptime
    // reading) is buffered, so the checks below may only see it next time.
    await probeWhileHeld(assetId);
    if (!answeredAt) {
      const answered = await prisma.assetMonitorSample.findFirst({
        where: { assetId, success: true, timestamp: { gt: since } },
        orderBy: { timestamp: "asc" },
        select: { timestamp: true },
      }).catch(() => null);
      if (answered) {
        answeredAt = answered.timestamp;
        run.push("info", `monitoring answered ${Math.max(0, Math.round((answered.timestamp.getTime() - since.getTime()) / 1000))} s after the device came back${rebootSince ? "" : "; ending the maintenance window"}`);
        if (!rebootSince) return true;
        continue;
      }
    } else if (!toldWaiting) {
      toldWaiting = true;
      run.push("info", "waiting for monitoring to read the device's uptime and record the reboot");
    }
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(timeouts.recoveryPollMs, deadline - Date.now()))));
    await run.flush();
  }
  if (answeredAt) {
    run.push("warn", `monitoring answered but did not record the reboot within ${Math.round(timeouts.recoveryWaitMs / 60_000)} min; ending the maintenance window — a "Device recently rebooted" alert may follow`);
    return true;
  }
  run.push("warn", `the device did not answer its monitoring probe within ${Math.round(timeouts.recoveryWaitMs / 60_000)} min of coming back; ending the maintenance window anyway — check the device`);
  return false;
}
