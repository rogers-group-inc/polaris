/**
 * src/utils/maintenanceRecurrence.ts
 *
 * Pure recurrence math for MaintenanceSchedule.schedule JSON — no DB imports.
 * The maintenanceScheduler job evaluates `isInWindow(schedule, now)` on every
 * tick, so there is no next-fire precomputation to invalidate: all times are
 * SERVER-LOCAL wall-clock and DST shifts are absorbed automatically (a window
 * is "active" exactly when the wall clock says it is).
 *
 * Schedule JSON shapes (validated by `scheduleShapeSchema`):
 *
 *   { version: 1, kind: "oneshot",
 *     startAt: "2026-07-12T22:00",       // local ISO, NO timezone suffix
 *     endAt:   "2026-07-13T02:00" }
 *
 *   { version: 1, kind: "recurring",
 *     freq: "daily" | "weekly" | "monthly" | "yearly",
 *     daysOfWeek: [0, 6],                // weekly only; 0 = Sunday
 *     dayOfMonth: 31,                    // monthly; clamped to month length
 *     month: 7, day: 4,                  // yearly (day clamped too)
 *     hours: [{ startTime: "22:00", endTime: "02:00" },   // SEVERAL ranges per day;
 *             { startTime: "12:00", endTime: "13:00" }],  // applies to every matched day
 *     hoursByDay: [{ dow: 6, hours: [] }],  // PER-DAY override (daily/weekly only);
 *                                        // hours: [] means all day for that day
 *     startTime: "22:00", endTime: "02:00",  // LEGACY single range — every row stored
 *                                        // before per-day hours carries this pair, and
 *                                        // it is still read (see resolveDayRanges)
 *     activeFrom: "2026-07-01", activeUntil: "2026-12-31" }  // optional recurrence
 *                                        // bounds (local dates, inclusive, checked
 *                                        // against the occurrence's START day)
 *
 * A day therefore produces ZERO OR MORE occurrences, not one — which is why
 * `occurrencesStartingOn` returns an array and every consumer of it iterates.
 * Ranges are resolved per matched day in one order: the day's own `hoursByDay`
 * entry, else `hours`, else the legacy `startTime`/`endTime` pair, else all
 * day. `endTime <= startTime` still spans midnight, and the day-of-* selector
 * still matches the START day.
 *
 * Occurrences are half-open intervals [start, end): a window ending 02:00 is
 * no longer active at exactly 02:00, so a window starting 02:00 can hand over
 * without a double-active instant.
 *
 * **Two ranges on the SAME day may not overlap** (`overlapProblems`, refused at
 * validation): "22:00–06:00 and 23:00–01:00" is a mistyped end time every
 * time, and each range is its own occurrence, so accepting it would put two
 * occurrences over one instant — ambiguous for a consumer that identifies an
 * occurrence by its start, which the operator-release check in
 * `maintenanceScheduleService.runReconcile` does (it compares the release time
 * against `currentWindow(...).start` to decide whether an operator who ended
 * maintenance by hand stays released).
 *
 * Overlap ACROSS days is deliberately allowed, because it is not a mistake:
 * "Mon–Fri 22:00–06:00 plus all day Saturday" has Friday's overnight range
 * running into Saturday's all-day one, and that is the most ordinary schedule
 * anyone writes. Where two occurrences do overlap, `currentWindow` returns the
 * earliest-STARTING one that contains the instant (yesterday's before
 * today's), so the answer is deterministic — but it describes that range
 * rather than the whole contiguous stretch, which is why the Maintenance
 * modal's "until" can read Saturday 06:00 on an asset that stays in
 * maintenance all weekend. Callers that need the end of the STRETCH chain
 * forward themselves (`quietTime.quietResumesAt` is the one that does).
 */

import { z } from "zod";

// Local date-time without timezone suffix ("2026-07-12T22:00" or with :ss).
// A trailing Z / ±hh:mm offset is rejected — everything is server-local.
const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const localDateTime = z.string().regex(LOCAL_DATETIME_RE, "expected local date-time like 2026-07-12T22:00 (no timezone suffix)");
const localDate = z.string().regex(LOCAL_DATE_RE, "expected local date like 2026-07-12");
const timeOfDay = z.string().regex(TIME_RE, "expected 24h time like 22:00");

const oneshotSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("oneshot"),
    startAt: localDateTime,
    endAt: localDateTime,
  })
  .strict()
  .refine(s => parseLocalDateTime(s.endAt).getTime() > parseLocalDateTime(s.startAt).getTime(), {
    message: "endAt must be after startAt",
  });

