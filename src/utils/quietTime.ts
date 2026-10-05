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
 *   held                PER SEVERITY, which of the four kinds of people-facing
 *                       send the window holds: `alerts` (the first alert and a
 *                       grouped alert's growth update), `alertReminders` (the
 *                       repeat pass), `escalations` (a tier's first run) and
 *                       `escalationReminders` (a tier's repeat runs). A
 *                       severity with no entry is not held at all. A held
 *                       `alerts` is what owes a summary — an alert nobody was
 *                       told of is reported when the window ends; a reminder
 *                       or tier held on its own just waits (rule 44's
 *                       behaviour, widened to the tiers). Absent = the legacy
 *                       pair below decides.
 *   holds               LEGACY (pre-2026-10-05 rows; still read): "all" =
 *                       every kind held for every severity in `severities`,
 *                       "followUps" = everything but `alerts`.
 *   severities          LEGACY with `holds`: which severities the window
 *                       holds; null = all. Still WRITTEN beside `held` as the
 *                       list of severities with any hold, for readers that
 *                       only want the list.
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
/** The four kinds of people-facing send a quiet time can hold, per severity. */
export const heldKindsSchema = z
  .object({
    alerts: z.boolean(),
    alertReminders: z.boolean(),
    escalations: z.boolean(),
    escalationReminders: z.boolean(),
  })
  .strict();
export type HeldKinds = z.infer<typeof heldKindsSchema>;

/** What is about to be sent, as the hold decision sees it. */
export type QuietSend = "fire" | "reminder" | "escalation" | "escalationReminder";
const SEND_TO_KIND: Record<QuietSend, keyof HeldKinds> = {
  fire: "alerts",
  reminder: "alertReminders",
  escalation: "escalations",
  escalationReminder: "escalationReminders",
};

export const quietTimeConfigSchema = z
  .object({
    windows: z.array(scheduleShapeSchema).min(1).max(MAX_QUIET_WINDOWS),
    held: z.record(z.string().min(1).max(32), heldKindsSchema).optional().nullable(),
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

/**
 * The third setting of an automation's Quiet time step: NO quiet time, not its
 * own and not the global ones. An automation carrying this always sends,
 * whatever Automations → Settings says — the shape a critical automation wants
 * on an install whose global quiet time covers every severity. Stored in
 * `NotificationRule.quietTime` beside the full policy so one column answers
 * "is this automation exempt from the global schedules?" with one read; `null`
 * there still means "the global schedules apply".
 */
export const quietTimeIgnoreGlobalSchema = z.object({ ignoreGlobal: z.literal(true) }).strict();

/** What `NotificationRule.quietTime` may hold: the exemption marker or a full policy. */
export const ruleQuietTimeSchema = z.union([quietTimeIgnoreGlobalSchema, quietTimeConfigSchema]);
export type RuleQuietTime = z.infer<typeof ruleQuietTimeSchema>;

export function isIgnoreGlobalQuietTime(q: unknown): q is { ignoreGlobal: true } {
  return !!q && typeof q === "object" && (q as { ignoreGlobal?: unknown }).ignoreGlobal === true;
}

/** The policy inside a rule-level value, or null for the exemption marker / nothing. */
export function ruleQuietConfig(q: RuleQuietTime | null | undefined): QuietTimeConfig | null {
  if (!q || isIgnoreGlobalQuietTime(q)) return null;
  return q as QuietTimeConfig;
}

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
  // Two sets over the coming year: the local days on which quiet time happens
  // at all, and those among them on which HH:MM is inside it. The time is
  // refused only when the second set is the whole of the first — "nights and
  // weekends" with a 07:30 summary is fine (weekday mornings are free; a held
  // weekend rolls into Monday's), while "every night 22:00–08:00" with 07:30
  // is a summary that could never go out on time.
  const touched = new Set<number>();
  const quietAt = new Set<number>();
  // The first and last days of the scan are half-seen — the night BEFORE the
  // first day was never expanded, and the last day's own night runs past the
  // horizon — so a 05:59 or 23:30 summary would look free there and slip
  // through. Judge only the days the scan sees whole.
  // Day keys are LOCAL midnights stepped by calendar day, never by 86 400 000
  // ms: across a DST change that step lands at 23:00 or 01:00 and the key no
  // longer matches the next occurrence's start day, which then looks free.
  const nextLocalDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
  const lo = nextLocalDay(from).getTime();
  const hi = new Date(from.getFullYear(), from.getMonth(), from.getDate() + SUMMARY_CHECK_DAYS - 1, 0, 0, 0, 0).getTime();
  for (const w of cfg.windows) {
    for (const occ of expandOccurrences(w, from, to, SUMMARY_CHECK_MAX_OCCURRENCES)) {
      // Every local day the occurrence has a minute in — strict, so an all-day
      // window ending at midnight does not count the next day as touched.
      for (let day = startOfLocalDay(occ.start); day.getTime() < occ.end.getTime(); day = nextLocalDay(day)) {
        if (day.getTime() < lo || day.getTime() >= hi) continue;
        touched.add(day.getTime());
        const candidate = atLocalTime(day, cfg.summaryAt);
        if (candidate.getTime() >= occ.start.getTime() && candidate.getTime() < occ.end.getTime()) quietAt.add(day.getTime());
      }
    }
  }
  if (touched.size === 0) return null;
  for (const day of touched) if (!quietAt.has(day)) return null;
  return `The summary time ${cfg.summaryAt} is inside the quiet period on every day it occurs, so a summary could never go out on time. Pick a time outside it, or leave it blank to send when each period ends.`;
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

type HoldPolicy = { held?: Record<string, HeldKinds> | null; holds?: "all" | "followUps" | null; severities?: string[] | null };

function anyKind(k: HeldKinds): boolean {
  return k.alerts || k.alertReminders || k.escalations || k.escalationReminders;
}

/** LEGACY reading: does the policy hold the FIRST alert? "followUps" lets it
 *  through and quiets only the reminders and escalation tiers. With `held`
 *  present the answer is per severity — see `quietHoldsSend`. */
export function quietHoldsFires(cfg: HoldPolicy): boolean {
  if (cfg.held) return Object.values(cfg.held).some((k) => k.alerts);
  return cfg.holds !== "followUps";
}

/**
 * What the policy holds for one severity, or null when it holds nothing of
 * that severity. The per-severity `held` map answers directly; a legacy row
 * derives it from `severities` + `holds` (all four kinds, or all but the
 * first alert).
 */
export function heldKindsFor(cfg: HoldPolicy, severity: string): HeldKinds | null {
  if (cfg.held) {
    const k = cfg.held[severity];
    return k && anyKind(k) ? k : null;
  }
  if (cfg.severities && !cfg.severities.includes(severity)) return null;
  const fires = cfg.holds !== "followUps";
  return { alerts: fires, alertReminders: true, escalations: true, escalationReminders: true };
}

/** Does the policy hold THIS send of THIS severity? The one question the hold
 *  decision asks of a policy once the window is known to be open. */
export function quietHoldsSend(cfg: HoldPolicy, severity: string, send: QuietSend): boolean {
  const k = heldKindsFor(cfg, severity);
  return !!k && k[SEND_TO_KIND[send]];
}

/** Is `severity` one the policy holds anything of? */
export function quietHoldsSeverity(cfg: HoldPolicy, severity: string): boolean {
  return heldKindsFor(cfg, severity) !== null;
}

/** The severities the policy holds anything of; null = every severity. */
export function quietHeldSeverities(cfg: HoldPolicy): string[] | null {
  if (cfg.held) return Object.keys(cfg.held).filter((s) => anyKind(cfg.held![s]!));
  return cfg.severities ?? null;
}

/** Is an alert of `metric` one the policy holds? A null list holds every kind;
 *  an alert with no metric (event/change) is held only by "any". */
export function quietHoldsKind(cfg: { alertKinds?: string[] | null }, metric: string | null | undefined): boolean {
  if (!cfg.alertKinds) return true;
  return !!metric && cfg.alertKinds.includes(metric);
}
