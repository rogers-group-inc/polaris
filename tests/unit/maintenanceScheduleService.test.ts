/**
 * tests/unit/maintenanceScheduleService.test.ts
 *
 * Behavioral coverage for the maintenance reconcile (enter/exit diff against
 * open window rows, status parking/restore via maintenanceReturnStatus,
 * overlapping schedules, disabled/deleted/criteria-drop exits, operator-
 * release re-entry suppression, self-heal of clobbered statuses) plus the
 * CRUD-side validation and the immediate-entry-on-create path.
 *
 * Prisma is replaced by a small in-memory fake (assets + window rows +
 * schedules) that answers exactly the query shapes the service issues, so
 * the tests assert end-state like an integration test but run DB-free. The
 * wall clock is pinned with fake timers — recurrence math is covered
 * separately in maintenanceRecurrence.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  type FakeAsset = {
    id: string;
    hostname: string | null;
    ipAddress: string | null;
    model: string | null;
    manufacturer: string | null;
    status: string;
    maintenanceReturnStatus: string | null;
    monitored: boolean;
    statusChangedAt?: Date;
    statusChangedBy?: string;
  };
  type FakeWindow = {
    id: string;
    assetId: string;
    scheduleId: string | null;
    holdKind?: string | null;
    scheduleName: string;
    startedAt: Date;
    endedAt: Date | null;
    endReason: string | null;
  };
  type FakeSchedule = {
    id: string;
    name: string;
    enabled: boolean;
    criteria: unknown | null;
    assetIds: string[];
    schedule: unknown;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  };

  type FakeHold = {
    id: string;
    assetId: string;
    kind: string;
    label: string;
    startedAt: Date;
    expiresAt: Date;
    createdBy: string | null;
  };

  const db = {
    assets: [] as FakeAsset[],
    windows: [] as FakeWindow[],
    schedules: [] as FakeSchedule[],
    holds: [] as FakeHold[],
  };
  let seq = 1;
  const nextId = () => `gen-${seq++}`;

  function assetMatches(a: FakeAsset, where: any): boolean {
    if (!where) return true;
    if (where.id?.in && !where.id.in.includes(a.id)) return false;
    if (typeof where.id === "string" && a.id !== where.id) return false;
    if (where.monitored === true && !a.monitored) return false;
    if (where.status?.not && a.status === where.status.not) return false;
    return true;
  }
  function windowMatches(w: FakeWindow, where: any): boolean {
    if (!where) return true;
    if (where.id?.in && !where.id.in.includes(w.id)) return false;
    if (where.endedAt === null && w.endedAt !== null) return false;
    if (where.endedAt && typeof where.endedAt === "object") {
      if ("not" in where.endedAt && where.endedAt.not === null && w.endedAt === null) return false;
      if ("lt" in where.endedAt && !(w.endedAt !== null && w.endedAt < where.endedAt.lt)) return false;
      if ("gte" in where.endedAt && !(w.endedAt === null || w.endedAt >= where.endedAt.gte)) return false;
    }
    if (typeof where.assetId === "string" && w.assetId !== where.assetId) return false;
    if (where.assetId?.in && !where.assetId.in.includes(w.assetId)) return false;
    if (where.scheduleId?.in && !(w.scheduleId && where.scheduleId.in.includes(w.scheduleId))) return false;
    if (where.endReason && w.endReason !== where.endReason) return false;
    if (where.startedAt?.lte && !(w.startedAt <= where.startedAt.lte)) return false;
    return true;
  }
  function holdMatches(x: FakeHold, where: any): boolean {
    if (!where) return true;
    if (where.id?.in && !where.id.in.includes(x.id)) return false;
    if (typeof where.assetId === "string" && x.assetId !== where.assetId) return false;
    if (where.assetId?.in && !where.assetId.in.includes(x.assetId)) return false;
    if (where.kind && x.kind !== where.kind) return false;
    if (where.expiresAt?.lte && !(x.expiresAt <= where.expiresAt.lte)) return false;
    if (where.expiresAt?.gt && !(x.expiresAt > where.expiresAt.gt)) return false;
    return true;
  }
  // Simplified OR support for listAssetWindows' overlap query.
  function windowMatchesWithOr(w: FakeWindow, where: any): boolean {
    if (!windowMatches(w, { ...where, OR: undefined })) return false;
    if (Array.isArray(where?.OR)) return where.OR.some((sub: any) => windowMatches(w, sub));
    return true;
  }

  const prisma = {
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    asset: {
      findMany: async (args: any = {}) =>
        db.assets.filter((a) => assetMatches(a, args.where)).map((a) => ({ ...a })),
      findUnique: async (args: any) => {
        const a = db.assets.find((x) => x.id === args.where.id);
        return a ? { ...a } : null;
      },
      update: async (args: any) => {
        const a = db.assets.find((x) => x.id === args.where.id);
        if (a) Object.assign(a, args.data);
        return a ? { ...a } : null;
      },
      updateMany: async (args: any) => {
        let count = 0;
        for (const a of db.assets) {
          if (!assetMatches(a, args.where)) continue;
          Object.assign(a, args.data);
          count++;
        }
        return { count };
      },
    },
    assetMaintenanceWindow: {
      findMany: async (args: any = {}) =>
        db.windows.filter((w) => windowMatchesWithOr(w, args.where)).map((w) => ({ ...w })),
      updateMany: async (args: any) => {
        let count = 0;
        for (const w of db.windows) {
          if (!windowMatches(w, args.where)) continue;
          Object.assign(w, args.data);
          count++;
        }
        return { count };
      },
      createMany: async (args: any) => {
        for (const row of args.data) {
          db.windows.push({ id: nextId(), endedAt: null, endReason: null, ...row });
        }
        return { count: args.data.length };
      },
      deleteMany: async (args: any) => {
        const keep = db.windows.filter((w) => !windowMatches(w, args.where));
        const count = db.windows.length - keep.length;
        db.windows = keep;
        return { count };
      },
    },
    maintenanceHold: {
      findMany: async (args: any = {}) =>
        db.holds.filter((x) => holdMatches(x, args.where)).map((x) => ({ ...x })),
      upsert: async (args: any) => {
        const { assetId, kind } = args.where.assetId_kind;
        const found = db.holds.find((x) => x.assetId === assetId && x.kind === kind);
        if (found) {
          Object.assign(found, args.update);
          return { ...found };
        }
        const row: FakeHold = {
          id: nextId(),
          startedAt: new Date(),
          createdBy: null,
          ...args.create,
        };
        db.holds.push(row);
        return { ...row };
      },
      deleteMany: async (args: any) => {
        const keep = db.holds.filter((x) => !holdMatches(x, args.where));
        const count = db.holds.length - keep.length;
        db.holds = keep;
        return { count };
      },
    },
    maintenanceSchedule: {
      findMany: async (args?: any) => {
        let rows = db.schedules;
        const idIn = args?.where?.id?.in;
        if (idIn) rows = rows.filter((s) => idIn.includes(s.id));
        return rows.map((s) => ({ ...s }));
      },
      findUnique: async (args: any) => {
        const s = db.schedules.find((x) => x.id === args.where.id);
        return s ? { ...s } : null;
      },
      create: async (args: any) => {
        const row: FakeSchedule = {
          id: nextId(),
          createdAt: new Date(),
          updatedAt: new Date(),
          criteria: null,
          createdBy: null,
          ...args.data,
        };
        db.schedules.push(row);
        return { ...row };
      },
      update: async (args: any) => {
        const s = db.schedules.find((x) => x.id === args.where.id)!;
        Object.assign(s, args.data, { updatedAt: new Date() });
        return { ...s };
      },
      delete: async (args: any) => {
        const idx = db.schedules.findIndex((x) => x.id === args.where.id);
        const [row] = db.schedules.splice(idx, 1);
        // Prisma onDelete: SetNull on the window FK.
        for (const w of db.windows) if (w.scheduleId === row.id) w.scheduleId = null;
        return { ...row };
      },
      deleteMany: async (args: any) => {
        const idIn: string[] = args?.where?.id?.in ?? [];
        const removed = db.schedules.filter((s) => idIn.includes(s.id));
        db.schedules = db.schedules.filter((s) => !idIn.includes(s.id));
        for (const r of removed) {
          for (const w of db.windows) if (w.scheduleId === r.id) w.scheduleId = null;
        }
        return { count: removed.length };
      },
    },
  };

  return {
    db,
    prisma,
    reset: () => { db.assets = []; db.windows = []; db.schedules = []; db.holds = []; seq = 1; },
  };
});

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: vi.fn(async () => {}),
  logEventsBatch: vi.fn(async () => 0),
}));
vi.mock("../../src/services/tagAssignmentService.js", () => ({
  // Tests hand in pre-normalized criteria (or null); resolveMatchingAssetIds
  // is stubbed per-test. The real normalize/resolve pipeline has its own
  // coverage in tagAssignment tests.
  normalizeCriteria: vi.fn((raw: unknown) => (raw == null ? null : raw)),
  resolveMatchingAssetIds: vi.fn(async () => new Set<string>()),
}));

import {
  reconcileMaintenance,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  removeAssetFromSchedule,
  getAssetMaintenanceInfo,
  operatorReleaseAsset,
  releaseAssetsForDecommission,
  previewTargets,
  listOccurrences,
  openMaintenanceHold,
  releaseMaintenanceHold,
} from "../../src/services/maintenanceScheduleService.js";
import { logEvent, logEventsBatch } from "../../src/services/eventLogService.js";
import { resolveMatchingAssetIds } from "../../src/services/tagAssignmentService.js";

const NOW = new Date(2026, 6, 10, 12, 0, 0); // 2026-07-10 12:00 local

function asset(id: string, over: Partial<{ status: string; monitored: boolean; maintenanceReturnStatus: string | null; hostname: string }> = {}) {
  return {
    id,
    hostname: over.hostname ?? id.toUpperCase(),
    ipAddress: null,
    model: null,
    manufacturer: null,
    status: over.status ?? "active",
    maintenanceReturnStatus: over.maintenanceReturnStatus ?? null,
    monitored: over.monitored ?? true,
  };
}

/** A one-shot spanning the pinned NOW. */
const ACTIVE_ONESHOT = { version: 1, kind: "oneshot", startAt: "2026-07-10T11:00", endAt: "2026-07-10T14:00" };
/** A one-shot that already ended before NOW. */
const PAST_ONESHOT = { version: 1, kind: "oneshot", startAt: "2026-07-09T11:00", endAt: "2026-07-09T14:00" };
/** Daily 11:00–14:00 — active at the pinned NOW. */
const DAILY = { version: 1, kind: "recurring", freq: "daily", startTime: "11:00", endTime: "14:00" };

