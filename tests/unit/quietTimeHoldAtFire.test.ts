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
  /** Live-fire source stamps (rule 92(f)): updateMany, never quietHeldAt. */
  liveStamps: [] as any[],
  deliveries: [] as any[],
  /** Rows already on the alert, for the all-clear's audience read (rule 120). */
  prior: [] as any[],
  events: [] as any[],
  channels: [] as any[],
  scriptRuns: [] as any[],
};
const holdAnswer = { value: null as any };
const holdQuestions: any[] = [];
const windowAnswer = { value: null as any };
const windowQuestions: any[] = [];

vi.mock("../../src/db.js", () => ({
  prisma: {
    notification: {
      findUnique: vi.fn(async () => db.notif),
      update: vi.fn(async (args: any) => { db.notifUpdates.push(args); return {}; }),
      updateMany: vi.fn(async (args: any) => { db.liveStamps.push(args); return { count: 1 }; }),
    },
    notificationDelivery: {
      createMany: vi.fn(async ({ data }: any) => { db.deliveries.push(...data); return { count: data.length }; }),
      create: vi.fn(async ({ data }: any) => { db.deliveries.push(data); return { id: "d", ...data }; }),
      findMany: vi.fn(async () => db.prior),
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
  resolveQuietWindow: vi.fn(async (q: any) => { windowQuestions.push(q); return windowAnswer.value; }),
}));

import { executeActions } from "../../src/services/automationActionService.js";

const CTX = { asset: "sw-core-1", value: "95", threshold: "90", severity: "warning", message: "hot", "trigger.summary": "CPU utilization is 95%" };
const NOTIFY = { type: "notify", channelId: "ch-email", addresses: ["oncall@example.com"] } as const;
const WINDOW_END = new Date(2026, 9, 3, 6, 0, 0, 0);
const HOLD = { source: { kind: "global", id: "g1", name: "Nights" }, config: { windows: [] }, windowEnd: WINDOW_END };

beforeEach(() => {
  db.notif = { ruleId: "r1", assetId: "a1", metric: "cpuPct", severity: "warning", testRun: false, quietHeldAt: null, quietSummarizedAt: null, quietSource: null };
  db.notifUpdates.length = 0;
  db.liveStamps.length = 0;
  windowAnswer.value = null;
  windowQuestions.length = 0;
  db.deliveries.length = 0;
  db.prior = [];
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

describe("a fire the open window lets through (business rule 92(f))", () => {
  const CRIT = { ...CTX, severity: "critical" };
  const NIGHTS = { kind: "global", id: "g1", name: "Nights" };

  it("goes out live and is stamped with the window's source — never as held", async () => {
    windowAnswer.value = NIGHTS;
    await executeActions("n1", [NOTIFY], CRIT, { ruleId: "r1" });
    expect(db.deliveries[0].status).toBeUndefined();
    expect(db.notifUpdates).toHaveLength(0);
    expect(db.liveStamps).toEqual([{ where: { id: "n1", quietHeldAt: null }, data: { quietSource: NIGHTS } }]);
    expect(windowQuestions[0]).toMatchObject({ ruleId: "r1", severity: "critical", metric: "cpuPct", assetId: "a1" });
    expect(db.events.map((e) => e.action)).not.toContain("notification.quiet_held");
  });

  it("stamps nothing when no window is open", async () => {
    await executeActions("n1", [NOTIFY], CRIT, { ruleId: "r1" });
    expect(windowQuestions).toHaveLength(1);
    expect(db.liveStamps).toHaveLength(0);
  });

  it("does not ask again for an alert already stamped (a grouped alert's growth update)", async () => {
    windowAnswer.value = NIGHTS;
    db.notif.quietSource = NIGHTS;
    await executeActions("n1", [NOTIFY], CRIT, { ruleId: "r1", growth: { count: 2 } });
    expect(windowQuestions).toHaveLength(0);
    expect(db.liveStamps).toHaveLength(0);
  });

  it("never stamps a test delivery, an all-clear, or the sweep's own passes", async () => {
    windowAnswer.value = NIGHTS;
    db.notif.testRun = true;
    await executeActions("n1", [NOTIFY], CRIT, { ruleId: "r1" });
    db.notif.testRun = false;
    await executeActions("n1", [NOTIFY], { ...CTX, severity: "resolved" }, { ruleId: "r1" });
    await executeActions("n1", [NOTIFY], CRIT, { ruleId: "r1", repeat: { attempt: 1 } });
    expect(windowQuestions).toHaveLength(0);
    expect(db.liveStamps).toHaveLength(0);
  });

  it("delivers as usual when the window lookup fails", async () => {
    const { resolveQuietWindow } = await import("../../src/services/quietTimeHoldService.js");
    vi.mocked(resolveQuietWindow).mockImplementationOnce(async () => { throw new Error("db down"); });
    await executeActions("n1", [NOTIFY], CRIT, { ruleId: "r1" });
    expect(db.deliveries).toHaveLength(1);
    expect(db.liveStamps).toHaveLength(0);
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

describe("recipient exceptions (business rule 120)", () => {
  const RESOLVED = { ...CTX, severity: "resolved" };
  const TWO = { ...NOTIFY, addresses: ["oncall@example.com", "noc@example.com"] } as const;
  // noc@ is excepted: held for nothing. Everyone else follows the policy.
  const SPLIT = { ...HOLD, split: true, isHeldFor: (a: string | null) => a !== "noc@example.com" };

  it("splits the To line: a live row for the excepted address, a held row for the rest", async () => {
    holdAnswer.value = SPLIT;
    await executeActions("n1", [TWO], CTX, { ruleId: "r1", ruleName: "cpu rule" });
    const email = db.deliveries.filter((d) => d.transport === "email");
    expect(email).toHaveLength(2);
    const live = email.find((d) => d.status === undefined);
    const held = email.find((d) => d.status === "held");
    expect(live.target).toBe("noc@example.com");
    expect(live.meta.quietHold).toBeUndefined();
    expect(held.target).toBe("oncall@example.com");
    expect(held.meta.quietHold).toEqual({ kind: "global", id: "g1", windowEnd: WINDOW_END.toISOString() });
    // Somebody was held, so the alert is stamped and the summary owes it.
    expect(db.notifUpdates).toHaveLength(1);
    const ev = db.events.find((e) => e.action === "notification.quiet_held");
    expect(ev.message).toContain("sent live to 1 excepted recipient copy");
    expect(ev.details).toMatchObject({ liveRows: 1, heldRows: 1 });
  });

  it("does not stamp an alert HELD when it reached every one of its readers live — only its source, for the summary's live list", async () => {
    holdAnswer.value = SPLIT;
    await executeActions("n1", [{ ...NOTIFY, addresses: ["noc@example.com"] }], CTX, { ruleId: "r1" });
    expect(db.deliveries).toHaveLength(1);
    expect(db.deliveries[0].status).toBeUndefined();
    expect(db.notifUpdates).toHaveLength(0);
    expect(db.events.map((e) => e.action)).not.toContain("notification.quiet_held");
    expect(db.liveStamps).toEqual([{ where: { id: "n1", quietHeldAt: null }, data: { quietSource: { kind: "global", id: "g1", name: "Nights" } } }]);
  });

  it("writes a split reminder's held side as DEFERRED — owed at the window's end", async () => {
    await executeActions("n1", [TWO], CTX, { ruleId: "r1", repeat: { attempt: 2 }, quietHold: SPLIT as any });
    const email = db.deliveries.filter((d) => d.transport === "email");
    expect(email.find((d) => d.target === "noc@example.com").status).toBeUndefined();
    const deferred = email.find((d) => d.target === "oncall@example.com");
    expect(deferred.status).toBe("deferred");
    expect(deferred.meta.repeat).toEqual({ attempt: 2 });
    expect(deferred.meta.quietHold.windowEnd).toBe(WINDOW_END.toISOString());
    // The sweep's pass never stamps the alert — only a fire does.
    expect(db.notifUpdates).toHaveLength(0);
  });

  it("sends the all-clear to the readers who were told, and skips the ones the fire was held for", async () => {
    db.notif.quietHeldAt = new Date();
    db.prior = [
      { transport: "email", target: "oncall@example.com", status: "held", meta: {} },
      { transport: "email", target: "noc@example.com", status: "sent", meta: {} },
    ];
    await executeActions("n1", [TWO], RESOLVED, { ruleId: "r1" });
    const email = db.deliveries.filter((d) => d.transport === "email");
    expect(email).toHaveLength(1);
    expect(email[0].target).toBe("noc@example.com");
    expect(email[0].status).toBeUndefined();
    expect(db.events.map((e) => e.action)).not.toContain("notification.quiet_allclear_dropped");
  });

  it("a reader the fire was held for but a released reminder reached gets the all-clear", async () => {
    db.notif.quietHeldAt = new Date();
    db.prior = [
      { transport: "email", target: "oncall@example.com, noc@example.com", status: "held", meta: {} },
      { transport: "email", target: "oncall@example.com", status: "sent", meta: { repeat: { attempt: 3 } } },
    ];
    await executeActions("n1", [TWO], RESOLVED, { ruleId: "r1" });
    const email = db.deliveries.filter((d) => d.transport === "email");
    expect(email).toHaveLength(1);
    expect(email[0].target).toBe("oncall@example.com");
  });

  it("still drops the all-clear whole when no row of the alert ever went out", async () => {
    db.notif.quietHeldAt = new Date();
    db.prior = [{ transport: "email", target: "oncall@example.com", status: "held", meta: {} }];
    await executeActions("n1", [TWO], RESOLVED, { ruleId: "r1" });
    expect(db.deliveries.filter((d) => d.transport === "email")).toHaveLength(0);
    expect(db.events.map((e) => e.action)).toContain("notification.quiet_allclear_dropped");
  });
});
