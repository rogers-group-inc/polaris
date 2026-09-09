/**
 * tests/unit/notificationEventTail.test.ts — the engine's event-tail fixes
 * that make event-trigger automations safe to seed at scale:
 *
 *   - cooldownSec enforcement: the tail has no per-(rule,asset) state rows, so
 *     cooldown is checked against recent Notification rows + an in-batch map
 *     (a single 1000-event batch self-dedupes). Keyed by assetId-or-
 *     resourceName so two integrations' failures never suppress each other.
 *   - reset.mode=event: the counterpart Event ("agent.connected" answering
 *     "agent.disconnected") clears the alert, scoped to the SAME subject, and
 *     an event that both fires and clears a rule only ever fires it.
 *   - runEventRuleTimedClear: event/change rules with reset.mode=timed get
 *     their uncleared notifications cleared after afterSec — the regular timed
 *     sweeps walk NotificationRuleState rows, which the event tail never
 *     creates (pre-fix: timed event rules simply never cleared).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const db = {
  rules: [] as any[],
  events: [] as any[],
  assets: [] as any[],
  recentNotifs: [] as any[],
  created: [] as any[],
  updateManyCalls: [] as any[],
  settings: new Map<string, any>(),
};

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationRule: { findMany: vi.fn(async () => db.rules) },
    event: { findMany: vi.fn(async () => db.events) },
    notification: {
      findMany: vi.fn(async () => db.recentNotifs),
      createMany: vi.fn(async ({ data }: any) => {
        db.created.push(...data);
        return { count: data.length };
      }),
      updateMany: vi.fn(async (args: any) => {
        db.updateManyCalls.push(args);
        return { count: 0 };
      }),
    },
    setting: {
      findUnique: vi.fn(async ({ where }: any) => db.settings.get(where.key) ?? null),
      upsert: vi.fn(async ({ where, create }: any) => {
        db.settings.set(where.key, { key: where.key, value: create.value });
        return create;
      }),
    },
    asset: {
      findUnique: vi.fn(async ({ where }: any) => db.assets.find((a) => a.id === where.id) ?? null),
      // Only the event tail's prime query (an explicit id list) is answered
      // from the store; every other findMany keeps the empty default the
      // threshold-path tests in this file rely on.
      findMany: vi.fn(async (args: any) => {
        const ids = args?.where?.id?.in;
        return ids ? db.assets.filter((a) => ids.includes(a.id)) : [];
      }),
    },
    notificationRuleState: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

import { evaluateAllNotificationRules, runEventRuleTimedClear } from "../../src/services/notificationEngine.js";

const NOW = Date.now();

function eventRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "r-ev",
    name: "Discovery failed",
    description: null,
    enabled: true,
    severity: "serious",
    trigger: { type: "event", actionPattern: "integration.discover.error" },
    scope: {},
    reset: { mode: "timed", afterSec: 3600 },
    actions: [],
    targets: [],
    clearBehavior: "timed",
    clearAfterSec: 3600,
    cooldownSec: 600,
    messageTemplate: null,
    emailComposition: null,
    escalation: null,
    severityBands: null,
    bandNotify: null,
    channels: ["in_app"],
    ...overrides,
  };
}

function discoverErrorEvent(resourceName: string, atMsAgo: number) {
  return {
    id: `e-${resourceName}-${atMsAgo}`,
    timestamp: new Date(NOW - atMsAgo),
    action: "integration.discover.error",
    resourceType: "integration",
    resourceId: `i-${resourceName}`,
    resourceName,
    level: "error",
    message: `Discovery failed for ${resourceName}`,
    details: null,
    actor: "system:discovery",
  };
}

beforeEach(() => {
  db.rules.length = 0;
  db.events.length = 0;
  db.assets.length = 0;
  db.recentNotifs.length = 0;
  db.created.length = 0;
  db.updateManyCalls.length = 0;
  db.settings.clear();
});

describe("event-tail cooldown", () => {
  it("two matching events for the same resource inside the window fire ONCE (in-batch dedupe)", async () => {
    db.rules.push(eventRule());
    db.events.push(discoverErrorEvent("FMG-1", 120_000), discoverErrorEvent("FMG-1", 60_000));
    await evaluateAllNotificationRules();
    expect(db.created).toHaveLength(1);
    expect(db.created[0]).toMatchObject({ ruleId: "r-ev", assetHostname: "FMG-1" });
  });

  it("different resources never suppress each other", async () => {
    db.rules.push(eventRule());
    db.events.push(discoverErrorEvent("FMG-1", 120_000), discoverErrorEvent("FMG-2", 60_000));
    await evaluateAllNotificationRules();
    expect(db.created.map((n) => n.assetHostname).sort()).toEqual(["FMG-1", "FMG-2"]);
  });

  it("a recent stored notification suppresses a new fire for the same key", async () => {
    db.rules.push(eventRule());
    db.recentNotifs.push({ ruleId: "r-ev", assetId: null, assetHostname: "FMG-1", triggeredAt: new Date(NOW - 120_000) });
    db.events.push(discoverErrorEvent("FMG-1", 60_000));
    await evaluateAllNotificationRules();
    expect(db.created).toHaveLength(0);
  });

  it("an event past the cooldown window fires again", async () => {
    db.rules.push(eventRule({ cooldownSec: 60 }));
    db.recentNotifs.push({ ruleId: "r-ev", assetId: null, assetHostname: "FMG-1", triggeredAt: new Date(NOW - 300_000) });
    db.events.push(discoverErrorEvent("FMG-1", 10_000));
    await evaluateAllNotificationRules();
    expect(db.created).toHaveLength(1);
  });

  it("no cooldown configured → every matching event fires (pre-feature behavior)", async () => {
    db.rules.push(eventRule({ cooldownSec: null }));
    db.events.push(discoverErrorEvent("FMG-1", 120_000), discoverErrorEvent("FMG-1", 60_000));
    await evaluateAllNotificationRules();
    expect(db.created).toHaveLength(2);
  });
});

describe("runEventRuleTimedClear", () => {
  const asDbRule = (r: Record<string, unknown>) => ({
    id: r.id, name: r.name, description: null, severity: "serious",
    trigger: r.trigger, scope: {}, reset: r.reset, actions: [],
    cooldownSec: null, messageTemplate: null, emailComposition: null,
    escalation: null, severityBands: null, bandNotify: null,
  });

  it("clears uncleared notifications older than afterSec for timed event rules only", async () => {
    const rules = [
      asDbRule({ id: "r-timed", name: "timed", trigger: { type: "event", actionPattern: "x.*" }, reset: { mode: "timed", afterSec: 3600 } }),
      asDbRule({ id: "r-manual", name: "manual", trigger: { type: "event", actionPattern: "y.*" }, reset: { mode: "manual" } }),
      asDbRule({ id: "r-metric", name: "metric", trigger: { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 }, reset: { mode: "timed", afterSec: 3600 } }),
    ];
    const now = new Date();
    await runEventRuleTimedClear(rules as never, now);
    expect(db.updateManyCalls).toHaveLength(1);
    const call = db.updateManyCalls[0];
    expect(call.where.ruleId).toBe("r-timed");
    expect(call.where.cleared).toBe(false);
    expect(call.where.triggeredAt.lte.getTime()).toBe(now.getTime() - 3600_000);
    expect(call.data).toMatchObject({ cleared: true, clearedBy: "system:timed" });
  });

  it("change-trigger rules with timed reset are swept too", async () => {
    const rules = [
      asDbRule({ id: "r-change", name: "change", trigger: { type: "change", changeType: "lldp_neighbor_added" }, reset: { mode: "timed", afterSec: 60 } }),
    ];
    await runEventRuleTimedClear(rules as never, new Date());
    expect(db.updateManyCalls).toHaveLength(1);
    expect(db.updateManyCalls[0].where.ruleId).toBe("r-change");
  });
});

/**
 * reset.mode = "event" — the counterpart Event clears the alert instead of a
 * clock running out. See business rule 32's sibling case: an event automation
 * has no reading to recover, but it usually has a recovery EVENT.
 */
