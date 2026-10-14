/**
 * tests/unit/ssrfOutboundCallers.test.ts
 *
 * Business rule 110, the callers. Every place Polaris connects to a host a
 * person typed judges it — by literal in any spelling, and by what its name
 * resolves to — and a redirect cannot carry a request somewhere the guard
 * never saw.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import net from "node:net";
import { _setResolverForTests } from "../../src/utils/netGuard.js";
import { sendWebhook } from "../../src/services/notificationChannels/webhookChannel.js";
import { sendApiCall } from "../../src/services/notificationChannels/apiCallChannel.js";
import { sendWebPush, generateVapidKeys } from "../../src/services/notificationChannels/webPushChannel.js";
import { measureRtt } from "../../src/services/haService.js";
// The channels send through utils/guardedFetch (undici + a connect-time netGuard
// lookup, rule 110). These tests stub the global fetch, so route it there; the
// connect-time guard itself is pinned in tests/unit/guardedFetch.test.ts.
vi.mock("../../src/utils/guardedFetch.js", () => ({
  guardedFetch: (url: string, init: unknown) => (globalThis.fetch as unknown as (u: string, i: unknown) => Promise<Response>)(url, init),
  guardedDispatcher: () => null,
}));

function resolveTo(map: Record<string, string>): void {
  _setResolverForTests({
    all: (h, _o, cb) => (map[h] ? cb(null, [{ address: map[h], family: map[h].includes(":") ? 6 : 4 }]) : cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }) as any, [])),
    allAsync: async (h) => (map[h] ? [{ address: map[h], family: map[h].includes(":") ? 6 : 4 }] : Promise.reject(new Error("ENOTFOUND"))),
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  _setResolverForTests(null);
});

const payload = { title: "t", message: "m", severity: "info" } as any;

describe("webhook channel", () => {
  it.each(["http://127.1/h", "http://2130706433/h", "http://[::ffff:127.0.0.1]/h", "http://169.254.169.254/latest"])(
    "refuses %s before any request",
    async (url) => {
      await expect(sendWebhook(url, "slack", payload)).rejects.toMatchObject({ code: "BLOCKED_HOST" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("refuses a name that resolves to loopback", async () => {
    resolveTo({ "hooks.rebind.example": "127.0.0.1" });
    await expect(sendWebhook("https://hooks.rebind.example/x", "slack", payload)).rejects.toMatchObject({ code: "BLOCKED_HOST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends to a name that resolves to a public address and does not follow redirects", async () => {
    resolveTo({ "hooks.slack.example": "34.1.2.3" });
    await sendWebhook("https://hooks.slack.example/x", "slack", payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
  });

  it("treats a redirect answer as a failure", async () => {
    resolveTo({ "hooks.slack.example": "34.1.2.3" });
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
    await expect(sendWebhook("https://hooks.slack.example/x", "slack", payload)).rejects.toThrow(/HTTP 302/);
  });
});

describe("api_call channel", () => {
  it("refuses a name that resolves to the metadata address", async () => {
    resolveTo({ "api.rebind.example": "169.254.169.254" });
    await expect(sendApiCall({ url: "https://api.rebind.example/x" } as any)).rejects.toMatchObject({ code: "BLOCKED_HOST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not follow redirects", async () => {
    resolveTo({ "api.example.test": "34.1.2.3" });
    await sendApiCall({ url: "https://api.example.test/x" } as any);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
  });
});

describe("web push", () => {
  const vapid = { ...generateVapidKeys(), subject: "mailto:a@example.com" } as any;

  it("refuses an endpoint that resolves to loopback, without a request", async () => {
    resolveTo({ "push.rebind.example": "127.0.0.1" });
    await expect(
      sendWebPush(vapid, { endpoint: "https://push.rebind.example/x", p256dh: "k", auth: "a" } as any, {} as any),
    ).rejects.toThrow(/endpoint refused/i);
  });

  it("refuses a literal metadata endpoint", async () => {
    await expect(
      sendWebPush(vapid, { endpoint: "https://169.254.169.254/x", p256dh: "k", auth: "a" } as any, {} as any),
    ).rejects.toThrow(/endpoint refused/i);
  });
});

describe("HA advisory RTT probe", () => {
  it("never connects to loopback or a metadata address", async () => {
    const spy = vi.spyOn(net.Socket.prototype, "connect");
    expect(await measureRtt("127.0.0.1", 22, 200)).toBeNull();
    expect(await measureRtt("2130706433", 22, 200)).toBeNull();
    expect(await measureRtt("169.254.169.254", 22, 200)).toBeNull();
    expect(await measureRtt("[::ffff:7f00:1]", 22, 200)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
