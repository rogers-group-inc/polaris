/**
 * tests/unit/quietTimeRecipientExceptions.test.ts — quiet-time recipient
 * exceptions (business rule 120).
 *
 * Two halves. The POLICY: `recipients` on the quiet-time config, an address
 * with its own per-severity held map — empty = it ignores the quiet time; it
 * may also be stricter than the policy, which is why a window opens a hold
 * when ANYONE is held (`quietHoldsSendAny`) and who is held is decided per
 * address (`quietHoldsSendFor`). The RELEASE: a reminder or tier deferred for
 * the held readers goes out when the window ends — the newest copy per
 * reader, the older ones superseded, and nothing for an alert that cleared or
 * was acknowledged meanwhile.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = { rows: [] as any[], updates: [] as any[] };

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationDelivery: {
      findMany: vi.fn(async () => db.rows),
      updateMany: vi.fn((args: any) => { db.updates.push(args); return args; }),
    },
    $transaction: vi.fn(async (ops: any[]) => ops),
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

import {
  quietTimeConfigSchema,
  quietHoldsSendFor,
  quietHoldsSendAny,
  quietHasRecipientExceptions,
  quietRecipientFullyExempt,
} from "../../src/utils/quietTime.js";
import { releaseHeldFollowUps } from "../../src/services/quietTimeSummaryService.js";

const WIN = [{ version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "22:00", endTime: "06:00" }] }];
const ALL = { alerts: true, alertReminders: true, escalations: true, escalationReminders: true };
const NONE = { alerts: false, alertReminders: false, escalations: false, escalationReminders: false };

describe("recipient exceptions on the policy", () => {
  it("parses, trimming and lower-casing the address", () => {
    const got = quietTimeConfigSchema.parse({ windows: WIN, recipients: [{ address: "  NOC@Example.com ", held: {} }] });
    expect(got.recipients).toEqual([{ address: "noc@example.com", held: {} }]);
  });

  it("refuses an address listed twice (after normalising) and a non-address", () => {
    const dup = quietTimeConfigSchema.safeParse({ windows: WIN, recipients: [{ address: "a@example.com", held: {} }, { address: "A@example.com", held: {} }] });
    expect(dup.success).toBe(false);
    expect(dup.error!.issues[0]!.path).toEqual(["recipients", 1, "address"]);
    expect(quietTimeConfigSchema.safeParse({ windows: WIN, recipients: [{ address: "nope", held: {} }] }).success).toBe(false);
  });

  it("caps the list at 50", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ address: `u${i}@example.com`, held: {} }));
    expect(quietTimeConfigSchema.safeParse({ windows: WIN, recipients: many }).success).toBe(false);
  });

  it("an excepted address answers for itself; everyone else (and no address) follows the policy", () => {
    const cfg = { windows: WIN, held: { warning: ALL }, recipients: [{ address: "noc@example.com", held: {} }] } as any;
    expect(quietHoldsSendFor(cfg, "noc@example.com", "warning", "fire")).toBe(false);
    expect(quietHoldsSendFor(cfg, "NOC@example.com", "warning", "fire")).toBe(false);
    expect(quietHoldsSendFor(cfg, "oncall@example.com", "warning", "fire")).toBe(true);
    expect(quietHoldsSendFor(cfg, null, "warning", "fire")).toBe(true);
    expect(quietHasRecipientExceptions(cfg)).toBe(true);
    expect(quietRecipientFullyExempt(cfg, "noc@example.com")).toBe(true);
    expect(quietRecipientFullyExempt(cfg, "oncall@example.com")).toBe(false);
  });

  it("an exception may be STRICTER than the policy, so the window holds for anyone held", () => {
    const cfg = { windows: WIN, held: { critical: NONE, warning: ALL }, recipients: [{ address: "mgr@example.com", held: { critical: { ...NONE, alertReminders: true } } }] } as any;
    // The policy lets critical reminders through, the manager holds them.
    expect(quietHoldsSendFor(cfg, "oncall@example.com", "critical", "reminder")).toBe(false);
    expect(quietHoldsSendFor(cfg, "mgr@example.com", "critical", "reminder")).toBe(true);
    expect(quietHoldsSendAny(cfg, "critical", "reminder")).toBe(true);
    expect(quietHoldsSendAny(cfg, "critical", "fire")).toBe(false);
    expect(quietRecipientFullyExempt(cfg, "mgr@example.com")).toBe(false);
  });

  it("a policy without exceptions is not split", () => {
    expect(quietHasRecipientExceptions({ windows: WIN } as any)).toBe(false);
    expect(quietHasRecipientExceptions({ windows: WIN, recipients: [] } as any)).toBe(false);
  });
});

describe("releaseHeldFollowUps — deferred reminders owed at the window's end", () => {
  const NOW = new Date("2026-10-15T06:05:00Z");
  const ENDED = "2026-10-15T06:00:00.000Z";
  const LATER = "2026-10-15T07:00:00.000Z";
  const row = (id: string, at: string, over: Record<string, unknown> = {}) => ({
    id, notificationId: "n1", channelId: "ch", transport: "email", target: "oncall@example.com",
    meta: { quietHold: { windowEnd: ENDED } }, createdAt: new Date(at),
    notification: { cleared: false, acknowledged: false }, ...over,
  });
  const idsTo = (status: string) => db.updates.filter((u) => u.data.status === status).flatMap((u) => u.where.id.in);

  beforeEach(() => { db.rows = []; db.updates = []; });

  it("sends the newest copy per reader and supersedes the older ones", async () => {
    db.rows = [row("r1", "2026-10-15T02:00:00Z"), row("r2", "2026-10-15T04:00:00Z"), row("r3", "2026-10-15T05:00:00Z", { target: "lead@example.com" })];
    expect(await releaseHeldFollowUps(NOW)).toEqual({ released: 2, superseded: 1 });
    expect(idsTo("pending").sort()).toEqual(["r2", "r3"]);
    expect(idsTo("superseded")).toEqual(["r1"]);
    // Only rows still deferred move — a concurrent tick cannot double-send.
    expect(db.updates.every((u) => u.where.status === "deferred")).toBe(true);
  });

  it("leaves a copy whose window has not ended yet", async () => {
    db.rows = [row("r1", "2026-10-15T05:00:00Z", { meta: { quietHold: { windowEnd: LATER } } })];
    expect(await releaseHeldFollowUps(NOW)).toEqual({ released: 0, superseded: 0 });
    expect(db.updates).toHaveLength(0);
  });

  it("supersedes every copy of an alert that cleared or was acknowledged", async () => {
    db.rows = [
      row("r1", "2026-10-15T02:00:00Z", { notification: { cleared: true, acknowledged: false } }),
      row("r2", "2026-10-15T03:00:00Z", { notificationId: "n2", notification: { cleared: false, acknowledged: true }, meta: { quietHold: { windowEnd: LATER } } }),
    ];
    expect(await releaseHeldFollowUps(NOW)).toEqual({ released: 0, superseded: 2 });
    expect(idsTo("superseded").sort()).toEqual(["r1", "r2"]);
  });

  it("does nothing when nothing is deferred", async () => {
    expect(await releaseHeldFollowUps(NOW)).toEqual({ released: 0, superseded: 0 });
    expect(db.updates).toHaveLength(0);
  });
});
