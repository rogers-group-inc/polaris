/**
 * src/services/firmwareScheduleService.ts — a firmware flash booked for later
 * (business rule 93), and the email that says how it went.
 *
 * A booking is made from the asset's Firmware card: the operator approves the
 * image BY NAME exactly as for a click-to-run flash (rule 87), picks a time
 * and names who hears the outcome. Making it takes the image gates and checks
 * a login is bound (`checkSchedulableUpgrade`); the device's live health and
 * topology are deliberately NOT taken then — a switch that is down at 3 pm may
 * be fine at 2 am — they are taken when it fires.
 *
 * Firing is the `startScheduledFirmwareUpgrades` job's (every minute, web role
 * — the role that holds the image on disk and runs the flash). A due booking
 * is CLAIMED (`pending` → `started`, one conditional update, so a second tick
 * cannot fire it twice) and handed to `startFirmwareUpgrade`, which re-takes
 * every gate. Then one of:
 *   started  — the run began; its outcome is emailed when it ends
 *              (`notifyScheduledRunFinished`, called by the runner).
 *   refused  — a gate said no (down, newer image now primary, login unbound…);
 *              nothing reaches the device and the refusal is emailed. Never
 *              retried: a booking is a decision about THIS flash at THIS time.
 *   pending  — a live run on the device, above / below it, or on its MCLAG
 *              peer (`FirmwareRunConflictError`). That clears on its own, so
 *              the booking waits and retries each tick, for up to
 *              CONFLICT_WAIT_MS past its time — a batch of devices booked for
 *              the same minute flashes one after another instead of all but
 *              one being refused.
 *   missed   — the job first saw it more than LATE_GRACE_MS after its time
 *              (Polaris was down). A flash hours outside the window the
 *              operator chose is not the flash they approved; emailed.
 *
 * The recipients hear it at every step (2026-11-09): when it is booked (and
 * when its time or image changes), when it starts (the job hands the booking's
 * recipients to the run — `firmwareEmailService.notifyRunStarted`), and when it
 * finishes, is refused or is missed. Email goes through
 * `firmwareEmailService.sendFirmwareEmail` — the install's oldest enabled email
 * channel, one message per recipient, each in that reader's zone when the
 * address is a Polaris user's, otherwise the server's. No channel = an Event
 * that says so; the booking still records what happened.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { checkSchedulableUpgrade, startFirmwareUpgrade, FirmwareRunConflictError } from "./firmwareUpgradeService.js";
import { firmwareEmailAsset, sendFirmwareEmail } from "./firmwareEmailService.js";
import { prepareNotify, targetFor, type NotifySpec, type NotifyTarget } from "./operationNotifyService.js";
import type { FirmwareResultOutcome } from "../utils/firmwareResultEmailTemplate.js";

/** How late a booking may start (the job ticks every minute; more = Polaris was down). */
export const LATE_GRACE_MS = 15 * 60_000;
/** How long past its time a booking waits for a related flash to finish. */
export const CONFLICT_WAIT_MS = 2 * 60 * 60_000;
/** The earliest a booking may be made for, from now. */
export const MIN_LEAD_MS = 60_000;
/** The furthest ahead a booking may be made. */
const MAX_LEAD_MS = 366 * 24 * 60 * 60_000;
export const MAX_RECIPIENTS = 20;
/** The cap on each list an automation's reboot action resolves (To, Cc, Bcc). */
export const AUTOMATION_MAX_RECIPIENTS = 200;
const DUE_BATCH = 50;
const LOG_TAIL = 15;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ScheduleSummary {
  id: string;
  assetId: string;
  imageId: string | null;
  toVersion: string;
  scheduledFor: Date;
  notifyEmails: string[];
  /** The picker's To / Cc / Bcc spec, when the booking was made with one (resolved at each send). */
  notifyRecipients: unknown;
  /** The email channels it goes out on; empty = the oldest enabled one. */
  notifyChannelIds: string[];
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

type ScheduleRow = ScheduleSummary;

function summarize(r: ScheduleRow): ScheduleSummary {
  return {
    id: r.id, assetId: r.assetId, imageId: r.imageId, toVersion: r.toVersion, scheduledFor: r.scheduledFor,
    notifyEmails: r.notifyEmails, notifyRecipients: r.notifyRecipients ?? null, notifyChannelIds: r.notifyChannelIds ?? [], status: r.status, runId: r.runId, error: r.error, createdBy: r.createdBy,
    createdAt: r.createdAt, updatedBy: r.updatedBy, updatedAt: r.updatedAt, cancelledBy: r.cancelledBy,
    cancelledAt: r.cancelledAt, firedAt: r.firedAt, notifiedAt: r.notifiedAt, notifyError: r.notifyError,
  };
}

/**
 * Lower-cased, trimmed, de-duplicated, each a plausible address. Pure.
 * Throws 400 naming the first bad address, or when the list is empty or long.
 * `allowEmpty` is for a Cc/Bcc list; `max` widens the cap for a list an
 * automation RESOLVED (a region's users), which nobody typed one by one.
 */
export function normalizeRecipients(list: readonly string[], opts: { max?: number; allowEmpty?: boolean } = {}): string[] {
  const max = opts.max ?? MAX_RECIPIENTS;
  const out: string[] = [];
  for (const raw of list) {
    const e = String(raw ?? "").trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e) || e.length > 254) throw new AppError(400, `"${raw}" is not an email address`);
    if (!out.includes(e)) out.push(e);
  }
  if (out.length === 0 && !opts.allowEmpty) throw new AppError(400, "Name at least one email address to send the results to");
  if (out.length > max) throw new AppError(400, `At most ${max} recipients`);
  return out;
}

