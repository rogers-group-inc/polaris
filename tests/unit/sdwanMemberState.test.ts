/**
 * tests/unit/sdwanMemberState.test.ts
 *
 * The `sdwanMemberState` asset-state field: does a WAN member of a named
 * performance-SLA health check still count as alive, per the FortiGate's own
 * verdict (AssetPerfSlaSample.state)?
 *
 * The case it exists for is the one no interface field can answer: a WAN port
 * on a cable modem stays oper-up through an ISP outage, and only the health
 * check knows the member is dead. Covered here: one alert per (health check,
 * member) rather than one per gate; no pin gate (unlike the interface and
 * tunnel resolvers); the health-check and member dimension filters; newest
 * sample wins; and the stored dimension staying in the shape the SD-WAN alert
 * charts parse.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    notificationRule: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    notificationRuleState: { findMany: vi.fn(), update: vi.fn(), upsert: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn(), delete: vi.fn() },
    notification: { create: vi.fn(), updateMany: vi.fn() },
    asset: { findMany: vi.fn(), findUnique: vi.fn() },
    assetTelemetrySample: { findMany: vi.fn() },
    assetInterfaceSample: { findMany: vi.fn() },
    assetIpsecTunnelSample: { findMany: vi.fn() },
    assetPerfSlaSample: { findMany: vi.fn() },
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
import { parseSdwanDimension, isSdwanScopedAlert, chartTokenForMetric } from "../../src/services/alertChartService.js";
import { buildSchemaCatalog, triggerDimensionApplicable, ruleInputSchema } from "../../src/services/notificationTypes.js";
import { streamForMetric } from "../../src/services/notificationCadenceService.js";

/** A FortiGate in scope, with NO pinned interfaces — the point of the field is
 *  that it needs none: SD-WAN members are not an operator-pinned set. */
function gate(id: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    hostname: id.toUpperCase(),
    assetType: "firewall",
    tags: [],
    discoveredByIntegrationId: null,
    monitorStatus: "up",
    status: "active",
    consecutiveFailures: 0,
    dependencySuppressed: false,
    quarantinedAt: null,
    ipAddress: null,
    manufacturer: null,
    model: null,
    os: null,
    monitoredInterfaces: [] as string[],
    ...over,
  };
}

function slaRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    assetId: "fw1",
    healthCheck: "Primary WAN",
    link: "wan1",
    timestamp: new Date(),
    state: "down",
    ...over,
  };
}

const MEMBER_RULE = {
  id: "r1",
  name: "SD-WAN member down",
  description: null,
  enabled: true,
  severity: "serious",
  trigger: { type: "asset_state", field: "sdwanMemberState", operator: "!=", value: "up", forDurationSec: 0 },
  scope: { allAssets: true },
  reset: { mode: "auto" },
  actions: [],
  clearBehavior: "auto",
  clearAfterSec: null,
  cooldownSec: null,
  messageTemplate: null,
  channels: ["in_app"],
  targets: [],
  emailComposition: null,
  escalation: null,
  severityBands: null,
  bandNotify: null,
};

/** Every (dimension, message) pair the pass raised. */
function created() {
  return h.prisma.notification.create.mock.calls.map(([args]: any[]) => args.data);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.notificationRuleState.findMany.mockResolvedValue([]);
  h.prisma.notification.create.mockResolvedValue({ id: "n-new" });
  h.prisma.notification.updateMany.mockResolvedValue({ count: 1 });
  h.prisma.setting.findUnique.mockResolvedValue(null);
  h.prisma.event.findMany.mockResolvedValue([]);
  h.prisma.asset.findMany.mockResolvedValue([]);
  h.prisma.assetTelemetrySample.findMany.mockResolvedValue([]);
  h.prisma.assetInterfaceSample.findMany.mockResolvedValue([]);
  h.prisma.assetIpsecTunnelSample.findMany.mockResolvedValue([]);
  h.prisma.assetPerfSlaSample.findMany.mockResolvedValue([]);
});

