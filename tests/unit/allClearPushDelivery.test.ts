/**
 * tests/unit/allClearPushDelivery.test.ts — an all-clear says "resolved" on the
 * transports with no composed body. Push, Slack/Teams and Pushbullet build
 * their title and text from the notification row, which still holds the
 * FIRE's severity and message; the all-clear row carries `allClear` + the
 * recovery sentence (stamped at fan-out) and the drain must use them, or the
 * "resolved" push reads exactly like the alert it closes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { rows, pushes, hooks, bullets } = vi.hoisted(() => {
  const notification = {
    id: "n-1",
    assetId: "a-1",
    message: "Port 7 is down",
    severity: "critical",
    assetHostname: "switch-1",
    dimension: null,
    metric: "monitorStatus",
    ruleId: "r1",
    triggeredAt: new Date("2026-10-26T12:00:00Z"),
    testRun: false,
    members: null,
  };
  const mk = (id: string, channelId: string, transport: string, meta: Record<string, unknown> | null) => ({
    id, channelId, transport, target: transport === "web_push" ? `https://push.example/${id}` : "", meta, attempts: 0, notification,
  });
  const clear = { allClear: true, message: "Resolved: Port down — switch-1 recovered" };
  return {
    rows: {
      list: [] as unknown[],
      fire: [
        mk("p1", "c-push", "web_push", { p256dh: "k", auth: "a", followUp: "Reminders every 15 minutes until acknowledged." }),
        mk("s1", "c-slack", "webhook", null),
        mk("b1", "c-bullet", "pushbullet", null),
      ],
      clear: [
        mk("p2", "c-push", "web_push", { p256dh: "k", auth: "a", noAck: true, ...clear }),
        mk("s2", "c-slack", "webhook", clear),
        mk("b2", "c-bullet", "pushbullet", clear),
      ],
    },
    pushes: [] as Array<{ title: string; body: string; severity: string; ackUrl?: string }>,
    hooks: [] as Array<{ title: string; message: string; severity: string }>,
    bullets: [] as Array<{ title: string; body: string }>,
  };
});

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationDelivery: {
      findMany: vi.fn(async () => rows.list),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
    notificationChannel: {
      findMany: vi.fn(async () => [
        { id: "c-push", type: "web_push", enabled: true, config: { publicKey: "p", privateKey: "q", subject: "mailto:a@b.c" } },
        { id: "c-slack", type: "slack", enabled: true, config: { webhookUrl: "https://hooks.example/x" } },
        { id: "c-bullet", type: "pushbullet", enabled: true, config: { accessToken: "t" } },
      ]),
    },
    pushSubscription: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

vi.mock("../../src/services/notificationChannels/webPushChannel.js", () => ({
  sendWebPush: vi.fn(async (_v: unknown, _t: unknown, p: unknown) => { pushes.push(p as never); }),
}));
vi.mock("../../src/services/notificationChannels/webhookChannel.js", () => ({
  sendWebhook: vi.fn(async (_u: unknown, _k: unknown, p: unknown) => { hooks.push(p as never); }),
}));
vi.mock("../../src/services/notificationChannels/pushbulletChannel.js", () => ({
  sendPushbullet: vi.fn(async (_c: unknown, p: unknown) => { bullets.push(p as never); }),
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}), logEventsBatch: vi.fn(async () => 0) }));

import { drainPendingDeliveries } from "../../src/services/notificationDeliveryService.js";

beforeEach(() => {
  pushes.length = 0;
  hooks.length = 0;
  bullets.length = 0;
});

describe("all-clear on push and chat", () => {
  it("says RESOLVED with the recovery sentence, in the resolved colour", async () => {
    rows.list = rows.clear;
    const res = await drainPendingDeliveries();
    expect(res.sent).toBe(3);
    expect(pushes[0]).toMatchObject({ title: "[RESOLVED] switch-1", body: "Resolved: Port down — switch-1 recovered", severity: "resolved" });
    expect(pushes[0].ackUrl).toBeUndefined();
    expect(hooks[0]).toMatchObject({ title: "[RESOLVED] switch-1", message: "Resolved: Port down — switch-1 recovered", severity: "resolved" });
    expect(bullets[0]).toEqual({ title: "[RESOLVED] switch-1", body: "Resolved: Port down — switch-1 recovered" });
  });

  it("leaves a firing send exactly as it was", async () => {
    rows.list = rows.fire;
    await drainPendingDeliveries();
    expect(pushes[0]).toMatchObject({
      title: "[CRITICAL] switch-1",
      body: "Port 7 is down\n\nReminders every 15 minutes until acknowledged.",
      severity: "critical",
    });
    expect(hooks[0]).toMatchObject({ title: "[CRITICAL] switch-1", message: "Port 7 is down", severity: "critical" });
    expect(bullets[0]).toEqual({ title: "[CRITICAL] switch-1", body: "Port 7 is down" });
  });
});