describe("event-tail counterpart reset", () => {
  const agentRule = (overrides: Record<string, unknown> = {}) =>
    eventRule({
      id: "r-agent",
      name: "Agent disconnected",
      trigger: { type: "event", actionPattern: "agent.disconnected" },
      reset: { mode: "event", resetEvent: { actionPattern: "agent.connected" } },
      clearBehavior: "auto",
      clearAfterSec: null,
      cooldownSec: null,
      ...overrides,
    });
  const agentEvent = (action: string, assetId: string, msAgo: number) => ({
    id: `e-${action}-${assetId}-${msAgo}`,
    timestamp: new Date(NOW - msAgo),
    action,
    resourceType: "asset",
    resourceId: assetId,
    resourceName: null,
    level: "warning",
    message: `${action} for ${assetId}`,
    details: null,
    actor: "system:agent-channel",
  });

  it("clears the alert for the SAME asset when the counterpart event arrives", async () => {
    db.rules.push(agentRule());
    db.events.push(agentEvent("agent.disconnected", "a-1", 120_000), agentEvent("agent.connected", "a-1", 60_000));
    await evaluateAllNotificationRules();
    // The disconnect genuinely happened: it is raised and delivered, then cleared.
    expect(db.created).toHaveLength(1);
    const clear = db.updateManyCalls.find((c) => c.data?.clearedBy === "system:event-reset");
    expect(clear).toBeTruthy();
    expect(clear.where.ruleId).toBe("r-agent");
    expect(clear.where.assetId).toBe("a-1");
    expect(clear.where.cleared).toBe(false);
  });

  it("one asset's recovery never clears another asset's alert", async () => {
    db.rules.push(agentRule());
    db.events.push(agentEvent("agent.connected", "a-2", 60_000));
    await evaluateAllNotificationRules();
    const clear = db.updateManyCalls.find((c) => c.data?.clearedBy === "system:event-reset");
    expect(clear.where.assetId).toBe("a-2");
  });

  it("a system-scoped rule keys the clear on the resource label, not an assetId", async () => {
    db.rules.push(agentRule({
      id: "r-disc",
      trigger: { type: "event", actionPattern: "integration.discover.error" },
      reset: { mode: "event", resetEvent: { actionPattern: "integration.discover.completed" } },
    }));
    db.events.push({
      ...discoverErrorEvent("FMG-1", 120_000),
      action: "integration.discover.completed",
      level: "info",
    });
    await evaluateAllNotificationRules();
    const clear = db.updateManyCalls.find((c) => c.data?.clearedBy === "system:event-reset");
    expect(clear.where.assetId).toBeNull();
    expect(clear.where.assetHostname).toBe("FMG-1");
  });

  it("an event that both fires and would clear the rule only FIRES it", async () => {
    // A glob wide enough to match its own recovery would otherwise clear the
    // alert it just raised, every tick, forever.
    db.rules.push(agentRule({ reset: { mode: "event", resetEvent: { actionPattern: "agent.*" } } }));
    db.events.push(agentEvent("agent.disconnected", "a-1", 60_000));
    await evaluateAllNotificationRules();
    expect(db.created).toHaveLength(1);
    expect(db.updateManyCalls.find((c) => c.data?.clearedBy === "system:event-reset")).toBeUndefined();
  });

  it("respects the reset event's optional resourceType narrowing", async () => {
    db.rules.push(agentRule({ reset: { mode: "event", resetEvent: { actionPattern: "agent.connected", resourceType: "integration" } } }));
    db.events.push(agentEvent("agent.connected", "a-1", 60_000)); // resourceType "asset"
    await evaluateAllNotificationRules();
    expect(db.updateManyCalls.find((c) => c.data?.clearedBy === "system:event-reset")).toBeUndefined();
  });

  it("runEventRuleTimedClear leaves event-reset rules alone", async () => {
    await runEventRuleTimedClear([
      {
        id: "r-agent", name: "Agent disconnected", description: null, severity: "warning",
        trigger: { type: "event", actionPattern: "agent.disconnected" }, scope: {},
        reset: { mode: "event", resetEvent: { actionPattern: "agent.connected" } },
        actions: [], cooldownSec: null, messageTemplate: null, emailComposition: null,
        escalation: null, severityBands: null, bandNotify: null,
      },
    ] as never, new Date());
    expect(db.updateManyCalls).toHaveLength(0);
  });
});

