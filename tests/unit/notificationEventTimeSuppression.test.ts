/**
 * tests/unit/notificationEventTimeSuppression.test.ts — business rule 80a:
 * the event tail judges suppression as of WHEN THE EVENT HAPPENED, not as of
 * the tick that gets round to reading it.
 *
 * The leak this pins: `assetCanTrigger` reads the live Asset row, which is
 * correct for a threshold rule (a reading is current by definition) and wrong
 * for the event tail, which works off a backlog on a 60-second job. Any
 * maintenance window shorter than that interval opened and closed between two
 * ticks, so the gate only ever saw an asset that was plainly `active`.
 *
 * Business rule 80 walked straight into it. An agent upgrade holds the asset
 * in maintenance so the `agent.disconnected` the operator asked for does not
 * page anyone — and a real 0.19.0 → 0.20.0 upgrade takes TWO SECONDS:
 *
 *   10:30:47  maintenance.entered   ← window opens
 *   10:30:49  agent.disconnected    ← written INSIDE it
 *   10:30:49  maintenance.exited    ← released on reattach
 *
 * Every part of rule 80 worked and the operator was paged anyway, because the
 * window had been shut for most of a minute by the time the tail looked. The
 * first two tests here are that exact timeline.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const db = {
  rules: [] as any[],
  events: [] as any[],
  assets: [] as any[],
  created: [] as any[],
  windows: [] as any[],
  settings: new Map<string, any>(),
  windowQueries: [] as any[],
};

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationRule: { findMany: vi.fn(async () => db.rules) },
    event: { findMany: vi.fn(async () => db.events) },
    notification: {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(async ({ data }: any) => {
        db.created.push(...data);
        return { count: data.length };
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
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
      findMany: vi.fn(async (args: any) => {
        const ids = args?.where?.id?.in;
        return ids ? db.assets.filter((a) => ids.includes(a.id)) : [];
      }),
    },
    assetMaintenanceWindow: {
      findMany: vi.fn(async (args: any) => {
        db.windowQueries.push(args);
        const ids = args?.where?.assetId?.in;
        return ids ? db.windows.filter((w: any) => ids.includes(w.assetId)) : [];
      }),
    },
    notificationRuleState: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

import {
  evaluateAllNotificationRules,
  suppressedAtEventTime,
  type MaintenanceSpan,
} from "../../src/services/notificationEngine.js";

const NOW = Date.now();
const ASSET = "a-agent-host";

/** The seeded baseline automation that pages on an agent disconnect. */
function agentDisconnectRule() {
  return {
    id: "r-agent-disc",
    name: "Agent disconnected",
    description: null,
    enabled: true,
    severity: "warning",
    trigger: { type: "event", actionPattern: "agent.disconnected" },
    scope: {},
    reset: { mode: "event", resetEvent: { actionPattern: "agent.connected" } },
    actions: [],
    targets: [],
    clearBehavior: "event",
    clearAfterSec: null,
    cooldownSec: 0,
    messageTemplate: null,
    emailComposition: null,
    escalation: null,
    severityBands: null,
    bandNotify: null,
    channels: ["in_app"],
  };
}

function disconnectEvent(atMsAgo: number) {
  return {
    id: `e-disc-${atMsAgo}`,
    timestamp: new Date(NOW - atMsAgo),
    action: "agent.disconnected",
    resourceType: "asset",
    resourceId: ASSET,
    resourceName: "ulvcorpos2.example.test",
    level: "warning",
    message: "Polaris Agent WebSocket detached (socket closed: 1006)",
    details: null,
    actor: null,
  };
}

/** The asset as the engine finds it on a LATER tick: out of maintenance,
 *  monitored, entirely healthy — which is the whole problem. */
function healthyAsset() {
  return {
    id: ASSET,
    hostname: "ulvcorpos2.example.test",
    status: "active",
    monitored: true,
    dependencySuppressed: false,
    tags: [],
  };
}

beforeEach(() => {
  db.rules.length = 0;
  db.events.length = 0;
  db.assets.length = 0;
  db.created.length = 0;
  db.windows.length = 0;
  db.windowQueries.length = 0;
  db.settings.clear();
});

