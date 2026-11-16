/**
 * tests/unit/ldapAuthService.test.ts — own unit suite for
 * src/services/ldapAuthService.ts (CQ-T010 batch 8c).
 *
 * No directory is contacted: withBoundLdapClient is replaced by a recorder
 * that hands `fn` a fake client whose search answers from per-test fixtures.
 * The module keeps a 30 s settings cache with no reset hook, so every test
 * re-imports the service after vi.resetModules() (the Prisma stand-in is a
 * hoisted object so it survives the reset).
 *
 * The dummy-bind timing half (rule 108(j)) also has ldapLoginTiming.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

type Bind = { host: string; port?: number; useLdaps?: boolean; verifyTls?: boolean; bindDn: string; bindPassword: string };
type SearchCall = { base: string; opts: Record<string, any> };

const h = vi.hoisted(() => ({
  prisma: {
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
  },
  binds: [] as Bind[],
  searches: [] as SearchCall[],
  // base DN → entries; or a function for finer control
  searchResult: (_base: string, _opts: Record<string, any>): Array<Record<string, unknown>> => [],
  failBind: (_cfg: Bind): Error | null => null,
  provisionExternalUser: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/ssoProvisioning.js", () => ({ provisionExternalUser: h.provisionExternalUser }));
vi.mock("../../src/services/ldapClient.js", async (orig) => {
  const real = await orig<typeof import("../../src/services/ldapClient.js")>();
  return {
    ...real,
    withBoundLdapClient: vi.fn(async (cfg: Bind, _signal: unknown, fn: (c: unknown) => unknown) => {
      h.binds.push({ ...cfg });
      const err = h.failBind(cfg);
      if (err) throw err;
      return fn({
        search: async (base: string, opts: Record<string, any>) => {
          h.searches.push({ base, opts });
          return { searchEntries: h.searchResult(base, opts) };
        },
      });
    }),
  };
});

type Svc = typeof import("../../src/services/ldapAuthService.js");
let svc: Svc;

const MASK = "••••••••";
const CONFIGURED = {
  enabled: true,
  url: "ldaps://dc.example:636",
  bindDn: "cn=svc,dc=example",
  bindPassword: "svc-pw",
  searchBase: "dc=example",
};

function stored(value: Record<string, unknown> | null) {
  h.prisma.setting.findUnique.mockResolvedValue(value ? { key: "ldap", value } : null);
}

beforeEach(async () => {
  h.binds = [];
  h.searches = [];
  h.searchResult = () => [];
  h.failBind = () => null;
  h.prisma.setting.findUnique.mockReset();
  h.prisma.setting.upsert.mockReset().mockResolvedValue({});
  h.provisionExternalUser.mockReset();
  vi.resetModules();
  svc = await import("../../src/services/ldapAuthService.js");
});

describe("getLdapSettingsMasked", () => {
  it("returns the defaults when nothing is stored", async () => {
    stored(null);
    const s = await svc.getLdapSettingsMasked();
    expect(s).toMatchObject({
      enabled: false,
      url: "",
      bindPassword: "",
      searchFilter: "(sAMAccountName={{username}})",
      tlsVerify: true,
      userIdAttribute: "objectGUID",
      groupAttribute: "memberOf",
      groupFilter: "(member={{userDn}})",
    });
  });

  it("masks a stored bind password and overlays stored fields on the defaults", async () => {
    stored({ ...CONFIGURED, emailAttr: "userPrincipalName" });
    const s = await svc.getLdapSettingsMasked();
    expect(s.bindPassword).toBe(MASK);
    expect(s.emailAttr).toBe("userPrincipalName");
    expect(s.displayNameAttr).toBe("displayName");
  });

  it("caches the row for 30 s", async () => {
    stored(CONFIGURED);
    await svc.getLdapSettingsMasked();
    await svc.isLdapEnabled();
    expect(h.prisma.setting.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("keptLdapBindPassword (rule 111(a))", () => {
  const cur = { url: "ldaps://dc.example:636", tlsVerify: true, bindPassword: "stored" };

  it("saves a typed password (trimmed) and clears on blank", () => {
    expect(svc.keptLdapBindPassword(cur, { bindPassword: " new " })).toBe("new");
    expect(svc.keptLdapBindPassword(cur, { bindPassword: "" })).toBe("");
  });

  it("keeps the stored password for an echoed mask (bullet or legacy asterisks) when the destination is unchanged", () => {
    expect(svc.keptLdapBindPassword(cur, { bindPassword: MASK })).toBe("stored");
    expect(svc.keptLdapBindPassword(cur, { bindPassword: "********" })).toBe("stored");
    expect(svc.keptLdapBindPassword(cur, { bindPassword: MASK, url: " ldaps://dc.example:636 ", tlsVerify: true })).toBe("stored");
  });

  it("returns '' for an echoed mask when nothing is stored", () => {
    expect(svc.keptLdapBindPassword({ ...cur, bindPassword: "" }, { bindPassword: MASK, url: "ldap://elsewhere" })).toBe("");
  });

  it("400s an echoed mask when the URL moved", () => {
    expect(() => svc.keptLdapBindPassword(cur, { bindPassword: MASK, url: "ldaps://evil.example:636" })).toThrow(
      expect.objectContaining({ httpStatus: 400, message: expect.stringContaining("LDAP server URL") }),
    );
  });

  it("400s an echoed mask when certificate checking was switched off", () => {
    expect(() => svc.keptLdapBindPassword(cur, { bindPassword: MASK, tlsVerify: false })).toThrow(
      expect.objectContaining({ httpStatus: 400, message: expect.stringContaining("certificate check") }),
    );
  });

  it("a typed password is saved even when the URL moves", () => {
    expect(svc.keptLdapBindPassword(cur, { bindPassword: "fresh", url: "ldap://new" })).toBe("fresh");
  });
});

describe("updateLdapSettings", () => {
  it("trims, falls back to stored then default values, upserts, and refreshes the cache", async () => {
    stored({ ...CONFIGURED, displayNameAttr: "cn" });
    const out = await svc.updateLdapSettings({
      enabled: true,
      url: " ldaps://dc.example:636 ",
      bindPassword: MASK,
      searchFilter: " (uid={{username}}) ",
      tlsVerify: true,
    });
    expect(out).toMatchObject({
      enabled: true,
      url: "ldaps://dc.example:636",
      bindDn: "cn=svc,dc=example",
      bindPassword: "svc-pw",
      searchFilter: "(uid={{username}})",
      displayNameAttr: "cn",
      emailAttr: "mail",
    });
    expect(h.prisma.setting.upsert).toHaveBeenCalledWith({
      where: { key: "ldap" },
      update: { value: out },
      create: { key: "ldap", value: out },
    });
    // served from the refreshed cache, no second read
    expect((await svc.getLdapSettingsMasked()).searchFilter).toBe("(uid={{username}})");
    expect(h.prisma.setting.findUnique).toHaveBeenCalledTimes(1);
  });

  it("refuses to carry the stored password to a new URL and writes nothing", async () => {
    stored(CONFIGURED);
    await expect(svc.updateLdapSettings({ enabled: true, url: "ldaps://other:636", bindPassword: MASK })).rejects.toMatchObject({
      httpStatus: 400,
    });
    expect(h.prisma.setting.upsert).not.toHaveBeenCalled();
  });

  // Partial bodies are not merged for these three fields: the UI always posts
  // the whole form, so this is current behaviour, noted in the batch report.
  it("an omitted enabled / tlsVerify / bindPassword resets to off / on / blank (full-form semantics)", async () => {
    stored({ ...CONFIGURED, tlsVerify: false });
    const out = await svc.updateLdapSettings({ url: CONFIGURED.url });
    expect(out.enabled).toBe(false);
    expect(out.tlsVerify).toBe(true);
    expect(out.bindPassword).toBe("");
    expect(out.bindDn).toBe(CONFIGURED.bindDn);
  });
});

describe("isLdapEnabled", () => {
  it.each([
    [{ ...CONFIGURED }, true],
    [{ ...CONFIGURED, enabled: false }, false],
    [{ ...CONFIGURED, url: "" }, false],
    [{ ...CONFIGURED, bindDn: "" }, false],
    [{ ...CONFIGURED, searchBase: "" }, false],
    [{ ...CONFIGURED, bindPassword: "" }, true],
  ])("%o → %s", async (value, expected) => {
    stored(value);
    expect(await svc.isLdapEnabled()).toBe(expected);
  });
});

describe("authenticateLdapUser", () => {
  const aliceEntry = {
    dn: "CN=Alice,OU=Users,DC=example",
    displayName: ["Alice Liddell"],
    mail: "alice@example.com",
    objectGUID: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
    memberOf: ["CN=Ops,DC=example", "CN=NOC,DC=example"],
  };

  it("rejects an empty password with 401 before any settings read or bind", async () => {
    await expect(svc.authenticateLdapUser("alice", "")).rejects.toMatchObject({ httpStatus: 401 });
    expect(h.prisma.setting.findUnique).not.toHaveBeenCalled();
    expect(h.binds).toHaveLength(0);
  });

  it("400s when LDAP is not configured", async () => {
    stored({ ...CONFIGURED, enabled: false });
    await expect(svc.authenticateLdapUser("alice", "pw")).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.binds).toHaveLength(0);
  });

  it("escapes the username into the filter (RFC 4515) and searches with the configured attributes", async () => {
    stored(CONFIGURED);
    await svc.authenticateLdapUser("a*)(uid=*", "pw").catch(() => {});
    const s = h.searches[0];
    expect(s.base).toBe("dc=example");
    expect(s.opts.filter).toBe("(sAMAccountName=a\\2a\\29\\28uid=\\2a)");
    expect(s.opts).toMatchObject({
      scope: "sub",
      attributes: ["displayName", "mail", "objectGUID", "memberOf"],
      explicitBufferAttributes: ["objectGUID"],
      sizeLimit: 2,
    });
    expect(h.binds[0]).toMatchObject({ host: "dc.example", port: 636, useLdaps: true, verifyTls: true, bindDn: "cn=svc,dc=example" });
  });

  it("parses an ldap:// URL without a port as plain LDAP with the default port", async () => {
    stored({ ...CONFIGURED, url: "ldap://dc.example", tlsVerify: false });
    await svc.authenticateLdapUser("alice", "pw").catch(() => {});
    expect(h.binds[0]).toMatchObject({ host: "dc.example", port: undefined, useLdaps: false, verifyTls: false });
  });

  it("asks for objectGUID / objectSid as buffers but entryUUID as text", async () => {
    stored({ ...CONFIGURED, userIdAttribute: "entryUUID" });
    await svc.authenticateLdapUser("alice", "pw").catch(() => {});
    expect(h.searches[0].opts.explicitBufferAttributes).toEqual([]);
  });

  it.each([
    ["no entry", []],
    ["two (ambiguous) entries", [{ dn: "cn=a" }, { dn: "cn=b" }]],
  ])("fails closed with 401 on %s, after a dummy bind", async (_label, entries) => {
    stored(CONFIGURED);
    h.searchResult = () => entries as Array<Record<string, unknown>>;
    h.failBind = (cfg) => (cfg.bindDn.startsWith("cn=polaris-no-such-user-") ? new Error("invalidCredentials") : null);
    await expect(svc.authenticateLdapUser("alice", "pw")).rejects.toMatchObject({ httpStatus: 401 });
    expect(h.binds).toHaveLength(2);
    expect(h.binds[1].bindDn).toMatch(/^cn=polaris-no-such-user-[0-9a-f-]{36},dc=example$/);
    expect(h.binds[1].bindPassword).not.toBe("pw");
  });

  it("502s when the entry has no DN", async () => {
    stored(CONFIGURED);
    h.searchResult = () => [{ dn: "" }];
    await expect(svc.authenticateLdapUser("alice", "pw")).rejects.toMatchObject({ httpStatus: 502 });
  });

  it("re-binds as the user with the typed password; a failed bind propagates", async () => {
    stored(CONFIGURED);
    h.searchResult = () => [aliceEntry];
    h.failBind = (cfg) => (cfg.bindDn === aliceEntry.dn ? Object.assign(new Error("bad"), { name: "InvalidCredentialsError" }) : null);
    await expect(svc.authenticateLdapUser("alice", "wrong")).rejects.toThrow("bad");
    expect(h.binds[1]).toMatchObject({ bindDn: aliceEntry.dn, bindPassword: "wrong" });
  });

  it("returns the verified profile with the decoded objectGUID and memberOf groups", async () => {
    stored(CONFIGURED);
    h.searchResult = () => [aliceEntry];
    const out = await svc.authenticateLdapUser("alice", "pw");
    expect(out).toEqual({
      dn: aliceEntry.dn,
      username: "alice",
      displayName: "Alice Liddell",
      email: "alice@example.com",
      ldapUid: "00112233445566778899aabbccddeeff",
      groups: ["CN=Ops,DC=example", "CN=NOC,DC=example"],
    });
    expect(h.binds).toHaveLength(2); // no reverse search: groupBaseDn is empty
  });

  it("hex-encodes a non-16-byte binary id, keeps a text id, and falls back to the lowercased DN", async () => {
    stored({ ...CONFIGURED, userIdAttribute: "objectSid" });
    h.searchResult = () => [{ ...aliceEntry, objectSid: Buffer.from([1, 2, 0xab]) }];
    expect((await svc.authenticateLdapUser("alice", "pw")).ldapUid).toBe("0102ab");

    vi.resetModules();
    svc = await import("../../src/services/ldapAuthService.js");
    stored({ ...CONFIGURED, userIdAttribute: "entryUUID" });
    h.searchResult = () => [{ ...aliceEntry, entryUUID: [" 1234-abcd "] }];
    expect((await svc.authenticateLdapUser("alice", "pw")).ldapUid).toBe("1234-abcd");

    h.searchResult = () => [{ dn: aliceEntry.dn }];
    expect((await svc.authenticateLdapUser("alice", "pw")).ldapUid).toBe("cn=alice,ou=users,dc=example");
  });

  it("reads Buffer-valued profile attributes and tolerates missing ones", async () => {
    stored(CONFIGURED);
    h.searchResult = () => [{ dn: aliceEntry.dn, displayName: Buffer.from("Ålice"), memberOf: "CN=Solo,DC=example" }];
    const out = await svc.authenticateLdapUser("alice", "pw");
    expect(out.displayName).toBe("Ålice");
    expect(out.email).toBe("");
    expect(out.groups).toEqual(["CN=Solo,DC=example"]);
  });

  it("adds reverse-search groups (escaped user DN in the filter) without duplicates", async () => {
    stored({ ...CONFIGURED, groupBaseDn: "ou=groups,dc=example" });
    const entry = { ...aliceEntry, dn: "CN=Smith\\, J (x),DC=example" };
    h.searchResult = (base) =>
      base === "ou=groups,dc=example" ? [{ dn: "CN=Ops,DC=example" }, { dn: "CN=Extra,DC=example" }, { dn: "" }] : [entry];
    const out = await svc.authenticateLdapUser("alice", "pw");
    expect(out.groups).toEqual(["CN=Ops,DC=example", "CN=NOC,DC=example", "CN=Extra,DC=example"]);
    const reverse = h.searches[1];
    expect(reverse.opts.filter).toBe("(member=CN=Smith\\5c, J \\28x\\29,DC=example)");
    expect(h.binds[2].bindDn).toBe("cn=svc,dc=example");
  });

  it("a failing reverse search is best-effort", async () => {
    stored({ ...CONFIGURED, groupBaseDn: "ou=groups,dc=example" });
    h.searchResult = () => [aliceEntry];
    let n = 0;
    h.failBind = () => (++n === 3 ? new Error("down") : null);
    const out = await svc.authenticateLdapUser("alice", "pw");
    expect(out.groups).toEqual(aliceEntry.memberOf);
  });

  it("skips the reverse search when the group filter is blank", async () => {
    stored({ ...CONFIGURED, groupBaseDn: "ou=groups,dc=example", groupFilter: "" });
    h.searchResult = () => [aliceEntry];
    await svc.authenticateLdapUser("alice", "pw");
    expect(h.binds).toHaveLength(2);
  });
});

describe("findOrProvisionLdapUser", () => {
  it("provisions under ldap / ldapUid, mapping empty profile fields to null", async () => {
    h.provisionExternalUser.mockResolvedValue({ id: "u-1" });
    const out = await svc.findOrProvisionLdapUser({
      dn: "cn=a",
      username: "alice",
      displayName: "",
      email: "",
      ldapUid: "guid",
      groups: ["g"],
    });
    expect(out).toEqual({ id: "u-1" });
    expect(h.provisionExternalUser).toHaveBeenCalledWith({
      provider: "ldap",
      externalIdField: "ldapUid",
      externalId: "guid",
      usernameHint: "alice",
      displayName: null,
      email: null,
      groups: ["g"],
    });
  });
});

describe("testLdapConnection", () => {
  it.each([
    [{ ...CONFIGURED, url: "" }, "Server URL is required"],
    [{ ...CONFIGURED, bindDn: "" }, "Bind DN is required"],
    [{ ...CONFIGURED, bindPassword: "" }, "Bind password is required"],
    [{ ...CONFIGURED, searchBase: "" }, "Search base is required"],
  ])("refuses an incomplete config without binding (%#)", async (value, message) => {
    stored(value);
    expect(await svc.testLdapConnection()).toEqual({ ok: false, message });
    expect(h.binds).toHaveLength(0);
  });

  it("binds as the service account and resolves the base DN", async () => {
    stored(CONFIGURED);
    h.searchResult = () => [{ dn: "dc=example" }];
    const out = await svc.testLdapConnection();
    expect(out.ok).toBe(true);
    expect(out.message).toContain("1 entry");
    expect(h.searches[0].opts).toMatchObject({ scope: "base", filter: "(objectClass=*)" });
  });

  it("maps a bind failure through formatLdapError", async () => {
    stored(CONFIGURED);
    h.failBind = () => Object.assign(new Error("49"), { name: "InvalidCredentialsError" });
    expect(await svc.testLdapConnection()).toEqual({ ok: false, message: "Invalid bind DN or password" });
  });
});
