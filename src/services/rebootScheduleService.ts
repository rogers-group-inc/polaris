/**
 * src/services/rebootScheduleService.ts — a reboot booked for later (business
 * rule 115), and the email that says how it went. The rule-93 shape, shared
 * with the firmware booking: approved when booked, judged when it fires, on
 * time or not at all, and its recipients hear the outcome either way.
 *
 * Booking checks that SOMETHING may reboot the asset (`checkSchedulableReboot`
 * — the opt-in, HA, the asset kind); its live state is taken when it fires.
 * The `startScheduledReboots` job (every minute, web role) CLAIMS a due
 * booking (`pending` → `started`, conditional) and hands it to `startReboot`,
 * which re-takes every gate:
 *   started  — the run began; its outcome is emailed when it ends.
 *   refused  — a gate said no; nothing was sent. Never retried.
 *   pending  — a reboot is already running on the device
 *              (`RebootRunConflictError`); it waits and retries each tick for
 *              up to CONFLICT_WAIT_MS past its time.
 *   missed   — first seen more than LATE_GRACE_MS late (Polaris was down).
 *
 * The recipient / time rules and their limits are the firmware booking's
 * (`normalizeRecipients`, `assertSchedulableTime`), imported, so the two
 * booking forms cannot drift apart. Email goes through the oldest enabled
 * email channel, one message per recipient in that reader's zone.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { checkSchedulableReboot, startReboot, RebootRunConflictError } from "./rebootService.js";
import { normalizeRecipients, assertSchedulableTime, LATE_GRACE_MS, CONFLICT_WAIT_MS } from "./firmwareScheduleService.js";
import { applyBrandLetterhead, sendEmailThroughChannel } from "./notificationDeliveryService.js";
import { resolveSummaryChannel } from "./quietTimeSummaryService.js";
import { resolveTimeZone, serverTimeZone } from "./userTimezoneService.js";
import { renderRebootResultEmail, type RebootResultOutcome } from "../utils/rebootResultEmailTemplate.js";

const DUE_BATCH = 50;
const LOG_TAIL = 15;

export interface RebootScheduleSummary {
  id: string;
  assetId: string;
  scheduledFor: Date;
  notifyEmails: string[];
  status: string;
  runId: string | null;
  error: string | null;
  createdBy: string;
  createdAt: Date;
  updatedBy: string | null;
  updatedAt: Date;
  cancelledBy: string | null;
  cancelledAt: Date | null;
  firedAt: Date | null;
  notifiedAt: Date | null;
  notifyError: string | null;
}

type Row = RebootScheduleSummary;

function summarize(r: Row): RebootScheduleSummary {
  return {
    id: r.id, assetId: r.assetId, scheduledFor: r.scheduledFor, notifyEmails: r.notifyEmails, status: r.status, runId: r.runId,
    error: r.error, createdBy: r.createdBy, createdAt: r.createdAt, updatedBy: r.updatedBy, updatedAt: r.updatedAt,
    cancelledBy: r.cancelledBy, cancelledAt: r.cancelledAt, firedAt: r.firedAt, notifiedAt: r.notifiedAt, notifyError: r.notifyError,
  };
}

async function assetName(assetId: string): Promise<string | undefined> {
  const a = await prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true, ipAddress: true } });
  return a?.hostname || a?.ipAddress || undefined;
}

export async function getPendingRebootSchedule(assetId: string): Promise<RebootScheduleSummary | null> {
  const r = await prisma.rebootSchedule.findFirst({ where: { assetId, status: "pending" } });
  return r ? summarize(r) : null;
}

export async function listRebootSchedulesForAsset(assetId: string, limit = 20): Promise<RebootScheduleSummary[]> {
  const rows = await prisma.rebootSchedule.findMany({ where: { assetId }, orderBy: { createdAt: "desc" }, take: Math.min(Math.max(limit, 1), 100) });
  return rows.map(summarize);
}

async function getOwn(assetId: string, scheduleId: string): Promise<Row> {
  const r = await prisma.rebootSchedule.findUnique({ where: { id: scheduleId } });
  if (!r || r.assetId !== assetId) throw new AppError(404, "Scheduled reboot not found");
  return r;
}

export async function createRebootSchedule(input: { assetId: string; scheduledFor: Date; notifyEmails: string[]; actor: string; now?: Date }): Promise<RebootScheduleSummary & { warnings: string[] }> {
  assertSchedulableTime(input.scheduledFor, input.now);
  const recipients = normalizeRecipients(input.notifyEmails);
  const { plan, warnings } = await checkSchedulableReboot(input.assetId);
  if (await prisma.rebootSchedule.findFirst({ where: { assetId: input.assetId, status: "pending" }, select: { id: true } })) {
    throw new AppError(409, "A reboot is already scheduled for this device — change or cancel it");
  }
  let row: Row;
  try {
    row = await prisma.rebootSchedule.create({ data: { assetId: input.assetId, scheduledFor: input.scheduledFor, notifyEmails: recipients, createdBy: input.actor } });
  } catch (err: any) {
    if (err?.code === "P2002") throw new AppError(409, "A reboot is already scheduled for this device — change or cancel it");
    throw err;
  }
  await logEvent({
    action: "asset.reboot_scheduled", resourceType: "asset", resourceId: input.assetId, resourceName: await assetName(input.assetId), actor: input.actor, level: "info",
    message: `Reboot scheduled for ${input.scheduledFor.toISOString()} (signed by "${plan.authority}"); results to ${recipients.join(", ")}`,
    details: { scheduleId: row.id, scheduledFor: input.scheduledFor.toISOString(), notifyEmails: recipients, method: plan.method, authority: plan.authority, warnings },
  });
  return { ...summarize(row), warnings };
}

export async function updateRebootSchedule(input: { assetId: string; scheduleId: string; scheduledFor?: Date; notifyEmails?: string[]; actor: string; now?: Date }): Promise<RebootScheduleSummary> {
  const current = await getOwn(input.assetId, input.scheduleId);
  if (current.status !== "pending") throw new AppError(409, `This reboot is already ${current.status} and can no longer be changed`);
  const data: { scheduledFor?: Date; notifyEmails?: string[]; updatedBy: string } = { updatedBy: input.actor };
  if (input.scheduledFor) {
    assertSchedulableTime(input.scheduledFor, input.now);
    data.scheduledFor = input.scheduledFor;
  }
  if (input.notifyEmails) data.notifyEmails = normalizeRecipients(input.notifyEmails);
  const res = await prisma.rebootSchedule.updateMany({ where: { id: current.id, status: "pending" }, data });
  if (res.count === 0) throw new AppError(409, "This reboot has already started or been cancelled");
  const row = await getOwn(input.assetId, input.scheduleId);
  const changes: string[] = [];
  if (data.scheduledFor && data.scheduledFor.getTime() !== current.scheduledFor.getTime()) changes.push(`time ${current.scheduledFor.toISOString()} → ${data.scheduledFor.toISOString()}`);
  if (data.notifyEmails && data.notifyEmails.join(",") !== current.notifyEmails.join(",")) changes.push(`recipients ${data.notifyEmails.join(", ")}`);
  await logEvent({
    action: "asset.reboot_rescheduled", resourceType: "asset", resourceId: input.assetId, resourceName: await assetName(input.assetId), actor: input.actor, level: "info",
    message: `Scheduled reboot changed${changes.length ? `: ${changes.join("; ")}` : " (no differences)"}`,
    details: { scheduleId: row.id, before: { scheduledFor: current.scheduledFor.toISOString(), notifyEmails: current.notifyEmails }, after: { scheduledFor: row.scheduledFor.toISOString(), notifyEmails: row.notifyEmails } },
  });
  return summarize(row);
}

export async function cancelRebootSchedule(assetId: string, scheduleId: string, actor: string): Promise<RebootScheduleSummary> {
  const current = await getOwn(assetId, scheduleId);
  if (current.status !== "pending") throw new AppError(409, `This reboot is already ${current.status} and can no longer be cancelled`);
  const res = await prisma.rebootSchedule.updateMany({ where: { id: current.id, status: "pending" }, data: { status: "cancelled", cancelledBy: actor, cancelledAt: new Date() } });
  if (res.count === 0) throw new AppError(409, "This reboot has already started — it can no longer be cancelled");
  await logEvent({
    action: "asset.reboot_schedule_cancelled", resourceType: "asset", resourceId: assetId, resourceName: await assetName(assetId), actor, level: "info",
    message: `Scheduled reboot (${current.scheduledFor.toISOString()}) cancelled`,
    details: { scheduleId: current.id },
  });
  return summarize(await getOwn(assetId, scheduleId));
}

// ─── Firing ──────────────────────────────────────────────────────────────────

export interface DueRebootResult { started: number; refused: number; missed: number; waiting: number }

/** The job's tick: due bookings oldest first, one at a time. */
export async function runDueRebootSchedules(now: Date = new Date()): Promise<DueRebootResult> {
  const due = await prisma.rebootSchedule.findMany({
    where: { status: "pending", scheduledFor: { lte: now } },
    orderBy: { scheduledFor: "asc" },
    take: DUE_BATCH,
    select: { id: true, assetId: true, scheduledFor: true, createdBy: true, error: true },
  });
  const out: DueRebootResult = { started: 0, refused: 0, missed: 0, waiting: 0 };
  for (const s of due) {
    const lateMs = now.getTime() - s.scheduledFor.getTime();
    const waited = !!s.error;
    if (!waited && lateMs > LATE_GRACE_MS) {
      await settle(s.id, "missed", `Polaris was not running at the scheduled time and first saw this reboot ${Math.round(lateMs / 60_000)} min late; it was not started`, now);
      out.missed++;
      continue;
    }
    if (waited && lateMs > CONFLICT_WAIT_MS) {
      await settle(s.id, "refused", `${s.error} — still waiting ${Math.round(CONFLICT_WAIT_MS / 60_000)} min after the scheduled time, so it was not started`, now);
      out.refused++;
      continue;
    }
    const claimed = await prisma.rebootSchedule.updateMany({ where: { id: s.id, status: "pending" }, data: { status: "started", firedAt: now } });
    if (claimed.count === 0) continue;
    try {
      await startReboot({ assetId: s.assetId, actor: s.createdBy, scheduleId: s.id });
      await prisma.rebootSchedule.update({ where: { id: s.id }, data: { error: null } }).catch(() => undefined);
      out.started++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof RebootRunConflictError) {
        await prisma.rebootSchedule.update({ where: { id: s.id }, data: { status: "pending", firedAt: null, error: msg } }).catch(() => undefined);
        out.waiting++;
        continue;
      }
      await settle(s.id, "refused", msg, now);
      out.refused++;
    }
  }
  return out;
}

