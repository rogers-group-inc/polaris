/**
 * tests/unit/maintenanceRecurrence.test.ts
 *
 * Pure-function coverage for the maintenance-schedule recurrence math:
 * shape validation, one-shot bounds, daily/weekly/monthly/yearly matching,
 * midnight-crossing time ranges (start-day semantics), all-day occurrences,
 * activeFrom/activeUntil bounds, short-month day clamping, and the
 * currentWindow occurrence identity used by the operator-release check.
 * All times are server-local by design — tests construct local Dates.
 */

import { describe, it, expect } from "vitest";

import {
  validateScheduleShape,
  resolveStartNow,
  serverClockInfo,
  formatLocalIsoMinute,
  isInWindow,
  currentWindow,
  nextWindow,
  expandOccurrences,
  parseLocalDay,
  type MaintenanceScheduleShape,
} from "../../src/utils/maintenanceRecurrence.js";

// Local-time helper: (y, m 1-based, d, hh, mm)
function at(y: number, m: number, d: number, hh = 0, mm = 0): Date {
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

const oneshot = (startAt: string, endAt: string): MaintenanceScheduleShape =>
  validateScheduleShape({ version: 1, kind: "oneshot", startAt, endAt });

const recurring = (extra: Record<string, unknown>): MaintenanceScheduleShape =>
  validateScheduleShape({ version: 1, kind: "recurring", ...extra });

// ─── validateScheduleShape ──────────────────────────────────────────────────

describe("validateScheduleShape", () => {
  it("accepts a one-shot and rejects end-before-start", () => {
    expect(() => oneshot("2026-07-12T22:00", "2026-07-13T02:00")).not.toThrow();
    expect(() => oneshot("2026-07-13T02:00", "2026-07-12T22:00")).toThrow();
  });

  it("rejects timezone-suffixed datetimes (server-local only)", () => {
    expect(() =>
      validateScheduleShape({ version: 1, kind: "oneshot", startAt: "2026-07-12T22:00:00Z", endAt: "2026-07-13T02:00:00Z" }),
    ).toThrow();
  });

  it("requires daysOfWeek for weekly, dayOfMonth for monthly, month+day for yearly", () => {
    expect(() => recurring({ freq: "weekly" })).toThrow();
    expect(() => recurring({ freq: "weekly", daysOfWeek: [0, 6] })).not.toThrow();
    expect(() => recurring({ freq: "monthly" })).toThrow();
    expect(() => recurring({ freq: "monthly", dayOfMonth: 15 })).not.toThrow();
    expect(() => recurring({ freq: "yearly", month: 7 })).toThrow();
    expect(() => recurring({ freq: "yearly", month: 7, day: 4 })).not.toThrow();
  });

  it("requires startTime and endTime together", () => {
    expect(() => recurring({ freq: "daily", startTime: "22:00" })).toThrow();
    expect(() => recurring({ freq: "daily", startTime: "22:00", endTime: "02:00" })).not.toThrow();
  });

  it("rejects inverted active bounds", () => {
    expect(() =>
      recurring({ freq: "daily", activeFrom: "2026-08-01", activeUntil: "2026-07-01" }),
    ).toThrow();
  });
});

// ─── one-shot ───────────────────────────────────────────────────────────────

describe("oneshot windows", () => {
  const s = oneshot("2026-07-12T22:00", "2026-07-13T02:00");

  it("is active inside [start, end) and inactive outside", () => {
    expect(isInWindow(s, at(2026, 7, 12, 21, 59))).toBe(false);
    expect(isInWindow(s, at(2026, 7, 12, 22, 0))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 13, 1, 59))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 13, 2, 0))).toBe(false); // half-open
  });

  it("currentWindow returns the literal bounds", () => {
    const w = currentWindow(s, at(2026, 7, 12, 23, 0))!;
    expect(w.start).toEqual(at(2026, 7, 12, 22, 0));
    expect(w.end).toEqual(at(2026, 7, 13, 2, 0));
  });

  it("nextWindow returns the window while upcoming/active, null after it passes", () => {
    expect(nextWindow(s, at(2026, 7, 1))!.start).toEqual(at(2026, 7, 12, 22, 0));
    expect(nextWindow(s, at(2026, 7, 13, 1, 0))!.end).toEqual(at(2026, 7, 13, 2, 0));
    expect(nextWindow(s, at(2026, 7, 13, 3, 0))).toBeNull();
  });
});

