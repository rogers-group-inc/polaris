/**
 * src/services/firmwareEmailService.ts — the one sender behind every firmware
 * upgrade email (business rule 93), and the notices for a flash started from
 * the card NOW with "Email me" ticked.
 *
 * `sendFirmwareEmail` renders `utils/firmwareResultEmailTemplate.ts` once per
 * recipient — each reader in their own zone when the address is a Polaris
 * user's, else the install's — and sends it through the install's oldest
 * enabled email channel (`resolveSummaryChannel`, the quiet-time summary's
 * resolver), letterheaded by `applyBrandLetterhead`. A per-reader message,
 * not a split alert, so rule 25 is untouched. It never throws for a delivery
 * problem: it answers with what went wrong (no channel, or the addresses that
 * failed) and the caller records it.
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
import { applyBrandLetterhead, sendEmailThroughChannel } from "./notificationDeliveryService.js";
import { resolveSummaryChannel } from "./quietTimeSummaryService.js";
import { resolveTimeZone, serverTimeZone } from "./userTimezoneService.js";
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
 * Send one email per recipient. `facts` is everything but the reader's zone.
 * Answers null when every message went, else why not — "no enabled email
 * channel …" or "<address>: <error>; …" for the ones that failed (the rest
 * still went).
 */
export async function sendFirmwareEmail(recipients: readonly string[], facts: Omit<FirmwareResultEmailInput, "zone">): Promise<string | null> {
  if (recipients.length === 0) return null;
  const channel = await resolveSummaryChannel(null, []);
  if (!channel) return "no enabled email channel (SMTP or Microsoft 365) is configured";

  const users = await prisma.user.findMany({
    where: { email: { in: [...recipients], mode: "insensitive" } },
    select: { email: true, timezone: true, detectedTimezone: true },
  });
  const zoneOf = new Map<string, string>();
  for (const u of users) if (u.email) zoneOf.set(u.email.toLowerCase(), resolveTimeZone(u.timezone, u.detectedTimezone));

  const failures: string[] = [];
  for (const address of recipients) {
    try {
      const rendered = renderFirmwareResultEmail({ ...facts, zone: zoneOf.get(address) ?? serverTimeZone() });
      const msg = await applyBrandLetterhead({ to: [address], subject: rendered.subject, text: rendered.text, html: rendered.html });
      await sendEmailThroughChannel({ type: channel.type, config: channel.config as Record<string, unknown> }, msg);
    } catch (err) {
      failures.push(`${address}: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    }
  }
  return failures.length > 0 ? failures.join("; ") : null;
}

// ─── A flash's own recipients ────────────────────────────────────────────────

const RUN_SELECT = {
  id: true, assetId: true, status: true, result: true, error: true, fromVersion: true, toVersion: true,
  verifiedVersion: true, startedBy: true, startedAt: true, finishedAt: true, log: true,
  notifyEmails: true, notifiedAt: true,
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
  const error = await sendFirmwareEmail(run.notifyEmails, {
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
  const error = await sendFirmwareEmail(run.notifyEmails, {
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
