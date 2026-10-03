/**
 * src/utils/quietTime.ts
 *
 * Quiet time for automation REMINDERS — the recurring windows during which an
 * unhandled alert's repeat pass is held instead of re-notifying (business
 * rule 44).
 *
 * The recurrence math is NOT re-implemented here: the windows are the very
 * same shapes `MaintenanceSchedule.schedule` carries, validated by
 * `maintenanceRecurrence.scheduleShapeSchema` and evaluated by its
 * `currentWindow` / `nextWindow`. That is deliberate on three counts:
 *
 *   - every time is SERVER-LOCAL wall clock, so a 22:00 quiet window means
 *     22:00 at the site across a DST shift (the whole reason that module has
 *     no next-fire precomputation),
 *   - a midnight-spanning window (22:00 → 06:00, the shape almost every
 *     quiet time takes) is already solved there, half-open, with the
 *     day-of-week selector matching the START day,
 *   - an operator who has already learned the Maintenance scheduler's
 *     recurrence vocabulary does not have to learn a second one.
 *
 * What is different from maintenance: a quiet time is a LIST of windows
 * ("nights, and all weekend"), because one recurrence cannot express two
 * unrelated shapes and re-entering the same policy on a second automation is
 * not the answer. Every window is checked independently and any one of them
 * being active means quiet.
 *
 * Nothing here reads or writes the database, and nothing here decides what
 * quiet MEANS — holding the reminder, stamping the hold and framing the
 * reminder that follows all live in `notificationEscalationService`.
 */

import { z } from "zod";
import {
  scheduleShapeSchema,
  currentWindow,
  nextWindow,
  expandOccurrences,
  resolveDayRanges,
  type MaintenanceOccurrence,
  type MaintenanceScheduleShape,
  type RecurringSchedule as RecurringShape,
  type TimeRange,
} from "./maintenanceRecurrence.js";

/** Cap on windows in one automation's quiet time. Eight covers "nights +
 *  each weekend day + a monthly change freeze" with room to spare, and bounds
 *  the per-sweep evaluation to something trivially cheap. */
export const MAX_QUIET_WINDOWS = 8;

/**
 * An automation's quiet time. An object rather than a bare array so a later
 * knob (a per-window exemption, say) can be added without a shape migration
 * of every stored automation.
 */
export const quietConfigSchema = z
  .object({
    windows: z.array(scheduleShapeSchema).min(1).max(MAX_QUIET_WINDOWS),
  })
  .strict();

export type QuietConfig = z.infer<typeof quietConfigSchema>;

/** How far `quietResumesAt` will chain through abutting/overlapping windows
 *  before giving up and reporting the end it has reached. A bound, not a
 *  policy: eight windows can chain at most eight times. */
const MAX_QUIET_CHAIN = MAX_QUIET_WINDOWS + 1;

/**
 * The first quiet window containing `now`, or null when it isn't quiet.
 *
 * Returns the OCCURRENCE rather than a boolean so a caller that needs to say
 * when the silence started (or ends) doesn't have to evaluate the recurrence
 * a second time.
 */
export function quietWindowNow(
  quiet: QuietConfig | null | undefined,
  now: Date,
): MaintenanceOccurrence | null {
  if (!quiet) return null;
  for (const w of quiet.windows) {
    const occ = currentWindow(w, now);
    if (occ) return occ;
  }
  return null;
}

/** Is `now` inside any of the automation's quiet windows? */
export function isQuietNow(quiet: QuietConfig | null | undefined, now: Date): boolean {
  return quietWindowNow(quiet, now) !== null;
}

/**
 * When reminders resume — the end of the quiet stretch containing `now`, or
 * null when it isn't quiet.
 *
 * NOT simply the containing window's end. Two windows that abut or overlap are
 * ONE stretch of silence to whoever is reading the alert: a nightly
 * 22:00–06:00 beside an all-day Saturday means a Friday-night alert resumes
 * Sunday at 06:00, not Saturday at 06:00. Since occurrences are half-open, a
 * window STARTING exactly at the current end continues the silence too, which
 * is why the chain tests `nextWindow(...).start <= end` rather than
 * containment alone.
 *
 * The loop is bounded (`MAX_QUIET_CHAIN`): with a capped window list the chain
 * cannot legitimately be longer, and reporting a slightly early resume time
 * beats spinning on a pathological blob.
 */
