/**
 * tests/unit/contactService.test.ts
 *
 * Address-book service coverage:
 *   - normalizeContactEmail  — the write-side normalization the unique index
 *                              depends on (lower-case) plus its rejections.
 *   - searchAddressBook      — the union of Polaris users and contacts, the
 *                              dedupe precedence (user beats contact on the
 *                              same address), and prefix-first ranking.
 *   - resolveContactsForAsset — the FIRE-TIME path. The properties that matter
 *                              are that it unions pins with criteria matches,
 *                              never double-counts a contact matching both,
 *                              and never scans the fleet: it loads exactly the
 *                              one triggering asset, and only when some contact
 *                              actually carries a criteria filter.
 *
 * prisma is stubbed — this is the pure/behavioral half, not persistence.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above the imports, so the stub it closes over has to be
// hoisted with it.
const prismaMock = vi.hoisted(() => ({
  contact: {
    findMany: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  directoryContactSource: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
  asset: { findMany: vi.fn(), findUnique: vi.fn() },
  user: { findMany: vi.fn() },
  pushSubscription: { groupBy: vi.fn() },
  event: { create: vi.fn() },
  $queryRaw: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({ prisma: prismaMock }));
// logEvent reads retention settings on every call; stub it out entirely so the
// CRUD paths under test don't drag the settings cache in.
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn() }));

import {
  adoptDirectoryContact,
  bumpContactCache,
  conditionMeansAllDevices,
  CONTACT_PAGE_MAX,
  createContact,
  deleteContact,
  updateContact,
  listContacts,
  normalizeContactCondition,
  normalizeContactEmail,
  previewContactAssets,
  resolveContactsForAsset,
  searchAddressBook,
} from "../../src/services/contactService.js";

/** A condition tree in the stored (`assetCondition`) shape. */
const COND = (field: string, operator: string, value: string) => ({
  op: "and",
  children: [{ field, operator, value }],
});

const CRITERIA = (field: string, value: string) => ({
  version: 1,
  match: "all",
  rules: [{ field, op: "exact", values: [value] }],
});

const contactRow = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  email: "noc@example.com",
  name: "NOC",
  description: null,
  origin: "manual",
  kind: "person",
  jobTitle: null,
  department: null,
  phone: null,
  assetCriteria: null,
  assetIds: [],
  createdBy: "jsmith",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  bumpContactCache();
  prismaMock.user.findMany.mockResolvedValue([]);
  prismaMock.pushSubscription.groupBy.mockResolvedValue([]);
  prismaMock.contact.findMany.mockResolvedValue([]);
});

describe("normalizeContactEmail", () => {
  it("trims and lower-cases so the unique index is case-insensitive", () => {
    expect(normalizeContactEmail("  NOC@Example.COM ")).toBe("noc@example.com");
  });

  it("rejects blanks and malformed addresses", () => {
    expect(() => normalizeContactEmail("")).toThrow(/required/i);
    expect(() => normalizeContactEmail("   ")).toThrow(/required/i);
    expect(() => normalizeContactEmail("not-an-address")).toThrow(/not a valid email/i);
    expect(() => normalizeContactEmail("a@b")).toThrow(/not a valid email/i);
    expect(() => normalizeContactEmail("two words@example.com")).toThrow(/not a valid email/i);
  });

  it("rejects an over-long address before it reaches the column", () => {
    expect(() => normalizeContactEmail("a".repeat(315) + "@example.com")).toThrow(/too long/i);
  });
});

