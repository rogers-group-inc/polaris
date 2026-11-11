/**
 * tests/unit/regionTree.test.ts — resolving location codes through a site's
 * region tree (business rule 153): a short code (`ra:rack1` alone) expands
 * to its full chain, a full chain that agrees is confirmed, one that
 * disagrees is a conflict shown as written, a lone floor is ambiguous, and
 * an empty tree changes nothing.
 */
import { describe, it, expect } from "vitest";
import {
  buildRegionIndex, resolveLocation, uniqueKeyFor, chainOf,
  remapLocationCodes, remapLocationKey, remapLayoutViewKey, remapPositionKeys, rewritesFor,
  type RegionNodeDto,
} from "../../src/services/regionTreeService.js";
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

// A tree edit carried into Polaris's own stored chains, and the descriptions offered.
describe("carrying a tree edit", () => {
  const before = codes({ area: "Mine", building: "Shop", floor: "1", room: "Closet" });
  const renamed = codes({ area: "Mine", building: "Shop", floor: "1", room: "IDF-2" });

  it("moves a stored chain at or under the region, keeping deeper levels", () => {
    expect(remapLocationCodes(codes({ room: "closet", rack: "rack1" }), "room", before, renamed))
      .toEqual(codes({ area: "Mine", building: "Shop", floor: "1", room: "IDF-2", rack: "rack1" }));
    expect(remapLocationCodes(codes({ building: "Office", room: "Closet" }), "room", before, renamed)).toBeNull();
    expect(remapLocationCodes(codes({ building: "Shop" }), "room", before, renamed)).toBeNull();
    expect(remapLocationCodes(null, "room", before, renamed)).toBeNull();
  });

  it("re-keys layout keys at and under the region, in the map's key grammar", () => {
    expect(remapLocationKey("r|mine|shop|1|closet", "room", before, renamed)).toBe("r|mine|shop|1|idf-2");
    expect(remapLocationKey("jb|mine|shop|1|closet|7", "room", before, renamed)).toBe("jb|mine|shop|1|idf-2|7");
    expect(remapLocationKey("ra|mine|shop|1|closet|rack1", "room", before, renamed)).toBe("ra|mine|shop|1|idf-2|rack1");
    // Above the region, or elsewhere: untouched.
    expect(remapLocationKey("f|mine|shop|1", "room", before, renamed)).toBeNull();
    expect(remapLocationKey("r|mine|office|1|closet", "room", before, renamed)).toBeNull();
    // A value holding "|" doesn't round-trip, so it is left alone.
    expect(remapLocationKey("r|mine|shop|1|clo|set", "room", before, renamed)).toBeNull();
  });

  it("re-keys a junction box into a rack with the extra segment", () => {
    const jbBefore = codes({ area: "Mine", building: "Shop", floor: "1", room: "Closet", junctionBox: "7" });
    const jbAfter = codes({ area: "Mine", building: "Shop", floor: "1", room: "Closet", rack: "rack1", junctionBox: "7" });
    expect(remapLocationKey("jb|mine|shop|1|closet|7", "junctionBox", jbBefore, jbAfter)).toBe("jb|mine|shop|1|closet|rack1|7");
  });

  it("keeps a saved view's id prefix, and never overwrites a box saved under the new key", () => {
    const id = "v:0b9e3c55-7a2b-4d55-9a3e-2b1c0d9e8f70|";
    expect(remapLayoutViewKey(id + "r|mine|shop|1|closet", "room", before, renamed)).toBe(id + "r|mine|shop|1|idf-2");
    expect(remapLayoutViewKey("flat", "room", before, renamed)).toBeNull();
    const pos = { "sw-1": { x: 1, y: 2 }, "locgroup:r|mine|shop|1|closet": { x: 5, y: 6 } };
    expect(remapPositionKeys(pos, "room", before, renamed)).toEqual({ "sw-1": { x: 1, y: 2 }, "locgroup:r|mine|shop|1|idf-2": { x: 5, y: 6 } });
    const both = { ...pos, "locgroup:r|mine|shop|1|idf-2": { x: 9, y: 9 } };
    expect(remapPositionKeys(both, "room", before, renamed)).toBeNull();
  });

  it("offers a description rewrite only where it WROTE the old place, short codes staying short", () => {
    const devices = [
      { assetId: "1", name: "full", written: codes({ building: "Shop", floor: "1", room: "Closet" }) },
      { assetId: "2", name: "short", written: codes({ room: "Closet" }) },
      { assetId: "3", name: "other", written: codes({ room: "Lobby" }) },
    ];
    const moved = codes({ area: "Mine", building: "Office", floor: "1", room: "Closet" });
    expect(rewritesFor("room", before, moved, devices)).toEqual([
      { assetId: "1", name: "full", from: devices[0].written, codes: codes({ building: "Office", floor: "1", room: "Closet" }) },
    ]);
    const r = rewritesFor("room", before, renamed, devices);
    expect(r.map((x) => [x.name, x.codes.room])).toEqual([["full", "IDF-2"], ["short", "IDF-2"]]);
  });
});