async function settle(scheduleId: string, status: "refused" | "missed", error: string, now: Date): Promise<void> {
  const row = await prisma.rebootSchedule.update({ where: { id: scheduleId }, data: { status, error, firedAt: now } });
  await logEvent({
    action: status === "missed" ? "asset.reboot_schedule_missed" : "asset.reboot_schedule_refused",
    resourceType: "asset", resourceId: row.assetId, resourceName: await assetName(row.assetId), actor: "system:reboot", level: "warning",
    message: `Scheduled reboot was not started: ${error}`,
    details: { scheduleId, scheduledFor: row.scheduledFor.toISOString(), error },
  });
  await sendResults(row, { outcome: status, method: null, authority: null, error, startedAt: null, finishedAt: null, log: [] });
}

/** Called by the runner when a booked run ends, and by the boot sweep for an orphan. Once per booking. */
export async function notifyScheduledRebootFinished(runId: string): Promise<void> {
  const s = await prisma.rebootSchedule.findUnique({ where: { runId } });
  if (!s || s.notifiedAt) return;
  const run = await prisma.rebootRun.findUnique({ where: { id: runId }, select: { status: true, error: true, method: true, authority: true, startedAt: true, finishedAt: true, log: true } });
  if (!run || ["queued", "sending", "rebooting"].includes(run.status)) return;
  const outcome: RebootResultOutcome = run.status === "succeeded" ? "succeeded" : run.status === "unverified" ? "unverified" : "failed";
  const log = Array.isArray(run.log) ? (run.log as Array<{ t: string; level: string; msg: string }>).slice(-LOG_TAIL) : [];
  await sendResults(s, { outcome, method: run.method, authority: run.authority, error: run.error, startedAt: run.startedAt, finishedAt: run.finishedAt, log });
}

