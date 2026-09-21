/**
 * tests/unit/notificationSuppressionSweep.test.ts
 *
 * clearSuppressedAlerts: an asset inside a maintenance window (or suppressed
 * behind a dark parent) must not carry a live alert — business rule 16. The
 * sweep soft-clears the alert with a reason, releases the state row so the
 * condition re-earns its debounce after the window, and leaves alerts on
 * healthy assets alone.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    notification: { findMany: vi.fn(), updateMany: vi.fn() },
    notificationRuleState: { updateMany: vi.fn() },
    asset: { findMany: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
  logEventsBatch: vi.fn(async () => 0),
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: vi.fn(async () => {}),
  logEventsBatch: h.logEventsBatch,
}));

import { clearSuppressedAlerts } from "../../src/services/notificationService.js";

const ALERT = (id: string, assetId: string, ruleName = "CPU high") => ({
  id, assetId, rule: { name: ruleName },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);
});

describe("clearSuppressedAlerts", () => {
  it("clears a maintenance asset's live alert and releases its state row", async () => {
    h.prisma.notification.findMany.mockResolvedValue([ALERT("n1", "a1")]);
    h.prisma.asset.findMany.mockResolvedValue([
      { id: "a1", hostname: "SW-1", status: "maintenance", dependencySuppressed: false },
    ]);

    const n = await clearSuppressedAlerts();

    expect(n).toBe(1);
    expect(h.prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["n1"] }, cleared: false },
        data: expect.objectContaining({ cleared: true, clearedBy: "system:maintenance" }),
      }),
    );
    // The state machine must let go, or the key sits firing on a dead alert.
    expect(h.prisma.notificationRuleState.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { notificationId: { in: ["n1"] } },
        data: expect.objectContaining({ state: "clear", notificationId: null }),
      }),
    );
    const events = h.logEventsBatch.mock.calls[0][0] as any[];
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("notification.suppressed");
    expect(events[0].message).toContain("SW-1");
  });

  it("names dependency suppression as its own reason", async () => {
    h.prisma.notification.findMany.mockResolvedValue([ALERT("n2", "a2")]);
    h.prisma.asset.findMany.mockResolvedValue([
      { id: "a2", hostname: "AP-9", status: "active", dependencySuppressed: true },
    ]);

    await clearSuppressedAlerts();

    expect(h.prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ clearedBy: "system:dependency-suppressed" }) }),
    );
  });

  it("never retires an alert RAISED FOR a dependency-suppressed device (business rule 78)", async () => {
    // A down automation that opted in raises that alert on purpose; the sweep
    // clearing it would re-raise it on the next tick, forever. The exclusion is
    // in the QUERY — such rows never even reach the asset lookup.
    h.prisma.notification.findMany.mockResolvedValue([]);
    await clearSuppressedAlerts();
    expect(h.prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ cleared: false, dependencyDown: false }) }),
    );
  });

  it("maintenance wins when an asset is both — it is the downtime the operator announced", async () => {
    h.prisma.notification.findMany.mockResolvedValue([ALERT("n3", "a3")]);
    h.prisma.asset.findMany.mockResolvedValue([
      { id: "a3", hostname: "FW-1", status: "maintenance", dependencySuppressed: true },
    ]);

    await clearSuppressedAlerts();

    expect(h.prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ clearedBy: "system:maintenance" }) }),
    );
  });

  it("leaves alerts on healthy assets alone", async () => {
    h.prisma.notification.findMany.mockResolvedValue([ALERT("n4", "a4"), ALERT("n5", "a5")]);
    h.prisma.asset.findMany.mockResolvedValue([
      { id: "a5", hostname: "SW-2", status: "maintenance", dependencySuppressed: false },
    ]);

    const n = await clearSuppressedAlerts();

    expect(n).toBe(1);
    expect(h.prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["n5"] }, cleared: false } }),
    );
  });

  it("writes nothing when no alert belongs to a suppressed asset", async () => {
    h.prisma.notification.findMany.mockResolvedValue([ALERT("n6", "a6")]);
    h.prisma.asset.findMany.mockResolvedValue([]);

    expect(await clearSuppressedAlerts()).toBe(0);
    expect(h.prisma.notification.updateMany).not.toHaveBeenCalled();
    expect(h.logEventsBatch).not.toHaveBeenCalled();
  });

  it("scopes to the assets just handed to it, and short-circuits on an empty set", async () => {
    expect(await clearSuppressedAlerts([])).toBe(0);
    expect(h.prisma.notification.findMany).not.toHaveBeenCalled();

    h.prisma.notification.findMany.mockResolvedValue([]);
    await clearSuppressedAlerts(["a7", "a8"]);
    expect(h.prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ cleared: false, assetId: { in: ["a7", "a8"] } }),
      }),
    );
  });

  it("only ever considers alerts that have an asset", async () => {
    h.prisma.notification.findMany.mockResolvedValue([]);
    await clearSuppressedAlerts();
    expect(h.prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ assetId: { not: null } }) }),
    );
  });
});