/** "22:00" → 1320. */
function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Hour ranges that overlap each other WITHIN one day, as messages naming both.
 *
 * Each range is measured from its own day's midnight, so a range whose end is
 * at or before its start is carried past 1440 — that is what makes
 * "22:00–06:00" and "23:00–01:00" comparable at all, and it is the pair this
 * check exists to catch. Sorting by start and comparing each range with the
 * one before it is sufficient for a set of intervals.
 *
 * Deliberately per-day and not across days: see the module header. A schedule
 * whose Friday night runs into an all-day Saturday is ordinary, not a typo.
 */
function overlapProblems(s: {
  hours?: TimeRange[];
  hoursByDay?: DayHours[];
}): string[] {
  const out: string[] = [];
  const check = (ranges: TimeRange[] | undefined, label: string): void => {
    if (!ranges || ranges.length < 2) return;
    const iv = ranges
      .map((r) => {
        const a = minutesOfDay(r.startTime);
        const b = minutesOfDay(r.endTime);
        return { a, b: b <= a ? b + 1440 : b, text: `${r.startTime}–${r.endTime}` };
      })
      .sort((x, y) => x.a - y.a);
    for (let i = 1; i < iv.length; i++) {
      if (iv[i]!.a < iv[i - 1]!.b) {
        out.push(`${label}: ${iv[i - 1]!.text} overlaps ${iv[i]!.text}`);
      }
    }
  };
  check(s.hours, "hours");
  for (const d of s.hoursByDay ?? []) check(d.hours, `hours on day ${d.dow}`);
  return out;
}

/** Cap on hour ranges in ONE day. Eight covers "overnight, plus a lunch
 *  window, plus a couple of afternoon slots" with room to spare, and bounds
 *  both the overlap check and the per-tick occurrence expansion. */
export const MAX_RANGES_PER_DAY = 8;

/**
 * One hour range within a day. Both ends are required — an "open" range has no
 * meaning here, and all-day is expressed by having NO ranges rather than by a
 * half-filled one (which is what made the legacy `startTime`/`endTime` pair
 * need a both-or-neither refinement of its own).
 */
const timeRangeSchema = z
  .object({
    startTime: timeOfDay,
    endTime: timeOfDay,
  })
  .strict();

export type TimeRange = z.infer<typeof timeRangeSchema>;

/** Per-day hours: which day, and the ranges on it (`[]` = all day). */
const dayHoursSchema = z
  .object({
    dow: z.number().int().min(0).max(6),
    hours: z.array(timeRangeSchema).max(MAX_RANGES_PER_DAY),
  })
  .strict();

export type DayHours = z.infer<typeof dayHoursSchema>;

const recurringSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("recurring"),
    freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    month: z.number().int().min(1).max(12).optional(),
    day: z.number().int().min(1).max(31).optional(),
    startTime: timeOfDay.optional(),
    endTime: timeOfDay.optional(),
    hours: z.array(timeRangeSchema).min(1).max(MAX_RANGES_PER_DAY).optional(),
    // An ARRAY, not a record keyed by day: a `z.record` of a day enum is not
    // partial in Zod 3 (it would demand all seven keys), and the array form
    // also lets the duplicate-day check below say which day is doubled.
    hoursByDay: z.array(dayHoursSchema).min(1).max(7).optional(),
    activeFrom: localDate.optional(),
    activeUntil: localDate.optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.freq === "weekly" && (!s.daysOfWeek || s.daysOfWeek.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "weekly recurrence requires daysOfWeek" });
    }
    if (s.freq === "monthly" && s.dayOfMonth == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "monthly recurrence requires dayOfMonth" });
    }
    if (s.freq === "yearly" && (s.month == null || s.day == null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "yearly recurrence requires month + day" });
    }
    if ((s.startTime == null) !== (s.endTime == null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "startTime and endTime must be set together (omit both for all-day)" });
    }
    // The legacy pair is the SAME field as `hours`, one range wide. Accepting
    // both would leave the reader deciding which the operator meant, and the
    // resolution order is not something a stored blob should depend on.
    if (s.hours && (s.startTime != null || s.endTime != null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "use hours[] or startTime/endTime, not both",
      });
    }
    if (s.hoursByDay) {
      if (s.freq !== "daily" && s.freq !== "weekly") {
        // A monthly or yearly recurrence matches ONE day per period, so
        // "different hours on Tuesday" has nothing to attach to; several
        // ranges on that day are what `hours` is for.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "hoursByDay needs a daily or weekly recurrence (use hours[] for monthly/yearly)",
        });
      }
      const seen = new Set<number>();
      for (const d of s.hoursByDay) {
        if (seen.has(d.dow)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `hoursByDay lists day ${d.dow} twice` });
        }
        seen.add(d.dow);
        // A day whose hours the schedule states but whose day the schedule
        // never matches is an editing accident every time — the operator
        // unticked the day and the hours stayed behind, so the summary and the
        // engine would silently disagree with what the editor shows.
        if (s.freq === "weekly" && s.daysOfWeek && !s.daysOfWeek.includes(d.dow)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `hoursByDay states hours for day ${d.dow}, which daysOfWeek does not include`,
          });
        }
      }
    }
    if (s.activeFrom && s.activeUntil && s.activeUntil < s.activeFrom) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "activeUntil must not be before activeFrom" });
    }
    for (const problem of overlapProblems(s)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }
  });

