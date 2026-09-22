/**
 * tests/unit/sidebarPushToggleDom.test.ts
 *
 * The account menu's NOTIFICATION PREFERENCE row (business rule 39), which
 * replaced the "Enable push" / "Disable push" toggle this file used to pin.
 *
 * Two properties it exists to protect:
 *
 *   The PERMISSION GATE. The push routes gate on alerts:read ("any viewer may
 *   opt into push"), but the only control once lived on /automations.html,
 *   which is page-gated automationManagement:read — so a role with alerts and
 *   no automation management could not enroll at all. The control now lives in
 *   the page-header account menu, which renders everywhere.
 *
 *   The RECONCILE. Enrollment is no longer a decision of its own: the operator
 *   picks a preference, it is stored on the account, and every browser brings
 *   its own subscription into line at boot. If `syncToPreference` stops being
 *   called here, "prefer push" silently means push only on whichever device
 *   the operator happened to click it on — the exact bug the rule was written
 *   for, and one nothing else would report.
 *
 *   The OFFER. The reconcile cannot prompt, so it leaves a browser that has
 *   never been asked for permission un-enrolled; the boot chain therefore ends
 *   by putting the question to it once. What that offer does is pinned in
 *   pushEnrollmentOffer.test.ts — here it is only that the chain reaches it.
 *
 * wireNotificationPrefs + _notifPrefMenuItem + _openNotifPrefMenu +
 * _chooseNotifPref are exercised directly rather than by evaluating all of
 * app.js (119 KB with polling loops that would fire here). They share
 * module-level state, so they are pulled out together.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_JS = readFileSync(join(process.cwd(), "public", "js", "app.js"), "utf-8");

/** Pull one function out of app.js so we don't boot the whole page. */
function extractFn(name: string): string {
  const start = APP_JS.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.js`);
  let depth = 0;
  let i = APP_JS.indexOf("{", start);
  for (; i < APP_JS.length; i++) {
    if (APP_JS[i] === "{") depth++;
    else if (APP_JS[i] === "}") { depth--; if (depth === 0) break; }
  }
  return APP_JS.slice(start, i + 1);
}

/** The label/order maps live at app.js module scope, beside the state. */
function extractVar(decl: string): string {
  const start = APP_JS.indexOf(decl);
  if (start < 0) throw new Error(`${decl} not found in app.js`);
  const end = APP_JS.indexOf("\n", start);
  return APP_JS.slice(start, end);
}

// These close over the same module-level _pushState/_pushBusy/_notifPref, so
// they have to be evaluated in one scope. ICONS is stubbed — the row only
// reads ICONS.bell for its glyph.
const SRC = [
  "var _pushState = null, _pushBusy = false, _notifPref = null, _pushOfferHandled = false;",
  "var currentUsername = 'dmoore';",
  extractVar("var NOTIF_PREF_LABELS ="),
  extractVar("var NOTIF_PREF_ORDER ="),
  "var ICONS = { bell: '<svg/>' };",
  extractFn("wireNotificationPrefs"),
  extractFn("_notifPrefMenuItem"),
  extractFn("_openNotifPrefMenu"),
  extractFn("_chooseNotifPref"),
  // The boot chain ends in the one-time enrollment offer for a browser that
  // has never been asked for permission — pulled in because wire() calls it.
  // What it does is pinned in pushEnrollmentOffer.test.ts.
  extractFn("_maybeOfferPushEnrollment"),
  extractFn("_openPushOfferDialog"),
  "return { wire: wireNotificationPrefs, item: _notifPrefMenuItem, open: _openNotifPrefMenu };",
].join("\n");

type Status = { enabledOnServer: boolean; permission: string; subscribed: boolean; supported: boolean };
type MenuItem = { label: string; icon?: string; disabled?: boolean; title?: string; onSelect?: () => void } | null;

async function run(opts: {
  status?: Partial<Status>;
  perm?: string;          // caller's alerts level
  supported?: boolean;
  preference?: string;
  preferenceFails?: boolean;
  offerEnrollment?: boolean;
}) {
  const calls: string[] = [];
  const status: Status = { supported: true, enabledOnServer: true, permission: "default", subscribed: false, ...opts.status } as Status;

  const polarisPush = {
    isSupported: () => opts.supported !== false,
    status: vi.fn(async () => status),
    enable: vi.fn(async (o: any) => { calls.push("enable:" + (o && o.surface)); }),
    disable: vi.fn(async () => { calls.push("disable"); }),
    registerSW: vi.fn(async () => { calls.push("registerSW"); return {}; }),
    reconcileSubscription: vi.fn(async (s: string) => { calls.push("reconcile:" + s); return true; }),
    syncToPreference: vi.fn(async (p: string, s: string) => { calls.push("sync:" + p + ":" + s); return ""; }),
    shouldOfferEnrollment: vi.fn(async (p: string) => {
      calls.push("shouldOffer:" + p);
      return !!opts.offerEnrollment;
    }),
    recordOfferMade: (u: string) => { calls.push("recordOffer:" + u); },
  };

  const RANK: Record<string, number> = { none: 0, read: 1, write: 2, fullwrite: 3 };
  const saved: string[] = [];

  // app.js reads these as GLOBALS (and guards on `window.polarisPush`), so
  // they must live on globalThis — passing them as parameters would satisfy
  // the bare references while leaving the window.* guard undefined.
  const g = globalThis as any;
  g.polarisPush = polarisPush;
  g.permAtLeast = (_key: string, level: string) => RANK[opts.perm ?? "read"] >= RANK[level];
  g.showToast = () => {};
  g.escapeHtml = (v: unknown) => String(v ?? "");
  g.openModal = (_t: string, _b: string, f: string) => {
    calls.push("openModal");
    document.body.innerHTML = '<div class="modal-footer">' + f + "</div>";
  };
  g.closeModal = () => { calls.push("closeModal"); };
  const menus: { items: MenuItem[]; opts: Record<string, unknown> }[] = [];
  g.showRowMenu = (_a: unknown, items: MenuItem[], o: Record<string, unknown>) => { menus.push({ items, opts: o }); };
  g.api = {
    push: {
      preference: vi.fn(async () => {
        calls.push("getPreference");
        if (opts.preferenceFails) throw new Error("nope");
        return { preference: opts.preference ?? "email" };
      }),
      setPreference: vi.fn(async (p: string) => { saved.push(p); return { preference: p }; }),
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const mod = new Function(SRC)() as {
    wire: () => void;
    item: (a: unknown) => MenuItem;
    open: (a: unknown) => void;
  };
  mod.wire();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return {
    calls, polarisPush, saved, menus,
    item: () => mod.item({ id: "badge" }),
    open: () => { mod.open({ id: "badge" }); return menus[menus.length - 1]!; },
  };
}

beforeEach(() => { document.body.innerHTML = ""; });

describe("permission gate", () => {
  it("offers the row for a role with alerts:read and NO automationManagement", async () => {
    // The whole point: this role can't reach /automations.html, where the only
    // enrollment control used to live.
    const { item } = await run({ perm: "read" });
    expect(item()?.label).toBe("Notifications: Email");
  });

  it("omits the row for alerts:none, and never even asks for the preference", async () => {
    const { item, calls } = await run({ perm: "none" });
    expect(item()).toBeNull();
    expect(calls).not.toContain("getPreference");
  });
});

describe("the row", () => {
  it("names the CURRENT setting rather than an action", async () => {
    // It opens a chooser; a row reading "Enable push" would promise a toggle.
    const { item } = await run({ preference: "any" });
    expect(item()?.label).toBe("Notifications: Email and push");
  });

  it("is still offered on a browser that cannot receive push at all", async () => {
    // The preference belongs to the ACCOUNT — this laptop being unable to
    // receive a push says nothing about the operator's phone.
    const { item } = await run({ supported: false, preference: "push" });
    expect(item()?.label).toBe("Notifications: Push");
  });

  it("falls back to Email when the preference can't be read, rather than vanishing", async () => {
    // A hidden row is indistinguishable from "this account has no such
    // setting", and leaves no way to set one.
    const { item } = await run({ preferenceFails: true });
    expect(item()?.label).toBe("Notifications: Email");
  });
});

describe("the chooser", () => {
  it("offers all three, ticking the current one", async () => {
    const { open } = await run({ preference: "push" });
    const labels = open().items.map((i) => i!.label);
    expect(labels).toEqual(["Email", "Push  ✓", "Email and push"]);
  });

  it("disables the two push options when the SERVER has no Web Push channel", async () => {
    const { open } = await run({ status: { enabledOnServer: false } });
    const items = open().items;
    expect(items.map((i) => i!.disabled)).toEqual([false, true, true]);
    expect(items[1]!.title).toMatch(/isn.t configured on this server/i);
  });

  it("keeps them enabled on a browser that has DENIED permission", async () => {
    // Sticky denial is a fact about this browser, not about the account: the
    // operator's phone may well honour the preference.
    const { open } = await run({ status: { permission: "denied" } });
    expect(open().items.every((i) => !i!.disabled)).toBe(true);
  });
});

describe("choosing a preference", () => {
  it("prompts THIS browser first, then persists, then reconciles", async () => {
    const { calls, saved, open } = await run({});
    open().items[1]!.onSelect!();          // "Push"
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain("enable:desktop");
    expect(saved).toEqual(["push"]);
    expect(calls).toContain("sync:push:desktop");
    // Order matters: enable() must run before the save's network round trip,
    // or Safari has already dropped the click's user activation.
    expect(calls.indexOf("enable:desktop")).toBeLessThan(calls.indexOf("sync:push:desktop"));
  });

  it("does not prompt when permission is already granted", async () => {
    const { polarisPush, saved, open } = await run({ status: { permission: "granted" } });
    open().items[2]!.onSelect!();          // "Email and push"
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(polarisPush.enable).not.toHaveBeenCalled();
    expect(saved).toEqual(["any"]);
  });

  it("saves Email without prompting, and lets the reconcile un-enroll this browser", async () => {
    const { polarisPush, saved, calls, open } = await run({ preference: "push", status: { permission: "granted", subscribed: true } });
    open().items[0]!.onSelect!();          // "Email"
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(polarisPush.enable).not.toHaveBeenCalled();
    expect(saved).toEqual(["email"]);
    // syncToPreference owns the un-enroll — never a bare disable() here, or the
    // two paths could disagree about what "email" means for a subscription.
    expect(calls).toContain("sync:email:desktop");
    expect(polarisPush.disable).not.toHaveBeenCalled();
  });

  it("does not await status() before enable()", async () => {
    // Awaiting burns the click's user activation; Safari then refuses the prompt.
    const { polarisPush, open } = await run({});
    const before = polarisPush.status.mock.calls.length;
    open().items[1]!.onSelect!();
    expect(polarisPush.status.mock.calls.length).toBe(before);
  });

  it("still saves when this browser refuses the prompt", async () => {
    // The preference is account-wide and the operator's other devices may
    // honour it, so a local refusal must not swallow the choice.
    const { saved, open, polarisPush } = await run({});
    polarisPush.enable.mockRejectedValueOnce(new Error("blocked"));
    open().items[1]!.onSelect!();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(saved).toEqual(["push"]);
  });

  it("does nothing when the current preference is picked again", async () => {
    const { saved, open } = await run({ preference: "email" });
    open().items[0]!.onSelect!();
    await new Promise((r) => setTimeout(r, 0));
    expect(saved).toEqual([]);
  });
});

describe("boot reconcile", () => {
  it("registers the worker and syncs this browser to the stored preference", async () => {
    // This is what makes "prefer push" mean push on a device the operator
    // never clicked anything on.
    const { calls } = await run({ preference: "push" });
    expect(calls).toContain("registerSW");
    expect(calls).toContain("sync:push:desktop");
  });

  it("syncs on an EMAIL preference too — that is how a device un-enrolls", async () => {
    const { calls } = await run({ preference: "email" });
    expect(calls).toContain("sync:email:desktop");
  });

  it("puts the enrollment offer to a browser the silent sync could not enroll", async () => {
    // The sync cannot prompt, so it leaves a never-asked browser un-enrolled.
    // If this call goes missing, an account that prefers push is silently not
    // reachable on any new laptop, profile or re-install — the same class of
    // bug as a missing sync, and just as invisible.
    const { calls } = await run({ preference: "push", offerEnrollment: true });
    expect(calls.indexOf("shouldOffer:push")).toBeGreaterThan(calls.indexOf("sync:push:desktop"));
    expect(calls).toContain("openModal");
  });

  it("offers nothing when this browser is not one to ask", async () => {
    const { calls } = await run({ preference: "push", offerEnrollment: false });
    expect(calls).toContain("shouldOffer:push");
    expect(calls).not.toContain("openModal");
  });
});
