/**
 * tests/unit/notificationResetConditions.test.ts — custom reset CONDITIONS on a
 * SINGLE (non-composite) trigger: the 2026-08 change that let the wizard offer
 * "when custom conditions are met" for every continuous trigger, seeded with the
 * trigger inverted.
 *
 * Two properties are what this suite exists to pin:
 *
 *   1. While an alert is firing the reset tree is the SOLE recovery authority —
 *      the trigger falling away does not clear it, and the trigger re-meeting
 *      does not cancel the reset's sustain timer.
 *   2. The tree resolves DIMENSION-FIRST, and the per-asset fallback is scoped to
 *      leaves in ANOTHER dimension space. A per-mount alert whose reset leaf is
 *      on the same mount clears independently of its siblings; a reset leaf on a
 *      device-wide metric (CPU) clears them all; a same-space leaf with no
 *      reading for that mount clears nothing (business rule 32(b) —
 *      poeFaultResetDimension.test.ts is where that half is pinned).
 *
 * Clones the composite suite's in-memory fake prisma, with a storage tick that
 * can report SEVERAL mounts per asset (the composite harness reports one) so the
 * per-dimension half is actually observable.
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

function findState(where: any): FakeState | null {
  const k = where.ruleId_assetId_dimensionKey;
  return db.states.find((s) => s.ruleId === k.ruleId && s.assetId === k.assetId && s.dimensionKey === k.dimensionKey) ?? null;
}

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationRule: { findMany: async () => db.rules },
    asset: { findMany: async () => db.assets, findUnique: async () => null },
    assetTelemetrySample: {
      findMany: async ({ where }: any) =>
        db.telemetry.filter((r) => where.assetId.in.includes(r.assetId) && r.timestamp >= where.timestamp.gte),
    },
    assetStorageSample: {
      findMany: async ({ where }: any) =>
        db.storage.filter((r) => where.assetId.in.includes(r.assetId) && r.timestamp >= where.timestamp.gte),
    },
    hostMetricsSample: { findMany: async () => db.hostSamples },
    notificationRuleState: {
      // The reset pass re-reads firing rows with a `state` filter, so the fake
      // has to honor it — filtering on ruleId alone would hand it every row.
      findMany: async ({ where }: any) =>
        db.states.filter((s) => s.ruleId === where.ruleId && (where.state === undefined || s.state === where.state)),
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
          if (ids.includes(n.id) && n.cleared === where.cleared) {
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

import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";

const T0 = new Date("2026-08-19T12:00:00Z");

function mkAsset(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, hostname: id, assetType: "server", tags: [], discoveredByIntegrationId: null,
    monitorStatus: "up", status: "active", consecutiveFailures: 0, dependencySuppressed: false,
    quarantinedAt: null, ipAddress: null, manufacturer: null, model: null, os: null,
    // The mounts these tests tick. Storage readings are pinned-mount only
    // (storageIsPinned over Asset.monitoredStorage), so an asset with an empty
    // pin set produces no storage readings at all and every storage assertion
    // below would pass vacuously.
    monitoredStorage: ["/var", "/opt"],
    ...extra,
  };
}

function baseRule(trigger: unknown, reset: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: "r1",
    name: "rule",
    description: null,
    severity: "warning",
    trigger,
    scope: { allAssets: true },
    clearBehavior: "manual",
    clearAfterSec: null,
    cooldownSec: null,
    messageTemplate: null,
    channels: ["in_app"],
    targets: [],
    emailComposition: null,
    escalation: null,
    reset,
    actions: [],
    ...extra,
  };
}

/** Polaris-host tick: cpu + memory in one sample row. */
async function hostTick(cpuPct: number, memUsedPct: number) {
  db.hostSamples = [{ cpuPct, memUsedPct, memUsedBytes: 0n, loadAvg1: 0, loadAvg5: 0, loadAvg15: 0, procRssBytes: 0n }];
  await evaluateAllNotificationRules();
}

