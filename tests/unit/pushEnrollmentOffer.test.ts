/**
 * tests/unit/pushEnrollmentOffer.test.ts
 *
 * The one-time enrollment offer (business rule 39).
 *
 * `syncToPreference` enrolls a browser whose permission is ALREADY granted and
 * deliberately never prompts, so the account's choice of push could not reach a
 * browser signing in for the first time: permission sits at "default", nothing
 * may raise the prompt without user activation, and the operator had to go and
 * re-pick the preference from the account menu on every new laptop, profile or
 * re-install. This is the question that closes that gap, and three properties
 * of it are worth pinning because each fails silently:
 *
 *   The GATE. Asking is only ever right at permission "default". "granted"
 *   means the silent reconcile has already done it, and "denied" cannot be
 *   re-prompted from script at all — a dialog there is one whose button
 *   provably does nothing.
 *
 *   The ONCE. The offer records itself when it is SHOWN, not when a button is
 *   clicked, because the scrim, the X and Escape hand back no callback. If that
 *   moves to the buttons, the dialog reopens on every page navigation until it
 *   is answered exactly one way, which is a nag.
 *
 *   The ORDERING. enable() must be the first statement of the click handler —
 *   before the dialog is torn down and before any await — or Safari drops the
 *   click's transient user activation and refuses the permission prompt. The
 *   same one-line regression push.js's own test pins for enable().
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PUSH_JS = readFileSync(join(process.cwd(), "public", "js", "push.js"), "utf-8");
const APP_JS = readFileSync(join(process.cwd(), "public", "js", "app.js"), "utf-8");
const MOBILE_APP_JS = readFileSync(join(process.cwd(), "public", "js", "mobile", "app.js"), "utf-8");

/** Lifts a brace-balanced function out of a file so we don't boot the page. */
function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

function extractVar(src: string, decl: string): string {
  const start = src.indexOf(decl);
  if (start < 0) throw new Error(`${decl} not found`);
  return src.slice(start, src.indexOf("\n", start));
}

// ─── push.js: shouldOfferEnrollment / recordOfferMade ────────────────────────

interface PushHarness {
  polarisPush: any;
  calls: string[];
  api: any;
  store: Record<string, string>;
}

function loadPush(opts?: {
  permission?: string;
  subscribed?: boolean;
  serverEnabled?: boolean;
  storageThrows?: boolean;
  store?: Record<string, string>;
}): PushHarness {
  const calls: string[] = [];
  const permission = opts?.permission ?? "default";
  const store: Record<string, string> = opts?.store ?? {};

  const subscription = opts?.subscribed
    ? { endpoint: "https://push.example.com/live", toJSON: () => ({ keys: { p256dh: "p", auth: "a" } }) }
    : null;

  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => { calls.push("getSubscription"); return subscription; }),
      subscribe: vi.fn(async () => subscription),
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
      subscribe: vi.fn(async () => { calls.push("api.push.subscribe"); }),
      unsubscribe: vi.fn(async () => {}),
    },
  };

  const localStorage = opts?.storageThrows
    ? {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
      }
    : {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = String(v); },
      };

  const win: any = {
    isSecureContext: true,
    localStorage,
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    PushManager: function () {},
    Notification: {
      get permission() { return permission; },
      requestPermission: vi.fn(async () => { calls.push("requestPermission"); return "granted"; }),
    },
  };
  const navigator: any = { serviceWorker: { register: vi.fn(async () => registration) } };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("window", "navigator", "api", "Notification", "Uint8Array", PUSH_JS)(
    win, navigator, api, win.Notification, Uint8Array,
  );

  return { polarisPush: win.polarisPush, calls, api, store };
}