// ─── Device filter on the event tail (business rule 46) ─────────────────────
// The wizard used to discard whatever the operator picked on the Devices step
// for an event trigger and save `scope:{}` — save, reopen, "All assets" again.
// Now it saves the filter, so the tail has to honor it; and every automation
// written before it could (`{}`) has to keep firing about everything.

function asset(over: Record<string, unknown> = {}) {
  return {
    id: "a-1", hostname: "sw-1", ipAddress: "10.0.0.1", macAddress: null,
    assetType: "switch", status: "active", location: null, learnedLocation: null,
    description: null, manufacturer: "Fortinet", model: "FS-148F", serialNumber: null,
    os: null, osVersion: null, department: null, assignedTo: null, tags: [],
    dependencySuppressed: false, lastSeenSwitch: null, lastSeenAp: null,
    monitored: true, discoveredByIntegrationId: null,
    ...over,
  };
}

function rebootEvent(assetId: string, name: string, atMsAgo: number) {
  return {
    id: `e-${assetId}-${atMsAgo}`,
    timestamp: new Date(NOW - atMsAgo),
    action: "asset.rebooted",
    resourceType: "asset",
    resourceId: assetId,
    resourceName: name,
    level: "warning",
    message: `${name} rebooted`,
    details: null,
    actor: "system:monitor",
  };
}