// ─── daily ──────────────────────────────────────────────────────────────────

describe("daily recurrence", () => {
  it("all-day daily is always in window", () => {
    const s = recurring({ freq: "daily" });
    expect(isInWindow(s, at(2026, 7, 10, 0, 0))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 10, 23, 59))).toBe(true);
  });

  it("time-ranged daily matches only inside the range", () => {
    const s = recurring({ freq: "daily", startTime: "22:00", endTime: "23:00" });
    expect(isInWindow(s, at(2026, 7, 10, 21, 59))).toBe(false);
    expect(isInWindow(s, at(2026, 7, 10, 22, 30))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 10, 23, 0))).toBe(false);
  });

  it("midnight-crossing range ends the FOLLOWING day", () => {
    const s = recurring({ freq: "daily", startTime: "22:00", endTime: "02:00" });
    expect(isInWindow(s, at(2026, 7, 10, 23, 30))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 11, 1, 30))).toBe(true); // yesterday's occurrence
    expect(isInWindow(s, at(2026, 7, 11, 2, 0))).toBe(false);
    // the occurrence containing 01:30 STARTED yesterday
    const w = currentWindow(s, at(2026, 7, 11, 1, 30))!;
    expect(w.start).toEqual(at(2026, 7, 10, 22, 0));
    expect(w.end).toEqual(at(2026, 7, 11, 2, 0));
  });
});

// ─── weekly ─────────────────────────────────────────────────────────────────

describe("weekly recurrence", () => {
  // 2026-07-11 is a Saturday (6); 2026-07-12 is a Sunday (0).
  const s = recurring({ freq: "weekly", daysOfWeek: [6, 0], startTime: "22:00", endTime: "02:00" });

  it("matches only listed days (window start day)", () => {
    expect(isInWindow(s, at(2026, 7, 10, 23, 0))).toBe(false); // Friday
    expect(isInWindow(s, at(2026, 7, 11, 23, 0))).toBe(true); // Saturday
    expect(isInWindow(s, at(2026, 7, 12, 23, 0))).toBe(true); // Sunday
    expect(isInWindow(s, at(2026, 7, 13, 23, 0))).toBe(false); // Monday
  });

  it("midnight span is matched on the START day: Sun 01:00 belongs to Saturday's window", () => {
    // Sunday 01:00 — inside Saturday 22:00 → Sunday 02:00
    expect(isInWindow(s, at(2026, 7, 12, 1, 0))).toBe(true);
    // Monday 01:00 — inside Sunday's window (Sunday is listed)
    expect(isInWindow(s, at(2026, 7, 13, 1, 0))).toBe(true);
    // Tuesday 01:00 — Monday isn't listed
    expect(isInWindow(s, at(2026, 7, 14, 1, 0))).toBe(false);
  });

  it("nextWindow scans forward to the next listed day", () => {
    const w = nextWindow(s, at(2026, 7, 8, 12, 0))!; // Wednesday
    expect(w.start).toEqual(at(2026, 7, 11, 22, 0)); // Saturday
  });
});

// ─── monthly ────────────────────────────────────────────────────────────────

describe("monthly recurrence", () => {
  it("matches the configured day of month", () => {
    const s = recurring({ freq: "monthly", dayOfMonth: 15 });
    expect(isInWindow(s, at(2026, 7, 15, 12, 0))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 14, 12, 0))).toBe(false);
  });

  it("clamps day 31 to short months (Feb 28 in non-leap years)", () => {
    const s = recurring({ freq: "monthly", dayOfMonth: 31 });
    expect(isInWindow(s, at(2026, 2, 28, 12, 0))).toBe(true); // 2026 non-leap
    expect(isInWindow(s, at(2026, 4, 30, 12, 0))).toBe(true); // April
    expect(isInWindow(s, at(2026, 4, 29, 12, 0))).toBe(false);
    expect(isInWindow(s, at(2028, 2, 29, 12, 0))).toBe(true); // 2028 leap
    expect(isInWindow(s, at(2028, 2, 28, 12, 0))).toBe(false);
  });
});

