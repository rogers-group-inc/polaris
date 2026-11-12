/**
 * tests/unit/notificationDeviceDownHandoff.test.ts
 *
 * An outage hands off only the alerts whose input IS the outage (business
 * rule 29(i)): packet loss, response time and the two stream-failing fields.
 * A device that is `down` hands those to asset-down — cleared as superseded,
 * no reset actions, no new fire while dark. Every other alert freezes through
 * the outage: clearing a memory-forecast alert on `down` re-sent it every time
 * a flapping WAN link brought the device back.
 *
 * Coverage:
 *   - triggerHandsOffWhenDeviceDown: response time, packet loss and stream
 *     failing hand off; CPU, memory, forecasts, SD-WAN, interfaces, path
 *     checks, the outage itself and held facts do not; a composite only when
 *     every leaf does.
 *   - assetIsDown is `down` alone.
 *   - a live response-time alert on a down device CLEARS as device-down; a
 *     pending row resets; no reset actions run (no "resolved").
 *   - a live SD-WAN or memory alert on a down device stays live.
 *   - a down asset is not evaluated for response time (no new fire while
 *     dark), while a `passive` one still is (nothing to hand to there).
 *   - a monitorStatus rule and a quarantined rule are untouched.
 *   - the composite path hands off the same way.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
beforeEach(() => resetEventLogStub());
vi.mock("../../src/services/notificationRecipientService.js", () => ({
  expandDeliveries: vi.fn(async () => {}),
  scopeRegionTagsOf: vi.fn(() => []),
}));

import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";
import { triggerHandsOffWhenDeviceDown, assetIsDown } from "../../src/services/notifications/scope.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

function scopeAsset(id: string, over: Partial<Record<string, unknown>> = {}) {
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
    ...over,
  };
}

function rule(trigger: Record<string, unknown>, over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "r1",
    name: "Rule",
    description: null,
    enabled: true,
    severity: "warning",
    trigger,
    scope: { allAssets: true },
    clearBehavior: "auto",
    clearAfterSec: null,
    cooldownSec: null,
    messageTemplate: null,
    channels: ["in_app"],
    targets: [],
    emailComposition: null,
    escalation: null,
    ...over,
  };
}

const SDWAN_LOSS = { type: "asset_metric", metric: "sdwanPacketLoss", aggregation: "avg", windowSec: 900, operator: ">=", threshold: 5, forDurationSec: 0 };
const CPU = { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 50, forDurationSec: 0 };
const RTT = { type: "asset_metric", metric: "responseTimeMs", aggregation: "latest", windowSec: 0, operator: ">", threshold: 200, forDurationSec: 0 };

function firingState(assetId: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "s1",
    ruleId: "r1",
    assetId,
    dimensionKey: "",
    state: "firing",
    notificationId: "n9",
    firedAt: new Date(Date.now() - 60_000),
    conditionMetSince: new Date(Date.now() - 60_000),
    recoveredSince: null,
    lastValue: 40,
    firingSeverity: null,
    bandMetSince: null,
    ...over,
  };
}

beforeEach(() => resetDbStub());

beforeEach(() => {
  vi.clearAllMocks();
  stubbed(prisma.notificationRuleState.findMany).mockResolvedValue([]);
  stubbed(prisma.notificationRuleState.findUnique).mockResolvedValue(null);
  stubbed(prisma.notification.create).mockResolvedValue({ id: "n1" });
  stubbed(prisma.notification.findMany).mockResolvedValue([]);
  stubbed(prisma.setting.findUnique).mockResolvedValue(null);
  stubbed(prisma.event.findMany).mockResolvedValue([]);
  stubbed(prisma.assetTelemetrySample.findMany).mockResolvedValue([]);
  stubbed(prisma.assetMonitorSample.findMany).mockResolvedValue([]);
});

describe("triggerHandsOffWhenDeviceDown", () => {
  it("hands off the metrics measured from the probes that declare the outage", () => {
    for (const metric of ["responseTimeMs", "probeLossPct"]) {
      expect(triggerHandsOffWhenDeviceDown({ ...CPU, metric } as any), metric).toBe(true);
    }
  });

  it("keeps every other metric — the outage does not falsify what the device reported", () => {
    for (const metric of [
      "cpuPct", "memPct", "memForecastPct", "memDaysUntilFull", "storageDaysUntilFull", "uptimeSec",
      "sdwanPacketLoss", "sdwanLatencyMs", "sdwanJitterMs", "ifInErrorRate", "hwSensorAlarm",
      "pathOk", "pathLatencyMs", "pathFailurePct", "pathTlsDaysLeft",
    ]) {
      expect(triggerHandsOffWhenDeviceDown({ ...CPU, metric } as any), metric).toBe(false);
    }
  });

  it("hands off the stream-failing fields, keeps every other state field", () => {
    const st = (field: string) => ({ type: "asset_state", field, operator: "==", value: "down" }) as any;
    for (const f of ["telemetryFailingMinutes", "systemInfoFailingMinutes"]) {
      expect(triggerHandsOffWhenDeviceDown(st(f)), f).toBe(true);
    }
    for (const f of [
      "sdwanMemberState", "ifOperStatus", "ipsecStatus", "poeStatus", "fortilinkStatus",
      "monitorStatus", "consecutiveFailures", "status", "dependencySuppressed", "quarantined", "firmwareVsPrimary",
    ]) {
      expect(triggerHandsOffWhenDeviceDown(st(f)), f).toBe(false);
    }
  });

  it("hands off a composite only when every leaf would", () => {
    const comp = (children: unknown[]) => ({ type: "composite", kind: "asset", op: "and", children, forDurationSec: 0 }) as any;
    const loss = { ...CPU, metric: "probeLossPct" };
    expect(triggerHandsOffWhenDeviceDown(comp([RTT, loss]))).toBe(true);
    expect(triggerHandsOffWhenDeviceDown(comp([RTT, CPU]))).toBe(false);
    expect(triggerHandsOffWhenDeviceDown(comp([RTT, { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" }]))).toBe(false);
    expect(triggerHandsOffWhenDeviceDown(comp([RTT, { op: "or", children: [loss, { ...CPU, metric: "pathOk" }] }]))).toBe(false);
  });

  it("never hands off a host trigger", () => {
    expect(triggerHandsOffWhenDeviceDown({ type: "host_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 50, forDurationSec: 0 } as any)).toBe(false);
  });
});

describe("assetIsDown", () => {
  it("is the confirmed outage alone", () => {
    expect(assetIsDown({ monitorStatus: "down" })).toBe(true);
    for (const s of ["up", "warning", "recovering", "unknown", "passive", null]) {
      expect(assetIsDown({ monitorStatus: s }), String(s)).toBe(false);
    }
  });
});

describe("device-down handoff", () => {
  it("clears a live response-time alert when its device goes down, with no reset actions", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([rule(RTT, { name: "Slow response" })]);
    stubbed(prisma.asset.findMany).mockResolvedValue([scopeAsset("gate-1", { monitorStatus: "down", consecutiveFailures: 9 })]);
    stubbed(prisma.notificationRuleState.findMany).mockResolvedValue([firingState("gate-1")]);

    await evaluateAllNotificationRules();

    expect(stubbed(prisma.notification.updateMany)).toHaveBeenCalledTimes(1);
    const cleared = stubbed(prisma.notification.updateMany).mock.calls[0][0];
    expect(cleared.where.id).toBe("n9");
    expect(cleared.data.clearedBy).toBe("system:device-down");
    const upd = stubbed(prisma.notificationRuleState.update).mock.calls.find((c: any) => c[0].where.id === "s1");
    expect(upd?.[0].data.state).toBe("clear");
    expect(upd?.[0].data.notificationId).toBe(null);
    // No "resolved" — the alert did not recover, it was handed to asset-down.
    expect(stubbed(prisma.notification.create)).not.toHaveBeenCalled();
    const ev = eventLog.logEvent.mock.calls.map((c: any) => c[0]).find((e: any) => e.action === "notification.superseded");
    expect(ev?.details.reason).toBe("device-down");
  });

  it("does not let a timed reset fire on a row the handoff just cleared", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([rule(RTT, { clearBehavior: "timed", clearAfterSec: 60 })]);
    stubbed(prisma.asset.findMany).mockResolvedValue([scopeAsset("gate-1", { monitorStatus: "down" })]);
    stubbed(prisma.notificationRuleState.findMany).mockResolvedValue([
      firingState("gate-1", { firedAt: new Date(Date.now() - 3_600_000) }),
    ]);

    await evaluateAllNotificationRules();

    const clearedBy = stubbed(prisma.notification.updateMany).mock.calls.map((c: any) => c[0].data.clearedBy);
    expect(clearedBy).toEqual(["system:device-down"]);
  });

  it("resets a pending row on a down device", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([rule(RTT)]);
    stubbed(prisma.asset.findMany).mockResolvedValue([scopeAsset("gate-1", { monitorStatus: "down" })]);
    stubbed(prisma.notificationRuleState.findMany).mockResolvedValue([
      firingState("gate-1", { state: "pending", notificationId: null }),
    ]);

    await evaluateAllNotificationRules();

    expect(stubbed(prisma.notification.updateMany)).not.toHaveBeenCalled();
    const upd = stubbed(prisma.notificationRuleState.update).mock.calls.find((c: any) => c[0].where.id === "s1");
    expect(upd?.[0].data.state).toBe("clear");
  });

  it("keeps a live SD-WAN SLA alert through its gate's outage", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([rule(SDWAN_LOSS, { name: "SLA packet loss" })]);
    stubbed(prisma.asset.findMany).mockResolvedValue([scopeAsset("gate-1", { monitorStatus: "down", consecutiveFailures: 9 })]);
    stubbed(prisma.notificationRuleState.findMany).mockResolvedValue([firingState("gate-1", { dimensionKey: "Overlay_HC|vpn-overlay1" })]);

    await evaluateAllNotificationRules();

    const clearedBy = stubbed(prisma.notification.updateMany).mock.calls.map((c: any) => c[0].data.clearedBy);
    expect(clearedBy).not.toContain("system:device-down");
  });

  it("keeps a live memory alert through a WAN flap, so it cannot re-fire when the device returns", async () => {
    const MEM = { ...CPU, metric: "memPct", threshold: 80 };
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([rule(MEM)]);
    stubbed(prisma.asset.findMany).mockResolvedValue([scopeAsset("down-1", { monitorStatus: "down" })]);
    stubbed(prisma.notificationRuleState.findMany).mockResolvedValue([firingState("down-1", { lastValue: 83 })]);

    await evaluateAllNotificationRules();

    const clearedBy = stubbed(prisma.notification.updateMany).mock.calls.map((c: any) => c[0].data.clearedBy);
    expect(clearedBy).not.toContain("system:device-down");
    expect(stubbed(prisma.notification.create)).not.toHaveBeenCalled();
  });

  it("does not fire a new response-time alert on a down device", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([rule(RTT)]);
    stubbed(prisma.asset.findMany).mockResolvedValue([scopeAsset("down-1", { monitorStatus: "down" })]);
    stubbed(prisma.assetMonitorSample.findMany).mockResolvedValue([
      { assetId: "down-1", timestamp: new Date(), responseTimeMs: 900, uptimeSec: null },
    ]);

    await evaluateAllNotificationRules();

    expect(stubbed(prisma.notification.create)).not.toHaveBeenCalled();
  });

  it("still evaluates a passive device — there is no asset-down alert to hand to", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([rule(RTT)]);
    stubbed(prisma.asset.findMany).mockResolvedValue([scopeAsset("pas-1", { monitorStatus: "passive" })]);
    stubbed(prisma.assetMonitorSample.findMany).mockResolvedValue([
      { assetId: "pas-1", timestamp: new Date(), responseTimeMs: 900, uptimeSec: null },
    ]);

    await evaluateAllNotificationRules();

    expect(stubbed(prisma.notification.create)).toHaveBeenCalledTimes(1);
  });

  it("leaves the asset-down alert itself alone", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([
      rule({ type: "asset_state", field: "monitorStatus", operator: "==", value: "down", forDurationSec: 0 }),
    ]);
    stubbed(prisma.asset.findMany).mockResolvedValue([scopeAsset("gate-1", { monitorStatus: "down" })]);
    stubbed(prisma.notificationRuleState.findMany).mockResolvedValue([firingState("gate-1")]);

    await evaluateAllNotificationRules();

    const clearedBy = stubbed(prisma.notification.updateMany).mock.calls.map((c: any) => c[0].data.clearedBy);
    expect(clearedBy).not.toContain("system:device-down");
  });

  it("leaves a held fact alone — quarantine does not end with an outage", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([
      rule({ type: "asset_state", field: "quarantined", operator: "==", value: true, forDurationSec: 0 }),
    ]);
    stubbed(prisma.asset.findMany).mockResolvedValue([scopeAsset("gate-1", { monitorStatus: "down", quarantinedAt: new Date() })]);
    stubbed(prisma.notificationRuleState.findMany).mockResolvedValue([firingState("gate-1")]);

    await evaluateAllNotificationRules();

    const clearedBy = stubbed(prisma.notification.updateMany).mock.calls.map((c: any) => c[0].data.clearedBy);
    expect(clearedBy).not.toContain("system:device-down");
  });

  it("hands off a composite alert the same way", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([
      rule({ type: "composite", kind: "asset", op: "and", children: [RTT, { ...CPU, metric: "probeLossPct" }], forDurationSec: 0 }),
    ]);
    stubbed(prisma.asset.findMany).mockResolvedValue([scopeAsset("down-1", { monitorStatus: "down" })]);
    stubbed(prisma.notificationRuleState.findMany).mockResolvedValue([firingState("down-1")]);

    await evaluateAllNotificationRules();

    const clearedBy = stubbed(prisma.notification.updateMany).mock.calls.map((c: any) => c[0].data.clearedBy);
    expect(clearedBy).toEqual(["system:device-down"]);
    const upd = stubbed(prisma.notificationRuleState.update).mock.calls.find((c: any) => c[0].where.id === "s1");
    expect(upd?.[0].data.state).toBe("clear");
  });
});
