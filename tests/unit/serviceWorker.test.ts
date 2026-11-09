/**
 * tests/unit/serviceWorker.test.ts
 *
 * public/sw.js runs in a worker global with no DOM, so it's evaluated into a
 * fake `self` here and the registered handlers are invoked directly. None of
 * this is reachable from a server test, and a regression here breaks
 * notifications on BOTH surfaces at once (one registration per origin).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "sw.js"), "utf-8");

const ORIGIN = "https://polaris.example.com";

function makeSelf(opts?: { clients?: any[]; cookie?: string | null; fetchFails?: "status" | "throw" }) {
  const handlers: Record<string, (e: any) => void> = {};
  const shown: Array<{ title: string; options: any }> = [];
  const navigated: Array<{ from: string; to: string }> = [];
  const opened: string[] = [];
  const focused: string[] = [];
  const fetches: Array<{ url: string; init: any }> = [];

  const clientList = (opts?.clients ?? []).map((url: string) => ({
    url,
    focus: vi.fn(async () => { focused.push(url); }),
    navigate: vi.fn(async (to: string) => { navigated.push({ from: url, to }); }),
  }));

  const self: any = {
    location: { origin: ORIGIN, href: ORIGIN + "/sw.js" },
    addEventListener: (name: string, fn: any) => { handlers[name] = fn; },
    skipWaiting: vi.fn(),
    registration: {
      showNotification: vi.fn(async (title: string, options: any) => { shown.push({ title, options }); }),
      pushManager: { subscribe: vi.fn(async () => null) },
    },
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: vi.fn(async () => clientList),
      openWindow: vi.fn(async (u: string) => { opened.push(u); }),
    },
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    cookieStore: opts?.cookie === null ? undefined : { get: vi.fn(async () => ({ value: opts?.cookie ?? "csrf-token-value" })) },
    fetch: vi.fn(async (url: string, init: any) => {
      fetches.push({ url, init });
      // The acknowledge path must survive both failure shapes: a refusal the
      // server answered (expired/spent/forbidden token) and no answer at all.
      if (opts?.fetchFails === "throw") throw new Error("offline");
      if (opts?.fetchFails === "status") return { ok: false, status: 410, json: async () => ({ ok: false, state: "used" }) };
      return { ok: true, json: async () => ({ enabled: true, publicKey: "dGVzdC12YXBpZC1rZXk" }) };
    }),
  };

  new Function("self", "fetch", "URL", "Uint8Array", "Object", "JSON", SRC)(
    self, self.fetch, URL, Uint8Array, Object, JSON,
  );

  return { self, handlers, shown, navigated, opened, focused, fetches, clientList };
}

/** Drive an event handler and await whatever it passed to waitUntil. */
async function fire(handlers: Record<string, any>, name: string, event: any) {
  const waits: Promise<any>[] = [];
  await handlers[name]({ ...event, waitUntil: (p: any) => waits.push(Promise.resolve(p)) });
  await Promise.all(waits);
}

