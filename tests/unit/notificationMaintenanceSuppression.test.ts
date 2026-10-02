/**
 * tests/unit/notificationMaintenanceSuppression.test.ts
 *
 * Maintenance/dependency suppression semantics in the notification engine:
 * suppressed assets (status="maintenance" or dependencySuppressed) produce no
 * readings (no fire), their `pending` state rows reset to clear, their
 * `firing` rows are left alone (frozen through a window; the down-parent sweep,
 * clearSuppressedAlerts, is notificationSuppressionSweep.test.ts),
 * and a healthy asset in the same scope still evaluates normally. Also locks
 * the shared monitor candidate filter so the polling exclusion can't silently
 * drift.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    notificationRule: { findMany: vi.fn() },
    notificationRuleState: { findMany: vi.fn(), update: vi.fn(), upsert: vi.fn(), findUnique: vi.fn() },
    notification: { create: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
    asset: { findMany: vi.fn(), findUnique: vi.fn() },
    event: { findMany: vi.fn() },
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
    hostMetricsSample: { findMany: vi.fn() },
    assetMaintenanceWindow: { findMany: vi.fn() },
  },
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../../src/services/notificationRecipientService.js", () => ({
  expandDeliveries: vi.fn(async () => {}),
  scopeRegionTagsOf: vi.fn(() => []),
}));

import {
  evaluateAllNotificationRules,
  isSuppressedForNotifications,
  frozenReadingIsFresh,
} from "../../src/services/notificationEngine.js";
import { MONITOR_CANDIDATE_WHERE } from "../../src/services/monitoringService.js";

function scopeAsset(id: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    hostname: id.toUpperCase(),
    assetType: "server",
    tags: [],
    discoveredByIntegrationId: null,
    monitorStatus: "up",
    status: "active",
    consecutiveFailures: 0,
    dependencySuppressed: false,
    quarantinedAt: null,
    ...over,
  };
}

// A no-debounce asset_state rule that fires when monitorStatus == "down".
const DOWN_RULE = {
  id: "r1",
  name: "Down rule",
  description: null,
  enabled: true,
  severity: "warning",
  trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down", forDurationSec: 0 },
  scope: { allAssets: true },
  clearBehavior: "manual",
  clearAfterSec: null,
  cooldownSec: null,
  messageTemplate: null,
  channels: ["in_app"],
  targets: [],
  emailComposition: null,
  escalation: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.notificationRule.findMany.mockResolvedValue([DOWN_RULE]);
  h.prisma.notificationRuleState.findMany.mockResolvedValue([]);
  h.prisma.notification.create.mockResolvedValue({ id: "n1" });
  h.prisma.setting.findUnique.mockResolvedValue(null);
  h.prisma.event.findMany.mockResolvedValue([]);
  h.prisma.assetMaintenanceWindow.findMany.mockResolvedValue([]);
});

describe("isSuppressedForNotifications", () => {
  it("suppresses maintenance and dependency-suppressed assets only", () => {
    expect(isSuppressedForNotifications({ status: "maintenance", dependencySuppressed: false })).toBe(true);
    expect(isSuppressedForNotifications({ status: "active", dependencySuppressed: true })).toBe(true);
    expect(isSuppressedForNotifications({ status: "active", dependencySuppressed: false })).toBe(false);
    expect(isSuppressedForNotifications({ status: "quarantined", dependencySuppressed: false })).toBe(false);
  });
});

describe("threshold-rule suppression", () => {
  it("a down asset in maintenance does not fire; a healthy-scope down asset does", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("maint", { status: "maintenance", monitorStatus: "down" }),
      scopeAsset("live", { monitorStatus: "down" }),
    ]);
    // fire() re-reads the per-key state row for the cooldown check.
    h.prisma.notificationRuleState.findUnique.mockResolvedValue(null);

    await evaluateAllNotificationRules();

    expect(h.prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.notification.create.mock.calls[0][0].data.assetId).toBe("live");
  });

  it("a dependency-suppressed down asset does not fire", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("child", { dependencySuppressed: true, monitorStatus: "down" }),
    ]);

    await evaluateAllNotificationRules();

    expect(h.prisma.notification.create).not.toHaveBeenCalled();
  });

  it("resets a suppressed asset's pending row to clear and leaves firing rows to the sweep", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("maint", { status: "maintenance", monitorStatus: "down" }),
    ]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([
      { id: "st-pending", ruleId: "r1", assetId: "maint", dimensionKey: "", state: "pending", conditionMetSince: new Date(), firedAt: null, notificationId: null },
      { id: "st-firing", ruleId: "r1", assetId: "maint", dimensionKey: "x", state: "firing", conditionMetSince: null, firedAt: new Date(), notificationId: "n-old" },
    ]);

    await evaluateAllNotificationRules();

    // pending → clear
    expect(h.prisma.notificationRuleState.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "st-pending" }, data: expect.objectContaining({ state: "clear" }) }),
    );
    // firing row untouched: a maintenance window freezes a live alert, it
    // never retires it (business rule 16).
    const touchedIds = h.prisma.notificationRuleState.update.mock.calls.map((c) => c[0].where.id);
    expect(touchedIds).not.toContain("st-firing");
    expect(h.prisma.notification.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.notification.create).not.toHaveBeenCalled();
  });
});

describe("frozenReadingIsFresh (business rule 16 — frozen, not deaf)", () => {
  const start = new Date("2026-10-02T00:00:00Z");
  it("needs a reading at all", () => {
    expect(frozenReadingIsFresh(null, false, null)).toBe(false);
    expect(frozenReadingIsFresh(undefined, true, start)).toBe(false);
  });
  it("dependency-suppressed only: any timestamped reading is current", () => {
    expect(frozenReadingIsFresh(new Date("2020-01-01T00:00:00Z"), false, null)).toBe(true);
  });
  it("in maintenance: strictly after the window opened", () => {
    expect(frozenReadingIsFresh(new Date(start.getTime() + 1), true, start)).toBe(true);
    expect(frozenReadingIsFresh(new Date(start.getTime()), true, start)).toBe(false);
    expect(frozenReadingIsFresh(new Date(start.getTime() - 60_000), true, start)).toBe(false);
  });
  it("in maintenance with no open window: never fresh", () => {
    expect(frozenReadingIsFresh(new Date(), true, null)).toBe(false);
  });
});

describe("a frozen alert recovers on evidence taken during the window", () => {
  const AUTO_RULE = { ...DOWN_RULE, clearBehavior: "auto" };
  const windowStart = new Date(Date.now() - 6 * 3600_000);
  const firingRow = {
    id: "st-firing", ruleId: "r1", assetId: "nvr", dimensionKey: "", state: "firing",
    conditionMetSince: null, recoveredSince: null, firedAt: new Date(windowStart.getTime() - 60_000),
    notificationId: "n-old", metRun: 0, clearRun: 0, lastReadingAt: null,
  };

  beforeEach(() => {
    h.prisma.notificationRule.findMany.mockResolvedValue([AUTO_RULE]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([firingRow]);
    h.prisma.notificationRuleState.findUnique.mockResolvedValue(firingRow);
    h.prisma.notification.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.assetMaintenanceWindow.findMany.mockResolvedValue([{ assetId: "nvr", startedAt: windowStart }]);
  });

  const clearedIds = () => h.prisma.notificationRuleState.update.mock.calls
    .filter((c) => c[0].data?.state === "clear").map((c) => c[0].where.id);

  it("an agent-pushed `up` after the window opened clears the Down alert", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("nvr", { status: "maintenance", monitorStatus: "up", lastMonitorAt: new Date() }),
    ]);
    await evaluateAllNotificationRules();
    expect(clearedIds()).toContain("st-firing");
    expect(h.prisma.notification.create).not.toHaveBeenCalled();
  });

  it("an `up` left over from before the window does not", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("nvr", { status: "maintenance", monitorStatus: "up", lastMonitorAt: new Date(windowStart.getTime() - 120_000) }),
    ]);
    await evaluateAllNotificationRules();
    expect(clearedIds()).not.toContain("st-firing");
  });

  it("a maintenance status with no open window row stays frozen", async () => {
    h.prisma.assetMaintenanceWindow.findMany.mockResolvedValue([]);
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("nvr", { status: "maintenance", monitorStatus: "up", lastMonitorAt: new Date() }),
    ]);
    await evaluateAllNotificationRules();
    expect(clearedIds()).not.toContain("st-firing");
  });

  it("a fresh reading that is still down neither clears nor re-fires", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("nvr", { status: "maintenance", monitorStatus: "down", lastMonitorAt: new Date() }),
    ]);
    await evaluateAllNotificationRules();
    expect(clearedIds()).not.toContain("st-firing");
    expect(h.prisma.notification.create).not.toHaveBeenCalled();
  });

  it("a suppressed asset with no firing row is not re-read into a fire", async () => {
    h.prisma.notificationRuleState.findMany.mockResolvedValue([]);
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("nvr", { status: "maintenance", monitorStatus: "down", lastMonitorAt: new Date() }),
    ]);
    await evaluateAllNotificationRules();
    expect(h.prisma.notification.create).not.toHaveBeenCalled();
    expect(h.prisma.assetMaintenanceWindow.findMany).not.toHaveBeenCalled();
  });
});

describe("MONITOR_CANDIDATE_WHERE", () => {
  it("selects monitored assets and excludes maintenance status", () => {
    expect(MONITOR_CANDIDATE_WHERE).toEqual({ monitored: true, status: { not: "maintenance" } });
  });
});
