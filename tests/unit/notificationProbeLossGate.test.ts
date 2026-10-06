/**
 * tests/unit/notificationProbeLossGate.test.ts
 *
 * Packet loss only alerts on a device that is currently ANSWERING (business
 * rule 29). An outage is the asset-down alert's business; before this gate one
 * outage raised two alerts — asset-down plus a packet-loss alert about the
 * probes that outage swallowed — and the loss alert then froze (a no-reading
 * asset stays frozen: a collection gap isn't recovery) so it sat next to the
 * down alert for the whole outage.
 *
 * Coverage:
 *   - assetIsAnsweringProbes over all five monitor states + null.
 *   - down/recovering/unknown assets are never even queried, and don't fire.
 *   - up + warning assets do fire (warning IS the lossy-but-alive state).
 *   - a live loss alert on an asset that stopped answering CLEARS (handoff,
 *     like the carve-out) rather than freezing, and a pending row resets.
 *   - the answering gate is metric-scoped: a cpuPct rule still evaluates a
 *     recovering asset (a DOWN one hands off under rule 29(i)).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    notificationRule: { findMany: vi.fn() },
    notificationRuleState: { findMany: vi.fn(), update: vi.fn(), upsert: vi.fn(), findUnique: vi.fn() },
    notification: { create: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
    asset: { findMany: vi.fn(), findUnique: vi.fn() },
    assetTelemetrySample: { findMany: vi.fn() },
    event: { findMany: vi.fn() },
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
    hostMetricsSample: { findMany: vi.fn() },
  },
  queryProbeLossRatios: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../../src/services/notificationRecipientService.js", () => ({
  expandDeliveries: vi.fn(async () => {}),
  scopeRegionTagsOf: vi.fn(() => []),
}));
vi.mock("../../src/services/probeLossQuery.js", () => ({
  queryProbeLossRatios: h.queryProbeLossRatios,
}));

import {
  evaluateAllNotificationRules,
  assetIsAnsweringProbes,
} from "../../src/services/notificationEngine.js";

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
    ...over,
  };
}

/** Legacy-shape rule (the engine folds it to v2) firing above 10% loss. */
function lossRule(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "r1",
    name: "High packet loss",
    description: null,
    enabled: true,
    severity: "critical",
    trigger: { type: "asset_metric", metric: "probeLossPct", aggregation: "latest", windowSec: 900, operator: ">", threshold: 10, forDurationSec: 0 },
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

const CPU_RULE = lossRule({
  id: "r2",
  name: "High CPU",
  trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 50, forDurationSec: 0 },
});

/** A firing state row for `assetId` on rule r1. */
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
    lastValue: 92.9,
    firingSeverity: null,
    bandMetSince: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.notificationRule.findMany.mockResolvedValue([lossRule()]);
  h.prisma.notificationRuleState.findMany.mockResolvedValue([]);
  h.prisma.notificationRuleState.findUnique.mockResolvedValue(null);
  h.prisma.notification.create.mockResolvedValue({ id: "n1" });
  h.prisma.setting.findUnique.mockResolvedValue(null);
  h.prisma.event.findMany.mockResolvedValue([]);
  h.prisma.assetTelemetrySample.findMany.mockResolvedValue([]);
  // Whatever asset ids reach the query, report them as heavily lossy.
  h.queryProbeLossRatios.mockImplementation(async (opts: any) =>
    (opts.assetIds ?? []).map((assetId: string) => ({ assetId, total: 14n, failed: 13n })),
  );
});

