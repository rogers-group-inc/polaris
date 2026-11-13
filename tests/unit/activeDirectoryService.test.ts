/**
 * tests/unit/activeDirectoryService.test.ts — the own suite for
 * src/services/activeDirectoryService.ts (CQ-T010).
 *
 * The LDAP bind is replaced at the client module (`ldapClient.withBoundLdapClient`
 * hands the callback a fake client whose `search` returns canned entries); the
 * module's pure helpers (GUID decode, error formatting, filter escaping) stay
 * real. Pins: the connection test's field checks and error mapping, the live
 * GAL typeahead filter and its result shaping, the bulk GAL read for rule 35
 * (filter string, objectGUID identity, the "absent attribute is no claim"
 * handling of userAccountControl and msExchRecipientTypeDetails), the manual
 * query tool, device discovery (SID / FILETIME / generalized-time decoding, the
 * zero-GUID guard, the 502 on a failed search, the scoped GUID filter) and the
 * rule 70 sweep inputs — the RAW guid set taken before the OU and
 * includeDisabled filters, completeness on cap / abort, and adSweepBlockedReason.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  search: vi.fn(),
  bound: vi.fn(),
}));
vi.mock("../../src/services/ldapClient.js", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return { ...real, withBoundLdapClient: m.bound };
});

import { AppError } from "../../src/utils/errors.js";
import {
  testConnection,
  adSearchFilter,
  searchDirectoryAd,
  buildGalLdapFilter,
  listDirectoryPeople,
  proxyQuery,
  discoverDevices,
  adSweepBlockedReason,
  type ActiveDirectoryConfig,
} from "../../src/services/activeDirectoryService.js";
import { normalizeDirectorySyncFilter } from "../../src/services/directorySyncService.js";

const CFG: ActiveDirectoryConfig = {
  host: "dc1.corp.local", bindDn: "CN=svc,DC=corp,DC=local", bindPassword: "pw", baseDn: "DC=corp,DC=local",
};

beforeEach(() => {
  m.search.mockReset();
  m.bound.mockReset();
  m.search.mockResolvedValue({ searchEntries: [] });
  m.bound.mockImplementation(async (_cfg: unknown, _signal: unknown, fn: (c: unknown) => unknown) => fn({ search: m.search }));
});

/** 16-byte GUID buffer whose hex is `hexByte` repeated. */
function guid(hexByte = "ab"): Buffer {
  return Buffer.from(hexByte.repeat(16), "hex");
}

/** Binary SID S-1-5-<subs...>. */
function sid(subs: number[]): Buffer {
  const b = Buffer.alloc(8 + subs.length * 4);
  b.writeUInt8(1, 0);
  b.writeUInt8(subs.length, 1);
  b.writeUIntBE(5, 2, 6);
  subs.forEach((s, i) => b.writeUInt32LE(s, 8 + i * 4));
  return b;
}

function filetime(iso: string): string {
  return (BigInt(Date.parse(iso)) * 10000n + 116444736000000000n).toString();
}

// ─── testConnection ──────────────────────────────────────────────────────────

describe("testConnection", () => {
  it.each([
    ["host", "Host is required"],
    ["bindDn", "Bind DN is required"],
    ["bindPassword", "Bind password is required"],
    ["baseDn", "Base DN is required"],
  ])("refuses without %s and never binds", async (field, message) => {
    const r = await testConnection({ ...CFG, [field]: "" });
    expect(r).toEqual({ ok: false, message });
    expect(m.bound).not.toHaveBeenCalled();
  });

  it("reports the sample computer count on success", async () => {
    m.search.mockResolvedValue({ searchEntries: [{ dn: "CN=PC1" }] });
    const r = await testConnection(CFG);
    expect(r).toEqual({ ok: true, message: "Connected — bind succeeded, sample computer query returned 1 entry(s)" });
    expect(m.search).toHaveBeenCalledWith("DC=corp,DC=local", expect.objectContaining({
      scope: "sub", filter: "(&(objectCategory=computer)(objectClass=computer))", attributes: ["cn"], sizeLimit: 1,
    }));
  });

  it("honours a configured one-level scope", async () => {
    await testConnection({ ...CFG, searchScope: "one" });
    expect(m.search.mock.calls[0][1].scope).toBe("one");
  });

  it("maps a bind failure to the operator message instead of throwing", async () => {
    m.bound.mockRejectedValue(Object.assign(new Error("80090308: LdapErr"), { name: "InvalidCredentialsError" }));
    expect(await testConnection(CFG)).toEqual({ ok: false, message: "Invalid bind DN or password" });
  });

  it("keeps only the first line of an unrecognized error", async () => {
    m.bound.mockRejectedValue(new Error("weird failure\nstack junk"));
    expect((await testConnection(CFG)).message).toBe("weird failure");
  });
});