function schedule(id: string, shape: unknown, over: Partial<{ enabled: boolean; assetIds: string[]; criteria: unknown; name: string }> = {}) {
  return {
    id,
    name: over.name ?? `Schedule ${id}`,
    enabled: over.enabled ?? true,
    criteria: over.criteria ?? null,
    assetIds: over.assetIds ?? [],
    schedule: shape,
    createdBy: null,
    createdAt: new Date(2026, 0, 1),
    updatedAt: new Date(2026, 0, 1),
  };
}

const openWindows = () => h.db.windows.filter((w) => w.endedAt === null);
const assetById = (id: string) => h.db.assets.find((a) => a.id === id)!;

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("reconcileMaintenance — enter", () => {
  it("enters matched monitored assets: window row + status flip + parked return status", async () => {
    h.db.assets.push(asset("a1"));
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1"] }));

    await reconcileMaintenance();

    expect(openWindows()).toHaveLength(1);
    expect(openWindows()[0]).toMatchObject({ assetId: "a1", scheduleId: "s1", scheduleName: "Schedule s1" });
    expect(assetById("a1")).toMatchObject({
      status: "maintenance",
      maintenanceReturnStatus: "active",
      statusChangedBy: "system:maintenance",
    });
    expect(vi.mocked(logEventsBatch)).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ action: "maintenance.entered", resourceId: "a1" })]),
    );
  });

  it("never targets unmonitored assets", async () => {
    h.db.assets.push(asset("a1", { monitored: false }));
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1"] }));

    await reconcileMaintenance();

    expect(openWindows()).toHaveLength(0);
    expect(assetById("a1").status).toBe("active");
  });

  it("does nothing when the schedule is out of window or disabled", async () => {
    h.db.assets.push(asset("a1"));
    h.db.schedules.push(schedule("s1", PAST_ONESHOT, { assetIds: ["a1"] }));
    h.db.schedules.push(schedule("s2", ACTIVE_ONESHOT, { assetIds: ["a1"], enabled: false }));

    await reconcileMaintenance();

    expect(openWindows()).toHaveLength(0);
    expect(assetById("a1").status).toBe("active");
  });

  it("preserves a manually-set maintenance status verbatim (no restore loop)", async () => {
    h.db.assets.push(asset("a1", { status: "maintenance" }));
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1"] }));

    await reconcileMaintenance();
    expect(assetById("a1").maintenanceReturnStatus).toBe("maintenance");

    // Window ends → restore to the operator's manual "maintenance".
    vi.setSystemTime(new Date(2026, 6, 10, 15, 0, 0));
    await reconcileMaintenance();
    expect(assetById("a1")).toMatchObject({ status: "maintenance", maintenanceReturnStatus: null });
    expect(openWindows()).toHaveLength(0);
  });

  it("unions criteria matches with explicit assetIds", async () => {
    h.db.assets.push(asset("a1"), asset("a2"));
    vi.mocked(resolveMatchingAssetIds).mockResolvedValue(new Set(["a2"]));
    h.db.schedules.push(
      schedule("s1", ACTIVE_ONESHOT, {
        assetIds: ["a1"],
        criteria: { version: 1, match: "all", rules: [{ field: "hostname", op: "contains", values: ["A2"] }] },
      }),
    );

    await reconcileMaintenance();

    expect(openWindows().map((w) => w.assetId).sort()).toEqual(["a1", "a2"]);
  });
});