/** The booked time must be in the future (by a minute) and within a year. Pure. */
export function assertSchedulableTime(when: Date, now: Date = new Date()): void {
  if (Number.isNaN(when.getTime())) throw new AppError(400, "scheduledFor is not a valid date and time");
  if (when.getTime() < now.getTime() + MIN_LEAD_MS) throw new AppError(400, "Pick a time at least a minute from now");
  if (when.getTime() > now.getTime() + MAX_LEAD_MS) throw new AppError(400, "Pick a time within the next year");
}

async function assetName(assetId: string): Promise<{ label: string | undefined; hostname: string | null; ipAddress: string | null; model: string | null }> {
  const a = await prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true, ipAddress: true, model: true } });
  return { label: a?.hostname || a?.ipAddress || undefined, hostname: a?.hostname ?? null, ipAddress: a?.ipAddress ?? null, model: a?.model ?? null };
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function getPendingSchedule(assetId: string): Promise<ScheduleSummary | null> {
  const r = await prisma.firmwareUpgradeSchedule.findFirst({ where: { assetId, status: "pending" } });
  return r ? summarize(r) : null;
}

export async function listSchedulesForAsset(assetId: string, limit = 20): Promise<ScheduleSummary[]> {
  const rows = await prisma.firmwareUpgradeSchedule.findMany({ where: { assetId }, orderBy: { createdAt: "desc" }, take: Math.min(Math.max(limit, 1), 100) });
  return rows.map(summarize);
}

