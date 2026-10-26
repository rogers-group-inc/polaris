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
 * email channel, one message per recipient in that reader's zone — or, when an
 * automation's booking carries a Cc or Bcc, one message to the whole To line
 * in the install's zone.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { checkSchedulableReboot, startReboot, RebootRunConflictError, recordRebootCredentialUse } from "./rebootService.js";
import { resolveRebootNote } from "./rebootSettingsService.js";
import { normalizeRecipients, assertSchedulableTime, LATE_GRACE_MS, CONFLICT_WAIT_MS, MIN_LEAD_MS, MAX_RECIPIENTS, AUTOMATION_MAX_RECIPIENTS } from "./firmwareScheduleService.js";
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
  /** Cc / Bcc of the results email — set only by an automation's booking. */
  notifyCc: string[];
  notifyBcc: string[];
  /** Why (rule 115(d)); carried onto the run when the booking fires. */
  note: string | null;
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
    id: r.id, assetId: r.assetId, scheduledFor: r.scheduledFor, notifyEmails: r.notifyEmails, notifyCc: r.notifyCc, notifyBcc: r.notifyBcc, note: r.note, status: r.status, runId: r.runId,
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

export async function createRebootSchedule(input: {
  assetId: string; scheduledFor: Date; notifyEmails: string[]; actor: string; now?: Date; context?: Record<string, unknown>;
  /** Why (rule 115(d)); refused blank while the install requires a note. */
  note?: string | null;
  /** Cc / Bcc of the results email; an automation's booking only. */
  notifyCc?: string[]; notifyBcc?: string[];
  /** Widens each list's cap — an automation's lists are resolved, not typed. */
  maxRecipients?: number;
}): Promise<RebootScheduleSummary & { warnings: string[] }> {
  assertSchedulableTime(input.scheduledFor, input.now);
  const max = input.maxRecipients ?? MAX_RECIPIENTS;
  const recipients = normalizeRecipients(input.notifyEmails, { max });
  const cc = normalizeRecipients(input.notifyCc ?? [], { max, allowEmpty: true });
  const bcc = normalizeRecipients(input.notifyBcc ?? [], { max, allowEmpty: true });
  const note = await resolveRebootNote(input.note);
  const { plan, warnings } = await checkSchedulableReboot(input.assetId);
  if (await prisma.rebootSchedule.findFirst({ where: { assetId: input.assetId, status: "pending" }, select: { id: true } })) {
    throw new AppError(409, "A reboot is already scheduled for this device — change or cancel it");
  }
  let row: Row;
  try {
    row = await prisma.rebootSchedule.create({ data: { assetId: input.assetId, scheduledFor: input.scheduledFor, notifyEmails: recipients, notifyCc: cc, notifyBcc: bcc, note, createdBy: input.actor } });
  } catch (err: any) {
    if (err?.code === "P2002") throw new AppError(409, "A reboot is already scheduled for this device — change or cancel it");
    throw err;
  }
  await logEvent({
    action: "asset.reboot_scheduled", resourceType: "asset", resourceId: input.assetId, resourceName: await assetName(input.assetId), actor: input.actor, level: "info",
    message: `Reboot scheduled for ${input.scheduledFor.toISOString()} (signed by "${plan.authority}"); results to ${recipients.join(", ")}` +
      (cc.length ? `, cc ${cc.join(", ")}` : "") + (bcc.length ? `, bcc ${bcc.join(", ")}` : "") + (note ? ` — reason: ${note}` : ""),
    details: {
      scheduleId: row.id, scheduledFor: input.scheduledFor.toISOString(), notifyEmails: recipients, note,
      ...(cc.length ? { notifyCc: cc } : {}), ...(bcc.length ? { notifyBcc: bcc } : {}),
      method: plan.method, authority: plan.authority, warnings, ...(input.context ?? {}),
    },
  });
  return { ...summarize(row), warnings };
}

