/**
 * tests/unit/notificationTestAlertExpiry.test.ts
 *
 * clearExpiredTestAlerts: a wizard "Test delivery" alert carries ruleId null
 * and writes no state row, so no recovery path can ever close it — without a
 * TTL sweep it sits on the device's Alerts tab forever. The sweep must clear
 * only test rows, only once they are over an hour old, and must leave real
 * alerts of any age alone.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    notification: { updateMany: vi.fn() },
  },
  logEvent: vi.fn(async (_event: unknown) => {}),
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: h.logEvent,
  logEventsBatch: vi.fn(async () => 0),
}));
vi.mock("../../src/services/notificationRuleService.js", () => ({
  findRulesMatchingAsset: vi.fn(async () => []),
}));

import { clearExpiredTestAlerts, TEST_ALERT_TTL_MS } from "../../src/services/notificationService.js";

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.notification.updateMany.mockResolvedValue({ count: 0 });
});

describe("clearExpiredTestAlerts", () => {
  it("clears only uncleared test alerts older than the TTL", async () => {
    const now = new Date("2026-09-01T12:00:00Z");
    h.prisma.notification.updateMany.mockResolvedValue({ count: 2 });

    const cleared = await clearExpiredTestAlerts(now);

    expect(cleared).toBe(2);
    const arg = h.prisma.notification.updateMany.mock.calls[0]![0];
    expect(arg.where.testRun).toBe(true);
    expect(arg.where.cleared).toBe(false);
    // An hour back, so a test fired 59 minutes ago is still on the board.
    expect(+arg.where.triggeredAt.lte).toBe(+now - TEST_ALERT_TTL_MS);
    expect(TEST_ALERT_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("soft-clears with its own reason and preserves history", async () => {
    h.prisma.notification.updateMany.mockResolvedValue({ count: 1 });
    await clearExpiredTestAlerts(new Date("2026-09-01T12:00:00Z"));

    const data = h.prisma.notification.updateMany.mock.calls[0]![0].data;
    expect(data).toMatchObject({ cleared: true, clearedBy: "system:test-expired" });
    expect(data.clearedAt).toBeInstanceOf(Date);
    // No acknowledge/history fields are touched — soft clear only.
    expect(Object.keys(data).sort()).toEqual(["cleared", "clearedAt", "clearedBy"]);
  });

  it("audits one summary line per sweep, not one per row", async () => {
    h.prisma.notification.updateMany.mockResolvedValue({ count: 3 });
    await clearExpiredTestAlerts();

    expect(h.logEvent).toHaveBeenCalledTimes(1);
    const ev = h.logEvent.mock.calls[0]![0] as any;
    expect(ev.action).toBe("notification.auto_cleared");
    expect(ev.details).toMatchObject({ count: 3, reason: "test_expired" });
  });

  it("writes no Event when nothing expired", async () => {
    h.prisma.notification.updateMany.mockResolvedValue({ count: 0 });
    expect(await clearExpiredTestAlerts()).toBe(0);
    expect(h.logEvent).not.toHaveBeenCalled();
  });
});