// Plain union (not discriminatedUnion): both members carry .refine/.superRefine
// wrappers (ZodEffects), which discriminatedUnion rejects. The `kind` literal
// still narrows the inferred type.
export const scheduleShapeSchema = z.union([oneshotSchema, recurringSchema]);

export type MaintenanceScheduleShape = z.infer<typeof scheduleShapeSchema>;
export type OneshotSchedule = z.infer<typeof oneshotSchema>;
export type RecurringSchedule = z.infer<typeof recurringSchema>;

export interface MaintenanceOccurrence {
  start: Date;
  end: Date;
}

/** Zod-validate an unknown schedule blob; throws ZodError on mismatch. */
export function validateScheduleShape(raw: unknown): MaintenanceScheduleShape {
  return scheduleShapeSchema.parse(raw);
}

/** Format a Date as the local-ISO minute string the schedule shapes carry. */
export function formatLocalIsoMinute(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface ServerClockInfo {
  /** Server wall clock as the local-ISO minute string every shape here carries. */
  now: string;
  /** IANA zone name the server resolves to ("UTC", "America/Chicago", …). */
  timeZone: string;
  /** Server UTC offset in minutes, east-positive (Central DST = -300). */
  offsetMinutes: number;
}

/**
 * The server's wall clock, for browsers that must PICK a time in it.
 *
 * Every time in this module is server-local wall clock with no offset — a
 * 22:00 nightly window means 22:00 at the site, which is the only reading that
 * survives DST. That contract silently breaks the other way for a browser: a
 * `datetime-local` field prefilled from `new Date()` in the BROWSER posts the
 * operator's wall clock, and the server reads those same digits as its own. On
 * a UTC-clocked host with a Central operator that maps a "now → now + 2h"
 * window onto one that started 5–6 hours ago and has ALREADY ENDED, so the
 * schedule saves cleanly, `isInWindow` is false forever, and nothing ever
 * enters maintenance. (`resolveStartNow` covers only the START of the ad-hoc
 * path; every operator-picked end time had the same hole.)
 *
 * Handing the browser this block lets it prefill, validate and LABEL in the
 * server's zone instead of guessing that the two agree.
 */
export function serverClockInfo(now: Date = new Date()): ServerClockInfo {
  let timeZone = "";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    // Intl is always present on supported Node, but a resolved zone is not
    // guaranteed on a stripped container image — the offset still is.
    timeZone = "";
  }
  return {
    now: formatLocalIsoMinute(now),
    timeZone,
    // getTimezoneOffset is west-positive; flip it so the sign reads the way
    // operators write offsets (Central DST = -300, not +300).
    offsetMinutes: -now.getTimezoneOffset(),
  };
}

/**
 * Pre-validation resolution for the ad-hoc `startNow` marker: a oneshot blob
 * carrying `startNow: true` gets `startAt` stamped from the SERVER clock (the
 * marker is stripped — stored shapes are always concrete). Trusting a
 * browser-supplied startAt breaks "enter maintenance now" whenever the
 * operator's clock runs ahead of the server (clock skew, or an operator in a
 * timezone ahead of the server's): the window sits in the server's future and
 * the asset doesn't enter until the skew elapses. Non-oneshot / non-startNow
 * blobs pass through untouched.
 */
export function resolveStartNow(raw: unknown, now: Date = new Date()): unknown {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== "oneshot" || obj.startNow !== true) return raw;
  const { startNow: _drop, ...rest } = obj;
  return { ...rest, startAt: formatLocalIsoMinute(now) };
}

/** Parse "YYYY-MM-DDTHH:MM(:SS)" as server-local time. */
function parseLocalDateTime(s: string): Date {
  const [datePart, timePart] = s.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi, sec] = timePart.split(":").map(Number);
  return new Date(y, mo - 1, d, h, mi, sec || 0, 0);
}

