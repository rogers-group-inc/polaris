/**
 * tests/unit/ldapLoginTiming.test.ts — re-scan F77. A username the directory
 * does not find used to cost one LDAP connection, a found one two (search,
 * then bind as the user) — an unauthenticated enumeration oracle for
 * directory usernames. Now a not-found name pays a second bind too, against a
 * DN that cannot exist with a random password, so no real account's failure
 * counter moves.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  binds: [] as Array<{ bindDn: string; bindPassword: string }>,
  entries: [] as Array<Record<string, unknown>>,
  prisma: {
    setting: {
      findUnique: vi.fn(async () => ({
        key: "ldap",
        value: {
          enabled: true, url: "ldap://dc.example:389", bindDn: "cn=svc,dc=example", bindPassword: "svc-pw",
          searchBase: "dc=example", searchFilter: "(sAMAccountName={{username}})",
        },
      })),
    },
  },
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/ldapClient.js", async (orig) => {
  const real = await orig<typeof import("../../src/services/ldapClient.js")>();
  return {
    ...real,
    withBoundLdapClient: vi.fn(async (cfg: { bindDn: string; bindPassword: string }, _t: unknown, fn: (c: unknown) => unknown) => {
      h.binds.push({ bindDn: cfg.bindDn, bindPassword: cfg.bindPassword });
      if (cfg.bindDn.startsWith("cn=polaris-no-such-user-")) throw new Error("invalidCredentials");
      return fn({ search: async () => ({ searchEntries: h.entries }) });
    }),
  };
});

import { authenticateLdapUser } from "../../src/services/ldapAuthService.js";

beforeEach(() => { h.binds = []; h.entries = []; });

describe("LDAP login cost does not depend on whether the directory knows the name", () => {
  it("a name the directory does not find still pays a second (dummy) bind", async () => {
    await expect(authenticateLdapUser("nobody", "pw")).rejects.toMatchObject({ httpStatus: 401 });
    expect(h.binds).toHaveLength(2);
    expect(h.binds[0].bindDn).toBe("cn=svc,dc=example");
    // The dummy bind: a DN that cannot exist, never the service account and
    // never the typed password, so nothing real is locked out.
    expect(h.binds[1].bindDn).toMatch(/^cn=polaris-no-such-user-[0-9a-f-]{36},dc=example$/);
    expect(h.binds[1].bindPassword).not.toBe("pw");
    expect(h.binds[1].bindPassword).not.toBe("svc-pw");
  });

  it("a found name costs the same two binds (search, then as the user)", async () => {
    h.entries = [{ dn: "cn=alice,dc=example" }];
    await authenticateLdapUser("alice", "pw").catch(() => {});
    expect(h.binds.slice(0, 2).map((b) => b.bindDn)).toEqual(["cn=svc,dc=example", "cn=alice,dc=example"]);
  });
});
