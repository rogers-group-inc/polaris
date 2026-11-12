/**
 * tests/unit/notificationStrandedAlerts.test.ts
 *
 * Stuck-alert fixes: (1) banded alerts EASE to the base severity in the
 * hysteresis dead band instead of parking at their last band; (2) interface
 * status readings are restricted to PINNED interfaces (Asset.monitoredInterfaces)
 * with an admin-up gate on ifOperStatus — an 8-port switch's unplugged ports
 * must not raise 8 "interface down" alerts; (3) the vanished-state sweep clears
 * firing rows whose asset left the rule's scope or whose dimension stopped
 * being reported (suppressed assets stay frozen — business rule 16); (4) the
 * rule service clears active alerts on disable and delete so nothing lingers
 * uncleared under a rule the engine no longer evaluates.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    notificationRule: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    notificationRuleState: { findMany: vi.fn(), update: vi.fn(), upsert: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn(), delete: vi.fn() },
    notification: { create: vi.fn(), updateMany: vi.fn() },
    asset: { findMany: vi.fn(), findUnique: vi.fn() },
    assetTelemetrySample: { findMany: vi.fn() },
    assetInterfaceSample: { findMany: vi.fn() },
    assetIpsecTunnelSample: { findMany: vi.fn() },
    event: { findMany: vi.fn() },
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
    hostMetricsSample: { findMany: vi.fn() },
  },
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { resetEventLogStub } from "./_eventLogStub.js";
beforeEach(() => resetEventLogStub());
vi.mock("../../src/services/notificationRecipientService.js", () => ({
  expandDeliveries: vi.fn(async () => {}),
  scopeRegionTagsOf: vi.fn(() => []),
}));

import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";
import { updateRule, deleteRule } from "../../src/services/notificationRuleService.js";
import { ruleInputSchema } from "../../src/services/notificationTypes.js";

function scopeAsset(id: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    hostname: id.toUpperCase(),
    assetType: "switch",
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

function firingState(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "s1",
    ruleId: "r1",
    assetId: "a1",
    dimensionKey: "",
    state: "firing",
    conditionMetSince: null,
    recoveredSince: null,
    firedAt: new Date(Date.now() - 3600_000),
    lastValue: null,
    notificationId: "n1",
    firingSeverity: null,
    ...over,
  };
}

const BANDED_CPU_RULE = {
  id: "r1",
  name: "Switch CPU",
  description: null,
  enabled: true,
  severity: "warning",
  trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 60, operator: ">=", threshold: 20, forDurationSec: 0 },
  scope: { allAssets: true },
  reset: { mode: "auto", clearThreshold: 10 },
  actions: [],
  clearBehavior: "auto",
  clearAfterSec: null,
  cooldownSec: null,
  messageTemplate: null,
  channels: ["in_app"],
  targets: [],
  emailComposition: null,
  escalation: null,
  severityBands: [{ threshold: 30, severity: "critical", actions: [] }],
  bandNotify: null,
};

const IFACE_RULE = {
  ...BANDED_CPU_RULE,
  id: "r1",
  name: "Interface down",
  severity: "serious",
  trigger: { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down", forDurationSec: 0 },
  reset: { mode: "auto" },
  severityBands: null,
};

const DOWN_RULE = {
  ...IFACE_RULE,
  name: "Asset down",
  trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down", forDurationSec: 0 },
};

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
});

/** notification.updateMany calls that soft-clear (data.cleared === true). */
function clearCalls() {
  return h.prisma.notification.updateMany.mock.calls.filter(([args]: any[]) => args?.data?.cleared === true);
}

describe("dead-band easing (severity bands + hysteresis)", () => {
  it("eases a critical alert to the base severity when the value drops into the dead band", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([BANDED_CPU_RULE]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("a1")]);
    // 15 is below the tier-0 fire threshold (20) but above clearThreshold (10).
    h.prisma.assetTelemetrySample.findMany.mockResolvedValue([
      { assetId: "a1", timestamp: new Date(), cpuPct: 15, memPct: null, memUsedBytes: null, sessionCount: null },
    ]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([firingState({ firingSeverity: "critical", lastValue: 35 })]);

    await evaluateAllNotificationRules();

    // The live alert was re-severitied in place, NOT cleared.
    const eased = h.prisma.notification.updateMany.mock.calls.find(([args]: any[]) => args?.data?.severity === "warning");
    expect(eased).toBeTruthy();
    expect(eased![0].where).toMatchObject({ id: "n1", cleared: false });
    expect(clearCalls()).toHaveLength(0);
    const stUpdate = h.prisma.notificationRuleState.update.mock.calls.find(([args]: any[]) => args?.data?.firingSeverity === "warning");
    expect(stUpdate).toBeTruthy();
  });

  it("still fully clears below the clear threshold", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([BANDED_CPU_RULE]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("a1")]);
    h.prisma.assetTelemetrySample.findMany.mockResolvedValue([
      { assetId: "a1", timestamp: new Date(), cpuPct: 5, memPct: null, memUsedBytes: null, sessionCount: null },
    ]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([firingState({ firingSeverity: "critical" })]);

    await evaluateAllNotificationRules();

    expect(clearCalls().length).toBeGreaterThan(0);
  });
});