/** Parse "YYYY-MM-DD" as server-local midnight. */
function parseLocalDate(s: string): Date {
  const [y, mo, d] = s.split("-").map(Number);
  return new Date(y, mo - 1, d, 0, 0, 0, 0);
}

/**
 * Public form of parseLocalDate for callers that hold an operator-supplied
 * day string ("YYYY-MM-DD"): the calendar range endpoints. Server-local
 * midnight, matching how every other time in this module is interpreted.
 */
export function parseLocalDay(s: string): Date {
  return parseLocalDate(s);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** Local midnight of the given date. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function addDays(d: Date, n: number): Date {
  // Construct via Y/M/D so DST-shortened/lengthened days can't drift the clock.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 0, 0, 0, 0);
}

/** Does the recurrence's day selector match local day D (a local midnight)? */
function dayMatches(s: RecurringSchedule, day: Date): boolean {
  switch (s.freq) {
    case "daily":
      return true;
    case "weekly":
      return (s.daysOfWeek ?? []).includes(day.getDay());
    case "monthly": {
      const clamped = Math.min(s.dayOfMonth!, daysInMonth(day.getFullYear(), day.getMonth()));
      return day.getDate() === clamped;
    }
    case "yearly": {
      if (day.getMonth() !== s.month! - 1) return false;
      const clamped = Math.min(s.day!, daysInMonth(day.getFullYear(), day.getMonth()));
      return day.getDate() === clamped;
    }
  }
}

/** Is local day D (a local midnight) within the activeFrom/activeUntil bounds? */
function withinActiveBounds(s: RecurringSchedule, day: Date): boolean {
  if (s.activeFrom && day.getTime() < parseLocalDate(s.activeFrom).getTime()) return false;
  if (s.activeUntil && day.getTime() > parseLocalDate(s.activeUntil).getTime()) return false;
  return true;
}

function setTime(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
}

/**
 * The hour ranges that apply to one matched day-of-week, or null for all day.
 *
 * ONE resolution order, everywhere: the day's own `hoursByDay` entry (whose
 * empty list means all day — an operator who says "Saturday" and picks no
 * hours means the whole day, exactly as an omitted `startTime` always has),
 * then the schedule-wide `hours`, then the legacy `startTime`/`endTime` pair
 * that every row written before per-day hours carries, then all day.
 *
 * Keyed by day-of-week rather than by Date so the validator can ask the same
 * question about a day that hasn't happened yet.
 */
export function resolveDayRanges(s: RecurringSchedule, dow: number): TimeRange[] | null {
  const own = s.hoursByDay?.find((d) => d.dow === dow);
  if (own) return own.hours.length > 0 ? own.hours : null;
  if (s.hours && s.hours.length > 0) return s.hours;
  if (s.startTime != null && s.endTime != null) {
    return [{ startTime: s.startTime, endTime: s.endTime }];
  }
  return null;
}

/**
 * Every occurrence STARTING on local day `day`, earliest first — empty when
 * the day selector / active bounds don't match. All-day = [00:00, next-day
 * 00:00). A range with endTime <= startTime ends on the FOLLOWING day (spans
 * midnight).
 *
 * An ARRAY because a day can carry several hour ranges (an overnight window
 * and a lunchtime one), each of which is its own occurrence with its own
 * start — which is what makes an operator who ends maintenance during the
 * morning window stay released for that window and re-enter for the
 * afternoon one.
 */
function occurrencesStartingOn(s: RecurringSchedule, day: Date): MaintenanceOccurrence[] {
  if (!dayMatches(s, day) || !withinActiveBounds(s, day)) return [];
  const ranges = resolveDayRanges(s, day.getDay());
  if (ranges === null) return [{ start: day, end: addDays(day, 1) }];
  return ranges
    .map((r) => ({
      start: setTime(day, r.startTime),
      end: r.endTime > r.startTime ? setTime(day, r.endTime) : setTime(addDays(day, 1), r.endTime),
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * The occurrence containing `date` ([start, end) half-open), or null.
 * Needed by the scheduler's operator-release check: "did the operator end
 * maintenance during THIS occurrence?" identifies the occurrence by its start.
 */
export function currentWindow(schedule: MaintenanceScheduleShape, date: Date): MaintenanceOccurrence | null {
  if (schedule.kind === "oneshot") {
    const start = parseLocalDateTime(schedule.startAt);
    const end = parseLocalDateTime(schedule.endAt);
    return date.getTime() >= start.getTime() && date.getTime() < end.getTime() ? { start, end } : null;
  }
  // An occurrence is at most 24h (all-day) so only ones starting today or
  // yesterday can contain `date`. Yesterday FIRST, and within a day the
  // ranges are in start order, so where two occurrences overlap (a Friday
  // night running into an all-day Saturday — legitimate, see the module
  // header) the answer is always the earliest-starting one that contains the
  // instant, rather than whichever the scan happened to reach. Half-open
  // intervals keep the handover instant unambiguous either way.
  const today = startOfDay(date);
  for (const day of [addDays(today, -1), today]) {
    for (const occ of occurrencesStartingOn(schedule, day)) {
      if (date.getTime() >= occ.start.getTime() && date.getTime() < occ.end.getTime()) return occ;
    }
  }
  return null;
}

/** True when `date` falls inside an active occurrence of the schedule. */
export function isInWindow(schedule: MaintenanceScheduleShape, date: Date): boolean {
  return currentWindow(schedule, date) !== null;
}

// Scan horizon for nextWindow: two years covers the worst legitimate gap
// (yearly recurrence just missed + activeFrom pushing the first occurrence
// out) without risking an unbounded loop on a dead schedule.
const NEXT_WINDOW_SCAN_DAYS = 731;

/**
 * The current-or-next occurrence whose end is after `date`, or null when the
 * schedule will never be active again (oneshot passed / activeUntil elapsed /
 * nothing within the two-year scan horizon). Powers UI summaries.
 */
// Day-scan cap for expandOccurrences. The calendar's month grid asks for 42
// days and its "whole year" reach is 366, so 400 bounds the loop without
// truncating any range the UI can request (the route caps the span too).
const EXPAND_MAX_DAYS = 400;

/**
 * Every occurrence OVERLAPPING the half-open range [rangeStart, rangeEnd) —
 * what the Maintenance modal's calendar tab paints. Expansion happens
 * server-side precisely because occurrences are SERVER-LOCAL wall-clock: a
 * browser in another timezone re-deriving them from the recurrence blob would
 * draw windows on the wrong days.
 *
 * The scan starts one day BEFORE the range so a midnight-spanning occurrence
 * (22:00 → 02:00) whose start day sits outside the range still shows up on the
 * day it bleeds into. `maxOccurrences` bounds an all-day daily schedule over a
 * long range; hitting it truncates rather than throws (the caller's range is
 * already capped, so this is a backstop, not a paging contract).
 */
export function expandOccurrences(
  schedule: MaintenanceScheduleShape,
  rangeStart: Date,
  rangeEnd: Date,
  maxOccurrences = 500,
): MaintenanceOccurrence[] {
  if (rangeEnd.getTime() <= rangeStart.getTime() || maxOccurrences <= 0) return [];
  if (schedule.kind === "oneshot") {
    const start = parseLocalDateTime(schedule.startAt);
    const end = parseLocalDateTime(schedule.endAt);
    return end.getTime() > rangeStart.getTime() && start.getTime() < rangeEnd.getTime()
      ? [{ start, end }]
      : [];
  }
  const out: MaintenanceOccurrence[] = [];
  let day = addDays(startOfDay(rangeStart), -1);
  outer: for (let i = 0; i <= EXPAND_MAX_DAYS && day.getTime() < rangeEnd.getTime(); i++) {
    for (const occ of occurrencesStartingOn(schedule, day)) {
      if (occ.end.getTime() > rangeStart.getTime() && occ.start.getTime() < rangeEnd.getTime()) {
        out.push(occ);
        // The cap counts OCCURRENCES, not days, now that one day can carry
        // several — a schedule with eight ranges a day reaches it eight times
        // faster, which is the honest accounting for a caller that is
        // protecting itself against volume.
        if (out.length >= maxOccurrences) break outer;
      }
    }
    day = addDays(day, 1);
  }
  return out;
}

export function nextWindow(schedule: MaintenanceScheduleShape, date: Date): MaintenanceOccurrence | null {
  if (schedule.kind === "oneshot") {
    const start = parseLocalDateTime(schedule.startAt);
    const end = parseLocalDateTime(schedule.endAt);
    return end.getTime() > date.getTime() ? { start, end } : null;
  }
  const active = currentWindow(schedule, date);
  if (active) return active;
  const today = startOfDay(date);
  for (let i = 0; i <= NEXT_WINDOW_SCAN_DAYS; i++) {
    const day = addDays(today, i);
    if (schedule.activeUntil && day.getTime() > parseLocalDate(schedule.activeUntil).getTime()) return null;
    // Start order within the day, so on a day whose morning range is already
    // over this returns the afternoon one rather than the first one listed.
    for (const occ of occurrencesStartingOn(schedule, day)) {
      if (occ.end.getTime() > date.getTime()) return occ;
    }
  }
  return null;
}
