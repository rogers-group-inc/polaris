/**
 * tests/unit/accountMenuPasswordRow.test.ts — the account menu's change-password
 * row (`_changePasswordMenuItem` in public/js/app.js).
 *
 * Same permission mismatch the two-factor row fixed, one surface over: the
 * only password field in the product lived on /users.html, which is page-gated
 * `users`, while `PUT /auth/password` asks for no permission beyond a session.
 * An ordinary local user therefore could not change their own password at all.
 *
 * What's pinned is the gate. The row is offered for exactly the accounts the
 * server will accept — `authProvider === "local"` off the /auth/totp/status
 * payload, which is the same value the route enforces against. Reading it from
 * that payload rather than from `currentUserAuthProvider` is deliberate and
 * load-bearing: renderNav also runs off the localStorage cache, which does not
 * carry the provider and defaults it to "local", so gating on it would offer
 * an SSO user a dialog the server answers with "managed by your identity
 * provider".
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

type MenuItem = { label: string; icon?: string; title?: string; onSelect?: () => void } | null;

function run(opts: { authProvider?: string | null; module?: boolean }): {
  item: MenuItem;
  opened: Record<string, unknown>[];
} {
  const opened: Record<string, unknown>[] = [];
  const g = globalThis as Record<string, unknown>;

  g.PolarisPasswordSelf = opts.module === false ? undefined : {
    open: vi.fn((o: Record<string, unknown>) => { opened.push(o); }),
  };
  g.currentUsername = "test_appdev";

  const state = opts.authProvider === null
    ? "null"
    : JSON.stringify({ authProvider: opts.authProvider, enabled: false, enrolling: false });

  const src = [
    `var _totpState = ${state};`,
    "var ICONS = { key: '<svg/>' };",
    "var currentUsername = 'test_appdev';",
    extractFn("_changePasswordMenuItem"),
    "return _changePasswordMenuItem();",
  ].join("\n");

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const item = new Function(src)() as MenuItem;
  return { item, opened };
}

describe("_changePasswordMenuItem", () => {
  it("offers the row to a local account", () => {
    const { item } = run({ authProvider: "local" });
    expect(item).not.toBeNull();
    expect(item!.label).toBe("Change password");
    // The dialog asks for the current password; saying so up front stops the
    // row reading like an admin reset.
    expect(item!.title).toMatch(/current password/i);
  });

  it.each(["azure", "oidc", "ldap", "entra-proxy"])(
    "withholds it from a %s account, whose provider owns the credential",
    (provider) => {
      expect(run({ authProvider: provider }).item).toBeNull();
    },
  );

  it("withholds it until the status payload has been read", () => {
    // The fetch is one-per-page-load and the menu is built per open, so a menu
    // opened before it lands must show nothing rather than guess "local".
    expect(run({ authProvider: null }).item).toBeNull();
  });

  it("withholds it on a page that doesn't load the shared module", () => {
    expect(run({ authProvider: "local", module: false }).item).toBeNull();
  });

  it("opens the shared modal naming the signed-in user", () => {
    const { item, opened } = run({ authProvider: "local" });
    item!.onSelect!();
    expect(opened).toEqual([{ username: "test_appdev" }]);
  });
});
