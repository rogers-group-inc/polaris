/**
 * tests/unit/regionScopeRename.test.ts — a region rename carries the principal
 * scope columns; a region delete reports instead of stripping them.
 *
 * `User.regionTags` / `GroupMapping.regionTags` hold BARE
 * region names and are deliberately not FK'd to a registry, so the name is the
 * only thing tying an assignment to the region it means. mapRegionService
 * rewrote asset tags, subnet tags and the `Tag` registry on a rename and left
 * these three alone — which revoked every scoped operator's region in silence:
 * the tag stayed in the column, matched no region, and the Users page filed it
 * under "Unknown region tags (no longer in the map)". Nothing failed, nothing
 * was logged, and region-scoped alert routing simply reached nobody.
 *
 * The delete half is the opposite decision on purpose — there is nothing to
 * rewrite the assignment TO, and a region redrawn under the same name is
 * routine, so the assignment survives and the Event names who is holding it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renameTagInList } from "../../src/utils/tagNormalize.js";

interface UserRow { id: string; username: string; regionTags: string[] }
interface MapRow { id: string; provider: string; groupKey: string; regionTags: string[] }

const store: { users: UserRow[]; mappings: MapRow[] } = {
  users: [],
  mappings: [],
};

/** Updates are collected as thunks and only applied by $transaction, so a test
 *  can also assert that NOTHING was written. */
let pending: Array<() => void> = [];

vi.mock("../../src/db.js", () => ({
  prisma: {
    user: {
      findMany: vi.fn(async () => store.users.map((r) => ({ ...r }))),
      update: vi.fn((args: any) => {
        const fn = () => {
          const row = store.users.find((r) => r.id === args.where.id);
          if (row) row.regionTags = args.data.regionTags;
        };
        pending.push(fn);
        return fn as any;
      }),
    },
    role: {
      findMany: vi.fn(async () => store.roles.map((r) => ({ ...r }))),
      update: vi.fn((args: any) => {
        const fn = () => {
          const row = store.roles.find((r) => r.id === args.where.id);
          if (row) row.regionTags = args.data.regionTags;
        };
        pending.push(fn);
        return fn as any;
      }),
    },
    groupMapping: {
      findMany: vi.fn(async () => store.mappings.map((r) => ({ ...r }))),
      update: vi.fn((args: any) => {
        const fn = () => {
          const row = store.mappings.find((r) => r.id === args.where.id);
          if (row) row.regionTags = args.data.regionTags;
        };
        pending.push(fn);
        return fn as any;
      }),
    },
    $transaction: vi.fn(async (ops: Array<() => void>) => {
      ops.forEach((op) => op());
      return ops.map(() => null);
    }),
  },
}));

const { renameRegionInPrincipalScopes, principalsScopedToRegion } = await import(
  "../../src/services/regionScopeService.js"
);

beforeEach(() => {
  pending = [];
  store.users = [
    { id: "u1", username: "tech-se", regionTags: ["Southeast"] },
    { id: "u2", username: "tech-mw", regionTags: ["Midwest"] },
    // Case differs from the region's stored name. Every matcher on both sides of
    // the wire compares case-insensitively, so this is a LIVE assignment and has
    // to move with the rename.
    { id: "u3", username: "tech-lower", regionTags: ["southeast", "Midwest"] },
    { id: "u4", username: "unscoped", regionTags: [] },
  ];
  store.mappings = [
    { id: "g1", provider: "oidc", groupKey: "SE-Ops", regionTags: ["Southeast"] },
    { id: "g2", provider: "ldap", groupKey: "MW-Ops", regionTags: ["Midwest"] },
  ];
});

describe("renameTagInList (pure)", () => {
  it("returns null when the list does not carry the old name", () => {
    expect(renameTagInList(["Midwest"], "Southeast", "SE Division")).toBeNull();
    expect(renameTagInList([], "Southeast", "SE Division")).toBeNull();
    expect(renameTagInList(null, "Southeast", "SE Division")).toBeNull();
  });

  it("matches case-insensitively and keeps position", () => {
    expect(renameTagInList(["Alpha", "southeast", "Zulu"], "Southeast", "SE Division")).toEqual([
      "Alpha",
      "SE Division",
      "Zulu",
    ]);
  });

  it("cannot grow the list when the principal already holds the new name", () => {
    // Otherwise a rename onto an existing tag leaves a duplicate that the
    // picker renders twice and every union recomputes forever.
    expect(renameTagInList(["SE Division", "Southeast"], "Southeast", "SE Division")).toEqual([
      "SE Division",
    ]);
  });

  it("refuses a blank on either side rather than writing an empty tag", () => {
    expect(renameTagInList(["Southeast"], "", "SE Division")).toBeNull();
    expect(renameTagInList(["Southeast"], "Southeast", "   ")).toBeNull();
  });
});

describe("renameRegionInPrincipalScopes", () => {
  it("rewrites users and group mappings that name the region", async () => {
    const moves = await renameRegionInPrincipalScopes("Southeast", "SE Division");
    expect(moves.users).toEqual(["tech-se", "tech-lower"]);
    expect(moves.groupMappings).toEqual(["oidc:SE-Ops"]);
    expect(moves.total).toBe(3);

    expect(store.users.find((u) => u.id === "u1")!.regionTags).toEqual(["SE Division"]);
    expect(store.users.find((u) => u.id === "u3")!.regionTags).toEqual(["SE Division", "Midwest"]);
    expect(store.mappings.find((m) => m.id === "g1")!.regionTags).toEqual(["SE Division"]);
  });

  it("leaves every principal that names a different region untouched", async () => {
    await renameRegionInPrincipalScopes("Southeast", "SE Division");
    expect(store.users.find((u) => u.id === "u2")!.regionTags).toEqual(["Midwest"]);
    expect(store.users.find((u) => u.id === "u4")!.regionTags).toEqual([]);
    expect(store.mappings.find((m) => m.id === "g2")!.regionTags).toEqual(["Midwest"]);
  });

  it("writes nothing when no principal is scoped to the region", async () => {
    const moves = await renameRegionInPrincipalScopes("Northwest", "NW Division");
    expect(moves.total).toBe(0);
    expect(pending).toHaveLength(0);
  });

  it("is a no-op for a case-only rename", async () => {
    // updateRegion treats it as no rename at all (`renamed` compares
    // lower-cased), so the scope columns must not churn either.
    const moves = await renameRegionInPrincipalScopes("Southeast", "SOUTHEAST");
    expect(moves.total).toBe(0);
    expect(pending).toHaveLength(0);
  });
});

describe("principalsScopedToRegion", () => {
  it("names every principal holding the region, case-insensitively", async () => {
    const held = await principalsScopedToRegion("southeast");
    expect(held.users).toEqual(["tech-se", "tech-lower"]);
    expect(held.groupMappings).toEqual(["oidc:SE-Ops"]);
    expect(held.total).toBe(3);
  });

  it("reports without stripping — the assignment survives the delete", async () => {
    await principalsScopedToRegion("Southeast");
    expect(pending).toHaveLength(0);
    expect(store.users.find((u) => u.id === "u1")!.regionTags).toEqual(["Southeast"]);
  });

  it("answers empty for a name nobody is scoped to", async () => {
    expect((await principalsScopedToRegion("Northwest")).total).toBe(0);
    expect((await principalsScopedToRegion("  ")).total).toBe(0);
  });
});