export async function updateRebootSchedule(input: {
  assetId: string; scheduleId: string; scheduledFor?: Date; notifyEmails?: string[];
  /** Absent = keep the booking's note; present is judged like a new booking's (rule 115(d)). */
  note?: string | null;
  actor: string; now?: Date;
}): Promise<RebootScheduleSummary> {
  const current = await getOwn(input.assetId, input.scheduleId);
  if (current.status !== "pending") throw new AppError(409, `This reboot is already ${current.status} and can no longer be changed`);
  const data: { scheduledFor?: Date; notifyEmails?: string[]; note?: string | null; updatedBy: string } = { updatedBy: input.actor };
  if (input.note !== undefined) data.note = await resolveRebootNote(input.note);
  if (input.scheduledFor) {
    assertSchedulableTime(input.scheduledFor, input.now);
    data.scheduledFor = input.scheduledFor;
  }
  // An automation's booking may hold a resolved list longer than a person may
  // type; editing it must not be refused for a length the operator inherited.
  if (input.notifyEmails) data.notifyEmails = normalizeRecipients(input.notifyEmails, { max: Math.max(MAX_RECIPIENTS, current.notifyEmails.length) });
  const res = await prisma.rebootSchedule.updateMany({ where: { id: current.id, status: "pending" }, data });
  if (res.count === 0) throw new AppError(409, "This reboot has already started or been cancelled");
  const row = await getOwn(input.assetId, input.scheduleId);
  const changes: string[] = [];
  if (data.scheduledFor && data.scheduledFor.getTime() !== current.scheduledFor.getTime()) changes.push(`time ${current.scheduledFor.toISOString()} → ${data.scheduledFor.toISOString()}`);
  if (data.notifyEmails && data.notifyEmails.join(",") !== current.notifyEmails.join(",")) changes.push(`recipients ${data.notifyEmails.join(", ")}`);
  if (data.note !== undefined && data.note !== current.note) changes.push(data.note ? `reason "${data.note}"` : "reason removed");
  await logEvent({
    action: "asset.reboot_rescheduled", resourceType: "asset", resourceId: input.assetId, resourceName: await assetName(input.assetId), actor: input.actor, level: "info",
    message: `Scheduled reboot changed${changes.length ? `: ${changes.join("; ")}` : " (no differences)"}`,
    details: { scheduleId: row.id, before: { scheduledFor: current.scheduledFor.toISOString(), notifyEmails: current.notifyEmails, note: current.note }, after: { scheduledFor: row.scheduledFor.toISOString(), notifyEmails: row.notifyEmails, note: row.note } },
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

// ─── Booked by an automation (business rule 115(c)) ──────────────────────────

export interface AutomationRebootInput {
  assetId: string;
  when: "now" | "at";
  /** HH:MM, the server's local time; used when `when` is "at". */
  at: string;
  /** The action's To / Cc / Bcc, already resolved to addresses at fire time. */
  notifyEmails: string[];
  notifyCc?: string[];
  notifyBcc?: string[];
  minGapHours: number;
  ruleId: string | null;
  ruleName: string | null;
  notificationId: string;
  now?: Date;
}

export type AutomationRebootResult =
  | { booked: true; scheduleId: string; scheduledFor: Date }
  | { booked: false; reason: string };

/**
 * When an `at` booking fires: the next HH:MM on the server's clock that is at
 * least MIN_LEAD_MS away. Calendar-day stepping (setDate), never +24 h, so a
 * DST change night still lands on the wall-clock time asked for.
 */
export function nextAutomationRebootTime(when: "now" | "at", at: string, now: Date): Date {
  if (when === "now") return new Date(now.getTime() + MIN_LEAD_MS + 30_000);
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (!m) throw new AppError(400, `"${at}" is not a time of day (HH:MM)`);
  const d = new Date(now.getTime());
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() < now.getTime() + MIN_LEAD_MS) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * The reboot action's one entry point. Books — never sends — so every gate a
 * booking takes applies, and is judged again when it fires. Two skips, each an
 * info Event rather than a failure, because both mean the reboot is already
 * handled: a booking is already pending for the device (one per asset), or it
 * rebooted — on purpose or not — within `minGapHours`. The gap is what keeps a
 * leak that refills memory after every boot from rebooting the device in a
 * loop. A gate that refuses (no opt-in, an HA FortiGate, an asset Polaris
 * cannot reboot) throws, and the caller records the failed action.
 */
export async function bookRebootFromAutomation(input: AutomationRebootInput): Promise<AutomationRebootResult> {
  const now = input.now ?? new Date();
  const actor = `automation:${input.ruleName ?? input.ruleId ?? "unknown"}`;
  const ctx = { automation: true, ruleId: input.ruleId, ruleName: input.ruleName, notificationId: input.notificationId };
  const skip = async (reason: string): Promise<AutomationRebootResult> => {
    await logEvent({
      action: "asset.reboot_automation_skipped", resourceType: "asset", resourceId: input.assetId, resourceName: await assetName(input.assetId), actor, level: "info",
      message: `Automation "${input.ruleName ?? input.ruleId ?? "?"}" did not book a reboot: ${reason}`,
      details: { ...ctx, reason },
    });
    return { booked: false, reason };
  };

  const pending = await prisma.rebootSchedule.findFirst({ where: { assetId: input.assetId, status: "pending" }, select: { scheduledFor: true } });
  if (pending) return skip(`a reboot is already booked for ${pending.scheduledFor.toISOString()}`);

  const since = new Date(now.getTime() - input.minGapHours * 3_600_000);
  const [recentRun, asset] = await Promise.all([
    prisma.rebootRun.findFirst({ where: { assetId: input.assetId, startedAt: { gte: since }, status: { not: "failed" } }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }),
    prisma.asset.findUnique({ where: { id: input.assetId }, select: { lastRebootAt: true } }),
  ]);
  const last = [recentRun?.startedAt, asset?.lastRebootAt].filter((d): d is Date => !!d && d >= since).sort((a, b) => b.getTime() - a.getTime())[0];
  if (last) return skip(`the device rebooted at ${last.toISOString()}, within the ${input.minGapHours} h minimum gap`);

  const scheduledFor = nextAutomationRebootTime(input.when, input.at, now);
  let booked: RebootScheduleSummary;
  try {
    booked = await createRebootSchedule({
      assetId: input.assetId, scheduledFor, notifyEmails: input.notifyEmails, notifyCc: input.notifyCc, notifyBcc: input.notifyBcc,
      maxRecipients: AUTOMATION_MAX_RECIPIENTS, actor, now, context: ctx,
      // Rule 115(d): an automation always says why — its own name — so a
      // required note never fails the action.
      note: `Automation "${input.ruleName ?? input.ruleId ?? "unknown"}"`,
    });
  } catch (err) {
    // Lost a race with another booking: the reboot is handled.
    if (err instanceof AppError && err.httpStatus === 409 && /already scheduled/.test(err.message)) return skip("a reboot is already booked for this device");
    throw err;
  }
  // Rule 112: the booking signs with a stored credential nobody typed in —
  // say whose, on the automation's name.
  await recordRebootCredentialUse(input.assetId, { username: null, actor, mayUseAny: false });
  return { booked: true, scheduleId: booked.id, scheduledFor };
}

// ─── Firing ──────────────────────────────────────────────────────────────────

export interface DueRebootResult { started: number; refused: number; missed: number; waiting: number }

/** The job's tick: due bookings oldest first, one at a time. */
export async function runDueRebootSchedules(now: Date = new Date()): Promise<DueRebootResult> {
  const due = await prisma.rebootSchedule.findMany({
    where: { status: "pending", scheduledFor: { lte: now } },
    orderBy: { scheduledFor: "asc" },
    take: DUE_BATCH,
    select: { id: true, assetId: true, scheduledFor: true, createdBy: true, error: true, note: true },
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
      await startReboot({ assetId: s.assetId, actor: s.createdBy, scheduleId: s.id, note: s.note });
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
  const render = (zone: string) => renderRebootResultEmail({
    outcome: facts.outcome, assetId: s.assetId, deviceName, model: asset?.model ?? null,
    method: facts.method ? METHOD_LABEL[facts.method] ?? facts.method : null, authority: facts.authority,
    error: facts.error, scheduledFor: s.scheduledFor, startedAt: facts.startedAt, finishedAt: facts.finishedAt,
    scheduledBy: s.createdBy, note: s.note, log: facts.log, zone,
  });
  const failures: string[] = [];
  const cc = s.notifyCc ?? [];
  const bcc = s.notifyBcc ?? [];
  if (cc.length || bcc.length) {
    // Cc / Bcc mean ONE message with the whole To line visible — the notify
    // action's contract for the same fields — so it is written in the
    // install's own zone rather than any one reader's (business rule 25).
    try {
      const rendered = render(serverTimeZone());
      const msg = await applyBrandLetterhead({ to: s.notifyEmails, cc, bcc, subject: rendered.subject, text: rendered.text, html: rendered.html });
      await sendEmailThroughChannel({ type: channel.type, config: channel.config as Record<string, unknown> }, msg);
    } catch (err) {
      failures.push(String((err as Error)?.message ?? err).slice(0, 200));
    }
  } else {
    for (const address of s.notifyEmails) {
      try {
        const rendered = render(zoneOf.get(address) ?? serverTimeZone());
        const msg = await applyBrandLetterhead({ to: [address], subject: rendered.subject, text: rendered.text, html: rendered.html });
        await sendEmailThroughChannel({ type: channel.type, config: channel.config as Record<string, unknown> }, msg);
      } catch (err) {
        failures.push(`${address}: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      }
    }
  }
  if (failures.length > 0) await recordNotifyError(s, deviceName, failures.join("; "));
  else logger.info({ scheduleId: s.id, recipients: s.notifyEmails.length + cc.length + bcc.length, outcome: facts.outcome }, "scheduled reboot results emailed");
}

async function recordNotifyError(s: Row, deviceName: string, error: string): Promise<void> {
  await prisma.rebootSchedule.update({ where: { id: s.id }, data: { notifyError: error.slice(0, 2000) } }).catch(() => undefined);
  await logEvent({
    action: "asset.reboot_schedule_email_failed", resourceType: "asset", resourceId: s.assetId, resourceName: deviceName, actor: "system:reboot", level: "warning",
    message: `The results email for the scheduled reboot could not be sent: ${error}`,
    details: { scheduleId: s.id, notifyEmails: s.notifyEmails, error },
  });
}