export function quietResumesAt(quiet: QuietConfig | null | undefined, now: Date): Date | null {
  const occ = quietWindowNow(quiet, now);
  if (!occ || !quiet) return null;
  let end = occ.end;
  for (let i = 0; i < MAX_QUIET_CHAIN; i++) {
    let extended: Date | null = null;
    for (const w of quiet.windows) {
      const next = nextWindow(w, end);
      if (next && next.start.getTime() <= end.getTime() && next.end.getTime() > end.getTime()) {
        extended = next.end;
        break;
      }
    }
    if (!extended) break;
    end = extended;
  }
  return end;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "22:00–06:00, 12:00–13:00" / "all day" — the hours half of a description. */
function hoursPhrase(ranges: TimeRange[] | null): string {
  if (ranges === null || ranges.length === 0) return "all day";
  return ranges.map((r) => `${r.startTime}–${r.endTime}`).join(", ");
}

/**
 * The days of a weekly/daily window grouped by the hours they keep:
 * "Mon, Tue, Wed 22:00–06:00; Sat all day".
 *
 * Grouped rather than listed per day because with per-day hours the common
 * shape is still "the same hours on most days, and something else at the
 * weekend" — seven segments saying the same thing is what makes a policy
 * sentence unreadable.
 */
function describeDayHours(w: RecurringShape): string {
  const days = w.freq === "daily" ? [0, 1, 2, 3, 4, 5, 6] : (w.daysOfWeek ?? []).slice().sort((a, b) => a - b);
  if (days.length === 0) return "";
  const groups: { hours: string; days: number[] }[] = [];
  for (const d of days) {
    const hours = hoursPhrase(resolveDayRanges(w, d));
    const last = groups[groups.length - 1];
    // Only ADJACENT days merge, so the label keeps calendar order — "Mon, Tue,
    // Wed 22:00–06:00; Thu all day; Fri, Sat 22:00–06:00" reads as a week,
    // where collecting all the 22:00 days together would not.
    if (last && last.hours === hours) last.days.push(d);
    else groups.push({ hours, days: [d] });
  }
  // Every day the same: say it once, and say "daily" when that is all seven.
  if (groups.length === 1) {
    return days.length === 7 ? `daily ${groups[0]!.hours}` : `${days.map((d) => WEEKDAY_LABELS[d]).join(", ")} ${groups[0]!.hours}`;
  }
  return groups.map((g) => `${g.days.map((d) => WEEKDAY_LABELS[d]).join(", ")} ${g.hours}`).join("; ");
}

/**
 * One window in words: "daily 22:00–06:00", "Mon, Tue 22:00–06:00; Sat all day".
 *
 * Terse on purpose. This text goes into `{repeat.policy}` — a sentence inside
 * an alert email, read by someone who wants to know when the next reminder is
 * coming, not into a schedule editor. The browser's own summary of the same
 * shape (`PolarisRecurrence.summary`, `public/js/recurrence-editor.js`) is the
 * richer one and is what the wizard shows while the operator is building it.
 */
export function describeQuietWindow(w: MaintenanceScheduleShape): string {
  if (w.kind === "oneshot") {
    return `${w.startAt.replace("T", " ")} – ${w.endAt.replace("T", " ")}`;
  }
  switch (w.freq) {
    case "daily":
    case "weekly":
      return describeDayHours(w) || `weekly ${hoursPhrase(resolveDayRanges(w, 0))}`;
    case "monthly":
      return `day ${w.dayOfMonth} of each month, ${hoursPhrase(resolveDayRanges(w, 0))}`;
    case "yearly":
      return `${MONTH_LABELS[(w.month ?? 1) - 1]} ${w.day} each year, ${hoursPhrase(resolveDayRanges(w, 0))}`;
  }
}

/**
 * The whole quiet time in words, for the reminder-policy sentence.
 *
 * Two windows are still spelled out (nights + weekends is the common pair);
 * beyond that the count is stated instead, because a run-on list of five
 * recurrences inside an alert email is noise — the automation's own page is
 * where the full policy is read.
 */
export function describeQuietTime(quiet: QuietConfig | null | undefined): string {
  if (!quiet || quiet.windows.length === 0) return "";
  if (quiet.windows.length <= 2) return quiet.windows.map(describeQuietWindow).join(" and ");
  return `${quiet.windows.length} quiet periods`;
}

// ─── Quiet time that HOLDS alerts (business rule 92) ────────────────────────
//
// The shape above (`quietConfigSchema`) is the legacy per-action
// `repeat.quiet`, which only ever paused reminders (business rule 44). Since
// 2026-10 quiet time is a policy of its own, carried by a global
// `QuietTimeSchedule` row or by `NotificationRule.quietTime`, and it withholds
// every people-facing send of an alert that fires inside a window — the alert
// still exists, and a SUMMARY email reports what is still outstanding once the
// window ends. The hold itself, the summary and the recipients live in
// `services/quietTimeHoldService.ts` / `services/quietTimeSummaryService.ts`;
// this half stays pure: the config shape, the one cross-field rule the shape
// has (the summary time may not sit inside a window), and the arithmetic that
// turns a window end into a send time.

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * One quiet-time policy — the same shape whether it is a global schedule's or
 * an automation's own.
 *
 *   windows             the recurrence shapes, any one active = quiet
 *   holds               "all" (default): the first alert, its escalation tiers
 *                       and its reminders are all held, and a summary email
 *                       of what is still outstanding goes out afterwards.
 *                       "followUps": only the chasing goes quiet — reminders
 *                       and escalation tiers wait for the window, the first
 *                       alert and the all-clear send as usual, and there is
 *                       nothing to summarise (rule 44's behaviour, widened to
 *                       the tiers).
 *   severities          which alert severities the window holds; null = all
 *   alertKinds          GLOBAL ONLY — Notification.metric names the window
 *                       holds ("cpuPct", "monitorStatus", …); null = any kind.
 *                       An event/change alert carries no metric and so matches
 *                       only "any". An automation's own quiet time has nothing
 *                       to filter — the automation IS the kind.
 *   summaryAt           "HH:MM" server-local; the summary waits for the first
 *                       such time at or after the window ends. null = the
 *                       moment the window ends.
 *   summaryChannelId    the email channel the summary goes through; null =
 *                       the hold's own email channel, else the first enabled
 *                       one (quietTimeSummaryService.resolveSummaryChannel).
 *   recurrenceThreshold an alert that fired MORE THAN this many times during
 *                       the window is reported even if it has recovered, with
 *                       every fire time; null = off.
 *
 * Severity values are plain strings here because `SEVERITIES` lives in
 * notificationTypes, which imports this module; the two consumers refine
 * membership against that list themselves (`severitiesKnown`).
 */
export const quietTimeConfigSchema = z
  .object({
    windows: z.array(scheduleShapeSchema).min(1).max(MAX_QUIET_WINDOWS),
    holds: z.enum(["all", "followUps"]).optional(),
    severities: z.array(z.string().min(1).max(32)).min(1).max(8).optional().nullable(),
    alertKinds: z.array(z.string().min(1).max(64)).min(1).max(50).optional().nullable(),
    summaryAt: z.string().regex(TIME_RE, "expected 24h time like 07:30").optional().nullable(),
    summaryChannelId: z.string().min(1).max(100).optional().nullable(),
    recurrenceThreshold: z.number().int().min(1).max(100).optional().nullable(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const problem = summaryTimeConflicts(cfg);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["summaryAt"], message: problem });
  });

