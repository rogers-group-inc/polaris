/**
 * tests/unit/writeScopeService.test.ts — business rule 141 (e): what a
 * Read-Write caller may change.
 *
 * Full Read-Write reaches everything; Read-Write reaches what the caller owns
 * (createdBy = the actor) plus, when they hold tags, what carries one of them
 * — region tags judged against the record's `region:<name>` tags and other
 * tags against the rest, never pooled; a request with no actor reaches
 * nothing and never throws on a flag; a bulk check refuses before any write
 * and names the first offender.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
vi.mock("../../src/db.js", () => ({ prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } } }));
vi.mock("../../src/services/regionScopeService.js", () => ({
  resolveTagScopesForUser: vi.fn(async (u: { regionTags: string[]; otherTags: string[] }) => ({
    regionTags: { user: u.regionTags, group: [], effective: u.regionTags },
    otherTags: { user: u.otherTags, group: [], effective: u.otherTags },
  })),
}));

import {
  resolveWriteScope,
  inWriteScope,
  assertInWriteScope,
  assertAllInWriteScope,
  assertFleetWide,
  reservationScopeRecord,
  type WriteScope,
} from "../../src/services/writeScopeService.js";

type FakeReq = {
  session?: { userId?: string; username?: string };
  apiToken?: { name: string; roleId: string };
  roleSnapshot?: { permissions: Record<string, string> };
};

function req(perm: string, opts: Partial<FakeReq> & { regions?: string[]; tags?: string[] } = {}): FakeReq {
  const { regions = [], tags = [], ...rest } = opts;
  findUnique.mockResolvedValue({ regionTags: regions, otherTags: tags, ssoGroups: [], authProvider: "local" });
  return {
    session: { userId: "u1", username: "alice" },
    roleSnapshot: { permissions: { assets: perm } },
    ...rest,
  };
}

beforeEach(() => { findUnique.mockReset(); });

describe("resolveWriteScope", () => {
  it("fullwrite is 'all' and never reads the user", async () => {
    const s = await resolveWriteScope(req("fullwrite") as never, "assets");
    expect(s.kind).toBe("all");
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("write with no tags is scoped to the actor alone", async () => {
    const s = await resolveWriteScope(req("write") as never, "assets");
    expect(s).toMatchObject({ kind: "scoped", actor: "alice" });
    expect(inWriteScope(s, { createdBy: "bob", tags: ["PCI"] })).toBe(false);
  });

  it("write with tags carries both dimensions, normalized", async () => {
    const s = await resolveWriteScope(req("write", { regions: [" Nashville "], tags: ["PCI"] }) as never, "assets");
    expect(s.kind).toBe("scoped");
    if (s.kind !== "scoped") return;
    expect([...s.regions]).toEqual(["nashville"]);
    expect([...s.tags]).toEqual(["pci"]);
  });

  it("a bearer token is the actor api:<name> with no tags, and reads no user", async () => {
    const r = req("write");
    delete r.session;
    r.apiToken = { name: "siem", roleId: "r9" };
    const s = await resolveWriteScope(r as never, "assets");
    expect(s).toMatchObject({ kind: "scoped", actor: "api:siem" });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("no actor at all (the Dash wallboard) is 'none'", async () => {
    const r = req("write");
    delete r.session;
    const s = await resolveWriteScope(r as never, "assets");
    expect(s.kind).toBe("none");
  });

  it("owner-only mode ignores the caller's tags", async () => {
    const s = await resolveWriteScope(req("write", { tags: ["PCI"] }) as never, "credentials", { ownerOnly: true });
    expect(inWriteScope(s, { createdBy: "bob", tags: ["PCI"] })).toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("memoises per request and key", async () => {
    const r = req("write", { tags: ["PCI"] });
    await resolveWriteScope(r as never, "assets");
    await resolveWriteScope(r as never, "assets");
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("inWriteScope", () => {
  const scoped: WriteScope = { kind: "scoped", actor: "alice", regions: new Set(["nashville"]), tags: new Set(["pci"]) };
  const tagless: WriteScope = { kind: "scoped", actor: "alice", regions: new Set(), tags: new Set() };

  it("owned rows are in scope whatever their tags", () => {
    expect(inWriteScope(tagless, { createdBy: "alice", tags: [] })).toBe(true);
    expect(inWriteScope(tagless, { createdBy: "bob", tags: [] })).toBe(false);
  });

  it("an unowned, untagged row is fullwrite-only", () => {
    expect(inWriteScope(scoped, { createdBy: null, tags: [] })).toBe(false);
    expect(inWriteScope({ kind: "all" }, { createdBy: null, tags: [] })).toBe(true);
  });

  it("a region tag on the row matches the caller's REGION, case-insensitively", () => {
    expect(inWriteScope(scoped, { createdBy: null, tags: ["Region:NASHVILLE"] })).toBe(true);
  });

  it("an other tag on the row matches the caller's OTHER tags, never their regions", () => {
    expect(inWriteScope(scoped, { createdBy: null, tags: ["pci"] })).toBe(true);
    // The "Atlanta" collision: a bare tag named like a region is not that region.
    expect(inWriteScope(scoped, { createdBy: null, tags: ["nashville"] })).toBe(false);
    // And a region tag is not matched by an other tag of the same name.
    const other: WriteScope = { kind: "scoped", actor: "x", regions: new Set(), tags: new Set(["nashville"]) };
    expect(inWriteScope(other, { createdBy: null, tags: ["region:nashville"] })).toBe(false);
  });

  it("'none' reaches nothing, even an owned row", () => {
    expect(inWriteScope({ kind: "none" }, { createdBy: "alice", tags: [] })).toBe(false);
  });
});

describe("the assertions", () => {
  const scoped: WriteScope = { kind: "scoped", actor: "alice", regions: new Set(), tags: new Set(["pci"]) };

  it("assertInWriteScope names the verb and both halves of the rule", () => {
    expect(() => assertInWriteScope(scoped, { createdBy: "bob", tags: [] }, "edit assets"))
      .toThrow(/you can only edit assets you created or that carry one of your tags/);
    expect(() => assertInWriteScope(scoped, { createdBy: "bob", tags: ["PCI"] }, "edit assets")).not.toThrow();
  });

  it("assertAllInWriteScope refuses on the first offender and names it", () => {
    const rows = [
      { id: "a", createdBy: "alice", tags: [] },
      { id: "b", createdBy: null, tags: [] },
      { id: "c", createdBy: null, tags: ["pci"] },
    ];
    expect(() => assertAllInWriteScope(scoped, rows, "quarantine devices", (r) => r.id)).toThrow(/\(b\)/);
    expect(() => assertAllInWriteScope({ kind: "all" }, rows, "quarantine devices")).not.toThrow();
  });

  it("assertFleetWide admits only fullwrite", () => {
    expect(() => assertFleetWide(scoped, "changing the staleness threshold")).toThrow(/needs Full Read-Write/);
    expect(() => assertFleetWide({ kind: "all" }, "x")).not.toThrow();
  });
});

describe("reservationScopeRecord", () => {
  it("judges a reservation on its creator, its network's tags and its device's tags", () => {
    const rec = reservationScopeRecord(
      { createdBy: "bob", subnet: { tags: ["region:Nashville"] } },
      { tags: ["pci"] },
    );
    expect(rec.createdBy).toBe("bob");
    expect(rec.tags).toEqual(["region:Nashville", "pci"]);
    expect(reservationScopeRecord({ createdBy: null, subnet: null }).tags).toEqual([]);
  });
});
