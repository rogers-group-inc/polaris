/**
 * tests/unit/regionScopeService.test.ts — CQ-T010 own suite for
 * src/services/regionScopeService.ts.
 *
 * tests/unit/regionScopeRename.test.ts drives the rename / delete pair over an
 * in-memory store. This suite covers the READ side the routes and the AI
 * assistant use — union(user, group) for both dimensions, group tags resolved
 * live from ssoGroups under the right mapping provider, an unknown user as
 * unrestricted — plus the write side's guards and its Prisma calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

const groups = vi.hoisted(() => ({ resolveGroupsToAccess: vi.fn() }));
vi.mock("../../src/services/groupMappingService.js", () => ({
  resolveGroupsToAccess: groups.resolveGroupsToAccess,
  // The real one-liner: "azure" (SAML) logins resolve under the "saml" provider.
  mappingProviderForAuthProvider: (p: string) => (p === "azure" ? "saml" : p),
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  resolveTagScopesForUser,
  getEffectiveRegionTags,
  getEffectiveTagScopes,
  renameRegionInPrincipalScopes,
  principalsScopedToRegion,
} from "../../src/services/regionScopeService.js";

const p = prisma as any;

function user(over: Partial<{ regionTags: string[] | null; otherTags: string[] | null; ssoGroups: string[] | null; authProvider: string }> = {}) {
  return { regionTags: [], otherTags: [], ssoGroups: null, authProvider: "local", ...over };
}

beforeEach(() => {
  resetDbStub();
  groups.resolveGroupsToAccess.mockReset();
  groups.resolveGroupsToAccess.mockResolvedValue({ regionTags: [], otherTags: [] });
  stubbed(p.user.findMany).mockResolvedValue([]);
  stubbed(p.groupMapping.findMany).mockResolvedValue([]);
});

describe("resolveTagScopesForUser", () => {
  it("a local user with no groups: effective = own tags, deduped case-insensitively and sorted; no group lookup", async () => {
    const s = await resolveTagScopesForUser(user({ regionTags: ["South", "north", "south"], otherTags: ["pci"] }));
    expect(groups.resolveGroupsToAccess).not.toHaveBeenCalled();
    expect(s.regionTags).toEqual({ user: ["South", "north", "south"], group: [], effective: ["north", "South"] });
    expect(s.otherTags).toEqual({ user: ["pci"], group: [], effective: ["pci"] });
  });

  it("unions group-derived tags with the user's own in both dimensions", async () => {
    groups.resolveGroupsToAccess.mockResolvedValue({ regionTags: ["West", "south"], otherTags: ["lab"] });
    const s = await resolveTagScopesForUser(user({ regionTags: ["South"], otherTags: ["pci"], ssoGroups: ["g1"], authProvider: "oidc" }));
    expect(groups.resolveGroupsToAccess).toHaveBeenCalledWith("oidc", ["g1"]);
    expect(s.regionTags).toEqual({ user: ["South"], group: ["West", "south"], effective: ["South", "West"] });
    expect(s.otherTags.effective).toEqual(["lab", "pci"]);
  });

  it("an azure (SAML) user resolves under the saml mapping provider", async () => {
    await resolveTagScopesForUser(user({ ssoGroups: ["g"], authProvider: "azure" }));
    expect(groups.resolveGroupsToAccess).toHaveBeenCalledWith("saml", ["g"]);
  });

  it("an empty ssoGroups list does not hit the group resolver", async () => {
    await resolveTagScopesForUser(user({ ssoGroups: [], authProvider: "ldap" }));
    expect(groups.resolveGroupsToAccess).not.toHaveBeenCalled();
  });

  it("null tag columns read as empty", async () => {
    const s = await resolveTagScopesForUser(user({ regionTags: null, otherTags: null, ssoGroups: null }));
    expect(s.regionTags).toEqual({ user: [], group: [], effective: [] });
    expect(s.otherTags).toEqual({ user: [], group: [], effective: [] });
  });

  it("drops blank and whitespace-padded duplicates from the effective list", async () => {
    groups.resolveGroupsToAccess.mockResolvedValue({ regionTags: [" South "], otherTags: [] });
    const s = await resolveTagScopesForUser(user({ regionTags: ["", "South"], ssoGroups: ["g"] }));
    expect(s.regionTags.effective).toEqual(["South"]);
  });

  it("propagates a group-resolution failure", async () => {
    groups.resolveGroupsToAccess.mockRejectedValue(new Error("db"));
    await expect(resolveTagScopesForUser(user({ ssoGroups: ["g"] }))).rejects.toThrow("db");
  });
});

describe("getEffectiveRegionTags", () => {
  it("reads one user row with the four scope columns and returns the effective regions", async () => {
    stubbed(p.user.findUnique).mockResolvedValue(user({ regionTags: ["South"], otherTags: ["pci"] }));
    await expect(getEffectiveRegionTags("u1")).resolves.toEqual(["South"]);
    expect(p.user.findUnique).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: { regionTags: true, otherTags: true, ssoGroups: true, authProvider: true },
    });
  });

  it("an unknown user is unrestricted ([])", async () => {
    stubbed(p.user.findUnique).mockResolvedValue(null);
    await expect(getEffectiveRegionTags("ghost")).resolves.toEqual([]);
  });

  it("includes live group-derived regions", async () => {
    stubbed(p.user.findUnique).mockResolvedValue(user({ ssoGroups: ["g"], authProvider: "saml" }));
    groups.resolveGroupsToAccess.mockResolvedValue({ regionTags: ["East"], otherTags: [] });
    await expect(getEffectiveRegionTags("u1")).resolves.toEqual(["East"]);
  });
});

describe("getEffectiveTagScopes", () => {
  it("returns both effective dimensions", async () => {
    stubbed(p.user.findUnique).mockResolvedValue(user({ regionTags: ["South"], otherTags: ["pci"], ssoGroups: ["g"], authProvider: "oidc" }));
    groups.resolveGroupsToAccess.mockResolvedValue({ regionTags: ["East"], otherTags: ["lab"] });
    await expect(getEffectiveTagScopes("u1")).resolves.toEqual({ regions: ["East", "South"], tags: ["lab", "pci"] });
  });

  it("an unknown user has no scope of either kind", async () => {
    stubbed(p.user.findUnique).mockResolvedValue(null);
    await expect(getEffectiveTagScopes("ghost")).resolves.toEqual({ regions: [], tags: [] });
  });
});

describe("renameRegionInPrincipalScopes", () => {
  it.each([
    ["", "New"],
    ["Old", ""],
    ["  ", "New"],
    ["Same", "same"],
    ["Same", " SAME "],
  ])("is a no-op with no reads for (%j → %j)", async (from, to) => {
    await expect(renameRegionInPrincipalScopes(from, to)).resolves.toEqual({ users: [], groupMappings: [], total: 0 });
    expect(p.user.findMany).not.toHaveBeenCalled();
    expect(p.groupMapping.findMany).not.toHaveBeenCalled();
  });

  it("tolerates null/undefined names as a no-op", async () => {
    await expect(renameRegionInPrincipalScopes(null as unknown as string, "x")).resolves.toMatchObject({ total: 0 });
    await expect(renameRegionInPrincipalScopes("x", undefined as unknown as string)).resolves.toMatchObject({ total: 0 });
  });

  it("rewrites only the rows that carry the old name, in one transaction, and names them", async () => {
    stubbed(p.user.findMany).mockResolvedValue([
      { id: "u1", username: "alice", regionTags: ["Old-Site", "South"] },
      { id: "u2", username: "bob", regionTags: ["South"] },
      { id: "u3", username: "carol", regionTags: ["old-site"] },
    ]);
    stubbed(p.groupMapping.findMany).mockResolvedValue([
      { id: "g1", provider: "saml", groupKey: "net-ops", regionTags: ["OLD-SITE"] },
      { id: "g2", provider: "ldap", groupKey: "it", regionTags: [] },
    ]);
    stubbed(p.user.update).mockImplementation((a: unknown) => ({ op: "user", a }));
    stubbed(p.groupMapping.update).mockImplementation((a: unknown) => ({ op: "gm", a }));

    const moves = await renameRegionInPrincipalScopes(" Old-Site ", " New-Site ");
    expect(moves).toEqual({ users: ["alice", "carol"], groupMappings: ["saml:net-ops"], total: 3 });
    expect(p.user.findMany).toHaveBeenCalledWith({ select: { id: true, username: true, regionTags: true } });
    expect(p.groupMapping.findMany).toHaveBeenCalledWith({ select: { id: true, provider: true, groupKey: true, regionTags: true } });
    expect(p.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { regionTags: ["New-Site", "South"] } });
    expect(p.user.update).toHaveBeenCalledWith({ where: { id: "u3" }, data: { regionTags: ["New-Site"] } });
    expect(p.groupMapping.update).toHaveBeenCalledWith({ where: { id: "g1" }, data: { regionTags: ["New-Site"] } });
    expect(p.$transaction).toHaveBeenCalledTimes(1);
    expect(stubbed(p.$transaction).mock.calls[0]![0]).toHaveLength(3);
  });

  it("a rename onto a name the principal already holds dedupes instead of growing the list", async () => {
    stubbed(p.user.findMany).mockResolvedValue([{ id: "u1", username: "alice", regionTags: ["Old", "new"] }]);
    await renameRegionInPrincipalScopes("Old", "New");
    expect(p.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { regionTags: ["New"] } });
  });

  it("nothing to move: no transaction", async () => {
    stubbed(p.user.findMany).mockResolvedValue([{ id: "u1", username: "alice", regionTags: ["South"] }]);
    await expect(renameRegionInPrincipalScopes("Old", "New")).resolves.toEqual({ users: [], groupMappings: [], total: 0 });
    expect(p.$transaction).not.toHaveBeenCalled();
  });

  it("propagates a failed transaction (the route must not log a rename that did not land)", async () => {
    stubbed(p.user.findMany).mockResolvedValue([{ id: "u1", username: "alice", regionTags: ["Old"] }]);
    stubbed(p.$transaction).mockRejectedValue(new Error("serialization"));
    await expect(renameRegionInPrincipalScopes("Old", "New")).rejects.toThrow("serialization");
  });
});

describe("principalsScopedToRegion", () => {
  it("names users and mappings holding the region, case- and whitespace-blind, and writes nothing", async () => {
    stubbed(p.user.findMany).mockResolvedValue([
      { username: "alice", regionTags: ["South", " old-site "] },
      { username: "bob", regionTags: ["South"] },
      { username: "dave", regionTags: null },
    ]);
    stubbed(p.groupMapping.findMany).mockResolvedValue([
      { provider: "oidc", groupKey: "ops", regionTags: ["OLD-SITE"] },
      { provider: "ldap", groupKey: "it", regionTags: null },
    ]);
    await expect(principalsScopedToRegion(" Old-Site ")).resolves.toEqual({
      users: ["alice"],
      groupMappings: ["oidc:ops"],
      total: 2,
    });
    expect(p.user.update).not.toHaveBeenCalled();
    expect(p.groupMapping.update).not.toHaveBeenCalled();
    expect(p.$transaction).not.toHaveBeenCalled();
  });

  it("a blank name reports nobody without reading", async () => {
    await expect(principalsScopedToRegion("  ")).resolves.toEqual({ users: [], groupMappings: [], total: 0 });
    await expect(principalsScopedToRegion(null as unknown as string)).resolves.toMatchObject({ total: 0 });
    expect(p.user.findMany).not.toHaveBeenCalled();
  });

  it("nobody holding it is an empty report", async () => {
    await expect(principalsScopedToRegion("Nowhere")).resolves.toEqual({ users: [], groupMappings: [], total: 0 });
  });
});
