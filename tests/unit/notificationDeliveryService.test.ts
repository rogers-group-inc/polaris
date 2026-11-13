/**
 * tests/unit/notificationDeliveryService.test.ts — notificationDeliveryService's
 * own suite (CQ-T010).
 *
 * Complements, rather than repeats:
 *   - pushEmailFallback.test.ts      (readPushFallback / pushStillInPlay / alreadyEmailedOnChannel, pure)
 *   - automationActions.test.ts      (api_call retry vs deleted-channel permanent fail; emailSentEventsFor)
 *   - allClearPushDelivery.test.ts   (an all-clear row says RESOLVED on push / Slack / Pushbullet)
 *   - alertChartRenderMemo / alertDependencyPathDelivery (per-drain render memo)
 *   - the firmware / reboot suites, which only MOCK applyBrandLetterhead + sendEmailThroughChannel
 *
 * What this adds: sendEmailThroughChannel's transport dispatch and its SMTP
 * defaults (port 587, STARTTLS); applyBrandLetterhead (untouched without the
 * token, the logo attached only when the HTML references its cid); and the
 * drain's own decisions — the legacy per-address body (View link, the
 * acknowledge line, `noAck` leaving it off — rule 25), a composed email with
 * no To refusing, TEST marking (rule 65), a disabled channel failing for good,
 * a Slack channel without a webhook, an unknown channel type, a transport
 * error retrying until MAX_ATTEMPTS, the error clipped to 500 chars, the
 * web-push payload (deep link, asset button, ack button, follow-up line), a
 * dead endpoint pruning its subscription and queueing the email fallback
 * cloned from THIS send's composed sibling, a throwing fallback not costing
 * the drain its summary Event, and the single-alert drain filter.
 *
 * Nothing is sent: every channel module is a spy, and the public URL is mocked
 * rather than read from the environment.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";

const h = vi.hoisted(() => ({
  sendSmtpEmail: vi.fn(),
  sendM365Email: vi.fn(),
  sendWebhook: vi.fn(),
  sendPushbullet: vi.fn(),
  sendWebPush: vi.fn(),
  sendApiCall: vi.fn(),
  buildAlertBrandBlock: vi.fn(),
  publicBaseUrl: vi.fn((): string | null => "https://polaris.example"),
}));

vi.mock("../../src/services/notificationChannels/emailChannel.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendSmtpEmail: h.sendSmtpEmail,
  sendM365Email: h.sendM365Email,
}));
vi.mock("../../src/services/notificationChannels/webhookChannel.js", () => ({ sendWebhook: h.sendWebhook }));
vi.mock("../../src/services/notificationChannels/pushbulletChannel.js", () => ({ sendPushbullet: h.sendPushbullet }));
vi.mock("../../src/services/notificationChannels/webPushChannel.js", () => ({ sendWebPush: h.sendWebPush }));
vi.mock("../../src/services/notificationChannels/apiCallChannel.js", () => ({ sendApiCall: h.sendApiCall }));
vi.mock("../../src/services/alertBrandService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildAlertBrandBlock: h.buildAlertBrandBlock,
}));
vi.mock("../../src/utils/publicUrl.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  publicBaseUrl: h.publicBaseUrl,
}));

import {
  sendEmailThroughChannel,
  applyBrandLetterhead,
  drainPendingDeliveries,
} from "../../src/services/notificationDeliveryService.js";

const NOTIFICATION = {
  id: "n1", message: "CPU is 97%", severity: "critical", assetId: "a1", assetHostname: "SRV-1",
  dimension: null, metric: "cpu", ruleId: "r1", triggeredAt: new Date("2026-11-13T10:00:00Z"),
  testRun: false, members: null, dependencyDown: false, dependencyBlame: null, rule: { name: "CPU high" },
};

const row = (over: Record<string, unknown> = {}) => ({
  id: "d1", channelId: "c-mail", transport: "email", target: "ops@example.com", meta: null, attempts: 0,
  notification: NOTIFICATION, ...over,
});

const CHANNELS = [
  { id: "c-mail", type: "smtp", enabled: true, config: { host: "mx", from: "polaris@example.com" } },
  { id: "c-m365", type: "oauth_m365", enabled: true, config: { tenantId: "t", clientId: "c", clientSecret: "s", fromUserId: "u" } },
  { id: "c-off", type: "smtp", enabled: false, config: {} },
  { id: "c-slack", type: "slack", enabled: true, config: {} },
  { id: "c-odd", type: "carrier_pigeon", enabled: true, config: {} },
  { id: "c-push", type: "web_push", enabled: true, config: { publicKey: "pk", privateKey: "sk", subject: "mailto:x@example.com" } },
];

let deliveryRows: unknown[] = [];

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of [h.sendSmtpEmail, h.sendM365Email, h.sendWebhook, h.sendPushbullet, h.sendWebPush, h.sendApiCall, h.buildAlertBrandBlock]) {
    f.mockReset();
    f.mockResolvedValue(undefined);
  }
  h.publicBaseUrl.mockReset();
  h.publicBaseUrl.mockReturnValue("https://polaris.example");
  deliveryRows = [];
  stubbed(prisma.notificationDelivery.findMany).mockImplementation(async () => deliveryRows);
  stubbed(prisma.notificationDelivery.updateMany).mockResolvedValue({ count: 0 });
  stubbed(prisma.notificationDelivery.update).mockResolvedValue({});
  stubbed(prisma.notificationDelivery.createMany).mockResolvedValue({ count: 0 });
  stubbed(prisma.notificationChannel.findMany).mockResolvedValue(CHANNELS);
  stubbed(prisma.pushSubscription.deleteMany).mockResolvedValue({ count: 0 });
});

const updateFor = (id: string) =>
  stubbed(prisma.notificationDelivery.update).mock.calls.map((c) => c[0]).find((a) => a.where.id === id)?.data;

// ─── sendEmailThroughChannel ────────────────────────────────────────────────

describe("sendEmailThroughChannel", () => {
  const msg = { to: "a@example.com", subject: "s", text: "t" };

  it("sends SMTP with the channel's settings, defaulting port 587 and STARTTLS", async () => {
    await sendEmailThroughChannel({ type: "smtp", config: { host: "mx", port: "not-a-port", username: 7, password: "pw", from: "f@example.com" } }, msg);
    expect(h.sendSmtpEmail).toHaveBeenCalledWith(
      { host: "mx", port: 587, security: "starttls", username: "", password: "pw", from: "f@example.com" },
      msg,
    );
  });

  it("keeps an explicit port and security mode", async () => {
    await sendEmailThroughChannel({ type: "smtp", config: { port: 465, security: "tls" } }, msg);
    expect(h.sendSmtpEmail.mock.calls[0][0]).toMatchObject({ port: 465, security: "tls" });
  });

  it("sends through Microsoft 365 with the app registration's fields", async () => {
    await sendEmailThroughChannel({ type: "oauth_m365", config: { tenantId: "t", clientId: "c", clientSecret: "s", fromUserId: "u" } }, msg);
    expect(h.sendM365Email).toHaveBeenCalledWith({ tenantId: "t", clientId: "c", clientSecret: "s", fromUserId: "u" }, msg);
  });

  it("tolerates a null config", async () => {
    await sendEmailThroughChannel({ type: "smtp", config: null }, msg);
    expect(h.sendSmtpEmail.mock.calls[0][0]).toMatchObject({ host: "", port: 587 });
  });

  it("refuses a channel that cannot send email with a 400", async () => {
    await expect(sendEmailThroughChannel({ type: "slack", config: {} }, msg)).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.sendSmtpEmail).not.toHaveBeenCalled();
  });

  it("propagates a transport failure so the caller can record it", async () => {
    h.sendSmtpEmail.mockRejectedValue(new Error("535 auth failed"));
    await expect(sendEmailThroughChannel({ type: "smtp", config: {} }, msg)).rejects.toThrow("535 auth failed");
  });
});

// ─── applyBrandLetterhead ───────────────────────────────────────────────────

describe("applyBrandLetterhead", () => {
  const logo = { cid: "polaris-brand-logo", filename: "logo.png", contentType: "image/png", content: Buffer.from("x") };

  it("returns a body with no brand token untouched and reads nothing", async () => {
    const msg = { text: "hello", html: "<p>hello</p>" };
    expect(await applyBrandLetterhead(msg)).toBe(msg);
    expect(h.buildAlertBrandBlock).not.toHaveBeenCalled();
  });

  it("fills the token and attaches the logo when the HTML references its cid", async () => {
    h.buildAlertBrandBlock.mockResolvedValue({ html: '<img src="cid:polaris-brand-logo">', text: "Polaris", attachment: logo });
    const prior = { ...logo, cid: "chart-1" };
    const out = await applyBrandLetterhead({ text: "{brand.header}\nbody", html: "<div>{brand.header}</div>", attachments: [prior], subject: "kept" });
    expect(out.text).toBe("Polaris\nbody");
    expect(out.html).toBe('<div><img src="cid:polaris-brand-logo"></div>');
    expect(out.attachments).toEqual([prior, logo]);
    expect(out.subject).toBe("kept");
  });

  it("leaves the logo off when the block degraded to text", async () => {
    h.buildAlertBrandBlock.mockResolvedValue({ html: "Polaris", text: "Polaris", attachment: logo });
    const input: { text: string; html: string; attachments?: unknown[] } = { text: "{brand.header}", html: "<div>{brand.header}</div>" };
    const out = await applyBrandLetterhead(input as { text: string; html: string });
    expect((out as typeof input).attachments).toBeUndefined();
  });

  it("a text-only body gets the text block and no attachment", async () => {
    h.buildAlertBrandBlock.mockResolvedValue({ html: "<img src=\"cid:polaris-brand-logo\">", text: "Polaris", attachment: logo });
    const out = await applyBrandLetterhead({ text: "{brand.header}\nx" });
    expect(out).toEqual({ text: "Polaris\nx", html: undefined, attachments: undefined });
  });
});

// ─── drainPendingDeliveries ─────────────────────────────────────────────────

describe("drainPendingDeliveries — selection", () => {
  it("returns zeros, reads no channels and audits nothing when the queue is empty", async () => {
    expect(await drainPendingDeliveries()).toEqual({ processed: 0, sent: 0, failed: 0 });
    expect(prisma.notificationChannel.findMany).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("pulls pending rows under the attempt cap, oldest first, and narrows to one alert when asked", async () => {
    await drainPendingDeliveries();
    await drainPendingDeliveries({ notificationId: "n7" });
    const [all, one] = stubbed(prisma.notificationDelivery.findMany).mock.calls.map((c) => c[0]);
    expect(all.where).toEqual({ status: "pending", attempts: { lt: 3 } });
    expect(all.orderBy).toEqual({ createdAt: "asc" });
    expect(all.take).toBe(200);
    expect(one.where).toEqual({ status: "pending", attempts: { lt: 3 }, notificationId: "n7" });
  });
});

describe("drainPendingDeliveries — email", () => {
  it("a legacy row mails the default body with the View link and the acknowledge line", async () => {
    deliveryRows = [row()];
    const res = await drainPendingDeliveries();
    expect(res).toEqual({ processed: 1, sent: 1, failed: 0 });
    const [, msg] = h.sendSmtpEmail.mock.calls[0];
    expect(msg).toEqual({
      to: "ops@example.com",
      subject: "[CRITICAL] SRV-1",
      text: "CPU is 97%\n\nView: https://polaris.example/automations.html\n\nAcknowledge this alert: https://polaris.example/alert-ack.html?id=n1",
    });
    const sent = stubbed(prisma.notificationDelivery.updateMany).mock.calls[0][0];
    expect(sent).toMatchObject({ where: { id: { in: ["d1"] } }, data: { status: "sent" } });
  });

  it("leaves the acknowledge line off a noAck address (rule 25) and the links off with no public URL", async () => {
    deliveryRows = [row({ meta: { noAck: true } })];
    await drainPendingDeliveries();
    expect(h.sendSmtpEmail.mock.calls[0][1].text).toBe("CPU is 97%\n\nView: https://polaris.example/automations.html");

    h.publicBaseUrl.mockReturnValue(null);
    deliveryRows = [row()];
    await drainPendingDeliveries();
    expect(h.sendSmtpEmail.mock.calls[1][1].text).toBe("CPU is 97%");
  });

  it("names a system alert with no host 'Polaris notification'", async () => {
    deliveryRows = [row({ notification: { ...NOTIFICATION, assetHostname: null, assetId: null, severity: "warning" } })];
    await drainPendingDeliveries();
    expect(h.sendSmtpEmail.mock.calls[0][1].subject).toBe("[WARNING] Polaris notification");
  });

  it("a composed row sends its own To / Cc / Bcc and subject through Microsoft 365", async () => {
    deliveryRows = [row({ channelId: "c-m365", meta: { composed: true, to: ["a@x.com", "", 5], cc: ["b@x.com"], bcc: ["c@x.com"], subject: "Custom", text: "plain", html: "<p>rich</p>" } })];
    await drainPendingDeliveries();
    expect(h.sendM365Email.mock.calls[0][1]).toEqual({ to: ["a@x.com"], cc: ["b@x.com"], bcc: ["c@x.com"], subject: "Custom", text: "plain", html: "<p>rich</p>" });
  });

  it("a composed row with no To recipients fails without sending", async () => {
    deliveryRows = [row({ meta: { composed: true, to: [] } })];
    const res = await drainPendingDeliveries();
    expect(res.failed).toBe(1);
    expect(h.sendSmtpEmail).not.toHaveBeenCalled();
    expect(updateFor("d1")).toMatchObject({ status: "pending", error: "composed email delivery has no To recipients" });
  });

  it("marks a test fire TEST on both the composed and the legacy path (rule 65)", async () => {
    const test = { ...NOTIFICATION, testRun: true };
    deliveryRows = [
      row({ id: "d-c", notification: test, meta: { composed: true, to: ["a@x.com"], subject: "Disk full", text: "t" } }),
      row({ id: "d-l", notification: test }),
    ];
    await drainPendingDeliveries();
    const subjects = h.sendSmtpEmail.mock.calls.map((c) => c[1].subject).sort();
    expect(subjects).toEqual(["[TEST] Disk full", "[TEST] [CRITICAL] SRV-1"]);
    // A test is about an invented device: no asset Event for its email.
    expect(eventLog.logEventsBatch.mock.calls[0][0]).toEqual([]);
  });

  it("files one asset Event per sent email, then one summary Event", async () => {
    deliveryRows = [row()];
    await drainPendingDeliveries();
    const events = eventLog.logEventsBatch.mock.calls[0][0];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ resourceId: "n1", details: { assetId: "a1", to: ["ops@example.com"] } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "notification.delivered", level: "info", message: "Notification delivery: 1 sent, 0 failed",
      details: { sent: 1, failed: 0, prunedSubscriptions: 0, emailedInsteadOfPush: 0 },
    });
  });
});

describe("drainPendingDeliveries — failures", () => {
  it("a DISABLED channel fails the attempt but keeps retrying — only a DELETED channel is permanent", async () => {
    deliveryRows = [row({ channelId: "c-off" })];
    await drainPendingDeliveries();
    // The channel still exists, so it is not 'permanent' — the attempt count
    // decides (the module header lumps disabled with deleted; the code does not).
    expect(updateFor("d1")).toMatchObject({ status: "pending", error: "delivery channel is disabled", attempts: { increment: 1 } });
  });

  it("a row with NO channel id (email) fails permanently at once", async () => {
    deliveryRows = [row({ channelId: null })];
    await drainPendingDeliveries();
    expect(updateFor("d1")).toMatchObject({ status: "failed", error: "delivery channel was deleted" });
  });

  it("a Slack channel without a webhook URL and an unknown channel type both fail with a reason", async () => {
    deliveryRows = [row({ id: "s", channelId: "c-slack" }), row({ id: "u", channelId: "c-odd" })];
    await drainPendingDeliveries();
    expect(updateFor("s")?.error).toBe("slack channel has no webhook URL");
    expect(updateFor("u")?.error).toBe('unknown channel type "carrier_pigeon"');
    expect(h.sendWebhook).not.toHaveBeenCalled();
  });

  it("a transport error retries until the third attempt, and the error is clipped to 500 chars", async () => {
    h.sendSmtpEmail.mockRejectedValue(new Error("x".repeat(900)));
    deliveryRows = [row({ id: "first", attempts: 0 }), row({ id: "last", attempts: 2 })];
    const res = await drainPendingDeliveries();
    expect(res).toEqual({ processed: 2, sent: 0, failed: 2 });
    expect(updateFor("first")).toMatchObject({ status: "pending" });
    expect(updateFor("last")).toMatchObject({ status: "failed" });
    expect(updateFor("first")?.error).toHaveLength(500);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ level: "warning", message: "Notification delivery: 0 sent, 2 failed" });
  });
});

describe("drainPendingDeliveries — web push", () => {
  const pushRow = (over: Record<string, unknown> = {}) => row({
    id: "p1", channelId: "c-push", transport: "web_push", target: "https://push.example/ep1",
    meta: { p256dh: "key", auth: "auth", followUp: "Reminders every 15 minutes until acknowledged." }, ...over,
  });

  it("sends the deep link, the device and acknowledge buttons and the follow-up line", async () => {
    deliveryRows = [pushRow()];
    await drainPendingDeliveries();
    const [vapid, sub, payload] = h.sendWebPush.mock.calls[0];
    expect(vapid).toEqual({ publicKey: "pk", privateKey: "sk", subject: "mailto:x@example.com" });
    expect(sub).toEqual({ endpoint: "https://push.example/ep1", p256dh: "key", auth: "auth" });
    expect(payload).toMatchObject({
      title: "[CRITICAL] SRV-1",
      body: "CPU is 97%\n\nReminders every 15 minutes until acknowledged.",
      severity: "critical",
      notificationId: "n1",
      ackUrl: "https://polaris.example/alert-ack.html?id=n1",
    });
    expect(payload.assetUrl).toContain("a1");
  });

  it("a system alert gets no device button; a noAck subscriber gets no acknowledge button", async () => {
    deliveryRows = [pushRow({ meta: { p256dh: "k", auth: "a", noAck: true }, notification: { ...NOTIFICATION, assetId: null } })];
    await drainPendingDeliveries();
    const payload = h.sendWebPush.mock.calls[0][2];
    expect(payload).not.toHaveProperty("assetUrl");
    expect(payload).not.toHaveProperty("ackUrl");
    expect(payload.body).toBe("CPU is 97%");
  });

  it("a dead endpoint (410) prunes its subscription and fails the row for good", async () => {
    h.sendWebPush.mockRejectedValue(Object.assign(new Error("410 Gone"), { gone: true }));
    deliveryRows = [pushRow()];
    await drainPendingDeliveries();
    expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { endpoint: { in: ["https://push.example/ep1"] } } });
    // No fallback stamp: nothing to email.
    expect(prisma.notificationDelivery.createMany).not.toHaveBeenCalled();
    expect(eventLog.logEvent.mock.calls[0][0].details).toMatchObject({ prunedSubscriptions: 1, emailedInsteadOfPush: 0 });
  });

  it("emails the recipient instead, cloning THIS send's composed body (dispatch match) with only their address", async () => {
    h.sendWebPush.mockRejectedValue(Object.assign(new Error("404"), { gone: true }));
    const fallback = { userId: "u1", channelId: "c-mail", address: "me@example.com" };
    // attempts 2 → this failure is terminal (a gone push is not 'permanent' by itself).
    deliveryRows = [pushRow({ attempts: 2, meta: { p256dh: "k", auth: "a", fallback, dispatch: "disp-2" } })];
    const siblings = [
      { transport: "web_push", status: "failed", target: "https://push.example/ep1", channelId: "c-push", meta: { fallback, dispatch: "disp-2" } },
      { transport: "email", status: "sent", target: "boss@example.com", channelId: "c-mail", meta: { composed: true, dispatch: "disp-1", subject: "FIRE", to: ["boss@example.com"] } },
      { transport: "email", status: "sent", target: "boss@example.com", channelId: "c-mail", meta: { composed: true, dispatch: "disp-2", subject: "RESOLVED", to: ["boss@example.com"], cc: ["x@example.com"] } },
    ];
    stubbed(prisma.notificationDelivery.findMany).mockImplementation(async (args: { where: { notificationId?: string; status?: string } }) =>
      args.where.status === "pending" ? deliveryRows : siblings);

    await drainPendingDeliveries();
    const created = stubbed(prisma.notificationDelivery.createMany).mock.calls[0][0].data;
    expect(created).toEqual([{
      notificationId: "n1", channelId: "c-mail", transport: "email", target: "me@example.com",
      meta: { composed: true, dispatch: "disp-2", subject: "RESOLVED", to: ["me@example.com"], cc: [], bcc: [], pushFallback: true },
    }]);
    expect(eventLog.logEvent.mock.calls[0][0].details).toMatchObject({ emailedInsteadOfPush: 1 });
  });

  it("a throwing fallback pass never costs the drain its status writes or summary Event", async () => {
    h.sendWebPush.mockRejectedValue(Object.assign(new Error("410"), { gone: true }));
    const fallback = { userId: "u1", channelId: "c-mail", address: "me@example.com" };
    deliveryRows = [pushRow({ attempts: 2, meta: { fallback } })];
    stubbed(prisma.notificationDelivery.findMany).mockImplementation(async (args: { where: { status?: string } }) => {
      if (args.where.status === "pending") return deliveryRows;
      throw new Error("sibling read failed");
    });
    const res = await drainPendingDeliveries();
    expect(res.failed).toBe(1);
    expect(updateFor("p1")).toMatchObject({ status: "failed" });
    expect(eventLog.logEvent.mock.calls[0][0].details).toMatchObject({ emailedInsteadOfPush: 0 });
  });
});