// ─── adSearchFilter / searchDirectoryAd ──────────────────────────────────────

describe("adSearchFilter", () => {
  const one = (w: string) => `(|(cn=*${w}*)(mail=*${w}*)(displayName=*${w}*)(sAMAccountName=*${w}*)(givenName=*${w}*)(sn=*${w}*))`;
  const wrap = (inner: string) => `(&(mail=*)(|(objectClass=user)(objectClass=group)(objectClass=contact))${inner})`;

  it("matches one word across every name and address attribute", () => {
    expect(adSearchFilter("john")).toBe(wrap(one("john")));
  });

  it("requires every word, in any order, splitting on spaces, commas and semicolons", () => {
    expect(adSearchFilter("  Smith, John ")).toBe(wrap(`(&${one("Smith")}${one("John")})`));
    expect(adSearchFilter("a;b c")).toBe(wrap(`(&${one("a")}${one("b")}${one("c")})`));
  });

  it("escapes filter metacharacters in each word (RFC 4515)", () => {
    expect(adSearchFilter("*)(uid=*")).toBe(wrap(one("\\2a\\29\\28uid=\\2a")));
    expect(adSearchFilter("a\\b")).toContain("a\\5cb");
  });
});

describe("searchDirectoryAd", () => {
  it("returns nothing for a query under two characters without binding", async () => {
    expect(await searchDirectoryAd(CFG, " a ")).toEqual([]);
    expect(m.bound).not.toHaveBeenCalled();
  });

  it("returns nothing when no base DN is configured", async () => {
    expect(await searchDirectoryAd({ ...CFG, baseDn: "" }, "john")).toEqual([]);
    expect(m.bound).not.toHaveBeenCalled();
  });

  it("shapes users, groups and contacts into address-book hits", async () => {
    m.search.mockResolvedValue({
      searchEntries: [
        { dn: "CN=Jane,OU=Staff", mail: "jane@corp.com", displayName: "Jane Doe", title: "Engineer", department: "IT", objectClass: ["top", "user"] },
        { dn: "CN=Ops,OU=Groups", mail: ["ops@corp.com", "alt@corp.com"], cn: "Ops", objectClass: ["top", "Group"] },
        { dn: "CN=NoMail", objectClass: "user" },
        { dn: "CN=Vendor", mail: "v@vendor.io", cn: "Vendor", description: "Supplier", objectClass: "contact" },
        { dn: "CN=Bare", mail: "bare@corp.com", objectClass: "user" },
      ],
    });
    const hits = await searchDirectoryAd(CFG, "an");
    expect(hits).toEqual([
      { id: "CN=Jane,OU=Staff", email: "jane@corp.com", name: "Jane Doe", description: "Engineer — IT", kind: "person" },
      { id: "CN=Ops,OU=Groups", email: "ops@corp.com", name: "Ops", description: "Distribution list", kind: "group" },
      { id: "CN=Vendor", email: "v@vendor.io", name: "Vendor", description: "Supplier", kind: "person" },
      { id: "CN=Bare", email: "bare@corp.com", name: null, description: null, kind: "person" },
    ]);
  });

  it("clamps the directory size limit to 1..100 and trims the result to the limit", async () => {
    m.search.mockResolvedValue({ searchEntries: Array.from({ length: 5 }, (_, i) => ({ dn: `CN=${i}`, mail: `${i}@c.com` })) });
    const hits = await searchDirectoryAd(CFG, "xx", 2);
    expect(hits).toHaveLength(2);
    expect(m.search.mock.calls[0][1].sizeLimit).toBe(2);
    await searchDirectoryAd(CFG, "xx", 500);
    expect(m.search.mock.calls[1][1].sizeLimit).toBe(100);
    await searchDirectoryAd(CFG, "xx", 0);
    expect(m.search.mock.calls[2][1].sizeLimit).toBe(1);
  });

  it("propagates a bind failure", async () => {
    m.bound.mockRejectedValue(new Error("down"));
    await expect(searchDirectoryAd(CFG, "john")).rejects.toThrow("down");
  });
});