describe("reconcileMaintenance — exit", () => {
  it("closes the window and restores the parked status when the schedule ends", async () => {
    h.db.assets.push(asset("a1", { status: "maintenance", maintenanceReturnStatus: "storage" }));
    h.db.schedules.push(schedule("s1", PAST_ONESHOT, { assetIds: ["a1"] }));
    h.db.windows.push({ id: "w1", assetId: "a1", scheduleId: "s1", scheduleName: "Schedule s1", startedAt: new Date(2026, 6, 9, 11, 0), endedAt: null, endReason: null });

    await reconcileMaintenance();

    expect(openWindows()).toHaveLength(0);
    expect(h.db.windows[0]).toMatchObject({ endReason: "schedule" });
    expect(assetById("a1")).toMatchObject({ status: "storage", maintenanceReturnStatus: null });
    expect(vi.mocked(logEventsBatch)).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ action: "maintenance.exited", resourceId: "a1" })]),
    );
  });

  it("closes with reason 'disabled' / 'deleted' / 'criteria' appropriately", async () => {
    h.db.assets.push(
      asset("a1", { status: "maintenance", maintenanceReturnStatus: "active" }),
      asset("a2", { status: "maintenance", maintenanceReturnStatus: "active" }),
      asset("a3", { status: "maintenance", maintenanceReturnStatus: "active" }),
    );
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1"], enabled: false }));
    h.db.schedules.push(schedule("s3", ACTIVE_ONESHOT, { assetIds: [] })); // a3 no longer matches
    const started = new Date(2026, 6, 10, 11, 0);
    h.db.windows.push(
      { id: "w1", assetId: "a1", scheduleId: "s1", scheduleName: "Schedule s1", startedAt: started, endedAt: null, endReason: null },
      { id: "w2", assetId: "a2", scheduleId: null, scheduleName: "Gone", startedAt: started, endedAt: null, endReason: null },
      { id: "w3", assetId: "a3", scheduleId: "s3", scheduleName: "Schedule s3", startedAt: started, endedAt: null, endReason: null },
    );

    await reconcileMaintenance();

    const byId = Object.fromEntries(h.db.windows.map((w) => [w.id, w]));
    expect(byId.w1.endReason).toBe("disabled");
    expect(byId.w2.endReason).toBe("deleted");
    expect(byId.w3.endReason).toBe("criteria");
    for (const id of ["a1", "a2", "a3"]) expect(assetById(id).status).toBe("active");
  });

  it("overlapping schedules: enter once, exit only when the LAST window closes", async () => {
    h.db.assets.push(asset("a1"));
    h.db.schedules.push(
      schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1"] }),
      schedule("s2", DAILY, { assetIds: ["a1"] }),
    );

    await reconcileMaintenance();
    expect(openWindows()).toHaveLength(2);
    expect(assetById("a1")).toMatchObject({ status: "maintenance", maintenanceReturnStatus: "active" });

    // 14:30 — the one-shot ended (14:00) AND the daily window ended (14:00).
    // Advance in two steps: first to 13:30 (one-shot still ends at 14:00 but
    // daily also ends 14:00 — both still open at 13:30).
    vi.setSystemTime(new Date(2026, 6, 10, 13, 30));
    await reconcileMaintenance();
    expect(openWindows()).toHaveLength(2);
    expect(assetById("a1").status).toBe("maintenance");

    // Disable s2 → its window closes, but s1 is still active → stays in maintenance.
    h.db.schedules.find((s) => s.id === "s2")!.enabled = false;
    await reconcileMaintenance();
    expect(openWindows()).toHaveLength(1);
    expect(assetById("a1").status).toBe("maintenance");

    // s1's one-shot ends → last window closes → restore.
    vi.setSystemTime(new Date(2026, 6, 10, 14, 30));
    await reconcileMaintenance();
    expect(openWindows()).toHaveLength(0);
    expect(assetById("a1")).toMatchObject({ status: "active", maintenanceReturnStatus: null });
  });

  it("leaves an operator-moved status alone on exit (clears the parked column only)", async () => {
    // Operator moved status off maintenance mid-window through a path that
    // closed no windows (defensive case).
    h.db.assets.push(asset("a1", { status: "decommissioned", maintenanceReturnStatus: "active" }));
    h.db.schedules.push(schedule("s1", PAST_ONESHOT, { assetIds: ["a1"] }));
    h.db.windows.push({ id: "w1", assetId: "a1", scheduleId: "s1", scheduleName: "Schedule s1", startedAt: new Date(2026, 6, 9, 11, 0), endedAt: null, endReason: null });

    await reconcileMaintenance();

    expect(assetById("a1")).toMatchObject({ status: "decommissioned", maintenanceReturnStatus: null });
  });
});

