/**
 * tests/unit/notificationEngineComposite.test.ts — composite (AND/OR) trigger
 * evaluation + condition-mode reset. Clones the hysteresis suite's in-memory
 * fake-prisma harness, extended with assets + two sample tables (telemetry +
 * storage) so a two-leaf AND can be driven per asset, plus host samples for
 * the kind=host path and the rule-service trigger-identity cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── In-memory fake prisma ────────────────────────────────────────────────────
interface FakeState {
  id: string;
  ruleId: string;
  assetId: string;
  dimensionKey: string;
  state: string;
  conditionMetSince: Date | null;
  recoveredSince: Date | null;
  firedAt: Date | null;
  lastValue: number | null;
  notificationId: string | null;
}

const db = {
  rules: [] as any[],
  assets: [] as any[],
  telemetry: [] as any[],
  storage: [] as any[],
  hostSamples: [] as any[],
  states: [] as FakeState[],
  notifications: [] as any[],
};
let seq = 0;
let hostSampleQueries = 0;

function findState(where: any): FakeState | null {
  const k = where.ruleId_assetId_dimensionKey;
  return db.states.find((s) => s.ruleId === k.ruleId && s.assetId === k.assetId && s.dimensionKey === k.dimensionKey) ?? null;
}

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationRule: {
      findMany: async () => db.rules,
      findUnique: async ({ where }: any) => db.rules.find((r) => r.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const r = db.rules.find((x) => x.id === where.id);
        if (r) Object.assign(r, data);
        return r;
      },
    },
    asset: {
      findMany: async () => db.assets,
      findUnique: async () => null,
    },
    assetTelemetrySample: {
      findMany: async ({ where }: any) =>
        db.telemetry.filter((r) => where.assetId.in.includes(r.assetId) && r.timestamp >= where.timestamp.gte),
    },
    assetStorageSample: {
      findMany: async ({ where }: any) =>
        db.storage.filter((r) => where.assetId.in.includes(r.assetId) && r.timestamp >= where.timestamp.gte),
    },
    hostMetricsSample: {
      findMany: async () => {
        hostSampleQueries++;
        return db.hostSamples;
      },
    },
    notificationRuleState: {
      findMany: async ({ where }: any) => db.states.filter((s) => s.ruleId === where.ruleId),
      findUnique: async ({ where }: any) => findState(where),
      update: async ({ where, data }: any) => {
        const s = db.states.find((x) => x.id === where.id);
        if (s) Object.assign(s, data);
        return s;
      },
      delete: async ({ where }: any) => {
        const i = db.states.findIndex((x) => x.id === where.id);
        if (i >= 0) db.states.splice(i, 1);
        return {};
      },
      deleteMany: async ({ where }: any) => {
        const before = db.states.length;
        db.states = db.states.filter((s) => s.ruleId !== where.ruleId);
        return { count: before - db.states.length };
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = findState(where);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const created: FakeState = {
          id: `st${++seq}`,
          conditionMetSince: null,
          recoveredSince: null,
          firedAt: null,
          lastValue: null,
          notificationId: null,
          ...create,
        };
        db.states.push(created);
        return created;
      },
    },
    notification: {
      create: async ({ data }: any) => {
        const n = { id: `n${++seq}`, cleared: false, ...data };
        db.notifications.push(n);
        return n;
      },
      updateMany: async ({ where, data }: any) => {
        const ids: string[] = where.id?.in ?? (where.id ? [where.id] : []);
        let count = 0;
        for (const n of db.notifications) {
          // Match by id (engine clears) or by ruleId (the rule service's
          // identity-change/disable/delete cleanup).
          const match = where.ruleId !== undefined ? n.ruleId === where.ruleId : ids.includes(n.id);
          if (match && n.cleared === where.cleared) {
            Object.assign(n, data);
            count++;
          }
        }
        return { count };
      },
    },
    setting: { findUnique: async () => null, upsert: async () => ({}) },
    event: { findMany: async () => [] },
  },
}));

vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../../src/services/notificationRecipientService.js", () => ({
  expandDeliveries: vi.fn(async () => {}),
  scopeRegionTagsOf: () => [],
  listRecipientUsers: vi.fn(async () => []),
  buildComposedEmail: vi.fn(() => ({ subject: "", text: "" })),
}));
vi.mock("../../src/services/automationActionService.js", () => ({
  executeActions: vi.fn(async () => ({ executed: 0, failed: 0 })),
}));

import { evaluateAllNotificationRules, previewRule } from "../../src/services/notificationEngine.js";
import { updateRule } from "../../src/services/notificationRuleService.js";
import { ruleInputSchema, previewInputSchema } from "../../src/services/notificationTypes.js";

const T0 = new Date("2026-07-21T12:00:00Z");

const cpuLeaf = { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90, aggregation: "latest", windowSec: 0 };
const storLeaf = {
  type: "asset_metric", metric: "storageUsedPct", operator: ">=", threshold: 80,
  aggregation: "latest", windowSec: 0, dimensionFilter: { mountPathPattern: "/var" },
};

function compositeRule(extra: Record<string, unknown> = {}, op: "and" | "or" = "and") {
  return {
    id: "r1",
    name: "combo",
    description: null,
    severity: "warning",
    trigger: { type: "composite", kind: "asset", op, children: [cpuLeaf, storLeaf], forDurationSec: 0 },
    scope: { allAssets: true },
    clearBehavior: "manual",
    clearAfterSec: null,
    cooldownSec: null,
    messageTemplate: null,
    channels: ["in_app"],
    targets: [],
    emailComposition: null,
    escalation: null,
    reset: { mode: "auto" },
    actions: [],
    ...extra,
  };
}

function mkAsset(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, hostname: id, assetType: "server", tags: [], discoveredByIntegrationId: null,
    monitorStatus: "up", status: "active", consecutiveFailures: 0, dependencySuppressed: false,
    quarantinedAt: null, ipAddress: null, manufacturer: null, model: null, os: null,
    // The one mount these tests tick. Storage readings are pinned-mount only
    // (storageIsPinned over Asset.monitoredStorage), so without the pin the
    // storage leaf of every composite here would silently resolve to "no
    // reading" and the AND/OR assertions would stop testing anything.
    monitoredStorage: ["/var"],
    ...extra,
  };
}

/** One engine tick. cpu = per-asset cpuPct (omit an asset = no telemetry row);
 *  storagePct = per-asset /var used% (omit = no storage row). */