// ─── yearly ─────────────────────────────────────────────────────────────────

describe("yearly recurrence", () => {
  it("matches month+day each year", () => {
    const s = recurring({ freq: "yearly", month: 7, day: 4, startTime: "06:00", endTime: "18:00" });
    expect(isInWindow(s, at(2026, 7, 4, 12, 0))).toBe(true);
    expect(isInWindow(s, at(2027, 7, 4, 12, 0))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 5, 12, 0))).toBe(false);
    expect(isInWindow(s, at(2026, 8, 4, 12, 0))).toBe(false);
  });

  it("nextWindow crosses a year boundary", () => {
    const s = recurring({ freq: "yearly", month: 1, day: 1 });
    const w = nextWindow(s, at(2026, 7, 10))!;
    expect(w.start).toEqual(at(2027, 1, 1));
  });
});

// ─── active bounds ──────────────────────────────────────────────────────────

describe("activeFrom / activeUntil", () => {
  const s = recurring({ freq: "daily", activeFrom: "2026-07-10", activeUntil: "2026-07-12" });

  it("inactive before activeFrom and after activeUntil (inclusive bounds)", () => {
    expect(isInWindow(s, at(2026, 7, 9, 12, 0))).toBe(false);
    expect(isInWindow(s, at(2026, 7, 10, 0, 0))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 12, 23, 59))).toBe(true);
    expect(isInWindow(s, at(2026, 7, 13, 0, 0))).toBe(false);
  });

  it("nextWindow returns null after activeUntil", () => {
    expect(nextWindow(s, at(2026, 7, 14))).toBeNull();
  });

  it("bounds apply to the occurrence START day for midnight spans", () => {
    const t = recurring({
      freq: "daily", startTime: "22:00", endTime: "02:00",
      activeFrom: "2026-07-10", activeUntil: "2026-07-10",
    });
    // Jul 10 22:00 → Jul 11 02:00 runs to completion even though activeUntil is Jul 10
    expect(isInWindow(t, at(2026, 7, 11, 1, 0))).toBe(true);
    // …but no Jul 11 occurrence starts
    expect(isInWindow(t, at(2026, 7, 11, 23, 0))).toBe(false);
  });
});

describe("resolveStartNow", () => {
  it("stamps a oneshot startNow blob with the supplied server clock and strips the marker", () => {
    const now = new Date(2026, 6, 15, 13, 42, 30); // seconds truncate away
    const out = resolveStartNow({ version: 1, kind: "oneshot", startNow: true, endAt: "2026-07-15T19:00" }, now) as any;
    expect(out.startAt).toBe("2026-07-15T13:42");
    expect(out.startNow).toBeUndefined();
    expect(out.endAt).toBe("2026-07-15T19:00");
    // The resolved blob validates as a plain oneshot.
    expect(validateScheduleShape(out).kind).toBe("oneshot");
  });

  it("passes through non-oneshot, non-startNow, and non-object blobs untouched", () => {
    const recurring = { version: 1, kind: "recurring", freq: "daily" };
    expect(resolveStartNow(recurring)).toBe(recurring);
    const concrete = { version: 1, kind: "oneshot", startAt: "2026-07-15T09:00", endAt: "2026-07-15T10:00" };
    expect(resolveStartNow(concrete)).toBe(concrete);
    expect(resolveStartNow(null)).toBeNull();
    expect(resolveStartNow("x")).toBe("x");
  });
});

describe("formatLocalIsoMinute", () => {
  it("zero-pads and truncates to the minute", () => {
    expect(formatLocalIsoMinute(new Date(2026, 0, 5, 8, 7, 59))).toBe("2026-01-05T08:07");
  });
});

// ─── expandOccurrences (calendar tab) ───────────────────────────────────────

