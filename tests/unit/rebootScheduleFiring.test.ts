/**
 * tests/unit/rebootScheduleFiring.test.ts — how the startScheduledReboots job
 * fires a due booking (business rule 115, the rule-93 shape): start / refuse /
 * wait on a reboot in progress / give up waiting / miss. Pins the exact
 * sequence of booking writes, the Event and the start call for each path, so
 * the firing loop it shares with the firmware booking (CQ-B033) is proved to
 * write what it wrote before it was shared.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  class Conflict extends Error {}
  return {
    Conflict,
    due: [] as Array<Record<string, any>>,
    calls: [] as Array<[string, unknown]>,
    claimCount: 1,
    startImpl: (async () => ({ id: "run-1" })) as (input: Record<string, unknown>) => Promise<unknown>,
  };
});

vi.mock("../../src/db.js", () => ({
  prisma: {
    rebootSchedule: {
      findMany: vi.fn(async (args: unknown) => { h.calls.push(["findMany", args]); return h.due; }),
      updateMany: vi.fn(async (args: any) => {
        h.calls.push(["updateMany", args]);
        // The results-email claim (notifiedAt) is not the firing claim.
        if ("notifiedAt" in args.where) return { count: 0 };
        return { count: h.claimCount };
      }),
      update: vi.fn(async (args: any) => {
        h.calls.push(["update", args]);
        const s = h.due.find((d) => d.id === args.where.id) ?? {};
        return { assetId: "asset-1", notifyEmails: ["ops@example.com"], ...s, ...args.data };
      }),
    },
    asset: { findUnique: vi.fn(async () => ({ hostname: "SRV-01", ipAddress: "10.0.0.5" })) },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async (e: unknown) => { h.calls.push(["logEvent", e]); }) }));
vi.mock("../../src/services/rebootService.js", () => ({
  checkSchedulableReboot: vi.fn(),
  startReboot: vi.fn(async (input: Record<string, unknown>) => { h.calls.push(["startReboot", input]); return h.startImpl(input); }),
  recordRebootCredentialUse: vi.fn(async () => undefined),
  RebootRunConflictError: h.Conflict,
}));
vi.mock("../../src/services/notificationDeliveryService.js", () => ({ applyBrandLetterhead: vi.fn(), sendEmailThroughChannel: vi.fn() }));
vi.mock("../../src/services/quietTimeSummaryService.js", () => ({ resolveSummaryChannel: vi.fn() }));

import { runDueRebootSchedules } from "../../src/services/rebootScheduleService.js";
import { LATE_GRACE_MS, CONFLICT_WAIT_MS } from "../../src/services/firmwareScheduleService.js";

const AT = new Date("2026-11-09T02:00:00Z");
const row = (over: Record<string, unknown> = {}) => ({ id: "s1", assetId: "asset-1", scheduledFor: AT, createdBy: "alice", error: null, note: "why", ...over });
const findManyArgs = (now: Date) => ["findMany", {
  where: { status: "pending", scheduledFor: { lte: now } },
  orderBy: { scheduledFor: "asc" },
  take: 50,
  select: { id: true, assetId: true, scheduledFor: true, createdBy: true, error: true, note: true },
}];
const claim = (now: Date) => ["updateMany", { where: { id: "s1", status: "pending" }, data: { status: "started", firedAt: now } }];
const settled = (status: string, error: string, now: Date) => [
  ["update", { where: { id: "s1" }, data: { status, error, firedAt: now } }],
  ["logEvent", {
    action: status === "missed" ? "asset.reboot_schedule_missed" : "asset.reboot_schedule_refused",
    resourceType: "asset", resourceId: "asset-1", resourceName: "SRV-01", actor: "system:reboot", level: "warning",
    message: `Scheduled reboot was not started: ${error}`,
    details: { scheduleId: "s1", scheduledFor: AT.toISOString(), error },
  }],
  ["updateMany", { where: { id: "s1", notifiedAt: null }, data: { notifiedAt: expect.any(Date) } }],
];

beforeEach(() => {
  h.due = [];
  h.calls = [];
  h.claimCount = 1;
  h.startImpl = async () => ({ id: "run-1" });
});

describe("runDueRebootSchedules — the firing sequence", () => {
  it("on time: claims, starts with the booking's note, clears the wait reason", async () => {
    const now = new Date(AT.getTime() + 30_000);
    h.due = [row()];
    expect(await runDueRebootSchedules(now)).toEqual({ started: 1, refused: 0, missed: 0, waiting: 0 });
    expect(h.calls).toEqual([
      findManyArgs(now),
      claim(now),
      ["startReboot", { assetId: "asset-1", actor: "alice", scheduleId: "s1", note: "why" }],
      ["update", { where: { id: "s1" }, data: { error: null } }],
    ]);
  });

  it("a claim another tick took is skipped", async () => {
    const now = new Date(AT.getTime() + 30_000);
    h.due = [row()];
    h.claimCount = 0;
    expect(await runDueRebootSchedules(now)).toEqual({ started: 0, refused: 0, missed: 0, waiting: 0 });
    expect(h.calls).toEqual([findManyArgs(now), claim(now)]);
  });

  it("a gate refusal at fire time settles it refused, Event + results claim", async () => {
    const now = new Date(AT.getTime() + 30_000);
    h.due = [row()];
    h.startImpl = async () => { throw new Error("no opt-in"); };
    expect(await runDueRebootSchedules(now)).toEqual({ started: 0, refused: 1, missed: 0, waiting: 0 });
    expect(h.calls).toEqual([
      findManyArgs(now),
      claim(now),
      ["startReboot", { assetId: "asset-1", actor: "alice", scheduleId: "s1", note: "why" }],
      ...settled("refused", "no opt-in", now),
    ]);
  });

  it("a reboot already running puts it back pending with the reason", async () => {
    const now = new Date(AT.getTime() + 30_000);
    h.due = [row()];
    h.startImpl = async () => { throw new h.Conflict("a reboot is running"); };
    expect(await runDueRebootSchedules(now)).toEqual({ started: 0, refused: 0, missed: 0, waiting: 1 });
    expect(h.calls).toEqual([
      findManyArgs(now),
      claim(now),
      ["startReboot", { assetId: "asset-1", actor: "alice", scheduleId: "s1", note: "why" }],
      ["update", { where: { id: "s1" }, data: { status: "pending", firedAt: null, error: "a reboot is running" } }],
    ]);
  });

  it("first seen past the grace = missed, nothing claimed or started", async () => {
    const now = new Date(AT.getTime() + LATE_GRACE_MS + 5 * 60_000);
    h.due = [row()];
    expect(await runDueRebootSchedules(now)).toEqual({ started: 0, refused: 0, missed: 1, waiting: 0 });
    const lateMin = Math.round((LATE_GRACE_MS + 5 * 60_000) / 60_000);
    expect(h.calls).toEqual([
      findManyArgs(now),
      ...settled("missed", `Polaris was not running at the scheduled time and first saw this reboot ${lateMin} min late; it was not started`, now),
    ]);
  });

  it("a booking that was waiting keeps waiting past the grace, then gives up after CONFLICT_WAIT_MS", async () => {
    const pastGrace = new Date(AT.getTime() + LATE_GRACE_MS + 60_000);
    h.due = [row({ error: "a reboot is running" })];
    expect(await runDueRebootSchedules(pastGrace)).toEqual({ started: 1, refused: 0, missed: 0, waiting: 0 });

    h.calls = [];
    const pastWait = new Date(AT.getTime() + CONFLICT_WAIT_MS + 60_000);
    expect(await runDueRebootSchedules(pastWait)).toEqual({ started: 0, refused: 1, missed: 0, waiting: 0 });
    expect(h.calls).toEqual([
      findManyArgs(pastWait),
      ...settled("refused", `a reboot is running — still waiting ${Math.round(CONFLICT_WAIT_MS / 60_000)} min after the scheduled time, so it was not started`, pastWait),
    ]);
  });

  it("several due bookings fire oldest first, one at a time", async () => {
    const now = new Date(AT.getTime() + 30_000);
    h.due = [row(), row({ id: "s2" })];
    await runDueRebootSchedules(now);
    expect(h.calls.filter(([k]) => k === "startReboot").map(([, a]) => (a as any).scheduleId)).toEqual(["s1", "s2"]);
  });
});
