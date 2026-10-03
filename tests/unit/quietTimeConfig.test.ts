/**
 * tests/unit/quietTimeConfig.test.ts
 *
 * The quiet-time POLICY shape (business rule 92): the config a global schedule
 * or an automation carries, the one cross-field rule it has — the summary time
 * may not fall inside a quiet period — and the arithmetic that turns a window
 * end into the summary's send time. Pure functions; all times server-local,
 * as the recurrence module's contract requires.
 */

import { describe, it, expect } from "vitest";

import {
  quietTimeConfigSchema,
  summaryTimeConflicts,
  summarySendAt,
  quietHoldsSeverity,
  quietHoldsKind,
  quietHoldsFires,
  MAX_QUIET_WINDOWS,
} from "../../src/utils/quietTime.js";

function at(y: number, m: number, d: number, hh = 0, mm = 0): Date {
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

const NIGHTLY = { version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "22:00", endTime: "06:00" }] };
const LUNCH = { version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "12:00", endTime: "13:00" }] };
const WEEKEND = { version: 1, kind: "recurring", freq: "weekly", daysOfWeek: [0, 6] };
const MONTHLY = { version: 1, kind: "recurring", freq: "monthly", dayOfMonth: 1, hours: [{ startTime: "01:00", endTime: "03:00" }] };

describe("quietTimeConfigSchema", () => {
  it("accepts the minimal policy and fills nothing in", () => {
    const cfg = quietTimeConfigSchema.parse({ windows: [NIGHTLY] });
    expect(cfg.windows).toHaveLength(1);
    expect(cfg.severities).toBeUndefined();
    expect(cfg.summaryAt).toBeUndefined();
  });

  it("accepts the full policy", () => {
    const cfg = quietTimeConfigSchema.parse({
      windows: [NIGHTLY, LUNCH],
      holds: "followUps",
      severities: ["notice", "warning", "serious"],
      alertKinds: ["cpuPct", "monitorStatus"],
      summaryAt: "07:30",
      summaryChannelId: "ch-1",
      recurrenceThreshold: 3,
    });
    expect(cfg.recurrenceThreshold).toBe(3);
  });

  it("refuses an empty window list, an unknown key, a bad time and a zero threshold", () => {
    expect(() => quietTimeConfigSchema.parse({ windows: [] })).toThrow();
    expect(() => quietTimeConfigSchema.parse({ windows: [NIGHTLY], holdScripts: true })).toThrow();
    expect(() => quietTimeConfigSchema.parse({ windows: [NIGHTLY], summaryAt: "7:30" })).toThrow();
    expect(() => quietTimeConfigSchema.parse({ windows: [NIGHTLY], recurrenceThreshold: 0 })).toThrow();
    expect(() => quietTimeConfigSchema.parse({ windows: Array(MAX_QUIET_WINDOWS + 1).fill(NIGHTLY) })).toThrow();
  });

  it("refuses a summary time inside a quiet period, naming the period", () => {
    const r = quietTimeConfigSchema.safeParse({ windows: [NIGHTLY], summaryAt: "05:00" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.path).toEqual(["summaryAt"]);
      expect(r.error.issues[0]!.message).toMatch(/05:00 falls inside a quiet period/);
      expect(r.error.issues[0]!.message).toMatch(/22:00–06:00/);
    }
  });
});

describe("summaryTimeConflicts", () => {
  it("is null with no summary time at all", () => {
    expect(summaryTimeConflicts({ windows: [NIGHTLY as never] })).toBeNull();
  });

  it("is null for a time outside every window", () => {
    expect(summaryTimeConflicts({ windows: [NIGHTLY, LUNCH] as never, summaryAt: "07:30" })).toBeNull();
    expect(summaryTimeConflicts({ windows: [NIGHTLY, LUNCH] as never, summaryAt: "13:00" })).toBeNull(); // half-open end
  });

  it("catches both sides of a midnight-spanning window", () => {
    expect(summaryTimeConflicts({ windows: [NIGHTLY] as never, summaryAt: "23:30" })).toMatch(/falls inside/);
    expect(summaryTimeConflicts({ windows: [NIGHTLY] as never, summaryAt: "05:59" })).toMatch(/falls inside/);
    expect(summaryTimeConflicts({ windows: [NIGHTLY] as never, summaryAt: "22:00" })).toMatch(/falls inside/); // inclusive start
  });

  it("catches an all-day weekend window at any time, and a monthly window on its day", () => {
    expect(summaryTimeConflicts({ windows: [WEEKEND] as never, summaryAt: "14:00" })).toMatch(/falls inside/);
    expect(summaryTimeConflicts({ windows: [MONTHLY] as never, summaryAt: "02:00" })).toMatch(/falls inside/);
    expect(summaryTimeConflicts({ windows: [MONTHLY] as never, summaryAt: "03:00" })).toBeNull();
  });

  it("ignores a one-shot window that has already passed", () => {
    const past = { version: 1, kind: "oneshot", startAt: "2020-01-01T00:00", endAt: "2020-01-02T00:00" };
    expect(summaryTimeConflicts({ windows: [past] as never, summaryAt: "12:00" }, at(2026, 10, 3, 9))).toBeNull();
  });
});

describe("summarySendAt", () => {
  const end = at(2026, 10, 3, 6, 0); // the nightly window's end, a Saturday

  it("is the window end when no time is set", () => {
    expect(summarySendAt({}, end)).toEqual(end);
    expect(summarySendAt({ summaryAt: null }, end)).toEqual(end);
  });

  it("is the same day's time when that is at or after the end", () => {
    expect(summarySendAt({ summaryAt: "07:30" }, end)).toEqual(at(2026, 10, 3, 7, 30));
    expect(summarySendAt({ summaryAt: "06:00" }, end)).toEqual(end);
  });

  it("rolls to the next day when the time has already passed — a daily appointment, not an offset", () => {
    expect(summarySendAt({ summaryAt: "07:30" }, at(2026, 10, 3, 13, 0))).toEqual(at(2026, 10, 4, 7, 30));
  });
});

describe("quietHoldsSeverity / quietHoldsKind / quietHoldsFires", () => {
  it("a null list holds everything", () => {
    expect(quietHoldsSeverity({}, "critical")).toBe(true);
    expect(quietHoldsKind({}, null)).toBe(true);
  });

  it("holds the first alert unless the policy says follow-ups only", () => {
    expect(quietHoldsFires({})).toBe(true);
    expect(quietHoldsFires({ holds: "all" })).toBe(true);
    expect(quietHoldsFires({ holds: "followUps" })).toBe(false);
  });

  it("a list holds only its members, and an alert with no metric matches only 'any'", () => {
    expect(quietHoldsSeverity({ severities: ["warning", "serious"] }, "critical")).toBe(false);
    expect(quietHoldsSeverity({ severities: ["warning", "serious"] }, "serious")).toBe(true);
    expect(quietHoldsKind({ alertKinds: ["cpuPct"] }, "cpuPct")).toBe(true);
    expect(quietHoldsKind({ alertKinds: ["cpuPct"] }, "monitorStatus")).toBe(false);
    expect(quietHoldsKind({ alertKinds: ["cpuPct"] }, null)).toBe(false);
  });
});
