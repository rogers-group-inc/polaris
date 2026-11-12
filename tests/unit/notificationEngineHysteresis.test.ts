/**
 * tests/unit/notificationEngineHysteresis.test.ts — B3 engine semantics:
 * hysteresis (reset.clearThreshold) + clear-sustain (reset.sustainSec) on the
 * firing state machine, plus the recoveredMeets pure helper.
 *
 * Drives evaluateAllNotificationRules() end-to-end through a host_metric rule
 * (single reading, no asset scope) against an in-memory fake prisma, with fake
 * timers so sustain windows can elapse deterministically.
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
    hostMetricsSample: { findMany: async () => db.hostSamples },
    notificationRuleState: {
      findMany: async ({ where }: any) => db.states.filter((s) => s.ruleId === where.ruleId),
      findUnique: async ({ where }: any) => findState(where),
      update: async ({ where, data }: any) => {
        const s = db.states.find((x) => x.id === where.id);
        if (s) Object.assign(s, data);
        return s;
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
        for (const n of db.notifications) {
          if (n.id === where.id && n.cleared === where.cleared) Object.assign(n, data);
        }
        return { count: 1 };
      },
    },
    setting: { findUnique: async () => null, upsert: async () => ({}) },
    event: { findMany: async () => [] },
  },
}));

vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
beforeEach(() => resetEventLogStub());
vi.mock("../../src/services/notificationRecipientService.js", () => ({
  expandDeliveries: vi.fn(async () => {}),
  scopeRegionTagsOf: () => [],
  listRecipientUsers: vi.fn(async () => []),
}));

import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";
import { recoveredMeets } from "../../src/services/notifications/readings.js";
import type { ResetConfig, Trigger } from "../../src/services/notificationTypes.js";

const T0 = new Date("2026-07-21T12:00:00Z");

function hostRule(reset: ResetConfig, extra: Record<string, unknown> = {}) {
  return {
    id: "r1",
    name: "cpu",
    description: null,
    severity: "warning",
    trigger: { type: "host_metric", metric: "cpuPct", operator: ">=", threshold: 90, aggregation: "latest", windowSec: 0, forDurationSec: 0 },
    scope: {},
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

/** One engine tick with the host CPU at `value`. */
async function tick(value: number) {
  db.hostSamples = [{ cpuPct: value }];
  await evaluateAllNotificationRules();
}

const theState = () => db.states[0];
const activeNotifs = () => db.notifications.filter((n) => !n.cleared);

