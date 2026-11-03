/**
 * tests/unit/savedOwnershipService.test.ts — the pure half of business rule
 * 140: who owns, sees, manages and may take a saved folder / filter /
 * dashboard, the list predicate that mirrors it in SQL, and the folder-tree
 * helpers a delete re-parents with.
 */

import { describe, it, expect } from "vitest";
import {
  canManage,
  canSee,
  canTake,
  descendantFolderIds,
  isOwner,
  ownerKindOf,
  ownerLabel,
  ownershipDto,
  survivingAncestor,
  visibleWhere,
  type OwnedRow,
  type SavedViewer,
} from "../../src/services/savedOwnershipService.js";

const row = (o: Partial<OwnedRow>): OwnedRow => ({
  ownerId: null,
  ownerRoleId: null,
  ownerRegion: null,
  ownerName: "x",
  visibility: "private",
  ...o,
});

const viewer = (o: Partial<SavedViewer> = {}): SavedViewer => ({
  id: "u1",
  username: "alice",
  roleId: "r1",
  regions: [],
  write: false,
  fullwrite: false,
  ...o,
});

describe("ownerKindOf / ownerLabel", () => {
  it("names each kind, and none for an ownerless row", () => {
    expect(ownerKindOf(row({ ownerId: "u" }))).toBe("user");
    expect(ownerKindOf(row({ ownerRoleId: "r" }))).toBe("role");
    expect(ownerKindOf(row({ ownerRegion: "West" }))).toBe("region");
    expect(ownerKindOf(row({}))).toBe("none");
    expect(ownerLabel(row({ ownerRoleId: "r", ownerName: "stale", ownerRole: { name: "NOC" } }))).toBe("role NOC");
    expect(ownerLabel(row({}))).toBe("no one");
  });
});

describe("isOwner", () => {
  it("matches the user, a holder of the role, and a user scoped to the region", () => {
    expect(isOwner(row({ ownerId: "u1" }), viewer())).toBe(true);
    expect(isOwner(row({ ownerId: "u2" }), viewer())).toBe(false);
    expect(isOwner(row({ ownerRoleId: "r1" }), viewer())).toBe(true);
    expect(isOwner(row({ ownerRegion: "Middle TN" }), viewer({ regions: ["middle tn"] }))).toBe(true);
  });

  it("does not make an UNRESTRICTED user a region owner", () => {
    expect(isOwner(row({ ownerRegion: "Middle TN" }), viewer({ regions: [] }))).toBe(false);
  });

  it("makes nobody the owner of an ownerless row, and the wallboard owner of nothing", () => {
    expect(isOwner(row({}), viewer({ fullwrite: true }))).toBe(false);
    expect(isOwner(row({ ownerId: "u1" }), null)).toBe(false);
  });
});

describe("canSee / canManage / canTake", () => {
  it("shows public rows to everyone, the wallboard included", () => {
    expect(canSee(row({ visibility: "public", ownerId: "u2" }), null)).toBe(true);
    expect(canSee(row({ ownerId: "u2" }), viewer())).toBe(false);
  });

  it("gives an ownerless row to fullwrite only — to see when private, and to manage", () => {
    const orphan = row({});
    expect(canSee(orphan, viewer())).toBe(false);
    expect(canSee(orphan, viewer({ fullwrite: true }))).toBe(true);
    expect(canManage(orphan, viewer())).toBe(false);
    expect(canManage(orphan, viewer({ fullwrite: true }))).toBe(true);
  });

  it("never lets fullwrite manage someone's OWNED row, public or not", () => {
    const theirs = row({ ownerId: "u2", visibility: "public" });
    expect(canManage(theirs, viewer({ fullwrite: true }))).toBe(false);
  });

  it("lets the owner or a fullwrite holder take any row", () => {
    const theirs = row({ ownerId: "u2", visibility: "public" });
    expect(canTake(theirs, viewer())).toBe(false);
    expect(canTake(theirs, viewer({ fullwrite: true }))).toBe(true);
    expect(canTake(row({ ownerRoleId: "r1" }), viewer())).toBe(true);
    expect(canTake(theirs, null)).toBe(false);
  });

  it("reports all of it in the DTO", () => {
    const dto = ownershipDto(row({ ownerRoleId: "r1", ownerRole: { name: "NOC" } }), viewer());
    expect(dto).toMatchObject({ ownerKind: "role", ownerName: "NOC", isOwner: true, canManage: true, canTake: true });
  });
});

describe("visibleWhere", () => {
  it("is public-only for the wallboard", () => {
    expect(visibleWhere(null)).toEqual({ visibility: "public" });
  });

  it("adds the user, role, each region and — at fullwrite — ownerless rows", () => {
    const w = visibleWhere(viewer({ regions: ["west"], fullwrite: true })) as { OR: unknown[] };
    expect(w.OR).toEqual([
      { visibility: "public" },
      { ownerId: "u1" },
      { ownerRoleId: "r1" },
      { ownerRegion: { equals: "west", mode: "insensitive" } },
      { ownerId: null, ownerRoleId: null, ownerRegion: null },
    ]);
  });
});

describe("folder tree helpers", () => {
  const parentOf = new Map<string, string | null>([
    ["top", null],
    ["mid", "top"],
    ["leaf", "mid"],
    ["other", "top"],
  ]);
  const childrenOf = new Map<string, string[]>([
    ["top", ["mid", "other"]],
    ["mid", ["leaf"]],
  ]);

  it("re-parents to the nearest ancestor that survives", () => {
    expect(survivingAncestor("leaf", parentOf, new Set(["leaf", "mid"]))).toBe("top");
    expect(survivingAncestor("mid", parentOf, new Set(["mid"]))).toBe("top");
    expect(survivingAncestor("top", parentOf, new Set(["top"]))).toBeNull();
  });

  it("survives a corrupt cycle", () => {
    const loop = new Map<string, string | null>([["a", "b"], ["b", "a"]]);
    expect(survivingAncestor("a", loop, new Set(["a", "b"]))).toBeNull();
  });

  it("lists a subtree without its root", () => {
    expect(descendantFolderIds("top", childrenOf).sort()).toEqual(["leaf", "mid", "other"]);
    expect(descendantFolderIds("leaf", childrenOf)).toEqual([]);
  });
});
