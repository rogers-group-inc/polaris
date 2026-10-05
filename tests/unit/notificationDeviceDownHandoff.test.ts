/**
 * tests/unit/notificationDeviceDownHandoff.test.ts
 *
 * One outage is one alert, for every reading the device itself reports
 * (business rule 29(i)). An SD-WAN SLA packet-loss alert was live on a gate
 * when the gate went down; the readings stopped with it, so the alert froze
 * next to the asset-down alert for twelve hours, then mailed "resolved" the
 * moment the modem was power-cycled and the overlay read healthy again. A
 * device that is `down` now hands every such alert to asset-down — cleared as
 * superseded, no reset actions, no new fire while dark.
 *
 * Coverage:
 *   - triggerHandsOffWhenDeviceDown: device-reported metrics and state fields
 *     hand off; the outage itself, held facts and path checks do not; a
 *     composite only when every leaf does.
 *   - assetIsDown is `down` alone.
 *   - a live SD-WAN alert on a down gate CLEARS as device-down; a pending row
 *     resets; no reset actions run (no "resolved").
 *   - a down asset is not evaluated for CPU (no new fire while dark), while a
 *     `passive` one still is (nothing to hand to there).
 *   - a monitorStatus rule and a quarantined rule are untouched.
 *   - the composite path hands off the same way.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    notificationRule: { findMany: vi.fn() },
    notificationRuleState: { findMany: vi.fn(), update: vi.fn(), upsert: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
    notification: { create: vi.fn(), createMany: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    asset: { findMany: vi.fn(), findUnique: vi.fn() },
    assetTelemetrySample: { findMany: vi.fn() },
    event: { findMany: vi.fn() },
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
    hostMetricsSample: { findMany: vi.fn() },
  },
  logEvent: vi.fn(async () => {}),
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));
vi.mock("../../src/services/notificationRecipientService.js", () => ({
  expandDeliveries: vi.fn(async () => {}),
  scopeRegionTagsOf: vi.fn(() => []),
}));

import {
  evaluateAllNotificationRules,
  triggerHandsOffWhenDeviceDown,
  assetIsDown,
} from "../../src/services/notificationEngine.js";

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

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.notificationRuleState.findMany.mockResolvedValue([]);
  h.prisma.notificationRuleState.findUnique.mockResolvedValue(null);
  h.prisma.notification.create.mockResolvedValue({ id: "n1" });
  h.prisma.notification.findMany.mockResolvedValue([]);
  h.prisma.setting.findUnique.mockResolvedValue(null);
  h.prisma.event.findMany.mockResolvedValue([]);
  h.prisma.assetTelemetrySample.findMany.mockResolvedValue([]);
});

describe("triggerHandsOffWhenDeviceDown", () => {
  it("hands off every metric the device reports", () => {
    for (const metric of ["sdwanPacketLoss", "sdwanLatencyMs", "sdwanJitterMs", "cpuPct", "memPct", "ifInErrorRate", "hwSensorAlarm", "probeLossPct"]) {
      expect(triggerHandsOffWhenDeviceDown({ ...CPU, metric } as any), metric).toBe(true);
    }
  });

  it("keeps path checks — the asset is the vantage point, not the subject", () => {
    for (const metric of ["pathOk", "pathLatencyMs", "pathFailurePct", "pathTlsDaysLeft"]) {
      expect(triggerHandsOffWhenDeviceDown({ ...CPU, metric } as any), metric).toBe(false);
    }
  });

  it("hands off device-reported state, keeps the outage itself and held facts", () => {
    const st = (field: string) => ({ type: "asset_state", field, operator: "==", value: "down" }) as any;
    for (const f of ["sdwanMemberState", "ifOperStatus", "ipsecStatus", "poeStatus", "fortilinkStatus"]) {
      expect(triggerHandsOffWhenDeviceDown(st(f)), f).toBe(true);
    }
    for (const f of ["monitorStatus", "consecutiveFailures", "status", "dependencySuppressed", "quarantined", "firmwareVsPrimary"]) {
      expect(triggerHandsOffWhenDeviceDown(st(f)), f).toBe(false);
    }
  });

  it("hands off a composite only when every leaf would", () => {
    const comp = (children: unknown[]) => ({ type: "composite", kind: "asset", op: "and", children, forDurationSec: 0 }) as any;
    const mem = { ...CPU, metric: "memPct" };
    expect(triggerHandsOffWhenDeviceDown(comp([CPU, mem]))).toBe(true);
    expect(triggerHandsOffWhenDeviceDown(comp([CPU, { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" }]))).toBe(false);
    expect(triggerHandsOffWhenDeviceDown(comp([CPU, { op: "or", children: [mem, { ...CPU, metric: "pathOk" }] }]))).toBe(false);
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
  it("clears a live SD-WAN SLA alert when its gate goes down, with no reset actions", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([rule(SDWAN_LOSS, { name: "SLA packet loss" })]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("gate-1", { monitorStatus: "down", consecutiveFailures: 9 })]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([firingState("gate-1", { dimensionKey: "Overlay_HC|vpn-overlay1" })]);

    await evaluateAllNotificationRules();

    expect(h.prisma.notification.updateMany).toHaveBeenCalledTimes(1);
    const cleared = h.prisma.notification.updateMany.mock.calls[0][0];
    expect(cleared.where.id).toBe("n9");
    expect(cleared.data.clearedBy).toBe("system:device-down");
    const upd = h.prisma.notificationRuleState.update.mock.calls.find((c: any) => c[0].where.id === "s1");
    expect(upd?.[0].data.state).toBe("clear");
    expect(upd?.[0].data.notificationId).toBe(null);
    // No "resolved" — the alert did not recover, it was handed to asset-down.
    expect(h.prisma.notification.create).not.toHaveBeenCalled();
    const ev = h.logEvent.mock.calls.map((c: any) => c[0]).find((e: any) => e.action === "notification.superseded");
    expect(ev?.details.reason).toBe("device-down");
  });

  it("does not let a timed reset fire on a row the handoff just cleared", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([rule(SDWAN_LOSS, { clearBehavior: "timed", clearAfterSec: 60 })]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("gate-1", { monitorStatus: "down" })]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([
      firingState("gate-1", { dimensionKey: "Overlay_HC|vpn-overlay1", firedAt: new Date(Date.now() - 3_600_000) }),
    ]);

    await evaluateAllNotificationRules();

    const clearedBy = h.prisma.notification.updateMany.mock.calls.map((c: any) => c[0].data.clearedBy);
    expect(clearedBy).toEqual(["system:device-down"]);
  });

  it("resets a pending row on a down device", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([rule(SDWAN_LOSS)]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("gate-1", { monitorStatus: "down" })]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([
      firingState("gate-1", { dimensionKey: "Overlay_HC|vpn-overlay1", state: "pending", notificationId: null }),
    ]);

    await evaluateAllNotificationRules();

    expect(h.prisma.notification.updateMany).not.toHaveBeenCalled();
    const upd = h.prisma.notificationRuleState.update.mock.calls.find((c: any) => c[0].where.id === "s1");
    expect(upd?.[0].data.state).toBe("clear");
  });

  it("does not fire a new alert on a down device", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([rule(CPU)]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("down-1", { monitorStatus: "down" })]);
    h.prisma.assetTelemetrySample.findMany.mockResolvedValue([
      { assetId: "down-1", timestamp: new Date(), cpuPct: 91, memPct: null, memUsedBytes: null, sessionCount: null },
    ]);

    await evaluateAllNotificationRules();

    expect(h.prisma.notification.create).not.toHaveBeenCalled();
  });

  it("still evaluates a passive device — there is no asset-down alert to hand to", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([rule(CPU)]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("pas-1", { monitorStatus: "passive" })]);
    h.prisma.assetTelemetrySample.findMany.mockResolvedValue([
      { assetId: "pas-1", timestamp: new Date(), cpuPct: 91, memPct: null, memUsedBytes: null, sessionCount: null },
    ]);

    await evaluateAllNotificationRules();

    expect(h.prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  it("leaves the asset-down alert itself alone", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([
      rule({ type: "asset_state", field: "monitorStatus", operator: "==", value: "down", forDurationSec: 0 }),
    ]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("gate-1", { monitorStatus: "down" })]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([firingState("gate-1")]);

    await evaluateAllNotificationRules();

    const clearedBy = h.prisma.notification.updateMany.mock.calls.map((c: any) => c[0].data.clearedBy);
    expect(clearedBy).not.toContain("system:device-down");
  });

  it("leaves a held fact alone — quarantine does not end with an outage", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([
      rule({ type: "asset_state", field: "quarantined", operator: "==", value: true, forDurationSec: 0 }),
    ]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("gate-1", { monitorStatus: "down", quarantinedAt: new Date() })]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([firingState("gate-1")]);

    await evaluateAllNotificationRules();

    const clearedBy = h.prisma.notification.updateMany.mock.calls.map((c: any) => c[0].data.clearedBy);
    expect(clearedBy).not.toContain("system:device-down");
  });

  it("hands off a composite alert the same way", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([
      rule({ type: "composite", kind: "asset", op: "and", children: [CPU, { ...CPU, metric: "memPct" }], forDurationSec: 0 }),
    ]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("down-1", { monitorStatus: "down" })]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([firingState("down-1")]);

    await evaluateAllNotificationRules();

    const clearedBy = h.prisma.notification.updateMany.mock.calls.map((c: any) => c[0].data.clearedBy);
    expect(clearedBy).toEqual(["system:device-down"]);
    const upd = h.prisma.notificationRuleState.update.mock.calls.find((c: any) => c[0].where.id === "s1");
    expect(upd?.[0].data.state).toBe("clear");
  });
});