describe("push handler", () => {
  it("shows a branded notification and never references the missing favicon", async () => {
    const h = makeSelf();
    await fire(h.handlers, "push", {
      data: { json: () => ({ title: "[CRITICAL] gw-01", body: "CPU 98%", url: ORIGIN + "/mobile.html#more/alerts", severity: "critical", notificationId: "n1" }) },
    });
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0].title).toBe("[CRITICAL] gw-01");
    expect(h.shown[0].options.icon).toBe("/icons/app-192.png");
    // /favicon.ico does not exist in this repo — referencing it is what made
    // every notification render with the browser's default glyph.
    expect(JSON.stringify(h.shown[0].options)).not.toContain("favicon");
    // badge omitted on purpose: Android masks it to a white blob.
    expect(h.shown[0].options.badge).toBeUndefined();
    expect(h.shown[0].options.requireInteraction).toBe(true);
    expect(h.shown[0].options.tag).toBe("n1");
  });

  it("keeps only serious/critical on screen — the old check read a severity the server never sends", async () => {
    // SEVERITIES is a closed enum (notice/informational/warning/serious/
    // critical). sw.js compared against "error", so requireInteraction was
    // dead code and NO alert was ever sticky.
    const loud = makeSelf();
    await fire(loud.handlers, "push", { data: { json: () => ({ title: "t", severity: "serious" }) } });
    expect(loud.shown[0].options.requireInteraction).toBe(true);

    const quiet = makeSelf();
    await fire(quiet.handlers, "push", { data: { json: () => ({ title: "t", severity: "warning" }) } });
    expect(quiet.shown[0].options.requireInteraction).toBe(false);

    const legacy = makeSelf();
    await fire(legacy.handlers, "push", { data: { json: () => ({ title: "t", severity: "error" }) } });
    expect(legacy.shown[0].options.requireInteraction).toBe(false);
  });

  it("survives a non-JSON payload", async () => {
    const h = makeSelf();
    await fire(h.handlers, "push", {
      data: { json: () => { throw new Error("not json"); }, text: () => "plain text" },
    });
    expect(h.shown[0].title).toBe("Polaris");
    expect(h.shown[0].options.body).toBe("plain text");
  });

  it("falls back to the desktop page when the payload carries no url", async () => {
    const h = makeSelf();
    await fire(h.handlers, "push", { data: { json: () => ({ title: "t", body: "b" }) } });
    expect(h.shown[0].options.data.url).toBe("/automations.html");
  });
});

describe("notificationclick", () => {
  it("navigates an open client to the server-chosen deep link", async () => {
    // The server already picked the surface (PushSubscription.surface); the
    // worker must not second-guess it.
    const h = makeSelf({ clients: [ORIGIN + "/mobile.html#assets"] });
    await fire(h.handlers, "notificationclick", {
      notification: { close: vi.fn(), data: { url: ORIGIN + "/mobile.html#more/alerts" } },
    });
    expect(h.navigated).toEqual([{ from: ORIGIN + "/mobile.html#assets", to: ORIGIN + "/mobile.html#more/alerts" }]);
    expect(h.focused).toHaveLength(1);
  });

  it("focuses WITHOUT navigating when the client is already there", async () => {
    // The old code navigated unconditionally, reloading a correct page and
    // throwing away scroll position + in-flight state.
    const target = ORIGIN + "/automations.html";
    const h = makeSelf({ clients: [target] });
    await fire(h.handlers, "notificationclick", {
      notification: { close: vi.fn(), data: { url: target } },
    });
    expect(h.navigated).toHaveLength(0);
    expect(h.focused).toEqual([target]);
  });

  it("resolves a RELATIVE url (POLARIS_PUBLIC_URL unset) against the origin", async () => {
    const h = makeSelf({ clients: [ORIGIN + "/index.html"] });
    await fire(h.handlers, "notificationclick", {
      notification: { close: vi.fn(), data: { url: "/mobile.html#more/alerts" } },
    });
    expect(h.navigated[0].to).toBe(ORIGIN + "/mobile.html#more/alerts");
  });

  it("opens a new window when nothing is open", async () => {
    const h = makeSelf({ clients: [] });
    await fire(h.handlers, "notificationclick", {
      notification: { close: vi.fn(), data: { url: "/mobile.html#more/alerts" } },
    });
    expect(h.opened).toEqual(["/mobile.html#more/alerts"]);
  });
});