describe("searchAddressBook", () => {
  it("returns users and contacts together", async () => {
    prismaMock.user.findMany.mockResolvedValue([
      { id: "u1", username: "jdoe", displayName: "Jane Doe", email: "jane@example.com" },
    ]);
    prismaMock.contact.findMany.mockResolvedValue([contactRow()]);

    const out = await searchAddressBook("");
    expect(out.map((e) => e.email).sort()).toEqual(["jane@example.com", "noc@example.com"]);
    expect(out.find((e) => e.email === "jane@example.com")!.source).toBe("user");
    expect(out.find((e) => e.email === "noc@example.com")!.source).toBe("contact");
  });

  it("skips user accounts with no email — they cannot be an email recipient", async () => {
    prismaMock.user.findMany.mockResolvedValue([
      { id: "u1", username: "svc", displayName: null, email: null },
    ]);
    expect(await searchAddressBook("")).toEqual([]);
  });

  it("dedupes on the address with the USER winning over the contact", async () => {
    // A user id survives the person changing address; a stored contact string
    // does not — so the account is the entry worth keeping.
    prismaMock.user.findMany.mockResolvedValue([
      { id: "u1", username: "jdoe", displayName: "Jane Doe", email: "jane@example.com" },
    ]);
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c9", email: "jane@example.com", name: "Jane (personal)" }),
    ]);

    const out = await searchAddressBook("");
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("user");
  });

  it("matches on name as well as address, case-insensitively", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c1", email: "a@example.com", name: "Night Shift" }),
      contactRow({ id: "c2", email: "b@example.com", name: "Day Shift" }),
    ]);
    const out = await searchAddressBook("NIGHT");
    expect(out.map((e) => e.email)).toEqual(["a@example.com"]);
  });

  it("ranks prefix matches above interior ones", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c1", email: "jane.donovan@example.com", name: "Jane Donovan" }),
      contactRow({ id: "c2", email: "noc@example.com", name: "NOC" }),
    ]);
    // "no" appears inside "jane.doNOvan" and at the head of "noc@…".
    const out = await searchAddressBook("no");
    expect(out[0].email).toBe("noc@example.com");
  });

  it("flags rows the caller owns so the picker can offer Edit", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c1", email: "mine@example.com", createdBy: "jsmith" }),
      contactRow({ id: "c2", email: "theirs@example.com", createdBy: "someone-else" }),
    ]);
    const out = await searchAddressBook("", { callerUsername: "jsmith" });
    expect(out.find((e) => e.email === "mine@example.com")!.owned).toBe(true);
    expect(out.find((e) => e.email === "theirs@example.com")!.owned).toBe(false);
  });

  it("caps the result set", async () => {
    prismaMock.contact.findMany.mockResolvedValue(
      Array.from({ length: 80 }, (_, i) => contactRow({ id: `c${i}`, email: `u${i}@example.com` })),
    );
    expect(await searchAddressBook("")).toHaveLength(50);
    expect(await searchAddressBook("", { limit: 5 })).toHaveLength(5);
  });

  it("carries each account's enrolled push-device count, and only for accounts", async () => {
    // Push is opt-in PER BROWSER: zero enrolled browsers is why a push
    // automation naming a perfectly good recipient delivers nothing, and the
    // count is already computed by listRecipientUsers — dropping it here is
    // what made the address book unable to say so.
    prismaMock.user.findMany.mockResolvedValue([
      { id: "u1", username: "jdoe", displayName: "Jane Doe", email: "jane@example.com" },
      { id: "u2", username: "sroe", displayName: "Sam Roe", email: "sam@example.com" },
    ]);
    prismaMock.pushSubscription.groupBy.mockResolvedValue([{ userId: "u1", _count: { _all: 2 } }]);
    prismaMock.contact.findMany.mockResolvedValue([contactRow()]);

    const out = await searchAddressBook("");
    expect(out.find((e) => e.email === "jane@example.com")!.pushDevices).toBe(2);
    expect(out.find((e) => e.email === "sam@example.com")!.pushDevices).toBe(0);
    // A contact is an address, not an account: there is no count to state.
    expect(out.find((e) => e.email === "noc@example.com")!.pushDevices).toBeUndefined();
  });
});

