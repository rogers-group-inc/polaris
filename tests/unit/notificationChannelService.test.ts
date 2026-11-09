/**
 * tests/unit/notificationChannelService.test.ts
 *
 * The NotificationChannel registry's secret discipline and the Web Push
 * capability toggle:
 *
 *   • every `secret: true` field is masked on read, and the web_push private
 *     key is never returned at all (only `privateKeySet`);
 *   • a write that echoes the mask (or a blank) keeps the stored secret — but
 *     never toward a new destination (business rule 111);
 *   • the client can never set the VAPID keys, `type` is immutable, and
 *     web_push is a singleton;
 *   • turning Web Push off never deletes the row or the keys (every enrolled
 *     device is signed against them);
 *   • the test push reaches only the caller's own devices and prunes a dead one.
 *
 * Field definitions come from the real notificationTypes; Prisma and the push
 * sender are faked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  subCount: vi.fn(),
  subFindMany: vi.fn(),
  subDeleteMany: vi.fn(),
  logEvent: vi.fn(),
  generateVapidKeys: vi.fn(),
  sendWebPush: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationChannel: {
      findMany: m.findMany, findUnique: m.findUnique, findFirst: m.findFirst, count: m.count,
      create: m.create, update: m.update, delete: m.del,
    },
    pushSubscription: { count: m.subCount, findMany: m.subFindMany, deleteMany: m.subDeleteMany },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: m.logEvent }));
vi.mock("../../src/services/notificationChannels/webPushChannel.js", () => ({
  generateVapidKeys: m.generateVapidKeys,
  sendWebPush: m.sendWebPush,
}));

const svc = await import("../../src/services/notificationChannelService.js");
const { SECRET_MASK } = await import("../../src/utils/secretMask.js");

const now = new Date("2026-11-09T00:00:00Z");
function row(over: Record<string, unknown>) {
  return { id: "ch-1", name: "Mail", type: "smtp", enabled: true, config: {}, createdBy: "alice", createdAt: now, updatedAt: now, ...over };
}
const smtpStored = { host: "smtp.example.com", port: 587, security: "starttls", username: "u", password: "hunter2", from: "p@example.com" };

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.create.mockImplementation(async (a: { data: Record<string, unknown> }) => row({ id: "ch-new", ...a.data }));
  m.update.mockImplementation(async (a: { where: { id: string }; data: Record<string, unknown> }) => row({ id: a.where.id, ...a.data }));
  m.generateVapidKeys.mockReturnValue({ publicKey: "PUB", privateKey: "PRIV" });
  m.subCount.mockResolvedValue(0);
  delete process.env.POLARIS_PUBLIC_URL;
});

// ─── Masking on read ─────────────────────────────────────────────────────────

describe("reading a channel never returns a secret", () => {
  it("masks each secret field that has a value and reports which are set", async () => {
    m.findMany.mockResolvedValue([
      row({ config: smtpStored }),
      row({ id: "ch-2", type: "slack", config: { webhookUrl: "" } }),
    ]);
    const [smtp, slack] = await svc.listChannels();
    expect(smtp.config).toMatchObject({ password: SECRET_MASK, passwordSet: true, host: "smtp.example.com" });
    expect(JSON.stringify(smtp)).not.toContain("hunter2");
    expect(slack.config).toMatchObject({ webhookUrl: "", webhookUrlSet: false });
    expect(smtp.transport).toBe("email");
  });

  it("omits the web_push private key entirely, exposing only privateKeySet", async () => {
    m.findUnique.mockResolvedValue(row({ type: "web_push", config: { publicKey: "PUB", privateKey: "PRIV", subject: "mailto:x" } }));
    const ch = await svc.getChannel("ch-1");
    expect(ch.config).not.toHaveProperty("privateKey");
    expect(ch.config).toMatchObject({ privateKeySet: true, publicKey: "PUB" });
  });

  it("returns an empty config and an 'unknown' transport for a row of an unknown type", async () => {
    m.findUnique.mockResolvedValue(row({ type: "carrier_pigeon", config: { secret: "x" } }));
    const ch = await svc.getChannel("ch-1");
    expect(ch.config).toEqual({});
    expect(ch.transport).toBe("unknown");
  });

  it("404s a missing channel; getChannelRaw returns secrets intact for the senders", async () => {
    m.findUnique.mockResolvedValue(null);
    await expect(svc.getChannel("x")).rejects.toMatchObject({ httpStatus: 404 });
    m.findUnique.mockResolvedValue(row({ config: smtpStored }));
    expect((await svc.getChannelRaw("ch-1"))!.config).toEqual(smtpStored);
  });
});

// ─── Writes ──────────────────────────────────────────────────────────────────

describe("createChannel", () => {
  it("400s an unknown type", async () => {
    await expect(svc.createChannel({ name: "x", type: "fax" })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("refuses a second web_push channel (singleton)", async () => {
    m.count.mockResolvedValue(1);
    await expect(svc.createChannel({ name: "Push", type: "web_push" })).rejects.toMatchObject({ httpStatus: 409 });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("never lets the client set the VAPID keys and strips UI-only *Set markers", async () => {
    m.count.mockResolvedValue(0);
    await svc.createChannel({ name: " Push ", type: "web_push", config: { publicKey: "EVIL", privateKey: "EVIL", privateKeySet: true, subject: "mailto:a@b" } }, "alice");
    const data = m.create.mock.calls[0][0].data;
    expect(data.name).toBe("Push");
    expect(data.config).toEqual({ subject: "mailto:a@b", publicKey: "", privateKey: "" });
    expect(data.createdBy).toBe("alice");
  });
});

describe("updateChannel", () => {
  it("keeps the stored secret when the client echoes the mask or sends a blank", async () => {
    m.findUnique.mockResolvedValue(row({ config: smtpStored }));
    await svc.updateChannel("ch-1", { name: "Mail", type: "smtp", config: { ...smtpStored, password: SECRET_MASK, passwordSet: true } });
    expect(m.update.mock.calls[0][0].data.config.password).toBe("hunter2");
    expect(m.update.mock.calls[0][0].data.config).not.toHaveProperty("passwordSet");

    m.update.mockClear();
    await svc.updateChannel("ch-1", { name: "Mail", type: "smtp", config: { ...smtpStored, password: "" } });
    expect(m.update.mock.calls[0][0].data.config.password).toBe("hunter2");
  });

  it("takes a newly typed secret", async () => {
    m.findUnique.mockResolvedValue(row({ config: smtpStored }));
    await svc.updateChannel("ch-1", { name: "Mail", type: "smtp", config: { ...smtpStored, password: "new-pass" } });
    expect(m.update.mock.calls[0][0].data.config.password).toBe("new-pass");
  });

  it("refuses to carry the stored password to a different SMTP host (business rule 111)", async () => {
    m.findUnique.mockResolvedValue(row({ config: smtpStored }));
    await expect(
      svc.updateChannel("ch-1", { name: "Mail", type: "smtp", config: { ...smtpStored, host: "evil.example.net", password: SECRET_MASK } }),
    ).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("host") });
    expect(m.update).not.toHaveBeenCalled();
  });

  it("allows a new host when the password is typed again", async () => {
    m.findUnique.mockResolvedValue(row({ config: smtpStored }));
    await svc.updateChannel("ch-1", { name: "Mail", type: "smtp", config: { ...smtpStored, host: "new.example.net", password: "retyped" } });
    expect(m.update.mock.calls[0][0].data.config).toMatchObject({ host: "new.example.net", password: "retyped" });
  });

  it("keeps the type immutable and the stored VAPID keys on a web_push update", async () => {
    m.findUnique.mockResolvedValue(row({ type: "web_push", config: { publicKey: "PUB", privateKey: "PRIV", subject: "mailto:a" } }));
    await svc.updateChannel("ch-1", { name: "Push", type: "smtp", config: { subject: "mailto:b", publicKey: "X", privateKey: "Y" } });
    const data = m.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("type");
    expect(data.config).toEqual({ subject: "mailto:b", publicKey: "PUB", privateKey: "PRIV" });
  });

  it("returns the masked row", async () => {
    m.findUnique.mockResolvedValue(row({ config: smtpStored }));
    const out = await svc.updateChannel("ch-1", { name: "Mail", type: "smtp", config: { ...smtpStored, password: SECRET_MASK } });
    expect(out.config.password).toBe(SECRET_MASK);
  });
});

describe("generateWebPushKeys", () => {
  it("only applies to a web_push channel", async () => {
    m.findUnique.mockResolvedValue(row({ type: "smtp" }));
    await expect(svc.generateWebPushKeys("ch-1")).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("stores a fresh keypair alongside the existing config and returns only the public half", async () => {
    m.findUnique.mockResolvedValue(row({ type: "web_push", config: { subject: "mailto:a" } }));
    const out = await svc.generateWebPushKeys("ch-1", "alice");
    expect(out).toEqual({ publicKey: "PUB", privateKeySet: true });
    expect(m.update.mock.calls[0][0].data.config).toEqual({ subject: "mailto:a", publicKey: "PUB", privateKey: "PRIV" });
  });
});

// ─── Web Push as a capability ────────────────────────────────────────────────

describe("setWebPushEnabled", () => {
  it("first enable creates the singleton and generates a keypair", async () => {
    let stored: Record<string, unknown> | null = null;
    m.findFirst.mockImplementation(async () => stored);
    m.create.mockImplementation(async (a: { data: Record<string, unknown> }) => { stored = row({ id: "wp", ...a.data }); return stored; });
    m.findUnique.mockImplementation(async () => stored);
    m.update.mockImplementation(async (a: { data: Record<string, unknown> }) => { stored = { ...stored!, ...a.data }; return stored; });
    const state = await svc.setWebPushEnabled(true, "alice");
    expect(m.create.mock.calls[0][0].data).toMatchObject({ type: "web_push", enabled: true, config: { subject: "mailto:polaris@localhost" } });
    expect(m.generateVapidKeys).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({ enabled: true, configured: true, channelId: "wp" });
  });

  it("derives the VAPID subject from an https POLARIS_PUBLIC_URL", async () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com/";
    m.findFirst.mockResolvedValue(null);
    await svc.setWebPushEnabled(true).catch(() => undefined);
    expect(m.create.mock.calls[0][0].data.config).toEqual({ subject: "https://polaris.example.com" });
  });

  it("disabling flips enabled off and NEVER deletes the row or its keys", async () => {
    m.findFirst.mockResolvedValue(row({ id: "wp", type: "web_push", enabled: true, config: { publicKey: "PUB", privateKey: "PRIV" } }));
    await svc.setWebPushEnabled(false, "alice");
    expect(m.update).toHaveBeenCalledWith({ where: { id: "wp" }, data: { enabled: false } });
    expect(m.del).not.toHaveBeenCalled();
    expect(m.generateVapidKeys).not.toHaveBeenCalled();
  });

  it("re-enabling a keyed row does not mint new keys (enrolled devices survive)", async () => {
    m.findFirst.mockResolvedValue(row({ id: "wp", type: "web_push", enabled: false, config: { publicKey: "PUB", privateKey: "PRIV" } }));
    await svc.setWebPushEnabled(true);
    expect(m.update).toHaveBeenCalledWith({ where: { id: "wp" }, data: { enabled: true } });
    expect(m.generateVapidKeys).not.toHaveBeenCalled();
  });

  it("reports enabled only when the row is on AND keyed", async () => {
    m.findFirst.mockResolvedValue(row({ id: "wp", type: "web_push", enabled: true, config: {} }));
    m.subCount.mockResolvedValue(3);
    await expect(svc.getWebPushState()).resolves.toEqual({ enabled: false, configured: true, subscriberCount: 3, channelId: "wp" });
  });
});

describe("sendWebPushTest", () => {
  const keyed = row({ id: "wp", type: "web_push", enabled: true, config: { publicKey: "PUB", privateKey: "PRIV", subject: "mailto:a" } });

  it("400s while Web Push is off or unkeyed", async () => {
    m.findFirst.mockResolvedValue(row({ type: "web_push", enabled: false, config: { publicKey: "P", privateKey: "Q" } }));
    await expect(svc.sendWebPushTest("u1")).rejects.toMatchObject({ httpStatus: 400 });
    m.findFirst.mockResolvedValue(null);
    await expect(svc.sendWebPushTest("u1")).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("queries only the caller's own subscriptions, and 400s when they have none", async () => {
    m.findFirst.mockResolvedValue(keyed);
    m.subFindMany.mockResolvedValue([]);
    await expect(svc.sendWebPushTest("u1")).rejects.toMatchObject({ httpStatus: 400 });
    expect(m.subFindMany.mock.calls[0][0].where).toEqual({ userId: "u1" });
  });

  it("sends to each device, prunes a gone endpoint for that user only, and reports the counts", async () => {
    m.findFirst.mockResolvedValue(keyed);
    m.subFindMany.mockResolvedValue([
      { endpoint: "https://push/a", p256dh: "k", auth: "a", surface: "desktop" },
      { endpoint: "https://push/b", p256dh: "k", auth: "a", surface: "mobile" },
    ]);
    m.sendWebPush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error("410"), { gone: true }));
    const r = await svc.sendWebPushTest("u1", "alice");
    expect(r).toMatchObject({ ok: true, sent: 1, failed: 1, pruned: 1 });
    expect(r.message).toContain("1 dead subscription removed");
    expect(m.subDeleteMany).toHaveBeenCalledWith({ where: { endpoint: "https://push/b", userId: "u1" } });
    expect(m.sendWebPush.mock.calls[0][0]).toEqual({ publicKey: "PUB", privateKey: "PRIV", subject: "mailto:a" });
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "notification_channel.test", level: "info" }));
  });

  it("surfaces the first error and logs a warning when nothing was delivered", async () => {
    m.findFirst.mockResolvedValue(keyed);
    m.subFindMany.mockResolvedValue([{ endpoint: "https://push/a", p256dh: "k", auth: "a", surface: "desktop" }]);
    m.sendWebPush.mockRejectedValue(new Error("network down"));
    const r = await svc.sendWebPushTest("u1");
    expect(r).toMatchObject({ ok: false, sent: 0, failed: 1, pruned: 0 });
    expect(r.message).toContain("network down");
    expect(m.subDeleteMany).not.toHaveBeenCalled();
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "warning" }));
  });
});
