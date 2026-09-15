/**
 * tests/unit/userAccountMenu.test.ts — the page-header account menu
 * (`openUserMenu` in public/js/app.js).
 *
 * The notification preference, display timezone, two-factor enrollment, help
 * and logout live behind the user badge, which means a regression here doesn't
 * misalign a button — it removes the only way to log out from every page at
 * once. The theme toggle is NOT here: it sits at the bottom of the sidebar
 * (see sidebarThemeToggleDom).
 *
 * Help and Logout are the two UNCONDITIONAL rows, and they sit in separate
 * groups: help is neither a preference nor the way out. Everything above them
 * is conditional on a permission, a provider or an install setting, which is
 * why most of what is pinned below is a label ORDER rather than a presence.
 *
 * openUserMenu is pulled out of app.js rather than evaluating the whole file
 * (119 KB with polling loops that would fire here); everything it reaches for
 * is stubbed, so what's pinned is the item set it hands showRowMenu.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_JS = readFileSync(join(process.cwd(), "public", "js", "app.js"), "utf-8");

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

interface Item {
  label?: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onSelect?: () => void;
}

function open(opts: {
  pref?: Item | null;
  tz?: Item | null;
  pw?: Item | null;
  totp?: Item | null;
  passkeys?: Item | null;
} = {}) {
  const captured: { items: Item[]; opts: Record<string, unknown>; anchor: unknown } =
    { items: [], opts: {}, anchor: null };
  const fetches: string[] = [];
  const opened: { url: string; target: string; features: string }[] = [];

  const g = globalThis as Record<string, unknown>;
  g.showRowMenu = (anchor: unknown, items: Item[], o: Record<string, unknown>) => {
    captured.anchor = anchor; captured.items = items; captured.opts = o;
  };
  g._notifPrefMenuItem = () => (opts.pref === undefined ? null : opts.pref);
  g._tzMenuItem = () => (opts.tz === undefined ? null : opts.tz);
  g._changePasswordMenuItem = () => (opts.pw === undefined ? null : opts.pw);
  g._totpMenuItem = () => (opts.totp === undefined ? null : opts.totp);
  g._passkeyMenuItem = () => (opts.passkeys === undefined ? null : opts.passkeys);
  g._csrfHeaders = () => ({ "x-csrf-token": "t" });
  g.ICONS = { logout: "<svg id='logout'/>", bell: "<svg id='bell'/>", shield: "<svg id='shield'/>", clock: "<svg id='clock'/>", key: "<svg id='key'/>", help: "<svg id='help'/>" };
  g.fetch = vi.fn((url: string) => { fetches.push(url); return Promise.resolve({}); });
  // openUserMenu is extracted on its own, so the module-level WIKI_URL it
  // closes over in the browser has to be supplied here. Its VALUE is
  // deliberately not the real one: what this file pins is that the row opens
  // whatever that constant holds, in a new tab, with noopener — a fork
  // repointing the wiki must not have to edit a test.
  g.WIKI_URL = "https://wiki.test/polaris";
  g.window = globalThis;
  g.open = (url: string, target: string, features: string) => { opened.push({ url, target, features }); return null; };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const openUserMenu = new Function(extractFn("openUserMenu") + "\nreturn openUserMenu;")() as (a: unknown) => void;
  openUserMenu({ id: "badge" });
  return { ...captured, fetches, opened, labels: captured.items.map((i) => (i.separator ? "—" : i.label)) };
}

describe("openUserMenu", () => {
  it("offers help and logout even when nothing conditional is available", () => {
    // The notification preference (alerts:read, and only once the account's
    // stored choice has resolved) and 2FA (local accounts only) are both
    // conditional. Help and Logout are not — losing logout would strand the
    // user, and help documents the pages this account CANNOT open as well as
    // the ones it can, so a reader who cannot find a feature is exactly who
    // needs it. With nothing conditional there is no leading separator,
    // because a rule above nothing separates nothing.
    expect(open().labels).toEqual(["Help", "—", "Logout"]);
  });

  it("carries no theme row — the toggle lives in the sidebar", () => {
    const r = open({ pref: { label: "Notifications: Email", icon: "<svg/>", onSelect: () => {} } });
    expect(r.labels).not.toContain("Light Mode");
    expect(r.labels).not.toContain("Dark Mode");
  });

  it("slots the notification-preference row above the logout separator", () => {
    // It names the CURRENT setting rather than an action, because the row is
    // the way into the three-way chooser, not a toggle (business rule 39).
    const r = open({ pref: { label: "Notifications: Email", icon: "<svg/>", onSelect: () => {} } });
    expect(r.labels).toEqual(["Notifications: Email", "—", "Help", "—", "Logout"]);
  });

  it("slots the two-factor row after the preference, still above the separator", () => {
    const r = open({
      pref: { label: "Notifications: Push", icon: "<svg/>", onSelect: () => {} },
      totp: { label: "Set up two-factor auth", icon: "<svg/>", onSelect: () => {} },
    });
    expect(r.labels).toEqual(["Notifications: Push", "Set up two-factor auth", "—", "Help", "—", "Logout"]);
  });

  it("groups the credential rows, password before the second factor on it", () => {
    // All three are local-account-only and came here for the same reason
    // (/users.html is admin-gated), so they read as one group. The password
    // leads: it is the credential, 2FA is something added to it, and the
    // passkey is the thing that can eventually replace both.
    const r = open({
      pref: { label: "Notifications: Push", icon: "<svg/>", onSelect: () => {} },
      pw: { label: "Change password", icon: "<svg/>", onSelect: () => {} },
      totp: { label: "Set up two-factor auth", icon: "<svg/>", onSelect: () => {} },
      passkeys: { label: "Set up a passkey", icon: "<svg/>", onSelect: () => {} },
    });
    expect(r.labels).toEqual([
      "Notifications: Push",
      "Change password",
      "Set up two-factor auth",
      "Set up a passkey",
      "—",
      "Help",
      "—",
      "Logout",
    ]);
  });

  it("omits the passkey row entirely when it is not on offer", () => {
    // An SSO account, or an install with passkeys off and none registered —
    // the menu must not grow a dead row for either.
    const r = open({
      pw: { label: "Change password", icon: "<svg/>", onSelect: () => {} },
      passkeys: null,
    });
    expect(r.labels).toEqual(["Change password", "—", "Help", "—", "Logout"]);
  });

  it("slots the timezone row between the preference and two-factor", () => {
    // It names the RESOLVED zone rather than "Automatic" alone, because the
    // setting exists for a surface the operator can't see from here (their
    // alert email), so the row has to say what that surface will use.
    const r = open({
      pref: { label: "Notifications: Email", icon: "<svg/>", onSelect: () => {} },
      tz: { label: "Timezone: America/Chicago", icon: "<svg/>", onSelect: () => {} },
      totp: { label: "Set up two-factor auth", icon: "<svg/>", onSelect: () => {} },
    });
    expect(r.labels).toEqual([
      "Notifications: Email",
      "Timezone: America/Chicago",
      "Set up two-factor auth",
      "—",
      "Help",
      "—",
      "Logout",
    ]);
  });

  it("keeps the timezone row for a role that has no notification row", () => {
    // The timezone row carries NO permission gate, unlike the notification
    // one: what zone a timestamp is drawn in changes nothing about which data
    // an account can reach, so a role below alerts:read must still reach it.
    const r = open({ pref: null, tz: { label: "Timezone: Automatic", icon: "<svg/>", onSelect: () => {} } });
    expect(r.labels).toEqual(["Timezone: Automatic", "—", "Help", "—", "Logout"]);
  });

  it("omits the two-factor row for an SSO account without disturbing the rest", () => {
    const r = open({ pref: { label: "Notifications: Email", icon: "<svg/>", onSelect: () => {} }, totp: null });
    expect(r.labels).toEqual(["Notifications: Email", "—", "Help", "—", "Logout"]);
  });

  it("opens the wiki in a new tab, with noopener", () => {
    // The wiki is a third-party origin, so it must not get a handle on the
    // Polaris window. `_blank` without `noopener` hands it `window.opener`.
    const r = open();
    const help = r.items.find((i) => i.label === "Help")!;
    help.onSelect!();
    expect(r.opened).toEqual([
      { url: "https://wiki.test/polaris", target: "_blank", features: "noopener" },
    ]);
  });

  it("keeps help out of the credentials group and out of the logout group", () => {
    // Its own group in the middle: it is neither an account setting nor the
    // way out, and grouping it with Logout would put a reference link beside
    // the one destructive row in the menu.
    const r = open({ pw: { label: "Change password", icon: "<svg/>", onSelect: () => {} } });
    const i = r.labels.indexOf("Help");
    expect(r.labels[i - 1]).toBe("—");
    expect(r.labels[i + 1]).toBe("—");
  });

  it("marks logout destructive and gives every row an icon", () => {
    const r = open({
      pref: { label: "Notifications: Email", icon: "<svg/>", onSelect: () => {} },
      totp: { label: "Set up two-factor auth", icon: "<svg/>", onSelect: () => {} },
    });
    const logout = r.items[r.items.length - 1];
    expect(logout.danger).toBe(true);
    expect(r.items.filter((i) => !i.separator).every((i) => Boolean(i.icon))).toBe(true);
  });

  it("right-aligns under its trigger — the badge sits at the page's right edge", () => {
    const r = open();
    expect(r.opts.align).toBe("end");
    expect(r.opts.label).toBe("Account menu");
  });

  it("POSTs the logout before leaving", () => {
    const r = open();
    r.items[r.items.length - 1].onSelect!();
    expect(r.fetches).toEqual(["/api/v1/auth/logout"]);
  });
});
