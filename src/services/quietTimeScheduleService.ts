/**
 * src/services/quietTimeScheduleService.ts
 *
 * CRUD for the GLOBAL quiet-time schedules (business rule 92) — the rows
 * behind Automations → Settings → Global Quiet Times. A schedule names which
 * devices (an automation-style scope), which severities and which alert
 * kinds go quiet during its windows, and how the summary that ends the
 * silence is sent (time of day, channel, recurrence threshold).
 *
 * The decision that USES these rows is quietTimeHoldService; this module only
 * stores them, audits every write and bumps the hold service's cache so a
 * new window is honoured on the next fire rather than in fifteen seconds.
 *
 * Nothing here retires a live alert. Adding, editing or disabling a schedule
 * changes what happens to the NEXT fire; an alert already held keeps its
 * stamp and is summarised by the source it was stamped with — a deleted
 * schedule still flushes (quietTimeSummaryService reads the stamp, not the
 * row).
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { bumpQuietTimeCache, parseQuietTimeConfig } from "./quietTimeHoldService.js";
import { quietWindowNow, quietResumesAt, type QuietTimeConfig } from "../utils/quietTime.js";
import { nextWindow, formatLocalIsoMinute } from "../utils/maintenanceRecurrence.js";
import type { RuleScope } from "./notificationTypes.js";

export interface QuietTimeScheduleInput {
  name: string;
  enabled?: boolean;
  scope: RuleScope;
  quiet: QuietTimeConfig;
}

const SELECT = {
  id: true, name: true, enabled: true, scope: true, quiet: true,
  createdBy: true, createdAt: true, updatedAt: true,
} as const;

type Row = Prisma.QuietTimeScheduleGetPayload<{ select: typeof SELECT }>;

/**
 * The row plus what the list needs to say at a glance, computed in the
 * SERVER's wall clock (every time in the config is): whether it is quiet now
 * and until when, else when it next goes quiet.
 */
function decorate(row: Row, now: Date) {
  const config = parseQuietTimeConfig(row.quiet);
  let inWindow = false;
  let windowEnd: string | null = null;
  let next: { start: string; end: string } | null = null;
  if (config) {
    const occ = quietWindowNow(config, now);
    if (occ) {
      inWindow = true;
      const end = quietResumesAt(config, now);
      windowEnd = end ? formatLocalIsoMinute(end) : null;
    } else {
      let soonest: { start: Date; end: Date } | null = null;
      for (const w of config.windows) {
        const n = nextWindow(w, now);
        if (n && (!soonest || n.start.getTime() < soonest.start.getTime())) soonest = n;
      }
      next = soonest ? { start: formatLocalIsoMinute(soonest.start), end: formatLocalIsoMinute(soonest.end) } : null;
    }
  }
  return { ...row, configValid: config !== null, inWindow, windowEnd, nextWindow: next };
}

export async function listQuietTimeSchedules(now: Date = new Date()) {
  const rows = await prisma.quietTimeSchedule.findMany({ select: SELECT, orderBy: { createdAt: "asc" } });
  const lastSummaries = await prisma.quietTimeSummary.findMany({
    where: { sourceKind: "global", sourceId: { in: rows.map((r) => r.id) } },
    select: { sourceId: true, createdAt: true, status: true, listedCount: true, recurringCount: true },
    orderBy: { createdAt: "desc" },
  });
  const lastBySource = new Map<string, (typeof lastSummaries)[number]>();
  for (const s of lastSummaries) if (!lastBySource.has(s.sourceId)) lastBySource.set(s.sourceId, s);
  return rows.map((r) => ({ ...decorate(r, now), lastSummary: lastBySource.get(r.id) ?? null }));
}

export async function getQuietTimeSchedule(id: string, now: Date = new Date()) {
  const row = await prisma.quietTimeSchedule.findUnique({ where: { id }, select: SELECT });
  if (!row) throw new AppError(404, "Quiet time schedule not found");
  return decorate(row, now);
}

