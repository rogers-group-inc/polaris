/**
 * tests/unit/directorySyncRun.test.ts
 *
 * runDirectorySync — the pass that actually writes contacts (business rule 35).
 *
 * The properties worth pinning are the ones whose absence is invisible until it
 * has already done damage:
 *
 *   - a Polaris user account or an operator-curated contact WINS, so an
 *     SSO-provisioned colleague never gets a duplicate entry;
 *   - a steady state issues ZERO writes, so a 20,000-person directory is
 *     affordable on every discovery cycle;
 *   - an empty or catastrophically-shrunken read never deletes, because a
 *     revoked grant otherwise presents as "everyone left the company";
 *   - a contact survives while ANY provenance row still claims it;
 *   - the Event carries counts only — no address, no name, no title.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  contact: { findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn(), update: vi.fn() },
  directoryContactSource: { findMany: vi.fn(), createMany: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  user: { findMany: vi.fn() },
  integration: { findMany: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}));
vi.mock("../../src/db.js", () => ({ prisma: prismaMock }));

const events = vi.hoisted(() => ({ logged: [] as Record<string, any>[] }));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
beforeEach(() => {
  resetEventLogStub();
  eventLog.logEvent.mockImplementation(async (e) => { events.logged.push(e); return undefined; });
});

const readers = vi.hoisted(() => ({ entra: vi.fn(), ad: vi.fn() }));
vi.mock("../../src/services/entraIdService.js", () => ({ listDirectoryPeople: readers.entra }));
vi.mock("../../src/services/activeDirectoryService.js", () => ({ listDirectoryPeople: readers.ad }));

vi.mock("../../src/services/contactService.js", () => ({
  bumpContactCache: vi.fn(),
  // The real one: a GAL always contains malformed entries, and this test cares
  // that exactly one of them does not abort the run.
  normalizeContactEmail: (raw: unknown) => {
    const email = String(raw ?? "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email)) throw new Error("bad address");
    return email;
  },
}));

import {
  deleteExceedsGuard,
  purgeDirectoryContacts,
  runDirectorySync,
  type DirectoryPerson,
} from "../../src/services/directorySyncService.js";

const person = (over: Partial<DirectoryPerson> = {}): DirectoryPerson => ({
  externalId: "e1",
  email: "jane@example.com",
  name: "Jane Doe",
  jobTitle: null, department: null, phone: null, description: null,
  kind: "person",
  ...over,
});

const OPTS = {
  integrationId: "i1",
  integrationName: "Corp Entra",
  integrationType: "entraid" as const,
  config: { enableDirectorySync: true },
  actor: "jsmith",
};

/**
 * Wire the three local reads. `contact.findMany` is called several times with
 * different shapes, so it is dispatched on the query rather than by call order —
 * ordering assumptions here would break on any internal reshuffle.
 */
