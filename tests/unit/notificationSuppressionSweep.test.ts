/**
 * tests/unit/notificationSuppressionSweep.test.ts
 *
 * clearSuppressedAlerts — business rule 16. An asset dark behind a parent that
 * is genuinely DOWN must not carry a live alert: the sweep soft-clears it,
 * releases the state row so the condition re-earns its debounce, and leaves
 * alerts on healthy assets alone. A MAINTENANCE WINDOW freezes an alert rather
 * than retiring it — on the asset in the window and on a child whose
 * suppression is owed to a maintained parent — except a DOWN alert, which it
 * retires (rule 16(a)).
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

const CPU_TRIGGER = { type: "threshold", metric: "cpu", operator: ">", value: 90 };
const DOWN_TRIGGER = { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" };

const ALERT = (id: string, assetId: string, ruleName = "CPU high", trigger: unknown = CPU_TRIGGER) => ({
  id, assetId, rule: { name: ruleName, trigger },
});
const DOWN_ALERT = (id: string, assetId: string) => ALERT(id, assetId, "Device down", DOWN_TRIGGER);

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

  it("asks about assets that are dependency-suppressed OR in their own window", async () => {
    h.prisma.notification.findMany.mockResolvedValue([ALERT("n2", "a2")]);
    h.prisma.asset.findMany.mockResolvedValue([]);

    expect(await clearSuppressedAlerts()).toBe(0);
    expect(h.prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: [{ dependencySuppressed: true }, { status: "maintenance" }] }),
      }),
    );
    expect(h.resolveDependencyBlameMany).not.toHaveBeenCalled();
    expect(h.prisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it("freezes a non-down alert on an asset in its own window (rule 16)", async () => {
    h.prisma.notification.findMany.mockResolvedValue([ALERT("n2", "a2")]);
    h.prisma.asset.findMany.mockResolvedValue([{ id: "a2", hostname: "NVR-1", status: "maintenance", dependencySuppressed: true }]);

    expect(await clearSuppressedAlerts()).toBe(0);
    // In its own window: no blame walk needed, whatever the dependency flag says.
    expect(h.resolveDependencyBlameMany).not.toHaveBeenCalled();
    expect(h.prisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it("retires a DOWN alert on an asset in its own window as system:maintenance (rule 16(a))", async () => {
    h.prisma.notification.findMany.mockResolvedValue([DOWN_ALERT("n9", "a9"), ALERT("n10", "a9")]);
    h.prisma.asset.findMany.mockResolvedValue([{ id: "a9", hostname: "NVR-9", status: "maintenance" }]);

    expect(await clearSuppressedAlerts()).toBe(1);
    expect(h.resolveDependencyBlameMany).not.toHaveBeenCalled();
    expect(h.prisma.notification.updateMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["n9"] }, cleared: false },
        data: expect.objectContaining({ cleared: true, clearedBy: "system:maintenance" }),
      }),
    );
    expect(h.prisma.notificationRuleState.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { notificationId: { in: ["n9"] } } }),
    );
    const events = h.logEventsBatch.mock.calls[0][0] as any[];
    expect(events).toHaveLength(1);
    expect(events[0].details).toEqual({ assetId: "a9", reason: "maintenance" });
    expect(events[0].message).toContain("NVR-9");
  });

  it("retires a child's DOWN alert behind a MAINTAINED parent, freezing its other alerts", async () => {
    h.prisma.notification.findMany.mockResolvedValue([DOWN_ALERT("n11", "a11"), ALERT("n12", "a11")]);
    h.prisma.asset.findMany.mockResolvedValue([{ id: "a11", hostname: "AP-11", status: "active" }]);
    h.resolveDependencyBlameMany.mockResolvedValue(new Map([["a11", blame("suppressed", "maintenance")]]));

    expect(await clearSuppressedAlerts()).toBe(1);
    expect(h.prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["n11"] }, cleared: false },
        data: expect.objectContaining({ clearedBy: "system:maintenance" }),
      }),
    );
  });

  it("writes each clearedBy in its own update when both reasons land in one tick", async () => {
    h.prisma.notification.findMany.mockResolvedValue([DOWN_ALERT("n13", "a13"), ALERT("n14", "a14")]);
    h.prisma.asset.findMany.mockResolvedValue([
      { id: "a13", hostname: "SW-13", status: "maintenance" },
      { id: "a14", hostname: "SW-14", status: "active" },
    ]);
    h.resolveDependencyBlameMany.mockResolvedValue(new Map([["a14", blame("down")]]));

    expect(await clearSuppressedAlerts()).toBe(2);
    // Only the non-maintained asset needs the walk.
    expect(h.resolveDependencyBlameMany).toHaveBeenCalledWith(["a14"]);
    expect(h.prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["n14"] }, cleared: false }, data: expect.objectContaining({ clearedBy: "system:dependency-suppressed" }) }),
    );
    expect(h.prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["n13"] }, cleared: false }, data: expect.objectContaining({ clearedBy: "system:maintenance" }) }),
    );
    expect(h.prisma.notificationRuleState.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { notificationId: { in: ["n14", "n13"] } } }),
    );
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
