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

describe("MONITOR_CANDIDATE_WHERE", () => {
  it("selects monitored assets and excludes maintenance status", () => {
    expect(MONITOR_CANDIDATE_WHERE).toEqual({ monitored: true, status: { not: "maintenance" } });
  });
});