describe("reconcileMaintenance — operator release & self-heal", () => {
  it("does not re-enter during the occurrence the operator released", async () => {
    h.db.assets.push(asset("a1"));
    h.db.schedules.push(schedule("s1", DAILY, { assetIds: ["a1"] }));
    // Operator released 30 minutes ago — inside today's 11:00-14:00 occurrence.
    h.db.windows.push({
      id: "w1", assetId: "a1", scheduleId: "s1", scheduleName: "Schedule s1",
      startedAt: new Date(2026, 6, 10, 11, 0), endedAt: new Date(2026, 6, 10, 11, 30), endReason: "operator",
    });

    await reconcileMaintenance();
    expect(openWindows()).toHaveLength(0);
    expect(assetById("a1").status).toBe("active");

    // Next day's occurrence → re-enters normally.
    vi.setSystemTime(new Date(2026, 6, 11, 12, 0));
    await reconcileMaintenance();
    expect(openWindows()).toHaveLength(1);
    expect(assetById("a1").status).toBe("maintenance");
  });

  it("operatorReleaseAsset closes all open windows without touching status", async () => {
    h.db.assets.push(asset("a1", { status: "maintenance", maintenanceReturnStatus: "active" }));
    h.db.windows.push(
      { id: "w1", assetId: "a1", scheduleId: "s1", scheduleName: "S1", startedAt: NOW, endedAt: null, endReason: null },
      { id: "w2", assetId: "a1", scheduleId: "s2", scheduleName: "S2", startedAt: NOW, endedAt: null, endReason: null },
    );

    const released = await operatorReleaseAsset("a1", "operator1");

    expect(released).toBe(true);
    expect(openWindows()).toHaveLength(0);
    expect(h.db.windows.every((w) => w.endReason === "operator")).toBe(true);
    // Status untouched (the caller's own write wins); parked column cleared.
    expect(assetById("a1")).toMatchObject({ status: "maintenance", maintenanceReturnStatus: null });
  });

  it("self-heals a status clobbered by a system writer mid-window", async () => {
    h.db.assets.push(asset("a1", { status: "maintenance", maintenanceReturnStatus: "active" }));
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1"] }));
    h.db.windows.push({ id: "w1", assetId: "a1", scheduleId: "s1", scheduleName: "Schedule s1", startedAt: new Date(2026, 6, 10, 11, 0), endedAt: null, endReason: null });

    // A discovery path flips status mid-window (guards missed it).
    assetById("a1").status = "disabled";
    // The reconcile needs a diff to reach the self-heal — add an unrelated change.
    h.db.assets.push(asset("a2"));
    h.db.schedules[0].assetIds = ["a1", "a2"];

    await reconcileMaintenance();

    // Re-flipped, and the clobbered value absorbed so exit restores it.
    expect(assetById("a1")).toMatchObject({ status: "maintenance", maintenanceReturnStatus: "disabled" });

    vi.setSystemTime(new Date(2026, 6, 10, 15, 0));
    await reconcileMaintenance();
    expect(assetById("a1")).toMatchObject({ status: "disabled", maintenanceReturnStatus: null });
  });
});

describe("schedule CRUD", () => {
  it("createSchedule with a now-active one-shot enters immediately (inline reconcile)", async () => {
    h.db.assets.push(asset("a1"));

    await createSchedule(
      { name: "Ad-hoc — A1", assetIds: ["a1"], schedule: ACTIVE_ONESHOT },
      "operator1",
    );

    expect(openWindows()).toHaveLength(1);
    expect(assetById("a1").status).toBe("maintenance");
  });

  it("suppressChildren defaults to true and persists an explicit false", async () => {
    h.db.assets.push(asset("a1"));

    const defaulted = await createSchedule(
      { name: "default", assetIds: ["a1"], schedule: ACTIVE_ONESHOT },
      "operator1",
    );
    expect((defaulted as any).suppressChildren).toBe(true);

    const optedOut = await createSchedule(
      { name: "opt-out", assetIds: ["a1"], schedule: ACTIVE_ONESHOT, suppressChildren: false },
      "operator1",
    );
    expect((optedOut as any).suppressChildren).toBe(false);

    // Update without the field snaps back to the default (normalizeInput
    // treats missing as true) — callers must pass it through.
    const updated = await updateSchedule(optedOut.id, {
      name: "opt-out",
      assetIds: ["a1"],
      schedule: ACTIVE_ONESHOT,
    });
    expect((updated as any).suppressChildren).toBe(true);
  });

  it("rejects empty targets, status criteria, and malformed schedules", async () => {
    await expect(createSchedule({ name: "x", schedule: ACTIVE_ONESHOT })).rejects.toThrow(/target at least one asset/);
    await expect(
      createSchedule({
        name: "x",
        criteria: { version: 1, match: "all", rules: [{ field: "status", op: "exact", values: ["active"] }] },
        schedule: ACTIVE_ONESHOT,
      }),
    ).rejects.toThrow(/cannot filter on status/);
    await expect(
      createSchedule({ name: "x", assetIds: ["a1"], schedule: { version: 1, kind: "recurring", freq: "weekly" } }),
    ).rejects.toThrow(/Invalid schedule/);
  });

  it("deleteSchedule exits its open windows and restores statuses", async () => {
    h.db.assets.push(asset("a1"));
    const created = await createSchedule({ name: "S", assetIds: ["a1"], schedule: ACTIVE_ONESHOT }, "op");
    expect(assetById("a1").status).toBe("maintenance");

    await deleteSchedule(created.id, "op");

    expect(openWindows()).toHaveLength(0);
    expect(assetById("a1")).toMatchObject({ status: "active", maintenanceReturnStatus: null });
  });
});