describe("acknowledge action", () => {
  // The alert's acknowledge PAGE, not a token link — business rule 25. The
  // same URL reaches every recipient, and the page behind it decides who may
  // act, which is why the button below is unconditional.
  const ACK = ORIGIN + "/alert-ack.html?id=n1";
  const ackNotification = (over?: any) => ({
    close: vi.fn(),
    data: { url: ORIGIN + "/automations.html", ackUrl: ACK, notificationId: "n1", ...over },
  });

  it("offers the button whenever the payload carries the page URL", async () => {
    const withLink = makeSelf();
    await fire(withLink.handlers, "push", { data: { json: () => ({ title: "t", ackUrl: ACK, notificationId: "n1" }) } });
    expect(withLink.shown[0].options.actions).toEqual([{ action: "ack", title: "Acknowledge" }]);
    expect(withLink.shown[0].options.data.ackUrl).toBe(ACK);

    // A pre-cutover payload (or an install with no public URL) sends none, and
    // the worker must not render a button that goes nowhere.
    const without = makeSelf();
    await fire(without.handlers, "push", { data: { json: () => ({ title: "t", notificationId: "n1" }) } });
    expect(without.shown[0].options.actions).toBeUndefined();
    expect(without.shown[0].options.data.ackUrl).toBeNull();
  });

  it("OPENS the acknowledge page and acknowledges nothing itself", async () => {
    const h = makeSelf({ clients: [] });
    await fire(h.handlers, "notificationclick", { action: "ack", notification: ackNotification() });

    // The whole point of the cutover: no request leaves the worker. Who
    // acknowledged is the session on the page, and the note is typed there.
    expect(h.fetches.filter((f) => f.init && f.init.method === "POST")).toHaveLength(0);
    expect(h.shown).toHaveLength(0);
    // `src=push` is audit provenance the page forwards on acknowledge.
    expect(h.opened).toEqual([ACK + "&src=push"]);
  });

  it("navigates an already-open tab to the page rather than opening a second one", async () => {
    const h = makeSelf({ clients: [ORIGIN + "/index.html"] });
    await fire(h.handlers, "notificationclick", { action: "ack", notification: ackNotification() });
    expect(h.opened).toHaveLength(0);
    expect(h.navigated).toEqual([{ from: ORIGIN + "/index.html", to: ACK + "&src=push" }]);
  });

  it("never navigates to another origin", async () => {
    const h = makeSelf({ clients: [] });
    await fire(h.handlers, "notificationclick", {
      action: "ack",
      notification: ackNotification({ ackUrl: "https://evil.example.net/alert-ack.html?id=n1" }),
    });
    expect(h.fetches).toHaveLength(0);
    expect(h.opened).toEqual([ORIGIN + "/automations.html"]);
  });

  it("still just opens the app on a plain body tap, link or no link", async () => {
    const h = makeSelf({ clients: [] });
    await fire(h.handlers, "notificationclick", { notification: ackNotification() });
    expect(h.fetches).toHaveLength(0);
    expect(h.opened).toEqual([ORIGIN + "/automations.html"]);
  });
});

