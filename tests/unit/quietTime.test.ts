/**
 * tests/unit/quietTime.test.ts
 *
 * Pure-function coverage for automation quiet time (business rule 44): the
 * config shape, "is it quiet now" across a midnight-spanning nightly window
 * and a weekend one, the resume time when two windows abut, and the prose the
 * reminder-policy sentence is built from.
 *
 * All times are server-local by design (the recurrence module's contract), so
 * every case constructs local Dates rather than parsing UTC strings.
 */

import { describe, it, expect } from "vitest";

import {
  quietConfigSchema,
  quietWindowNow,
  isQuietNow,
  quietResumesAt,
  describeQuietWindow,
  describeQuietTime,
  MAX_QUIET_WINDOWS,
  type QuietConfig,
} from "../../src/utils/quietTime.js";

// Local-time helper: (y, m 1-based, d, hh, mm)
function at(y: number, m: number, d: number, hh = 0, mm = 0): Date {
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

const quiet = (...windows: Record<string, unknown>[]): QuietConfig =>
  quietConfigSchema.parse({ windows });

// 22:00 → 06:00 every day: the shape nearly every quiet time takes.
const NIGHTLY = { version: 1, kind: "recurring", freq: "daily", startTime: "22:00", endTime: "06:00" };
// All day Saturday + Sunday.
const WEEKEND = { version: 1, kind: "recurring", freq: "weekly", daysOfWeek: [0, 6] };

describe("quietConfigSchema", () => {
  it("accepts one window and rejects an empty list", () => {
    expect(() => quiet(NIGHTLY)).not.toThrow();
    expect(() => quietConfigSchema.parse({ windows: [] })).toThrow();
  });

  it("caps the window count", () => {
    const one = { ...NIGHTLY };
    expect(() => quietConfigSchema.parse({ windows: Array(MAX_QUIET_WINDOWS).fill(one) })).not.toThrow();
    expect(() => quietConfigSchema.parse({ windows: Array(MAX_QUIET_WINDOWS + 1).fill(one) })).toThrow();
  });

  it("rejects an unknown key and a malformed window", () => {
    expect(() => quietConfigSchema.parse({ windows: [NIGHTLY], holdEscalation: true })).toThrow();
    // endTime without startTime is refused by the shared recurrence schema.
    expect(() => quietConfigSchema.parse({ windows: [{ version: 1, kind: "recurring", freq: "daily", endTime: "06:00" }] })).toThrow();
  });

  it("accepts a one-shot window — the API may express a single quiet weekend", () => {
    expect(() =>
      quiet({ version: 1, kind: "oneshot", startAt: "2026-08-29T18:00", endAt: "2026-08-31T06:00" }),
    ).not.toThrow();
  });
});

describe("isQuietNow", () => {
  const q = quiet(NIGHTLY);

  it("is quiet inside a midnight-spanning window, on both sides of midnight", () => {
    expect(isQuietNow(q, at(2026, 8, 25, 22, 0))).toBe(true);
    expect(isQuietNow(q, at(2026, 8, 25, 23, 59))).toBe(true);
    expect(isQuietNow(q, at(2026, 8, 26, 0, 30))).toBe(true);
    expect(isQuietNow(q, at(2026, 8, 26, 5, 59))).toBe(true);
  });

  it("is not quiet at the half-open end, nor in the working day", () => {
    // [start, end): 06:00 is the first minute reminders are allowed again.
    expect(isQuietNow(q, at(2026, 8, 26, 6, 0))).toBe(false);
    expect(isQuietNow(q, at(2026, 8, 26, 12, 0))).toBe(false);
    expect(isQuietNow(q, at(2026, 8, 25, 21, 59))).toBe(false);
  });

  it("takes any ONE of several windows as quiet", () => {
    const both = quiet(NIGHTLY, WEEKEND);
    // Saturday noon: the weekend window alone covers it.
    expect(at(2026, 8, 29).getDay()).toBe(6);
    expect(isQuietNow(both, at(2026, 8, 29, 12, 0))).toBe(true);
    // Tuesday noon: neither.
    expect(isQuietNow(both, at(2026, 8, 25, 12, 0))).toBe(false);
  });

  it("no quiet time at all is never quiet", () => {
    expect(isQuietNow(null, at(2026, 8, 26, 2, 0))).toBe(false);
    expect(isQuietNow(undefined, at(2026, 8, 26, 2, 0))).toBe(false);
  });

  it("reports the containing occurrence, not just a boolean", () => {
    const occ = quietWindowNow(quiet(NIGHTLY), at(2026, 8, 26, 2, 0));
    expect(occ?.start).toEqual(at(2026, 8, 25, 22, 0));
    expect(occ?.end).toEqual(at(2026, 8, 26, 6, 0));
  });
});

describe("quietResumesAt", () => {
  it("is the window's end when nothing follows it", () => {
    expect(quietResumesAt(quiet(NIGHTLY), at(2026, 8, 26, 2, 0))).toEqual(at(2026, 8, 26, 6, 0));
  });

  it("is null when it isn't quiet", () => {
    expect(quietResumesAt(quiet(NIGHTLY), at(2026, 8, 26, 12, 0))).toBeNull();
  });

  /**
   * The case the chaining exists for: nightly quiet beside an all-day
   * weekend. A Friday-night alert must not be told reminders resume Saturday
   * at 06:00 — Saturday is quiet all day, and so is Sunday, so the honest
   * answer is Monday 06:00.
   */
  it("chains through abutting and overlapping windows", () => {
    const q = quiet(NIGHTLY, WEEKEND);
    expect(at(2026, 8, 28).getDay()).toBe(5); // Friday
    const resumes = quietResumesAt(q, at(2026, 8, 28, 23, 0));
    // Fri 22:00–Sat 06:00, then all Sat, then all Sun, then Sun 22:00–Mon 06:00.
    expect(resumes).toEqual(at(2026, 8, 31, 6, 0));
  });
});

describe("describeQuietWindow / describeQuietTime", () => {
  it("names a daily window and a weekly one", () => {
    expect(describeQuietWindow(quietConfigSchema.parse({ windows: [NIGHTLY] }).windows[0]!))
      .toBe("daily 22:00–06:00");
    expect(describeQuietWindow(quietConfigSchema.parse({ windows: [WEEKEND] }).windows[0]!))
      .toBe("Sun, Sat all day");
  });

  it("spells out one or two windows and counts more", () => {
    expect(describeQuietTime(quiet(NIGHTLY))).toBe("daily 22:00–06:00");
    expect(describeQuietTime(quiet(NIGHTLY, WEEKEND))).toBe("daily 22:00–06:00 and Sun, Sat all day");
    expect(describeQuietTime(quiet(NIGHTLY, WEEKEND, NIGHTLY))).toBe("3 quiet periods");
  });

  it("is empty with no quiet time, so the policy sentence prunes it away", () => {
    expect(describeQuietTime(null)).toBe("");
  });

  it("groups days that keep the same hours, in calendar order", () => {
    // Nights Mon–Wed, all day at the weekend — one window, not four.
    const w = quietConfigSchema.parse({
      windows: [{
        version: 1, kind: "recurring", freq: "weekly",
        daysOfWeek: [0, 1, 2, 3, 6],
        hours: [{ startTime: "22:00", endTime: "06:00" }],
        hoursByDay: [{ dow: 0, hours: [] }, { dow: 6, hours: [] }],
      }],
    }).windows[0]!;
    expect(describeQuietWindow(w)).toBe("Sun all day; Mon, Tue, Wed 22:00–06:00; Sat all day");
  });

  it("lists several ranges on one line", () => {
    const w = quietConfigSchema.parse({
      windows: [{
        version: 1, kind: "recurring", freq: "daily",
        hours: [{ startTime: "22:00", endTime: "06:00" }, { startTime: "12:00", endTime: "13:00" }],
      }],
    }).windows[0]!;
    expect(describeQuietWindow(w)).toBe("daily 22:00–06:00, 12:00–13:00");
  });
});

/**
 * Per-day hours are what let ONE window say "nights during the week, all
 * weekend" — the configuration that used to need two, and the reason the
 * wizard now edits a single window instead of a list.
 */
describe("a single window with per-day hours", () => {
  const weekNightsAndWeekend = quiet({
    version: 1, kind: "recurring", freq: "weekly",
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    hours: [{ startTime: "22:00", endTime: "06:00" }],
    hoursByDay: [{ dow: 0, hours: [] }, { dow: 6, hours: [] }],
  });

  it("is quiet overnight on a weekday and all day at the weekend", () => {
    expect(isQuietNow(weekNightsAndWeekend, at(2026, 8, 25, 23, 0))).toBe(true); // Tue night
    expect(isQuietNow(weekNightsAndWeekend, at(2026, 8, 25, 14, 0))).toBe(false); // Tue afternoon
    expect(at(2026, 8, 29).getDay()).toBe(6);
    expect(isQuietNow(weekNightsAndWeekend, at(2026, 8, 29, 14, 0))).toBe(true); // Saturday
  });

  it("chains a Friday-night alert through the whole weekend", () => {
    // Fri 22:00 → Sat 06:00 OVERLAPS all-day Saturday, which abuts all-day
    // Sunday: one unbroken stretch of silence from Friday night.
    expect(at(2026, 8, 28).getDay()).toBe(5);
    // It ends at MIDNIGHT on Monday, not 06:00 — and that is the START-day
    // rule doing exactly what it says. Sunday's own hours are "all day", which
    // replaces the 22:00–06:00 range rather than adding to it, so nothing
    // covers Monday 00:00–06:00: Monday's range starts on MONDAY at 22:00.
    // An operator who wants the weekend to run into Monday morning gives
    // Sunday the hours 22:00–06:00 instead of all-day, or adds them to it.
    expect(quietResumesAt(weekNightsAndWeekend, at(2026, 8, 28, 23, 30))).toEqual(at(2026, 8, 31, 0, 0));
  });
});
