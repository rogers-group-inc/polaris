/**
 * tests/unit/notificationResetActions.test.ts
 *
 * Actions that run when an alert ENDS.
 *
 * Every clear path used to write cleared/clearedBy/clearedAt and nothing else,
 * so "tell the NOC it came back" was not expressible — only severity-band
 * rules had anything like it (bandNotify.resolvedActions). The load-bearing
 * detail is ORDERING: reset actions must run while the notification id is
 * still live, or their delivery rows have nothing to hang off.
 *
 * Drives the engine end-to-end through a host_metric rule against an in-memory
 * fake prisma, mirroring notificationEngineHysteresis.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

/** Every executeActions call, with the alert's cleared state AT CALL TIME. */
const executed: Array<{ notificationId: string; actions: any[]; message: string; clearedWhenCalled: boolean }> = [];

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
          id: `st${++seq}`, conditionMetSince: null, recoveredSince: null, firedAt: null,
          lastValue: null, notificationId: null, ...create,
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
      findMany: async ({ where }: any) =>
        db.notifications.filter((n) => n.ruleId === where.ruleId && !n.cleared),
      // The all-clear reads the alert it is closing (allClearView).
      findUnique: async ({ where }: any) => db.notifications.find((n) => n.id === where.id) ?? null,
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const n of db.notifications) {
          const idMatch = where.id ? n.id === where.id : n.ruleId === where.ruleId;
          if (idMatch && n.cleared === where.cleared) { Object.assign(n, data); count++; }
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
  expandDeliveries: vi.fn(async () => 1),
  scopeRegionTagsOf: () => [],
  listRecipientUsers: vi.fn(async () => []),
  buildComposedEmail: () => ({ subject: "s", text: "t" }),
}));
vi.mock("../../src/services/automationActionService.js", () => ({
  executeActions: vi.fn(async (notificationId: string, actions: any[], ctx: Record<string, string>) => {
    const n = db.notifications.find((x) => x.id === notificationId);
    executed.push({ notificationId, actions, message: ctx.message ?? "", clearedWhenCalled: !!n?.cleared });
    return { executed: actions.length, failed: 0 };
  }),
}));

import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";
import type { ResetConfig } from "../../src/services/notificationTypes.js";

const T0 = new Date("2026-08-12T12:00:00Z");
const RESET_NOTIFY = [{ type: "notify", channelId: "ch-noc" }];

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
    actions: [{ type: "notify", channelId: "ch-noc" }],
    ...extra,
  };
}

async function tick(value: number) {
  db.hostSamples = [{ cpuPct: value }];
  await evaluateAllNotificationRules();
}

const resetRuns = () => executed.filter((e) => e.message.startsWith("Resolved:"));

beforeEach(() => {
  db.rules = [];
  db.hostSamples = [];
  db.states = [];
  db.notifications = [];
  executed.length = 0;
  seq = 0;
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("reset actions", () => {
  it("run when the condition recovers, and say the device recovered", async () => {
    db.rules = [hostRule({ mode: "auto" }, { resetActions: RESET_NOTIFY })];
    await tick(95);
    expect(resetRuns()).toHaveLength(0); // firing, not resolved

    await tick(10);
    expect(resetRuns()).toHaveLength(1);
    expect(resetRuns()[0]!.message).toContain("recovered");
    expect(resetRuns()[0]!.actions).toEqual(RESET_NOTIFY);
  });

  it("run BEFORE the alert is cleared, so their deliveries have an alert to attach to", async () => {
    db.rules = [hostRule({ mode: "auto" }, { resetActions: RESET_NOTIFY })];
    await tick(95);
    const alertId = db.notifications[0]!.id;
    await tick(10);

    const run = resetRuns()[0]!;
    expect(run.notificationId).toBe(alertId);
    // The whole point: a cleared-first ordering would leave every reset
    // delivery (and its acknowledge token) pointing at a closed alert.
    expect(run.clearedWhenCalled).toBe(false);
    expect(db.notifications[0]!.cleared).toBe(true); // …but it IS cleared after
  });

  it("stay silent for an automation that defines none — every stored rule keeps its behaviour", async () => {
    db.rules = [hostRule({ mode: "auto" })]; // no resetActions
    await tick(95);
    await tick(10);
    expect(resetRuns()).toHaveLength(0);
    expect(db.notifications[0]!.cleared).toBe(true);
  });

  it("wait for the clear-sustain window rather than firing on the first good reading", async () => {
    db.rules = [hostRule({ mode: "auto", sustainSec: 120 }, { resetActions: RESET_NOTIFY })];
    await tick(95);
    await tick(10);
    expect(resetRuns()).toHaveLength(0); // recovery observed, not sustained

    vi.setSystemTime(new Date(T0.getTime() + 121_000));
    await tick(10);
    expect(resetRuns()).toHaveLength(1);
  });

  it("do NOT run while the value sits in the hysteresis dead band", async () => {
    // Below the fire line but above the clear line: the alert is deliberately
    // still firing, so it has not ended.
    db.rules = [hostRule({ mode: "auto", clearThreshold: 70 }, { resetActions: RESET_NOTIFY })];
    await tick(95);
    await tick(80);
    expect(resetRuns()).toHaveLength(0);
    expect(db.notifications[0]!.cleared).toBe(false);

    await tick(60); // crosses the clear line
    expect(resetRuns()).toHaveLength(1);
  });

  it("run on a timed reset, naming the timeout rather than a recovery", async () => {
    db.rules = [hostRule({ mode: "timed", afterSec: 300 }, { resetActions: RESET_NOTIFY })];
    await tick(95);
    expect(resetRuns()).toHaveLength(0);

    vi.setSystemTime(new Date(T0.getTime() + 301_000));
    await tick(95); // still bad — the TIMER is what ends this alert
    expect(resetRuns()).toHaveLength(1);
    expect(resetRuns()[0]!.message).toContain("timed out");
    expect(resetRuns()[0]!.clearedWhenCalled).toBe(false);
  });

  it("do not run on a manual reset — the alert is still standing, waiting for a human", async () => {
    db.rules = [hostRule({ mode: "manual" }, { resetActions: RESET_NOTIFY })];
    await tick(95);
    await tick(10);
    expect(resetRuns()).toHaveLength(0);
    expect(db.notifications[0]!.cleared).toBe(false);
  });

  it("re-fire on the NEXT cycle — a recovery per alert, not once per rule", async () => {
    db.rules = [hostRule({ mode: "auto" }, { resetActions: RESET_NOTIFY })];
    await tick(95);
    await tick(10);
    await tick(95);
    await tick(10);
    expect(resetRuns()).toHaveLength(2);
  });
});