describe("shouldOfferEnrollment() — when a browser is asked at all", () => {
  it("asks when the account prefers push and this browser has never been asked", async () => {
    const h = loadPush();
    expect(await h.polarisPush.shouldOfferEnrollment("push", { username: "dmoore" })).toBe(true);
  });

  it("asks for the both-methods preference too", async () => {
    const h = loadPush();
    expect(await h.polarisPush.shouldOfferEnrollment("any", { username: "dmoore" })).toBe(true);
  });

  it("never asks an account that prefers email", async () => {
    const h = loadPush();
    expect(await h.polarisPush.shouldOfferEnrollment("email", { username: "dmoore" })).toBe(false);
    // Not even far enough to look at the browser.
    expect(h.calls).toEqual([]);
  });

  it("never asks when permission is already granted — the silent reconcile owns that browser", async () => {
    const h = loadPush({ permission: "granted" });
    expect(await h.polarisPush.shouldOfferEnrollment("push", { username: "dmoore" })).toBe(false);
  });

  it("never asks when permission is denied — script cannot re-prompt, so the button would do nothing", async () => {
    const h = loadPush({ permission: "denied" });
    expect(await h.polarisPush.shouldOfferEnrollment("push", { username: "dmoore" })).toBe(false);
  });

  it("never asks a browser that already holds a subscription", async () => {
    const h = loadPush({ subscribed: true });
    expect(await h.polarisPush.shouldOfferEnrollment("push", { username: "dmoore" })).toBe(false);
  });

  it("never asks when the SERVER has no Web Push configured", async () => {
    const h = loadPush({ serverEnabled: false });
    expect(await h.polarisPush.shouldOfferEnrollment("push", { username: "dmoore" })).toBe(false);
  });

  it("takes the server's answer from a status() the caller already read", async () => {
    const h = loadPush();
    expect(await h.polarisPush.shouldOfferEnrollment("push", {
      username: "dmoore",
      status: { enabledOnServer: true, permission: "default", subscribed: false, supported: true },
    })).toBe(true);
    expect(h.api.push.key).not.toHaveBeenCalled();
  });

  it("stays silent when the server read fails rather than surfacing it", async () => {
    const h = loadPush();
    h.api.push.key.mockRejectedValueOnce(new Error("403"));
    expect(await h.polarisPush.shouldOfferEnrollment("push", { username: "dmoore" })).toBe(false);
  });

  it("never prompts on its own", async () => {
    const h = loadPush();
    await h.polarisPush.shouldOfferEnrollment("push", { username: "dmoore" });
    expect(h.calls).not.toContain("requestPermission");
  });
});

describe("the offer is made once per account per browser", () => {
  it("does not ask again once the offer has been recorded", async () => {
    const store: Record<string, string> = {};
    const first = loadPush({ store });
    expect(await first.polarisPush.shouldOfferEnrollment("push", { username: "dmoore" })).toBe(true);
    first.polarisPush.recordOfferMade("dmoore");

    // A later page load is a fresh evaluation of push.js against the same store.
    const second = loadPush({ store });
    expect(await second.polarisPush.shouldOfferEnrollment("push", { username: "dmoore" })).toBe(false);
  });

  it("keys the record per account, so a second operator on this browser is still asked", async () => {
    const store: Record<string, string> = {};
    const h = loadPush({ store });
    h.polarisPush.recordOfferMade("dmoore");
    expect(await h.polarisPush.shouldOfferEnrollment("push", { username: "dmoore" })).toBe(false);
    expect(await h.polarisPush.shouldOfferEnrollment("push", { username: "someone-else" })).toBe(true);
  });

  it("falls back to memory when storage is blocked, rather than asking twice in one page load", async () => {
    const h = loadPush({ storageThrows: true });
    expect(await h.polarisPush.shouldOfferEnrollment("push", { username: "dmoore" })).toBe(true);
    h.polarisPush.recordOfferMade("dmoore");
    expect(await h.polarisPush.shouldOfferEnrollment("push", { username: "dmoore" })).toBe(false);
  });
});

// ─── app.js: the desktop dialog ──────────────────────────────────────────────

type DesktopRun = {
  calls: string[];
  modals: { title: string; body: string; footer: string }[];
  recorded: string[];
  offer: () => Promise<void>;
};