function stubLocal(opts: {
  provenance?: { externalId: string; contactId: string; observed: unknown }[];
  manualEmails?: string[];
  userEmails?: (string | null)[];
  contactsByEmail?: { id: string; email: string; origin: string }[];
  projectionRows?: Record<string, unknown>[];
} = {}) {
  prismaMock.directoryContactSource.findMany.mockResolvedValue(opts.provenance ?? []);
  prismaMock.user.findMany.mockResolvedValue((opts.userEmails ?? []).map((email) => ({ email })));
  prismaMock.contact.findMany.mockImplementation(async (args: any) => {
    if (args?.where?.origin === "manual") return (opts.manualEmails ?? []).map((email) => ({ email }));
    if (args?.select?.directorySources) return opts.projectionRows ?? [];
    return opts.contactsByEmail ?? [];
  });
  // The service reads the RESULT count, so the stub has to report what it
  // "inserted" rather than a flat zero.
  prismaMock.contact.createMany.mockImplementation(async (args: any) => ({ count: (args?.data ?? []).length }));
  prismaMock.contact.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.directoryContactSource.createMany.mockResolvedValue({ count: 0 });
  prismaMock.directoryContactSource.deleteMany.mockResolvedValue({ count: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  events.logged.length = 0;
  prismaMock.$transaction.mockImplementation(async (ops: unknown[]) => ops);
});

describe("deleteExceedsGuard", () => {
  it("has a FLOOR as well as a ratio", () => {
    // On a small book 20% is a single row, and refusing a one-row delete would
    // make ordinary turnover need an operator. The failure being guarded
    // against is categorical, not incremental.
    expect(deleteExceedsGuard(1, 3)).toBe(false);
    expect(deleteExceedsGuard(49, 50)).toBe(false);
    expect(deleteExceedsGuard(51, 100)).toBe(true);
    expect(deleteExceedsGuard(2001, 10_000)).toBe(true);
    expect(deleteExceedsGuard(1999, 10_000)).toBe(false);
  });
});

describe("runDirectorySync — who does NOT become a contact", () => {
  it("skips an address a Polaris user account already holds", async () => {
    // An SSO-provisioned colleague is already in the GAL; minting a second
    // entry for them is exactly the duplicate this prevents.
    readers.entra.mockResolvedValue([person()]);
    stubLocal({ userEmails: ["Jane@Example.com"] }); // note the casing
    const out = await runDirectorySync(OPTS);
    expect(out.skippedUser).toBe(1);
    expect(prismaMock.contact.createMany).not.toHaveBeenCalled();
  });

  it("skips an address an operator already curated", async () => {
    readers.entra.mockResolvedValue([person()]);
    stubLocal({ manualEmails: ["jane@example.com"] });
    const out = await runDirectorySync(OPTS);
    expect(out.skippedManual).toBe(1);
    expect(prismaMock.contact.createMany).not.toHaveBeenCalled();
  });

  it("counts a malformed address instead of aborting the run", async () => {
    readers.entra.mockResolvedValue([
      person({ externalId: "bad", email: "Jane Doe (no address)" }),
      person({ externalId: "ok", email: "ok@example.com" }),
    ]);
    stubLocal();
    const out = await runDirectorySync(OPTS);
    expect(out.invalidAddress).toBe(1);
    expect(out.created).toBe(1);
  });

  it("writes created rows through the same projection the refresh uses", async () => {
    // Otherwise a directory value carrying stray whitespace is created raw and
    // then immediately trimmed by the projection pass in the SAME run: a wasted
    // write, and one person counted as both created and updated.
    readers.entra.mockResolvedValue([person({ name: "  Jane Doe  ", jobTitle: "  Foreman  " })]);
    stubLocal();
    await runDirectorySync(OPTS);
    const row = prismaMock.contact.createMany.mock.calls.at(-1)![0].data[0];
    expect(row.name).toBe("Jane Doe");
    expect(row.jobTitle).toBe("Foreman");
    expect(row.origin).toBe("entra");
    expect(row.createdBy).toBeNull();
  });

  it("de-dupes two directory objects sharing one address", async () => {
    // A user object and a contact object for the same mailbox: a second
    // provenance row would be a stable duplicate nothing reconciles.
    readers.entra.mockResolvedValue([
      person({ externalId: "a" }),
      person({ externalId: "b" }),
    ]);
    stubLocal();
    const out = await runDirectorySync(OPTS);
    expect(out.created).toBe(1);
  });
});

describe("runDirectorySync — the steady state is free", () => {
  it("writes NOTHING when the directory is unchanged", async () => {
    const p = person();
    readers.entra.mockResolvedValue([p]);
    stubLocal({
      provenance: [{ externalId: "e1", contactId: "c1", observed: p }],
      contactsByEmail: [{ id: "c1", email: "jane@example.com", origin: "entra" }],
      projectionRows: [{
        id: "c1", name: "Jane Doe", kind: "person", jobTitle: null, department: null,
        phone: null, description: null, origin: "entra",
        directorySources: [{ sourceKind: "entra", observed: p }],
      }],
    });

    const out = await runDirectorySync(OPTS);
    expect(out.created).toBe(0);
    expect(out.updated).toBe(0);
    expect(out.unchanged).toBe(1);
    expect(prismaMock.contact.createMany).not.toHaveBeenCalled();
    expect(prismaMock.directoryContactSource.createMany).not.toHaveBeenCalled();
    // The provenance blob is compared, so an identical run touches nothing.
    expect(prismaMock.directoryContactSource.update).not.toHaveBeenCalled();
  });

  it("writes NOTHING when the stored blob comes back from jsonb with its keys reordered (CQ-B054)", async () => {
    // PostgreSQL jsonb returns object keys in its own order (shorter first,
    // then bytewise), never the order they were written in. A JSON.stringify
    // comparison called that a change and rewrote every row on every run.
    const p = person();
    const reordered = Object.fromEntries(Object.entries(p).reverse());
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(p));
    readers.entra.mockResolvedValue([p]);
    stubLocal({
      provenance: [{ externalId: "e1", contactId: "c1", observed: reordered }],
      contactsByEmail: [{ id: "c1", email: "jane@example.com", origin: "entra" }],
      projectionRows: [{
        id: "c1", name: "Jane Doe", kind: "person", jobTitle: null, department: null,
        phone: null, description: null, origin: "entra",
        directorySources: [{ sourceKind: "entra", observed: p }],
      }],
    });

    const out = await runDirectorySync(OPTS);
    expect(out.unchanged).toBe(1);
    expect(prismaMock.directoryContactSource.update).not.toHaveBeenCalled();
  });

  it("updates the provenance blob when the directory changed something", async () => {
    const before = person({ jobTitle: "Operator" });
    const after = person({ jobTitle: "Plant Operator" });
    readers.entra.mockResolvedValue([after]);
    stubLocal({
      provenance: [{ externalId: "e1", contactId: "c1", observed: before }],
      contactsByEmail: [{ id: "c1", email: "jane@example.com", origin: "entra" }],
      projectionRows: [{
        id: "c1", name: "Jane Doe", kind: "person", jobTitle: "Operator", department: null,
        phone: null, description: null, origin: "entra",
        directorySources: [{ sourceKind: "entra", observed: after }],
      }],
    });

    const out = await runDirectorySync(OPTS);
    expect(prismaMock.directoryContactSource.update).toHaveBeenCalled();
    expect(out.updated).toBe(1);
  });
});