describe("resolveContactsForAsset", () => {
  it("returns nothing when the book is empty, without touching the asset table", async () => {
    prismaMock.contact.findMany.mockResolvedValue([]);
    expect(await resolveContactsForAsset("a1")).toEqual([]);
    expect(prismaMock.asset.findUnique).not.toHaveBeenCalled();
  });

  it("matches an explicit pin WITHOUT loading the asset at all", async () => {
    // Pins are a plain id comparison — a contact that only pins devices must
    // not cost a query on the fire-time path.
    prismaMock.contact.findMany.mockResolvedValue([contactRow({ assetIds: ["a1"] })]);
    const out = await resolveContactsForAsset("a1");
    expect(out.map((c) => c.email)).toEqual(["noc@example.com"]);
    expect(prismaMock.asset.findUnique).not.toHaveBeenCalled();
  });

  it("does not match a contact pinned to a different device", async () => {
    prismaMock.contact.findMany.mockResolvedValue([contactRow({ assetIds: ["other"] })]);
    expect(await resolveContactsForAsset("a1")).toEqual([]);
  });

  it("matches on criteria, loading exactly the one triggering asset", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c1", email: "srv@example.com", assetCriteria: CRITERIA("assetType", "server") }),
      contactRow({ id: "c2", email: "fw@example.com", assetCriteria: CRITERIA("assetType", "firewall") }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({ id: "a1", assetType: "server", ipAddress: null });

    const out = await resolveContactsForAsset("a1");
    expect(out.map((c) => c.email)).toEqual(["srv@example.com"]);
    // One asset read, never a findMany over the fleet.
    expect(prismaMock.asset.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.asset.findMany).not.toHaveBeenCalled();
  });

  it("skips the CIDR containment query when no contact filters by subnet", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ assetCriteria: CRITERIA("assetType", "server") }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({ id: "a1", assetType: "server", ipAddress: "10.0.0.5" });
    await resolveContactsForAsset("a1");
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("unions pins with criteria matches and never lists a contact twice", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c1", email: "both@example.com", assetIds: ["a1"], assetCriteria: CRITERIA("assetType", "server") }),
      contactRow({ id: "c2", email: "pin@example.com", assetIds: ["a1"] }),
      contactRow({ id: "c3", email: "crit@example.com", assetCriteria: CRITERIA("assetType", "server") }),
      contactRow({ id: "c4", email: "neither@example.com", assetCriteria: CRITERIA("assetType", "printer") }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({ id: "a1", assetType: "server", ipAddress: null });

    const out = await resolveContactsForAsset("a1");
    expect(out.map((c) => c.email).sort()).toEqual(["both@example.com", "crit@example.com", "pin@example.com"]);
  });

  it("still honours pins when the asset row has been deleted", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c1", email: "pin@example.com", assetIds: ["a1"] }),
      contactRow({ id: "c2", email: "crit@example.com", assetCriteria: CRITERIA("assetType", "server") }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue(null);
    const out = await resolveContactsForAsset("a1");
    expect(out.map((c) => c.email)).toEqual(["pin@example.com"]);
  });
});

// ─── Condition-tree device filter (the shape that superseded assetCriteria) ───

describe("normalizeContactCondition", () => {
  it("accepts the wider device-filter vocabulary", () => {
    expect(normalizeContactCondition(COND("location", "contains", "Ashfield"))).toBeTruthy();
    expect(normalizeContactCondition(COND("fortigate", "contains", "CENTRAL"))).toBeTruthy();
    expect(normalizeContactCondition(COND("hostname", "matches", "PLV*"))).toBeTruthy();
  });

  it("reads an empty tree as no filter, never as every device", () => {
    expect(normalizeContactCondition(null)).toBeNull();
    expect(normalizeContactCondition({ op: "and", children: [] })).toBeNull();
    expect(normalizeContactCondition({ op: "and", children: [{ op: "or", children: [] }] })).toBeNull();
  });

  it("rejects a malformed tree with a 400", () => {
    expect(() => normalizeContactCondition({ op: "nope", children: [] })).toThrow(/invalid/i);
    expect(() => normalizeContactCondition(COND("hostname", "isExactly", "x"))).toThrow(/invalid/i);
    expect(() => normalizeContactCondition(COND("nosuchfield", "equals", "x"))).toThrow(/invalid/i);
  });

  it("refuses a tree nested past the cap", () => {
    let node: unknown = { field: "hostname", operator: "contains", value: "x" };
    for (let i = 0; i < 8; i++) node = { op: "and", children: [node] };
    expect(() => normalizeContactCondition(node)).toThrow(/nest at most/i);
  });
});

