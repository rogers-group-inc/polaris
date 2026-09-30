/**
 * tests/unit/notificationDependencyDownAlert.test.ts
 *
 * Business rule 78 — a down automation that opts in (`trigger.alertWhenDependencyDown`)
 * still fires for a dependency-suppressed device, the moment it turns Dep. Down,
 * and the alert names who silenced it. Everything else keeps rule 37: an
 * automation without the toggle drops the asset, and a MAINTENANCE window
 * silences even an opted-in one.
 *
 * The alert's flavour follows the asset's flag: a plain Down alert on a device
 * that has since turned Dep. Down, or a dependency-down alert whose upstream
 * came back while the device stayed dark, is ENDED (no reset actions) and
 * raised again in the other flavour.
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
  },
  logEvent: vi.fn(async () => {}),
  blame: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));
vi.mock("../../src/services/notificationRecipientService.js", () => ({
  expandDeliveries: vi.fn(async () => {}),
  scopeRegionTagsOf: vi.fn(() => []),
}));
// The blame walk is DB-bound and has its own tests; here it answers by fixture.
vi.mock("../../src/services/dependencyTreeService.js", () => ({
  resolveDependencyBlame: h.blame,
  newBlameLoadCache: () => ({ states: new Map(), parents: new Map(), edgesLoaded: new Set() }),
}));

import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";

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

const downRule = (over: Record<string, unknown> = {}, trigger: Record<string, unknown> = {}) => ({
  id: "r1",
  name: "PLC down",
  description: null,
  enabled: true,
  severity: "critical",
  trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down", forDurationSec: 0, missedPolls: 3, ...trigger },
  scope: { allAssets: true },
  clearBehavior: "manual",
  clearAfterSec: null,
  cooldownSec: null,
  messageTemplate: null,
  channels: ["in_app"],
  targets: [],
  emailComposition: null,
  escalation: null,
  ...over,
});
const OPTED_IN = downRule({}, { alertWhenDependencyDown: true });

const ONE_HOP = {
  upstream: { id: "sw", hostname: "SW-PLANT-3", reason: "down" },
  rootCause: { id: "sw", hostname: "SW-PLANT-3", reason: "down" },
  chain: [{ id: "sw", hostname: "SW-PLANT-3", reason: "down" }],
  hops: 1,
  truncated: false,
};
const TWO_HOPS = {
  upstream: { id: "sw", hostname: "SW-PLANT-3", reason: "suppressed" },
  rootCause: { id: "fg", hostname: "FG-PLANT", reason: "down" },
  chain: [{ id: "sw", hostname: "SW-PLANT-3", reason: "suppressed" }, { id: "fg", hostname: "FG-PLANT", reason: "down" }],
  hops: 2,
  truncated: false,
};

const firingRow = (assetId: string, notificationId: string) => ({
  id: `st-${assetId}`, ruleId: "r1", assetId, dimensionKey: "", state: "firing",
  conditionMetSince: null, recoveredSince: null, firedAt: new Date(Date.now() - 60_000), notificationId,
  firingSeverity: "critical", bandMetSince: null, metRun: 0, clearRun: 0, lastReadingAt: null, lastValue: null,
});

const created = () => h.prisma.notification.create.mock.calls.map((c) => c[0].data);
const clearedBy = () => h.prisma.notification.updateMany.mock.calls.map((c) => c[0].data?.clearedBy);
const triggeredEvents = () => h.logEvent.mock.calls.map((c) => c[0] as any).filter((e) => e.action === "notification.triggered");

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.notificationRule.findMany.mockResolvedValue([OPTED_IN]);
  h.prisma.notificationRuleState.findMany.mockResolvedValue([]);
  h.prisma.notificationRuleState.findUnique.mockResolvedValue(null);
  h.prisma.notification.create.mockResolvedValue({ id: "n-new" });
  h.prisma.notification.findMany.mockResolvedValue([]);
  h.prisma.setting.findUnique.mockResolvedValue(null);
  h.prisma.event.findMany.mockResolvedValue([]);
  h.blame.mockResolvedValue(ONE_HOP);
});

describe("an automation WITHOUT the toggle keeps rule 37", () => {
  it("drops a dependency-suppressed device, whatever its own probe says", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([downRule()]);
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("plc", { dependencySuppressed: true, monitorStatus: "down" }),
    ]);
    await evaluateAllNotificationRules();
    expect(h.prisma.notification.create).not.toHaveBeenCalled();
    expect(h.blame).not.toHaveBeenCalled();
  });
});

describe("an opted-in automation speaks for its silenced devices", () => {
  it("fires the moment the device is Dep. Down — before its own probe has judged it", async () => {
    // Own status is still `warning`: the count has not been reached, and the
    // upstream's verdict is the evidence the operator asked to hear about.
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("plc", { dependencySuppressed: true, monitorStatus: "warning" }),
    ]);
    await evaluateAllNotificationRules();

    expect(created()).toHaveLength(1);
    const data = created()[0];
    expect(data.assetId).toBe("plc");
    expect(data.dependencyDown).toBe(true);
    expect(data.dependencyBlame).toMatchObject({
      upstream: { id: "sw", hostname: "SW-PLANT-3" },
      rootCause: { id: "sw", hostname: "SW-PLANT-3", reason: "down" },
      hops: 1,
      ownStatus: "warning",
    });
    // The sentence says the state outright and names the switch — this is what
    // the in-app card, the push body and every chat post show.
    expect(data.message).toContain("DEPENDENCY DOWN");
    expect(data.message).toContain("PLC");
    expect(data.message).toContain("upstream device SW-PLANT-3 is down");
    // The audit Event carries the ids a script or SIEM can follow.
    expect(triggeredEvents()).toHaveLength(1);
    expect(triggeredEvents()[0].details).toMatchObject({ dependencyDown: true, upstreamAssetId: "sw", rootCauseAssetId: "sw" });
  });

  it("APPENDS the notice to an operator's own message template rather than replacing it", async () => {
    // The gap a live dev run found: the seeded "Asset down" automation carries
    // messageTemplate "{asset} is down", and push / Slack / Teams send nothing
    // but Notification.message — so the plant would have been paged with the
    // one fact they already knew and none of the reason.
    h.prisma.notificationRule.findMany.mockResolvedValue([
      downRule({ messageTemplate: "{asset} is down" }, { alertWhenDependencyDown: true }),
    ]);
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("plc", { dependencySuppressed: true, monitorStatus: "down" }),
    ]);
    await evaluateAllNotificationRules();
    const msg = created()[0].message as string;
    expect(msg).toBe("PLC is down — DEPENDENCY DOWN — upstream SW-PLANT-3 is down");
    // Their words survive, first.
    expect(msg.startsWith("PLC is down")).toBe(true);
  });

  it("does not double up when the operator's template already renders the notice", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([
      downRule({ messageTemplate: "{dependency.summary}" }, { alertWhenDependencyDown: true }),
    ]);
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("plc", { dependencySuppressed: true, monitorStatus: "down" }),
    ]);
    await evaluateAllNotificationRules();
    const msg = created()[0].message as string;
    expect(msg.match(/DEPENDENCY DOWN/g)).toHaveLength(1);
  });

  it("leaves a custom template alone on a plain Down alert", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([
      downRule({ messageTemplate: "{asset} is down" }, { alertWhenDependencyDown: true }),
    ]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("srv", { monitorStatus: "down" })]);
    await evaluateAllNotificationRules();
    expect(created()[0].message).toBe("SRV is down");
  });

  it("names the root cause when the upstream device is itself dependency-down", async () => {
    h.blame.mockResolvedValue(TWO_HOPS);
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("plc", { dependencySuppressed: true, monitorStatus: "down" }),
    ]);
    await evaluateAllNotificationRules();
    const data = created()[0];
    expect(data.message).toContain("upstream device SW-PLANT-3 sits behind FG-PLANT, which is down");
    expect(data.dependencyBlame).toMatchObject({ rootCause: { id: "fg", hostname: "FG-PLANT" }, hops: 2 });
    expect(triggeredEvents()[0].details).toMatchObject({ upstreamAssetId: "sw", rootCauseAssetId: "fg" });
  });

  it("still fires, unnamed, when the walk cannot say who", async () => {
    h.blame.mockResolvedValue(null);
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("plc", { dependencySuppressed: true, monitorStatus: "down" }),
    ]);
    await evaluateAllNotificationRules();
    const data = created()[0];
    expect(data.dependencyDown).toBe(true);
    expect(data.message).toContain("DEPENDENCY DOWN");
    expect(data.message).toContain("a device above it is down");
  });

  it("a MAINTENANCE window still silences it — rule 16 wins", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("plc", { dependencySuppressed: true, status: "maintenance", monitorStatus: "down" }),
    ]);
    await evaluateAllNotificationRules();
    expect(h.prisma.notification.create).not.toHaveBeenCalled();
  });

  it("an un-suppressed device on the same automation fires as plain Down, with no dependency flavour", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("srv", { monitorStatus: "down" }),
    ]);
    await evaluateAllNotificationRules();
    const data = created()[0];
    expect(data.assetId).toBe("srv");
    expect(data.dependencyDown).toBeUndefined();
    expect(data.dependencyBlame).toBeUndefined();
    expect(data.message).not.toContain("DEPENDENCY DOWN");
    expect(h.blame).not.toHaveBeenCalled();
  });

  it("an up device that is merely suppressed-and-recovering does not fire twice", async () => {
    // Already firing as dependency-down and still Dep. Down: nothing to do.
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("plc", { dependencySuppressed: true, monitorStatus: "down" }),
    ]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([firingRow("plc", "n-dep")]);
    h.prisma.notification.findMany.mockResolvedValue([{ id: "n-dep", dependencyDown: true }]);
    await evaluateAllNotificationRules();
    expect(h.prisma.notification.create).not.toHaveBeenCalled();
    expect(h.prisma.notification.updateMany).not.toHaveBeenCalled();
  });
});

describe("the alert's flavour follows the asset's suppression flag", () => {
  it("a live plain Down alert on a device that turned Dep. Down is ended and raised again naming the switch", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("plc", { dependencySuppressed: true, monitorStatus: "down" }),
    ]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([firingRow("plc", "n-plain")]);
    h.prisma.notification.findMany.mockResolvedValue([{ id: "n-plain", dependencyDown: false }]);

    await evaluateAllNotificationRules();

    expect(clearedBy()).toEqual(["system:dependency-down"]);
    expect(h.prisma.notification.updateMany.mock.calls[0][0].where).toMatchObject({ id: "n-plain", cleared: false });
    // The state row let go before the new fire took it back.
    expect(h.prisma.notificationRuleState.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "st-plc" }, data: expect.objectContaining({ state: "clear", notificationId: null }) }),
    );
    expect(created()).toHaveLength(1);
    expect(created()[0].dependencyDown).toBe(true);
    expect(created()[0].message).toContain("SW-PLANT-3");
    // Audited as a handoff, never as a recovery.
    const handoff = h.logEvent.mock.calls.map((c) => c[0] as any).find((e) => e.action === "notification.superseded");
    expect(handoff).toBeTruthy();
    expect(handoff.details).toMatchObject({ reason: "dependency-down", assetId: "plc" });
    expect(h.logEvent.mock.calls.map((c) => (c[0] as any).action)).not.toContain("notification.auto_cleared");
  });

  it("a dependency-down alert whose upstream came back while the device stayed dark becomes its own outage", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("plc", { dependencySuppressed: false, monitorStatus: "down" }),
    ]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([firingRow("plc", "n-dep")]);
    h.prisma.notification.findMany.mockResolvedValue([{ id: "n-dep", dependencyDown: true }]);

    await evaluateAllNotificationRules();

    expect(clearedBy()).toEqual(["system:dependency-released"]);
    expect(created()).toHaveLength(1);
    expect(created()[0].dependencyDown).toBeUndefined();
    expect(created()[0].message).not.toContain("DEPENDENCY DOWN");
    const handoff = h.logEvent.mock.calls.map((c) => c[0] as any).find((e) => e.action === "notification.superseded");
    expect(handoff.details).toMatchObject({ reason: "dependency-released" });
  });

  it("a dependency-down alert whose device came back UP simply recovers — no handoff, no second alert", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("plc", { dependencySuppressed: false, monitorStatus: "up" }),
    ]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([firingRow("plc", "n-dep")]);
    h.prisma.notification.findMany.mockResolvedValue([{ id: "n-dep", dependencyDown: true }]);

    await evaluateAllNotificationRules();

    expect(h.prisma.notification.create).not.toHaveBeenCalled();
    expect(clearedBy()).not.toContain("system:dependency-released");
    expect(clearedBy()).not.toContain("system:dependency-down");
  });

  it("looks the flavour up only for an opted-in automation's firing rows", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([downRule()]);
    h.prisma.asset.findMany.mockResolvedValue([scopeAsset("srv", { monitorStatus: "down" })]);
    h.prisma.notificationRuleState.findMany.mockResolvedValue([firingRow("srv", "n-x")]);
    await evaluateAllNotificationRules();
    expect(h.prisma.notification.findMany).not.toHaveBeenCalled();
  });
});