describe("ad-hoc schedule lifecycle", () => {
  it("operator release deletes the spent ad-hoc schedule; window history survives", async () => {
    h.db.assets.push(asset("a1"));
    await createSchedule({ name: "Ad-hoc — A1", assetIds: ["a1"], schedule: ACTIVE_ONESHOT }, "op");
    expect(assetById("a1").status).toBe("maintenance");

    await operatorReleaseAsset("a1", "op");
    expect(h.db.schedules).toHaveLength(0);
    expect(h.db.windows).toHaveLength(1);
    expect(h.db.windows[0]!.endReason).toBe("operator");
    expect(h.db.windows[0]!.scheduleId).toBeNull(); // SetNull — scheduleName snapshot keeps the label
  });

  it("operator release keeps multi-asset and criteria-based schedules", async () => {
    h.db.assets.push(asset("a1"), asset("a2"));
    h.db.schedules.push(schedule("s-multi", ACTIVE_ONESHOT, { assetIds: ["a1", "a2"] }));
    await reconcileMaintenance();
    expect(assetById("a1").status).toBe("maintenance");

    await operatorReleaseAsset("a1", "op");
    expect(h.db.schedules).toHaveLength(1); // two explicit assets → not the ad-hoc shape
    expect(assetById("a2").status).toBe("maintenance"); // untouched
  });

  it("reconcile deletes an ad-hoc one-shot once its window ends naturally", async () => {
    h.db.assets.push(asset("a1"));
    await createSchedule({ name: "Ad-hoc — A1", assetIds: ["a1"], schedule: ACTIVE_ONESHOT }, "op");
    expect(assetById("a1").status).toBe("maintenance");

    vi.setSystemTime(new Date(2026, 6, 10, 15, 0)); // past the 14:00 end
    await reconcileMaintenance();
    expect(assetById("a1").status).toBe("active");
    expect(h.db.windows[0]!.endReason).toBe("schedule");
    expect(h.db.schedules).toHaveLength(0);
  });

  it("disabling an ad-hoc schedule ends the window but keeps the schedule", async () => {
    h.db.assets.push(asset("a1"));
    await createSchedule({ name: "Ad-hoc — A1", assetIds: ["a1"], schedule: ACTIVE_ONESHOT }, "op");
    h.db.schedules[0]!.enabled = false;

    await reconcileMaintenance();
    expect(assetById("a1").status).toBe("active");
    expect(h.db.windows[0]!.endReason).toBe("disabled");
    expect(h.db.schedules).toHaveLength(1); // operator's explicit disable — not spent
  });

  it("a single-asset one-shot edited to a future window is not deleted when its old window closes", async () => {
    h.db.assets.push(asset("a1", { status: "maintenance", maintenanceReturnStatus: "active" }));
    const future = { version: 1, kind: "oneshot", startAt: "2026-07-12T11:00", endAt: "2026-07-12T14:00" };
    h.db.schedules.push(schedule("s1", future, { assetIds: ["a1"] }));
    h.db.windows.push({
      id: "w1", assetId: "a1", scheduleId: "s1", scheduleName: "Schedule s1",
      startedAt: new Date(2026, 6, 10, 11, 0), endedAt: null, endReason: null,
    });

    await reconcileMaintenance();
    expect(h.db.windows[0]!.endReason).toBe("schedule");
    expect(h.db.schedules).toHaveLength(1); // nextWindow != null → still has a purpose
  });

  it("startNow stamps the server clock so entry is immediate regardless of client skew", async () => {
    h.db.assets.push(asset("a1"));
    const row = await createSchedule(
      { name: "Ad-hoc — A1", assetIds: ["a1"], schedule: { version: 1, kind: "oneshot", startNow: true, endAt: "2026-07-10T14:00" } },
      "op",
    );
    expect((row.schedule as any).startAt).toBe("2026-07-10T12:00"); // pinned NOW, server-local
    expect((row.schedule as any).startNow).toBeUndefined(); // marker stripped — stored shape is concrete
    expect(assetById("a1").status).toBe("maintenance");
  });
});