/** Device tick. `mounts` is per-asset { mountPath: used% }; `cpu` per-asset. */
async function assetTick(mounts: Record<string, Record<string, number>>, cpu: Record<string, number> = {}) {
  const now = new Date();
  db.storage = Object.entries(mounts).flatMap(([assetId, byMount]) =>
    Object.entries(byMount).map(([mountPath, pct]) => ({ assetId, timestamp: now, mountPath, usedBytes: pct, totalBytes: 100 })),
  );
  db.telemetry = Object.entries(cpu).map(([assetId, v]) => ({ assetId, timestamp: now, cpuPct: v, memPct: null, memUsedBytes: null, sessionCount: null }));
  await evaluateAllNotificationRules();
}

const hostState = () => db.states.find((s) => s.assetId === "" && s.dimensionKey === "");
const dimState = (assetId: string, dim: string) => db.states.find((s) => s.assetId === assetId && s.dimensionKey === dim);
const activeNotifs = () => db.notifications.filter((n) => !n.cleared);

const HOST_CPU = { type: "host_metric", metric: "cpuPct", operator: ">=", threshold: 90, aggregation: "latest", windowSec: 0, forDurationSec: 0 };
const hostLeaf = (metric: string, operator: string, threshold: number) => ({ type: "host_metric", metric, operator, threshold, aggregation: "latest", windowSec: 0 });

const STORAGE_TRIGGER = {
  type: "asset_metric", metric: "storageUsedPct", operator: ">=", threshold: 80,
  aggregation: "latest", windowSec: 0, forDurationSec: 0, dimensionFilter: {},
};