describe("expandOccurrences", () => {
  /** Compact "MM-DD HH:MM→MM-DD HH:MM" rendering so expectations stay readable. */
  const stamp = (d: Date) => formatLocalIsoMinute(d).slice(5).replace("T", " ");
  const render = (occs: Array<{ start: Date; end: Date }>) =>
    occs.map(o => `${stamp(o.start)}→${stamp(o.end)}`);

  it("returns a one-shot only when it overlaps the range", () => {
    const s = oneshot("2026-07-12T22:00", "2026-07-13T02:00");
    expect(expandOccurrences(s, at(2026, 7, 12), at(2026, 7, 14))).toHaveLength(1);
    // Half-open on both sides: a window ending exactly at the range start is out…
    expect(expandOccurrences(s, at(2026, 7, 13, 2), at(2026, 7, 14))).toHaveLength(0);
    // …and one starting exactly at the range end is out too.
    expect(expandOccurrences(s, at(2026, 7, 10), at(2026, 7, 12, 22))).toHaveLength(0);
  });

  it("expands a daily time range across the requested days", () => {
    const s = recurring({ freq: "daily", startTime: "20:00", endTime: "22:00" });
    expect(render(expandOccurrences(s, at(2026, 7, 1), at(2026, 7, 4)))).toEqual([
      "07-01 20:00→07-01 22:00",
      "07-02 20:00→07-02 22:00",
      "07-03 20:00→07-03 22:00",
    ]);
  });

  it("includes a midnight-spanning occurrence that STARTED before the range", () => {
    // 22:00 → 02:00 daily: the window bleeding into the range's first morning
    // starts the previous day, which a naive from-the-range-start scan misses.
    const s = recurring({ freq: "daily", startTime: "22:00", endTime: "02:00" });
    const occs = expandOccurrences(s, at(2026, 7, 2), at(2026, 7, 3));
    expect(render(occs)).toEqual([
      "07-01 22:00→07-02 02:00",
      "07-02 22:00→07-03 02:00",
    ]);
  });

  it("emits all-day occurrences as [midnight, next midnight)", () => {
    const s = recurring({ freq: "weekly", daysOfWeek: [6] }); // Saturdays
    expect(render(expandOccurrences(s, at(2026, 7, 1), at(2026, 7, 15)))).toEqual([
      "07-04 00:00→07-05 00:00",
      "07-11 00:00→07-12 00:00",
    ]);
  });

  it("honors activeFrom/activeUntil bounds", () => {
    const s = recurring({
      freq: "daily", startTime: "01:00", endTime: "02:00",
      activeFrom: "2026-07-03", activeUntil: "2026-07-04",
    });
    expect(render(expandOccurrences(s, at(2026, 7, 1), at(2026, 7, 10)))).toEqual([
      "07-03 01:00→07-03 02:00",
      "07-04 01:00→07-04 02:00",
    ]);
  });

  it("truncates at maxOccurrences and returns nothing for an inverted range", () => {
    const s = recurring({ freq: "daily", startTime: "01:00", endTime: "02:00" });
    expect(expandOccurrences(s, at(2026, 7, 1), at(2026, 7, 30), 5)).toHaveLength(5);
    expect(expandOccurrences(s, at(2026, 7, 30), at(2026, 7, 1))).toHaveLength(0);
  });
});

describe("parseLocalDay", () => {
  it("parses a day string as server-local midnight", () => {
    expect(parseLocalDay("2026-07-12").getTime()).toBe(at(2026, 7, 12).getTime());
  });
});

describe("serverClockInfo", () => {
  it("reports the wall clock as the local-ISO minute the shapes carry", () => {
    const now = new Date(2026, 7, 19, 14, 30, 45, 123);
    expect(serverClockInfo(now).now).toBe("2026-08-19T14:30");
  });

  it("reports the offset east-positive, opposite getTimezoneOffset's sign", () => {
    const now = new Date(2026, 7, 19, 14, 30);
    expect(serverClockInfo(now).offsetMinutes).toBe(-now.getTimezoneOffset());
  });

  it("round-trips: parsing the reported wall clock back yields the same minute", () => {
    // This is the property the browser relies on to compute its skew — the
    // string must be re-readable as a wall clock, not as an instant.
    const now = new Date(2026, 1, 3, 9, 5);
    const parsed = validateScheduleShape({
      version: 1, kind: "oneshot",
      startAt: serverClockInfo(now).now,
      endAt: "2030-01-01T00:00",
    });
    expect((parsed as { startAt: string }).startAt).toBe("2026-02-03T09:05");
  });

  it("always names a zone or an empty string, never undefined", () => {
    const info = serverClockInfo(new Date(2026, 7, 19, 14, 30));
    expect(typeof info.timeZone).toBe("string");
  });
});