async function tick(cpu: Record<string, number>, storagePct: Record<string, number>) {
  const now = new Date();
  db.telemetry = Object.entries(cpu).map(([assetId, v]) => ({ assetId, timestamp: now, cpuPct: v, memPct: null, memUsedBytes: null, sessionCount: null }));
  db.storage = Object.entries(storagePct).map(([assetId, pct]) => ({ assetId, timestamp: now, mountPath: "/var", usedBytes: pct, totalBytes: 100 }));
  await evaluateAllNotificationRules();
}

const stateOf = (assetId: string) => db.states.find((s) => s.assetId === assetId && s.dimensionKey === "");
const activeNotifs = () => db.notifications.filter((n) => !n.cleared);

beforeEach(() => {
  db.rules = [];
  db.assets = [mkAsset("a1"), mkAsset("a2")];
  db.telemetry = [];
  db.storage = [];
  db.hostSamples = [];
  db.states = [];
  db.notifications = [];
  seq = 0;
  hostSampleQueries = 0;
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("composite AND/OR evaluation", () => {
  it("AND fires one alert per asset at dimensionKey '' only when every leaf is met", async () => {
    db.rules = [compositeRule()];
    await tick({ a1: 95, a2: 95 }, { a1: 94, a2: 40 }); // a1 both; a2 cpu only
    expect(activeNotifs()).toHaveLength(1);
    const n = activeNotifs()[0];
    expect(n.assetId).toBe("a1");
    expect(stateOf("a1")!.state).toBe("firing");
    expect(stateOf("a1")!.dimensionKey).toBe("");
    expect(stateOf("a2")).toBeUndefined(); // AND not met → no state row at all
    // Default message names the met conditions + the witness dimension.
    expect(n.message).toContain("CPU utilization >= 90 (95)");
    expect(n.message).toContain("(/var = 94)");
    expect(n.message).toContain("2 of 2 conditions met");
  });

  it("OR fires when any leaf is met", async () => {
    db.rules = [compositeRule({}, "or")];
    await tick({ a1: 50, a2: 50 }, { a1: 94, a2: 40 }); // a1 storage only
    expect(activeNotifs()).toHaveLength(1);
    expect(activeNotifs()[0].assetId).toBe("a1");
    expect(activeNotifs()[0].message).toContain("1 of 2 conditions met");
  });

  it("forDurationSec debounces: pending first, fires once sustained", async () => {
    db.rules = [compositeRule({ trigger: { type: "composite", kind: "asset", op: "and", children: [cpuLeaf, storLeaf], forDurationSec: 120 } })];
    await tick({ a1: 95 }, { a1: 94 });
    expect(stateOf("a1")!.state).toBe("pending");
    expect(activeNotifs()).toHaveLength(0);
    vi.setSystemTime(new Date(T0.getTime() + 130_000));
    await tick({ a1: 95 }, { a1: 94 });
    expect(stateOf("a1")!.state).toBe("firing");
    expect(activeNotifs()).toHaveLength(1);
  });

  it("a partial-missing tick under AND resets the pending debounce", async () => {
    db.rules = [compositeRule({ trigger: { type: "composite", kind: "asset", op: "and", children: [cpuLeaf, storLeaf], forDurationSec: 120 } })];
    await tick({ a1: 95 }, { a1: 94 });
    expect(stateOf("a1")!.state).toBe("pending");
    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    await tick({ a1: 95 }, {}); // storage leaf missing → AND false
    expect(stateOf("a1")!.state).toBe("clear");
  });

  it("an asset with ZERO readings across all leaves is frozen (firing survives)", async () => {
    db.rules = [compositeRule()];
    await tick({ a1: 95 }, { a1: 94 });
    expect(stateOf("a1")!.state).toBe("firing");
    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    await tick({}, {}); // asset stopped reporting entirely
    expect(stateOf("a1")!.state).toBe("firing"); // frozen, not auto-cleared
    expect(activeNotifs()).toHaveLength(1);
  });

  it("auto reset clears when the tree is no longer true; sustain + re-meet cancel work", async () => {
    db.rules = [compositeRule({ reset: { mode: "auto", sustainSec: 120 } })];
    await tick({ a1: 95 }, { a1: 94 });
    expect(stateOf("a1")!.state).toBe("firing");

    await tick({ a1: 95 }, { a1: 40 }); // AND false → recovery observed, timer starts
    expect(stateOf("a1")!.state).toBe("firing");
    expect(stateOf("a1")!.recoveredSince).toEqual(T0);

    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    await tick({ a1: 95 }, { a1: 94 }); // re-met mid-sustain — timer cancels
    expect(stateOf("a1")!.recoveredSince).toBeNull();

    vi.setSystemTime(new Date(T0.getTime() + 120_000));
    await tick({ a1: 50 }, { a1: 40 });
    vi.setSystemTime(new Date(T0.getTime() + 241_000));
    await tick({ a1: 50 }, { a1: 40 }); // sustained ≥ 120s — clears
    expect(stateOf("a1")!.state).toBe("clear");
    expect(activeNotifs()).toHaveLength(0);
    expect(db.notifications[0].clearedBy).toBe("system:auto-resolve");
  });

  it("cooldown suppresses an immediate refire after auto-clear", async () => {
    db.rules = [compositeRule({ cooldownSec: 600 })];
    await tick({ a1: 95 }, { a1: 94 });
    await tick({ a1: 50 }, { a1: 40 }); // auto-clears
    expect(db.notifications).toHaveLength(1);
    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    await tick({ a1: 95 }, { a1: 94 }); // within cooldown
    expect(db.notifications).toHaveLength(1);
    vi.setSystemTime(new Date(T0.getTime() + 601_000));
    await tick({ a1: 95 }, { a1: 94 }); // cooldown elapsed
    expect(db.notifications).toHaveLength(2);
  });

  it("timed reset clears by the sweep even while the tree still meets", async () => {
    db.rules = [compositeRule({ reset: { mode: "timed", afterSec: 60 } })];
    await tick({ a1: 95 }, { a1: 94 });
    expect(stateOf("a1")!.state).toBe("firing");
    vi.setSystemTime(new Date(T0.getTime() + 61_000));
    await tick({ a1: 95 }, { a1: 94 });
    expect(stateOf("a1")!.state).toBe("clear");
    expect(db.notifications[0].clearedBy).toBe("system:timed");
  });

  it("orphan sweep: per-dimension state rows under a composite rule are cleared + deleted", async () => {
    db.rules = [compositeRule()];
    // Simulate a single→composite edit that left a per-mount firing row behind.
    db.notifications.push({ id: "nOld", cleared: false });
    db.states.push({
      id: "stOld", ruleId: "r1", assetId: "a1", dimensionKey: "/var", state: "firing",
      conditionMetSince: null, recoveredSince: null, firedAt: T0, lastValue: 94, notificationId: "nOld",
    });
    await tick({}, {});
    expect(db.states.find((s) => s.id === "stOld")).toBeUndefined();
    const old = db.notifications.find((n) => n.id === "nOld")!;
    expect(old.cleared).toBe(true);
    expect(old.clearedBy).toBe("system:rule-edited");
  });

  it("suppressed assets: pending resets, firing freezes", async () => {
    db.rules = [compositeRule({ trigger: { type: "composite", kind: "asset", op: "and", children: [cpuLeaf, storLeaf], forDurationSec: 120 } })];
    await tick({ a1: 95, a2: 95 }, { a1: 94, a2: 94 });
    expect(stateOf("a1")!.state).toBe("pending");
    expect(stateOf("a2")!.state).toBe("pending");
    // a1 into maintenance; its debounce must restart after the window.
    db.assets = [mkAsset("a1", { status: "maintenance" }), mkAsset("a2")];
    vi.setSystemTime(new Date(T0.getTime() + 130_000));
    await tick({ a1: 95, a2: 95 }, { a1: 94, a2: 94 });
    expect(stateOf("a1")!.state).toBe("clear"); // pending reset
    expect(stateOf("a2")!.state).toBe("firing"); // unaffected asset fired
  });

  it("host composite (kind=host) fires one alert at assetId ''", async () => {
    db.rules = [compositeRule({
      trigger: {
        type: "composite", kind: "host", op: "and",
        children: [
          { type: "host_metric", metric: "cpuPct", operator: ">=", threshold: 90, aggregation: "latest", windowSec: 0 },
          { type: "host_metric", metric: "memUsedPct", operator: ">=", threshold: 80, aggregation: "latest", windowSec: 0 },
        ],
        forDurationSec: 0,
      },
    })];
    db.hostSamples = [{ cpuPct: 95, memUsedPct: 85, timestamp: T0 }];
    await evaluateAllNotificationRules();
    expect(activeNotifs()).toHaveLength(1);
    expect(activeNotifs()[0].assetId).toBeNull();
    expect(activeNotifs()[0].assetHostname).toBe("Polaris host");
    const st = db.states.find((s) => s.assetId === "" && s.dimensionKey === "");
    expect(st!.state).toBe("firing");
    // Two distinct leaves = two resolver calls (dedupe is for identical leaves).
    expect(hostSampleQueries).toBe(2);
  });

  it("identical leaves share one resolver query", async () => {
    const leaf = { type: "host_metric", metric: "cpuPct", operator: ">=", threshold: 90, aggregation: "latest", windowSec: 0 };
    db.rules = [compositeRule({
      trigger: { type: "composite", kind: "host", op: "or", children: [leaf, { ...leaf }], forDurationSec: 0 },
    })];
    db.hostSamples = [{ cpuPct: 50, timestamp: T0 }];
    await evaluateAllNotificationRules();
    expect(hostSampleQueries).toBe(1);
  });
});

describe("condition-mode reset", () => {
  const resetTree = { op: "and", children: [{ type: "asset_metric", metric: "cpuPct", operator: "<", threshold: 70, aggregation: "latest", windowSec: 0 }] };

  it("the reset tree is the sole recovery authority while firing", async () => {
    db.rules = [compositeRule({ reset: { mode: "condition", condition: resetTree } })];
    await tick({ a1: 95 }, { a1: 94 });
    expect(stateOf("a1")!.state).toBe("firing");

    // Trigger no longer true (storage recovered) but cpu 75 ≥ reset's <70 — stays firing.
    await tick({ a1: 75 }, { a1: 40 });
    expect(stateOf("a1")!.state).toBe("firing");
    expect(activeNotifs()).toHaveLength(1);

    // Reset tree true (cpu < 70) → clears, even though it just cleared via tree not trigger.
    await tick({ a1: 65 }, { a1: 40 });
    expect(stateOf("a1")!.state).toBe("clear");
    expect(activeNotifs()).toHaveLength(0);
    expect(db.notifications[0].clearedBy).toBe("system:auto-resolve");
  });

  it("condition reset honors sustainSec, and the trigger re-meeting does not cancel the timer", async () => {
    db.rules = [compositeRule({ reset: { mode: "condition", condition: resetTree, sustainSec: 120 } })];
    await tick({ a1: 95 }, { a1: 94 });
    expect(stateOf("a1")!.state).toBe("firing");

    await tick({ a1: 65 }, { a1: 40 }); // reset tree true — timer starts
    expect(stateOf("a1")!.recoveredSince).toEqual(T0);

    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    await tick({ a1: 65 }, { a1: 94 }); // trigger storage leaf re-met — reset tree STILL true, timer keeps running
    expect(stateOf("a1")!.recoveredSince).toEqual(T0);
    expect(stateOf("a1")!.state).toBe("firing");

    vi.setSystemTime(new Date(T0.getTime() + 121_000));
    await tick({ a1: 65 }, { a1: 40 }); // sustained ≥ 120s — clears
    expect(stateOf("a1")!.state).toBe("clear");
  });

  it("reset tree going false cancels the sustain timer", async () => {
    db.rules = [compositeRule({ reset: { mode: "condition", condition: resetTree, sustainSec: 120 } })];
    await tick({ a1: 95 }, { a1: 94 });
    await tick({ a1: 65 }, { a1: 40 });
    expect(stateOf("a1")!.recoveredSince).not.toBeNull();
    await tick({ a1: 85 }, { a1: 40 }); // cpu back above 70 — reset no longer met
    expect(stateOf("a1")!.recoveredSince).toBeNull();
    expect(stateOf("a1")!.state).toBe("firing");
  });

  it("fire → condition-clear → refire loop is gated by cooldown", async () => {
    // Non-exclusive reset: trigger AND reset can both be true (cpu ≥ 90 fires;
    // reset tree is storage < 100 — always true here). Cooldown must gate.
    const alwaysReset = { op: "and", children: [{ type: "asset_metric", metric: "storageUsedPct", operator: "<", threshold: 100, aggregation: "latest", windowSec: 0, dimensionFilter: { mountPathPattern: "/var" } }] };
    db.rules = [compositeRule({ reset: { mode: "condition", condition: alwaysReset }, cooldownSec: 600 })];
    await tick({ a1: 95 }, { a1: 94 }); // fires
    expect(db.notifications).toHaveLength(1);
    await tick({ a1: 95 }, { a1: 94 }); // reset tree true → clears
    expect(stateOf("a1")!.state).toBe("clear");
    await tick({ a1: 95 }, { a1: 94 }); // would refire, but cooldown holds
    expect(db.notifications).toHaveLength(1);
    vi.setSystemTime(new Date(T0.getTime() + 601_000));
    await tick({ a1: 95 }, { a1: 94 }); // cooldown elapsed — refires
    expect(db.notifications).toHaveLength(2);
  });
});

describe("composite preview", () => {
  it("returns one row per asset with a per-leaf breakdown", async () => {
    const now = new Date();
    db.telemetry = [
      { assetId: "a1", timestamp: now, cpuPct: 95, memPct: null, memUsedBytes: null, sessionCount: null },
      { assetId: "a2", timestamp: now, cpuPct: 45, memPct: null, memUsedBytes: null, sessionCount: null },
    ];
    db.storage = [{ assetId: "a1", timestamp: now, mountPath: "/var", usedBytes: 94, totalBytes: 100 }];
    const input = previewInputSchema.parse({
      trigger: { type: "composite", kind: "asset", op: "and", children: [cpuLeaf, storLeaf], forDurationSec: 0 },
      scope: { allAssets: true },
    });
    const res = await previewRule(input as any);
    expect(res.supported).toBe(true);
    expect(res.totalEvaluated).toBe(2);

    const m1 = res.matches.find((m) => m.assetId === "a1")!;
    expect(m1.meets).toBe(true);
    expect(m1.conditionsSummary).toBe("2 of 2 conditions met");
    expect(m1.leaves).toHaveLength(2);
    expect(m1.leaves![0]).toMatchObject({ leafId: "0", met: true, value: 95, noData: false });
    expect(m1.leaves![1]).toMatchObject({ leafId: "1", met: true, dimension: "/var", noData: false });

    const m2 = res.matches.find((m) => m.assetId === "a2")!;
    expect(m2.meets).toBe(false);
    expect(m2.leaves![0]).toMatchObject({ met: false, value: 45, noData: false }); // measured false
    expect(m2.leaves![1]).toMatchObject({ met: false, value: null, noData: true }); // no storage data
    // Met rows sort first.
    expect(res.matches[0].assetId).toBe("a1");
  });

  it("skips assets with zero readings across all leaves", async () => {
    db.telemetry = [];
    db.storage = [];
    const input = previewInputSchema.parse({
      trigger: { type: "composite", kind: "asset", op: "and", children: [cpuLeaf, storLeaf], forDurationSec: 0 },
      scope: { allAssets: true },
    });
    const res = await previewRule(input as any);
    expect(res.totalEvaluated).toBe(0);
    expect(res.matches).toHaveLength(0);
  });
});

describe("rule-service trigger-identity cleanup", () => {
  it("updateRule clears alerts + deletes state rows when the trigger identity changes", async () => {
    db.rules = [compositeRule()];
    db.notifications.push({ id: "nA", ruleId: "r1", cleared: false });
    db.states.push({
      id: "stA", ruleId: "r1", assetId: "a1", dimensionKey: "", state: "firing",
      conditionMetSince: null, recoveredSince: null, firedAt: T0, lastValue: null, notificationId: "nA",
    });
    // composite → single cpu trigger = identity change (composite:asset → asset_metric:cpuPct)
    const input = ruleInputSchema.parse({
      name: "combo",
      trigger: { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 },
    });
    await updateRule("r1", input, "tester");
    expect(db.states).toHaveLength(0);
    const n = db.notifications.find((x) => x.id === "nA")!;
    expect(n.cleared).toBe(true);
    expect(n.clearedBy).toBe("system:rule-edited");
  });

  it("a threshold-only edit keeps state rows (same identity)", async () => {
    db.rules = [compositeRule()];
    db.states.push({
      id: "stA", ruleId: "r1", assetId: "a1", dimensionKey: "", state: "firing",
      conditionMetSince: null, recoveredSince: null, firedAt: T0, lastValue: null, notificationId: null,
    });
    const input = ruleInputSchema.parse({
      name: "combo",
      trigger: { type: "composite", kind: "asset", op: "and", children: [{ ...cpuLeaf, threshold: 95 }, storLeaf], forDurationSec: 0 },
    });
    await updateRule("r1", input, "tester");
    expect(db.states).toHaveLength(1);
  });
});
