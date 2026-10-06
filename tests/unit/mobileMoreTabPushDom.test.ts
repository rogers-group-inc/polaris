/**
 * tests/unit/mobileMoreTabPushDom.test.ts
 *
 * The More tab's Notifications row — a PREFERENCE since business rule 39, not
 * an on/off switch. It names the account's current choice (Email / Push / both)
 * and opens a sheet with the three options; the second half of its supporting
 * line is about THIS phone, because the preference can be perfectly saved and
 * still reach nothing here.
 *
 * Getting the states wrong is user-visible in bad ways. The iOS one in
 * particular is what stops the tab from offering a choice that can only ever
 * throw (iOS grants Web Push only to an installed home-screen app, but
 * `"PushManager" in window` is true in plain Safari from 16.4).
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "more-tab.js"), "utf-8");

type Status = { supported: boolean; enabledOnServer: boolean; permission: string; subscribed: boolean };

interface Ctx {
  status: Status;
  supported: boolean;
  ios: boolean;
  firefox: boolean;
  standalone: boolean;
  canPrompt: boolean;
  preference: string;
}

const g = globalThis as any;

async function render(ctx: Partial<Ctx>) {
  const c: Ctx = {
    status: { supported: true, enabledOnServer: true, permission: "default", subscribed: false },
    supported: true, ios: false, firefox: false, standalone: false, canPrompt: false,
    preference: "email",
    ...ctx,
  } as Ctx;

  document.body.innerHTML = '<div id="app"><main class="app-body" id="app-body"></main></div>';

  const calls: string[] = [];
  const snacks: string[] = [];
  const routed: string[] = [];
  const saved: string[] = [];

  g.escapeHtml = (s: any) => String(s ?? "");
  g.timeAgo = () => "just now";
  g._csrfHeaders = () => ({});
  g.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  g.api = {
    alerts: { list: vi.fn(async () => ({ notifications: [] })) },
    push: {
      preference: vi.fn(async () => ({ preference: c.preference ?? "email" })),
      setPreference: vi.fn(async (v: string) => { saved.push(v); return { preference: v }; }),
    },
  };
  g.PolarisRouter = { go: (r: string) => routed.push(r) };
  g.PolarisTabs = { showSnackbar: (m: string) => snacks.push(m) };
  g.PolarisTheme = { get: () => "dark", set: vi.fn() };
  g.PolarisInstall = {
    isIos: () => c.ios,
    isFirefox: () => c.firefox,
    isStandalone: () => c.standalone,
    canPrompt: () => c.canPrompt,
    prompt: vi.fn(async () => { calls.push("install.prompt"); return "accepted"; }),
    onChange: vi.fn(),
  };
  g.polarisPush = {
    isSupported: () => c.supported,
    status: vi.fn(async () => c.status),
    enable: vi.fn(async (o: any) => { calls.push("enable:" + (o && o.surface)); }),
    disable: vi.fn(async () => { calls.push("disable"); }),
    syncToPreference: vi.fn(async (pref: string, surf: string) => { calls.push("sync:" + pref + ":" + surf); return ""; }),
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
  const body = document.getElementById("app-body")!;
  await (g.PolarisMoreTab.spec.render(body, { route: { parts: [] }, user: { username: "u", role: "admin" } }) as any);
  // Let the preference → sync → status() promise chain settle.
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  return { calls, snacks, routed, saved, c };
}

/** The three options inside the preference sheet, in render order. */
const sheetOptions = () =>
  Array.from(document.querySelectorAll(".sheet [data-pref]")) as HTMLElement[];
const pickPref = (v: string) => {
  const b = document.querySelector(`.sheet [data-pref="${v}"]`) as HTMLElement;
  b.click();
};

const row = () => document.getElementById("push-toggle-row") as HTMLElement | null;
const label = () => document.getElementById("push-status-label")?.textContent ?? "";
const visible = (el: HTMLElement | null) => !!el && el.style.display !== "none";

beforeEach(() => { document.body.innerHTML = ""; });

