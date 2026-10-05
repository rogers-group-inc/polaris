/**
 * tests/unit/quietTimeHoldAtFire.test.ts
 *
 * The fire-time half of quiet time (business rule 92), as `executeActions`
 * applies it: a fire inside a window writes HELD delivery rows and stamps the
 * alert; scripts and API calls still run; a test delivery is never held; the
 * all-clear for a held, un-summarised alert sends nothing to people; and the
 * sweep's own calls (tiers / reminders) are left to the sweep's gate. Plus
 * `expandDeliveries`' side of the contract — a held row is `status: "held"`
 * and carries the hold in its meta, and an unheld row is byte-identical to
 * before.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  notif: null as any,
  notifUpdates: [] as any[],
  deliveries: [] as any[],
  events: [] as any[],
  channels: [] as any[],
  scriptRuns: [] as any[],
};
const holdAnswer = { value: null as any };
const holdQuestions: any[] = [];

vi.mock("../../src/db.js", () => ({
  prisma: {
    notification: {
      findUnique: vi.fn(async () => db.notif),
      update: vi.fn(async (args: any) => { db.notifUpdates.push(args); return {}; }),
    },
    notificationDelivery: {
      createMany: vi.fn(async ({ data }: any) => { db.deliveries.push(...data); return { count: data.length }; }),
      create: vi.fn(async ({ data }: any) => { db.deliveries.push(data); return { id: "d", ...data }; }),
    },
    notificationChannel: {
      findMany: vi.fn(async ({ where }: any) => db.channels.filter((c) => where.id.in.includes(c.id))),
    },
    user: { findMany: vi.fn(async () => []) },
    pushSubscription: { findMany: vi.fn(async () => []) },
    setting: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: vi.fn(async (e: any) => { db.events.push(e); }),
}));
vi.mock("../../src/services/automationScriptService.js", () => ({
  requestScriptRun: vi.fn(async (args: any) => { db.scriptRuns.push(args); return { id: "run-1" }; }),
}));
vi.mock("../../src/services/quietTimeHoldService.js", () => ({
  resolveQuietHold: vi.fn(async (q: any) => { holdQuestions.push(q); return holdAnswer.value; }),
}));

import { executeActions } from "../../src/services/automationActionService.js";

const CTX = { asset: "sw-core-1", value: "95", threshold: "90", severity: "warning", message: "hot", "trigger.summary": "CPU utilization is 95%" };
const NOTIFY = { type: "notify", channelId: "ch-email", addresses: ["oncall@example.com"] } as const;
const WINDOW_END = new Date(2026, 9, 3, 6, 0, 0, 0);
const HOLD = { source: { kind: "global", id: "g1", name: "Nights" }, config: { windows: [] }, windowEnd: WINDOW_END };

beforeEach(() => {
  db.notif = { ruleId: "r1", assetId: "a1", metric: "cpuPct", severity: "warning", testRun: false, quietHeldAt: null, quietSummarizedAt: null };
  db.notifUpdates.length = 0;
  db.deliveries.length = 0;
  db.events.length = 0;
  db.scriptRuns.length = 0;
  db.channels = [{ id: "ch-email", type: "smtp", enabled: true }];
  holdAnswer.value = null;
  holdQuestions.length = 0;
});

describe("executeActions inside a quiet window", () => {
  it("writes HELD delivery rows, stamps the alert once, and audits the hold", async () => {
    holdAnswer.value = HOLD;
    const r = await executeActions("n1", [NOTIFY], CTX, { ruleId: "r1", ruleName: "cpu rule", assetId: "a1" });

    expect(r.executed).toBe(1);
    expect(db.deliveries).toHaveLength(1);
    expect(db.deliveries[0].status).toBe("held");
    expect(db.deliveries[0].meta.quietHold).toEqual({ kind: "global", id: "g1", windowEnd: WINDOW_END.toISOString() });
    // The recipients were resolved exactly as for a real send.
    expect(db.deliveries[0].target).toBe("oncall@example.com");
    expect(db.deliveries[0].meta.composed).toBe(true);

    expect(db.notifUpdates).toHaveLength(1);
    // The NAME rides along so a summary for a since-deleted schedule can still say who held the alert.
    expect(db.notifUpdates[0].data.quietSource).toEqual({ kind: "global", id: "g1", name: "Nights" });
    expect(db.notifUpdates[0].data.quietHeldAt).toBeInstanceOf(Date);
    const held = db.events.filter((e) => e.action === "notification.quiet_held");
    expect(held).toHaveLength(1);
    expect(held[0].message).toContain('global quiet time "Nights"');
    expect(held[0].details.windowEnd).toBe("2026-10-03T06:00");
    // The question named the alert's kind and device, not just its rule.
    expect(holdQuestions[0]).toMatchObject({ ruleId: "r1", severity: "warning", metric: "cpuPct", assetId: "a1" });
  });

  it("does not re-stamp an alert that is already held (a grouped alert's growth update)", async () => {
    holdAnswer.value = HOLD;
    db.notif.quietHeldAt = new Date();
    await executeActions("n1", [NOTIFY], CTX, { ruleId: "r1", growth: { count: 2 } });
    expect(db.deliveries[0].status).toBe("held");
    expect(db.notifUpdates).toHaveLength(0);
    expect(db.events.filter((e) => e.action === "notification.quiet_held")).toHaveLength(0);
  });

  it("still runs scripts and API calls — only people-facing sends are held", async () => {
    holdAnswer.value = HOLD;
    await executeActions("n1", [
      NOTIFY,
      { type: "script", scriptId: "s1", runOn: "server" } as any,
      { type: "api_call", method: "POST", url: "https://hooks.example.com/x" } as any,
    ], CTX, { ruleId: "r1" });
    expect(db.scriptRuns).toHaveLength(1);
    const apiRow = db.deliveries.find((d) => d.transport === "api_call");
    expect(apiRow).toBeDefined();
    expect(apiRow.status).toBeUndefined(); // pending by default — it goes out
    expect(db.deliveries.find((d) => d.transport === "email").status).toBe("held");
  });

  it("never holds or stamps a fire with no notify action — nothing people-facing to withhold, so nothing for a summary to report", async () => {
    holdAnswer.value = HOLD;
    await executeActions("n1", [
      { type: "event" } as any,
      { type: "script", scriptId: "s1", runOn: "server" } as any,
    ], CTX, { ruleId: "r1" });
    expect(holdQuestions).toHaveLength(0);
    expect(db.notifUpdates).toHaveLength(0);
    expect(db.events.map((e) => e.action)).not.toContain("notification.quiet_held");
    expect(db.scriptRuns).toHaveLength(1);
  });

  it("writes an ordinary pending row when nothing is quiet", async () => {
    await executeActions("n1", [NOTIFY], CTX, { ruleId: "r1" });
    expect(db.deliveries[0].status).toBeUndefined();
    expect(db.deliveries[0].meta.quietHold).toBeUndefined();
    expect(db.notifUpdates).toHaveLength(0);
  });

  it("never holds a test delivery", async () => {
    holdAnswer.value = HOLD;
    db.notif.testRun = true;
    await executeActions("n1", [NOTIFY], CTX, { ruleId: "r1" });
    expect(holdQuestions).toHaveLength(0);
    expect(db.deliveries[0].status).toBeUndefined();
  });

  it("leaves the sweep's tiers and reminders to the sweep's own gate", async () => {
    holdAnswer.value = HOLD;
    await executeActions("n1", [NOTIFY], CTX, { ruleId: "r1", escalation: { tier: 1, attempt: 1 } });
    await executeActions("n1", [NOTIFY], CTX, { ruleId: "r1", repeat: { attempt: 1 } });
    expect(holdQuestions).toHaveLength(0);
    expect(db.deliveries.every((d) => d.status === undefined)).toBe(true);
  });
});

describe("the all-clear of a held alert", () => {
  const RESOLVED = { ...CTX, severity: "resolved" };

  it("sends nothing to people while the alert is held and un-summarised, and says so", async () => {
    db.notif.quietHeldAt = new Date();
    const r = await executeActions("n1", [NOTIFY, { type: "api_call", method: "POST", url: "https://hooks.example.com/x" } as any], RESOLVED, { ruleId: "r1", ruleName: "cpu rule" });
    expect(db.deliveries.filter((d) => d.transport === "email")).toHaveLength(0);
    expect(db.deliveries.filter((d) => d.transport === "api_call")).toHaveLength(1);
    expect(r.executed).toBe(1);
    expect(db.events.map((e) => e.action)).toContain("notification.quiet_allclear_dropped");
    // No hold question for an all-clear: it is dropped or sent, never held.
    expect(holdQuestions).toHaveLength(0);
  });

  it("sends the all-clear once a summary has named the alert", async () => {
    db.notif.quietHeldAt = new Date(Date.now() - 3_600_000);
    db.notif.quietSummarizedAt = new Date();
    await executeActions("n1", [NOTIFY], RESOLVED, { ruleId: "r1" });
    expect(db.deliveries).toHaveLength(1);
    expect(db.deliveries[0].status).toBeUndefined();
    expect(db.events.map((e) => e.action)).not.toContain("notification.quiet_allclear_dropped");
  });

  it("sends the all-clear of an alert that was never held", async () => {
    await executeActions("n1", [NOTIFY], RESOLVED, { ruleId: "r1" });
    expect(db.deliveries).toHaveLength(1);
  });
});
