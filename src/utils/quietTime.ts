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
  type MaintenanceOccurrence,
  type MaintenanceScheduleShape,
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

/** "22:00–06:00" / "all day" — the time half of a window's description. */
function timePhrase(startTime?: string, endTime?: string): string {
  return startTime && endTime ? `${startTime}–${endTime}` : "all day";
}

/**
 * One window in words: "daily 22:00–06:00", "Sat, Sun all day".
 *
 * Terse on purpose. This text goes into `{repeat.policy}` — a sentence inside
 * an alert email, read by someone who wants to know when the next reminder is
 * coming, not into a schedule editor. The browser's own summary of the same
 * shape (`PolarisRecurrence.summary`, assets-maintenance.js) is the richer one
 * and is what the wizard shows while the operator is building the window.
 */
export function describeQuietWindow(w: MaintenanceScheduleShape): string {
  if (w.kind === "oneshot") {
    return `${w.startAt.replace("T", " ")} – ${w.endAt.replace("T", " ")}`;
  }
  const time = timePhrase(w.startTime, w.endTime);
  switch (w.freq) {
    case "daily":
      return `daily ${time}`;
    case "weekly": {
      const days = (w.daysOfWeek ?? [])
        .slice()
        .sort((a, b) => a - b)
        .map((d) => WEEKDAY_LABELS[d] ?? String(d))
        .join(", ");
      return days ? `${days} ${time}` : `weekly ${time}`;
    }
    case "monthly":
      return `day ${w.dayOfMonth} of each month, ${time}`;
    case "yearly":
      return `${MONTH_LABELS[(w.month ?? 1) - 1]} ${w.day} each year, ${time}`;
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
