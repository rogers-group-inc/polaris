/**
 * tests/unit/notificationClearReleasesState.test.ts
 *
 * clearNotifications — an operator clearing an alert by hand releases the
 * NotificationRuleState rows behind it. Left `firing`, the engine reads a
 * condition that still holds as "already raised" and never alerts again: a
 * FortiGate whose down alert was cleared while it stayed down went silent
 * until it came back up. Released, the condition re-earns its debounce and
 * raises a NEW alert.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    notification: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 1 })) },
    notificationRuleState: { updateMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: vi.fn(),
  },
  logEvent: vi.fn(async () => {}),
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: h.logEvent,
  logEventsBatch: vi.fn(async () => 0),
}));

import { clearNotifications } from "../../src/services/notificationService.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Prisma resolves a batch transaction to its operations' results in order.
  h.prisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
});

describe("clearNotifications", () => {
  it("releases the rule-state rows behind the cleared alerts, runs included", async () => {
    await clearNotifications(["n1", "n2"], "dmoore");

    expect(h.prisma.notificationRuleState.updateMany).toHaveBeenCalledWith({
      where: { notificationId: { in: ["n1", "n2"] } },
      data: expect.objectContaining({
        state: "clear",
        notificationId: null,
        conditionMetSince: null,
        recoveredSince: null,
        // A stale run would let the next reading fire with no hold at all.
        metRun: 0,
        clearRun: 0,
        lastReadingAt: null,
      }),
    });
  });

  it("clears the alert and the state row in one transaction", async () => {
    await clearNotifications(["n1"], "dmoore");

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    const ops = h.prisma.$transaction.mock.calls[0][0] as unknown[];
    expect(ops).toHaveLength(2);
    expect(h.prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["n1"] }, cleared: false },
      data: expect.objectContaining({ cleared: true, clearedBy: "dmoore" }),
    });
  });

  it("frees a row stranded behind an alert that is already cleared", async () => {
    // The alert flip matches nothing (cleared before this fix), but the row
    // pointing at it is still released — the state filter is not narrowed to
    // the alerts this call happened to flip.
    h.prisma.notification.updateMany.mockResolvedValueOnce({ count: 0 });

    const n = await clearNotifications(["old"], "dmoore");

    expect(n).toBe(0);
    expect(h.prisma.notificationRuleState.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { notificationId: { in: ["old"] } } }),
    );
  });

  it("returns the count of alerts it cleared and audits it", async () => {
    h.prisma.notification.updateMany.mockResolvedValueOnce({ count: 2 });

    const n = await clearNotifications(["n1", "n2"], "dmoore");

    expect(n).toBe(2);
    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "notification.cleared", details: { ids: ["n1", "n2"], count: 2 } }),
    );
  });

  it("refuses an empty batch", async () => {
    await expect(clearNotifications([], "dmoore")).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});
