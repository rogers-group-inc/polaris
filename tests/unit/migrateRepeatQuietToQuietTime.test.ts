/**
 * tests/unit/migrateRepeatQuietToQuietTime.test.ts
 *
 * The one-shot that promotes per-action reminder quiet windows (rule 44) into
 * the automation's own quiet time (rule 92). The planner is pure and is what
 * these cases pin: the three places a `repeat` lives, the dedupe across them,
 * the cap, and the rule that an existing `quietTime` is never overwritten.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  rules: [] as any[],
  updates: [] as any[],
  settings: new Map<string, unknown>(),
  events: [] as any[],
};

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationRule: {
      findMany: vi.fn(async () => db.rules),
      update: vi.fn(async (args: any) => { db.updates.push(args); return {}; }),
    },
    setting: {
      findUnique: vi.fn(async ({ where }: any) => (db.settings.has(where.key) ? { key: where.key } : null)),
      upsert: vi.fn(async ({ where, create }: any) => { db.settings.set(where.key, create.value); return {}; }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: vi.fn(async (e: any) => { db.events.push(e); }),
}));
vi.mock("../../src/jobs/_metrics.js", () => ({ runInstrumentedJob: vi.fn(async () => {}) }));

import { planPromotion, migrateRepeatQuietToQuietTime, PROMOTED_KEY } from "../../src/jobs/migrateRepeatQuietToQuietTime.js";

const NIGHTLY = { version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "22:00", endTime: "06:00" }] };
const WEEKEND = { version: 1, kind: "recurring", freq: "weekly", daysOfWeek: [0, 6] };
const notify = (repeat?: unknown) => ({ type: "notify", channelId: "ch", recipientUserIds: ["u"], ...(repeat !== undefined ? { repeat } : {}) });

beforeEach(() => {
  db.rules = [];
  db.updates = [];
  db.settings.clear();
  db.events = [];
});

describe("planPromotion", () => {
  it("does nothing for a rule with no quiet anywhere", () => {
    const p = planPromotion({ repeat: { everyMin: 15, stopOn: "acknowledge" }, actions: [notify()], severityBands: null, quietTime: null });
    expect(p.noop).toBe(true);
  });

  it("collects windows from the rule-level repeat, the actions and the bands, deduplicated", () => {
    const p = planPromotion({
      repeat: { everyMin: 15, stopOn: "acknowledge", quiet: { windows: [NIGHTLY] } },
      actions: [notify({ everyMin: 30, stopOn: "clear", quiet: { windows: [NIGHTLY, WEEKEND] } }), notify()],
      severityBands: [{ threshold: 90, severity: "critical", actions: [notify({ everyMin: 5, stopOn: "acknowledge", quiet: { windows: [WEEKEND] } })] }],
      quietTime: null,
    });
    expect(p.noop).toBe(false);
    expect(p.windowsFound).toBe(2);
    expect(p.quietTime?.windows).toEqual([NIGHTLY, WEEKEND]);
    // Promoted as "pause the chasing", never as "hold the first alert": that
    // is the operator's click to make.
    expect(p.quietTime?.holds).toBe("followUps");
    // Every `quiet` key is gone; the rest of each repeat survives.
    expect(p.repeat).toEqual({ everyMin: 15, stopOn: "acknowledge" });
    expect((p.actions as any[])[0].repeat).toEqual({ everyMin: 30, stopOn: "clear" });
    expect((p.actions as any[])[1]).toEqual(notify());
    expect((p.severityBands as any[])[0].actions[0].repeat).toEqual({ everyMin: 5, stopOn: "acknowledge" });
  });

  it("strips the stale keys but keeps an existing quietTime", () => {
    const existing = { windows: [WEEKEND], severities: ["serious"] };
    const p = planPromotion({
      repeat: { everyMin: 15, stopOn: "acknowledge", quiet: { windows: [NIGHTLY] } },
      actions: [],
      severityBands: null,
      quietTime: existing,
    });
    expect(p.noop).toBe(false);
    expect(p.quietTime).toBeUndefined();
    expect(p.repeat).toEqual({ everyMin: 15, stopOn: "acknowledge" });
  });

  it("caps at the window limit and drops a malformed set rather than promoting it", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...NIGHTLY, hours: [{ startTime: `${String(i).padStart(2, "0")}:00`, endTime: `${String(i).padStart(2, "0")}:30` }] }));
    const p = planPromotion({ repeat: { everyMin: 15, stopOn: "acknowledge", quiet: { windows: many } }, actions: [], severityBands: null, quietTime: null });
    expect(p.windowsFound).toBe(10);
    expect(p.quietTime?.windows).toHaveLength(8);
    const bad = planPromotion({ repeat: { everyMin: 15, stopOn: "acknowledge", quiet: { windows: [{ nonsense: true }] } }, actions: [], severityBands: null, quietTime: null });
    expect(bad.quietTime).toBeUndefined();
    expect(bad.repeat).toEqual({ everyMin: 15, stopOn: "acknowledge" });
  });
});

describe("migrateRepeatQuietToQuietTime", () => {
  it("writes one update + one warning Event per converted automation, then stamps the marker", async () => {
    db.rules = [
      { id: "r1", name: "Nightly", repeat: { everyMin: 15, stopOn: "acknowledge", quiet: { windows: [NIGHTLY] } }, actions: [], severityBands: null, quietTime: null },
      { id: "r2", name: "Plain", repeat: null, actions: [notify()], severityBands: null, quietTime: null },
    ];
    await migrateRepeatQuietToQuietTime();
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].where).toEqual({ id: "r1" });
    expect(db.updates[0].data.quietTime.windows).toEqual([NIGHTLY]);
    expect(db.events.map((e) => e.action)).toEqual(["automation.quiet_time_migrated"]);
    expect(db.events[0].level).toBe("warning");
    expect(db.settings.has(PROMOTED_KEY)).toBe(true);
  });

  it("is a no-op once the marker exists", async () => {
    db.settings.set(PROMOTED_KEY, { ranAt: "x" });
    db.rules = [{ id: "r1", name: "Nightly", repeat: { everyMin: 15, stopOn: "acknowledge", quiet: { windows: [NIGHTLY] } }, actions: [], severityBands: null, quietTime: null }];
    await migrateRepeatQuietToQuietTime();
    expect(db.updates).toHaveLength(0);
  });
});