describe("ignore action", () => {
  // There is no duration member in NotificationOptions, so a serious/critical
  // alert stays on screen via `requireInteraction` and Windows honours that
  // literally — the toast never auto-dismisses. Ignore is the button that
  // clears it, and it must clear it WITHOUT meaning anything to the server.
  it("rides along on a sticky alert, behind Acknowledge", async () => {
    const h = makeSelf();
    await fire(h.handlers, "push", {
      data: { json: () => ({ title: "t", severity: "critical", ackUrl: ORIGIN + "/alert-ack.html?id=n1", notificationId: "n1" }) },
    });
    // Chrome drops overflow past maxActions from the END, so the action that
    // actually does something has to be first.
    expect(h.shown[0].options.actions).toEqual([
      { action: "ack", title: "Acknowledge" },
      { action: "ignore", title: "Ignore" },
    ]);
  });

  it("is the only action when the recipient cannot acknowledge", async () => {
    // A role below alerts:write gets no ackUrl (business rule 25). The alert is
    // still sticky, so it still needs a way off the screen.
    const h = makeSelf();
    await fire(h.handlers, "push", { data: { json: () => ({ title: "t", severity: "serious" }) } });
    expect(h.shown[0].options.actions).toEqual([{ action: "ignore", title: "Ignore" }]);
  });

  it("is NOT offered on an alert that clears itself", async () => {
    // A transient notification goes away on the OS banner timer; a button to
    // hurry that along is noise, and it would make the button set vary for no
    // reason the operator can see.
    const h = makeSelf();
    await fire(h.handlers, "push", {
      data: { json: () => ({ title: "t", severity: "warning", ackUrl: ORIGIN + "/alert-ack.html?id=n1" }) },
    });
    expect(h.shown[0].options.actions).toEqual([{ action: "ack", title: "Acknowledge" }]);
  });

  it("yields its slot to Acknowledge and Open device when both apply", async () => {
    // Notification.maxActions is 2 and the overflow is dropped from the end,
    // so the order in sw.js IS the priority. Ignore is last because the
    // Windows toast already carries its own close button; the other two do
    // something no platform affordance can.
    const h = makeSelf();
    await fire(h.handlers, "push", {
      data: { json: () => ({
        title: "t", severity: "critical", notificationId: "n1",
        ackUrl: ORIGIN + "/alert-ack.html?id=n1",
        assetUrl: ORIGIN + "/assets.html#view=asset:a1",
      }) },
    });
    expect(h.shown[0].options.actions).toEqual([
      { action: "ack", title: "Acknowledge" },
      { action: "open-asset", title: "Open device" },
    ]);
  });

  it("takes the free slot when the reader cannot acknowledge", async () => {
    const h = makeSelf();
    await fire(h.handlers, "push", {
      data: { json: () => ({ title: "t", severity: "serious", assetUrl: ORIGIN + "/assets.html#view=asset:a1" }) },
    });
    expect(h.shown[0].options.actions).toEqual([
      { action: "open-asset", title: "Open device" },
      { action: "ignore", title: "Ignore" },
    ]);
  });

  it("closes the notification and does nothing else", async () => {
    // The bug this guards: an unrecognized action falls through to the
    // focusOrOpen at the bottom of the handler, so a missing early return
    // makes Ignore open the app — the opposite of ignoring.
    const close = vi.fn();
    const h = makeSelf({ clients: [ORIGIN + "/index.html"] });
    await fire(h.handlers, "notificationclick", {
      action: "ignore",
      notification: { close, data: { url: ORIGIN + "/automations.html", ackUrl: ORIGIN + "/alert-ack.html?id=n1" } },
    });
    expect(close).toHaveBeenCalled();
    expect(h.opened).toHaveLength(0);
    expect(h.navigated).toHaveLength(0);
    expect(h.focused).toHaveLength(0);
    // Nothing reaches the server: a tray button has no session, so it cannot
    // mean the alert was handled. It keeps escalating.
    expect(h.fetches).toHaveLength(0);
  });
});

describe("open device action", () => {
  const ASSET = ORIGIN + "/assets.html#view=asset:a1";
  const notif = (over?: any) => ({
    close: vi.fn(),
    data: { url: ORIGIN + "/automations.html", assetUrl: ASSET, notificationId: "n1", ...over },
  });

  it("opens the device page, not the server-chosen alerts deep link", async () => {
    // The body tap still goes to the alerts list — right for triage across
    // several alerts, two taps from the one device this alert is about.
    const h = makeSelf({ clients: [] });
    await fire(h.handlers, "notificationclick", { action: "open-asset", notification: notif() });
    expect(h.opened).toEqual([ASSET]);
  });

  it("navigates an open tab rather than opening a second one", async () => {
    const h = makeSelf({ clients: [ORIGIN + "/index.html"] });
    await fire(h.handlers, "notificationclick", { action: "open-asset", notification: notif() });
    expect(h.opened).toHaveLength(0);
    expect(h.navigated).toEqual([{ from: ORIGIN + "/index.html", to: ASSET }]);
  });

  it("falls back to the deep link rather than navigating off-origin", async () => {
    const h = makeSelf({ clients: [] });
    await fire(h.handlers, "notificationclick", {
      action: "open-asset",
      notification: notif({ assetUrl: "https://evil.example.net/assets.html#view=asset:a1" }),
    });
    expect(h.opened).toEqual([ORIGIN + "/automations.html"]);
  });

  it("is absent on an alert with no device behind it", async () => {
    // A capacity warning, a failed backup, a discovery error: the server sends
    // no assetUrl and the button must not point at #view=asset:undefined.
    const h = makeSelf();
    await fire(h.handlers, "push", { data: { json: () => ({ title: "t", severity: "critical", ackUrl: ORIGIN + "/alert-ack.html?id=n1" }) } });
    expect(h.shown[0].options.actions).toEqual([
      { action: "ack", title: "Acknowledge" },
      { action: "ignore", title: "Ignore" },
    ]);
  });
});

