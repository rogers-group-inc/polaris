/**
 * tests/unit/topologyViewService.test.ts
 *
 * Pure validators of saved topology views (business rules 147-149): names,
 * modes, shown types, backgrounds, polygons, racks and rack placements
 * (bounds + overlap + full / half depth), and the location-code commit body.
 * The DB-touching functions are covered by tests/integration/topologyViews.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  sanitizeViewName,
  sanitizeMode,
  sanitizeShownTypes,
  sanitizeBackground,
  sanitizePolygons,
  sanitizeRacks,
  sanitizeRackPlacements,
  sanitizeLocationCodeChanges,
  sanitizeWalls,
  sanitizeWallPlacements,
  sanitizeLayers,
  sanitizeRegion,
  sanitizeCableRoutes,
  MAX_RACK_UNITS,
  MAX_VIEW_NAME_LEN,
  type TopologyRack,
} from "../../src/services/topologyViewService.js";

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";

function status(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { httpStatus?: number }).httpStatus;
  }
  return undefined;
}

describe("view name / mode / shown types", () => {
  it("normalises names and rejects empty or oversize ones", () => {
    expect(sanitizeViewName("  Plant   floor ")).toBe("Plant floor");
    expect(status(() => sanitizeViewName("   "))).toBe(400);
    expect(status(() => sanitizeViewName("x".repeat(MAX_VIEW_NAME_LEN + 1)))).toBe(400);
  });

  it("accepts the three modes only (Rack and Wall became Room, rule 156)", () => {
    expect(sanitizeMode("room")).toBe("room");
    expect(status(() => sanitizeMode("rack"))).toBe(400);
    expect(status(() => sanitizeMode("wall"))).toBe(400);
    expect(status(() => sanitizeMode("map"))).toBe(400);
  });

  it("always keeps firewall shown and de-duplicates", () => {
    expect(sanitizeShownTypes(["switch", "switch", "server"])).toEqual(["firewall", "switch", "server"]);
    expect(sanitizeShownTypes([])).toEqual(["firewall"]);
    expect(status(() => sanitizeShownTypes(["bad type!"]))).toBe(400);
  });
});

describe("sanitizeBackground", () => {
  it("accepts OSM centre + zoom and an image id; null clears", () => {
    expect(sanitizeBackground({ kind: "osm", center: [36.1, -86.7], zoom: 19 })).toEqual({ kind: "osm", center: [36.1, -86.7], zoom: 19, layer: "map" });
    expect(sanitizeBackground({ kind: "osm", center: [36.1, -86.7], zoom: 19, layer: "satellite" })).toMatchObject({ layer: "satellite" });
    expect(status(() => sanitizeBackground({ kind: "osm", center: [36.1, -86.7], zoom: 19, layer: "terrain" }))).toBe(400);
    expect(sanitizeBackground({ kind: "image", imageId: A1, width: 9, height: 9 })).toEqual({ kind: "image", imageId: A1 });
    expect(sanitizeBackground(null)).toBeNull();
  });

  it("rejects out-of-range coordinates, zoom and unknown kinds", () => {
    expect(status(() => sanitizeBackground({ kind: "osm", center: [91, 0], zoom: 10 }))).toBe(400);
    expect(status(() => sanitizeBackground({ kind: "osm", center: [0, 0], zoom: 23 }))).toBe(400);
    expect(status(() => sanitizeBackground({ kind: "osm", center: [0, 0], zoom: 0 }))).toBe(400);
    expect(status(() => sanitizeBackground({ kind: "image", imageId: "x" }))).toBe(400);
    expect(status(() => sanitizeBackground({ kind: "tiles" }))).toBe(400);
  });
});

describe("sanitizePolygons", () => {
  const sq = [[0, 0], [10, 0], [10, 10]];
  it("keeps the group's codes in their display casing", () => {
    const out = sanitizePolygons([{ id: "p1", codes: { building: " Plant ", floor: "1" }, points: sq }]);
    expect(out[0].codes).toEqual({ area: null, building: "Plant", floor: "1", room: null, rack: null, junctionBox: null });
  });

  it("rejects too few points, no codes, duplicate ids and an embedded code", () => {
    expect(status(() => sanitizePolygons([{ id: "p", codes: { building: "x" }, points: [[0, 0], [1, 1]] }]))).toBe(400);
    expect(status(() => sanitizePolygons([{ id: "p", codes: {}, points: sq }]))).toBe(400);
    expect(status(() => sanitizePolygons([
      { id: "p", codes: { building: "a" }, points: sq },
      { id: "p", codes: { building: "b" }, points: sq },
    ]))).toBe(400);
    expect(status(() => sanitizePolygons([{ id: "p", codes: { building: "x f:2" }, points: sq }]))).toBe(400);
  });
});

describe("racks and rack placements", () => {
  const racks: TopologyRack[] = sanitizeRacks([
    { id: "rA", name: "Rack A", units: 42, order: 0 },
    { id: "rB", name: "Rack B", units: 24, order: 1, face: "rear" },
  ]);

  it("normalises rack order and defaults the face", () => {
    const r = sanitizeRacks([{ id: "b", name: "B", units: 10, order: 7 }, { id: "a", name: "A", units: 10, order: 2 }]);
    expect(r.map((x) => [x.id, x.order, x.face])).toEqual([["a", 0, "front"], ["b", 1, "front"]]);
    expect(status(() => sanitizeRacks([{ id: "a", name: "A", units: MAX_RACK_UNITS + 1 }]))).toBe(400);
  });

  it("accepts devices and cable management that fit and do not overlap", () => {
    const out = sanitizeRackPlacements([
      { id: "p1", kind: "asset", assetId: A1, rackId: "rA", face: "front", startU: 41, heightU: 2 },
      { id: "cm1", kind: "cableManagement", rackId: "rA", face: "front", startU: 40, heightU: 1 },
    ], racks);
    expect(out[0].fullDepth).toBe(false); // half depth unless marked full
    expect(out[1]).toMatchObject({ assetId: null, fullDepth: false });
  });

  it("keeps a third-party box's name, defaults it, and refuses a bad one", () => {
    const out = sanitizeRackPlacements([
      { id: "tp1", kind: "thirdParty", label: "  ISP   router ", rackId: "rA", face: "front", startU: 30, heightU: 2 },
      { id: "tp2", kind: "thirdParty", rackId: "rA", face: "front", startU: 20, heightU: 1, assetId: A1 },
      { id: "p1", kind: "asset", assetId: A2, label: "ignored", rackId: "rA", face: "front", startU: 10, heightU: 1 },
    ], racks);
    expect(out[0]).toMatchObject({ kind: "thirdParty", label: "ISP router", assetId: null, fullDepth: false });
    expect(out[1]).toMatchObject({ label: "Third party", assetId: null }); // no name → the default, never an asset
    expect(out[2].label).toBeNull();
    expect(status(() => sanitizeRackPlacements([{ id: "t", kind: "thirdParty", label: "x".repeat(65), rackId: "rA", face: "front", startU: 1, heightU: 1 }], racks))).toBe(400);
    expect(status(() => sanitizeRackPlacements([{ id: "t", kind: "thirdParty", label: "a\u0007b", rackId: "rA", face: "front", startU: 1, heightU: 1 }], racks))).toBe(400);
    expect(status(() => sanitizeRackPlacements([{ id: "t", kind: "shelf", rackId: "rA", face: "front", startU: 1, heightU: 1 }], racks))).toBe(400);
  });

  it("rejects a placement past the top of the rack or in an unknown rack", () => {
    expect(status(() => sanitizeRackPlacements([{ id: "p", kind: "asset", assetId: A1, rackId: "rB", face: "front", startU: 24, heightU: 2 }], racks))).toBe(400);
    expect(status(() => sanitizeRackPlacements([{ id: "p", kind: "asset", assetId: A1, rackId: "nope", face: "front", startU: 1, heightU: 1 }], racks))).toBe(400);
  });

  it("a front device and a rear device share a U by default", () => {
    expect(sanitizeRackPlacements([
      { id: "p1", kind: "asset", assetId: A1, rackId: "rA", face: "front", startU: 10, heightU: 1 },
      { id: "p2", kind: "asset", assetId: A2, rackId: "rA", face: "rear", startU: 10, heightU: 1 },
    ], racks)).toHaveLength(2);
  });

  it("a full-depth device blocks the rear; two half-depth items share a U", () => {
    expect(status(() => sanitizeRackPlacements([
      { id: "p1", kind: "asset", assetId: A1, rackId: "rA", face: "front", startU: 10, heightU: 2, fullDepth: true },
      { id: "p2", kind: "asset", assetId: A2, rackId: "rA", face: "rear", startU: 11, heightU: 1, fullDepth: false },
    ], racks))).toBe(400);
    expect(sanitizeRackPlacements([
      { id: "p1", kind: "asset", assetId: A1, rackId: "rA", face: "front", startU: 10, heightU: 1, fullDepth: false },
      { id: "p2", kind: "asset", assetId: A2, rackId: "rA", face: "rear", startU: 10, heightU: 1, fullDepth: false },
    ], racks)).toHaveLength(2);
  });

  it("racks a device at most once per view", () => {
    expect(status(() => sanitizeRackPlacements([
      { id: "p1", kind: "asset", assetId: A1, rackId: "rA", face: "front", startU: 1, heightU: 1 },
      { id: "p2", kind: "asset", assetId: A1, rackId: "rB", face: "front", startU: 1, heightU: 1 },
    ], racks))).toBe(400);
  });
});

describe("sanitizeLocationCodeChanges", () => {
  it("parses a valid body and rejects duplicates and codeless changes", () => {
    expect(sanitizeLocationCodeChanges([{ assetId: A1, codes: { building: "Plant" } }])[0].codes.building).toBe("Plant");
    expect(status(() => sanitizeLocationCodeChanges([]))).toBe(400);
    expect(status(() => sanitizeLocationCodeChanges([
      { assetId: A1, codes: { building: "a" } },
      { assetId: A1, codes: { building: "b" } },
    ]))).toBe(400);
    expect(status(() => sanitizeLocationCodeChanges([{ assetId: A1, codes: {} }]))).toBe(400);
  });

  it("carries the levels a placement sets (rule 148(a)), and refuses an unknown one", () => {
    expect(sanitizeLocationCodeChanges([{ assetId: A1, codes: { building: "Plant" }, levels: ["building", "building"] }])[0].levels).toEqual(["building"]);
    expect(sanitizeLocationCodeChanges([{ assetId: A1, codes: { building: "Plant" } }])[0].levels).toBeUndefined();
    expect(status(() => sanitizeLocationCodeChanges([{ assetId: A1, codes: { building: "Plant" }, levels: ["shelf"] }]))).toBe(400);
    expect(status(() => sanitizeLocationCodeChanges([{ assetId: A1, codes: { building: "Plant" }, levels: [] }]))).toBe(400);
    // Rule 168: a placement that sets a floor sets a number.
    expect(status(() => sanitizeLocationCodeChanges([{ assetId: A1, codes: { floor: "Surface" }, levels: ["floor"] }]))).toBe(400);
    expect(sanitizeLocationCodeChanges([{ assetId: A1, codes: { floor: "-1" }, levels: ["floor"] }])[0].codes.floor).toBe("-1");
  });
});

describe("wall views (rule 151)", () => {
  const walls = sanitizeWalls([{ id: "w1", name: "MDF wall", width: 96, height: 48 }]);
  const rect = (x: number, y: number, w: number, h: number) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

  it("sizes walls in whole inches within limits", () => {
    expect(walls[0]).toMatchObject({ width: 96, height: 48, order: 0 });
    expect(status(() => sanitizeWalls([{ id: "w", name: "x", width: 2, height: 48 }]))).toBe(400);
    expect(status(() => sanitizeWalls([{ id: "w", name: "x", width: 700, height: 48 }]))).toBe(400);
  });

  it("accepts items that share an edge and refuses an overlap", () => {
    expect(sanitizeWallPlacements([
      { id: "a", kind: "asset", assetId: A1, wallId: "w1", points: rect(0, 0, 12, 8) },
      { id: "b", kind: "asset", assetId: A2, wallId: "w1", points: rect(12, 0, 12, 8) },
    ], walls)).toHaveLength(2);
    expect(status(() => sanitizeWallPlacements([
      { id: "a", kind: "asset", assetId: A1, wallId: "w1", points: rect(0, 0, 12, 8) },
      { id: "b", kind: "cableManagement", wallId: "w1", points: rect(11, 7, 4, 4) },
    ], walls))).toBe(400);
  });

  it("keeps corners on the junction box, an asset once, and never a rack (rule 156)", () => {
    expect(status(() => sanitizeWallPlacements([{ id: "a", kind: "asset", assetId: A1, wallId: "w1", points: rect(90, 0, 12, 8) }], walls))).toBe(400);
    expect(status(() => sanitizeWallPlacements([
      { id: "a", kind: "asset", assetId: A1, wallId: "w1", points: rect(0, 0, 4, 4) },
      { id: "b", kind: "asset", assetId: A1, wallId: "w1", points: rect(10, 0, 4, 4) },
    ], walls))).toBe(400);
    expect(status(() => sanitizeWallPlacements([{ id: "r", kind: "rack", wallId: "w1", units: 12, label: "Wall rack", points: rect(0, 0, 24, 24) }], walls))).toBe(400);
    const [t] = sanitizeWallPlacements([{ id: "t", kind: "thirdParty", wallId: "w1", label: " Carrier NID ", points: rect(0, 0, 12, 8) }], walls);
    expect(t).toMatchObject({ kind: "thirdParty", label: "Carrier NID", units: null, linkedViewId: null, assetId: null });
  });

  it("refuses a shape with no area", () => {
    expect(status(() => sanitizeWallPlacements([{ id: "a", kind: "cableManagement", wallId: "w1", points: [[0, 0], [4, 0], [8, 0]] }], walls))).toBe(400);
  });
});

describe("floor layers and regions (rules 150, 152)", () => {
  it("orders layers by level, a name is an optional label (rule 168), and never lists layer 0", () => {
    const out = sanitizeLayers([{ level: 2, name: "2" }, { level: -1, name: "Basement" }]);
    expect(out.map((l) => l.level)).toEqual([-1, 2]);
    expect(out[0]).toMatchObject({ name: "Basement", background: null });
    expect(status(() => sanitizeLayers([{ level: 0, name: "Ground" }]))).toBe(400);
    expect(sanitizeLayers([{ level: 1, name: "" }])[0]).toMatchObject({ level: 1, name: "" });
    // Rule 152(a): a floor plan's placement on the ground.
    const placed = sanitizeLayers([{ level: 1, name: "", plan: { cx: 10, cy: -5, sx: 0.5, sy: 2, rot: 370 } }])[0];
    expect(placed.plan).toEqual({ cx: 10, cy: -5, sx: 0.5, sy: 2, rot: 10 });
    expect(status(() => sanitizeLayers([{ level: 1, name: "", plan: { cx: 0, cy: 0, sx: 0, sy: 1, rot: 0 } }]))).toBe(400);
    expect(status(() => sanitizeLayers([{ level: 1, name: "", plan: { cx: "x", cy: 0, sx: 1, sy: 1 } }]))).toBe(400);
    expect(status(() => sanitizeLayers([{ level: 1, name: "1" }, { level: 1, name: "One" }]))).toBe(400);
    expect(status(() => sanitizeLayers([{ level: 1, name: "2 r:x" }]))).toBe(400);
  });

  it("polygons default to layer 0", () => {
    const [p] = sanitizePolygons([{ id: "p", codes: { room: "MDF" }, points: [[0, 0], [1, 0], [1, 1]] }]);
    expect(p.layer).toBe(0);
  });

  it("a region is a room chain or null (a rack or junction box is the Room view's own)", () => {
    expect(sanitizeRegion(null)).toBeNull();
    expect(sanitizeRegion({ building: "Plant", room: "MDF", junctionBox: "7" })).toMatchObject({ building: "Plant", room: "MDF", junctionBox: null, rack: null });
    expect(sanitizeRegion({ rack: "R1" })).toBeNull();
    expect(status(() => sanitizeRegion({}))).toBe(400);
  });
});


describe("rule 179: cable managers, items beside a rack, cable routes", () => {
  const racks: TopologyRack[] = sanitizeRacks([{ id: "rA", name: "Rack A", units: 24, order: 0 }]);

  it("turns every cable manager and the trough on unless set false", () => {
    expect(racks[0].cableManagers).toEqual({ left: true, right: true, trough: true });
    const r = sanitizeRacks([{ id: "a", name: "A", units: 10, cableManagers: { left: false, trough: false } }]);
    expect(r[0].cableManagers).toEqual({ left: false, right: true, trough: false });
    expect(status(() => sanitizeRacks([{ id: "a", name: "A", units: 10, cableManagers: { left: "no" } }]))).toBe(400);
  });

  it("stands an item beside the rack using no U, one per slot", () => {
    const out = sanitizeRackPlacements([
      { id: "u1", kind: "asset", assetId: A1, rackId: "rA", face: "front", startU: 1, heightU: 24 },
      { id: "pdu", kind: "asset", assetId: A2, rackId: "rA", face: "front", startU: 5, heightU: 3, mount: "side", side: "left", slot: 0 },
      { id: "tp", kind: "thirdParty", label: "PDU B", rackId: "rA", face: "front", mount: "side", side: "left", slot: 1 },
    ], racks);
    expect(out[0]).toMatchObject({ mount: "rack", side: null, slot: null });
    expect(out[1]).toMatchObject({ mount: "side", side: "left", slot: 0, startU: 1, heightU: 1 });
    expect(status(() => sanitizeRackPlacements([
      { id: "a", kind: "thirdParty", rackId: "rA", mount: "side", side: "right", slot: 0 },
      { id: "b", kind: "thirdParty", rackId: "rA", mount: "side", side: "right", slot: 0 },
    ], racks))).toBe(400);
    expect(status(() => sanitizeRackPlacements([{ id: "c", kind: "cableManagement", rackId: "rA", mount: "side", side: "left", slot: 0 }], racks))).toBe(400);
    expect(status(() => sanitizeRackPlacements([{ id: "c", kind: "thirdParty", rackId: "rA", mount: "side", side: "left", slot: 2 }], racks))).toBe(400);
    expect(status(() => sanitizeRackPlacements([{ id: "c", kind: "thirdParty", rackId: "rA", mount: "side", side: "up", slot: 0 }], racks))).toBe(400);
  });

  it("keeps a route's bends, ends and sig and refuses a malformed one", () => {
    const out = sanitizeCableRoutes({ "e|a|b": { bends: [[10, 20], [30.5, 40]], s: { side: "left", f: 0.25 }, sig: "x" } });
    expect(out["e|a|b"]).toEqual({ bends: [[10, 20], [30.5, 40]], s: { side: "left", f: 0.25 }, sig: "x" });
    expect(status(() => sanitizeCableRoutes([]))).toBe(400);
    expect(status(() => sanitizeCableRoutes({ k: { bends: Array.from({ length: 25 }, () => [0, 0]), sig: "" } }))).toBe(400);
    expect(status(() => sanitizeCableRoutes({ k: { bends: [[0, "1"]], sig: "" } }))).toBe(400);
    expect(status(() => sanitizeCableRoutes({ k: { bends: [], s: { side: "left", f: 2 }, sig: "" } }))).toBe(400);
    expect(status(() => sanitizeCableRoutes({ k: { bends: [] } }))).toBe(400);
  });
});