interface Facts {
  outcome: RebootResultOutcome;
  method: string | null;
  authority: string | null;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  log: Array<{ t: string; level: string; msg: string }>;
}

const METHOD_LABEL: Record<string, string> = {
  "fortigate-rest": "FortiGate REST API",
  "fortigate-ssh": "FortiGate SSH CLI",
  "controller-switch": "through the controlling FortiGate (managed FortiSwitch restart)",
  "controller-ap": "through the controlling FortiGate (managed FortiAP restart)",
  "device-ssh": "the device's own SSH CLI",
  agent: "the Polaris Agent",
};

async function sendResults(s: Row, facts: Facts): Promise<void> {
  const claimed = await prisma.rebootSchedule.updateMany({ where: { id: s.id, notifiedAt: null }, data: { notifiedAt: new Date() } });
  if (claimed.count === 0) return;
  const asset = await prisma.asset.findUnique({ where: { id: s.assetId }, select: { hostname: true, ipAddress: true, model: true } });
  const deviceName = asset?.hostname || asset?.ipAddress || s.assetId;
  const channel = await resolveSummaryChannel(null, []);
  if (!channel) {
    await recordNotifyError(s, deviceName, "no enabled email channel (SMTP or Microsoft 365) is configured");
    return;
  }
  const users = await prisma.user.findMany({ where: { email: { in: s.notifyEmails, mode: "insensitive" } }, select: { email: true, timezone: true, detectedTimezone: true } });
  const zoneOf = new Map<string, string>();
  for (const u of users) if (u.email) zoneOf.set(u.email.toLowerCase(), resolveTimeZone(u.timezone, u.detectedTimezone));
  const failures: string[] = [];
  for (const address of s.notifyEmails) {
    try {
      const rendered = renderRebootResultEmail({
        outcome: facts.outcome, assetId: s.assetId, deviceName, model: asset?.model ?? null,
        method: facts.method ? METHOD_LABEL[facts.method] ?? facts.method : null, authority: facts.authority,
        error: facts.error, scheduledFor: s.scheduledFor, startedAt: facts.startedAt, finishedAt: facts.finishedAt,
        scheduledBy: s.createdBy, log: facts.log, zone: zoneOf.get(address) ?? serverTimeZone(),
      });
      const msg = await applyBrandLetterhead({ to: [address], subject: rendered.subject, text: rendered.text, html: rendered.html });
      await sendEmailThroughChannel({ type: channel.type, config: channel.config as Record<string, unknown> }, msg);
    } catch (err) {
      failures.push(`${address}: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    }
  }
  if (failures.length > 0) await recordNotifyError(s, deviceName, failures.join("; "));
  else logger.info({ scheduleId: s.id, recipients: s.notifyEmails.length, outcome: facts.outcome }, "scheduled reboot results emailed");
}

async function recordNotifyError(s: Row, deviceName: string, error: string): Promise<void> {
  await prisma.rebootSchedule.update({ where: { id: s.id }, data: { notifyError: error.slice(0, 2000) } }).catch(() => undefined);
  await logEvent({
    action: "asset.reboot_schedule_email_failed", resourceType: "asset", resourceId: s.assetId, resourceName: deviceName, actor: "system:reboot", level: "warning",
    message: `The results email for the scheduled reboot could not be sent: ${error}`,
    details: { scheduleId: s.id, notifyEmails: s.notifyEmails, error },
  });
}
