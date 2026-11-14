/**
 * tests/unit/directorySyncService.test.ts — the own suite for
 * src/services/directorySyncService.ts (business rule 35, CQ-T010).
 *
 * Complements directorySyncFilter.test.ts and directorySyncRun.test.ts. Pins
 * the filter normalization (defaults, trimming, the entry-cap clamp), every
 * exclusion category and the include-wins-over-exclude order, the per-field
 * Entra-over-AD projection, the deletion guard's floor and ratio, and the run
 * itself on the shared _dbStub: reader dispatch, the user / manual claims
 * (35(b)), first-wins de-dup, the created count taken from the result, the
 * steady state issuing zero writes, the provenance move, the guarded deletion
 * (35(c)), re-projection of every touched contact, the counts-only Event
 * (35(e)), and the purge.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const m = vi.hoisted(() => ({ entra: vi.fn(), ad: vi.fn(), bump: vi.fn() }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/entraIdService.js", () => ({ listDirectoryPeople: m.entra }));
vi.mock("../../src/services/activeDirectoryService.js", () => ({ listDirectoryPeople: m.ad }));
vi.mock("../../src/services/contactService.js", () => ({
  bumpContactCache: m.bump,
  // Same contract as the real one: lower-cases, trims, throws on a malformed address.
  normalizeContactEmail: (raw: unknown) => {
    const email = String(raw ?? "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email)) throw new Error("bad address");
    return email;
  },
}));

import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  normalizeDirectorySyncFilter,
  directoryExclusionReason,
  projectContactFromSources,
  deleteExceedsGuard,
  runDirectorySync,
  purgeDirectoryContacts,
  DIRECTORY_SYNC_DEFAULT_MAX_ENTRIES,
  DIRECTORY_SYNC_MAX_ENTRIES_CEILING,
  type DirectoryPerson,
} from "../../src/services/directorySyncService.js";

const db = {
  contactFindMany: stubbed(prisma.contact.findMany),
  contactCreateMany: stubbed(prisma.contact.createMany),
  contactDeleteMany: stubbed(prisma.contact.deleteMany),
  contactUpdate: stubbed(prisma.contact.update),
  srcFindMany: stubbed(prisma.directoryContactSource.findMany),
  srcCreateMany: stubbed(prisma.directoryContactSource.createMany),
  srcUpdate: stubbed(prisma.directoryContactSource.update),
  srcDeleteMany: stubbed(prisma.directoryContactSource.deleteMany),
  userFindMany: stubbed(prisma.user.findMany),
  tx: stubbed(prisma.$transaction),
};

const person = (over: Partial<DirectoryPerson> = {}): DirectoryPerson => ({
  externalId: "e1", email: "jane@example.com", name: "Jane Doe",
  jobTitle: null, department: null, phone: null, description: null, kind: "person",
  ...over,
});

const F = normalizeDirectorySyncFilter(undefined);
const filt = (over: Record<string, unknown>) => normalizeDirectorySyncFilter(over);

describe("normalizeDirectorySyncFilter", () => {
  it("applies the conservative defaults to an absent block", () => {
    expect(F).toEqual({
      excludeDisabled: true, excludeSharedMailboxes: true, includeGroups: true, includeOrgContacts: false,
      ouInclude: [], ouExclude: [], groupExclude: [], domainInclude: [], domainExclude: [], nameExclude: [],
      maxEntries: DIRECTORY_SYNC_DEFAULT_MAX_ENTRIES,
    });
  });

  it("keeps explicit booleans and ignores non-boolean truthy values", () => {
    const f = filt({ excludeDisabled: false, excludeSharedMailboxes: "no", includeGroups: 0, includeOrgContacts: true });
    expect(f.excludeDisabled).toBe(false);
    expect(f.excludeSharedMailboxes).toBe(true);
    expect(f.includeGroups).toBe(true);
    expect(f.includeOrgContacts).toBe(true);
  });

  it("trims list entries and drops blanks and non-strings", () => {
    expect(filt({ ouInclude: ["  *OU=Staff*  ", "", "   ", 7, null] }).ouInclude).toEqual(["*OU=Staff*"]);
    expect(filt({ nameExclude: "not-a-list" }).nameExclude).toEqual([]);
  });

  it("strips a leading @ and lower-cases the domain lists", () => {
    const f = filt({ domainInclude: ["@Example.COM", "corp.local"], domainExclude: ["@Vendor.io"] });
    expect(f.domainInclude).toEqual(["example.com", "corp.local"]);
    expect(f.domainExclude).toEqual(["vendor.io"]);
  });

  it("truncates the entry cap and clamps it to the ceiling", () => {
    expect(filt({ maxEntries: 1234.9 }).maxEntries).toBe(1234);
    expect(filt({ maxEntries: "500" }).maxEntries).toBe(500);
    expect(filt({ maxEntries: 10_000_000 }).maxEntries).toBe(DIRECTORY_SYNC_MAX_ENTRIES_CEILING);
  });

  it("falls back to the default cap for zero, negative or non-numeric values", () => {
    for (const v of [0, -5, "abc", null, Infinity]) {
      expect(filt({ maxEntries: v }).maxEntries).toBe(DIRECTORY_SYNC_DEFAULT_MAX_ENTRIES);
    }
  });
});

describe("directoryExclusionReason", () => {
  it("keeps an ordinary person", () => {
    expect(directoryExclusionReason(person(), F)).toBeNull();
  });

  it("drops an entry with no address", () => {
    expect(directoryExclusionReason(person({ email: "" }), F)).toBe("no email address");
  });

  it("drops a distribution list only when groups are not included", () => {
    expect(directoryExclusionReason(person({ kind: "group" }), F)).toBeNull();
    expect(directoryExclusionReason(person({ kind: "group" }), filt({ includeGroups: false }))).toBe("distribution list");
  });

  it("drops a disabled account by default, and only on a positive claim", () => {
    expect(directoryExclusionReason(person({ disabled: true }), F)).toBe("disabled account");
    expect(directoryExclusionReason(person({ disabled: undefined }), F)).toBeNull();
    expect(directoryExclusionReason(person({ disabled: true }), filt({ excludeDisabled: false }))).toBeNull();
  });

  it("names the mailbox kind for shared, room and equipment mailboxes", () => {
    expect(directoryExclusionReason(person({ mailboxKind: "shared" }), F)).toBe("shared mailbox");
    expect(directoryExclusionReason(person({ mailboxKind: "room" }), F)).toBe("room mailbox");
    expect(directoryExclusionReason(person({ mailboxKind: "equipment" }), F)).toBe("equipment mailbox");
  });

  it("never treats an unknown mailbox kind as shared (Entra reports unknown for everyone)", () => {
    expect(directoryExclusionReason(person({ mailboxKind: "unknown" }), F)).toBeNull();
    expect(directoryExclusionReason(person({ mailboxKind: "user" }), F)).toBeNull();
    expect(directoryExclusionReason(person({ mailboxKind: "shared" }), filt({ excludeSharedMailboxes: false }))).toBeNull();
  });

  it("with an OU include list, keeps only a DN that matches and drops a missing DN", () => {
    const f = filt({ ouInclude: ["*OU=Staff*"] });
    expect(directoryExclusionReason(person({ distinguishedName: "CN=J,OU=Staff,DC=c" }), f)).toBeNull();
    expect(directoryExclusionReason(person({ distinguishedName: "CN=J,OU=Svc,DC=c" }), f)).toBe("outside the included OUs");
    expect(directoryExclusionReason(person(), f)).toBe("outside the included OUs");
  });

  it("lets the OU include list win over the exclude list", () => {
    const f = filt({ ouInclude: ["*OU=Staff*"], ouExclude: ["*OU=Staff*"] });
    expect(directoryExclusionReason(person({ distinguishedName: "CN=J,OU=Staff,DC=c" }), f)).toBeNull();
  });

  it("applies an OU exclusion to a DN and keeps an entry with no DN", () => {
    const f = filt({ ouExclude: ["*OU=Disabled Users*"] });
    expect(directoryExclusionReason(person({ distinguishedName: "CN=J,OU=disabled users,DC=c" }), f)).toBe("in an excluded OU");
    expect(directoryExclusionReason(person(), f)).toBeNull();
  });

  it("matches included domains case-blind on the part after the last @", () => {
    const f = filt({ domainInclude: ["example.com"] });
    expect(directoryExclusionReason(person({ email: "Jane@EXAMPLE.com" }), f)).toBeNull();
    expect(directoryExclusionReason(person({ email: "jane@sub.example.com" }), f)).toBe("outside the included domains");
  });

  it("lets the domain include list win over the exclude list", () => {
    const f = filt({ domainInclude: ["example.com"], domainExclude: ["example.com"] });
    expect(directoryExclusionReason(person(), f)).toBeNull();
  });

  it("drops an excluded domain", () => {
    expect(directoryExclusionReason(person({ email: "x@vendor.io" }), filt({ domainExclude: ["vendor.io"] }))).toBe("in an excluded domain");
  });

  it("drops a member of an excluded group, case-blind", () => {
    const f = filt({ groupExclude: ["CN=Contractors,DC=c"] });
    expect(directoryExclusionReason(person({ groupDns: ["cn=contractors,dc=c"] }), f)).toBe("member of an excluded group");
    expect(directoryExclusionReason(person({ groupDns: ["CN=Staff,DC=c"] }), f)).toBeNull();
    expect(directoryExclusionReason(person({ groupDns: [] }), f)).toBeNull();
  });

  it("matches a name exclusion against the display name or the address", () => {
    const f = filt({ nameExclude: ["svc-*", "*noreply*"] });
    expect(directoryExclusionReason(person({ name: "svc-backup" }), f)).toBe("matched a name exclusion");
    expect(directoryExclusionReason(person({ name: null, email: "noreply@example.com" }), f)).toBe("matched a name exclusion");
    expect(directoryExclusionReason(person(), f)).toBeNull();
  });

  it("reports the first applicable category, checked in a fixed order", () => {
    const f = filt({ domainExclude: ["example.com"] });
    expect(directoryExclusionReason(person({ disabled: true }), f)).toBe("disabled account");
  });
});

describe("projectContactFromSources", () => {
  it("projects an empty source set to a nameless manual person", () => {
    expect(projectContactFromSources([])).toEqual({
      name: null, kind: "person", jobTitle: null, department: null, phone: null, description: null, origin: "manual",
    });
  });

  it("lets Entra outrank AD per field, falling through on a blank value and trimming", () => {
    const p = projectContactFromSources([
      { sourceKind: "ad", observed: person({ name: "AD Name", jobTitle: "AD Title", phone: " 555 " }) },
      { sourceKind: "entra", observed: person({ name: "  Entra Name  ", jobTitle: "   ", phone: null }) },
    ]);
    expect(p.name).toBe("Entra Name");
    expect(p.jobTitle).toBe("AD Title");
    expect(p.phone).toBe("555");
    expect(p.origin).toBe("entra");
  });

  it("calls the contact a group when any source says so", () => {
    expect(projectContactFromSources([
      { sourceKind: "entra", observed: person() },
      { sourceKind: "ad", observed: person({ kind: "group" }) },
    ]).kind).toBe("group");
  });

  it("ranks an unknown source kind last", () => {
    const p = projectContactFromSources([
      { sourceKind: "other", observed: person({ department: "Other Dept" }) },
      { sourceKind: "ad", observed: person({ department: "AD Dept" }) },
    ]);
    expect(p.department).toBe("AD Dept");
    expect(p.origin).toBe("ad");
  });

  it("tolerates a source row with no observed blob", () => {
    const p = projectContactFromSources([{ sourceKind: "ad", observed: undefined as never }]);
    expect(p).toMatchObject({ name: null, kind: "person", origin: "ad" });
  });
});

describe("deleteExceedsGuard", () => {
  it("allows up to the 50-row floor on a small book", () => {
    expect(deleteExceedsGuard(50, 60)).toBe(false);
    expect(deleteExceedsGuard(51, 60)).toBe(true);
  });

  it("allows up to 20% of a large book", () => {
    expect(deleteExceedsGuard(2000, 10_000)).toBe(false);
    expect(deleteExceedsGuard(2001, 10_000)).toBe(true);
  });

  it("floors the ratio before comparing", () => {
    expect(deleteExceedsGuard(300, 1504)).toBe(false);
    expect(deleteExceedsGuard(301, 1504)).toBe(true);
  });
});

// ─── runDirectorySync ────────────────────────────────────────────────────────

const OPTS = {
  integrationId: "i1", integrationName: "Corp Entra", integrationType: "entraid" as const,
  config: { enableDirectorySync: true } as Record<string, unknown>, actor: "system",
};

/** A small in-memory contact table the findMany dispatcher reads. */
let contacts: Array<Record<string, any>>;
let provenance: Array<Record<string, any>>;
let users: Array<{ email: string | null }>;
let createdSeq = 0;

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  m.entra.mockReset();
  m.ad.mockReset();
  m.bump.mockReset();
  contacts = [];
  provenance = [];
  users = [];
  createdSeq = 0;
  db.srcFindMany.mockImplementation(async () => provenance);
  db.userFindMany.mockImplementation(async () => users);
  db.contactFindMany.mockImplementation(async ({ where }: any) => {
    if (where?.origin === "manual") return contacts.filter((c) => c.origin === "manual");
    if (where?.email?.in) return contacts.filter((c) => where.email.in.includes(c.email));
    if (where?.id?.in) {
      return contacts
        .filter((c) => where.id.in.includes(c.id) && c.origin !== "manual")
        .map((c) => ({ ...c, directorySources: c.directorySources ?? [] }));
    }
    return [];
  });
  db.contactCreateMany.mockImplementation(async ({ data }: any) => {
    for (const d of data) contacts.push({ id: `c${++createdSeq}`, ...d });
    return { count: data.length };
  });
  db.contactUpdate.mockImplementation(async (a: any) => a);
  db.srcCreateMany.mockResolvedValue({ count: 0 });
  db.srcUpdate.mockImplementation(async (a: any) => a);
  db.srcDeleteMany.mockResolvedValue({ count: 0 });
  db.contactDeleteMany.mockResolvedValue({ count: 0 });
});

