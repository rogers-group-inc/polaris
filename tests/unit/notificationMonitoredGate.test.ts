/**
 * tests/unit/notificationMonitoredGate.test.ts
 *
 * "An automation only fires about a device Polaris is actually polling."
 *
 * Three layers, because the hole this closes was that they disagreed:
 *   - statusAllowsMonitoring / UNMONITORABLE_STATUSES — the four lifecycle
 *     statuses that can't carry `monitored` at all (business rule 10).
 *   - assetCanTrigger — the ONE per-asset gate, shared by the threshold /
 *     composite paths and the event/change tail.
 *   - the SQL half: every evaluation load pushes `monitored: true` into the
 *     WHERE, while the builder's device-list preview deliberately does not
 *     (it reports the unmonitored remainder instead of hiding it).
 *
 * The bug that motivated the gate: `monitorStatus` is NOT cleared when
 * monitoring is turned off, so a `monitorStatus == down` automation kept an
 * alert firing forever about a device nobody had polled since it was shelved.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    notificationRule: { findMany: vi.fn() },
    notificationRuleState: { findMany: vi.fn(), update: vi.fn(), upsert: vi.fn(), findUnique: vi.fn() },
    notification: { create: vi.fn(), createMany: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    asset: { findMany: vi.fn(), findUnique: vi.fn() },
    event: { findMany: vi.fn() },
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
    hostMetricsSample: { findMany: vi.fn() },
    // The event tail's second gate reads maintenance-window HISTORY, so it can
    // judge an event against the window that was open when it happened rather
    // than against the asset's status a tick later (business rule 80a).
    // Default: no windows — the asset was never in maintenance.
    assetMaintenanceWindow: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../../src/services/notificationRecipientService.js", () => ({
  expandDeliveries: vi.fn(async () => {}),
  scopeRegionTagsOf: vi.fn(() => []),
}));

import {
  assetCanTrigger,
  clearAssetDetailCache,
  evaluateAllNotificationRules,
  previewRule,
} from "../../src/services/notificationEngine.js";
import { statusAllowsMonitoring, UNMONITORABLE_STATUSES } from "../../src/utils/assetInvariants.js";

function scopeAsset(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    hostname: id.toUpperCase(),
    assetType: "server",
    tags: [],
    discoveredByIntegrationId: null,
    monitorStatus: "down",
    status: "active",
    consecutiveFailures: 0,
    dependencySuppressed: false,
    quarantinedAt: null,
    monitored: true,
    ...over,
  };
}

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

const EVENT_RULE = {
  ...DOWN_RULE,
  id: "r-ev",
  name: "Firmware changed",
  trigger: { type: "event", actionPattern: "asset.firmware.changed" },
  reset: { mode: "manual" },
  actions: [],
};

function firmwareEvent(assetId: string | null) {
  return {
    id: "e1",
    timestamp: new Date(),
    action: "asset.firmware.changed",
    level: "info",
    resourceType: assetId ? "asset" : "system",
    resourceId: assetId,
    resourceName: assetId ? assetId.toUpperCase() : "Polaris",
    actor: "system",
    message: "Firmware 7.4.1 to 7.4.5",
    details: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAssetDetailCache();
  h.prisma.notificationRuleState.findMany.mockResolvedValue([]);
  h.prisma.notification.create.mockResolvedValue({ id: "n1" });
  h.prisma.notification.findMany.mockResolvedValue([]);
  h.prisma.notificationRuleState.findUnique.mockResolvedValue(null);
  h.prisma.setting.findUnique.mockResolvedValue(null);
  h.prisma.event.findMany.mockResolvedValue([]);
  h.prisma.asset.findMany.mockResolvedValue([]);
});

describe("statusAllowsMonitoring", () => {
  it("refuses exactly the four unmonitorable lifecycle statuses", () => {
    expect(UNMONITORABLE_STATUSES).toEqual(["decommissioned", "disabled", "storage", "quarantined"]);
    for (const s of UNMONITORABLE_STATUSES) expect(statusAllowsMonitoring(s)).toBe(false);
  });
  it("allows the statuses a monitored device legitimately sits in", () => {
    expect(statusAllowsMonitoring("active")).toBe(true);
    // maintenance keeps `monitored` so the operator's intent survives the
    // window — the window pauses POLLING, it doesn't revoke monitoring.
    expect(statusAllowsMonitoring("maintenance")).toBe(true);
  });
  it("is permissive about values it has never heard of", () => {
    // The enum is the authority on what a status may be; an unknown value must
    // not silently stop polling.
    expect(statusAllowsMonitoring("some_future_status")).toBe(true);
    expect(statusAllowsMonitoring(undefined)).toBe(true);
    expect(statusAllowsMonitoring(null)).toBe(true);
  });
});

describe("assetCanTrigger", () => {
  const live = { monitored: true, status: "active", dependencySuppressed: false };

  it("passes a monitored, unsuppressed asset", () => {
    expect(assetCanTrigger(live)).toBe(true);
  });
  it("refuses an unmonitored asset", () => {
    expect(assetCanTrigger({ ...live, monitored: false })).toBe(false);
  });
  it("refuses a maintenance-window or dependency-suppressed asset", () => {
    expect(assetCanTrigger({ ...live, status: "maintenance" })).toBe(false);
    expect(assetCanTrigger({ ...live, dependencySuppressed: true })).toBe(false);
  });
  it("passes a row with no `monitored` at all — the host pseudo-asset", () => {
    expect(assetCanTrigger({ status: "active", dependencySuppressed: false })).toBe(true);
  });
});

describe("the SQL gate on evaluation loads", () => {
  it("pushes monitored:true into the WHERE for an allAssets scope", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([DOWN_RULE]);
    await evaluateAllNotificationRules();
    expect(h.prisma.asset.findMany).toHaveBeenCalled();
    expect(h.prisma.asset.findMany.mock.calls[0][0].where).toEqual({ monitored: true });
  });

  it("pushes it alongside a dimensioned scope without making an empty scope look non-empty", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([
      { ...DOWN_RULE, scope: { assetTypes: ["firewall"] } },
      // No dimensions and not allAssets ⇒ matches nothing, and the gate must
      // not turn that into "every monitored asset".
      { ...DOWN_RULE, id: "r2", scope: {} },
    ]);
    await evaluateAllNotificationRules();
    const wheres = h.prisma.asset.findMany.mock.calls.map((c: any[]) => c[0].where);
    expect(wheres).toContainEqual({ AND: [{ assetType: { in: ["firewall"] } }, { monitored: true }] });
    // The empty scope short-circuits to zero assets — no query at all.
    expect(wheres).toHaveLength(1);
  });

  it("leaves the device-list preview UNFILTERED and reports the remainder", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("live"),
      scopeAsset("shelved", { monitored: false, status: "storage" }),
    ]);
    const res = await previewRule({ scope: { allAssets: true } } as any);
    expect(h.prisma.asset.findMany.mock.calls[0][0].where).toEqual({});
    expect(res.totalEvaluated).toBe(1);
    expect(res.unmonitoredCount).toBe(1);
    expect(res.matches.map((m) => m.assetId)).toEqual(["live"]);
  });
});

describe("the event/change tail honors the same gate", () => {
  beforeEach(() => {
    h.prisma.notificationRule.findMany.mockResolvedValue([EVENT_RULE]);
  });

  it("fires for an event about a monitored asset", async () => {
    h.prisma.event.findMany.mockResolvedValue([firmwareEvent("a-live")]);
    h.prisma.asset.findUnique.mockResolvedValue({
      id: "a-live", hostname: "A-LIVE", status: "active", tags: [],
      dependencySuppressed: false, monitored: true,
    });
    await evaluateAllNotificationRules();
    expect(h.prisma.notification.createMany).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire for an event about an unmonitored asset", async () => {
    h.prisma.event.findMany.mockResolvedValue([firmwareEvent("a-shelved")]);
    h.prisma.asset.findUnique.mockResolvedValue({
      id: "a-shelved", hostname: "A-SHELVED", status: "storage", tags: [],
      dependencySuppressed: false, monitored: false,
    });
    await evaluateAllNotificationRules();
    expect(h.prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it("still fires for a system-scoped event, which has no asset to poll", async () => {
    h.prisma.event.findMany.mockResolvedValue([firmwareEvent(null)]);
    await evaluateAllNotificationRules();
    expect(h.prisma.asset.findUnique).not.toHaveBeenCalled();
    expect(h.prisma.notification.createMany).toHaveBeenCalledTimes(1);
  });

  it("still fires when the asset row is GONE — a deletion audit must not be swallowed", async () => {
    h.prisma.event.findMany.mockResolvedValue([firmwareEvent("a-deleted")]);
    h.prisma.asset.findUnique.mockResolvedValue(null);
    await evaluateAllNotificationRules();
    expect(h.prisma.notification.createMany).toHaveBeenCalledTimes(1);
  });
});
