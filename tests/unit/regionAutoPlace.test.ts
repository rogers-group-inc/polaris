/**
 * tests/unit/regionAutoPlace.test.ts — business rule 150(a): a Rack or Wall
 * view created for (or linked to) a region is filled with the devices whose
 * codes already put them in its racks or junction boxes.
 */

import { describe, it, expect } from "vitest";
import {
  autoPlaceRack,
  autoPlaceWall,
  groupRegionDevices,
  locationWithin,
  type AutoRack,
  type AutoWall,
  type PlaceableDevice,
} from "../../src/utils/regionAutoPlace.js";
import { polygonsOverlap } from "../../src/utils/wallGeometry.js";
import type { LocationCodes } from "../../src/utils/locationCodes.js";

const L = (o: Partial<LocationCodes>): LocationCodes =>
  ({ area: null, building: null, floor: null, room: null, rack: null, junctionBox: null, ...o }) as LocationCodes;
const dev = (assetId: string, loc: Partial<LocationCodes> | null): PlaceableDevice =>
  ({ assetId, name: assetId, location: loc ? L(loc) : null });

const RACK_OPTS = { maxRacks: 50, maxPlacements: 2000, defaultUnits: 42, maxNameLen: 60 };
const WALL_OPTS = { maxWalls: 20, maxPlacements: 1000, defaultWidth: 96, defaultHeight: 48, maxNameLen: 60 };
const freshRack = (): AutoRack[] => [{ id: "r1", name: "Rack 1", units: 42, order: 0, face: "front" }];
const freshWall = (): AutoWall[] => [{ id: "w1", name: "Wall 1", width: 96, height: 48, order: 0 }];

const devices = [
  dev("sw2", { building: "Plant", room: "MDF", rack: "R1" }),
  dev("sw1", { building: "Plant", room: "MDF", rack: "r1 " }),
  dev("sw3", { building: "Plant", room: "MDF", rack: "R2" }),
  dev("ap1", { building: "Plant", room: "MDF" }),
  dev("plc", { building: "Plant", room: "MDF", junctionBox: "JB-3" }),
  dev("plc2", { building: "Plant", room: "Scale", junctionBox: "JB-9" }),
  dev("far", { building: "Office", room: "MDF", rack: "R1" }),
  dev("none", null),
];

describe("locationWithin", () => {
  it("matches every code the region sets, case- and spacing-blind", () => {
    expect(locationWithin(L({ room: "mdf" }), L({ building: "Plant", room: "MDF " }))).toBe(true);
    expect(locationWithin(L({ building: "Plant", room: "MDF" }), L({ building: "Office", room: "MDF" }))).toBe(false);
    expect(locationWithin(L({}), L({ room: "MDF" }))).toBe(false);
    expect(locationWithin(L({ room: "MDF" }), null)).toBe(false);
  });
});

describe("groupRegionDevices", () => {
  it("groups by the rack's full chain, in name order", () => {
    const g = groupRegionDevices(L({ building: "Plant", room: "MDF" }), devices, "rack");
    expect(g.map((x) => [x.name, x.devices.map((d) => d.assetId)])).toEqual([
      ["R1", ["sw1", "sw2"]],
      ["R2", ["sw3"]],
    ]);
  });

  it("a short code joins the one rack of its name it doesn't contradict", () => {
    const g = groupRegionDevices(L({ room: "MDF" }), [
      dev("full", { building: "Plant", room: "MDF", rack: "R1" }),
      dev("short", { room: "MDF", rack: "R1" }),
    ], "rack");
    expect(g.map((x) => [x.name, x.devices.map((d) => d.assetId)])).toEqual([["R1", ["full", "short"]]]);
  });

  it("a short code two racks of its name could own stays apart", () => {
    const g = groupRegionDevices(L({ rack: "R1" }), [...devices, dev("bare", { rack: "R1" })], "rack");
    expect(g).toHaveLength(3);
    expect(g.find((x) => x.devices.some((d) => d.assetId === "bare"))!.devices).toHaveLength(1);
  });

  it("names two racks of one name by where each is", () => {
    const g = groupRegionDevices(L({ rack: "R1" }), devices, "rack");
    expect(g.map((x) => x.name).sort()).toEqual(["R1 · Office / MDF", "R1 · Plant / MDF"]);
  });
});