describe("runDirectorySync — reading", () => {
  it("reads Entra for an entraid integration with the normalized filter and the signal", async () => {
    m.entra.mockResolvedValue([]);
    const signal = new AbortController().signal;
    await runDirectorySync({ ...OPTS, config: { directorySync: { maxEntries: 10 } }, signal });
    expect(m.ad).not.toHaveBeenCalled();
    const [cfg, filter, sig] = m.entra.mock.calls[0];
    expect(cfg).toEqual({ directorySync: { maxEntries: 10 } });
    expect(filter.maxEntries).toBe(10);
    expect(sig).toBe(signal);
  });

  it("reads AD for an activedirectory integration and tags provenance as 'ad'", async () => {
    m.ad.mockResolvedValue([person()]);
    await runDirectorySync({ ...OPTS, integrationType: "activedirectory" });
    expect(m.entra).not.toHaveBeenCalled();
    expect(db.srcCreateMany.mock.calls[0][0].data[0]).toMatchObject({ sourceKind: "ad", integrationId: "i1", externalId: "e1" });
    expect(db.contactCreateMany.mock.calls[0][0].data[0].origin).toBe("ad");
  });

  it("propagates a reader failure without writing or logging", async () => {
    m.entra.mockRejectedValue(new Error("403 Forbidden"));
    await expect(runDirectorySync(OPTS)).rejects.toThrow("403 Forbidden");
    expect(db.contactCreateMany).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("runDirectorySync — creating", () => {
  it("creates a new contact through the projection, owned by nobody, and records provenance", async () => {
    m.entra.mockResolvedValue([person({ email: " Jane@Example.com ", name: "  Jane Doe ", jobTitle: "Engineer" })]);
    const s = await runDirectorySync(OPTS);
    const createArg = db.contactCreateMany.mock.calls[0][0];
    expect(createArg.skipDuplicates).toBe(true);
    expect(createArg.data).toEqual([{
      email: "jane@example.com", name: "Jane Doe", kind: "person", jobTitle: "Engineer",
      department: null, phone: null, description: null, origin: "entra", createdBy: null,
    }]);
    const prov = db.srcCreateMany.mock.calls[0][0];
    expect(prov.skipDuplicates).toBe(true);
    expect(prov.data[0]).toMatchObject({ integrationId: "i1", externalId: "e1", sourceKind: "entra", contactId: "c1" });
    expect(s).toMatchObject({ scanned: 1, created: 1, updated: 0, deleted: 0 });
    expect(m.bump).toHaveBeenCalledTimes(1);
  });

  it("counts created rows from the insert's result, not the batch size", async () => {
    m.entra.mockResolvedValue([person(), person({ externalId: "e2", email: "bob@example.com" })]);
    db.contactCreateMany.mockImplementation(async ({ data }: any) => {
      contacts.push({ id: "c1", ...data[0] });
      return { count: 1 };
    });
    const s = await runDirectorySync(OPTS);
    expect(s.created).toBe(1);
    // The loser of the race has no row yet, so it gets no provenance this run.
    expect(db.srcCreateMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it("falls back to the batch size when the insert reports no count", async () => {
    m.entra.mockResolvedValue([person()]);
    db.contactCreateMany.mockImplementation(async ({ data }: any) => {
      contacts.push({ id: "c1", ...data[0] });
      return undefined;
    });
    expect((await runDirectorySync(OPTS)).created).toBe(1);
  });

  it("attaches provenance to an existing synced contact instead of creating a second one", async () => {
    contacts.push({ id: "c9", email: "jane@example.com", origin: "ad", name: "Jane Doe", kind: "person", jobTitle: null, department: null, phone: null, description: null });
    m.entra.mockResolvedValue([person()]);
    await runDirectorySync(OPTS);
    expect(db.contactCreateMany).not.toHaveBeenCalled();
    expect(db.srcCreateMany.mock.calls[0][0].data[0].contactId).toBe("c9");
  });
});

describe("runDirectorySync — exclusion, claims and de-dup", () => {
  it("counts exclusions and names the dominant category", async () => {
    m.entra.mockResolvedValue([
      person({ externalId: "a", disabled: true }),
      person({ externalId: "b", email: "b@example.com", disabled: true }),
      person({ externalId: "c", email: "" }),
      person({ externalId: "d", email: "d@example.com" }),
    ]);
    const s = await runDirectorySync(OPTS);
    expect(s.excluded).toBe(3);
    expect(s.topExclusionReason).toBe("disabled account");
    expect(s.created).toBe(1);
  });

  it("leaves the top reason null when nothing was excluded", async () => {
    m.entra.mockResolvedValue([person()]);
    expect((await runDirectorySync(OPTS)).topExclusionReason).toBeNull();
  });

  it("counts a malformed address without aborting the run", async () => {
    m.entra.mockResolvedValue([person({ externalId: "bad", email: "not an address" }), person()]);
    const s = await runDirectorySync(OPTS);
    expect(s.invalidAddress).toBe(1);
    expect(s.created).toBe(1);
  });

  it("keeps the first object for an address the directory lists twice", async () => {
    m.entra.mockResolvedValue([person({ externalId: "first" }), person({ externalId: "second", email: "JANE@example.com" })]);
    await runDirectorySync(OPTS);
    expect(db.contactCreateMany.mock.calls[0][0].data).toHaveLength(1);
    expect(db.srcCreateMany.mock.calls[0][0].data.map((d: any) => d.externalId)).toEqual(["first"]);
  });

  it("skips an address a Polaris user holds, comparing trimmed and case-blind (35(b))", async () => {
    users = [{ email: "  JANE@example.com " }, { email: null }];
    m.entra.mockResolvedValue([person()]);
    const s = await runDirectorySync(OPTS);
    expect(s.skippedUser).toBe(1);
    expect(db.contactCreateMany).not.toHaveBeenCalled();
    expect(db.srcCreateMany).not.toHaveBeenCalled();
  });

  it("skips an address an operator-curated contact holds (35(b))", async () => {
    contacts.push({ id: "m1", email: "jane@example.com", origin: "manual" });
    m.entra.mockResolvedValue([person()]);
    const s = await runDirectorySync(OPTS);
    expect(s.skippedManual).toBe(1);
    expect(s.created).toBe(0);
    expect(db.srcCreateMany).not.toHaveBeenCalled();
  });

  it("marks the run capped when the read reaches the entry cap and logs a warning", async () => {
    m.entra.mockResolvedValue([person(), person({ externalId: "e2", email: "b@example.com" })]);
    const s = await runDirectorySync({ ...OPTS, config: { directorySync: { maxEntries: 2 } } });
    expect(s.capped).toBe(true);
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev.level).toBe("warning");
    expect(ev.message).toContain("hit the 2 entry cap");
  });
});

describe("runDirectorySync — steady state and change", () => {
  function seedSynced(observed: DirectoryPerson, contactOver: Record<string, unknown> = {}) {
    contacts.push({
      id: "c1", email: "jane@example.com", origin: "entra", name: "Jane Doe", kind: "person",
      jobTitle: null, department: null, phone: null, description: null,
      directorySources: [{ sourceKind: "entra", observed }], ...contactOver,
    });
    provenance.push({ externalId: "e1", contactId: "c1", observed });
  }

  it("issues zero writes when nothing changed, even with the stored blob's keys reordered", async () => {
    const p = person();
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as unknown as DirectoryPerson;
    seedSynced(reordered);
    m.entra.mockResolvedValue([p]);
    const s = await runDirectorySync(OPTS);
    expect(db.contactCreateMany).not.toHaveBeenCalled();
    expect(db.srcCreateMany).not.toHaveBeenCalled();
    expect(db.srcUpdate).not.toHaveBeenCalled();
    expect(db.contactUpdate).not.toHaveBeenCalled();
    expect(s).toMatchObject({ created: 0, updated: 0, unchanged: 1, deleted: 0 });
    expect(eventLog.logEvent.mock.calls[0][0].details?.changed).toBe(0);
  });

  it("rewrites provenance and re-projects the contact when the directory changed a field", async () => {
    seedSynced(person());
    const next = person({ jobTitle: "Director" });
    m.entra.mockResolvedValue([next]);
    // The provenance update lands before re-projection reads the sources.
    db.srcUpdate.mockImplementation(async (a: any) => {
      contacts[0].directorySources = [{ sourceKind: "entra", observed: a.data.observed }];
      return a;
    });
    const s = await runDirectorySync(OPTS);
    const upd = db.srcUpdate.mock.calls[0][0];
    expect(upd.where).toEqual({ integrationId_externalId: { integrationId: "i1", externalId: "e1" } });
    expect(upd.data).toMatchObject({ contactId: "c1", observed: next });
    expect(upd.data.lastSeenAt).toBeInstanceOf(Date);
    expect(db.contactUpdate).toHaveBeenCalledWith({ where: { id: "c1" }, data: expect.objectContaining({ jobTitle: "Director" }) });
    expect(s.updated).toBe(1);
  });

  it("moves provenance when the address now resolves to a different contact", async () => {
    const p = person();
    provenance.push({ externalId: "e1", contactId: "old", observed: p });
    contacts.push({ id: "c2", email: "jane@example.com", origin: "entra", name: "Jane Doe", kind: "person", jobTitle: null, department: null, phone: null, description: null, directorySources: [{ sourceKind: "entra", observed: p }] });
    m.entra.mockResolvedValue([p]);
    await runDirectorySync(OPTS);
    expect(db.srcUpdate.mock.calls[0][0].data.contactId).toBe("c2");
  });

  it("skips re-projecting a touched contact that has no sources left", async () => {
    contacts.push({ id: "c1", email: "jane@example.com", origin: "entra", name: "stale", kind: "person", jobTitle: null, department: null, phone: null, description: null, directorySources: [] });
    m.entra.mockResolvedValue([person()]);
    const s = await runDirectorySync(OPTS);
    expect(db.contactUpdate).not.toHaveBeenCalled();
    expect(s.unchanged).toBe(0);
    expect(s.updated).toBe(0);
  });
});

describe("runDirectorySync — deletion (35(a), 35(c))", () => {
  function owned(n: number) {
    for (let i = 0; i < n; i++) provenance.push({ externalId: `x${i}`, contactId: `cx${i}`, observed: {} });
  }

  it("deletes the vanished provenance rows and only contacts no source still claims", async () => {
    owned(3);
    m.entra.mockResolvedValue([person()]);
    db.contactDeleteMany.mockResolvedValue({ count: 2 });
    const s = await runDirectorySync(OPTS);
    expect(db.srcDeleteMany).toHaveBeenCalledWith({ where: { integrationId: "i1", externalId: { in: ["x0", "x1", "x2"] } } });
    expect(db.contactDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["cx0", "cx1", "cx2"] }, origin: { not: "manual" }, directorySources: { none: {} } },
    });
    expect(s.deleted).toBe(2);
    expect(s.deleteSkippedGuard).toBe(false);
  });

  it("refuses every deletion on an empty read and says so in a warning", async () => {
    owned(3);
    m.entra.mockResolvedValue([]);
    const s = await runDirectorySync(OPTS);
    expect(s.deleteSkippedGuard).toBe(true);
    expect(db.srcDeleteMany).not.toHaveBeenCalled();
    expect(db.contactDeleteMany).not.toHaveBeenCalled();
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev.level).toBe("warning");
    expect(ev.message).toContain("REMOVALS SKIPPED");
  });

  it("refuses a catastrophically shrunken read", async () => {
    owned(60);
    m.entra.mockResolvedValue([person()]);
    const s = await runDirectorySync(OPTS);
    expect(s.deleteSkippedGuard).toBe(true);
    expect(db.contactDeleteMany).not.toHaveBeenCalled();
  });

  it("does not delete when every owned row is still present", async () => {
    provenance.push({ externalId: "e1", contactId: "c1", observed: person() });
    m.entra.mockResolvedValue([person()]);
    await runDirectorySync(OPTS);
    expect(db.srcDeleteMany).not.toHaveBeenCalled();
  });
});

describe("runDirectorySync — the Event (35(e))", () => {
  it("logs one info Event with counts only — no address, name or title anywhere", async () => {
    m.entra.mockResolvedValue([person({ jobTitle: "Secret Title", phone: "555-0100" }), person({ externalId: "z", email: "x@y.io", disabled: true })]);
    const s = await runDirectorySync(OPTS);
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ action: "integration.directory_sync", resourceType: "integration", resourceId: "i1", resourceName: "Corp Entra", actor: "system", level: "info" });
    expect(ev.message).toBe('Directory sync for "Corp Entra" — scanned 2, 1 added, 0 updated, 0 removed, 1 excluded (mostly: disabled account)');
    expect(ev.details).toEqual({ ...s, changed: 1 });
    const blob = JSON.stringify(ev);
    for (const pii of ["jane@example.com", "Jane Doe", "Secret Title", "555-0100", "x@y.io", "e1"]) {
      expect(blob).not.toContain(pii);
    }
  });
});

