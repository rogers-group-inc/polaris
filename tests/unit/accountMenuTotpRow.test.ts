/**
 * tests/unit/accountMenuTotpRow.test.ts — the account menu's two-factor row
 * (`wireTotpState` / `_totpMenuItem` / `refreshTotpState` / `_openTotpSelf` in
 * public/js/app.js).
 *
 * This row exists to fix the same class of permission mismatch push
 * enrollment had: /auth/totp/* is self-service (any logged-in local account),
 * but the only UI lived on /users.html, which is admin-gated — so an ordinary
 * local user could never configure their own second factor. What's pinned
 * here is that the row is offered for exactly the accounts the server will
 * accept (authProvider === "local") and names the action it will actually
 * take, since an SSO account's enroll call is refused outright.
 *
 * The four functions share module-level state, so they're pulled out of
 * app.js together rather than by evaluating all of it (polling loops).
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

const SRC = [
  "var _totpState = null, _totpFetched = false;",
  "var ICONS = { shield: '<svg/>' };",
  extractFn("wireTotpState"),
  extractFn("_totpMenuItem"),
  extractFn("refreshTotpState"),
  extractFn("_openTotpSelf"),
  "return { wire: wireTotpState, item: _totpMenuItem, refresh: refreshTotpState };",
].join("\n");

interface Status {
  authProvider: string;
  enabled: boolean;
  enrolling: boolean;
  backupCodesRemaining: number;
}

type MenuItem = { label: string; icon?: string; title?: string; onSelect?: () => void } | null;

async function run(opts: { status?: Partial<Status> | null; module?: boolean; api?: boolean }) {
  const status: Status = {
    authProvider: "local", enabled: false, enrolling: false, backupCodesRemaining: 0,
    ...(opts.status ?? {}),
  };
  const calls: string[] = [];
  const opened: Record<string, unknown>[] = [];

  const statusFn = vi.fn(async () => { calls.push("status"); return opts.status === null ? null : status; });
  const g = globalThis as Record<string, unknown>;
  // app.js reads these as globals and guards on `window.*`, so they have to
  // live on globalThis rather than be passed in.
  g.PolarisTotpSelf = opts.module === false ? undefined : {
    status: statusFn,
    open: (o: Record<string, unknown>) => { opened.push(o); calls.push("open"); },
  };
  g.api = opts.api === false ? undefined : { totp: { status: statusFn } };

  const mod = new Function(SRC)() as { wire: () => void; item: () => MenuItem; refresh: () => void };
  mod.wire();
  await Promise.resolve();
  await Promise.resolve();
  return { item: mod.item(), calls, opened, statusFn, wire: mod.wire, itemFn: mod.item, refresh: mod.refresh };
}

describe("account-menu two-factor row", () => {
  it("offers enrollment to a local account that hasn't set it up", async () => {
    const r = await run({});
    expect(r.item?.label).toBe("Set up two-factor auth");
    expect(r.item?.icon).toBeTruthy();
  });

  it("resumes an abandoned enrollment rather than pretending it never started", async () => {
    const r = await run({ status: { enrolling: true } });
    expect(r.item?.label).toBe("Finish two-factor setup");
  });

  it("offers the only action available once enabled, and says what it costs", async () => {
    // There is no re-issue endpoint, so disable is the only thing a
    // fully-enrolled account can do from here.
    const r = await run({ status: { enabled: true, backupCodesRemaining: 7 } });
    expect(r.item?.label).toBe("Disable two-factor auth");
    expect(r.item?.title).toContain("7 backup codes left");
  });

  it("omits the row for every non-local provider — the directory owns MFA there", async () => {
    for (const authProvider of ["azure", "oidc", "ldap", "entra-proxy"]) {
      const r = await run({ status: { authProvider } });
      expect(r.item, authProvider).toBeNull();
    }
  });

  it("omits the row when state hasn't arrived, so it can't mislabel itself", async () => {
    const r = await run({ status: null });
    expect(r.item).toBeNull();
  });

  it("omits the row on a page that doesn't load the shared module", async () => {
    const r = await run({ module: false });
    expect(r.item).toBeNull();
    expect(r.calls).toEqual([]);
  });

  it("fetches once per page load — renderNav runs twice on the cache-warm path", async () => {
    const r = await run({});
    r.wire();
    r.wire();
    expect(r.calls.filter((c) => c === "status")).toHaveLength(1);
  });

  it("re-reads state after the flow changes it, so the next open relabels", async () => {
    const r = await run({});
    r.item!.onSelect!();
    expect(r.opened).toHaveLength(1);
    const onChange = r.opened[0].onChange as () => void;
    onChange();
    await Promise.resolve();
    expect(r.calls.filter((c) => c === "status")).toHaveLength(2);
  });

  it("the shared refresh is a no-op on a page without the module, not a throw", async () => {
    // users.js calls it opportunistically after its own enroll/disable.
    const r = await run({ module: false });
    expect(() => r.refresh()).not.toThrow();
  });
});