describe("releaseAssetsForDecommission", () => {
  it("force-closes the window and decommissions an asset deleted at its source", async () => {
    h.db.assets.push(asset("a1"));
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1"] }));
    await reconcileMaintenance();
    expect(assetById("a1").status).toBe("maintenance");

    const released = await releaseAssetsForDecommission(["a1"], {
      actor: "discovery",
      statusChangedBy: "integration:FMG",
      reason: 'no longer configured in "FMG"',
    });

    expect(released).toEqual(["a1"]);
    expect(openWindows()).toHaveLength(0);
    expect(h.db.windows[0]!.endReason).toBe("decommissioned");
    expect(assetById("a1")).toMatchObject({
      status: "decommissioned",
      maintenanceReturnStatus: null,
      statusChangedBy: "integration:FMG",
    });
    expect(vi.mocked(logEventsBatch)).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ action: "maintenance.exited", resourceId: "a1" }),
      ]),
    );
    // The ad-hoc-shaped schedule that held it is spent (its only asset is gone).
    expect(h.db.schedules).toHaveLength(0);
  });

  it("does not restore the pre-window status when the window's occurrence ends", async () => {
    h.db.assets.push(asset("a1"));
    h.db.schedules.push(schedule("s1", DAILY, { assetIds: ["a1"] })); // recurring — survives
    await reconcileMaintenance();

    await releaseAssetsForDecommission(["a1"], { statusChangedBy: "integration:FMG" });
    // The real status write clamps monitored=false (db.ts extension, mocked out
    // here) — that clamp is what keeps the asset out of the target set.
    assetById("a1").monitored = false;

    vi.setSystemTime(new Date(2026, 6, 10, 15, 0)); // past today's 14:00 end
    await reconcileMaintenance();
    vi.setSystemTime(new Date(2026, 6, 11, 12, 0)); // next occurrence
    await reconcileMaintenance();

    expect(assetById("a1").status).toBe("decommissioned"); // never restored, never re-entered
    expect(openWindows()).toHaveLength(0);
  });

  it("is a no-op for assets with no open window (the common sweep case)", async () => {
    h.db.assets.push(asset("a1"));

    const released = await releaseAssetsForDecommission(["a1", "a2"]);

    expect(released).toEqual([]);
    expect(assetById("a1").status).toBe("active"); // caller's own status write owns these
    expect(h.db.windows).toHaveLength(0);
  });
});

describe("previewTargets", () => {
  it("returns only monitored assets, capped, with the total", async () => {
    for (let i = 0; i < 60; i++) h.db.assets.push(asset(`a${i}`, { hostname: `HOST-${String(i).padStart(2, "0")}` }));
    h.db.assets.push(asset("um1", { monitored: false }));
    const ids = h.db.assets.map((a) => a.id);

    const res = await previewTargets({ assetIds: ids });

    expect(res.total).toBe(60); // unmonitored excluded
    expect(res.assets).toHaveLength(50); // cap
    expect(res.assets[0].hostname).toBe("HOST-00"); // hostname-sorted
  });
});

describe("listOccurrences (calendar tab)", () => {
  it("expands every schedule over the range, sorted, as server-local strings", async () => {
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { name: "One-time" }));
    h.db.schedules.push(schedule("s2", DAILY, { name: "Nightly" }));

    const res = await listOccurrences({ from: "2026-07-10", to: "2026-07-11" });

    expect(res.truncated).toBe(false);
    expect(res.occurrences.map((o) => `${o.name} ${o.start}→${o.end}`)).toEqual([
      "Nightly 2026-07-10T11:00→2026-07-10T14:00",
      "One-time 2026-07-10T11:00→2026-07-10T14:00",
      "Nightly 2026-07-11T11:00→2026-07-11T14:00",
    ]);
  });

  it("includes the whole `to` day (range end is that day's midnight boundary)", async () => {
    h.db.schedules.push(schedule("s1", DAILY));
    const res = await listOccurrences({ from: "2026-07-11", to: "2026-07-11" });
    expect(res.occurrences).toHaveLength(1);
    expect(res.occurrences[0].start).toBe("2026-07-11T11:00");
  });

  it("flags the single-asset one-shot artifacts so the grid can style them", async () => {
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { name: "Ad-hoc — A1", assetIds: ["a1"] }));
    h.db.schedules.push(schedule("s2", ACTIVE_ONESHOT, { name: "Planned", assetIds: ["a1", "a2"] }));
    const res = await listOccurrences({ from: "2026-07-10", to: "2026-07-10" });
    expect(res.occurrences.find((o) => o.name === "Ad-hoc — A1")!.adhoc).toBe(true);
    expect(res.occurrences.find((o) => o.name === "Planned")!.adhoc).toBe(false);
  });

  it("skips a schedule whose stored shape is unparseable rather than failing the month", async () => {
    h.db.schedules.push(schedule("bad", { version: 1, kind: "nonsense" }));
    h.db.schedules.push(schedule("good", DAILY));
    const res = await listOccurrences({ from: "2026-07-10", to: "2026-07-10" });
    expect(res.occurrences).toHaveLength(1);
    expect(res.occurrences[0].scheduleId).toBe("good");
  });

  it("rejects an inverted or over-wide range", async () => {
    await expect(listOccurrences({ from: "2026-07-10", to: "2026-07-09" })).rejects.toThrow(/not be before/);
    await expect(listOccurrences({ from: "2026-01-01", to: "2027-12-31" })).rejects.toThrow(/too wide/i);
  });
});