describe("autoPlaceRack", () => {
  it("fills a fresh view: the placeholder rack takes the first rack's name, a new rack the next", () => {
    const r = autoPlaceRack(L({ building: "Plant", room: "MDF" }), freshRack(), [], devices, RACK_OPTS);
    expect(r.containers.map((c) => c.name)).toEqual(["R1", "R2"]);
    expect(r.placed).toEqual(["sw1", "sw2", "sw3"]);
    expect(r.unplaced).toEqual([]);
    const byAsset = Object.fromEntries(r.placements.map((p) => [p.assetId, p]));
    expect(byAsset.sw1).toMatchObject({ rackId: "r1", face: "front", startU: 1, heightU: 1, fullDepth: false, kind: "asset" });
    expect(byAsset.sw2).toMatchObject({ rackId: "r1", startU: 2 });
    expect(byAsset.sw3.rackId).toBe(r.containers[1].id);
  });

  it("never moves what is already racked, and skips a device already placed", () => {
    const existing = [{ id: "x", kind: "asset" as const, assetId: "sw1", label: null, rackId: "r1", face: "front" as const, startU: 1, heightU: 2, fullDepth: true }];
    const racks: AutoRack[] = [{ id: "r1", name: "R1", units: 42, order: 0, face: "front" }];
    const r = autoPlaceRack(L({ building: "Plant", rack: "R1", room: "MDF" }), racks, existing, devices, RACK_OPTS);
    expect(r.placements[0]).toEqual(existing[0]);
    expect(r.placed).toEqual(["sw2"]);
    expect(r.placements.find((p) => p.assetId === "sw2")).toMatchObject({ rackId: "r1", startU: 3 });
  });

  it("uses the rear once the front is full, then reports what didn't fit", () => {
    const racks: AutoRack[] = [{ id: "r1", name: "Rack 1", units: 1, order: 0, face: "front" }];
    const many = ["a", "b", "c"].map((id) => dev(id, { rack: "Tiny" }));
    const r = autoPlaceRack(L({ rack: "Tiny" }), racks, [], many, RACK_OPTS);
    expect(r.placements.map((p) => [p.assetId, p.face, p.startU])).toEqual([["a", "front", 1], ["b", "rear", 1]]);
    expect(r.unplaced).toEqual(["c"]);
  });

  it("does nothing for a region no device is in", () => {
    const r = autoPlaceRack(L({ room: "Nowhere" }), freshRack(), [], devices, RACK_OPTS);
    expect(r.placed).toEqual([]);
    expect(r.containers).toEqual(freshRack());
  });
});

describe("autoPlaceWall", () => {
  it("mounts a junction box's devices on the placeholder wall, renamed for it", () => {
    const r = autoPlaceWall(L({ junctionBox: "JB-3" }), freshWall(), [], devices, WALL_OPTS);
    expect(r.containers.map((w) => w.name)).toEqual(["JB-3"]);
    expect(r.placed).toEqual(["plc"]);
    expect(r.placements[0]).toMatchObject({ wallId: "w1", kind: "asset", assetId: "plc", points: [[1, 1], [13, 1], [13, 9], [1, 9]] });
  });

  it("a wall named after its view counts as a placeholder; one wall per junction box", () => {
    const walls: AutoWall[] = [{ id: "w1", name: "Plant", width: 96, height: 48, order: 0 }];
    const r = autoPlaceWall(L({ building: "Plant" }), walls, [], devices, { ...WALL_OPTS, viewName: "Plant" });
    expect(r.containers.map((w) => w.name)).toEqual(["JB-3", "JB-9"]);
    expect(r.placed.sort()).toEqual(["plc", "plc2"]);
  });

  it("finds room around what is already mounted", () => {
    const existing = [{ id: "c", kind: "cableManagement" as const, assetId: null, label: null, wallId: "w1",
      points: [[0, 0], [20, 0], [20, 20], [0, 20]] as Array<[number, number]>, units: null, linkedViewId: null }];
    const many = Array.from({ length: 5 }, (_, i) => dev(`d${i}`, { junctionBox: "JB-3" }));
    // The wall already holds an item, so only its name claims it for the box.
    const walls: AutoWall[] = [{ id: "w1", name: "jb-3", width: 96, height: 48, order: 0 }];
    const r = autoPlaceWall(L({ junctionBox: "JB-3" }), walls, existing, many, WALL_OPTS);
    expect(r.containers).toHaveLength(1);
    expect(r.placed).toHaveLength(5);
    const mine = r.placements.filter((p) => p.assetId);
    for (const p of mine) expect(polygonsOverlap(p.points, existing[0].points)).toBe(false);
    for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) expect(polygonsOverlap(mine[i].points, mine[j].points)).toBe(false);
  });

  it("a placeholder wall already holding something is left alone: the box gets its own wall", () => {
    const existing = [{ id: "c", kind: "cableManagement" as const, assetId: null, label: null, wallId: "w1",
      points: [[0, 0], [3, 0], [3, 24], [0, 24]] as Array<[number, number]>, units: null, linkedViewId: null }];
    const r = autoPlaceWall(L({ junctionBox: "JB-3" }), freshWall(), existing, devices, WALL_OPTS);
    expect(r.containers.map((w) => w.name)).toEqual(["Wall 1", "JB-3"]);
    expect(r.placements.find((p) => p.assetId === "plc")!.wallId).toBe(r.containers[1].id);
  });

  it("reports devices a full wall can't take", () => {
    const walls: AutoWall[] = [{ id: "w1", name: "Wall 1", width: 14, height: 10, order: 0 }];
    const r = autoPlaceWall(L({ junctionBox: "JB-3" }), walls, [], [dev("a", { junctionBox: "JB-3" }), dev("b", { junctionBox: "JB-3" })], WALL_OPTS);
    expect(r.placed).toEqual(["a"]);
    expect(r.unplaced).toEqual(["b"]);
  });
});