describe("assetIsAnsweringProbes", () => {
  it("counts up and warning as answering, and nothing else", () => {
    expect(assetIsAnsweringProbes({ monitorStatus: "up" })).toBe(true);
    // warning = 1..threshold-1 consecutive failures on a device still replying —
    // exactly the lossy-but-alive state packet loss exists to catch.
    expect(assetIsAnsweringProbes({ monitorStatus: "warning" })).toBe(true);
    expect(assetIsAnsweringProbes({ monitorStatus: "down" })).toBe(false);
    // recovering still has asset-down live behind it (cs < threshold).
    expect(assetIsAnsweringProbes({ monitorStatus: "recovering" })).toBe(false);
    expect(assetIsAnsweringProbes({ monitorStatus: "unknown" })).toBe(false);
    expect(assetIsAnsweringProbes({ monitorStatus: null })).toBe(false);
  });

  it("excludes passive — there is no asset-down alert to supersede a loss alert there", () => {
    // A dark passive device sits at 100% loss indefinitely, and the alert that
    // would normally own that outage is exactly what is missing. Admitting it
    // would park a permanently-firing, never-clearing loss alert on every
    // device an operator just told Polaris to stop judging.
    expect(assetIsAnsweringProbes({ monitorStatus: "passive" })).toBe(false);
  });
});

describe("packet-loss gate", () => {
  it("never queries loss for a device that isn't answering", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("up-1"),
      scopeAsset("warn-1", { monitorStatus: "warning", consecutiveFailures: 2 }),
      scopeAsset("down-1", { monitorStatus: "down", consecutiveFailures: 7 }),
      scopeAsset("rec-1", { monitorStatus: "recovering" }),
      scopeAsset("new-1", { monitorStatus: "unknown" }),
    ]);

    await evaluateAllNotificationRules();

    expect(h.queryProbeLossRatios).toHaveBeenCalledTimes(1);
    expect(h.queryProbeLossRatios.mock.calls[0][0].assetIds.sort()).toEqual(["up-1", "warn-1"]);
    const fired = h.prisma.notification.create.mock.calls.map((c: any) => c[0].data.assetId).sort();
    expect(fired).toEqual(["up-1", "warn-1"]);
  });

  it("skips the query entirely when nothing in scope is answering", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("down-1", { monitorStatus: "down" }),
      scopeAsset("down-2", { monitorStatus: "down" }),
    ]);

    await evaluateAllNotificationRules();

    expect(h.queryProbeLossRatios).not.toHaveBeenCalled();
    expect(h.prisma.notification.create).not.toHaveBeenCalled();
  });

  it("clears a live loss alert when the device stops answering (handoff, not a freeze)", async () => {
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("down-1", { monitorStatus: "down" })]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([firingState("down-1")]);

    await evaluateAllNotificationRules();

    // The alert row is soft-cleared, attributed to the handoff...
    expect(h.prisma.notification.updateMany).toHaveBeenCalledTimes(1);
    const cleared = h.prisma.notification.updateMany.mock.calls[0][0];
    expect(cleared.where.id).toBe("n9");
    expect(cleared.data.clearedBy).toBe("system:device-down");
    // ...and the state machine is re-armed rather than left firing.
    const upd = h.prisma.notificationRuleState.update.mock.calls.find((c: any) => c[0].where.id === "s1");
    expect(upd?.[0].data.state).toBe("clear");
    expect(upd?.[0].data.notificationId).toBe(null);
  });

  it("resets a pending loss row when the device stops answering", async () => {
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("down-1", { monitorStatus: "down" })]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([
      firingState("down-1", { state: "pending", notificationId: null }),
    ]);

    await evaluateAllNotificationRules();

    expect(h.prisma.notification.updateMany).not.toHaveBeenCalled();
    const upd = h.prisma.notificationRuleState.update.mock.calls.find((c: any) => c[0].where.id === "s1");
    expect(upd?.[0].data.state).toBe("clear");
    expect(upd?.[0].data.conditionMetSince).toBe(null);
  });

  it("the answering gate is metric-scoped — a recovering asset still evaluates for CPU", async () => {
    // Every other metric hands off on `down` alone (rule 29(i), covered in
    // notificationDeviceDownHandoff.test.ts); `recovering` is answering again,
    // so its CPU readings are real.
    h.prisma.notificationRule.findMany.mockResolvedValue([CPU_RULE]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("rec-1", { monitorStatus: "recovering" })]);
    h.prisma.assetTelemetrySample.findMany.mockResolvedValue([
      { assetId: "rec-1", timestamp: new Date(), cpuPct: 91, memPct: null, memUsedBytes: null, sessionCount: null },
    ]);

    await evaluateAllNotificationRules();

    expect(h.prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.notification.create.mock.calls[0][0].data.assetId).toBe("rec-1");
  });
});