// ─── Per-day hour ranges ────────────────────────────────────────────────────

/**
 * A day carries a LIST of hour ranges now, and each range is its own
 * occurrence. The cases that matter are the ones where "one occurrence per
 * day" used to be load-bearing: currentWindow picking the CONTAINING range,
 * nextWindow skipping a range that is already over, and expandOccurrences
 * emitting several rows for one day.
 */
describe("hours[] — several ranges on every matched day", () => {
  const twice = recurring({
    freq: "daily",
    hours: [
      { startTime: "09:00", endTime: "11:00" },
      { startTime: "14:00", endTime: "16:00" },
    ],
  });

  it("is in window inside either range and out between them", () => {
    expect(isInWindow(twice, at(2026, 8, 25, 9, 30))).toBe(true);
    expect(isInWindow(twice, at(2026, 8, 25, 12, 0))).toBe(false);
    expect(isInWindow(twice, at(2026, 8, 25, 15, 0))).toBe(true);
    expect(isInWindow(twice, at(2026, 8, 25, 16, 0))).toBe(false); // half-open
  });

  it("identifies the CONTAINING range, not merely the day", () => {
    // Occurrence identity is what the operator-release check compares against,
    // so the afternoon window must not answer with the morning's start.
    expect(currentWindow(twice, at(2026, 8, 25, 15, 0))?.start).toEqual(at(2026, 8, 25, 14, 0));
    expect(currentWindow(twice, at(2026, 8, 25, 9, 30))?.start).toEqual(at(2026, 8, 25, 9, 0));
  });

  it("nextWindow skips a range that has already ended today", () => {
    expect(nextWindow(twice, at(2026, 8, 25, 12, 0))?.start).toEqual(at(2026, 8, 25, 14, 0));
    // After both, it rolls to tomorrow's first.
    expect(nextWindow(twice, at(2026, 8, 25, 17, 0))?.start).toEqual(at(2026, 8, 26, 9, 0));
  });

  it("expands to one occurrence PER RANGE per day", () => {
    const occs = expandOccurrences(twice, at(2026, 8, 25), at(2026, 8, 27));
    expect(occs).toHaveLength(4);
    expect(occs.map((o) => o.start.getHours())).toEqual([9, 14, 9, 14]);
  });

  it("caps on occurrences, not days", () => {
    expect(expandOccurrences(twice, at(2026, 8, 25), at(2026, 8, 30), 3)).toHaveLength(3);
  });

  it("still spans midnight, per range", () => {
    const overnight = recurring({
      freq: "daily",
      hours: [{ startTime: "22:00", endTime: "02:00" }, { startTime: "12:00", endTime: "13:00" }],
    });
    expect(isInWindow(overnight, at(2026, 8, 26, 1, 0))).toBe(true);
    expect(currentWindow(overnight, at(2026, 8, 26, 1, 0))?.start).toEqual(at(2026, 8, 25, 22, 0));
  });
});

describe("hoursByDay — different hours on different days", () => {
  // Nights on Mon/Tue with a lunchtime slot on Monday; Saturday all day.
  const perDay = recurring({
    freq: "weekly",
    daysOfWeek: [1, 2, 6],
    hours: [{ startTime: "22:00", endTime: "06:00" }],
    hoursByDay: [
      { dow: 1, hours: [{ startTime: "22:00", endTime: "06:00" }, { startTime: "12:00", endTime: "13:00" }] },
      { dow: 6, hours: [] },
    ],
  });

  it("uses the day's own hours where it has them", () => {
    expect(at(2026, 8, 24).getDay()).toBe(1); // Monday
    expect(isInWindow(perDay, at(2026, 8, 24, 12, 30))).toBe(true);
    // Tuesday has no entry of its own, so it falls back to `hours`.
    expect(at(2026, 8, 25).getDay()).toBe(2);
    expect(isInWindow(perDay, at(2026, 8, 25, 12, 30))).toBe(false);
    expect(isInWindow(perDay, at(2026, 8, 25, 23, 0))).toBe(true);
  });

  it("treats an EMPTY hours list as all day", () => {
    expect(at(2026, 8, 29).getDay()).toBe(6); // Saturday
    expect(isInWindow(perDay, at(2026, 8, 29, 3, 0))).toBe(true);
    expect(isInWindow(perDay, at(2026, 8, 29, 15, 0))).toBe(true);
    expect(currentWindow(perDay, at(2026, 8, 29, 15, 0))).toEqual({
      start: at(2026, 8, 29), end: at(2026, 8, 30),
    });
  });

  it("never matches a day the day selector excludes", () => {
    expect(at(2026, 8, 26).getDay()).toBe(3); // Wednesday, not selected
    expect(isInWindow(perDay, at(2026, 8, 26, 23, 0))).toBe(false);
  });
});