describe("interface readings — pinned-interface + admin-up gates", () => {
  it("fires only for pinned admin-up interfaces and names the interface", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([IFACE_RULE]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("a1", { monitoredInterfaces: ["port1", "port2"] })]);
    h.prisma.assetInterfaceSample.findMany.mockResolvedValue([
      { assetId: "a1", ifName: "port1", operStatus: "down", adminStatus: "up" },   // pinned + admin-up → fires
      { assetId: "a1", ifName: "port2", operStatus: "down", adminStatus: "down" }, // pinned but admin-downed → deliberate, no fire
      { assetId: "a1", ifName: "port5", operStatus: "down", adminStatus: "up" },   // unplugged, not pinned → no fire
    ]);

    await evaluateAllNotificationRules();

    expect(h.prisma.notification.create).toHaveBeenCalledTimes(1);
    const created = h.prisma.notification.create.mock.calls[0][0];
    expect(created.data.message).toContain("port1");
  });
});

describe("vanished-state sweep", () => {
  it("clears a firing row whose dimension is no longer reported (stale unpinned port)", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([IFACE_RULE]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("a1", { monitoredInterfaces: ["port1"] })]);
    h.prisma.assetInterfaceSample.findMany.mockResolvedValue([
      { assetId: "a1", ifName: "port1", operStatus: "up", adminStatus: "up" },
      { assetId: "a1", ifName: "port5", operStatus: "down", adminStatus: "up" }, // not pinned → invisible to the rule
    ]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([
      firingState({ id: "s5", dimensionKey: "port5", notificationId: "n5" }),
    ]);

    await evaluateAllNotificationRules();

    const cleared = clearCalls();
    expect(cleared).toHaveLength(1);
    expect(cleared[0][0].where).toMatchObject({ id: "n5" });
    const stUpdate = h.prisma.notificationRuleState.update.mock.calls.find(
      ([args]: any[]) => args?.where?.id === "s5" && args?.data?.state === "clear",
    );
    expect(stUpdate).toBeTruthy();
  });

  it("clears a firing row whose asset left the scope, but freezes a suppressed one", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([DOWN_RULE]);
    // loadScopeAssets sees only a1; the sweep's existence re-check (id.in query)
    // finds maint1 suppressed and gone1 deleted.
    h.prisma.asset.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.id?.in) {
        return [{ id: "maint1", status: "maintenance", dependencySuppressed: false }];
      }
      return [scopeAsset("a1")];
    });
    h.prisma.notificationRuleState.findMany.mockResolvedValue([
      firingState({ id: "sg", assetId: "gone1", notificationId: "ng" }),
      firingState({ id: "sm", assetId: "maint1", notificationId: "nm" }),
    ]);

    await evaluateAllNotificationRules();

    const cleared = clearCalls();
    expect(cleared).toHaveLength(1);
    expect(cleared[0][0].where).toMatchObject({ id: "ng" });
    // The suppressed asset's row must stay frozen (rule 16) — no state reset.
    const maintReset = h.prisma.notificationRuleState.update.mock.calls.find(([args]: any[]) => args?.where?.id === "sm");
    expect(maintReset).toBeUndefined();
  });

  it("freezes an in-scope asset that produced no readings at all (collection gap)", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([IFACE_RULE]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("a1", { monitoredInterfaces: ["port1"] })]);
    h.prisma.assetInterfaceSample.findMany.mockResolvedValue([]); // nothing reported this tick
    h.prisma.notificationRuleState.findMany.mockResolvedValue([
      firingState({ id: "s1", dimensionKey: "port1", notificationId: "n1" }),
    ]);

    await evaluateAllNotificationRules();

    expect(clearCalls()).toHaveLength(0);
    expect(h.prisma.notificationRuleState.update).not.toHaveBeenCalled();
  });

  it("clears a firing row whose interface was UNPINNED even when the asset produced no readings (config edge, not a collection gap)", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([IFACE_RULE]);
    // port1 left the pin set — the device's only alerting interface. No pinned
    // interfaces remain, so the rule resolves zero readings for this asset;
    // before the pin-test carve-out the no-readings freeze stranded the alert.
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("a1", { monitoredInterfaces: [] })]);
    h.prisma.assetInterfaceSample.findMany.mockResolvedValue([]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([
      firingState({ id: "s1", dimensionKey: "port1", notificationId: "n1" }),
    ]);

    await evaluateAllNotificationRules();

    const cleared = clearCalls();
    expect(cleared).toHaveLength(1);
    expect(cleared[0][0].where).toMatchObject({ id: "n1" });
    const stUpdate = h.prisma.notificationRuleState.update.mock.calls.find(
      ([args]: any[]) => args?.where?.id === "s1" && args?.data?.state === "clear",
    );
    expect(stUpdate).toBeTruthy();
  });

  it("clears an unpinned-interface COUNTER-metric alert the same way (ifInBps)", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([{
      ...IFACE_RULE,
      name: "Uplink saturated",
      trigger: { type: "asset_metric", metric: "ifInBps", aggregation: "latest", windowSec: 300, operator: ">=", threshold: 1, forDurationSec: 0 },
    }]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("a1", { monitoredInterfaces: [] })]);
    h.prisma.assetInterfaceSample.findMany.mockResolvedValue([]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([
      firingState({ id: "s1", dimensionKey: "port1", notificationId: "n1" }),
    ]);

    await evaluateAllNotificationRules();

    expect(clearCalls()).toHaveLength(1);
  });

  it("clears an unpinned-tunnel alert the same way (ipsecStatus)", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([{
      ...IFACE_RULE,
      name: "Tunnel down",
      trigger: { type: "asset_state", field: "ipsecStatus", operator: "==", value: "down", forDurationSec: 0 },
    }]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("a1", { monitoredIpsecTunnels: [] })]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([
      firingState({ id: "s1", dimensionKey: "tun-branch", notificationId: "n1" }),
    ]);

    await evaluateAllNotificationRules();

    expect(clearCalls()).toHaveLength(1);
  });
});