export type QuietTimeConfig = z.infer<typeof quietTimeConfigSchema>;

/** Server-local midnight of `d`'s day. */
function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/** `day` at the server-local wall-clock time `hhmm`. */
function atLocalTime(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h ?? 0, m ?? 0, 0, 0);
}

/** How far ahead the summary-time check looks. A yearly window needs a year;
 *  366 covers a leap year without scanning two of them. */
const SUMMARY_CHECK_DAYS = 366;
/** Occurrence cap for that scan — eight ranges a day for a year. */
const SUMMARY_CHECK_MAX_OCCURRENCES = SUMMARY_CHECK_DAYS * MAX_QUIET_WINDOWS + 8;

/**
 * Why `summaryAt` cannot be used with these windows, or null when it can.
 *
 * The summary is the thing that ends the silence, so a send time inside a
 * window is a contradiction: the summary would either go out mid-window
 * (announcing alerts the window is still collecting) or wait for a window end
 * that the time was supposed to replace. Refused at validation, in the server's
 * wall clock, by walking every occurrence in the coming year and asking
 * whether that day's HH:MM falls inside it — uniform across daily, weekly,
 * monthly, yearly and one-shot windows, midnight-spanning ones included (an
 * occurrence Fri 22:00 → Sat 06:00 is tested at both Friday's and Saturday's
 * HH:MM). The year starts from `now`, which only matters for a one-shot or a
 * bounded window that has already ended: those can never conflict again.
 */
