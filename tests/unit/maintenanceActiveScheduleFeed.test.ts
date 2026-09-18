/**
 * tests/unit/maintenanceActiveScheduleFeed.test.ts
 *
 * getActiveMaintenanceSchedules — the feed behind the Active Maintenance
 * dashboard widget (/dashboard/noc-summary?feeds=maintenanceSchedules).
 *
 * The load-bearing behaviour here is the FILTER rule, which is the opposite of
 * every other NOC feed's: a schedule matches when ANY of its devices is in
 * scope, and is then reported WHOLE (every device counted, every asset type
 * named), because a window covering switches, APs and servers is still the
 * window a switch-scoped board needs to know about. `matchedCount` is what
 * records how much of it the filter claimed.
 *
 * Prisma is a small in-memory fake answering the two query shapes this
 * function issues: `maintenanceSchedule.findMany({where:{enabled}})` and the
 * open-window GROUP BY (implemented here as the same aggregation over the fake
 * rows, honouring the bound id array). The clock is pinned with fake timers —
 * the recurrence math itself is covered in maintenanceRecurrence.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  type FakeAsset = { id: string; assetType: string };
  type FakeWindow = { assetId: string; scheduleId: string | null; endedAt: Date | null };
  type FakeSchedule = {
    id: string;
    name: string;
    enabled: boolean;
    criteria: unknown | null;
    assetIds: string[];
    schedule: unknown;
    suppressChildren: boolean;
  };

  const db = { assets: [] as FakeAsset[], windows: [] as FakeWindow[], schedules: [] as FakeSchedule[] };

  const prisma = {
    maintenanceSchedule: {
      findMany: async (args?: any) => {
        const enabled = args?.where?.enabled;
        return db.schedules
          .filter((s) => enabled === undefined || s.enabled === enabled)
          .map((s) => ({ ...s }));
      },
    },
    // The open-window GROUP BY, as JS: one row per (scheduleId, assetType)
    // with a total and a count of the ids the caller bound.
    $queryRawUnsafe: async (_sql: string, ids: string[]) => {
      const set = new Set(ids || []);
      const acc = new Map<string, { scheduleId: string; assetType: string; total: bigint; matched: bigint }>();
      for (const w of db.windows) {
        if (w.endedAt !== null || !w.scheduleId) continue;
        const a = db.assets.find((x) => x.id === w.assetId);
        if (!a) continue;
        const key = w.scheduleId + "|" + a.assetType;
        const row = acc.get(key) ?? { scheduleId: w.scheduleId, assetType: a.assetType, total: 0n, matched: 0n };
        row.total += 1n;
        if (set.has(a.id)) row.matched += 1n;
        acc.set(key, row);
      }
      return [...acc.values()];
    },
  };

  return { db, prisma, reset: () => { db.assets = []; db.windows = []; db.schedules = []; } };
});

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: vi.fn(async () => {}),
  logEventsBatch: vi.fn(async () => 0),
}));
vi.mock("../../src/services/tagAssignmentService.js", () => ({
  normalizeCriteria: vi.fn((raw: unknown) => (raw == null ? null : raw)),
  resolveMatchingAssetIds: vi.fn(async () => new Set<string>()),
}));

import { getActiveMaintenanceSchedules } from "../../src/services/maintenanceScheduleService.js";

const NOW = new Date(2026, 6, 10, 12, 0, 0); // 2026-07-10 12:00 local

/** One-shot 11:00–14:00 today — active at the pinned NOW. */
const ACTIVE = { version: 1, kind: "oneshot", startAt: "2026-07-10T11:00", endAt: "2026-07-10T14:00" };
/** One-shot 11:00–12:30 today — active, but ending before ACTIVE does. */
const ENDS_SOON = { version: 1, kind: "oneshot", startAt: "2026-07-10T11:00", endAt: "2026-07-10T12:30" };
/** One-shot that ended yesterday — no current occurrence. */
const PAST = { version: 1, kind: "oneshot", startAt: "2026-07-09T11:00", endAt: "2026-07-09T14:00" };
/** Daily 11:00–14:00 — recurring and active at NOW. */
const DAILY = { version: 1, kind: "recurring", freq: "daily", startTime: "11:00", endTime: "14:00" };

function schedule(id: string, shape: unknown, over: Partial<FakeScheduleOver> = {}) {
  return {
    id,
    name: over.name ?? `Schedule ${id}`,
    enabled: over.enabled ?? true,
    criteria: over.criteria ?? null,
    assetIds: over.assetIds ?? [],
    schedule: shape,
    suppressChildren: over.suppressChildren ?? true,
  };
}
interface FakeScheduleOver {
  name: string; enabled: boolean; criteria: unknown; assetIds: string[]; suppressChildren: boolean;
}

