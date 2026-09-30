/**
 * tests/unit/notificationSuppressionSweep.test.ts
 *
 * clearSuppressedAlerts — business rule 16. An asset dark behind a parent that
 * is genuinely DOWN must not carry a live alert: the sweep soft-clears it,
 * releases the state row so the condition re-earns its debounce, and leaves
 * alerts on healthy assets alone. A MAINTENANCE WINDOW never retires an alert —
 * not on the asset in the window, and not on a child whose suppression is owed
 * to a maintained parent.
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
  resolveDependencyBlameMany: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: vi.fn(async () => {}),
  logEventsBatch: h.logEventsBatch,
}));
vi.mock("../../src/services/dependencyTreeService.js", () => ({
  resolveDependencyBlameMany: h.resolveDependencyBlameMany,
}));

import { clearSuppressedAlerts } from "../../src/services/notificationService.js";

const ALERT = (id: string, assetId: string, ruleName = "CPU high") => ({
  id, assetId, rule: { name: ruleName },
});

type Reason = "down" | "maintenance" | "dependency_test" | "suppressed";
/** A blame chain, upstream first, root cause last. */
const blame = (...reasons: Reason[]) => {
  const chain = reasons.map((reason, i) => ({ id: `p${i}`, hostname: `P-${i}`, reason }));
  return { upstream: chain[0], rootCause: chain[chain.length - 1], chain, hops: chain.length, truncated: false };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);
});

describe("clearSuppressedAlerts", () => {
  it("clears an alert behind a DOWN parent and releases its state row", async () => {
    h.prisma.notification.findMany.mockResolvedValue([ALERT("n1", "a1")]);
    h.prisma.asset.findMany.mockResolvedValue([{ id: "a1", hostname: "AP-9" }]);
    h.resolveDependencyBlameMany.mockResolvedValue(new Map([["a1", blame("suppressed", "down")]]));

    const n = await clearSuppressedAlerts();

    expect(n).toBe(1);
    expect(h.prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["n1"] }, cleared: false },
        data: expect.objectContaining({ cleared: true, clearedBy: "system:dependency-suppressed" }),
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
    expect(events[0].message).toContain("AP-9");
  });

  it("only asks about dependency-suppressed assets that are NOT themselves in maintenance", async () => {
    // An asset in its own window is excluded in the QUERY, whatever its
    // dependency flag says — a window never retires an alert (rule 16).
    h.prisma.notification.findMany.mockResolvedValue([ALERT("n2", "a2")]);
    h.prisma.asset.findMany.mockResolvedValue([]);

    expect(await clearSuppressedAlerts()).toBe(0);
    expect(h.prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dependencySuppressed: true, NOT: { status: "maintenance" } }),
      }),
    );
    expect(h.resolveDependencyBlameMany).not.toHaveBeenCalled();
    expect(h.prisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it("leaves a child's alert alone when a MAINTAINED parent is what silenced it", async () => {
    h.prisma.notification.findMany.mockResolvedValue([ALERT("n3", "a3"), ALERT("n4", "a4")]);
    h.prisma.asset.findMany.mockResolvedValue([
      { id: "a3", hostname: "SW-1" },
      { id: "a4", hostname: "AP-2" },
    ]);
    h.resolveDependencyBlameMany.mockResolvedValue(new Map([
      ["a3", blame("maintenance")],
      // A grandchild: the switch above it is suppressed, the gate above THAT
      // is in a window — still owed to maintenance.
      ["a4", blame("suppressed", "maintenance")],
    ]));

    expect(await clearSuppressedAlerts()).toBe(0);
    expect(h.prisma.notification.updateMany).not.toHaveBeenCalled();
    expect(h.logEventsBatch).not.toHaveBeenCalled();
  });

  it("clears only the outage-owed child when both kinds are present", async () => {
    h.prisma.notification.findMany.mockResolvedValue([ALERT("n5", "a5"), ALERT("n6", "a6")]);
    h.prisma.asset.findMany.mockResolvedValue([
      { id: "a5", hostname: "SW-5" },
      { id: "a6", hostname: "SW-6" },
    ]);
    h.resolveDependencyBlameMany.mockResolvedValue(new Map([
      ["a5", blame("maintenance")],
      ["a6", blame("down")],
    ]));

    expect(await clearSuppressedAlerts()).toBe(1);
    expect(h.prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["n6"] }, cleared: false } }),
    );
  });

  it("leaves the alert alone when the blame walk finds nothing (a flag about to be released)", async () => {
    h.prisma.notification.findMany.mockResolvedValue([ALERT("n7", "a7")]);
    h.prisma.asset.findMany.mockResolvedValue([{ id: "a7", hostname: "SW-7" }]);
    h.resolveDependencyBlameMany.mockResolvedValue(new Map([["a7", null]]));

    expect(await clearSuppressedAlerts()).toBe(0);
    expect(h.prisma.notification.updateMany).not.toHaveBeenCalled();
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

  it("only ever considers alerts that have an asset", async () => {
    h.prisma.notification.findMany.mockResolvedValue([]);
    await clearSuppressedAlerts();
    expect(h.prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ assetId: { not: null } }) }),
    );
    expect(h.prisma.asset.findMany).not.toHaveBeenCalled();
  });
});