// ─── buildGalLdapFilter / listDirectoryPeople ────────────────────────────────

describe("buildGalLdapFilter", () => {
  it("builds the default filter: users, contacts and mail-enabled groups, minus disabled and shared/room/equipment", () => {
    expect(buildGalLdapFilter(normalizeDirectorySyncFilter(undefined))).toBe(
      "(&(mail=*)(|(&(objectCategory=person)(objectClass=user))(objectClass=contact)(&(objectClass=group)(mail=*)))" +
      "(!(userAccountControl:1.2.840.113556.1.4.803:=2))" +
      "(!(msExchRecipientTypeDetails=4))(!(msExchRecipientTypeDetails=16))(!(msExchRecipientTypeDetails=32)))",
    );
  });

  it("drops groups at the source and omits each negation when its toggle is off", () => {
    const f = normalizeDirectorySyncFilter({ includeGroups: false, excludeDisabled: false, excludeSharedMailboxes: false });
    expect(buildGalLdapFilter(f)).toBe("(&(mail=*)(|(&(objectCategory=person)(objectClass=user))(objectClass=contact)))");
  });
});

describe("listDirectoryPeople", () => {
  const F = normalizeDirectorySyncFilter(undefined);

  it("returns nothing without a base DN and never binds", async () => {
    expect(await listDirectoryPeople({ ...CFG, baseDn: "" }, F)).toEqual([]);
    expect(m.bound).not.toHaveBeenCalled();
  });

  it("pages the read, bounds it by the entry cap, asks for objectGUID as bytes, and passes the signal", async () => {
    const signal = new AbortController().signal;
    await listDirectoryPeople(CFG, normalizeDirectorySyncFilter({ maxEntries: 300 }), signal);
    expect(m.bound.mock.calls[0][1]).toBe(signal);
    expect(m.search).toHaveBeenCalledWith("DC=corp,DC=local", expect.objectContaining({
      scope: "sub", paged: { pageSize: 1000 }, sizeLimit: 300, timeLimit: 120, explicitBufferAttributes: ["objectGUID"],
    }));
    expect(m.search.mock.calls[0][1].attributes).toEqual(expect.arrayContaining(["mail", "msExchRecipientTypeDetails", "memberOf", "userAccountControl"]));
  });

  it("maps a user entry, keyed by its objectGUID rather than its DN", async () => {
    m.search.mockResolvedValue({ searchEntries: [{
      dn: "CN=Jane,OU=Staff,DC=corp", objectGUID: guid("0a"), mail: "jane@corp.com", displayName: "Jane Doe", cn: "jane",
      title: "Engineer", department: "IT", telephoneNumber: "555", userAccountControl: "512",
      msExchRecipientTypeDetails: "1", memberOf: ["CN=G1", "CN=G2"], objectClass: ["user"],
    }] });
    const [p] = await listDirectoryPeople(CFG, F);
    expect(p).toEqual({
      externalId: "0a".repeat(16), email: "jane@corp.com", name: "Jane Doe", jobTitle: "Engineer", department: "IT",
      phone: "555", description: null, kind: "person", distinguishedName: "CN=Jane,OU=Staff,DC=corp",
      disabled: false, mailboxKind: "user", groupDns: ["CN=G1", "CN=G2"],
    });
  });

  it("reads ACCOUNTDISABLE from userAccountControl and treats an absent one as no claim", async () => {
    m.search.mockResolvedValue({ searchEntries: [
      { objectGUID: guid("01"), mail: "a@c.com", userAccountControl: "514" },
      { objectGUID: guid("02"), mail: "b@c.com" },
    ] });
    const [a, b] = await listDirectoryPeople(CFG, F);
    expect(a.disabled).toBe(true);
    expect(b.disabled).toBeUndefined();
  });

  it("maps the Exchange recipient type, and a non-numeric one to unknown", async () => {
    m.search.mockResolvedValue({ searchEntries: [
      { objectGUID: guid("01"), mail: "a@c.com", msExchRecipientTypeDetails: "4" },
      { objectGUID: guid("02"), mail: "b@c.com", msExchRecipientTypeDetails: ["16"] },
      { objectGUID: guid("03"), mail: "c@c.com", msExchRecipientTypeDetails: "32" },
      { objectGUID: guid("04"), mail: "d@c.com", msExchRecipientTypeDetails: "2147483648" },
      { objectGUID: guid("06"), mail: "f@c.com", msExchRecipientTypeDetails: "garbage" },
    ] });
    const kinds = (await listDirectoryPeople(CFG, F)).map((p) => p.mailboxKind);
    expect(kinds).toEqual(["shared", "room", "equipment", "user", "unknown"]);
  });

  // BUG: mailboxKindOf runs Number(firstStr(raw)); an ABSENT msExchRecipientTypeDetails
  // gives firstStr → null and Number(null) → 0, which is finite, so an entry from a
  // directory with no Exchange schema is reported as mailboxKind "user" — a positive
  // claim — instead of "unknown" ("no Exchange schema: not a claim either way", the
  // function's own comment). It is the same Number(null) trap the userAccountControl
  // read four lines below guards against. No exclusion decision changes today
  // (directoryExclusionReason treats "user" and "unknown" alike), but the wrong claim
  // is persisted in every DirectoryContactSource.observed blob.
  it.fails("reports a missing Exchange recipient type as unknown, not user", async () => {
    m.search.mockResolvedValue({ searchEntries: [{ objectGUID: guid("05"), mail: "e@c.com" }] });
    const [p] = await listDirectoryPeople(CFG, F);
    expect(p.mailboxKind).toBe("unknown");
  });

  it("labels a group as a distribution list, falls back to mobile and the distinguishedName attribute", async () => {
    m.search.mockResolvedValue({ searchEntries: [
      { objectGUID: guid("01"), mail: "g@c.com", cn: "Group", objectClass: ["top", "group"], memberOf: "CN=Parent", distinguishedName: "CN=Group,DC=c" },
      { objectGUID: guid("02"), mail: "p@c.com", mobile: "777" },
    ] });
    const [g, p] = await listDirectoryPeople(CFG, F);
    expect(g).toMatchObject({ kind: "group", description: "Distribution list", name: "Group", distinguishedName: "CN=Group,DC=c", groupDns: ["CN=Parent"] });
    expect(p).toMatchObject({ phone: "777", distinguishedName: undefined, groupDns: [] });
  });

  it("skips an entry with no address, a non-binary GUID or an all-zero GUID", async () => {
    m.search.mockResolvedValue({ searchEntries: [
      { objectGUID: guid("01") },
      { objectGUID: "not-a-buffer", mail: "x@c.com" },
      { objectGUID: Buffer.alloc(16), mail: "zero@c.com" },
      { objectGUID: Buffer.alloc(8, 1), mail: "short@c.com" },
      { objectGUID: guid("09"), mail: "ok@c.com" },
    ] });
    expect((await listDirectoryPeople(CFG, F)).map((p) => p.email)).toEqual(["ok@c.com"]);
  });

  it("stops at an aborted signal and never returns more than the cap", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ objectGUID: guid(`1${i}`), mail: `${i}@c.com` }));
    m.search.mockResolvedValue({ searchEntries: entries });
    expect(await listDirectoryPeople(CFG, normalizeDirectorySyncFilter({ maxEntries: 3 }))).toHaveLength(3);
    const ac = new AbortController();
    ac.abort();
    expect(await listDirectoryPeople(CFG, F, ac.signal)).toEqual([]);
  });
});

