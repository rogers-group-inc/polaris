/**
 * tests/unit/rebootScheduleCancel.test.ts — business rule 115(b): a booked
 * reboot is withdrawn once the device has rebooted some other way.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  pending: [] as Array<{ id: string; scheduledFor: Date }>,
  claimed: new Set<string>(),
  updates: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, any>>,
  throwOnRead: false,
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    rebootSchedule: {
      findMany: vi.fn(async () => { if (h.throwOnRead) throw new Error("db down"); return h.pending; }),
      updateMany: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        h.updates.push(args.data);
        return { count: h.claimed.has(args.where.id) ? 0 : 1 };
      }),
    },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async (e: Record<string, unknown>) => { h.events.push(e); }) }));
vi.mock("../../src/utils/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { cancelPendingRebootAfterReboot } from "../../src/services/rebootScheduleCancel.js";

const when = new Date("2026-10-14T07:00:00Z");

beforeEach(() => {
  h.pending = [];
  h.claimed = new Set();
  h.updates = [];
  h.events = [];
  h.throwOnRead = false;
});

describe("cancelPendingRebootAfterReboot", () => {
  it("does nothing when no reboot is booked", async () => {
    expect(await cancelPendingRebootAfterReboot({ assetId: "a1", cause: "detected", actor: "system:monitor" })).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("cancels the booking when monitoring detects a reboot, and says why", async () => {
    h.pending = [{ id: "s1", scheduledFor: when }];
    expect(await cancelPendingRebootAfterReboot({ assetId: "a1", cause: "detected", actor: "system:monitor", resourceName: "FGT-1" })).toBe(1);
    expect(h.updates[0]).toMatchObject({ status: "cancelled", cancelledBy: "system:reboot" });
    expect(h.events[0]).toMatchObject({ action: "asset.reboot_schedule_cancelled", resourceId: "a1", resourceName: "FGT-1" });
    expect(h.events[0].message).toMatch(/uptime reset/);
    expect(h.events[0].details).toMatchObject({ scheduleId: "s1", automatic: true, cause: "detected" });
  });

  it("names the operator when their reboot-now succeeded", async () => {
    h.pending = [{ id: "s1", scheduledFor: when }];
    await cancelPendingRebootAfterReboot({ assetId: "a1", cause: "manual", actor: "dmoore", runId: "run-9" });
    expect(h.updates[0]).toMatchObject({ cancelledBy: "dmoore" });
    expect(h.events[0].message).toMatch(/rebooted by dmoore/);
    expect(h.events[0].details).toMatchObject({ runId: "run-9", cause: "manual" });
  });

  it("leaves a booking the scheduler claimed in the meantime alone", async () => {
    h.pending = [{ id: "s1", scheduledFor: when }];
    h.claimed.add("s1");
    expect(await cancelPendingRebootAfterReboot({ assetId: "a1", cause: "detected", actor: "system:monitor" })).toBe(0);
    expect(h.events).toHaveLength(0);
  });

  it("never throws", async () => {
    h.throwOnRead = true;
    expect(await cancelPendingRebootAfterReboot({ assetId: "a1", cause: "detected", actor: "system:monitor" })).toBe(0);
  });
});