describe("rule service — disable/delete alert cleanup", () => {
  const storedRule = {
    id: "r1",
    name: "Switch CPU",
    description: null,
    enabled: true,
    severity: "warning",
    trigger: BANDED_CPU_RULE.trigger,
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

  const input = ruleInputSchema.parse({
    name: "Switch CPU",
    severity: "warning",
    trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 60, operator: ">=", threshold: 20 },
    scope: { allAssets: true },
    reset: { mode: "auto" },
    enabled: false,
  });

  beforeEach(() => {
    h.prisma.notificationRule.findUnique.mockResolvedValue(storedRule);
    h.prisma.notificationRule.update.mockResolvedValue({ ...storedRule, enabled: false });
    h.prisma.notificationRule.delete.mockResolvedValue(storedRule);
    h.prisma.notificationRuleState.deleteMany.mockResolvedValue({ count: 1 });
  });

  it("disabling a rule clears its active alerts and drops its state rows", async () => {
    await updateRule("r1", input, "tester");
    const cleared = clearCalls();
    expect(cleared).toHaveLength(1);
    expect(cleared[0][0].where).toMatchObject({ ruleId: "r1", cleared: false });
    expect(cleared[0][0].data.clearedBy).toBe("system:rule-disabled");
    expect(h.prisma.notificationRuleState.deleteMany).toHaveBeenCalledWith({ where: { ruleId: "r1" } });
  });

  it("an enabled→enabled edit with the same trigger identity does NOT clear", async () => {
    await updateRule("r1", { ...input, enabled: true }, "tester");
    expect(clearCalls()).toHaveLength(0);
    expect(h.prisma.notificationRuleState.deleteMany).not.toHaveBeenCalled();
  });

  it("deleting a rule clears its active alerts first", async () => {
    await deleteRule("r1", "tester");
    const cleared = clearCalls();
    expect(cleared).toHaveLength(1);
    expect(cleared[0][0].data.clearedBy).toBe("system:rule-deleted");
    expect(h.prisma.notificationRule.delete).toHaveBeenCalled();
  });
});
