/**
 * tests/unit/quietTimeScheduleService.test.ts
 *
 * The global quiet-time schedules (business rule 92) as the Settings tab sees
 * them: the at-a-glance state computed in the server's wall clock (quiet now
 * and until when, else the soonest next window across all windows; an
 * unparseable config is flagged, never thrown), the newest summary per
 * schedule, the cache bump on every write so a new window is honoured on the
 * next fire, a delete that names the alerts it is holding (they keep their
 * stamp and flush), and the summary drill-down's per-reader counts.
 *
 * The quiet-window maths (utils/quietTime, utils/maintenanceRecurrence) and
 * the config schema run for real; times are built with the local-time Date
 * constructor because every time in the config is server-local.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  schedFindMany: vi.fn(),
  schedFindUnique: vi.fn(),
  schedCreate: vi.fn(),
  schedUpdate: vi.fn(),
  schedDelete: vi.fn(),
  sumFindMany: vi.fn(),
  sumFindUnique: vi.fn(),
  notifCount: vi.fn(),
  notifFindMany: vi.fn(),
  bump: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    quietTimeSchedule: {
      findMany: m.schedFindMany, findUnique: m.schedFindUnique, create: m.schedCreate,
      update: m.schedUpdate, delete: m.schedDelete,
    },
    quietTimeSummary: { findMany: m.sumFindMany, findUnique: m.sumFindUnique },
    notification: { count: m.notifCount, findMany: m.notifFindMany },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: m.logEvent }));
vi.mock("../../src/services/quietTimeHoldService.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/quietTimeHoldService.js")>()),
  bumpQuietTimeCache: m.bump,
}));

const svc = await import("../../src/services/quietTimeScheduleService.js");

const NIGHTLY = { version: 1, kind: "recurring", freq: "daily", startTime: "22:00", endTime: "06:00" };
const LUNCH = { version: 1, kind: "recurring", freq: "daily", startTime: "12:00", endTime: "13:00" };

function sched(over: Record<string, unknown> = {}) {
  return {
    id: "q1", name: "Nights", enabled: true, scope: {}, quiet: { windows: [NIGHTLY] },
    createdBy: "alice", createdAt: new Date(2026, 0, 1), updatedAt: new Date(2026, 0, 1),
    ...over,
  };
}
const input = (over: Record<string, unknown> = {}) =>
  ({ name: "Nights", scope: {}, quiet: { windows: [NIGHTLY] }, ...over }) as never;

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.sumFindMany.mockResolvedValue([]);
  m.schedCreate.mockImplementation(async (a: { data: Record<string, unknown> }) => sched({ ...a.data }));
  m.schedUpdate.mockImplementation(async (a: { data: Record<string, unknown> }) => sched({ ...a.data }));
});

// ─── The at-a-glance state ───────────────────────────────────────────────────

describe("the list's at-a-glance state", () => {
  it("inside a window: quiet now, and until when", async () => {
    m.schedFindUnique.mockResolvedValue(sched());
    const s = await svc.getQuietTimeSchedule("q1", new Date(2026, 10, 9, 23, 30));
    expect(s).toMatchObject({ configValid: true, inWindow: true, windowEnd: "2026-11-10T06:00", nextWindow: null });
  });

  it("outside every window: the SOONEST next window across all of them", async () => {
    m.schedFindUnique.mockResolvedValue(sched({ quiet: { windows: [NIGHTLY, LUNCH] } }));
    const s = await svc.getQuietTimeSchedule("q1", new Date(2026, 10, 9, 9, 0));
    expect(s).toMatchObject({ inWindow: false, windowEnd: null, nextWindow: { start: "2026-11-09T12:00", end: "2026-11-09T13:00" } });
  });

  it("flags a stored config that no longer parses instead of throwing", async () => {
    m.schedFindUnique.mockResolvedValue(sched({ quiet: { windows: [] } }));
    const s = await svc.getQuietTimeSchedule("q1", new Date(2026, 10, 9, 23, 30));
    expect(s).toMatchObject({ configValid: false, inWindow: false, nextWindow: null });
  });

  it("404s an unknown schedule", async () => {
    m.schedFindUnique.mockResolvedValue(null);
    await expect(svc.getQuietTimeSchedule("x")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("attaches each schedule's NEWEST global summary, or null", async () => {
    m.schedFindMany.mockResolvedValue([sched({ id: "q1" }), sched({ id: "q2" })]);
    m.sumFindMany.mockResolvedValue([
      { sourceId: "q1", createdAt: new Date(2026, 10, 9), status: "sent", listedCount: 3, recurringCount: 0 },
      { sourceId: "q1", createdAt: new Date(2026, 10, 8), status: "sent", listedCount: 9, recurringCount: 1 },
    ]);
    const rows = await svc.listQuietTimeSchedules(new Date(2026, 10, 9, 9, 0));
    expect(m.sumFindMany.mock.calls[0][0].where).toEqual({ sourceKind: "global", sourceId: { in: ["q1", "q2"] } });
    expect(rows[0].lastSummary).toMatchObject({ listedCount: 3 });
    expect(rows[1].lastSummary).toBeNull();
  });
});

// ─── Writes ──────────────────────────────────────────────────────────────────

describe("writes bump the hold cache and are audited", () => {
  it("create defaults to enabled, records the creator and bumps the cache", async () => {
    await svc.createQuietTimeSchedule(input(), "alice");
    expect(m.schedCreate.mock.calls[0][0].data).toMatchObject({ enabled: true, createdBy: "alice" });
    expect(m.bump).toHaveBeenCalledTimes(1);
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "quiet_time.created", details: expect.objectContaining({ windows: 1 }) }));
  });

  it("create honours an explicit enabled:false", async () => {
    await svc.createQuietTimeSchedule(input({ enabled: false }));
    expect(m.schedCreate.mock.calls[0][0].data.enabled).toBe(false);
  });

  it("update 404s an unknown schedule without bumping the cache", async () => {
    m.schedFindUnique.mockResolvedValue(null);
    await expect(svc.updateQuietTimeSchedule("x", input())).rejects.toMatchObject({ httpStatus: 404 });
    expect(m.bump).not.toHaveBeenCalled();
  });

  it("update names an enable/disable flip in the Event", async () => {
    m.schedFindUnique.mockResolvedValue({ id: "q1", name: "Nights", enabled: true });
    await svc.updateQuietTimeSchedule("q1", input({ enabled: false }), "alice");
    expect(m.bump).toHaveBeenCalledTimes(1);
    expect(m.logEvent.mock.calls[0][0].message).toBe('Global quiet time "Nights" updated (disabled)');
  });

  it("delete counts the alerts it is holding right now (they flush, they are not dropped)", async () => {
    m.schedFindUnique.mockResolvedValue({ id: "q1", name: "Nights" });
    m.notifCount.mockResolvedValue(4);
    await svc.deleteQuietTimeSchedule("q1", "alice");
    expect(m.notifCount.mock.calls[0][0].where).toEqual({
      quietSummarizedAt: null, quietHeldAt: { not: null }, quietSource: { path: ["id"], equals: "q1" },
    });
    expect(m.schedDelete).toHaveBeenCalledWith({ where: { id: "q1" } });
    expect(m.bump).toHaveBeenCalledTimes(1);
    expect(m.logEvent.mock.calls[0][0]).toMatchObject({
      action: "quiet_time.deleted", details: { heldAlerts: 4 }, message: expect.stringContaining("4 held alert(s) will be summarised now"),
    });
  });
});

// ─── Summaries ───────────────────────────────────────────────────────────────

describe("summary review", () => {
  it("clamps the recent-summaries limit to 1..100 and carries only the live COUNT", async () => {
    m.sumFindMany.mockResolvedValue([{ id: "s1", details: { live: [{}, {}] } }, { id: "s2", details: null }]);
    const rows = await svc.listQuietTimeSummaries(500);
    expect(m.sumFindMany.mock.calls[0][0].take).toBe(100);
    expect(rows).toEqual([{ id: "s1", liveCount: 2 }, { id: "s2", liveCount: 0 }]);
    await svc.listQuietTimeSummaries(0);
    expect(m.sumFindMany.mock.calls[1][0].take).toBe(1);
  });

  it("404s an unknown summary", async () => {
    m.sumFindUnique.mockResolvedValue(null);
    await expect(svc.getQuietTimeSummary("x")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("reads covered alerts live, marks which were listed, and counts each reader's own copy (rule 92)", async () => {
    m.sumFindUnique.mockResolvedValue({
      id: "s1", notificationIds: ["n1", "n2", "n3"],
      details: {
        outstanding: [{ notificationId: "n1" }, { notificationId: "n2" }],
        recurring: [{ notificationIds: ["n3"] }],
        live: [{ notificationId: "n9" }],
        recurrenceThreshold: 3,
      },
      recipients: [
        { address: "all@example.com" },                                  // unfiltered: sees everything
        { address: "bob@example.com", alertIds: ["n2"], liveAlertIds: ["n9"] },
      ],
    });
    m.notifFindMany.mockResolvedValue([
      { id: "n1", rule: { name: "Down" } },
      { id: "n3", rule: null },
    ]);
    const r = await svc.getQuietTimeSummary("s1");
    expect(r.covered).toEqual([
      { id: "n1", ruleName: "Down", rule: undefined, listed: true },
      { id: "n3", ruleName: null, rule: undefined, listed: false },
    ]);
    expect(r.summary.recipients).toEqual([
      { address: "all@example.com", listedCount: 2, recurringCount: 1, liveCount: 1, filtered: false },
      { address: "bob@example.com", alertIds: ["n2"], liveAlertIds: ["n9"], listedCount: 1, recurringCount: 0, liveCount: 1, filtered: true },
    ]);
    expect(r.listed).toMatchObject({ recurrenceThreshold: 3, live: [{ notificationId: "n9" }] });
  });

  it("skips the covered-alert read for a summary that names none", async () => {
    m.sumFindUnique.mockResolvedValue({ id: "s1", notificationIds: [], details: null, recipients: null });
    const r = await svc.getQuietTimeSummary("s1");
    expect(m.notifFindMany).not.toHaveBeenCalled();
    expect(r.covered).toEqual([]);
    expect(r.summary.recipients).toEqual([]);
  });
});
