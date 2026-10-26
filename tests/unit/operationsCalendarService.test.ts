/**
 * tests/unit/operationsCalendarService.test.ts — the Events Calendar tab's
 * data: maintenance occurrences, reboots and firmware upgrades over a day
 * range, booked and past, as server-local wall-clock strings.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rebootSchedules: [] as any[],
  rebootRuns: [] as any[],
  firmwareSchedules: [] as any[],
  firmwareRuns: [] as any[],
  extraRuns: [] as any[],
  bookedRunIds: [] as any[],
  occurrences: { occurrences: [] as any[], truncated: false },
  calls: [] as string[],
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    rebootSchedule: {
      findMany: vi.fn(async (args: any) => {
        if (args.where.runId) { h.calls.push("rebootSchedule.byRun"); return h.bookedRunIds; }
        h.calls.push("rebootSchedule.range");
        return h.rebootSchedules;
      }),
    },
    rebootRun: {
      findMany: vi.fn(async (args: any) => {
        if (args.where.id) { h.calls.push("rebootRun.byId"); return h.extraRuns; }
        h.calls.push("rebootRun.range");
        return h.rebootRuns;
      }),
    },
    firmwareUpgradeSchedule: { findMany: vi.fn(async (args: any) => (args.where.runId ? [] : h.firmwareSchedules)) },
    firmwareUpgradeRun: { findMany: vi.fn(async (args: any) => (args.where.id ? [] : h.firmwareRuns)) },
    firmwareGroupSchedule: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("../../src/services/maintenanceScheduleService.js", () => ({
  listOccurrences: vi.fn(async () => h.occurrences),
}));

import { listCalendar, mergeDeviceItems, calendarRange, groupItem, MAX_DEVICE_ITEMS } from "../../src/services/operationsCalendarService.js";
import { AppError } from "../../src/utils/errors.js";

const local = (y: number, mo: number, d: number, hh: number, mm: number) => new Date(y, mo - 1, d, hh, mm, 0, 0);
const asset = { hostname: "FGT-01", ipAddress: "10.0.0.1" };
const NOW = local(2026, 8, 12, 9, 0);

beforeEach(() => {
  h.rebootSchedules = [];
  h.rebootRuns = [];
  h.firmwareSchedules = [];
  h.firmwareRuns = [];
  h.extraRuns = [];
  h.bookedRunIds = [];
  h.occurrences = { occurrences: [], truncated: false };
  h.calls = [];
});

describe("mergeDeviceItems", () => {
  it("a booking not yet run is a 15-minute point at its booked time, in server-local digits", () => {
    const items = mergeDeviceItems("reboot", [
      { id: "b1", assetId: "a1", scheduledFor: local(2026, 8, 14, 2, 0), status: "pending", runId: null, createdBy: "automation:Mem", error: null, asset },
    ], [], new Map(), new Set(), NOW);
    expect(items).toEqual([{
      kind: "reboot", id: "booking:b1", assetId: "a1", assetName: "FGT-01", start: "2026-08-14T02:00", end: "2026-08-14T02:15",
      booked: true, scheduleId: "b1", runId: null, status: "pending", by: "automation:Mem", toVersion: null, note: null, error: null,
    }]);
  });

  it("a reboot carries its reason — the run's once it ran, else the booking's (rule 115(d))", () => {
    const run = { id: "r1", assetId: "a1", status: "succeeded", startedBy: "alice", startedAt: local(2026, 8, 10, 2, 0), finishedAt: local(2026, 8, 10, 2, 10), error: null, note: "Leak", asset };
    const items = mergeDeviceItems("reboot", [
      { id: "b1", assetId: "a1", scheduledFor: local(2026, 8, 10, 2, 0), status: "started", runId: "r1", createdBy: "alice", error: null, note: "Leak", asset },
      { id: "b2", assetId: "a1", scheduledFor: local(2026, 8, 11, 2, 0), status: "pending", runId: null, createdBy: "alice", error: null, note: "Patch night", asset },
    ], [run], new Map([["r1", run]]), new Set(["r1"]), NOW);
    expect(items.map((i) => i.note)).toEqual(["Leak", "Patch night"]);
    const fw = mergeDeviceItems("firmware", [], [{ ...run, toVersion: "7.6.7" }], new Map(), new Set(), NOW);
    expect(fw[0]).not.toHaveProperty("note");
  });

  it("a booking that ran carries its run's outcome and end, and the run is not drawn twice", () => {
    const run = { id: "r1", assetId: "a1", status: "failed", startedBy: "automation:Mem", startedAt: local(2026, 8, 10, 2, 0), finishedAt: local(2026, 8, 10, 2, 40), error: "did not come back", asset };
    const items = mergeDeviceItems("reboot", [
      { id: "b1", assetId: "a1", scheduledFor: local(2026, 8, 10, 2, 0), status: "started", runId: "r1", createdBy: "automation:Mem", error: null, asset },
    ], [run], new Map([["r1", run]]), new Set(["r1"]), NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "booking:b1", status: "failed", end: "2026-08-10T02:40", error: "did not come back", runId: "r1" });
  });

  it("a reboot-now is its own item; a run still going ends at now", () => {
    const items = mergeDeviceItems("firmware", [], [
      { id: "fr1", assetId: "a1", status: "running", startedBy: "dmoore", startedAt: local(2026, 8, 12, 8, 0), finishedAt: null, error: null, toVersion: "7.6.7", asset },
    ], new Map(), new Set(), NOW);
    expect(items[0]).toMatchObject({ id: "run:fr1", booked: false, status: "running", start: "2026-08-12T08:00", end: "2026-08-12T09:00", toVersion: "7.6.7", by: "dmoore" });
  });

  it("names a device with no hostname by its address, then its id", () => {
    const items = mergeDeviceItems("reboot", [
      { id: "b1", assetId: "a1", scheduledFor: NOW, status: "pending", runId: null, createdBy: "x", error: null, asset: { hostname: null, ipAddress: "10.0.0.9" } },
      { id: "b2", assetId: "a2", scheduledFor: NOW, status: "pending", runId: null, createdBy: "x", error: null, asset: null },
    ], [], new Map(), new Set(), NOW);
    expect(items.map((i) => i.assetName)).toEqual(["10.0.0.9", "a2"]);
  });
});

describe("groupItem (rule 122)", () => {
  it("draws a group booking on its FortiGate, carrying the group id for the click-through", () => {
    const at = new Date(2026, 9, 17, 2, 0);
    const item = groupItem({ id: "g1", gateAssetId: "gate-1", scheduledFor: at, status: "pending", createdBy: "alice", error: null, finishedAt: null, gate: { hostname: "FGT-HQ", ipAddress: null }, _count: { members: 7 } }, at);
    expect(item).toMatchObject({ kind: "firmware", id: "group:g1", assetId: "gate-1", assetName: "group of 7 on FGT-HQ", booked: true, scheduleId: null, runId: null, status: "pending", groupId: "g1" });
    expect(item.start).toBe("2026-10-17T02:00");
  });
});

describe("calendarRange", () => {
  it("is [first day midnight, the day after the last)", () => {
    const r = calendarRange("2026-08-01", "2026-08-31");
    expect(r.start.getTime()).toBe(local(2026, 8, 1, 0, 0).getTime());
    expect(r.end.getTime()).toBe(local(2026, 9, 1, 0, 0).getTime());
  });
  it("refuses a reversed, malformed or too-wide range", () => {
    expect(() => calendarRange("2026-08-31", "2026-08-01")).toThrow(AppError);
    expect(() => calendarRange("2026-13-45", "2026-08-01")).toThrow(AppError);
    expect(() => calendarRange("2026-01-01", "2027-06-01")).toThrow(/too wide/);
  });
});

describe("listCalendar", () => {
  it("returns only the kinds asked for — a kind not asked for is null, not empty", async () => {
    h.occurrences = { occurrences: [{ scheduleId: "s1", name: "Patching", enabled: true, kind: "recurring", adhoc: false, start: "2026-08-12T22:00", end: "2026-08-13T02:00" }], truncated: false };
    const res = await listCalendar({ from: "2026-08-01", to: "2026-08-31", kinds: new Set(["maintenance"]), now: NOW });
    expect(res.maintenance).toHaveLength(1);
    expect(res.reboot).toBeNull();
    expect(res.firmware).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it("fetches a run a booking points at when the run started outside the range", async () => {
    h.rebootSchedules = [{ id: "b1", assetId: "a1", scheduledFor: local(2026, 8, 31, 23, 59), status: "started", runId: "r9", createdBy: "dmoore", error: null, asset }];
    h.extraRuns = [{ id: "r9", assetId: "a1", status: "succeeded", startedBy: "dmoore", startedAt: local(2026, 9, 1, 0, 1), finishedAt: local(2026, 9, 1, 0, 6), error: null, asset }];
    const res = await listCalendar({ from: "2026-08-01", to: "2026-08-31", kinds: new Set(["reboot"]), now: NOW });
    expect(h.calls).toContain("rebootRun.byId");
    expect(res.reboot![0]).toMatchObject({ status: "succeeded" });
  });

  it("does not draw an in-range run twice when its booking sits outside the range", async () => {
    h.rebootRuns = [{ id: "r1", assetId: "a1", status: "succeeded", startedBy: "dmoore", startedAt: local(2026, 8, 1, 0, 1), finishedAt: null, error: null, asset }];
    h.bookedRunIds = [{ runId: "r1" }];
    const res = await listCalendar({ from: "2026-08-01", to: "2026-08-31", kinds: new Set(["reboot"]), now: NOW });
    expect(res.reboot).toEqual([]);
  });

  it("caps each kind and says so", async () => {
    h.firmwareRuns = Array.from({ length: MAX_DEVICE_ITEMS + 1 }, (_, i) => ({
      id: "f" + i, assetId: "a" + i, status: "succeeded", startedBy: "x", startedAt: local(2026, 8, 2, 1, 0), finishedAt: null, error: null, toVersion: "7.6.7", asset,
    }));
    const res = await listCalendar({ from: "2026-08-01", to: "2026-08-31", kinds: new Set(["firmware"]), now: NOW });
    expect(res.firmware).toHaveLength(MAX_DEVICE_ITEMS);
    expect(res.truncated).toBe(true);
  });
});