async function getOwnSchedule(assetId: string, scheduleId: string): Promise<ScheduleRow> {
  const r = await prisma.firmwareUpgradeSchedule.findUnique({ where: { id: scheduleId } });
  if (!r || r.assetId !== assetId) throw new AppError(404, "Scheduled upgrade not found");
  return r;
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Rule 122: a device in a pending or running group upgrade is flashed by the
 * group — a single-device booking beside it would race the group's ordering
 * (and booking the group cancelled any such booking in the first place).
 */
async function assertNotInGroup(assetId: string): Promise<void> {
  const m = await prisma.firmwareGroupMember.findFirst({
    where: { assetId, state: { in: ["planned", "waiting", "running"] }, group: { status: { in: ["pending", "running"] } } },
    select: { group: { select: { scheduledFor: true, status: true } } },
  });
  if (m) {
    throw new AppError(409, `This device is in a group firmware upgrade ${m.group.status === "running" ? "that is running now" : `scheduled for ${m.group.scheduledFor.toISOString()}`} — change or cancel the group instead`);
  }
}

export interface CreateScheduleInput {
  assetId: string;
  imageId: string;
  scheduledFor: Date;
  /** Plain addresses — the API's original shape. Ignored when `notify` is given. */
  notifyEmails?: string[];
  /** The dialog's picker spec + email channels (operationNotifyService). */
  notify?: NotifySpec;
  actor: string;
  now?: Date;
}

/** What a booking stores for its recipients, from either input shape. */
async function recipientsFrom(assetId: string, notify: NotifySpec | undefined, emails: string[] | undefined): Promise<{ notifyEmails: string[]; notifyRecipients?: object; notifyChannelIds?: string[] }> {
  if (notify) {
    const p = await prepareNotify(assetId, notify);
    return { notifyEmails: p.notifyEmails, notifyRecipients: p.notifyRecipients, notifyChannelIds: p.notifyChannelIds };
  }
  return { notifyEmails: normalizeRecipients(emails ?? []) };
}

export async function createSchedule(input: CreateScheduleInput): Promise<ScheduleSummary & { warnings: string[] }> {
  assertSchedulableTime(input.scheduledFor, input.now);
  const who = await recipientsFrom(input.assetId, input.notify, input.notifyEmails);
  const recipients = who.notifyEmails;
  await assertNotInGroup(input.assetId);
  const { approved, fromVersion, warnings } = await checkSchedulableUpgrade(input.assetId, input.imageId);
  if (await prisma.firmwareUpgradeSchedule.findFirst({ where: { assetId: input.assetId, status: "pending" }, select: { id: true } })) {
    throw new AppError(409, "An upgrade is already scheduled for this device — change or cancel it");
  }
  let row: ScheduleRow;
  try {
    row = await prisma.firmwareUpgradeSchedule.create({
      data: {
        assetId: input.assetId,
        imageId: approved.id,
        toVersion: approved.versionLabel,
        scheduledFor: input.scheduledFor,
        notifyEmails: recipients,
        ...(who.notifyRecipients ? { notifyRecipients: who.notifyRecipients } : {}),
        notifyChannelIds: who.notifyChannelIds ?? [],
        createdBy: input.actor,
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") throw new AppError(409, "An upgrade is already scheduled for this device — change or cancel it");
    throw err;
  }
  const name = await assetName(input.assetId);
  await logEvent({
    action: "firmware.upgrade_scheduled",
    resourceType: "asset",
    resourceId: input.assetId,
    resourceName: name.label,
    actor: input.actor,
    level: "info",
    message: `Firmware upgrade scheduled for ${input.scheduledFor.toISOString()}: ${fromVersion ?? "unknown"} → ${approved.versionLabel} (${approved.role} image); results to ${recipients.join(", ")}`,
    details: { scheduleId: row.id, imageId: approved.id, toVersion: approved.versionLabel, scheduledFor: input.scheduledFor.toISOString(), notifyEmails: recipients, notifyRecipients: who.notifyRecipients ?? null, notifyChannelIds: who.notifyChannelIds ?? [], warnings },
  });
  // Off the request path: an SMTP round trip per recipient is not the booker's wait.
  void notifyBooking(row, "scheduled", null, warnings, fromVersion);
  return { ...summarize(row), warnings };
}

/**
 * The booking notice: "scheduled" when it is made (or to an address added to
 * it later), "rescheduled" when its time or image changes. Never throws — a
 * failure is a warning Event, and the booking stands.
 */
async function notifyBooking(
  s: Pick<ScheduleRow, "id" | "assetId" | "toVersion" | "scheduledFor" | "createdBy" | "notifyEmails" | "notifyRecipients" | "notifyChannelIds">,
  notice: "scheduled" | "rescheduled",
  /** Only these To addresses (an address added to the booking) — null = everyone on it. */
  onlyTo: readonly string[] | null,
  warnings: readonly string[] = [],
  fromVersion: string | null = null,
): Promise<void> {
  if (onlyTo && onlyTo.length === 0) return;
  try {
    const full = await targetFor(s);
    const target: NotifyTarget = onlyTo ? { to: [...onlyTo], cc: [], bcc: [], channelIds: full.channelIds } : full;
    const recipients = [...target.to, ...target.cc, ...target.bcc];
    const asset = await firmwareEmailAsset(s.assetId);
    const error = await sendFirmwareEmail(target, {
      outcome: notice,
      scheduled: true,
      assetId: s.assetId,
      deviceName: asset.deviceName,
      model: asset.model,
      fromVersion: fromVersion ?? asset.osVersion,
      toVersion: s.toVersion,
      verifiedVersion: null,
      result: null,
      error: null,
      scheduledFor: s.scheduledFor,
      startedAt: null,
      finishedAt: null,
      scheduledBy: s.createdBy,
      warnings: [...warnings],
      log: [],
    });
    if (error) await recordNoticeError(s, asset.deviceName, notice, recipients, error);
  } catch (err) {
    logger.warn({ err, scheduleId: s.id, notice }, "firmware schedule: the booking email could not be sent");
  }
}

export interface UpdateScheduleInput {
  assetId: string;
  scheduleId: string;
  scheduledFor?: Date;
  notifyEmails?: string[];
  /** The dialog's picker spec + email channels; replaces `notifyEmails` when given. */
  notify?: NotifySpec;
  imageId?: string;
  actor: string;
  now?: Date;
}

export async function updateSchedule(input: UpdateScheduleInput): Promise<ScheduleSummary & { warnings: string[] }> {
  const current = await getOwnSchedule(input.assetId, input.scheduleId);
  if (current.status !== "pending") throw new AppError(409, `This upgrade is already ${current.status} and can no longer be changed`);
  await assertNotInGroup(input.assetId);
  const data: { scheduledFor?: Date; notifyEmails?: string[]; notifyRecipients?: object; notifyChannelIds?: string[]; imageId?: string; toVersion?: string; updatedBy: string } = { updatedBy: input.actor };
  let warnings: string[] = [];
  if (input.scheduledFor) {
    assertSchedulableTime(input.scheduledFor, input.now);
    data.scheduledFor = input.scheduledFor;
  }
  if (input.notify || input.notifyEmails) Object.assign(data, await recipientsFrom(input.assetId, input.notify, input.notifyEmails));
  if (input.imageId && input.imageId !== current.imageId) {
    const checked = await checkSchedulableUpgrade(input.assetId, input.imageId);
    data.imageId = checked.approved.id;
    data.toVersion = checked.approved.versionLabel;
    warnings = checked.warnings;
  }
  // Conditional on still pending: the job may have claimed it since the read.
  const res = await prisma.firmwareUpgradeSchedule.updateMany({ where: { id: current.id, status: "pending" }, data });
  if (res.count === 0) throw new AppError(409, "This upgrade has already started or been cancelled");
  const row = await getOwnSchedule(input.assetId, input.scheduleId);
  const changes: string[] = [];
  if (data.scheduledFor && data.scheduledFor.getTime() !== current.scheduledFor.getTime()) changes.push(`time ${current.scheduledFor.toISOString()} → ${data.scheduledFor.toISOString()}`);
  if (data.toVersion && data.toVersion !== current.toVersion) changes.push(`image ${current.toVersion} → ${data.toVersion}`);
  if (data.notifyEmails && data.notifyEmails.join(",") !== current.notifyEmails.join(",")) changes.push(`recipients ${data.notifyEmails.join(", ")}`);
  if (data.notifyChannelIds && data.notifyChannelIds.join(",") !== current.notifyChannelIds.join(",")) changes.push("email channels");
  const name = await assetName(input.assetId);
  await logEvent({
    action: "firmware.upgrade_rescheduled",
    resourceType: "asset",
    resourceId: input.assetId,
    resourceName: name.label,
    actor: input.actor,
    level: "info",
    message: `Scheduled firmware upgrade to ${row.toVersion} changed${changes.length ? `: ${changes.join("; ")}` : " (no differences)"}`,
    details: { scheduleId: row.id, before: { scheduledFor: current.scheduledFor.toISOString(), toVersion: current.toVersion, notifyEmails: current.notifyEmails }, after: { scheduledFor: row.scheduledFor.toISOString(), toVersion: row.toVersion, notifyEmails: row.notifyEmails } },
  });
  // A new time or image is news to everyone on it; a new address alone hears
  // only that it is booked.
  const moved = row.scheduledFor.getTime() !== current.scheduledFor.getTime() || row.toVersion !== current.toVersion;
  if (moved) void notifyBooking(row, "rescheduled", null, warnings);
  else void notifyBooking(row, "scheduled", row.notifyEmails.filter((e) => !current.notifyEmails.includes(e)), warnings);
  return { ...summarize(row), warnings };
}

export async function cancelSchedule(assetId: string, scheduleId: string, actor: string): Promise<ScheduleSummary> {
  const current = await getOwnSchedule(assetId, scheduleId);
  if (current.status !== "pending") throw new AppError(409, `This upgrade is already ${current.status} and can no longer be cancelled`);
  const res = await prisma.firmwareUpgradeSchedule.updateMany({
    where: { id: current.id, status: "pending" },
    data: { status: "cancelled", cancelledBy: actor, cancelledAt: new Date() },
  });
  if (res.count === 0) throw new AppError(409, "This upgrade has already started — it can no longer be cancelled");
  const name = await assetName(assetId);
  await logEvent({
    action: "firmware.upgrade_schedule_cancelled",
    resourceType: "asset",
    resourceId: assetId,
    resourceName: name.label,
    actor,
    level: "info",
    message: `Scheduled firmware upgrade to ${current.toVersion} (${current.scheduledFor.toISOString()}) cancelled`,
    details: { scheduleId: current.id },
  });
  return summarize(await getOwnSchedule(assetId, scheduleId));
}

// ─── Firing ───────────────────────────────────────────────────────────────────

export interface DueRunResult {
  started: number;
  refused: number;
  missed: number;
  waiting: number;
}

/**
 * The job's tick. Due bookings oldest first, one at a time — each start is a
 * handful of point queries and then hands off to `setImmediate`, so a batch of
 * fifty is seconds, and sequential is what lets the topology gate see the run
 * the previous booking just started.
 */
export async function runDueSchedules(now: Date = new Date()): Promise<DueRunResult> {
  const due = await prisma.firmwareUpgradeSchedule.findMany({
    where: { status: "pending", scheduledFor: { lte: now } },
    orderBy: { scheduledFor: "asc" },
    take: DUE_BATCH,
    select: { id: true, assetId: true, imageId: true, toVersion: true, scheduledFor: true, createdBy: true, error: true, notifyEmails: true, notifyRecipients: true, notifyChannelIds: true },
  });
  const out: DueRunResult = { started: 0, refused: 0, missed: 0, waiting: 0 };
  for (const s of due) {
    const lateMs = now.getTime() - s.scheduledFor.getTime();
    // A booking that was waiting on a related flash keeps waiting past the
    // grace (its `error` says what it waits for); one first seen this late
    // means Polaris was not running at its time.
    const waited = !!s.error;
    if (!waited && lateMs > LATE_GRACE_MS) {
      await settle(s.id, "missed", `Polaris was not running at the scheduled time and first saw this upgrade ${Math.round(lateMs / 60_000)} min late; it was not started`, now);
      out.missed++;
      continue;
    }
    if (waited && lateMs > CONFLICT_WAIT_MS) {
      await settle(s.id, "refused", `${s.error} — still waiting ${Math.round(CONFLICT_WAIT_MS / 60_000)} min after the scheduled time, so it was not started`, now);
      out.refused++;
      continue;
    }
    // Claim. A second tick, or a cancel racing this one, finds it not pending.
    const claimed = await prisma.firmwareUpgradeSchedule.updateMany({ where: { id: s.id, status: "pending" }, data: { status: "started", firedAt: now } });
    if (claimed.count === 0) continue;
    try {
      if (!s.imageId) throw new AppError(409, `The approved image (${s.toVersion}) was deleted from the Repository`);
      // The booking's recipients ride on the run: it emails them "started".
      await startFirmwareUpgrade({ assetId: s.assetId, imageId: s.imageId, actor: s.createdBy, scheduleId: s.id, notifyEmails: s.notifyEmails, notifyRecipients: (s.notifyRecipients as object | null) ?? null, notifyChannelIds: s.notifyChannelIds });
      await prisma.firmwareUpgradeSchedule.update({ where: { id: s.id }, data: { error: null } }).catch(() => undefined);
      out.started++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof FirmwareRunConflictError) {
        // Put it back; it retries next tick until CONFLICT_WAIT_MS.
        await prisma.firmwareUpgradeSchedule.update({ where: { id: s.id }, data: { status: "pending", firedAt: null, error: msg } }).catch(() => undefined);
        out.waiting++;
        continue;
      }
      await settle(s.id, "refused", msg, now);
      out.refused++;
    }
  }
  return out;
}

/** A booking that ends without a run: record it, write the Event, email it. */
async function settle(scheduleId: string, status: "refused" | "missed", error: string, now: Date): Promise<void> {
  const row = await prisma.firmwareUpgradeSchedule.update({ where: { id: scheduleId }, data: { status, error, firedAt: now } });
  const name = await assetName(row.assetId);
  await logEvent({
    action: status === "missed" ? "firmware.upgrade_schedule_missed" : "firmware.upgrade_schedule_refused",
    resourceType: "asset",
    resourceId: row.assetId,
    resourceName: name.label,
    actor: "system:firmware",
    level: "warning",
    message: `Scheduled firmware upgrade to ${row.toVersion} was not started: ${error}`,
    details: { scheduleId, scheduledFor: row.scheduledFor.toISOString(), error },
  });
  await sendResults(row, {
    outcome: status,
    fromVersion: null,
    verifiedVersion: null,
    result: null,
    error,
    startedAt: null,
    finishedAt: null,
    log: [],
  });
}

/**
 * Called by the runner when a booked run reaches a terminal state, and by the
 * boot sweep for one a restart orphaned. Once per booking: `notifiedAt` is
 * claimed before sending, so a second caller finds it taken.
 */
export async function notifyScheduledRunFinished(runId: string): Promise<void> {
  const s = await prisma.firmwareUpgradeSchedule.findUnique({ where: { runId } });
  if (!s || s.notifiedAt) return;
  const run = await prisma.firmwareUpgradeRun.findUnique({
    where: { id: runId },
    select: { status: true, result: true, error: true, fromVersion: true, toVersion: true, verifiedVersion: true, startedAt: true, finishedAt: true, log: true },
  });
  if (!run || run.status === "queued" || run.status === "running") return;
  const outcome: FirmwareResultOutcome = run.status === "succeeded" ? "succeeded" : run.status === "unverified" ? "unverified" : "failed";
  const log = Array.isArray(run.log) ? (run.log as Array<{ t: string; level: string; msg: string }>).slice(-LOG_TAIL) : [];
  await sendResults({ ...s, toVersion: run.toVersion }, {
    outcome,
    fromVersion: run.fromVersion,
    verifiedVersion: run.verifiedVersion,
    result: run.result,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    log,
  });
}

interface ResultFacts {
  outcome: FirmwareResultOutcome;
  fromVersion: string | null;
  verifiedVersion: string | null;
  result: string | null;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  log: Array<{ t: string; level: string; msg: string }>;
}

async function sendResults(s: ScheduleRow, facts: ResultFacts): Promise<void> {
  const claimed = await prisma.firmwareUpgradeSchedule.updateMany({ where: { id: s.id, notifiedAt: null }, data: { notifiedAt: new Date() } });
  if (claimed.count === 0) return;

  const asset = await firmwareEmailAsset(s.assetId);
  const deviceName = asset.deviceName;
  const error = await sendFirmwareEmail(await targetFor(s), {
    outcome: facts.outcome,
    scheduled: true,
    assetId: s.assetId,
    deviceName,
    model: asset.model,
    fromVersion: facts.fromVersion ?? asset.osVersion,
    toVersion: s.toVersion,
    verifiedVersion: facts.verifiedVersion,
    result: facts.result,
    error: facts.error,
    scheduledFor: s.scheduledFor,
    startedAt: facts.startedAt,
    finishedAt: facts.finishedAt,
    scheduledBy: s.createdBy,
    log: facts.log,
  });
  if (error) {
    await recordNotifyError(s, deviceName, error);
  } else {
    logger.info({ scheduleId: s.id, recipients: s.notifyEmails.length, outcome: facts.outcome }, "scheduled firmware upgrade results emailed");
  }
}

async function recordNotifyError(s: ScheduleRow, deviceName: string, error: string): Promise<void> {
  await prisma.firmwareUpgradeSchedule.update({ where: { id: s.id }, data: { notifyError: error.slice(0, 2000) } }).catch(() => undefined);
  await logEvent({
    action: "firmware.upgrade_schedule_email_failed",
    resourceType: "asset",
    resourceId: s.assetId,
    resourceName: deviceName,
    actor: "system:firmware",
    level: "warning",
    message: `The results email for the scheduled firmware upgrade to ${s.toVersion} could not be sent: ${error}`,
    details: { scheduleId: s.id, notifyEmails: s.notifyEmails, error },
  });
}

/** A booking notice that could not be sent: an Event only — `notifyError` is the results email's. */
async function recordNoticeError(s: Pick<ScheduleRow, "id" | "assetId" | "toVersion">, deviceName: string, notice: string, recipients: readonly string[], error: string): Promise<void> {
  await logEvent({
    action: "firmware.upgrade_schedule_email_failed",
    resourceType: "asset",
    resourceId: s.assetId,
    resourceName: deviceName,
    actor: "system:firmware",
    level: "warning",
    message: `The "${notice}" email for the scheduled firmware upgrade to ${s.toVersion} could not be sent: ${error}`,
    details: { scheduleId: s.id, notice, notifyEmails: recipients, error },
  });
}
