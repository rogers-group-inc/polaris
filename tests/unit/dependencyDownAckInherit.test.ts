/**
 * tests/unit/dependencyDownAckInherit.test.ts
 *
 * Business rule 78a — acknowledging a device's own down alert acknowledges
 * every live dependency-down alert (rule 78's opt-out) whose ROOT CAUSE is that
 * device, with the same person and the same note, and records which alert the
 * acknowledgement came from. The fire-time half (a dependency alert raised
 * after the root was acknowledged is born acknowledged) is pinned in
 * notificationDependencyDownAlert.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    notification: { findMany: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  logEvent: vi.fn(async () => {}),
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent, logEventsBatch: vi.fn() }));

import {
  acknowledgeNotifications,
  inheritableRootCauseId,
  inheritedAckData,
} from "../../src/services/notificationService.js";
import { ackInheritedFromOf } from "../../src/services/nocDashboardService.js";

const blame = (rootId: string, reason = "down") => ({
  upstream: { id: "sw", hostname: "SW-PLANT-3" },
  rootCause: { id: rootId, hostname: rootId.toUpperCase(), reason },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.notification.updateMany.mockImplementation(async (args: any) => ({ count: args.where.id.in.length }));
  h.prisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
});

/** findMany is called: (1) the note-policy read when no note, (2) the root
 *  read, (3) the dependency-children read. A note skips (1). */
function stubReads(roots: unknown[], children: unknown[]) {
  h.prisma.notification.findMany
    .mockResolvedValueOnce(roots)
    .mockResolvedValueOnce(children);
}

describe("inheritableRootCauseId", () => {
  it("answers the root cause only when it is down in its own right", () => {
    expect(inheritableRootCauseId(blame("fg"))).toBe("fg");
    expect(inheritableRootCauseId(blame("fg", "maintenance"))).toBeNull();
    expect(inheritableRootCauseId(blame("fg", "dependency_test"))).toBeNull();
  });
  it("is null for a missing or unreadable snapshot", () => {
    expect(inheritableRootCauseId(null)).toBeNull();
    expect(inheritableRootCauseId({ upstream: null, rootCause: null })).toBeNull();
    expect(inheritableRootCauseId("nope")).toBeNull();
  });
});

describe("ackInheritedFromOf / inheritedAckData", () => {
  it("round-trips the root cause's name through the stored snapshot", () => {
    const data = inheritedAckData({ notificationId: "n1", assetId: "fg", hostname: "FG-PLANT", acknowledgedBy: "jsmith", acknowledgeNote: "fibre cut" });
    expect(data).toMatchObject({ acknowledged: true, acknowledgedBy: "jsmith", acknowledgeNote: "fibre cut" });
    expect(ackInheritedFromOf(data.acknowledgedVia)).toBe("FG-PLANT");
  });
  it("falls back to the asset id, and is null on a direct acknowledgement", () => {
    expect(ackInheritedFromOf({ notificationId: "n1", assetId: "fg", hostname: null })).toBe("fg");
    expect(ackInheritedFromOf(null)).toBeNull();
  });
});

describe("acknowledgeNotifications cascades to dependency-down alerts", () => {
  it("acknowledges the dependency alerts whose root cause is the acknowledged device, with its note", async () => {
    stubReads(
      [{ id: "n-root", assetId: "fg", assetHostname: "FG-PLANT" }],
      [
        { id: "n-plc1", dependencyBlame: blame("fg") },
        { id: "n-plc2", dependencyBlame: blame("fg") },
      ],
    );
    const count = await acknowledgeNotifications(["n-root"], "jsmith", "ISP fibre cut, ticket 4411");
    // The return value is what the operator acknowledged, not the cascade.
    expect(count).toBe(1);

    // The children read asks for live, unacknowledged dependency alerts naming this root.
    const childWhere = h.prisma.notification.findMany.mock.calls[1][0].where;
    expect(childWhere).toMatchObject({ cleared: false, acknowledged: false, dependencyDown: true });
    expect(childWhere.OR).toEqual([{ dependencyBlame: { path: ["rootCause", "id"], equals: "fg" } }]);

    const cascade = h.prisma.notification.updateMany.mock.calls[1][0];
    expect(cascade.where.id.in).toEqual(["n-plc1", "n-plc2"]);
    expect(cascade.data).toMatchObject({
      acknowledged: true,
      acknowledgedBy: "jsmith",
      acknowledgeNote: "ISP fibre cut, ticket 4411",
      acknowledgedVia: { notificationId: "n-root", assetId: "fg", hostname: "FG-PLANT" },
    });

    const events = h.logEvent.mock.calls.map((c) => c[0] as any);
    expect(events).toHaveLength(2);
    expect(events[1].details).toMatchObject({ ids: ["n-plc1", "n-plc2"], count: 2, inheritedFrom: ["n-root"] });
  });

  it("does not cascade from an alert that is not a root-cause down alert", async () => {
    stubReads([], []);
    await acknowledgeNotifications(["n-cpu"], "jsmith", "known");
    // Only the root read ran; no children read, no second write.
    expect(h.prisma.notification.findMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.notification.updateMany).toHaveBeenCalledTimes(1);
  });

  it("skips a child whose snapshot names a root cause that is not down in its own right", async () => {
    stubReads(
      [{ id: "n-root", assetId: "fg", assetHostname: "FG-PLANT" }],
      [{ id: "n-plc", dependencyBlame: blame("fg", "maintenance") }],
    );
    await acknowledgeNotifications(["n-root"], "jsmith", "x");
    expect(h.prisma.notification.updateMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("a failed cascade never fails the operator's own acknowledgement", async () => {
    h.prisma.notification.findMany
      .mockResolvedValueOnce([{ id: "n-root", assetId: "fg", assetHostname: "FG-PLANT" }])
      .mockRejectedValueOnce(new Error("db gone"));
    await expect(acknowledgeNotifications(["n-root"], "jsmith", "x")).resolves.toBe(1);
  });
});
