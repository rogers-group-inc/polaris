/**
 * src/services/firmwareEmailService.ts — the one sender behind every firmware
 * upgrade email (business rule 93), and the notices for a flash started from
 * the card NOW with "Email me" ticked.
 *
 * `sendFirmwareEmail` renders `utils/firmwareResultEmailTemplate.ts` and
 * hands it to `operationNotifyService.deliverOperationEmail` with a target —
 * To / Cc / Bcc and the chosen email channels, resolved from what the booking
 * or run stored (`targetFor`, 2026-11-09). One message per To address in that
 * reader's zone, or ONE message when there is a Cc / Bcc; the oldest enabled
 * email channel when none was chosen. It never throws for a delivery problem:
 * it answers with what went wrong and the caller records it.
 *
 * Who calls it:
 *   firmwareScheduleService — a booking's scheduled / rescheduled notice and
 *       its results (finished, refused, missed, orphaned), to the booking's
 *       recipients.
 *   notifyRunStarted        — every run that carries `notifyEmails` (a flash
 *       started now with recipients, or a booking firing — the job copies the
 *       booking's recipients onto the run), right after the run starts.
 *   notifyRunFinished       — a flash started NOW with recipients, when it
 *       ends; a booked run's outcome is the booking's results email instead
 *       (`notifyScheduledRunFinished`), so it is never sent twice. Once per
 *       run: `FirmwareUpgradeRun.notifiedAt` is claimed before sending, so the
 *       runner and the boot sweep cannot both send it.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { deliverOperationEmail, targetFor, type NotifyTarget } from "./operationNotifyService.js";
import { renderFirmwareResultEmail, type FirmwareResultEmailInput, type FirmwareResultOutcome } from "../utils/firmwareResultEmailTemplate.js";

const LOG_TAIL = 15;

export interface FirmwareEmailAsset {
  deviceName: string;
  model: string | null;
  osVersion: string | null;
}

/** The device as the email names it. */
export async function firmwareEmailAsset(assetId: string): Promise<FirmwareEmailAsset> {
  const a = await prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true, ipAddress: true, model: true, osVersion: true } });
  return { deviceName: a?.hostname || a?.ipAddress || assetId, model: a?.model ?? null, osVersion: a?.osVersion ?? null };
}

/**
 * Send the email to a target — its To / Cc / Bcc on its channels
 * (`operationNotifyService.deliverOperationEmail`: one message per To address
 * in that reader's zone, or ONE message when there is a Cc / Bcc). `facts` is
 * everything but the reader's zone. Answers null when every message went, else
 * why not.
 */
export async function sendFirmwareEmail(target: NotifyTarget, facts: Omit<FirmwareResultEmailInput, "zone">): Promise<string | null> {
  return deliverOperationEmail(target, (zone) => renderFirmwareResultEmail({ ...facts, zone }));
}

// ─── A flash's own recipients ────────────────────────────────────────────────

const RUN_SELECT = {
  id: true, assetId: true, status: true, result: true, error: true, fromVersion: true, toVersion: true,
  verifiedVersion: true, startedBy: true, startedAt: true, finishedAt: true, log: true,
  notifyEmails: true, notifyRecipients: true, notifyChannelIds: true, notifiedAt: true,
  schedule: { select: { id: true, scheduledFor: true, createdBy: true } },
} as const;

async function recordRunEmailFailure(run: { id: string; assetId: string; toVersion: string; notifyEmails: string[] }, deviceName: string, notice: string, error: string): Promise<void> {
  await logEvent({
    action: "firmware.upgrade_email_failed",
    resourceType: "asset",
    resourceId: run.assetId,
    resourceName: deviceName,
    actor: "system:firmware",
    level: "warning",
    message: `The "${notice}" email for the firmware upgrade to ${run.toVersion} could not be sent: ${error}`,
    details: { runId: run.id, notice, notifyEmails: run.notifyEmails, error },
  });
}

/**
 * The run has started: tell its recipients. Sent for any run that carries
 * `notifyEmails` — a click-to-run flash with "Email me" ticked, or a booking
 * the job just fired. Fire-and-forget from `startFirmwareUpgrade`; a failure
 * is a warning Event, never a reason the flash does not run.
 */
export async function notifyRunStarted(runId: string): Promise<void> {
  const run = await prisma.firmwareUpgradeRun.findUnique({ where: { id: runId }, select: RUN_SELECT });
  if (!run || run.notifyEmails.length === 0) return;
  const asset = await firmwareEmailAsset(run.assetId);
  const error = await sendFirmwareEmail(await targetFor(run), {
    outcome: "started",
    scheduled: !!run.schedule,
    assetId: run.assetId,
    deviceName: asset.deviceName,
    model: asset.model,
    fromVersion: run.fromVersion ?? asset.osVersion,
    toVersion: run.toVersion,
    verifiedVersion: null,
    result: null,
    error: null,
    scheduledFor: run.schedule?.scheduledFor ?? null,
    startedAt: run.startedAt,
    finishedAt: null,
    scheduledBy: run.schedule?.createdBy ?? run.startedBy,
    log: [],
  });
  if (error) await recordRunEmailFailure(run, asset.deviceName, "started", error);
  else logger.info({ runId, recipients: run.notifyEmails.length }, "firmware upgrade started email sent");
}

/**
 * A click-to-run flash with recipients has ended: email its outcome, once.
 * A booked run is skipped — its booking's results email says the same thing
 * (`notifyScheduledRunFinished`). Called by the runner's `.finally` and by the
 * boot sweep for a run a restart orphaned.
 */
export async function notifyRunFinished(runId: string): Promise<void> {
  const run = await prisma.firmwareUpgradeRun.findUnique({ where: { id: runId }, select: RUN_SELECT });
  if (!run || run.schedule || run.notifyEmails.length === 0 || run.notifiedAt) return;
  if (run.status === "queued" || run.status === "running") return;
  const claimed = await prisma.firmwareUpgradeRun.updateMany({ where: { id: run.id, notifiedAt: null }, data: { notifiedAt: new Date() } });
  if (claimed.count === 0) return;
  const outcome: FirmwareResultOutcome = run.status === "succeeded" ? "succeeded" : run.status === "unverified" ? "unverified" : "failed";
  const asset = await firmwareEmailAsset(run.assetId);
  const log = Array.isArray(run.log) ? (run.log as Array<{ t: string; level: string; msg: string }>).slice(-LOG_TAIL) : [];
  const error = await sendFirmwareEmail(await targetFor(run), {
    outcome,
    scheduled: false,
    assetId: run.assetId,
    deviceName: asset.deviceName,
    model: asset.model,
    fromVersion: run.fromVersion ?? asset.osVersion,
    toVersion: run.toVersion,
    verifiedVersion: run.verifiedVersion,
    result: run.result,
    error: run.error,
    scheduledFor: null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    scheduledBy: run.startedBy,
    log,
  });
  if (error) {
    await prisma.firmwareUpgradeRun.update({ where: { id: run.id }, data: { notifyError: error.slice(0, 2000) } }).catch(() => undefined);
    await recordRunEmailFailure(run, asset.deviceName, outcome, error);
  } else {
    logger.info({ runId, recipients: run.notifyEmails.length, outcome }, "firmware upgrade results emailed");
  }
}