describe("getAssetMaintenanceInfo — coverage provenance", () => {
  it("names how each schedule reaches the asset, and whether removing it empties the schedule", async () => {
    h.db.assets.push(asset("a1"));
    h.db.assets.push(asset("a2"));
    h.db.schedules.push(schedule("s1", DAILY, { assetIds: ["a1"], name: "Only device" }));
    h.db.schedules.push(schedule("s2", DAILY, { assetIds: ["a1", "a2"], name: "Two devices" }));
    h.db.schedules.push(schedule("s3", DAILY, { criteria: { rules: [] }, name: "By filter" }));
    vi.mocked(resolveMatchingAssetIds).mockResolvedValue(new Set(["a1"]));

    const info = await getAssetMaintenanceInfo("a1");
    const byId = new Map(info.schedules.map((s) => [s.id, s]));

    expect(byId.get("s1")).toMatchObject({ explicit: true, byCriteria: false, removable: true, lastTarget: true });
    expect(byId.get("s2")).toMatchObject({ explicit: true, byCriteria: false, removable: true, lastTarget: false });
    expect(byId.get("s3")).toMatchObject({ explicit: false, byCriteria: true, removable: false, lastTarget: false });
  });

  it("reports the asset's CURRENT status, which is what the edit modal re-syncs its dropdown from", async () => {
    h.db.assets.push(asset("a1"));
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1"] }));
    await reconcileMaintenance();

    expect(await getAssetMaintenanceInfo("a1")).toMatchObject({
      inMaintenance: true,
      status: "maintenance",
      returnStatus: "active",
    });

    await removeAssetFromSchedule("s1", "a1");

    expect(await getAssetMaintenanceInfo("a1")).toMatchObject({
      inMaintenance: false,
      status: "active",
      returnStatus: null,
    });
  });

  it("an asset both listed AND filter-matched is not removable one asset at a time", async () => {
    h.db.assets.push(asset("a1"));
    h.db.schedules.push(schedule("s1", DAILY, { assetIds: ["a1"], criteria: { rules: [] } }));
    vi.mocked(resolveMatchingAssetIds).mockResolvedValue(new Set(["a1"]));

    const info = await getAssetMaintenanceInfo("a1");

    expect(info.schedules[0]).toMatchObject({ explicit: true, byCriteria: true, removable: false, lastTarget: false });
  });
});

describe("removeAssetFromSchedule", () => {
  it("drops the asset, leaves the schedule for its other devices, and ends its window", async () => {
    h.db.assets.push(asset("a1"), asset("a2"));
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1", "a2"] }));
    await reconcileMaintenance();
    expect(assetById("a1").status).toBe("maintenance");

    const res = await removeAssetFromSchedule("s1", "a1", "dana");

    expect(res).toMatchObject({ scheduleDeleted: false, remainingAssetIds: 1 });
    expect(h.db.schedules[0].assetIds).toEqual(["a2"]);
    // The reconcile that follows closes the window and restores the status.
    expect(openWindows().map((w) => w.assetId)).toEqual(["a2"]);
    expect(assetById("a1")).toMatchObject({ status: "active", maintenanceReturnStatus: null });
    expect(assetById("a2").status).toBe("maintenance");
    expect(vi.mocked(logEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "maintenance_schedule.updated", actor: "dana" }),
    );
  });

  it("deletes the schedule when the asset was its last target", async () => {
    h.db.assets.push(asset("a1"));
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1"], name: "Only device" }));
    await reconcileMaintenance();

    const res = await removeAssetFromSchedule("s1", "a1", "dana");

    expect(res).toMatchObject({ scheduleDeleted: true, scheduleName: "Only device", remainingAssetIds: 0 });
    expect(h.db.schedules).toHaveLength(0);
    expect(openWindows()).toHaveLength(0);
    expect(assetById("a1")).toMatchObject({ status: "active", maintenanceReturnStatus: null });
    expect(vi.mocked(logEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "maintenance_schedule.deleted",
        details: expect.objectContaining({ reason: "last-asset-removed" }),
      }),
    );
  });

  it("keeps a criteria-based schedule that has no explicit targets left", async () => {
    h.db.assets.push(asset("a1"));
    h.db.schedules.push(schedule("s1", DAILY, { assetIds: ["a1"], criteria: { rules: [] } }));
    // The filter matches a DIFFERENT asset, so removing a1 is honest here.
    vi.mocked(resolveMatchingAssetIds).mockResolvedValue(new Set(["a9"]));

    const res = await removeAssetFromSchedule("s1", "a1");

    expect(res.scheduleDeleted).toBe(false);
    expect(h.db.schedules).toHaveLength(1);
    expect(h.db.schedules[0].assetIds).toEqual([]);
  });

  it("refuses when the schedule reaches the asset through its filter", async () => {
    h.db.assets.push(asset("a1"));
    h.db.schedules.push(schedule("s1", DAILY, { assetIds: ["a1"], criteria: { rules: [] }, name: "By filter" }));
    vi.mocked(resolveMatchingAssetIds).mockResolvedValue(new Set(["a1"]));

    await expect(removeAssetFromSchedule("s1", "a1")).rejects.toThrow(/filter/i);
    expect(h.db.schedules[0].assetIds).toEqual(["a1"]);
  });

  it("refuses for a schedule that does not target the asset, and 404s on a missing schedule or asset", async () => {
    h.db.assets.push(asset("a1"), asset("a2"));
    h.db.schedules.push(schedule("s1", DAILY, { assetIds: ["a2"] }));

    await expect(removeAssetFromSchedule("s1", "a1")).rejects.toThrow(/does not target/i);
    await expect(removeAssetFromSchedule("nope", "a1")).rejects.toThrow(/not found/i);
    await expect(removeAssetFromSchedule("s1", "ghost")).rejects.toThrow(/not found/i);
  });
});

// ─── Maintenance holds (business rule 80) ────────────────────────────────────
//
// A hold is downtime POLARIS is causing — an agent upgrade / reinstall /
// uninstall stops the agent service, which drops the WebSocket and writes
// agent.disconnected. These assert the two halves that make it safe: the hold
// enters through the same path a schedule does (so the status parks and the
// alert sweep runs), and NOTHING can leave an asset held forever.