beforeEach(() => {
  db.rules = [];
  db.assets = [mkAsset("a1")];
  db.telemetry = [];
  db.storage = [];
  db.hostSamples = [];
  db.states = [];
  db.notifications = [];
  seq = 0;
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── The reset tree is the sole recovery authority ────────────────────────────

describe("single-trigger reset conditions — recovery authority", () => {
  it("the INVERTED trigger seed behaves like the automatic reset", async () => {
    // What the wizard writes when the operator unchecks the box and leaves the
    // seeded tree alone: cpu >= 90 fires, cpu < 90 clears.
    db.rules = [baseRule(HOST_CPU, { mode: "condition", condition: { op: "or", children: [hostLeaf("cpuPct", "<", 90)] } })];
    await hostTick(95, 10);
    expect(hostState()?.state).toBe("firing");
    await hostTick(70, 10);
    expect(hostState()?.state).toBe("clear");
    expect(activeNotifs()).toHaveLength(0);
  });

  it("the trigger going false does NOT clear when the reset tree is still false", async () => {
    // A dead band the operator wrote by hand: fire at >= 90, clear only under 60.
    db.rules = [baseRule(HOST_CPU, { mode: "condition", condition: { op: "and", children: [hostLeaf("cpuPct", "<", 60)] } })];
    await hostTick(95, 10);
    expect(hostState()?.state).toBe("firing");
    await hostTick(75, 10); // below the fire threshold, above the reset line
    expect(hostState()?.state).toBe("firing");
    expect(activeNotifs()).toHaveLength(1);
    await hostTick(50, 10);
    expect(hostState()?.state).toBe("clear");
  });

  it("recovers on a DIFFERENT metric — even while the trigger still meets", async () => {
    // "The CPU alert clears when memory is back under control" is nonsense as an
    // automation but is exactly the shape that proves the tree, not the trigger,
    // decides recovery.
    db.rules = [baseRule(HOST_CPU, { mode: "condition", condition: { op: "and", children: [hostLeaf("memUsedPct", "<", 50)] } })];
    await hostTick(95, 90);
    expect(hostState()?.state).toBe("firing");
    await hostTick(95, 20); // trigger still true, reset tree true
    expect(hostState()?.state).toBe("clear");
    expect(activeNotifs()).toHaveLength(0);
  });

  it("an AND tree needs every leaf; an OR tree needs one", async () => {
    const both = { op: "and", children: [hostLeaf("cpuPct", "<", 60), hostLeaf("memUsedPct", "<", 50)] };
    db.rules = [baseRule(HOST_CPU, { mode: "condition", condition: both })];
    await hostTick(95, 90);
    expect(hostState()?.state).toBe("firing");
    await hostTick(50, 90); // cpu recovered, memory has not
    expect(hostState()?.state).toBe("firing");
    await hostTick(50, 20);
    expect(hostState()?.state).toBe("clear");

    db.states = [];
    db.notifications = [];
    db.rules = [baseRule(HOST_CPU, { mode: "condition", condition: { op: "or", children: both.children } })];
    await hostTick(95, 90);
    expect(hostState()?.state).toBe("firing");
    await hostTick(50, 90); // one leaf is enough under OR
    expect(hostState()?.state).toBe("clear");
  });

  it("a firing alert whose TRIGGER stopped reporting still clears on the tree", async () => {
    // The auto path freezes a row with no reading (absent evidence is not
    // recovery). Under a condition reset the trigger isn't the authority, so a
    // metric that vanished must not strand the alert forever.
    db.rules = [baseRule(
      { ...HOST_CPU, metric: "loadAvg1", threshold: 8 },
      { mode: "condition", condition: { op: "and", children: [hostLeaf("memUsedPct", "<", 50)] } },
    )];
    db.hostSamples = [{ cpuPct: 0, memUsedPct: 90, memUsedBytes: 0n, loadAvg1: 9, loadAvg5: 0, loadAvg15: 0, procRssBytes: 0n }];
    await evaluateAllNotificationRules();
    expect(hostState()?.state).toBe("firing");
    // loadAvg1 recovers out of the alert's way while memory recovers too.
    await hostTick(0, 20);
    expect(hostState()?.state).toBe("clear");
  });
});

// ── Clear-sustain on a condition reset ───────────────────────────────────────

describe("single-trigger reset conditions — sustain", () => {
  // The reset leaf is deliberately on MEMORY while the trigger watches CPU, so
  // the trigger can re-meet without also making the reset tree false — which is
  // the only way to observe that `recoveredSince` belongs to the tree.
  const RESET = { mode: "condition", condition: { op: "and", children: [hostLeaf("memUsedPct", "<", 50)] }, sustainSec: 600 };

  it("the recovery must hold sustainSec before the alert clears", async () => {
    db.rules = [baseRule(HOST_CPU, RESET)];
    await hostTick(95, 90);
    expect(hostState()?.state).toBe("firing");

    await hostTick(50, 20); // reset tree true — timer starts
    expect(hostState()?.state).toBe("firing");
    expect(hostState()?.recoveredSince).toBeInstanceOf(Date);

    vi.setSystemTime(new Date(T0.getTime() + 5 * 60_000));
    await hostTick(50, 20);
    expect(hostState()?.state).toBe("firing"); // not yet 10 minutes

    vi.setSystemTime(new Date(T0.getTime() + 11 * 60_000));
    await hostTick(50, 20);
    expect(hostState()?.state).toBe("clear");
  });

  it("the trigger re-meeting does not cancel the reset's timer", async () => {
    db.rules = [baseRule(HOST_CPU, RESET)];
    await hostTick(95, 90);
    await hostTick(50, 20); // timer starts at T0
    expect(hostState()?.recoveredSince?.getTime()).toBe(T0.getTime());

    // CPU climbs back over the fire threshold. Under the automatic reset that
    // cancels the clear-sustain timer; under a condition reset the timer is the
    // TREE's, and the tree (memory) is still recovered.
    vi.setSystemTime(new Date(T0.getTime() + 5 * 60_000));
    await hostTick(95, 20);
    expect(hostState()?.recoveredSince?.getTime()).toBe(T0.getTime());
    expect(hostState()?.state).toBe("firing");

    vi.setSystemTime(new Date(T0.getTime() + 11 * 60_000));
    await hostTick(95, 20); // trigger still true — the tree clears it anyway
    expect(hostState()?.state).toBe("clear");
  });

  it("the reset tree going false cancels the timer", async () => {
    db.rules = [baseRule(HOST_CPU, RESET)];
    await hostTick(95, 90);
    await hostTick(50, 20);
    expect(hostState()?.recoveredSince).toBeInstanceOf(Date);

    vi.setSystemTime(new Date(T0.getTime() + 5 * 60_000));
    await hostTick(50, 90); // memory back over the reset line
    expect(hostState()?.recoveredSince).toBeNull();
    expect(hostState()?.state).toBe("firing");
  });
});

// ── Dimension-first resolution ───────────────────────────────────────────────

describe("single-trigger reset conditions — per-dimension resolution", () => {
  it("a same-dimension reset leaf clears one mount's alert, not its siblings", async () => {
    db.rules = [baseRule(STORAGE_TRIGGER, {
      mode: "condition",
      condition: { op: "and", children: [{ type: "asset_metric", metric: "storageUsedPct", operator: "<", threshold: 60, aggregation: "latest", windowSec: 0, dimensionFilter: {} }] },
    })];
    await assetTick({ a1: { "/var": 95, "/opt": 90 } });
    expect(dimState("a1", "/var")?.state).toBe("firing");
    expect(dimState("a1", "/opt")?.state).toBe("firing");
    expect(activeNotifs()).toHaveLength(2);

    // /var drains, /opt does not.
    await assetTick({ a1: { "/var": 30, "/opt": 90 } });
    expect(dimState("a1", "/var")?.state).toBe("clear");
    expect(dimState("a1", "/opt")?.state).toBe("firing");
    expect(activeNotifs()).toHaveLength(1);
  });

  it("an UNPINNED mount raises nothing, however full it is", async () => {
    // The gate the complaint was about: the storage stream walks every
    // mountpath and keeps the unpinned ones at cadence="slow", so a
    // "disk over 80%" rule used to alert on every volume the device happened
    // to report. Only the mounts the operator marked for monitoring alert.
    db.assets = [mkAsset("a1", { monitoredStorage: ["/var"] })];
    db.rules = [baseRule(STORAGE_TRIGGER, { mode: "auto" })];
    await assetTick({ a1: { "/var": 95, "/opt": 99 } });
    expect(dimState("a1", "/var")?.state).toBe("firing");
    expect(dimState("a1", "/opt")).toBeUndefined();
    expect(activeNotifs()).toHaveLength(1);
  });

  it("a device-wide reset leaf (CPU) clears every mount's alert together", async () => {
    // The fallback half: cpuPct reports at dimKey "", so no per-mount entry
    // exists and both rows read the asset-level truth.
    db.rules = [baseRule(STORAGE_TRIGGER, {
      mode: "condition",
      condition: { op: "and", children: [{ type: "asset_metric", metric: "cpuPct", operator: "<", threshold: 20, aggregation: "latest", windowSec: 0 }] },
    })];
    await assetTick({ a1: { "/var": 95, "/opt": 90 } }, { a1: 80 });
    expect(activeNotifs()).toHaveLength(2);

    await assetTick({ a1: { "/var": 95, "/opt": 90 } }, { a1: 5 });
    expect(dimState("a1", "/var")?.state).toBe("clear");
    expect(dimState("a1", "/opt")?.state).toBe("clear");
    expect(activeNotifs()).toHaveLength(0);
  });

  it("per-asset, not per-fleet: one device recovering leaves the other firing", async () => {
    db.assets = [mkAsset("a1"), mkAsset("a2")];
    db.rules = [baseRule(STORAGE_TRIGGER, {
      mode: "condition",
      condition: { op: "and", children: [{ type: "asset_metric", metric: "cpuPct", operator: "<", threshold: 20, aggregation: "latest", windowSec: 0 }] },
    })];
    await assetTick({ a1: { "/var": 95 }, a2: { "/var": 95 } }, { a1: 80, a2: 80 });
    expect(activeNotifs()).toHaveLength(2);

    await assetTick({ a1: { "/var": 95 }, a2: { "/var": 95 } }, { a1: 5, a2: 80 });
    expect(dimState("a1", "/var")?.state).toBe("clear");
    expect(dimState("a2", "/var")?.state).toBe("firing");
  });

  it("a suppressed asset stays frozen — maintenance is not recovery", async () => {
    db.rules = [baseRule(STORAGE_TRIGGER, {
      mode: "condition",
      condition: { op: "and", children: [{ type: "asset_metric", metric: "cpuPct", operator: "<", threshold: 20, aggregation: "latest", windowSec: 0 }] },
    })];
    await assetTick({ a1: { "/var": 95 } }, { a1: 80 });
    expect(dimState("a1", "/var")?.state).toBe("firing");

    db.assets = [mkAsset("a1", { status: "maintenance" })];
    await assetTick({ a1: { "/var": 95 } }, { a1: 5 }); // reset tree true, but silenced
    expect(dimState("a1", "/var")?.state).toBe("firing");
    expect(activeNotifs()).toHaveLength(1);
  });
});