describe("pushsubscriptionchange", () => {
  const newSub = (endpoint: string) => ({
    endpoint,
    toJSON: () => ({ keys: { p256dh: "p", auth: "a" } }),
  });

  it("re-registers the new endpoint and names the one it replaced", async () => {
    const h = makeSelf();
    await fire(h.handlers, "pushsubscriptionchange", {
      oldSubscription: { endpoint: "https://push/old", options: { applicationServerKey: new Uint8Array([1, 2, 3]) } },
      newSubscription: newSub("https://push/new"),
    });
    const post = h.fetches.find((f) => f.init && f.init.method === "POST");
    expect(post).toBeTruthy();
    const body = JSON.parse(post!.init.body);
    expect(body.endpoint).toBe("https://push/new");
    // oldEndpoint is how the server carries `surface` forward — a rotation
    // mints a new endpoint, so there's no row to inherit from.
    expect(body.oldEndpoint).toBe("https://push/old");
    expect(post!.init.headers["X-CSRF-Token"]).toBe("csrf-token-value");
    expect(post!.init.credentials).toBe("include");
  });

  it("fetches the VAPID key when the old subscription doesn't expose one", async () => {
    const h = makeSelf();
    await fire(h.handlers, "pushsubscriptionchange", {
      oldSubscription: { endpoint: "https://push/old", options: {} },
      newSubscription: newSub("https://push/new"),
    });
    expect(h.fetches.some((f) => f.url.includes("/push-subscriptions/key"))).toBe(true);
    expect(h.fetches.some((f) => f.init && f.init.method === "POST")).toBe(true);
  });

  it("gives up quietly when no key is obtainable", async () => {
    const h = makeSelf();
    h.self.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: false, publicKey: "" }) });
    await fire(h.handlers, "pushsubscriptionchange", {
      oldSubscription: { endpoint: "https://push/old", options: {} },
      newSubscription: newSub("https://push/new"),
    });
    expect(h.fetches.some((f) => f.init && f.init.method === "POST")).toBe(false);
  });

  it("does not throw when the whole flow fails", async () => {
    const h = makeSelf();
    h.self.fetch.mockRejectedValue(new Error("offline"));
    await expect(fire(h.handlers, "pushsubscriptionchange", {
      oldSubscription: { endpoint: "https://push/old", options: {} },
    })).resolves.toBeUndefined();
  });
});

describe("offline posture", () => {
  it("registers NO fetch handler", () => {
    // Polaris is online-only. A fetch handler here would turn this into a
    // caching layer that can serve stale app code.
    const h = makeSelf();
    expect(h.handlers.fetch).toBeUndefined();
    expect(Object.keys(h.handlers).sort()).toEqual(
      ["activate", "install", "notificationclick", "push", "pushsubscriptionchange"],
    );
  });

  it("contains no Cache Storage usage", () => {
    expect(SRC).not.toMatch(/caches\.(open|match)/);
  });
});
