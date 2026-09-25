/**
 * tests/unit/pathFailureRateCeiling.test.ts
 *
 * A path check's failure rate is a windowed ratio like packet loss, but it does
 * NOT take packet loss's saturation ceiling (business rule 85). At 100% loss
 * the device is down and the down automation owns the outage (rule 29); at
 * 100% path failures the host is up and is the one reporting — every run to
 * the target failed, which is exactly what the operator's rule is for.
 *
 * Before this was pinned, `pathFailurePct` inherited the default ceiling of
 * 100: a total outage of the target never fired, and a live alert CLEARED
 * (`system:reading-saturated`) as the rate climbed to 100%.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    notificationRule: { findMany: vi.fn() },
    notificationRuleState: { findMany: vi.fn(), update: vi.fn(), upsert: vi.fn(), findUnique: vi.fn() },
    notification: { create: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
    asset: { findMany: vi.fn(), findUnique: vi.fn() },
    assetTelemetrySample: { findMany: vi.fn() },
    assetPathCheckSample: { groupBy: vi.fn(), findMany: vi.fn() },
    pathCheck: { findMany: vi.fn() },
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

import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";

const HOST = "host-1";
const CHECK = "check-erp";

function scopeAsset(id: string) {
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
  };
}

function pathRule(trigger: Record<string, unknown> = {}) {
  return {
    id: "r1",
    name: "ERP unreachable from a site",
    description: null,
    enabled: true,
    severity: "critical",
    trigger: {
      type: "asset_metric", metric: "pathFailurePct", aggregation: "latest",
      windowSec: 600, operator: ">=", threshold: 50, forDurationSec: 0, ...trigger,
    },
    scope: { allAssets: true },
    clearBehavior: "auto",
    clearAfterSec: null,
    cooldownSec: null,
    messageTemplate: null,
    channels: ["in_app"],
    targets: [],
    emailComposition: null,
    escalation: null,
  };
}

/** The grouped (host, check, ok) counts the resolver aggregates. */
function runs(failed: number, passed: number) {
  const at = new Date();
  const rows = [];
  if (failed) rows.push({ assetId: HOST, checkId: CHECK, ok: false, _count: { _all: failed }, _max: { timestamp: at } });
  if (passed) rows.push({ assetId: HOST, checkId: CHECK, ok: true, _count: { _all: passed }, _max: { timestamp: at } });
  h.prisma.assetPathCheckSample.groupBy.mockResolvedValue(rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.notificationRule.findMany.mockResolvedValue([pathRule()]);
  h.prisma.notificationRuleState.findMany.mockResolvedValue([]);
  h.prisma.notificationRuleState.findUnique.mockResolvedValue(null);
  h.prisma.notification.create.mockResolvedValue({ id: "n1" });
  h.prisma.setting.findUnique.mockResolvedValue(null);
  h.prisma.event.findMany.mockResolvedValue([]);
  h.prisma.assetTelemetrySample.findMany.mockResolvedValue([]);
  h.prisma.asset.findMany.mockResolvedValue([scopeAsset(HOST)]);
  h.prisma.pathCheck.findMany.mockResolvedValue([{ id: CHECK, name: "ERP" }]);
});

describe("path failure rate has no saturation ceiling", () => {
  it("fires when every run failed", async () => {
    runs(10, 0);
    await evaluateAllNotificationRules();
    expect(h.prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  it("still fires below 100%, as any ratio would", async () => {
    runs(6, 4);
    await evaluateAllNotificationRules();
    expect(h.prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  it("ignores a stored ceiling — the field is packet loss's alone", async () => {
    // An API write, or a rule saved before the wizard stopped offering the box.
    h.prisma.notificationRule.findMany.mockResolvedValue([pathRule({ ignoreAtOrAbove: 90 })]);
    runs(10, 0);
    await evaluateAllNotificationRules();
    expect(h.prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  it("keeps a live alert open at 100% instead of clearing it as saturated", async () => {
    h.prisma.notificationRuleState.findMany.mockResolvedValue([{
      id: "s1", ruleId: "r1", assetId: HOST, dimensionKey: CHECK, state: "firing", notificationId: "n9",
      firedAt: new Date(Date.now() - 60_000), conditionMetSince: new Date(Date.now() - 60_000),
      recoveredSince: null, lastValue: 80, firingSeverity: null, bandMetSince: null,
    }]);
    runs(10, 0);
    await evaluateAllNotificationRules();
    const cleared = h.prisma.notification.updateMany.mock.calls.map((c: any) => c[0]?.data?.clearedBy);
    expect(cleared).not.toContain("system:reading-saturated");
    const upd = h.prisma.notificationRuleState.update.mock.calls.find((c: any) => c[0].where.id === "s1");
    if (upd) expect(upd[0].data.state).not.toBe("clear");
  });
});