describe("purgeDirectoryContacts", () => {
  it("returns 0 and logs nothing when the integration owns no rows", async () => {
    db.srcFindMany.mockResolvedValue([]);
    expect(await purgeDirectoryContacts("i1", "sync disabled")).toBe(0);
    expect(db.srcDeleteMany).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
    expect(m.bump).not.toHaveBeenCalled();
  });

  it("drops the integration's provenance, then each contact no source still claims, and logs a warning", async () => {
    db.srcFindMany.mockResolvedValue([{ contactId: "c1" }, { contactId: "c1" }, { contactId: "c2" }]);
    db.contactDeleteMany.mockResolvedValue({ count: 2 });
    const n = await purgeDirectoryContacts("i1", "integration deleted", "admin");
    expect(n).toBe(2);
    expect(db.srcDeleteMany).toHaveBeenCalledWith({ where: { integrationId: "i1" } });
    expect(db.contactDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["c1", "c2"] }, origin: { not: "manual" }, directorySources: { none: {} } },
    });
    expect(db.srcDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(db.contactDeleteMany.mock.invocationCallOrder[0]);
    expect(m.bump).toHaveBeenCalledTimes(1);
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({
      action: "contact.directory_sync.purged", resourceType: "integration", resourceId: "i1", actor: "admin", level: "warning",
      message: "Removed 2 directory-synced address-book entries — integration deleted",
      details: { deleted: 2, provenanceRows: 3, reason: "integration deleted" },
    });
  });

  it("uses the singular for one removed entry", async () => {
    db.srcFindMany.mockResolvedValue([{ contactId: "c1" }]);
    db.contactDeleteMany.mockResolvedValue({ count: 1 });
    await purgeDirectoryContacts("i1", "toggle off");
    expect(eventLog.logEvent.mock.calls[0][0].message).toBe("Removed 1 directory-synced address-book entry — toggle off");
  });

  it("batches the contact delete in chunks of 200", async () => {
    db.srcFindMany.mockResolvedValue(Array.from({ length: 450 }, (_, i) => ({ contactId: `c${i}` })));
    db.contactDeleteMany.mockResolvedValue({ count: 10 });
    expect(await purgeDirectoryContacts("i1", "x")).toBe(30);
    expect(db.contactDeleteMany.mock.calls.map((c) => c[0].where.id.in.length)).toEqual([200, 200, 50]);
  });
});
