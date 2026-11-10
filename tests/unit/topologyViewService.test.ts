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

  it("accepts the three modes only", () => {
    expect(sanitizeMode("rack")).toBe("rack");
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
    expect(out[0].codes).toEqual({ area: null, building: "Plant", floor: "1", room: null, junctionBox: null });
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
    expect(out[0].fullDepth).toBe(true); // a device defaults to full depth
    expect(out[1]).toMatchObject({ assetId: null, fullDepth: false }); // cable management to half
  });

  it("keeps a third-party box's name, defaults it, and refuses a bad one", () => {
    const out = sanitizeRackPlacements([
      { id: "tp1", kind: "thirdParty", label: "  ISP   router ", rackId: "rA", face: "front", startU: 30, heightU: 2 },
      { id: "tp2", kind: "thirdParty", rackId: "rA", face: "front", startU: 20, heightU: 1, assetId: A1 },
      { id: "p1", kind: "asset", assetId: A2, label: "ignored", rackId: "rA", face: "front", startU: 10, heightU: 1 },
    ], racks);
    expect(out[0]).toMatchObject({ kind: "thirdParty", label: "ISP router", assetId: null, fullDepth: true });
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

  it("a full-depth device blocks the rear; two half-depth items share a U", () => {
    expect(status(() => sanitizeRackPlacements([
      { id: "p1", kind: "asset", assetId: A1, rackId: "rA", face: "front", startU: 10, heightU: 2 },
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
});