describe("maintenance holds", () => {
  it("puts the asset into maintenance and opens a window naming the operation", async () => {
    h.db.assets.push(asset("a1"));

    const took = await openMaintenanceHold({ assetId: "a1", kind: "agent-upgrade" });

    expect(took).toBe(true);
    expect(assetById("a1")).toMatchObject({ status: "maintenance", maintenanceReturnStatus: "active" });
    expect(openWindows()).toHaveLength(1);
    expect(openWindows()[0]).toMatchObject({
      assetId: "a1",
      scheduleId: null,
      holdKind: "agent-upgrade",
      scheduleName: "Polaris Agent upgrade",
    });
  });

  it("survives the reconcile tick that closes schedule-less windows", async () => {
    // The trap this whole design exists to avoid: a window with no live holder
    // is closed as "deleted", so a hold row that did not announce itself would
    // be torn down within 30 seconds of being taken.
    h.db.assets.push(asset("a1"));
    await openMaintenanceHold({ assetId: "a1", kind: "agent-upgrade" });

    await reconcileMaintenance();
    await reconcileMaintenance();

    expect(openWindows()).toHaveLength(1);
    expect(assetById("a1").status).toBe("maintenance");
  });

  it("restores the parked status on release", async () => {
    h.db.assets.push(asset("a1", { status: "active" }));
    await openMaintenanceHold({ assetId: "a1", kind: "agent-upgrade" });

    const released = await releaseMaintenanceHold({ assetId: "a1", kind: "agent-upgrade" });

    expect(released).toBe(true);
    expect(assetById("a1")).toMatchObject({ status: "active", maintenanceReturnStatus: null });
    expect(openWindows()).toHaveLength(0);
    expect(h.db.windows[0]).toMatchObject({ endReason: "released" });
  });

  it("expires on its own when nothing releases it", async () => {
    // The process died mid-upgrade. A held asset is not being watched, so the
    // reconcile has to end this without being asked.
    h.db.assets.push(asset("a1"));
    await openMaintenanceHold({ assetId: "a1", kind: "agent-upgrade" });
    expect(assetById("a1").status).toBe("maintenance");

    vi.setSystemTime(new Date(NOW.getTime() + 21 * 60_000));
    await reconcileMaintenance();

    expect(h.db.holds).toHaveLength(0);
    expect(openWindows()).toHaveLength(0);
    expect(h.db.windows[0]).toMatchObject({ endReason: "expired" });
    expect(assetById("a1").status).toBe("active");
  });

  it("extends rather than stacks when the same operation is retried", async () => {
    h.db.assets.push(asset("a1"));
    await openMaintenanceHold({ assetId: "a1", kind: "agent-upgrade" });
    const firstExpiry = h.db.holds[0].expiresAt;
    const startedAt = h.db.holds[0].startedAt;

    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60_000));
    await openMaintenanceHold({ assetId: "a1", kind: "agent-upgrade" });

    expect(h.db.holds).toHaveLength(1);
    expect(openWindows()).toHaveLength(1);
    expect(h.db.holds[0].expiresAt.getTime()).toBeGreaterThan(firstExpiry.getTime());
    // The window it opened is the same one — re-dating it would shorten the
    // chart band the operator reads.
    expect(h.db.holds[0].startedAt).toEqual(startedAt);
  });

  it("keeps the asset held until the LAST holder lets go", async () => {
    h.db.assets.push(asset("a1"));
    h.db.schedules.push(schedule("s1", ACTIVE_ONESHOT, { assetIds: ["a1"] }));
    await reconcileMaintenance();
    await openMaintenanceHold({ assetId: "a1", kind: "agent-upgrade" });
    expect(openWindows()).toHaveLength(2);

    await releaseMaintenanceHold({ assetId: "a1", kind: "agent-upgrade" });

    expect(openWindows()).toHaveLength(1);
    expect(assetById("a1").status).toBe("maintenance");
  });

  it("takes no hold on an unmonitored asset, and says so", async () => {
    h.db.assets.push(asset("a1", { monitored: false }));

    const took = await openMaintenanceHold({ assetId: "a1", kind: "agent-upgrade" });

    expect(took).toBe(false);
    expect(h.db.holds).toHaveLength(0);
    expect(openWindows()).toHaveLength(0);
    expect(assetById("a1").status).toBe("active");
  });

  it("releasing a hold nobody took is a no-op, not a throw", async () => {
    h.db.assets.push(asset("a1"));
    await expect(releaseMaintenanceHold({ assetId: "a1", kind: "agent-upgrade" })).resolves.toBe(false);
  });

  it("an operator release drops the holder too, so the next tick cannot re-enter", async () => {
    h.db.assets.push(asset("a1"));
    await openMaintenanceHold({ assetId: "a1", kind: "agent-upgrade" });

    await operatorReleaseAsset("a1", "dmoore");
    await reconcileMaintenance();

    expect(h.db.holds).toHaveLength(0);
    // Still closed after the tick: a live hold would have re-opened it and the
    // operator's release would have visibly undone itself. (Restoring the
    // status is the assets route's job on this path — it writes the status the
    // operator chose right after calling this, for a hold exactly as for a
    // schedule.)
    expect(openWindows()).toHaveLength(0);
    expect(h.db.windows[0]).toMatchObject({ endReason: "operator" });
  });

  it("a decommission drops the holder too", async () => {
    h.db.assets.push(asset("a1"));
    await openMaintenanceHold({ assetId: "a1", kind: "agent-uninstall" });

    await releaseAssetsForDecommission(["a1"], { actor: "system:discovery" });
    await reconcileMaintenance();

    expect(h.db.holds).toHaveLength(0);
    expect(openWindows()).toHaveLength(0);
    expect(assetById("a1").status).toBe("decommissioned");
  });

  it("reports the hold on the asset's Maintenance tab, ending at the cap", async () => {
    h.db.assets.push(asset("a1"));
    await openMaintenanceHold({ assetId: "a1", kind: "agent-reinstall" });

    const info = await getAssetMaintenanceInfo("a1");

    expect(info.inMaintenance).toBe(true);
    expect(info.openWindows).toHaveLength(1);
    expect(info.openWindows[0]).toMatchObject({
      scheduleId: null,
      scheduleName: "Polaris Agent reinstall",
    });
    // A hold has no occurrence to end — the cap is the honest answer.
    expect(info.openWindows[0].until).toEqual(h.db.holds[0].expiresAt);
  });

  it("refuses a kind it does not know", async () => {
    h.db.assets.push(asset("a1"));
    await expect(
      openMaintenanceHold({ assetId: "a1", kind: "agent-reboot" as never }),
    ).rejects.toThrow(/hold kind/i);
  });
});