describe("runDirectorySync — the deletion guard", () => {
  it("refuses to delete anything when the read came back empty", async () => {
    // A revoked grant, an expired secret or an unreachable DC all present as
    // "everyone left the company".
    readers.entra.mockResolvedValue([]);
    stubLocal({
      provenance: Array.from({ length: 40 }, (_, i) => ({
        externalId: `e${i}`, contactId: `c${i}`, observed: person(),
      })),
    });

    const out = await runDirectorySync(OPTS);
    expect(out.deleteSkippedGuard).toBe(true);
    expect(out.deleted).toBe(0);
    expect(prismaMock.directoryContactSource.deleteMany).not.toHaveBeenCalled();
    expect(events.logged.at(-1)!.level).toBe("warning");
  });

  it("refuses a delete set over the guard, and says so in the message", async () => {
    readers.entra.mockResolvedValue([person({ externalId: "keep" })]);
    stubLocal({
      provenance: [
        { externalId: "keep", contactId: "c0", observed: person({ externalId: "keep" }) },
        ...Array.from({ length: 200 }, (_, i) => ({
          externalId: `gone${i}`, contactId: `c${i + 1}`, observed: person(),
        })),
      ],
      contactsByEmail: [{ id: "c0", email: "jane@example.com", origin: "entra" }],
    });

    const out = await runDirectorySync(OPTS);
    expect(out.deleteSkippedGuard).toBe(true);
    expect(prismaMock.directoryContactSource.deleteMany).not.toHaveBeenCalled();
    expect(events.logged.at(-1)!.message).toMatch(/REMOVALS SKIPPED/);
  });

  it("does delete an ordinary departure, and only where no source is left", async () => {
    readers.entra.mockResolvedValue([]);
    stubLocal({ provenance: [{ externalId: "gone", contactId: "c9", observed: person() }] });
    prismaMock.contact.deleteMany.mockResolvedValue({ count: 1 });

    // scanned === 0 is itself a guard trip, so give it something to scan.
    readers.entra.mockResolvedValue([person({ externalId: "other", email: "bob@example.com" })]);
    const out = await runDirectorySync(OPTS);

    expect(out.deleteSkippedGuard).toBe(false);
    expect(prismaMock.directoryContactSource.deleteMany).toHaveBeenCalled();
    const del = prismaMock.contact.deleteMany.mock.calls.at(-1)![0];
    // A contact lives while ANY provenance row still claims it — the other
    // directory's, typically. And an adopted row is structurally undeletable.
    expect(del.where.directorySources).toEqual({ none: {} });
    expect(del.where.origin).toEqual({ not: "manual" });
  });
});

describe("runDirectorySync — the audit trail names nobody", () => {
  it("logs counts only", async () => {
    readers.entra.mockResolvedValue([
      person({ externalId: "a", email: "jane@example.com", name: "Jane Doe", jobTitle: "Foreman" }),
      person({ externalId: "b", email: "bob@example.com", name: "Bob Smith", disabled: true }),
    ]);
    stubLocal();
    await runDirectorySync(OPTS);

    const ev = events.logged.at(-1)!;
    const serialized = JSON.stringify({ message: ev.message, details: ev.details });
    // Event.details is readable by anyone with events access and is shipped
    // off-host by the syslog and SFTP archivers.
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain("Jane");
    expect(serialized).not.toContain("Bob");
    expect(serialized).not.toContain("Foreman");
    // The dominant exclusion CATEGORY is fine, and is the actionable half.
    expect(ev.message).toMatch(/disabled account/);
    expect(ev.details.scanned).toBe(2);
  });
});

describe("purgeDirectoryContacts", () => {
  it("drops provenance, then only the contacts left with none", async () => {
    prismaMock.directoryContactSource.findMany.mockResolvedValue([
      { contactId: "c1" }, { contactId: "c2" }, { contactId: "c1" },
    ]);
    prismaMock.directoryContactSource.deleteMany.mockResolvedValue({ count: 3 });
    prismaMock.contact.deleteMany.mockResolvedValue({ count: 2 });

    const n = await purgeDirectoryContacts("i1", "directory sync switched off", "jsmith");
    expect(n).toBe(2);
    const del = prismaMock.contact.deleteMany.mock.calls.at(-1)![0];
    expect(del.where.origin).toEqual({ not: "manual" });
    expect(del.where.directorySources).toEqual({ none: {} });
    // Count and reason, no addresses.
    expect(JSON.stringify(events.logged.at(-1))).not.toContain("@");
  });

  it("is a no-op when the integration never synced anything", async () => {
    prismaMock.directoryContactSource.findMany.mockResolvedValue([]);
    expect(await purgeDirectoryContacts("i1", "integration deleted")).toBe(0);
    expect(prismaMock.contact.deleteMany).not.toHaveBeenCalled();
  });
});