describe("resolveContactsForAsset — condition trees", () => {
  it("matches a stored condition against the one triggering asset", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c1", email: "ashf@example.com", assetCondition: COND("location", "contains", "ashfield") }),
      contactRow({ id: "c2", email: "knox@example.com", assetCondition: COND("location", "contains", "knoxville") }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({ id: "a1", location: "Ashfield Plant", ipAddress: null });

    const out = await resolveContactsForAsset("a1");
    expect(out.map((c) => c.email)).toEqual(["ashf@example.com"]);
    expect(prismaMock.asset.findMany).not.toHaveBeenCalled();
  });

  it("matches on the FortiGate a device is sighted behind", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ assetCondition: COND("fortigate", "contains", "ashf-edge") }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({
      id: "a1",
      learnedLocation: "CENTRALFGT1",
      fortigateSightings: [{ fortigateDevice: "ASHF-EDGE-01" }],
      ipAddress: null,
    });
    expect((await resolveContactsForAsset("a1")).length).toBe(1);
  });

  it("does its own CIDR math — no containment query for a subnet condition", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ assetCondition: COND("subnet", "inCidr", "10.20.0.0/16") }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({ id: "a1", ipAddress: "10.20.3.7" });
    expect((await resolveContactsForAsset("a1")).length).toBe(1);
    // The tree evaluates ipInCidr in memory; only the legacy predicate defers
    // containment to the database.
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("treats the all-devices marker as owning every device", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ email: "everything@example.com", assetCondition: { op: "and", children: [] } }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({ id: "a1", assetType: "printer", ipAddress: null });
    expect((await resolveContactsForAsset("a1")).map((c) => c.email)).toEqual(["everything@example.com"]);
  });

  it("folds a legacy flat criteria forward and matches through the tree", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ email: "legacy@example.com", assetCriteria: CRITERIA("location", "Ashfield Plant") }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({ id: "a1", location: "Ashfield Plant", ipAddress: null });
    expect((await resolveContactsForAsset("a1")).length).toBe(1);
  });

  it("keeps matching a legacy criteria the tree cannot express", async () => {
    // `integration` has no condition-tree equivalent, so this row must stay on
    // the flat predicate rather than silently losing the rule.
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({
        email: "byint@example.com",
        assetCriteria: { version: 1, match: "all", rules: [{ field: "integration", op: "exact", values: ["int-1"] }] },
      }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({
      id: "a1",
      discoveredByIntegrationId: "int-1",
      sources: [],
      ipAddress: null,
    });
    expect((await resolveContactsForAsset("a1")).length).toBe(1);
  });

  it("ignores a stored condition that no longer validates instead of throwing", async () => {
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ email: "broken@example.com", assetCondition: { op: "and", children: [{ field: "gone", operator: "equals", value: "x" }] } }),
    ]);
    prismaMock.asset.findUnique.mockResolvedValue({ id: "a1", ipAddress: null });
    // No filter → owns nothing, and the list still resolves.
    expect(await resolveContactsForAsset("a1")).toEqual([]);
  });
});

