/**
 * tests/unit/regionTree.test.ts — resolving location codes through a site's
 * region tree (business rule 153): a short code (`ra:rack1` alone) expands
 * to its full chain, a full chain that agrees is confirmed, one that
 * disagrees is a conflict shown as written, a lone floor is ambiguous, and
 * an empty tree changes nothing.
 */
import { describe, it, expect } from "vitest";
import { buildRegionIndex, resolveLocation, uniqueKeyFor, chainOf, type RegionNodeDto } from "../../src/services/regionTreeService.js";
import type { LocationCodes } from "../../src/utils/locationCodes.js";

const codes = (o: Partial<LocationCodes>): LocationCodes => ({ area: null, building: null, floor: null, room: null, rack: null, junctionBox: null, ...o });

// Mine > Shop > floor 1 > Closet > rack1 ; Mine > Office > floor 1
const nodes: RegionNodeDto[] = [
  { id: "a", kind: "area", name: "Mine", parentId: null },
  { id: "b1", kind: "building", name: "Shop", parentId: "a" },
  { id: "b2", kind: "building", name: "Office", parentId: "a" },
  { id: "f1", kind: "floor", name: "1", parentId: "b1" },
  { id: "f2", kind: "floor", name: "1", parentId: "b2" },
  { id: "r", kind: "room", name: "Closet", parentId: "f1" },
  { id: "k", kind: "rack", name: "rack1", parentId: "r" },
];
const index = buildRegionIndex(nodes);

describe("region tree resolution", () => {
  it("a floor is unique only within its parent; everything else per site", () => {
    expect(uniqueKeyFor("floor", "1", "b1")).not.toBe(uniqueKeyFor("floor", "1", "b2"));
    expect(uniqueKeyFor("room", " Closet ", null)).toBe(uniqueKeyFor("room", "closet", "ignored"));
  });

  it("expands a short code to its full chain", () => {
    expect(resolveLocation(index, codes({ rack: "rack1" }))).toEqual({
      location: codes({ area: "Mine", building: "Shop", floor: "1", room: "Closet", rack: "rack1" }),
      status: "resolved",
    });
    expect(resolveLocation(index, codes({ room: "CLOSET" })).location).toMatchObject({ building: "Shop", floor: "1", room: "Closet" });
  });

  it("keeps a deeper code the tree doesn't know yet", () => {
    const r = resolveLocation(index, codes({ rack: "rack1", junctionBox: "9" }));
    expect(r.status).toBe("resolved");
    expect(r.location).toMatchObject({ room: "Closet", rack: "rack1", junctionBox: "9" });
  });

  it("places a floor through its building, and calls a lone floor ambiguous", () => {
    expect(resolveLocation(index, codes({ building: "Office", floor: "1" })).location).toMatchObject({ area: "Mine", building: "Office", floor: "1" });
    expect(resolveLocation(index, codes({ floor: "1" }))).toEqual({ location: codes({ floor: "1" }), status: "ambiguous" });
  });

  it("confirms a full chain that agrees and flags one that doesn't, shown as written", () => {
    const full = codes({ area: "Mine", building: "Shop", floor: "1", room: "Closet" });
    expect(resolveLocation(index, full).status).toBe("resolved");
    const wrong = codes({ building: "Office", room: "Closet" });
    expect(resolveLocation(index, wrong)).toEqual({ location: wrong, status: "conflict" });
  });

  it("flags codes the tree doesn't know (shown as written), and an empty tree changes nothing", () => {
    const unknown = codes({ building: "Annex", room: "IDF" });
    expect(resolveLocation(index, unknown)).toEqual({ location: unknown, status: "unknown" });
    const any = codes({ rack: "rack1" });
    expect(resolveLocation(buildRegionIndex([]), any)).toEqual({ location: any, status: "asWritten" });
    expect(resolveLocation(index, null)).toEqual({ location: null, status: "asWritten" });
  });

  it("reads a node's chain outermost first", () => {
    expect(chainOf(index, nodes[6])).toEqual(codes({ area: "Mine", building: "Shop", floor: "1", room: "Closet", rack: "rack1" }));
  });
});