export async function createQuietTimeSchedule(input: QuietTimeScheduleInput, actor?: string) {
  const row = await prisma.quietTimeSchedule.create({
    data: {
      name: input.name,
      enabled: input.enabled !== false,
      scope: input.scope as Prisma.InputJsonValue,
      quiet: input.quiet as unknown as Prisma.InputJsonValue,
      createdBy: actor ?? null,
    },
    select: SELECT,
  });
  bumpQuietTimeCache();
  await logEvent({
    action: "quiet_time.created",
    resourceType: "quiet-time-schedule",
    resourceId: row.id,
    resourceName: row.name,
    actor,
    message: `Global quiet time "${row.name}" created`,
    details: { enabled: row.enabled, windows: input.quiet.windows.length, severities: input.quiet.severities ?? null, alertKinds: input.quiet.alertKinds ?? null, summaryAt: input.quiet.summaryAt ?? null, recurrenceThreshold: input.quiet.recurrenceThreshold ?? null },
  });
  return decorate(row, new Date());
}

export async function updateQuietTimeSchedule(id: string, input: QuietTimeScheduleInput, actor?: string) {
  const existing = await prisma.quietTimeSchedule.findUnique({ where: { id }, select: { id: true, name: true, enabled: true } });
  if (!existing) throw new AppError(404, "Quiet time schedule not found");
  const row = await prisma.quietTimeSchedule.update({
    where: { id },
    data: {
      name: input.name,
      enabled: input.enabled !== false,
      scope: input.scope as Prisma.InputJsonValue,
      quiet: input.quiet as unknown as Prisma.InputJsonValue,
    },
    select: SELECT,
  });
  bumpQuietTimeCache();
  await logEvent({
    action: "quiet_time.updated",
    resourceType: "quiet-time-schedule",
    resourceId: id,
    resourceName: row.name,
    actor,
    message: `Global quiet time "${row.name}" updated` + (existing.enabled !== row.enabled ? ` (${row.enabled ? "enabled" : "disabled"})` : ""),
    details: { enabled: row.enabled, windows: input.quiet.windows.length, severities: input.quiet.severities ?? null, alertKinds: input.quiet.alertKinds ?? null, summaryAt: input.quiet.summaryAt ?? null, recurrenceThreshold: input.quiet.recurrenceThreshold ?? null },
  });
  return decorate(row, new Date());
}

export async function deleteQuietTimeSchedule(id: string, actor?: string) {
  const existing = await prisma.quietTimeSchedule.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!existing) throw new AppError(404, "Quiet time schedule not found");
  // Alerts it is holding right now keep their stamp: the summary job reads
  // the stamp and flushes them at the moment it finds the source gone.
  const heldNow = await prisma.notification.count({
    where: { quietSummarizedAt: null, quietHeldAt: { not: null }, quietSource: { equals: { kind: "global", id } } },
  });
  await prisma.quietTimeSchedule.delete({ where: { id } });
  bumpQuietTimeCache();
  await logEvent({
    action: "quiet_time.deleted",
    resourceType: "quiet-time-schedule",
    resourceId: id,
    resourceName: existing.name,
    actor,
    message: `Global quiet time "${existing.name}" deleted` + (heldNow > 0 ? ` — ${heldNow} held alert(s) will be summarised now` : ""),
    details: { heldAlerts: heldNow },
  });
}

/** Recent summary runs, newest first — the Settings tab's "Recent summaries" list. */
export async function listQuietTimeSummaries(limit = 20) {
  return prisma.quietTimeSummary.findMany({
    select: {
      id: true, sourceKind: true, sourceId: true, sourceName: true, coveredFrom: true, coveredTo: true,
      listedCount: true, recurringCount: true, recipients: true, channelId: true, status: true, createdAt: true, sentAt: true,
      notificationIds: true,
    },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(100, limit)),
  });
}
