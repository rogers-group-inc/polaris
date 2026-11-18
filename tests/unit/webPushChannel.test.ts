/**
 * tests/unit/webPushChannel.test.ts — browser / PWA Web Push delivery
 * (CQ-T010). The `web-push` library and netGuard are mocked at the module
 * boundary; the real endpoint guard (rule 110) is pinned by
 * ssrfOutboundCallers.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { setVapidDetails, sendNotification, generateVAPIDKeys, resolveAllowedHost } = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
  generateVAPIDKeys: vi.fn(),
  resolveAllowedHost: vi.fn(),
}));
// Named exports only, as web-push 4 ships them: a mock with a `default` would
// pass while the real module (no default export) fails to load.
vi.mock("web-push", () => ({ setVapidDetails, sendNotification, generateVAPIDKeys }));
vi.mock("../../src/utils/netGuard.js", () => ({ resolveAllowedHost }));

import {
  sendWebPush,
  generateVapidKeys,
  type VapidConfig,
  type WebPushPayload,
  type WebPushError,
} from "../../src/services/notificationChannels/webPushChannel.js";
import { AppError } from "../../src/utils/errors.js";

const vapid = (over: Partial<VapidConfig> = {}): VapidConfig => ({
  publicKey: "PUB",
  privateKey: "PRIV",
  subject: "mailto:ops@example.com",
  ...over,
});
const target = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: "P256", auth: "AUTH" };
const payload: WebPushPayload = {
  title: "sw-01 down",
  body: "No response",
  severity: "error",
  url: "/m/alerts",
  notificationId: "n1",
  ackUrl: "/alert-ack.html?id=n1",
  assetUrl: null,
};

beforeEach(() => {
  setVapidDetails.mockReset();
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  generateVAPIDKeys.mockReset();
  resolveAllowedHost.mockReset();
  resolveAllowedHost.mockResolvedValue("142.250.1.1");
});

describe("sendWebPush — keys and subject", () => {
  it.each([{ publicKey: "" }, { privateKey: "" }])("refuses a channel with no keypair (%o) as a 400", async (over) => {
    const err = await sendWebPush(vapid(over), target, payload).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(400);
    expect(setVapidDetails).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it.each(["mailto:ops@example.com", "https://polaris.example"])("keeps a valid subject %s", async (subject) => {
    await sendWebPush(vapid({ subject }), target, payload);
    expect(setVapidDetails).toHaveBeenCalledWith(subject, "PUB", "PRIV");
  });

  it.each(["", "ops@example.com", "http://polaris.example"])("falls back from an invalid subject %j", async (subject) => {
    await sendWebPush(vapid({ subject }), target, payload);
    expect(setVapidDetails).toHaveBeenCalledWith("mailto:polaris@localhost", "PUB", "PRIV");
  });
});

describe("sendWebPush — endpoint guard", () => {
  it("checks the endpoint's hostname", async () => {
    await sendWebPush(vapid(), target, payload);
    expect(resolveAllowedHost).toHaveBeenCalledWith("fcm.googleapis.com");
  });

  it("a refused endpoint is a statusCode-400 error and nothing is sent", async () => {
    resolveAllowedHost.mockRejectedValue(Object.assign(new Error("host 127.0.0.1 is blocked"), { code: "BLOCKED_HOST" }));
    const err = (await sendWebPush(vapid(), { ...target, endpoint: "https://127.0.0.1/p" }, payload).catch((e) => e)) as WebPushError;
    expect(err.message).toBe("Web push endpoint refused: host 127.0.0.1 is blocked");
    expect(err.statusCode).toBe(400);
    expect(err.gone).toBeUndefined();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("an unparseable endpoint is refused the same way", async () => {
    const err = (await sendWebPush(vapid(), { ...target, endpoint: "not a url" }, payload).catch((e) => e)) as WebPushError;
    expect(err.message).toMatch(/^Web push endpoint refused: /);
    expect(err.statusCode).toBe(400);
    expect(resolveAllowedHost).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("sendWebPush — delivery", () => {
  it("sends the subscription keys and the whole payload as JSON", async () => {
    await sendWebPush(vapid(), target, payload);
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: target.endpoint, keys: { p256dh: "P256", auth: "AUTH" } },
      JSON.stringify(payload),
    );
  });

  it.each([404, 410])("a %i means the subscription is gone", async (statusCode) => {
    sendNotification.mockRejectedValue(Object.assign(new Error("Received unexpected response code"), { statusCode, body: "push subscription has unsubscribed or expired." }));
    const err = (await sendWebPush(vapid(), target, payload).catch((e) => e)) as WebPushError;
    expect(err.gone).toBe(true);
    expect(err.statusCode).toBe(statusCode);
    expect(err.message).toBe(`Web push failed (HTTP ${statusCode}): push subscription has unsubscribed or expired.`);
  });

  it.each([400, 413, 429, 500])("a %i is a failure but not gone", async (statusCode) => {
    sendNotification.mockRejectedValue(Object.assign(new Error("bad"), { statusCode }));
    const err = (await sendWebPush(vapid(), target, payload).catch((e) => e)) as WebPushError;
    expect(err.gone).toBe(false);
    expect(err.statusCode).toBe(statusCode);
    expect(err.message).toBe(`Web push failed (HTTP ${statusCode}): bad`);
  });

  it("a transport error with no status is a failure, not gone", async () => {
    sendNotification.mockRejectedValue(new Error("ECONNRESET"));
    const err = (await sendWebPush(vapid(), target, payload).catch((e) => e)) as WebPushError;
    expect(err.message).toBe("Web push failed: ECONNRESET");
    expect(err.statusCode).toBeUndefined();
    expect(err.gone).toBe(false);
  });

  it("an empty rejection still reads", async () => {
    sendNotification.mockRejectedValue(undefined);
    const err = (await sendWebPush(vapid(), target, payload).catch((e) => e)) as WebPushError;
    expect(err.message).toBe("Web push failed: unknown");
  });
});

describe("generateVapidKeys", () => {
  it("returns the library's fresh keypair", () => {
    generateVAPIDKeys.mockReturnValue({ publicKey: "p", privateKey: "q" });
    expect(generateVapidKeys()).toEqual({ publicKey: "p", privateKey: "q" });
    expect(generateVAPIDKeys).toHaveBeenCalledTimes(1);
  });
});
