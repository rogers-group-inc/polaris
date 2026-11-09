/**
 * tests/unit/pushClient.test.ts
 *
 * public/js/push.js is a classic script that assigns window.polarisPush, so
 * it's evaluated into a fake browser global here (the assetsFiltersDom idiom).
 *
 * The load-bearing assertion is the ORDER of the two awaits in enable():
 * Notification.requestPermission() must run before any network call, or
 * Safari/iOS drops the click's transient user activation and silently refuses
 * the prompt. That's a one-line regression to reintroduce and impossible to
 * catch without a test.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "push.js"), "utf-8");

interface Harness {
  polarisPush: any;
  calls: string[];
  api: any;
  subscribeArgs: any[];
  setPermission: (p: string) => void;
  setSubscription: (s: any | null) => void;
  registerCount: () => number;
}

function load(opts?: { supported?: boolean; serverEnabled?: boolean }): Harness {
  const calls: string[] = [];
  const subscribeArgs: any[] = [];
  let permission = "default";
  let subscription: any = null;
  let registrations = 0;

  const fakeSub = (endpoint: string) => ({
    endpoint,
    toJSON: () => ({ keys: { p256dh: "p256dh-value", auth: "auth-value" } }),
    unsubscribe: vi.fn(async () => true),
  });

  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => subscription),
      subscribe: vi.fn(async () => {
        calls.push("pushManager.subscribe");
        subscription = fakeSub("https://push.example.com/new");
        return subscription;
      }),
    },
  };

  const api = {
    push: {
      key: vi.fn(async () => {
        calls.push("api.push.key");
        return opts?.serverEnabled === false
          ? { enabled: false, publicKey: "" }
          : { enabled: true, publicKey: "dGVzdC12YXBpZC1rZXk" };
      }),
      subscribe: vi.fn(async (body: any) => {
        calls.push("api.push.subscribe");
        subscribeArgs.push(body);
      }),
      unsubscribe: vi.fn(async () => { calls.push("api.push.unsubscribe"); }),
    },
  };

  const supported = opts?.supported !== false;
  const win: any = {
    isSecureContext: supported,
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    PushManager: supported ? function () {} : undefined,
    Notification: supported
      ? {
          get permission() { return permission; },
          requestPermission: vi.fn(async () => {
            calls.push("Notification.requestPermission");
            return permission === "default" ? "granted" : permission;
          }),
        }
      : undefined,
  };
  if (!supported) { delete win.PushManager; delete win.Notification; }

  const navigator: any = supported
    ? { serviceWorker: { register: vi.fn(async () => { registrations++; return registration; }) } }
    : {};

  const sandbox = { window: win, navigator, api, Notification: win.Notification, Uint8Array };
  new Function("window", "navigator", "api", "Notification", "Uint8Array", SRC)(
    sandbox.window, sandbox.navigator, sandbox.api, sandbox.Notification, Uint8Array,
  );

  return {
    polarisPush: win.polarisPush,
    calls,
    api,
    subscribeArgs,
    setPermission: (p) => { permission = p; },
    setSubscription: (s) => { subscription = s === null ? null : fakeSub(s); },
    registerCount: () => registrations,
  };
}

let h: Harness;
beforeEach(() => { h = load(); });

describe("enable() — user-activation ordering", () => {
  it("requests permission BEFORE any network call", async () => {
    await h.polarisPush.enable({ surface: "mobile" });
    const permIdx = h.calls.indexOf("Notification.requestPermission");
    const keyIdx = h.calls.indexOf("api.push.key");
    expect(permIdx).toBeGreaterThanOrEqual(0);
    expect(keyIdx).toBeGreaterThanOrEqual(0);
    // If this flips, Safari/iOS silently refuse the permission prompt.
    expect(permIdx).toBeLessThan(keyIdx);
  });

  it("does not call the server at all when permission is refused", async () => {
    h.setPermission("denied");
    await expect(h.polarisPush.enable()).rejects.toThrow(/permission was not granted/i);
    expect(h.api.push.key).not.toHaveBeenCalled();
    expect(h.api.push.subscribe).not.toHaveBeenCalled();
  });
});

describe("enable() — surface", () => {
  it("sends the caller's surface to the server", async () => {
    await h.polarisPush.enable({ surface: "mobile" });
    expect(h.subscribeArgs[0].surface).toBe("mobile");
    expect(h.subscribeArgs[0].endpoint).toBe("https://push.example.com/new");
    expect(h.subscribeArgs[0].keys).toEqual({ p256dh: "p256dh-value", auth: "auth-value" });
  });

  it("defaults to desktop when the caller passes nothing", async () => {
    await h.polarisPush.enable();
    expect(h.subscribeArgs[0].surface).toBe("desktop");
  });

  it("normalizes an unknown surface to desktop", async () => {
    await h.polarisPush.enable({ surface: "tablet" });
    expect(h.subscribeArgs[0].surface).toBe("desktop");
  });

  it("errors when the server has no Web Push configured", async () => {
    const off = load({ serverEnabled: false });
    await expect(off.polarisPush.enable()).rejects.toThrow(/isn't enabled on the server/i);
  });
});

describe("reconcileSubscription()", () => {
  it("re-posts the browser's current subscription", async () => {
    h.setSubscription("https://push.example.com/rotated");
    const ok = await h.polarisPush.reconcileSubscription("mobile");
    expect(ok).toBe(true);
    expect(h.subscribeArgs[0]).toMatchObject({
      endpoint: "https://push.example.com/rotated",
      surface: "mobile",
    });
  });

  it("no-ops when the browser holds no subscription", async () => {
    h.setSubscription(null);
    expect(await h.polarisPush.reconcileSubscription("desktop")).toBe(false);
    expect(h.api.push.subscribe).not.toHaveBeenCalled();
  });

  it("never prompts for permission", async () => {
    // It runs on every page load; it must be completely silent.
    h.setSubscription("https://push.example.com/x");
    await h.polarisPush.reconcileSubscription("desktop");
    expect(h.calls).not.toContain("Notification.requestPermission");
  });

  it("swallows a server error rather than surfacing it", async () => {
    h.setSubscription("https://push.example.com/x");
    h.api.push.subscribe.mockRejectedValueOnce(new Error("500"));
    await expect(h.polarisPush.reconcileSubscription("desktop")).resolves.toBe(false);
  });
});

describe("support gate", () => {
  it("reports unsupported and refuses to enable", async () => {
    const un = load({ supported: false });
    expect(un.polarisPush.isSupported()).toBe(false);
    await expect(un.polarisPush.enable()).rejects.toThrow(/doesn't support/i);
    expect(await un.polarisPush.reconcileSubscription("desktop")).toBe(false);
  });
});

describe("registerSW()", () => {
  it("memoizes the registration", async () => {
    await h.polarisPush.registerSW();
    await h.polarisPush.registerSW();
    expect(h.registerCount()).toBe(1);
  });
});

describe("syncToPreference() — the cross-device reconcile", () => {
  // This is what makes the notification preference an ACCOUNT setting rather
  // than a per-browser one (business rule 39): every client calls it at boot
  // and brings its OWN subscription into line. If it stops working, "prefer
  // push" quietly means push only on the device the operator clicked it on —
  // and nothing anywhere reports that.

  it("enrolls silently when the account prefers push and permission is granted", async () => {
    h.setPermission("granted");
    h.setSubscription(null);
    await expect(h.polarisPush.syncToPreference("push", "mobile")).resolves.toBe("enrolled");
    expect(h.calls).toContain("pushManager.subscribe");
    expect(h.subscribeArgs[0].surface).toBe("mobile");
  });

  it("NEVER prompts — a boot-time call has no user activation to spend", async () => {
    // Safari refuses a prompt raised outside a gesture, and a refusal is
    // sticky, so asking here would burn the operator's one chance to say yes.
    h.setPermission("default");
    h.setSubscription(null);
    await expect(h.polarisPush.syncToPreference("push", "desktop")).resolves.toBe("needs-permission");
    expect(h.calls).not.toContain("Notification.requestPermission");
    expect(h.calls).not.toContain("pushManager.subscribe");
  });

  it("un-enrolls this browser when the account has gone back to email", async () => {
    // "Email" is also an instruction to STOP pushing here — which is how a
    // preference set on one device reaches the others.
    h.setPermission("granted");
    h.setSubscription("https://push.example.com/existing");
    await expect(h.polarisPush.syncToPreference("email", "desktop")).resolves.toBe("removed");
    expect(h.calls).toContain("api.push.unsubscribe");
  });

  it("does nothing when the account prefers email and nothing is enrolled", async () => {
    h.setSubscription(null);
    await expect(h.polarisPush.syncToPreference("email", "desktop")).resolves.toBe("");
    expect(h.calls).not.toContain("api.push.unsubscribe");
  });

  it("refreshes an existing subscription instead of re-subscribing", async () => {
    // Browsers rotate endpoints; this pass is the primary repair, so a
    // push-preferring browser that is already enrolled must still re-post.
    h.setPermission("granted");
    h.setSubscription("https://push.example.com/existing");
    await expect(h.polarisPush.syncToPreference("any", "desktop")).resolves.toBe("");
    expect(h.calls).toContain("api.push.subscribe");
    expect(h.calls).not.toContain("pushManager.subscribe");
    expect(h.subscribeArgs[0].endpoint).toBe("https://push.example.com/existing");
  });

  it("treats 'any' as wanting push, not as ambiguous", async () => {
    h.setPermission("granted");
    h.setSubscription(null);
    await expect(h.polarisPush.syncToPreference("any", "desktop")).resolves.toBe("enrolled");
  });

  it("stays silent when the server has no Web Push channel", async () => {
    // Nothing to enroll against, and nothing the operator did wrong — this
    // runs on every page load for someone who clicked nothing.
    const off = load({ serverEnabled: false });
    off.setPermission("granted");
    off.setSubscription(null);
    await expect(off.polarisPush.syncToPreference("push", "desktop")).resolves.toBe("");
    expect(off.calls).not.toContain("pushManager.subscribe");
  });

  it("never throws on an unsupported browser", async () => {
    const un = load({ supported: false });
    await expect(un.polarisPush.syncToPreference("push", "desktop")).resolves.toBe("");
  });
});