/** Put `assetType` device `id` in an open window for schedule `scheduleId`. */
function hold(scheduleId: string, id: string, assetType: string) {
  h.db.assets.push({ id, assetType });
  h.db.windows.push({ assetId: id, scheduleId, endedAt: null });
}

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("getActiveMaintenanceSchedules", () => {
  it("reports an in-window schedule with its device count, type breakdown and window end", async () => {
    h.db.schedules.push(schedule("s1", ACTIVE, { name: "Switch firmware" }));
    hold("s1", "a1", "switch");
    hold("s1", "a2", "switch");
    hold("s1", "a3", "access_point");

    const rows = await getActiveMaintenanceSchedules();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "s1",
      name: "Switch firmware",
      deviceCount: 3,
      matchedCount: 3,
      filtered: false,
      kind: "oneshot",
      adhoc: false,
      suppressChildren: true,
      // SERVER-LOCAL wall clock, never a UTC instant — a browser east of the
      // server must not re-render the window on another hour.
      startedAt: "2026-07-10T11:00",
      endsAt: "2026-07-10T14:00",
    });
    // …and the same end as a true instant, which is the only form a countdown
    // can be computed from.
    expect(new Date(rows[0]!.endsAtUtc!).getTime()).toBe(new Date(2026, 6, 10, 14, 0, 0).getTime());
    expect(rows[0]!.assetTypes).toEqual([
      { assetType: "switch", count: 2 },
      { assetType: "access_point", count: 1 },
    ]);
  });

  it("keeps a multi-type schedule WHOLE when the filter matches only one of its types", async () => {
    h.db.schedules.push(schedule("s1", ACTIVE));
    hold("s1", "sw1", "switch");
    hold("s1", "ap1", "access_point");
    hold("s1", "srv1", "server");

    // The widget's filter resolved to the switches only.
    const rows = await getActiveMaintenanceSchedules(50, ["sw1"]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deviceCount: 3, matchedCount: 1, filtered: true });
    expect(rows[0]!.assetTypes.map((t) => t.assetType).sort()).toEqual(["access_point", "server", "switch"]);
  });

  it("drops a schedule none of whose devices the filter matched", async () => {
    h.db.schedules.push(schedule("s1", ACTIVE));
    hold("s1", "sw1", "switch");

    expect(await getActiveMaintenanceSchedules(50, ["other-asset"])).toEqual([]);
  });

  it("never lists a disabled schedule, even one still holding open windows", async () => {
    h.db.schedules.push(schedule("s1", ACTIVE, { enabled: false }));
    hold("s1", "a1", "switch");

    expect(await getActiveMaintenanceSchedules()).toEqual([]);
  });

  it("lists a just-opened window with no devices yet, but not under a filter", async () => {
    // The reconcile runs every 30s, so a window can be open before any device
    // has entered it. Unfiltered that is worth showing; a filter has nothing
    // to match it against.
    h.db.schedules.push(schedule("s1", ACTIVE));

    const unfiltered = await getActiveMaintenanceSchedules();
    expect(unfiltered).toHaveLength(1);
    expect(unfiltered[0]).toMatchObject({ deviceCount: 0, assetTypes: [] });

    expect(await getActiveMaintenanceSchedules(50, ["sw1"])).toEqual([]);
  });

  it("keeps a schedule whose occurrence has passed while its rows are still open, with no end time", async () => {
    // The up-to-30s closing lag: the devices are still held, so the widget
    // must still say so — but there is no window end left to report.
    h.db.schedules.push(schedule("s1", PAST));
    hold("s1", "a1", "server");

    const rows = await getActiveMaintenanceSchedules();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deviceCount: 1, startedAt: null, endsAt: null, endsAtUtc: null });
  });

  it("orders soonest-ending first and sinks a schedule with no readable end", async () => {
    h.db.schedules.push(schedule("s1", ACTIVE, { name: "Ends at 14" }));
    hold("s1", "a1", "switch");
    h.db.schedules.push(schedule("s2", ENDS_SOON, { name: "Ends at 12:30" }));
    hold("s2", "a2", "switch");
    h.db.schedules.push(schedule("s3", PAST, { name: "No end" }));
    hold("s3", "a3", "switch");

    const rows = await getActiveMaintenanceSchedules();
    expect(rows.map((r) => r.name)).toEqual(["Ends at 12:30", "Ends at 14", "No end"]);
  });

  it("marks a recurring schedule's kind and an ad-hoc one-shot as ad-hoc", async () => {
    h.db.schedules.push(schedule("s1", DAILY));
    hold("s1", "a1", "switch");
    // Ad-hoc = one-shot + no criteria + exactly one explicit asset (the
    // status-pill "enter maintenance now" artifact).
    h.db.schedules.push(schedule("s2", ACTIVE, { assetIds: ["a2"] }));
    hold("s2", "a2", "server");

    const rows = await getActiveMaintenanceSchedules();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("s1")).toMatchObject({ kind: "recurring", adhoc: false });
    expect(byId.get("s2")).toMatchObject({ kind: "oneshot", adhoc: true });
  });

  it("applies the row cap after ordering", async () => {
    h.db.schedules.push(schedule("s1", ACTIVE, { name: "Later" }));
    hold("s1", "a1", "switch");
    h.db.schedules.push(schedule("s2", ENDS_SOON, { name: "Sooner" }));
    hold("s2", "a2", "switch");

    const rows = await getActiveMaintenanceSchedules(1);
    expect(rows.map((r) => r.name)).toEqual(["Sooner"]);
  });
});