function desktopHarness(opts: {
  shouldOffer?: boolean;
  pref?: string;
  enableFails?: string;
  hasPolarisPush?: boolean;
}): DesktopRun {
  const calls: string[] = [];
  const modals: { title: string; body: string; footer: string }[] = [];
  const recorded: string[] = [];
  const g = globalThis as any;

  g.polarisPush = opts.hasPolarisPush === false ? undefined : {
    shouldOfferEnrollment: vi.fn(async () => {
      calls.push("shouldOfferEnrollment");
      return opts.shouldOffer !== false;
    }),
    recordOfferMade: (u: string) => { calls.push("recordOfferMade"); recorded.push(u); },
    enable: vi.fn(() => {
      calls.push("enable");
      return opts.enableFails
        ? Promise.reject(new Error(opts.enableFails))
        : Promise.resolve(true);
    }),
    status: vi.fn(async () => ({ supported: true, enabledOnServer: true, permission: "granted", subscribed: true })),
  };
  g.openModal = (title: string, body: string, footer: string) => {
    calls.push("openModal");
    modals.push({ title, body, footer });
    document.body.innerHTML = '<div class="modal-footer">' + footer + "</div>";
  };
  g.closeModal = () => { calls.push("closeModal"); };
  g.showToast = (msg: string, kind: string) => { calls.push("toast:" + kind + ":" + msg); };
  g.escapeHtml = (s: any) => String(s ?? "");

  const SRC = [
    "var _pushOfferHandled = false;",
    `var _notifPref = ${JSON.stringify(opts.pref ?? "push")};`,
    "var _pushState = { enabledOnServer: true, permission: 'default', subscribed: false, supported: true };",
    'var currentUsername = "dmoore";',
    extractVar(APP_JS, "var NOTIF_PREF_LABELS ="),
    extractFn(APP_JS, "_maybeOfferPushEnrollment"),
    extractFn(APP_JS, "_openPushOfferDialog"),
    "return { offer: _maybeOfferPushEnrollment };",
  ].join("\n");

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const mod = new Function(SRC)() as { offer: () => Promise<void> };
  return { calls, modals, recorded, offer: mod.offer };
}

describe("the desktop offer", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("opens a dialog naming the account's preference, with Enable and Not now", async () => {
    const h = desktopHarness({ shouldOffer: true });
    await h.offer();
    expect(h.modals).toHaveLength(1);
    expect(h.modals[0].title).toBe("Push notifications");
    expect(h.modals[0].body).toContain("this browser has never been enrolled");
    expect(h.modals[0].footer).toContain("Enable");
    expect(h.modals[0].footer).toContain("Not now");
  });

  it("records the offer when it is SHOWN, so any way of dismissing it is final", async () => {
    const h = desktopHarness({ shouldOffer: true });
    await h.offer();
    // No button has been touched.
    expect(h.recorded).toEqual(["dmoore"]);
    expect(h.calls.indexOf("recordOfferMade")).toBeGreaterThan(h.calls.indexOf("openModal"));
  });

  it("opens nothing when this browser is not one to ask", async () => {
    const h = desktopHarness({ shouldOffer: false });
    await h.offer();
    expect(h.modals).toHaveLength(0);
    expect(h.calls).not.toContain("recordOfferMade");
  });

  it("checks at most once per page load — renderNav runs twice on a cold cache", async () => {
    const h = desktopHarness({ shouldOffer: true });
    await h.offer();
    await h.offer();
    expect(h.calls.filter((c) => c === "shouldOfferEnrollment")).toHaveLength(1);
    expect(h.modals).toHaveLength(1);
  });

  it("enrolls on Enable, calling enable() BEFORE the dialog is torn down", async () => {
    const h = desktopHarness({ shouldOffer: true });
    await h.offer();
    (document.getElementById("push-offer-enable") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    // If closeModal (or anything awaited) came first, Safari would refuse the
    // permission prompt this click is the activation for.
    expect(h.calls.indexOf("enable")).toBeLessThan(h.calls.indexOf("closeModal"));
    expect(h.calls.some((c) => c.startsWith("toast:success"))).toBe(true);
  });

  it("says what happened when the browser refuses, and does not re-ask", async () => {
    const h = desktopHarness({ shouldOffer: true, enableFails: "Notification permission was not granted." });
    await h.offer();
    (document.getElementById("push-offer-enable") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.some((c) => c.startsWith("toast:warning"))).toBe(true);
  });

  it("just closes on Not now", async () => {
    const h = desktopHarness({ shouldOffer: true });
    await h.offer();
    (document.getElementById("push-offer-dismiss") as HTMLButtonElement).click();
    expect(h.calls).toContain("closeModal");
    expect(h.calls).not.toContain("enable");
  });

  it("does nothing at all in a browser with no push support wired up", async () => {
    const h = desktopHarness({ hasPolarisPush: false });
    await h.offer();
    expect(h.modals).toHaveLength(0);
  });
});