describe("business rule 80a — an agent upgrade's two-second window", () => {
  it("does NOT page when the disconnect happened inside a window that has since closed", async () => {
    db.rules.push(agentDisconnectRule());
    db.assets.push(healthyAsset());
    // The upgrade: window open 45s ago, shut 43s ago. The disconnect landed in
    // the middle of it. The tick reading this is happening NOW, long after.
    db.events.push(disconnectEvent(44_000));
    db.windows.push({
      assetId:   ASSET,
      startedAt: new Date(NOW - 45_000),
      endedAt:   new Date(NOW - 43_000),
    });

    await evaluateAllNotificationRules();

    expect(db.created).toHaveLength(0);
  });

  it("DOES page for a disconnect that happened after the window closed", async () => {
    db.rules.push(agentDisconnectRule());
    db.assets.push(healthyAsset());
    // Same upgrade, but the agent dropped again ten seconds after it finished.
    // That is a real outage and the operator has to hear about it.
    db.events.push(disconnectEvent(33_000));
    db.windows.push({
      assetId:   ASSET,
      startedAt: new Date(NOW - 45_000),
      endedAt:   new Date(NOW - 43_000),
    });

    await evaluateAllNotificationRules();

    expect(db.created).toHaveLength(1);
  });

  it("DOES page for a disconnect that happened before the window opened", async () => {
    db.rules.push(agentDisconnectRule());
    db.assets.push(healthyAsset());
    db.events.push(disconnectEvent(60_000));
    db.windows.push({
      assetId:   ASSET,
      startedAt: new Date(NOW - 45_000),
      endedAt:   new Date(NOW - 43_000),
    });

    await evaluateAllNotificationRules();

    expect(db.created).toHaveLength(1);
  });

  it("still pages when the asset was never in a window at all", async () => {
    db.rules.push(agentDisconnectRule());
    db.assets.push(healthyAsset());
    db.events.push(disconnectEvent(44_000));

    await evaluateAllNotificationRules();

    expect(db.created).toHaveLength(1);
  });

  it("asks for window history ONCE per tick, scoped to the batch's assets and span", async () => {
    db.rules.push(agentDisconnectRule());
    db.assets.push(healthyAsset());
    db.events.push(disconnectEvent(50_000), disconnectEvent(10_000));

    await evaluateAllNotificationRules();

    // One query, not one per event — at 2000 assets the per-event shape is
    // what makes a broad outage expensive.
    expect(db.windowQueries).toHaveLength(1);
    const where = db.windowQueries[0].where;
    expect(where.assetId.in).toEqual([ASSET]);
    // Bounded by the batch's own span: started no later than its newest event.
    expect(where.startedAt.lte.getTime()).toBe(NOW - 10_000);
  });
});

describe("suppressedAtEventTime — the boundaries", () => {
  const spans = (list: MaintenanceSpan[]) => new Map([[ASSET, list]]);
  const at = (ms: number) => new Date(ms);

  it("counts both ends as inside the window", () => {
    // A two-second window makes the boundary the common case, not an edge: the
    // disconnect and the window's close landed in the same second in the
    // report that prompted this.
    const s = spans([{ startedAt: at(1000), endedAt: at(3000) }]);
    expect(suppressedAtEventTime(s, ASSET, at(1000))).toBe(true);
    expect(suppressedAtEventTime(s, ASSET, at(2000))).toBe(true);
    expect(suppressedAtEventTime(s, ASSET, at(3000))).toBe(true);
    expect(suppressedAtEventTime(s, ASSET, at(999))).toBe(false);
    expect(suppressedAtEventTime(s, ASSET, at(3001))).toBe(false);
  });

  it("treats an open window as running to now and beyond", () => {
    const s = spans([{ startedAt: at(1000), endedAt: null }]);
    expect(suppressedAtEventTime(s, ASSET, at(999))).toBe(false);
    expect(suppressedAtEventTime(s, ASSET, at(1000))).toBe(true);
    // Year 3000, not Number.MAX_SAFE_INTEGER — that overflows the Date range
    // and getTime() comes back NaN, which compares false against everything
    // and would have made this assertion pass for the wrong reason.
    expect(suppressedAtEventTime(s, ASSET, new Date("3000-01-01T00:00:00Z"))).toBe(true);
  });

  it("matches any of several windows in the batch's span", () => {
    const s = spans([
      { startedAt: at(1000), endedAt: at(2000) },
      { startedAt: at(5000), endedAt: at(6000) },
    ]);
    expect(suppressedAtEventTime(s, ASSET, at(1500))).toBe(true);
    expect(suppressedAtEventTime(s, ASSET, at(3500))).toBe(false); // the gap
    expect(suppressedAtEventTime(s, ASSET, at(5500))).toBe(true);
  });

  it("never suppresses an event that names no asset", () => {
    // A system-scoped event — capacity, backups, an update — has no device and
    // cannot be in anyone's maintenance window.
    const s = spans([{ startedAt: at(0), endedAt: null }]);
    expect(suppressedAtEventTime(s, null, at(1000))).toBe(false);
  });

  it("never suppresses an asset with no windows loaded", () => {
    expect(suppressedAtEventTime(new Map(), ASSET, at(1000))).toBe(false);
    expect(suppressedAtEventTime(spans([]), ASSET, at(1000))).toBe(false);
  });
});