describe("writes normalize the filter to one live shape", () => {
  beforeEach(() => {
    prismaMock.contact.findUnique.mockResolvedValue(null); // no email clash
    prismaMock.contact.create.mockImplementation(({ data }: any) => ({
      id: "new",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));
  });

  const createdData = () => prismaMock.contact.create.mock.calls[0]![0].data;

  it("stores a posted condition and leaves the legacy column unset", async () => {
    await createContact({ email: "a@example.com", assetCondition: COND("location", "contains", "ashf") }, "jsmith");
    expect(createdData().assetCondition).toEqual(COND("location", "contains", "ashf"));
    expect(createdData().assetCriteria).toBeUndefined();
  });

  it("folds a posted flat criteria forward rather than storing it", async () => {
    await createContact({ email: "a@example.com", assetCriteria: CRITERIA("assetType", "switch") }, "jsmith");
    expect(createdData().assetCondition).toEqual({
      op: "and",
      children: [{ field: "assetType", operator: "equals", value: "switch" }],
    });
    expect(createdData().assetCriteria).toBeUndefined();
  });

  it("keeps a flat criteria the tree cannot express as legacy", async () => {
    await createContact(
      {
        email: "a@example.com",
        assetCriteria: { version: 1, match: "all", rules: [{ field: "integration", op: "exact", values: ["int-1"] }] },
      },
      "jsmith",
    );
    expect(createdData().assetCondition).toBeUndefined();
    expect(createdData().assetCriteria).toBeTruthy();
  });

  it("only produces the all-devices marker from the explicit flag", async () => {
    await createContact({ email: "a@example.com", assetAllDevices: true }, "jsmith");
    expect(conditionMeansAllDevices(createdData().assetCondition)).toBe(true);

    prismaMock.contact.create.mockClear();
    // An empty tree is NOT a way in — that would hand the contact the fleet.
    await createContact({ email: "b@example.com", assetCondition: { op: "and", children: [] } }, "jsmith");
    expect(createdData().assetCondition).toBeUndefined();
  });
});

describe("previewContactAssets", () => {
  beforeEach(() => {
    prismaMock.asset.findMany.mockResolvedValue([]);
  });

  it("evaluates a condition over the fleet and counts the MONITORED matches", async () => {
    prismaMock.asset.findMany
      .mockResolvedValueOnce([
        { id: "a1", location: "Ashfield Plant" },
        { id: "a2", location: "Knoxville Yard" },
      ])
      // the sample read for the matched ids
      .mockResolvedValueOnce([
        { id: "a1", hostname: "SW1", ipAddress: null, assetType: "switch", monitored: true },
      ]);

    const out = await previewContactAssets({ assetCondition: COND("location", "contains", "ashfield") });
    expect(out.matchCount).toBe(1);
    expect(out.unmonitoredCount).toBe(0);
    expect(out.sample.map((s) => s.id)).toEqual(["a1"]);
    // `monitored` is a filter input, not something the caller renders.
    expect(out.sample[0]).not.toHaveProperty("monitored");
  });

  it("counts unmonitored matches separately and keeps them out of the list", async () => {
    // The filter DOES cover them — an event/change automation fires on an
    // unmonitored device — so they're reported, just not offered as choices.
    prismaMock.asset.findMany
      .mockResolvedValueOnce([{ id: "a1" }, { id: "a2" }, { id: "a3" }])
      .mockResolvedValueOnce([
        { id: "a1", hostname: "SW1", ipAddress: null, assetType: "switch", monitored: true },
        { id: "a2", hostname: "OLD1", ipAddress: null, assetType: "server", monitored: false },
        { id: "a3", hostname: "OLD2", ipAddress: null, assetType: "server", monitored: false },
      ]);

    const out = await previewContactAssets({ assetCondition: COND("status", "notEquals", "decommissioned") });
    expect(out.matchCount).toBe(1);
    expect(out.unmonitoredCount).toBe(2);
    expect(out.sample.map((s) => s.hostname)).toEqual(["SW1"]);
  });

  it("joins the FortiGate sighting relation only when a condition asks for it", async () => {
    await previewContactAssets({ assetCondition: COND("location", "contains", "x") });
    expect(prismaMock.asset.findMany.mock.calls[0]![0].select.fortigateSightings).toBeUndefined();

    prismaMock.asset.findMany.mockClear();
    prismaMock.asset.findMany.mockResolvedValue([]);
    await previewContactAssets({ assetCondition: COND("fortigate", "contains", "x") });
    expect(prismaMock.asset.findMany.mock.calls[0]![0].select.fortigateSightings).toBeTruthy();
  });

  it("reads an address-only contact as covering nothing, with no fleet read", async () => {
    const out = await previewContactAssets({});
    expect(out).toEqual({ matchCount: 0, unmonitoredCount: 0, sample: [] });
    expect(prismaMock.asset.findMany).not.toHaveBeenCalled();
  });

  it("unions explicit pins with the condition matches", async () => {
    prismaMock.asset.findMany
      .mockResolvedValueOnce([{ id: "a1", location: "Ashfield" }])
      .mockResolvedValueOnce([
        { id: "a1", hostname: "SW1", ipAddress: null, assetType: "switch", monitored: true },
        { id: "pinned", hostname: "SRV9", ipAddress: null, assetType: "server", monitored: true },
      ]);
    const out = await previewContactAssets({
      assetCondition: COND("location", "contains", "ashfield"),
      assetIds: ["pinned"],
    });
    expect(out.matchCount).toBe(2);
  });
});

describe("listContacts (paging + server-side search)", () => {
  it("returns a page plus the UNPAGED total", async () => {
    // total is what the "showing N of M" hint reads. Returning contacts.length
    // instead would make a truncated page indistinguishable from a complete one.
    prismaMock.contact.findMany.mockResolvedValue([contactRow()]);
    prismaMock.contact.count.mockResolvedValue(4210);

    const page = await listContacts({ limit: 1 });
    expect(page.contacts).toHaveLength(1);
    expect(page.total).toBe(4210);
  });

  it("pushes the search term into SQL rather than filtering in memory", async () => {
    prismaMock.contact.findMany.mockResolvedValue([]);
    prismaMock.contact.count.mockResolvedValue(0);

    await listContacts({ q: "night", limit: 25, offset: 50 });
    const args = prismaMock.contact.findMany.mock.calls.at(-1)![0];
    expect(args.where.OR).toEqual([
      { email: { contains: "night", mode: "insensitive" } },
      { name: { contains: "night", mode: "insensitive" } },
    ]);
    expect(args.take).toBe(25);
    expect(args.skip).toBe(50);
    // The count must use the SAME predicate, or the pager reports a total for
    // a different question than the page answers.
    expect(prismaMock.contact.count.mock.calls.at(-1)![0].where).toEqual(args.where);
  });

  it("clamps the page size, so an uncapped caller cannot un-paginate the table", async () => {
    prismaMock.contact.findMany.mockResolvedValue([]);
    prismaMock.contact.count.mockResolvedValue(0);

    await listContacts({ limit: 100_000 });
    expect(prismaMock.contact.findMany.mock.calls.at(-1)![0].take).toBe(CONTACT_PAGE_MAX);

    await listContacts({ limit: 0, offset: -5 });
    const args = prismaMock.contact.findMany.mock.calls.at(-1)![0];
    expect(args.take).toBe(1);
    expect(args.skip).toBe(0);
  });

  it("treats a blank query as no search predicate, but keeps the visibility gate", async () => {
    prismaMock.contact.findMany.mockResolvedValue([]);
    prismaMock.contact.count.mockResolvedValue(0);
    await listContacts({ q: "   " });
    // Gated by DEFAULT: includeDirectorySynced has to be granted, never assumed.
    expect(prismaMock.contact.findMany.mock.calls.at(-1)![0].where).toEqual({ origin: "manual" });

    await listContacts({ q: "   ", includeDirectorySynced: true });
    expect(prismaMock.contact.findMany.mock.calls.at(-1)![0].where).toEqual({});
  });

  it("never widens visibility from the caller's own origin filter", async () => {
    // The gate and the filter are separate parameters precisely so asking for
    // directory rows cannot grant them.
    prismaMock.contact.findMany.mockResolvedValue([]);
    prismaMock.contact.count.mockResolvedValue(0);

    await listContacts({ origin: "directory" });
    // Nothing, not the manual rows: falling back would answer a question the
    // caller did not ask, and read as a broken filter rather than a gate.
    expect(prismaMock.contact.findMany.mock.calls.at(-1)![0].where).toEqual({ origin: { in: [] } });

    await listContacts({ origin: "directory", includeDirectorySynced: true });
    expect(prismaMock.contact.findMany.mock.calls.at(-1)![0].where)
      .toEqual({ origin: { not: "manual" } });
  });

  it("narrows to ONE backend, under the same gate", async () => {
    // What the address book's per-directory tab asks for. A named backend is a
    // narrowing of "directory", so it must take the gate identically — asking
    // for "entra" is not a way around asking for "directory".
    prismaMock.contact.findMany.mockResolvedValue([]);
    prismaMock.contact.count.mockResolvedValue(0);

    await listContacts({ origin: "entra", includeDirectorySynced: true });
    expect(prismaMock.contact.findMany.mock.calls.at(-1)![0].where).toEqual({ origin: "entra" });

    await listContacts({ origin: "entra" });
    expect(prismaMock.contact.findMany.mock.calls.at(-1)![0].where).toEqual({ origin: { in: [] } });
  });
});

describe("address-book reads are bounded", () => {
  it("searchAddressBook filters contacts in SQL and bounds what it fetches", async () => {
    // The regression this guards: reading the whole table and Zod-validating
    // every stored filter blob on each keystroke of the recipient typeahead.
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.contact.findMany.mockResolvedValue([]);

    await searchAddressBook("noc", { limit: 10 });
    const args = prismaMock.contact.findMany.mock.calls.at(-1)![0];
    expect(args.where.OR).toEqual([
      { email: { contains: "noc", mode: "insensitive" } },
      { name: { contains: "noc", mode: "insensitive" } },
    ]);
    expect(args.take).toBe(21); // limit * 2 + 1, so dedupe cannot short the page
    // Scalars only — no JSON filter blobs, so rowToContact never runs here.
    expect(Object.keys(args.select).sort()).toEqual([
      "createdBy", "department", "description", "email", "id", "jobTitle", "kind", "name", "origin", "phone",
    ]);
  });

  it("hides directory-synced rows from an ungated caller, and the live fan-out with them", async () => {
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.contact.findMany.mockResolvedValue([]);

    await searchAddressBook("noc");
    expect(prismaMock.contact.findMany.mock.calls.at(-1)![0].where.origin).toBe("manual");

    await searchAddressBook("noc", { includeDirectorySynced: true });
    expect(prismaMock.contact.findMany.mock.calls.at(-1)![0].where.origin).toBeUndefined();
  });

  it("badges a synced row as its directory, not as a plain contact", async () => {
    // origin stores the BACKEND NAME so it maps straight onto the picker's
    // existing entra / ad badges with no client-side translation.
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.contact.findMany.mockResolvedValue([
      contactRow({ id: "c1", email: "a@example.com", origin: "entra", jobTitle: "Foreman" }),
      contactRow({ id: "c2", email: "b@example.com", origin: "manual" }),
    ]);

    const out = await searchAddressBook("", { includeDirectorySynced: true });
    expect(out.find((e) => e.email === "a@example.com")!.source).toBe("entra");
    expect(out.find((e) => e.email === "a@example.com")!.jobTitle).toBe("Foreman");
    expect(out.find((e) => e.email === "b@example.com")!.source).toBe("contact");
  });

  it("the fire path loads only contacts that could own a device", async () => {
    // A contact with no filter and no pins can never match a triggering asset,
    // so the alert path must not pay to load it. Without this the cost of every
    // alert would scale with the size of the address book.
    prismaMock.contact.findMany.mockResolvedValue([]);
    await resolveContactsForAsset("a1");

    const args = prismaMock.contact.findMany.mock.calls.at(-1)![0];
    expect(args.where.OR).toHaveLength(3);
    expect(args.where.OR).toContainEqual({ assetIds: { isEmpty: false } });
    // The two JSON columns are matched as DB-NULL, not JSON-null: the writers
    // pass `undefined` for "no filter", which leaves the column SQL NULL.
    expect(args.where.OR.filter((c: Record<string, unknown>) => "assetCondition" in c || "assetCriteria" in c))
      .toHaveLength(2);
  });
});

describe("adoption: an operator taking a synced row out of the sync's hands", () => {
  /** $transaction([deleteMany, update]) resolves to both results, in order. */
  const stubAdoptTx = (row: Record<string, unknown>) => {
    prismaMock.directoryContactSource.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.contact.update.mockResolvedValue(row);
    prismaMock.$transaction.mockResolvedValue([{ count: 1 }, row]);
  };

  it("creating over a synced address adopts the row instead of 409ing", async () => {
    // email is UNIQUE, so a synced row physically blocks hand-creating the same
    // person. Refusing would leave the operator no way to claim an address they
    // are looking straight at.
    prismaMock.contact.findUnique
      .mockResolvedValueOnce({ id: "c1", name: "J Martin", origin: "entra" })   // collision probe
      .mockResolvedValueOnce({ id: "c1", email: "j@example.com", name: "J Martin", origin: "entra" });
    stubAdoptTx(contactRow({ id: "c1", email: "j@example.com", origin: "manual", createdBy: "jsmith" }));

    const out = await createContact({ email: "j@example.com", name: "J Martin" }, "jsmith");
    expect(out.origin).toBe("manual");
    expect(prismaMock.contact.create).not.toHaveBeenCalled();
    // Dropping the provenance is the whole mechanism: it is what makes the row
    // survive the person leaving the directory.
    expect(prismaMock.directoryContactSource.deleteMany)
      .toHaveBeenCalledWith({ where: { contactId: "c1" } });
    const data = prismaMock.contact.update.mock.calls.at(-1)![0].data;
    expect(data.origin).toBe("manual");
    expect(data.createdBy).toBe("jsmith");
  });

  it("creating over a MANUAL address still 409s — adoption is only for synced rows", async () => {
    prismaMock.contact.findUnique.mockResolvedValue({ id: "c1", name: "NOC", origin: "manual" });
    await expect(createContact({ email: "noc@example.com" }, "jsmith"))
      .rejects.toThrow(/already in the address book/i);
  });

  it("editing a synced row adopts it rather than writing into it", async () => {
    // A plain update would look like it worked and be overwritten on the next
    // discovery run.
    prismaMock.contact.findUnique
      .mockResolvedValueOnce(null)                                              // no email clash
      .mockResolvedValueOnce({ origin: "ad" })                                  // current row
      .mockResolvedValueOnce({ id: "c1", email: "j@example.com", name: null, origin: "ad" });
    stubAdoptTx(contactRow({ id: "c1", email: "j@example.com", origin: "manual" }));

    const out = await updateContact("c1", { email: "j@example.com", name: "Jay" }, "jsmith");
    expect(out.origin).toBe("manual");
    expect(prismaMock.directoryContactSource.deleteMany).toHaveBeenCalled();
  });

  it("a bare adopt keeps what the directory reported — it claims, it does not blank", async () => {
    prismaMock.contact.findUnique.mockResolvedValue({
      id: "c1", email: "j@example.com", name: "J Martin", origin: "entra",
    });
    stubAdoptTx(contactRow({ id: "c1", email: "j@example.com", origin: "manual" }));

    await adoptDirectoryContact("c1", { actor: "jsmith" });
    const data = prismaMock.contact.update.mock.calls.at(-1)![0].data;
    expect(Object.keys(data).sort()).toEqual(["createdBy", "origin"]);
  });

  it("refuses to adopt a row that is already the operator's", async () => {
    prismaMock.contact.findUnique.mockResolvedValue({
      id: "c1", email: "noc@example.com", name: "NOC", origin: "manual",
    });
    await expect(adoptDirectoryContact("c1", { actor: "jsmith" }))
      .rejects.toThrow(/already an address-book entry you own/i);
  });
});

describe("deleteContact", () => {
  it("refuses a synced row, naming both ways out", async () => {
    // Deleting would succeed and then be undone by the next run, leaving the
    // operator believing the address was gone.
    prismaMock.contact.findUnique.mockResolvedValue({
      email: "j@example.com", name: "J Martin", origin: "ad",
    });
    await expect(deleteContact("c1", "jsmith")).rejects.toThrow(/Active Directory/);
    await expect(deleteContact("c1", "jsmith")).rejects.toThrow(/directory-sync filter/);
    expect(prismaMock.contact.delete).not.toHaveBeenCalled();
  });

  it("deletes a manual row", async () => {
    prismaMock.contact.findUnique.mockResolvedValue({
      email: "noc@example.com", name: "NOC", origin: "manual",
    });
    prismaMock.contact.delete.mockResolvedValue({});
    await deleteContact("c1", "jsmith");
    expect(prismaMock.contact.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
  });
});