export function summaryTimeConflicts(
  cfg: { windows: MaintenanceScheduleShape[]; summaryAt?: string | null },
  now: Date = new Date(),
): string | null {
  if (!cfg.summaryAt) return null;
  const from = startOfLocalDay(now);
  const to = new Date(from.getTime() + SUMMARY_CHECK_DAYS * 86_400_000);
  for (const w of cfg.windows) {
    for (const occ of expandOccurrences(w, from, to, SUMMARY_CHECK_MAX_OCCURRENCES)) {
      // Every local day the occurrence touches, start day through end day.
      for (let day = startOfLocalDay(occ.start); day.getTime() <= occ.end.getTime(); day = new Date(day.getTime() + 86_400_000)) {
        const candidate = atLocalTime(day, cfg.summaryAt);
        if (candidate.getTime() >= occ.start.getTime() && candidate.getTime() < occ.end.getTime()) {
          return `The summary time ${cfg.summaryAt} falls inside a quiet period (${describeQuietWindow(w)}). Pick a time outside every quiet period, or leave it blank to send when each period ends.`;
        }
      }
    }
  }
  return null;
}

/**
 * When the summary for a window that ended at `windowEnd` is due: the end
 * itself, or the first `summaryAt` at or after it. A window ending 06:00 with
 * a 07:30 summary sends at 07:30 the same day; one ending 13:00 sends at 07:30
 * the NEXT day — the time is a daily appointment, not an offset.
 */
export function summarySendAt(cfg: { summaryAt?: string | null }, windowEnd: Date): Date {
  if (!cfg.summaryAt) return windowEnd;
  const sameDay = atLocalTime(startOfLocalDay(windowEnd), cfg.summaryAt);
  return sameDay.getTime() >= windowEnd.getTime() ? sameDay : new Date(sameDay.getTime() + 86_400_000);
}

/** Does the policy hold the FIRST alert (and so owe a summary)? "followUps"
 *  lets it through and quiets only the reminders and escalation tiers. */
export function quietHoldsFires(cfg: { holds?: "all" | "followUps" | null }): boolean {
  return cfg.holds !== "followUps";
}

/** Is `severity` one the policy holds? A null list holds every severity. */
export function quietHoldsSeverity(cfg: { severities?: string[] | null }, severity: string): boolean {
  return !cfg.severities || cfg.severities.includes(severity);
}

/** Is an alert of `metric` one the policy holds? A null list holds every kind;
 *  an alert with no metric (event/change) is held only by "any". */
export function quietHoldsKind(cfg: { alertKinds?: string[] | null }, metric: string | null | undefined): boolean {
  if (!cfg.alertKinds) return true;
  return !!metric && cfg.alertKinds.includes(metric);
}