beforeEach(() => {
  db.rules = [];
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

describe("recoveredMeets", () => {
  const trig = { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 } as unknown as Trigger;

  it("without a clearThreshold recovery is !meets (legacy)", () => {
    const reset: ResetConfig = { mode: "auto" };
    expect(recoveredMeets(trig, reset, 95)).toBe(false);
    expect(recoveredMeets(trig, reset, 89)).toBe(true);
    expect(recoveredMeets(trig, reset, null)).toBe(true);
  });

  it("with a clearThreshold recovery requires crossing IT, leaving a dead band", () => {
    const reset: ResetConfig = { mode: "auto", clearThreshold: 80 };
    expect(recoveredMeets(trig, reset, 95)).toBe(false); // still meets
    expect(recoveredMeets(trig, reset, 85)).toBe(false); // dead band
    expect(recoveredMeets(trig, reset, 79)).toBe(true);  // crossed the clear line
    expect(recoveredMeets(trig, reset, 80)).toBe(false); // >= 80 still not recovered (op >=)
    expect(recoveredMeets(trig, reset, null)).toBe(true); // absent reading = recovered (legacy parity)
  });

  it("inverted operators mirror the band", () => {
    const low = { type: "asset_metric", metric: "cpuPct", operator: "<=", threshold: 10 } as unknown as Trigger;
    const reset: ResetConfig = { mode: "auto", clearThreshold: 20 };
    expect(recoveredMeets(low, reset, 5)).toBe(false);  // meets
    expect(recoveredMeets(low, reset, 15)).toBe(false); // dead band
    expect(recoveredMeets(low, reset, 25)).toBe(true);  // recovered above clear line
  });

  it("non-auto modes ignore hysteresis fields", () => {
    expect(recoveredMeets(trig, { mode: "manual" }, 85)).toBe(true); // !meets
    expect(recoveredMeets(trig, { mode: "timed", afterSec: 60 }, 85)).toBe(true);
  });
});

describe("firing state machine — hysteresis dead band", () => {
  it("fire → dead band stays firing → crossing the clear threshold clears", async () => {
    db.rules = [hostRule({ mode: "auto", clearThreshold: 80 })];

    await tick(95);
    expect(theState().state).toBe("firing");
    expect(activeNotifs()).toHaveLength(1);

    await tick(85); // below fire threshold, above clear threshold
    expect(theState().state).toBe("firing"); // dead band — no flap
    expect(activeNotifs()).toHaveLength(1);

    await tick(79);
    expect(theState().state).toBe("clear");
    expect(activeNotifs()).toHaveLength(0);
    expect(db.notifications[0].clearedBy).toBe("system:auto-resolve");
  });

  it("legacy auto (no clearThreshold) still clears at the fire threshold", async () => {
    db.rules = [hostRule({ mode: "auto" })];
    await tick(95);
    expect(theState().state).toBe("firing");
    await tick(89);
    expect(theState().state).toBe("clear");
  });
});

describe("firing state machine — clear-sustain", () => {
  it("recovery must hold sustainSec before clearing; re-meet resets the timer", async () => {
    db.rules = [hostRule({ mode: "auto", clearThreshold: 80, sustainSec: 120 })];

    await tick(95);
    expect(theState().state).toBe("firing");

    await tick(75); // recovered — sustain timer starts
    expect(theState().state).toBe("firing");
    expect(theState().recoveredSince).toEqual(T0);

    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    await tick(95); // re-met mid-sustain — timer cancels, stays firing
    expect(theState().state).toBe("firing");
    expect(theState().recoveredSince).toBeNull();

    vi.setSystemTime(new Date(T0.getTime() + 120_000));
    await tick(75); // recovered again — fresh timer
    expect(theState().recoveredSince).toEqual(new Date(T0.getTime() + 120_000));
    expect(theState().state).toBe("firing");

    vi.setSystemTime(new Date(T0.getTime() + 180_000));
    await tick(75); // 60s elapsed < 120s — still firing
    expect(theState().state).toBe("firing");

    vi.setSystemTime(new Date(T0.getTime() + 241_000));
    await tick(75); // 121s elapsed ≥ 120s — clears
    expect(theState().state).toBe("clear");
    expect(theState().recoveredSince).toBeNull();
    expect(activeNotifs()).toHaveLength(0);
  });

  it("dead-band reading cancels a running sustain timer", async () => {
    db.rules = [hostRule({ mode: "auto", clearThreshold: 80, sustainSec: 120 })];
    await tick(95);
    await tick(75);
    expect(theState().recoveredSince).not.toBeNull();
    await tick(85); // back into the dead band — recovery evidence is gone
    expect(theState().state).toBe("firing");
    expect(theState().recoveredSince).toBeNull();
  });

  it("sustainSec 0 clears on the first recovered reading", async () => {
    db.rules = [hostRule({ mode: "auto", clearThreshold: 80, sustainSec: 0 })];
    await tick(95);
    await tick(75);
    expect(theState().state).toBe("clear");
  });
});

describe("firing state machine — non-auto modes unchanged", () => {
  it("manual re-arms the state on recovery but leaves the notification", async () => {
    db.rules = [hostRule({ mode: "manual" })];
    await tick(95);
    expect(theState().state).toBe("firing");
    await tick(50);
    expect(theState().state).toBe("clear");
    expect(activeNotifs()).toHaveLength(1); // stays for a human
  });

  it("timed clears by the sweep after afterSec even while the condition still meets", async () => {
    db.rules = [hostRule({ mode: "timed", afterSec: 60 })];
    await tick(95);
    expect(theState().state).toBe("firing");
    vi.setSystemTime(new Date(T0.getTime() + 61_000));
    await tick(95); // condition still met; timer sweep clears anyway
    expect(theState().state).toBe("clear");
    expect(activeNotifs()).toHaveLength(0);
    expect(db.notifications[0].clearedBy).toBe("system:timed");
  });

  it("cooldown still suppresses an immediate re-fire after auto-clear", async () => {
    db.rules = [hostRule({ mode: "auto" }, { cooldownSec: 600 })];
    await tick(95);
    await tick(50); // auto-clears
    expect(db.notifications).toHaveLength(1);
    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    await tick(95); // within cooldown — no second notification
    expect(db.notifications).toHaveLength(1);
    vi.setSystemTime(new Date(T0.getTime() + 601_000));
    await tick(95); // cooldown elapsed — fires again
    expect(db.notifications).toHaveLength(2);
  });
});

describe("firing state machine — band descent hold (business rule 19(a))", () => {
  // The incident shape: base 90 / band 95, auto reset with a clear line, a
  // hold on the trigger. A value idling at the band's line must not cycle the
  // alert between bands (each climb back re-ran the band's notify actions).
  const banded = () => hostRule(
    { mode: "auto", clearThreshold: 75 },
    {
      trigger: { type: "host_metric", metric: "cpuPct", operator: ">", threshold: 90, aggregation: "latest", windowSec: 0, forDurationSec: 120 },
      severityBands: [{ threshold: 95, severity: "serious", actions: [] }],
    },
  );
  const step = async (value: number, sec = 60) => {
    vi.setSystemTime(new Date(Date.now() + sec * 1000));
    await tick(value);
  };

  it("a dip under the band and back holds the band — no de-escalation, no re-escalation", async () => {
    db.rules = [banded()];
    await tick(96);
    await step(96, 120);
    expect(theState().state).toBe("firing");
    expect(theState()).toMatchObject({ firingSeverity: "serious" });
    eventLog.logEvent.mockClear();

    await step(94); // under the band for one reading
    expect(theState()).toMatchObject({ firingSeverity: "serious" });
    await step(96); // back over it
    await step(96);
    expect(theState()).toMatchObject({ firingSeverity: "serious" });
    expect(activeNotifs()).toHaveLength(1);
    const moves = eventLog.logEvent.mock.calls.filter(([e]: any) => /escalated$/.test(e.action));
    expect(moves).toHaveLength(0);
  });

  it("eases once the value has stayed out of the band for the band's hold", async () => {
    db.rules = [banded()];
    await tick(96);
    await step(96, 120);
    await step(93);  // descent timer starts
    await step(93);  // 60s out
    expect(theState()).toMatchObject({ firingSeverity: "serious" });
    await step(93);  // 120s out — the band's hold
    expect(theState()).toMatchObject({ firingSeverity: "warning" });
    expect(activeNotifs()[0].severity).toBe("warning");
  });

  it("dead-band easing waits out the hold too, and the clear line still clears", async () => {
    db.rules = [banded()];
    await tick(96);
    await step(96, 120);
    await step(85);  // dead band
    expect(theState()).toMatchObject({ state: "firing", firingSeverity: "serious" });
    await step(85, 120);
    expect(theState()).toMatchObject({ state: "firing", firingSeverity: "warning" });
    await step(70);
    expect(theState().state).toBe("clear");
  });
});
