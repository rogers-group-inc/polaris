/**
 * tests/unit/accountMenuPasskeyRow.test.ts — the account menu's passkey row
 * (`wirePasskeyState` / `_passkeyMenuItem` / `refreshPasskeyState` in
 * public/js/app.js).
 *
 * The row exists for the same reason the two-factor one does: /auth/passkeys/*
 * is self-service (any logged-in local account), but the only other credential
 * UI lives on /users.html, which is admin-gated — so without this an ordinary
 * local user could not register the passkey the install is offering them.
 *
 * What's pinned beyond "the row appears": the row must NOT appear for an
 * account the server will refuse (every non-local provider), and it must still
 * appear for a user who holds credentials on an install that has since turned
 * passkeys OFF — removing them is exactly what that person might now want to
 * do, and hiding the row would strand them.
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
  "var _passkeyState = null, _passkeyFetched = false;",
  "var ICONS = { key: '<svg/>' };",
  extractFn("wirePasskeyState"),
  extractFn("refreshPasskeyState"),
  extractFn("_passkeyMenuItem"),
  "return { wire: wirePasskeyState, item: _passkeyMenuItem, refresh: refreshPasskeyState };",
].join("\n");

interface Summary {
  authProvider: string;
  count: number;
  availability: { mode?: string; unavailableReason?: string | null };
}

type MenuItem = { label: string; icon?: string; title?: string; onSelect?: () => void } | null;

async function run(opts: { summary?: Partial<Summary> | null; module?: boolean; api?: boolean } = {}) {
  const summary: Summary = {
    authProvider: "local",
    count: 0,
    availability: { mode: "both", unavailableReason: null },
    ...(opts.summary ?? {}),
  };
  const calls: string[] = [];
  const opened: Record<string, unknown>[] = [];

  const summaryFn = vi.fn(async () => { calls.push("summary"); return opts.summary === null ? null : summary; });
  const g = globalThis as Record<string, unknown>;
  // app.js reads these as globals and guards on `window.*`, so they have to
  // live on globalThis rather than be passed in.
  g.PolarisPasskeys = opts.module === false ? undefined : {
    summary: summaryFn,
    open: (o: Record<string, unknown>) => { opened.push(o); calls.push("open"); },
  };
  g.api = opts.api === false ? undefined : { auth: { passkeys: summaryFn } };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const mod = new Function(SRC)() as { wire: () => void; item: () => MenuItem; refresh: () => void };
  mod.wire();
  await Promise.resolve();
  await Promise.resolve();
  return { item: mod.item(), calls, opened, summaryFn, wire: mod.wire, itemFn: mod.item };
}

describe("account-menu passkey row", () => {
  it("offers enrollment to a local account with none registered", async () => {
    const r = await run();
    expect(r.item?.label).toBe("Set up a passkey");
    expect(r.item?.icon).toBeTruthy();
  });

  it("names the count once the account holds some", async () => {
    const r = await run({ summary: { count: 2 } });
    expect(r.item?.label).toBe("Passkeys (2)");
  });

  it("omits the row for every non-local provider — the IdP owns credentials there", async () => {
    for (const authProvider of ["azure", "oidc", "ldap", "entra-proxy"]) {
      const r = await run({ summary: { authProvider } });
      expect(r.item, authProvider).toBeNull();
    }
  });

  it("omits the row on an install with passkeys off and nothing registered", async () => {
    const r = await run({ summary: { count: 0, availability: { mode: "off" } } });
    expect(r.item).toBeNull();
  });

  it("KEEPS the row when passkeys are off but the user still holds some", async () => {
    // Removing them is the one thing that person might now want to do; hiding
    // the row would leave credentials on the account with no way to clear them.
    const r = await run({ summary: { count: 1, availability: { mode: "off" } } });
    expect(r.item?.label).toBe("Passkeys (1)");
    expect(r.item?.title).toMatch(/disabled/);
  });

  it("explains itself in the tooltip when this origin cannot run a ceremony", async () => {
    const r = await run({
      summary: { availability: { mode: "both", unavailableReason: "Passkeys need a secure context." } },
    });
    expect(r.item?.title).toBe("Passkeys need a secure context.");
  });

  it("omits the row when state hasn't arrived, so it can't mislabel itself", async () => {
    const r = await run({ summary: null });
    expect(r.item).toBeNull();
  });

  it("omits the row on a page that doesn't load the shared module", async () => {
    const r = await run({ module: false });
    expect(r.item).toBeNull();
    expect(r.calls).toEqual([]);
  });

  it("fetches once per page load, not once per menu open", async () => {
    const r = await run();
    r.wire();
    r.wire();
    expect(r.summaryFn).toHaveBeenCalledTimes(1);
  });

  it("survives a failed fetch by offering no row rather than throwing", async () => {
    const g = globalThis as Record<string, unknown>;
    g.PolarisPasskeys = { summary: vi.fn(async () => { throw new Error("offline"); }), open: () => {} };
    g.api = { auth: { passkeys: () => {} } };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const mod = new Function(SRC)() as { wire: () => void; item: () => MenuItem };
    mod.wire();
    await Promise.resolve();
    await Promise.resolve();
    expect(mod.item()).toBeNull();
  });

  it("re-reads state after the flow changed it, so the count relabels", async () => {
    const r = await run({ summary: { count: 0 } });
    r.item?.onSelect?.();
    expect(r.opened[0]).toHaveProperty("onChange");
  });
});