const rebootRule = (scope: Record<string, unknown>) =>
  eventRule({
    id: "r-reboot",
    name: "Device rebooted",
    trigger: { type: "event", actionPattern: "asset.rebooted" },
    scope,
    cooldownSec: null,
  });

describe("event-tail device filter", () => {
  it("fires only for the devices the filter names", async () => {
    db.rules.push(rebootRule({ assetTypes: ["firewall"] }));
    db.assets.push(asset({ id: "a-fw", hostname: "fw-1", assetType: "firewall" }), asset({ id: "a-sw", hostname: "sw-1", assetType: "switch" }));
    db.events.push(rebootEvent("a-fw", "fw-1", 60_000), rebootEvent("a-sw", "sw-1", 30_000));
    await evaluateAllNotificationRules();
    expect(db.created.map((n) => n.assetHostname)).toEqual(["fw-1"]);
  });

  it("honors a condition tree the same way (the wizard's builder shape)", async () => {
    db.rules.push(rebootRule({ condition: { op: "and", children: [{ field: "hostname", operator: "contains", value: "fw" }] } }));
    db.assets.push(asset({ id: "a-fw", hostname: "fw-1" }), asset({ id: "a-sw", hostname: "sw-1" }));
    db.events.push(rebootEvent("a-fw", "fw-1", 60_000), rebootEvent("a-sw", "sw-1", 30_000));
    await evaluateAllNotificationRules();
    expect(db.created.map((n) => n.assetHostname)).toEqual(["fw-1"]);
  });

  it("a filtered automation does not fire on an event that names no device", async () => {
    db.rules.push(eventRule({ scope: { assetTypes: ["firewall"] }, cooldownSec: null }));
    db.events.push(discoverErrorEvent("FMG-1", 60_000));
    await evaluateAllNotificationRules();
    expect(db.created).toHaveLength(0);
  });

  it("`{}` — every automation written before filters existed — still fires about everything", async () => {
    db.rules.push(rebootRule({}));
    db.assets.push(asset({ id: "a-fw", hostname: "fw-1", assetType: "firewall" }), asset({ id: "a-sw", hostname: "sw-1" }));
    db.events.push(rebootEvent("a-fw", "fw-1", 60_000), rebootEvent("a-sw", "sw-1", 30_000));
    await evaluateAllNotificationRules();
    expect(db.created.map((n) => n.assetHostname).sort()).toEqual(["fw-1", "sw-1"]);
  });

  it("`allAssets` fires about everything, including subjects that are not devices", async () => {
    db.rules.push(eventRule({ scope: { allAssets: true }, cooldownSec: null }));
    db.events.push(discoverErrorEvent("FMG-1", 60_000));
    await evaluateAllNotificationRules();
    expect(db.created).toHaveLength(1);
  });

  it("change triggers are filtered by the same test", async () => {
    db.rules.push(eventRule({
      id: "r-fw-change",
      trigger: { type: "change", changeType: "firmware_changed" },
      scope: { assetTypes: ["firewall"] },
      cooldownSec: null,
    }));
    db.assets.push(asset({ id: "a-fw", hostname: "fw-1", assetType: "firewall" }), asset({ id: "a-sw", hostname: "sw-1" }));
    db.events.push(
      { ...rebootEvent("a-fw", "fw-1", 60_000), action: "asset.firmware.changed" },
      { ...rebootEvent("a-sw", "sw-1", 30_000), action: "asset.firmware.changed" },
    );
    await evaluateAllNotificationRules();
    expect(db.created.map((n) => n.assetHostname)).toEqual(["fw-1"]);
  });
});
