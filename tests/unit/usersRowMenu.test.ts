/**
 * tests/unit/usersRowMenu.test.ts — the Users page row-menu item builders
 * (`_userMenuItems` / `_roleMenuItems` in public/js/users.js).
 *
 * The Users table carried up to five conditional buttons per row and they moved
 * behind the username as a context menu. The conditions are the fragile part and
 * they are security-shaped: an IdP-managed account has no local password to
 * reset, an Azure account's 2FA belongs to the identity provider, and "reset
 * someone else's 2FA" must not be offered for your OWN account (that is the
 * self-service flow) nor for an account that has no 2FA to reset. Offering the
 * wrong verb here means an admin clicking into a modal that cannot work, or a
 * local-password reset surfaced for a federated account.
 *
 * `_roleMenuItems` pins the other half: Delete stays PRESENT but disabled with
 * the reason as its tooltip, because hiding it leaves an admin hunting for an
 * action that used to be there.
 *
 * users.js is a classic browser script; the builders are top-level function
 * declarations, so an indirect eval puts them on globalThis.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

interface MenuItem {
  label?: string;
  separator?: boolean;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  onSelect?: () => void;
}
interface UserRow {
  id: string;
  username: string;
  authProvider?: string;
  totpEnabled?: boolean;
  role?: { id: string };
}
interface RoleRow { id: string; name: string; isBuiltIn?: boolean; userCount: number }

const g = globalThis as Record<string, unknown>;
let userMenuItems: (u: UserRow) => MenuItem[];
let roleMenuItems: (r: RoleRow) => MenuItem[];

/** Just the actionable labels, separators dropped. */
const labels = (items: MenuItem[]) => items.filter((i) => !i.separator).map((i) => i.label);

beforeAll(() => {
  const win = new Window();
  g.window = win;
  g.document = win.document;
  g.PolarisPrefs = { save: () => {}, load: () => null };
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g.showToast = () => {};
  g.showConfirm = async () => false;
  g.permAtLeast = () => true;
  g.api = {};
  g.currentUsername = "alice";           // the logged-in operator, for isSelf
  g.formatDate = () => "";
  g.regionPillsHtml = () => "";
  g.TableSF = function () {};
  g.setupColumnLayout = () => null;
  g.userReady = Promise.resolve();

  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/users.js"), "utf8"));
  userMenuItems = g._userMenuItems as typeof userMenuItems;
  roleMenuItems = g._roleMenuItems as typeof roleMenuItems;
  expect(typeof userMenuItems, "users.js no longer declares _userMenuItems").toBe("function");
  expect(typeof roleMenuItems, "users.js no longer declares _roleMenuItems").toBe("function");
});

describe("_userMenuItems", () => {
  const local = (over: Partial<UserRow> = {}): UserRow =>
    ({ id: "u1", username: "bob", authProvider: "local", totpEnabled: false, role: { id: "r1" }, ...over });

  it("always offers role, tags and delete", () => {
    // These three are unconditional, which is what guarantees the trigger can
    // never open an empty menu.
    const l = labels(userMenuItems(local()));
    expect(l).toContain("Change Role");
    expect(l).toContain("Assign Tags");
    expect(l).toContain("Delete");
  });

  it("offers a password reset for a local account", () => {
    expect(labels(userMenuItems(local()))).toContain("Reset password");
  });

  it("does NOT offer a password reset for an IdP-managed account", () => {
    // isIdpManaged is authProvider !== "local" — there is no local credential
    // to reset, so the old row hid the button and the menu must too.
    for (const p of ["azure", "oidc", "ldap", "entra-proxy"]) {
      expect(labels(userMenuItems(local({ authProvider: p }))), p).not.toContain("Reset password");
    }
  });

  it("offers self-service 2FA on your OWN row", () => {
    const l = labels(userMenuItems(local({ username: "alice", authProvider: "local" })));
    expect(l).toContain("Two-factor auth");
    expect(l).not.toContain("Reset 2FA");
  });

  it("offers an admin 2FA reset on someone else's row only when they have it enabled", () => {
    expect(labels(userMenuItems(local({ totpEnabled: true })))).toContain("Reset 2FA");
    expect(labels(userMenuItems(local({ totpEnabled: false })))).not.toContain("Reset 2FA");
  });

  it("offers no 2FA verb at all for an Azure account", () => {
    // The IdP owns the second factor there — true even for your own row.
    const other = labels(userMenuItems(local({ authProvider: "azure", totpEnabled: true })));
    expect(other).not.toContain("Reset 2FA");
    expect(other).not.toContain("Two-factor auth");
    const self = labels(userMenuItems(local({ username: "alice", authProvider: "azure" })));
    expect(self).not.toContain("Two-factor auth");
  });

  it("puts Delete last, marked destructive, behind a separator", () => {
    const items = userMenuItems(local());
    const last = items[items.length - 1]!;
    expect(last.label).toBe("Delete");
    expect(last.danger).toBe(true);
    expect(items[items.length - 2]!.separator).toBe(true);
  });

  it("never returns an empty menu, whatever the account shape", () => {
    const shapes: Partial<UserRow>[] = [
      {}, { authProvider: "azure" }, { authProvider: "oidc", totpEnabled: true },
      { username: "alice" }, { authProvider: "ldap", totpEnabled: false },
    ];
    for (const s of shapes) expect(labels(userMenuItems(local(s))).length).toBeGreaterThan(0);
  });
});

describe("_roleMenuItems", () => {
  const role = (over: Partial<RoleRow> = {}): RoleRow =>
    ({ id: "r1", name: "networkadmin", isBuiltIn: false, userCount: 0, ...over });

  it("leads with Edit — the name used to jump straight there", () => {
    expect(roleMenuItems(role())[0]!.label).toBe("Edit");
  });

  it("enables Delete for an unused custom role", () => {
    const del = roleMenuItems(role()).find((i) => i.label === "Delete")!;
    expect(del.disabled).toBeFalsy();
    expect(del.danger).toBe(true);
  });

  it("disables Delete on a built-in role and says why", () => {
    const del = roleMenuItems(role({ isBuiltIn: true })).find((i) => i.label === "Delete")!;
    expect(del.disabled).toBe(true);
    expect(del.title).toMatch(/built-in/i);
  });

  it("disables Delete while users still hold the role and says why", () => {
    const del = roleMenuItems(role({ userCount: 3 })).find((i) => i.label === "Delete")!;
    expect(del.disabled).toBe(true);
    expect(del.title).toMatch(/reassign/i);
  });

  it("keeps Delete present rather than hiding it when blocked", () => {
    // Hiding it would leave an admin hunting for an action that used to exist.
    expect(labels(roleMenuItems(role({ isBuiltIn: true })))).toContain("Delete");
  });

  it("does not mark a disabled Delete as destructive", () => {
    // Red on an inert control reads as "this will do damage" when it does nothing.
    expect(roleMenuItems(role({ isBuiltIn: true })).find((i) => i.label === "Delete")!.danger).toBe(false);
  });
});