describe("the preference row", () => {
  it("names the account's current choice", async () => {
    await render({ preference: "any" });
    expect(visible(row())).toBe(true);
    expect(label()).toMatch(/^Email and push/);
  });

  it("is still shown on a browser that cannot receive push at all", async () => {
    // The preference belongs to the ACCOUNT — this phone being unable to
    // receive a push says nothing about the operator's laptop. The row admits
    // the local limitation in its supporting line instead of disappearing.
    await render({ supported: false, preference: "push" });
    expect(visible(row())).toBe(true);
    expect(label()).toMatch(/can't receive push/i);
  });

  it("says so when the SERVER has no Web Push channel", async () => {
    await render({
      preference: "push",
      status: { supported: true, enabledOnServer: false, permission: "default", subscribed: false },
    });
    expect(visible(row())).toBe(true);
    expect(label()).toMatch(/isn't set up on this server/i);
  });

  it("adds no local caveat at all on an Email preference", async () => {
    // Nothing about this phone matters when the account isn't asking for push.
    await render({ preference: "email", status: { supported: true, enabledOnServer: false, permission: "denied", subscribed: false } });
    expect(label()).toBe("Email");
  });

  it("reports a sticky denial rather than pretending it can enroll", async () => {
    await render({
      preference: "push",
      status: { supported: true, enabledOnServer: true, permission: "denied", subscribed: false },
    });
    expect(label()).toMatch(/blocked in your browser settings/i);
  });

  it("on iOS outside standalone, says to install first", async () => {
    await render({ ios: true, standalone: false, preference: "push" });
    expect(label()).toMatch(/Add to Home Screen/i);
  });
});

describe("choosing a preference", () => {
  it("offers all three, ticking the current one", async () => {
    await render({ preference: "push" });
    row()!.click();
    const opts = sheetOptions();
    expect(opts.map((b) => b.getAttribute("data-pref"))).toEqual(["email", "push", "any"]);
    // The tick is a leading check glyph on the active row.
    expect(opts[1]!.querySelector("use")?.getAttribute("href")).toBe("#i-check");
    expect(opts[0]!.querySelector("use")).toBeNull();
  });

  it("disables the push options when the SERVER has no Web Push channel", async () => {
    await render({ status: { supported: true, enabledOnServer: false, permission: "default", subscribed: false } });
    row()!.click();
    const opts = sheetOptions();
    expect(opts.map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, true, true]);
  });

  it("enables with surface=mobile, then persists, then reconciles", async () => {
    const { calls, saved } = await render({});
    row()!.click();
    pickPref("push");
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    // surface is what routes the push deep link back to the mobile SPA.
    expect(calls).toContain("enable:mobile");
    expect(saved).toEqual(["push"]);
    expect(calls).toContain("sync:push:mobile");
    // enable() must come before the save's network round trip, or Safari has
    // already dropped the tap's user activation.
    expect(calls.indexOf("enable:mobile")).toBeLessThan(calls.indexOf("sync:push:mobile"));
  });

  it("does not prompt when permission is already granted", async () => {
    const { calls, saved } = await render({
      status: { supported: true, enabledOnServer: true, permission: "granted", subscribed: true },
    });
    row()!.click();
    pickPref("any");
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    expect(calls).not.toContain("enable:mobile");
    expect(saved).toEqual(["any"]);
  });

  it("saves Email and lets the reconcile un-enroll this phone", async () => {
    const { calls, saved } = await render({
      preference: "push",
      status: { supported: true, enabledOnServer: true, permission: "granted", subscribed: true },
    });
    row()!.click();
    pickPref("email");
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    expect(saved).toEqual(["email"]);
    // syncToPreference owns the un-enroll — never a bare disable() here, or the
    // two paths could disagree about what "email" means for a subscription.
    expect(calls).toContain("sync:email:mobile");
    expect(calls).not.toContain("disable");
  });

  it("on iOS outside standalone, routes to the install steps instead of prompting", async () => {
    const { routed, calls, saved } = await render({ ios: true, standalone: false });
    row()!.click();
    pickPref("push");
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    expect(routed).toContain("more/install");
    expect(calls).not.toContain("enable:mobile"); // would have thrown on iOS
    // And nothing is saved: a preference this phone cannot honour, chosen on
    // this phone, is a promise Polaris would break.
    expect(saved).toEqual([]);
  });

  it("on iOS INSIDE standalone, enrolls normally", async () => {
    const { calls, saved } = await render({ ios: true, standalone: true });
    row()!.click();
    pickPref("push");
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain("enable:mobile");
    expect(saved).toEqual(["push"]);
  });

  it("does not call status() inside the tap handler", async () => {
    // Awaiting there burns the tap's user activation and Safari refuses the
    // permission prompt.
    await render({});
    row()!.click();
    const before = g.polarisPush.status.mock.calls.length;
    pickPref("push");
    expect(g.polarisPush.status.mock.calls.length).toBe(before);
  });

  it("still saves when this browser refuses the prompt", async () => {
    // The preference is account-wide and other devices may honour it.
    const { saved, snacks } = await render({});
    g.polarisPush.enable.mockRejectedValueOnce(new Error("blocked"));
    row()!.click();
    pickPref("push");
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(saved).toEqual(["push"]);
    expect(snacks.join(" ")).toMatch(/blocked/i);
  });
});

describe("install row", () => {
  it("is hidden once running standalone", async () => {
    await render({ standalone: true, canPrompt: true });
    expect(visible(document.getElementById("install-row"))).toBe(false);
  });

  it("triggers the native prompt on Android when available", async () => {
    const { calls } = await render({ canPrompt: true });
    const r = document.getElementById("install-row")!;
    expect(visible(r)).toBe(true);
    r.click();
    await new Promise((res) => setTimeout(res, 0));
    expect(calls).toContain("install.prompt");
  });

  it("routes to the manual steps on iOS", async () => {
    const { routed } = await render({ ios: true });
    document.getElementById("install-row")!.click();
    expect(routed).toContain("more/install");
  });

  it("still offers manual steps on a browser with no native prompt", async () => {
    // Firefox for Android CAN install from its own menu; it just never
    // implemented beforeinstallprompt. Hiding the row on !canPrompt() left
    // those users with no affordance at all.
    const { routed } = await render({ canPrompt: false, ios: false, firefox: true });
    const r = document.getElementById("install-row")!;
    expect(visible(r)).toBe(true);
    r.click();
    expect(routed).toContain("more/install");
  });

  it("shows Firefox-specific steps on the install page", async () => {
    await render({ firefox: true, canPrompt: false });
    document.body.innerHTML = '<div id="app"><main class="app-body" id="app-body"></main></div>';
    const body = document.getElementById("app-body")!;
    await (g.PolarisMoreTab.spec.render(body, { route: { parts: ["install"] }, user: {} }) as any);
    expect(body.innerHTML).toMatch(/Firefox menu/);
  });
});

describe("standalone escape hatch", () => {
  it("opens Desktop view in a real browser tab when installed", async () => {
    // scope "/" means it would otherwise open inside the standalone window —
    // full desktop layout, no address bar, no way back.
    await render({ standalone: true });
    const link = document.querySelector('a[href="/index.html?desktop=1"]') as HTMLAnchorElement;
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener");
  });

  it("navigates in place in a normal browser tab", async () => {
    await render({ standalone: false });
    const link = document.querySelector('a[href="/index.html?desktop=1"]') as HTMLAnchorElement;
    expect(link.getAttribute("target")).toBeNull();
  });
});

describe("push deep link destination", () => {
  // Alerts left More for its own navbar tab (alerts-tab.js). A push already
  // sitting in a tray keeps the #more/alerts URL it was sent with, so app.js
  // must still send that route to the tab rather than bouncing it to Search.
  it("still routes the retired #more/alerts link to the Alerts tab", () => {
    const appSrc = readFileSync(join(process.cwd(), "public", "js", "mobile", "app.js"), "utf-8");
    expect(appSrc).toMatch(/route\.name === "more"[^\n]*route\.parts\[0\] === "alerts"\)\s*\{\s*PolarisRouter\.go\("alerts", \{ replace: true \}\)/);
  });

  it("no longer registers an alerts sub-page under More", async () => {
    await render({});
    expect(document.querySelector('[data-sub="alerts"]')).toBeNull();
  });
});