describe("hour-range validation", () => {
  it("refuses two ranges that overlap on the same day", () => {
    expect(() => recurring({
      freq: "daily",
      hours: [{ startTime: "09:00", endTime: "11:00" }, { startTime: "10:00", endTime: "12:00" }],
    })).toThrow();
    // Including the midnight-spanning pair, which reads as fine until you
    // carry the end past 24:00.
    expect(() => recurring({
      freq: "daily",
      hours: [{ startTime: "22:00", endTime: "06:00" }, { startTime: "23:00", endTime: "01:00" }],
    })).toThrow();
    // Per DAY: the same clash inside one hoursByDay entry.
    expect(() => recurring({
      freq: "weekly",
      daysOfWeek: [1],
      hoursByDay: [{ dow: 1, hours: [{ startTime: "09:00", endTime: "11:00" }, { startTime: "10:30", endTime: "12:00" }] }],
    })).toThrow();
  });

  it("allows ranges that merely abut, and ranges that overlap ACROSS days", () => {
    expect(() => recurring({
      freq: "daily",
      hours: [{ startTime: "09:00", endTime: "11:00" }, { startTime: "11:00", endTime: "12:00" }],
    })).not.toThrow();
    // Friday night running into an all-day Saturday — the most ordinary
    // schedule anyone writes, and it must not be refused as a typo.
    const weekend = recurring({
      freq: "weekly",
      daysOfWeek: [5, 6],
      hours: [{ startTime: "22:00", endTime: "06:00" }],
      hoursByDay: [{ dow: 6, hours: [] }],
    });
    expect(at(2026, 8, 28).getDay()).toBe(5); // Friday
    // Both occurrences contain Saturday 03:00; the answer is the earliest
    // STARTING one, deterministically.
    expect(currentWindow(weekend, at(2026, 8, 29, 3, 0))?.start).toEqual(at(2026, 8, 28, 22, 0));
  });

  it("refuses hours[] alongside the legacy startTime/endTime pair", () => {
    expect(() => recurring({
      freq: "daily",
      startTime: "22:00",
      endTime: "06:00",
      hours: [{ startTime: "09:00", endTime: "11:00" }],
    })).toThrow();
  });

  it("refuses hoursByDay on a monthly or yearly recurrence", () => {
    expect(() => recurring({
      freq: "monthly", dayOfMonth: 1,
      hoursByDay: [{ dow: 1, hours: [] }],
    })).toThrow();
  });

  it("refuses hours for a day the recurrence never matches, and a doubled day", () => {
    expect(() => recurring({
      freq: "weekly", daysOfWeek: [1],
      hoursByDay: [{ dow: 4, hours: [] }],
    })).toThrow();
    expect(() => recurring({
      freq: "weekly", daysOfWeek: [1],
      hoursByDay: [{ dow: 1, hours: [] }, { dow: 1, hours: [{ startTime: "09:00", endTime: "10:00" }] }],
    })).toThrow();
  });

  it("still accepts every shape written before per-day hours", () => {
    // parseStoredShape warns-and-SKIPS a schedule whose shape no longer
    // validates, so a rejection here would silently stop an existing
    // maintenance schedule from ever running again.
    expect(() => recurring({ freq: "daily", startTime: "22:00", endTime: "02:00" })).not.toThrow();
    expect(() => recurring({ freq: "weekly", daysOfWeek: [0, 6] })).not.toThrow();
    expect(() => recurring({ freq: "monthly", dayOfMonth: 31, startTime: "01:00", endTime: "03:00" })).not.toThrow();
  });
});