describe("saturation ceiling", () => {
  /** Report every queried asset at exactly `pct` loss. */
  const reportAll = (pct: number) =>
    h.queryProbeLossRatios.mockImplementation(async (opts: any) =>
      (opts.assetIds ?? []).map((assetId: string) => ({
        assetId, total: 1000n, failed: BigInt(Math.round(pct * 10)),
      })),
    );

  it("drops a 100% reading under the default ceiling", async () => {
    // An answering device CAN read 100% now that the loss anchor is gone — a
    // window full of dead bursts with one late reply is the ordinary shape just
    // after recovery. At 100% the number describes an outage, which the down
    // automation owns.
    reportAll(100);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("up-1")]);

    await evaluateAllNotificationRules();

    expect(h.prisma.notification.create).not.toHaveBeenCalled();
  });

  it("still fires just below the ceiling", async () => {
    reportAll(99.9);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("up-1")]);

    await evaluateAllNotificationRules();

    expect(h.prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  it("honours a lower ceiling the automation sets", async () => {
    // THE POST-OUTAGE CASE. With the anchor removed a device back from a
    // 55-minute outage genuinely reads ~92% for the rest of the window; an
    // operator who does not want an alert trailing every outage sets 90.
    h.prisma.notificationRule.findMany.mockResolvedValue([
      lossRule({
        trigger: {
          type: "asset_metric", metric: "probeLossPct", aggregation: "latest",
          windowSec: 900, operator: ">", threshold: 10, forDurationSec: 0,
          ignoreAtOrAbove: 90,
        },
      }),
    ]);
    reportAll(92);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("up-1")]);

    await evaluateAllNotificationRules();

    expect(h.prisma.notification.create).not.toHaveBeenCalled();
  });

  it("is inclusive — a reading exactly AT the ceiling is dropped", async () => {
    // "Ignore at or above" has to mean it, or a default of 100 would suppress
    // nothing at all.
    h.prisma.notificationRule.findMany.mockResolvedValue([
      lossRule({
        trigger: {
          type: "asset_metric", metric: "probeLossPct", aggregation: "latest",
          windowSec: 900, operator: ">", threshold: 10, forDurationSec: 0,
          ignoreAtOrAbove: 90,
        },
      }),
    ]);
    reportAll(90);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("up-1")]);

    await evaluateAllNotificationRules();

    expect(h.prisma.notification.create).not.toHaveBeenCalled();
  });

  it("CLEARS a live alert whose reading saturated, rather than freezing it", async () => {
    // The device is still answering, so the not-answering handoff never sees
    // it. Without its own handoff the dropped reading looks like "stopped
    // reporting" to clearVanishedStates, which FREEZES — leaving a loss alert
    // escalating through the outage, the exact duplicate rule 29 exists to stop.
    reportAll(100);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("up-1")]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([firingState("up-1")]);

    await evaluateAllNotificationRules();

    expect(h.prisma.notification.updateMany).toHaveBeenCalledTimes(1);
    const cleared = h.prisma.notification.updateMany.mock.calls[0][0];
    expect(cleared.where.id).toBe("n9");
    expect(cleared.data.clearedBy).toBe("system:reading-saturated");
    const upd = h.prisma.notificationRuleState.update.mock.calls.find((c: any) => c[0].where.id === "s1");
    expect(upd?.[0].data.state).toBe("clear");
    expect(upd?.[0].data.notificationId).toBe(null);
  });

  it("does not apply to a metric with no ceiling semantics", async () => {
    // 100 is a perfectly ordinary CPU reading and must still alert.
    h.prisma.notificationRule.findMany.mockResolvedValue([CPU_RULE]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("up-1")]);
    h.prisma.assetTelemetrySample.findMany.mockResolvedValue([
      { assetId: "up-1", timestamp: new Date(), cpuPct: 100, memPct: null, memUsedBytes: null, sessionCount: null },
    ]);

    await evaluateAllNotificationRules();

    expect(h.prisma.notification.create).toHaveBeenCalledTimes(1);
  });
});