// ─── proxyQuery ──────────────────────────────────────────────────────────────

describe("proxyQuery", () => {
  it("defaults to the computer filter under the configured base with a 50-row limit", async () => {
    await proxyQuery(CFG, {});
    expect(m.search).toHaveBeenCalledWith("DC=corp,DC=local", {
      scope: "sub", filter: "(&(objectCategory=computer)(objectClass=computer))", attributes: undefined, sizeLimit: 50, timeLimit: 15,
    });
  });

  it("uses the caller's trimmed filter, base, scope and attributes", async () => {
    await proxyQuery(CFG, { filter: "  (cn=pc1) ", baseDn: " OU=X,DC=corp ", scope: "base", attributes: ["cn"], sizeLimit: 5 });
    expect(m.search).toHaveBeenCalledWith("OU=X,DC=corp", expect.objectContaining({ filter: "(cn=pc1)", scope: "base", attributes: ["cn"], sizeLimit: 5 }));
  });

  it("treats an empty attribute list as all attributes and clamps the size limit to 1..500", async () => {
    await proxyQuery(CFG, { attributes: [], sizeLimit: 9999 });
    expect(m.search.mock.calls[0][1]).toMatchObject({ attributes: undefined, sizeLimit: 500 });
    await proxyQuery(CFG, { sizeLimit: -3 });
    expect(m.search.mock.calls[1][1].sizeLimit).toBe(1);
  });

  it("throws a 400 AppError when neither the query nor the config names a base DN", async () => {
    const err: any = await proxyQuery({ ...CFG, baseDn: "" }, { baseDn: "   " }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(400);
    expect(m.bound).not.toHaveBeenCalled();
  });

  it("stringifies Buffer attributes and Buffer arrays, leaving other values as they are", async () => {
    m.search.mockResolvedValue({ searchEntries: [{
      dn: "CN=PC1", cn: "PC1", photo: Buffer.from("hi"), certs: [Buffer.from("a"), Buffer.from("b")], memberOf: ["CN=G"], empty: [],
    }] });
    expect(await proxyQuery(CFG, {})).toEqual({ entries: [{
      dn: "CN=PC1", cn: "PC1", photo: "hi", certs: ["a", "b"], memberOf: ["CN=G"], empty: [],
    }] });
  });
});

// ─── discoverDevices ─────────────────────────────────────────────────────────

function computer(over: Record<string, unknown> = {}) {
  return {
    dn: "CN=PC1,OU=Workstations,OU=HQ,DC=corp,DC=local",
    objectGUID: guid("ab"),
    objectSid: sid([21, 1, 2, 3, 1105]),
    cn: "PC1",
    dNSHostName: "pc1.corp.local",
    operatingSystem: "Windows 11 Enterprise",
    operatingSystemVersion: "10.0 (22631)",
    description: ["Front desk"],
    whenCreated: "20240115083000.0Z",
    lastLogonTimestamp: filetime("2026-11-01T12:00:00.000Z"),
    userAccountControl: "4096",
    ...over,
  };
}

describe("discoverDevices — validation", () => {
  it.each([
    ["host", "Host is required"],
    ["bindDn", "Bind DN is required"],
    ["bindPassword", "Bind password is required"],
    ["baseDn", "Base DN is required"],
  ])("throws a 400 without %s", async (field, message) => {
    const err = await discoverDevices({ ...CFG, [field]: "" }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(400);
    expect(err.message).toBe(message);
    expect(m.bound).not.toHaveBeenCalled();
  });

  it("throws a 400 for a malformed scoped objectGUID rather than searching", async () => {
    const err = await discoverDevices(CFG, undefined, undefined, { objectGuid: "xyz" }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(400);
    expect(err.message).toContain("Malformed AD objectGUID");
    expect(m.search).not.toHaveBeenCalled();
  });

  it("maps a failed search to a 502 and reports it through the progress callback", async () => {
    m.bound.mockRejectedValue(Object.assign(new Error("x"), { code: "ECONNREFUSED" }));
    const log = vi.fn();
    const err = await discoverDevices(CFG, undefined, log).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(502);
    expect(err.message).toBe("Active Directory search failed: Connection refused — check port and firewall");
    expect(log).toHaveBeenCalledWith("discover.ad.search", "error", "Active Directory: search failed — Connection refused — check port and firewall");
  });
});

describe("discoverDevices — parsing", () => {
  it("searches computers, paged and capped, asking for GUID and SID as bytes", async () => {
    await discoverDevices(CFG);
    expect(m.search).toHaveBeenCalledWith("DC=corp,DC=local", expect.objectContaining({
      scope: "sub", filter: "(&(objectCategory=computer)(objectClass=computer))",
      explicitBufferAttributes: ["objectGUID", "objectSid"], paged: { pageSize: 1000 }, sizeLimit: 10_000, timeLimit: 120,
    }));
  });

  it("decodes a computer object into a device", async () => {
    m.search.mockResolvedValue({ searchEntries: [computer()] });
    const r = await discoverDevices(CFG);
    expect(r.devices).toEqual([{
      objectGuid: "ab".repeat(16),
      objectSid: "S-1-5-21-1-2-3-1105",
      cn: "PC1",
      dnsHostName: "pc1.corp.local",
      distinguishedName: "CN=PC1,OU=Workstations,OU=HQ,DC=corp,DC=local",
      operatingSystem: "Windows 11 Enterprise",
      operatingSystemVersion: "10.0 (22631)",
      description: "Front desk",
      whenCreated: "2024-01-15T08:30:00.000Z",
      lastLogonTimestamp: "2026-11-01T12:00:00.000Z",
      disabled: false,
      ouPath: "OU=HQ/OU=Workstations",
    }]);
    expect(r).toMatchObject({ presentObjectGuids: ["ab".repeat(16)], disabledObjectGuids: [], inventoryComplete: true, scoped: false });
  });

  it("reads the ACCOUNTDISABLE bit and treats a missing userAccountControl as enabled", async () => {
    m.search.mockResolvedValue({ searchEntries: [
      computer({ objectGUID: guid("01"), userAccountControl: "4098" }),
      computer({ objectGUID: guid("02"), userAccountControl: undefined }),
    ] });
    const r = await discoverDevices(CFG);
    expect(r.devices.map((d) => d.disabled)).toEqual([true, false]);
    expect(r.disabledObjectGuids).toEqual(["01".repeat(16)]);
  });

  it("leaves never-logged-on and malformed timestamps undefined", async () => {
    m.search.mockResolvedValue({ searchEntries: [
      computer({ objectGUID: guid("01"), lastLogonTimestamp: "0", whenCreated: "2024-01-15" }),
      computer({ objectGUID: guid("02"), lastLogonTimestamp: "abc", whenCreated: undefined }),
      computer({ objectGUID: guid("03"), lastLogonTimestamp: "-5" }),
    ] });
    const r = await discoverDevices(CFG);
    for (const d of r.devices) expect(d.lastLogonTimestamp).toBeUndefined();
    expect(r.devices[0].whenCreated).toBeUndefined();
    expect(r.devices[1].whenCreated).toBeUndefined();
  });

  it("drops an empty, non-binary or all-zero GUID and blanks an unreadable SID", async () => {
    m.search.mockResolvedValue({ searchEntries: [
      computer({ objectGUID: Buffer.alloc(16) }),
      computer({ objectGUID: "ab" }),
      computer({ objectGUID: guid("07"), objectSid: Buffer.alloc(4) }),
      computer({ objectGUID: guid("08"), objectSid: "S-1-5" }),
    ] });
    const r = await discoverDevices(CFG);
    expect(r.devices.map((d) => [d.objectGuid, d.objectSid])).toEqual([["07".repeat(16), ""], ["08".repeat(16), ""]]);
  });

  it("stops at a truncated SID's last whole sub-authority", async () => {
    const full = sid([21, 7, 8]);
    m.search.mockResolvedValue({ searchEntries: [computer({ objectSid: full.subarray(0, full.length - 2) })] });
    expect((await discoverDevices(CFG)).devices[0].objectSid).toBe("S-1-5-21-7");
  });

  it("falls back to the distinguishedName attribute and keeps an escaped comma inside an OU name", async () => {
    m.search.mockResolvedValue({ searchEntries: [computer({ dn: "", distinguishedName: "CN=PC1,OU=Sales\\, East,OU=HQ,DC=c" })] });
    const d = (await discoverDevices(CFG)).devices[0];
    expect(d.distinguishedName).toBe("CN=PC1,OU=Sales\\, East,OU=HQ,DC=c");
    expect(d.ouPath).toBe("OU=HQ/OU=Sales\\, East");
  });

  it("reports the retrieved count through the progress callback", async () => {
    m.search.mockResolvedValue({ searchEntries: [computer()] });
    const log = vi.fn();
    await discoverDevices(CFG, undefined, log);
    expect(log).toHaveBeenCalledWith("discover.ad.search", "info", "Active Directory: retrieved 1 computer object(s)");
  });
});

describe("discoverDevices — scoped runs and completeness", () => {
  it("narrows the search to one object by its escaped GUID bytes", async () => {
    const r = await discoverDevices(CFG, undefined, undefined, { objectGuid: "AB".repeat(16) });
    expect(m.search.mock.calls[0][1].filter).toBe(`(&(objectCategory=computer)(objectClass=computer)(objectGUID=${"\\ab".repeat(16)}))`);
    expect(r.scoped).toBe(true);
  });

  it("marks the read incomplete when it hits the 10,000-object cap", async () => {
    m.search.mockResolvedValue({ searchEntries: Array.from({ length: 10_000 }, () => computer()) });
    const log = vi.fn();
    const r = await discoverDevices(CFG, undefined, log);
    expect(r.inventoryComplete).toBe(false);
    expect(log).toHaveBeenCalledWith("discover.ad.search", "error", expect.stringContaining("10000-object cap"));
  });

  it("marks the read incomplete when cancelled mid-parse", async () => {
    const ac = new AbortController();
    ac.abort();
    m.search.mockResolvedValue({ searchEntries: [computer()] });
    const r = await discoverDevices(CFG, ac.signal);
    expect(r.devices).toEqual([]);
    expect(r.inventoryComplete).toBe(false);
  });
});

describe("discoverDevices — filters keep the raw inventory (rule 70(b))", () => {
  const entries = [
    computer({ objectGUID: guid("01"), dn: "CN=A,OU=Servers,DC=c" }),
    computer({ objectGUID: guid("02"), dn: "CN=B,OU=Workstations,DC=c", userAccountControl: "2" }),
    computer({ objectGUID: guid("03"), dn: "CN=C,OU=Lab,DC=c" }),
  ];

  it("applies the OU include list and reports the drop, without narrowing the present set", async () => {
    m.search.mockResolvedValue({ searchEntries: entries });
    const log = vi.fn();
    const r = await discoverDevices({ ...CFG, ouInclude: ["*OU=Servers*"] }, undefined, log);
    expect(r.devices.map((d) => d.cn)).toEqual(["PC1"]);
    expect(r.devices[0].distinguishedName).toBe("CN=A,OU=Servers,DC=c");
    expect(r.presentObjectGuids).toHaveLength(3);
    expect(log).toHaveBeenCalledWith("discover.filter", "info", "Device filter: 1 included, 2 excluded");
  });

  it("lets the include list win over the exclude list", async () => {
    m.search.mockResolvedValue({ searchEntries: entries });
    const r = await discoverDevices({ ...CFG, ouInclude: ["*OU=Lab*"], ouExclude: ["*OU=Lab*"] });
    expect(r.devices.map((d) => d.distinguishedName)).toEqual(["CN=C,OU=Lab,DC=c"]);
  });

  it("applies the OU exclude list case-blind", async () => {
    m.search.mockResolvedValue({ searchEntries: entries });
    const r = await discoverDevices({ ...CFG, ouExclude: ["*ou=lab*"] });
    expect(r.devices.map((d) => d.distinguishedName)).toEqual(["CN=A,OU=Servers,DC=c", "CN=B,OU=Workstations,DC=c"]);
  });

  it("drops disabled computers only when includeDisabled is false, still listing them as disabled", async () => {
    m.search.mockResolvedValue({ searchEntries: entries });
    expect((await discoverDevices(CFG)).devices).toHaveLength(3);
    const log = vi.fn();
    const r = await discoverDevices({ ...CFG, includeDisabled: false }, undefined, log);
    expect(r.devices.map((d) => d.distinguishedName)).toEqual(["CN=A,OU=Servers,DC=c", "CN=C,OU=Lab,DC=c"]);
    expect(r.disabledObjectGuids).toEqual(["02".repeat(16)]);
    expect(r.presentObjectGuids).toHaveLength(3);
    expect(log).toHaveBeenCalledWith("discover.filter.disabled", "info", "Skipping 1 disabled computer account(s) (includeDisabled=false)");
  });
});

describe("adSweepBlockedReason", () => {
  const ok = { presentObjectGuids: ["a"], inventoryComplete: true, scoped: false };

  it("trusts a whole, non-empty, unscoped read", () => {
    expect(adSweepBlockedReason(ok)).toBeNull();
  });

  it("names the scoped run first, even when the read is also partial and empty", () => {
    expect(adSweepBlockedReason({ presentObjectGuids: [], inventoryComplete: false, scoped: true }))
      .toBe("the run was scoped to a single computer object");
  });

  it("refuses an incomplete read", () => {
    expect(adSweepBlockedReason({ ...ok, inventoryComplete: false })).toContain("incomplete");
  });

  it("refuses an empty read", () => {
    expect(adSweepBlockedReason({ ...ok, presentObjectGuids: [] })).toBe("the directory read came back empty");
  });
});