// ─── mobile/app.js: the bottom sheet ─────────────────────────────────────────

function mobileHarness(opts: {
  shouldOffer?: boolean;
  ios?: boolean;
  standalone?: boolean;
  enableFails?: string;
}) {
  const calls: string[] = [];
  const recorded: string[] = [];
  const snacks: string[] = [];
  const g = globalThis as any;

  g.polarisPush = {
    shouldOfferEnrollment: vi.fn(async (pref: string) => {
      calls.push("shouldOfferEnrollment:" + pref);
      return opts.shouldOffer !== false;
    }),
    recordOfferMade: (u: string) => { calls.push("recordOfferMade"); recorded.push(u); },
    enable: vi.fn((o: any) => {
      calls.push("enable:" + (o && o.surface));
      return opts.enableFails ? Promise.reject(new Error(opts.enableFails)) : Promise.resolve(true);
    }),
  };
  g.PolarisInstall = {
    isIos: () => !!opts.ios,
    isStandalone: () => !!opts.standalone,
  };
  g.PolarisTabs = { showSnackbar: (m: string) => { calls.push("snack"); snacks.push(m); } };

  const SRC = [
    'var currentUser = { username: "dmoore" };',
    extractFn(MOBILE_APP_JS, "maybeOfferPushEnrollment"),
    extractFn(MOBILE_APP_JS, "openPushOfferSheet"),
    "return { offer: maybeOfferPushEnrollment };",
  ].join("\n");

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const mod = new Function(SRC)() as { offer: (p: string) => Promise<void> | undefined };
  return { calls, recorded, snacks, offer: mod.offer };
}

describe("the mobile offer", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("opens a sheet with Enable and Not now, and records the offer on open", async () => {
    const h = mobileHarness({ shouldOffer: true });
    await h.offer("push");
    expect(document.querySelector(".sheet")).not.toBeNull();
    expect(document.querySelector(".scrim")).not.toBeNull();
    expect(document.getElementById("push-offer-enable")).not.toBeNull();
    expect(document.getElementById("push-offer-dismiss")).not.toBeNull();
    expect(h.recorded).toEqual(["dmoore"]);
  });

  it("never asks a phone on iOS outside the installed app — the button could only throw there", async () => {
    const h = mobileHarness({ shouldOffer: true, ios: true, standalone: false });
    await h.offer("push");
    expect(h.calls).toEqual([]);
    expect(document.querySelector(".sheet")).toBeNull();
  });

  it("asks once iOS is running the home-screen app", async () => {
    const h = mobileHarness({ shouldOffer: true, ios: true, standalone: true });
    await h.offer("push");
    expect(document.querySelector(".sheet")).not.toBeNull();
  });

  it("passes the account's own preference through, so a failed read asks nothing", async () => {
    const h = mobileHarness({ shouldOffer: false });
    await h.offer("email");
    expect(h.calls).toContain("shouldOfferEnrollment:email");
    expect(document.querySelector(".sheet")).toBeNull();
  });

  it("enrolls on Enable, calling enable() BEFORE the sheet is torn down", async () => {
    const h = mobileHarness({ shouldOffer: true });
    await h.offer("push");
    (document.getElementById("push-offer-enable") as HTMLButtonElement).click();
    expect(h.calls).toContain("enable:mobile");
    expect(document.querySelector(".sheet")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.snacks[0]).toMatch(/on for this phone/i);
  });

  it("dismisses on Not now without enrolling", async () => {
    const h = mobileHarness({ shouldOffer: true });
    await h.offer("push");
    (document.getElementById("push-offer-dismiss") as HTMLButtonElement).click();
    expect(document.querySelector(".sheet")).toBeNull();
    expect(h.calls.some((c) => c.startsWith("enable"))).toBe(false);
  });
});