describe("sdwanMemberState readings", () => {
  it("raises one alert per (health check, member) and names the pair", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([MEMBER_RULE]);
    h.prisma.asset.findMany.mockResolvedValue([gate("fw1")]);
    h.prisma.assetPerfSlaSample.findMany.mockResolvedValue([
      slaRow({ link: "wan1", state: "down" }),
      slaRow({ link: "wan2", state: "down" }),
      slaRow({ link: "wan3", state: "up" }),
    ]);

    await evaluateAllNotificationRules();

    const rows = created();
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.dimension).sort()).toEqual(["Primary WAN|wan1", "Primary WAN|wan2"]);
    // The operator-facing label names the member, not just the gate.
    expect(rows.map((r: any) => r.message).join(" ")).toContain("Primary WAN / wan1");
  });

  it("fires with no pinned interfaces at all — the ISP case the field exists for", async () => {
    // The WAN port is oper-up and not even monitored; only the health check
    // knows the member is dead. The interface resolvers would produce nothing.
    h.prisma.notificationRule.findMany.mockResolvedValue([MEMBER_RULE]);
    h.prisma.asset.findMany.mockResolvedValue([gate("fw1", { monitoredInterfaces: [] })]);
    h.prisma.assetPerfSlaSample.findMany.mockResolvedValue([slaRow()]);

    await evaluateAllNotificationRules();

    expect(created()).toHaveLength(1);
    expect(h.prisma.assetInterfaceSample.findMany).not.toHaveBeenCalled();
  });

  it("narrows to one health check, leaving other checks' dead members alone", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([{
      ...MEMBER_RULE,
      trigger: { ...MEMBER_RULE.trigger, dimensionFilter: { healthCheck: "Primary WAN" } },
    }]);
    h.prisma.asset.findMany.mockResolvedValue([gate("fw1")]);
    h.prisma.assetPerfSlaSample.findMany.mockResolvedValue([
      slaRow({ healthCheck: "Primary WAN", link: "wan1", state: "down" }),
      slaRow({ healthCheck: "Backup LTE", link: "wan2", state: "down" }),
    ]);

    await evaluateAllNotificationRules();

    const rows = created();
    expect(rows).toHaveLength(1);
    expect(rows[0].dimension).toBe("Primary WAN|wan1");
  });

  it("narrows to one member when the operator names one", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([{
      ...MEMBER_RULE,
      trigger: { ...MEMBER_RULE.trigger, dimensionFilter: { healthCheck: "Primary WAN", link: "wan2" } },
    }]);
    h.prisma.asset.findMany.mockResolvedValue([gate("fw1")]);
    h.prisma.assetPerfSlaSample.findMany.mockResolvedValue([
      slaRow({ link: "wan1", state: "down" }),
      slaRow({ link: "wan2", state: "down" }),
    ]);

    await evaluateAllNotificationRules();

    const rows = created();
    expect(rows).toHaveLength(1);
    expect(rows[0].dimension).toBe("Primary WAN|wan2");
  });

  it("reads the newest sample per member, not whichever row came back first", async () => {
    // Rows arrive newest-first per (asset, health check, member) — a member
    // that already recovered must not alert off its older down sample.
    h.prisma.notificationRule.findMany.mockResolvedValue([MEMBER_RULE]);
    h.prisma.asset.findMany.mockResolvedValue([gate("fw1")]);
    const now = Date.now();
    h.prisma.assetPerfSlaSample.findMany.mockResolvedValue([
      slaRow({ link: "wan1", state: "up", timestamp: new Date(now) }),
      slaRow({ link: "wan1", state: "down", timestamp: new Date(now - 60_000) }),
    ]);

    await evaluateAllNotificationRules();

    expect(created()).toHaveLength(0);
  });

  it("stores a dimension the SD-WAN alert charts can parse back to the same pair", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([MEMBER_RULE]);
    h.prisma.asset.findMany.mockResolvedValue([gate("fw1")]);
    h.prisma.assetPerfSlaSample.findMany.mockResolvedValue([slaRow({ healthCheck: "VPN-SLA", link: "wan1" })]);

    await evaluateAllNotificationRules();

    const target = parseSdwanDimension(created()[0].dimension);
    expect(target).toEqual({ healthChecks: ["VPN-SLA"], link: "wan1" });
  });
});

describe("sdwanMemberState vocabulary", () => {
  it("publishes the health-check + member dimensions to the builder", () => {
    const cat = buildSchemaCatalog();
    expect((cat.fieldDimensions as Record<string, string[]>).sdwanMemberState).toEqual(["healthCheck", "link"]);
    // Both are valid at the dimension-values endpoint; a foreign one is a 400.
    expect(triggerDimensionApplicable("sdwanMemberState", "healthCheck")).toBe(true);
    expect(triggerDimensionApplicable("sdwanMemberState", "link")).toBe(true);
    expect(triggerDimensionApplicable("sdwanMemberState", "ifNamePattern")).toBe(false);
    // Device identifiers apply to every asset leaf.
    expect(triggerDimensionApplicable("sdwanMemberState", "hostnamePattern")).toBe(true);
  });

  it("offers a closed up/down picker rather than free text", () => {
    const meta = (buildSchemaCatalog().fieldMeta as Record<string, any>).sdwanMemberState;
    expect(meta.label).toBe("SD-WAN member state");
    expect(meta.kind).toBe("enum");
    expect(meta.values).toEqual(["up", "down"]);
  });

  it("accepts a rule carrying both dimensions", () => {
    expect(() => ruleInputSchema.parse({
      name: "SD-WAN member down",
      severity: "serious",
      scope: { allAssets: true },
      messageTemplate: "{message}",
      trigger: { type: "asset_state", field: "sdwanMemberState", operator: "!=", value: "up", dimensionFilter: { healthCheck: "Primary WAN", link: "wan1" } },
    })).not.toThrow();
  });

  it("counts a poll-based hold against the SD-WAN stream, not the probe loop", () => {
    // The SD-WAN collector has its own cadence (the integration's
    // sdwanIntervalSeconds); defaulting to responseTime — or to the system-info
    // pass it rode until 2026-09 — would convert "for 3 polls" at the wrong
    // interval and mislead the wizard.
    expect(streamForMetric("sdwanMemberState")).toBe("sdwan");
  });

  it("charts the health check rather than the gate's own graphs", () => {
    expect(isSdwanScopedAlert("sdwanMemberState")).toBe(true);
    expect(chartTokenForMetric("sdwanMemberState")).toBe("chart.sdwanLatency");
  });
});
