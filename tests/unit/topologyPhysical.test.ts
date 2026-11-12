/**
 * tests/unit/topologyPhysical.test.ts
 *
 * The Topology-mode canvas's pure helpers (public/js/topology-physical.js,
 * business rule 148): a drop is judged by the INNERMOST polygon that contains
 * it (a floor inside a building wins), a point outside every polygon finds
 * none (so nothing is staged), and the group picker offers every prefix of
 * every code chain the site's devices carry, in display casing.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

let P: Record<string, any>;

beforeAll(() => {
  const sb: Record<string, any> = { window: {}, console };
  vm.createContext(sb);
  vm.runInContext(readFileSync(resolve(__dirname, "../../public/js/topology-physical.js"), "utf8"), sb);
  P = sb.window.PolarisTopologyPhysical;
});

const codes = (o: Record<string, string>) => ({ area: null, building: null, floor: null, room: null, junctionBox: null, ...o });
const building = { id: "b", codes: codes({ building: "Plant" }), points: [[0, 0], [100, 0], [100, 100], [0, 100]] };
const floor = { id: "f", codes: codes({ building: "Plant", floor: "1" }), points: [[10, 10], [60, 10], [60, 60], [10, 60]] };
const office = { id: "o", codes: codes({ building: "Office" }), points: [[200, 0], [300, 0], [300, 100]] };

describe("innermostPolygon", () => {
  it("picks the smallest containing polygon", () => {
    expect(P._innermostPolygon([building, floor, office], [20, 20]).id).toBe("f");
    expect(P._innermostPolygon([building, floor, office], [80, 80]).id).toBe("b");
    expect(P._innermostPolygon([floor, building], [20, 20]).id).toBe("f"); // order does not matter
  });

  it("finds nothing outside every polygon", () => {
    expect(P._innermostPolygon([building, floor, office], [150, 50])).toBeNull();
    expect(P._innermostPolygon([], [1, 1])).toBeNull();
  });

  it("handles a triangle and its edges", () => {
    expect(P._pointInRing([290, 50], office.points)).toBe(true);
    expect(P._pointInRing([210, 90], office.points)).toBe(false);
  });
});

describe("polyCodes (polygons are areas, buildings and floors)", () => {
  it("keeps area / building / floor and drops room, rack and junction box", () => {
    expect(P._polyCodes({ area: "Mine", building: "Plant", floor: "1", room: "MDF", rack: "R1", junctionBox: "7" }))
      .toEqual({ area: "Mine", building: "Plant", floor: "1", room: null, rack: null, junctionBox: null });
  });
});

describe("groupsFromData", () => {
  it("lists every chain prefix once, display casing kept", () => {
    const groups = P._groupsFromData({
      fortigate: { location: null },
      switches: [{ location: { building: "Plant", floor: "1" } }, { location: { building: "plant", floor: "2" } }],
      aps: [{ location: { area: "Mine", building: "Shop" } }],
      endpoints: [{ location: { building: "Plant", floor: "1", room: "MCC" } }],
    });
    expect(groups.map((g: any) => P._codesLabel(g))).toEqual([
      "b:Plant",
      "b:Plant f:1",
      "b:Plant f:1 r:MCC",
      "b:plant f:2",
      "a:Mine",
      "a:Mine b:Shop",
    ]);
  });

  it("compares codes case- and space-blind", () => {
    expect(P._codesEqual(codes({ building: "North  Closet" }), codes({ building: "north closet" }))).toBe(true);
    expect(P._codesEqual(codes({ building: "A" }), codes({ building: "A", floor: "1" }))).toBe(false);
  });
});

describe("stacked floors (rule 152(a))", () => {
  const ext = { w: 1000, h: 500 };
  it("places a plan on the ground and back: move, stretch, rotate", () => {
    const plan = { cx: 100, cy: 200, sx: 2, sy: 0.5, rot: 30 };
    for (const [x, y] of [[0, 0], [1000, 500], [250, 400]]) {
      const g = P._planToGround(plan, ext, x, y);
      const back = P._groundToPlan(plan, ext, g[0], g[1]);
      expect(back[0]).toBeCloseTo(x, 6);
      expect(back[1]).toBeCloseTo(y, 6);
    }
    // The plan's centre is its placement's centre; 90° turns +x into +y.
    expect(P._planToGround(plan, ext, 500, 250)).toEqual([100, 200]);
    const turned = P._planToGround({ cx: 0, cy: 0, sx: 1, sy: 1, rot: 90 }, ext, 600, 250);
    expect(turned[0]).toBeCloseTo(0, 6);
    expect(turned[1]).toBeCloseTo(100, 6);
  });
  it("fades floors above, hides floors below, and scales by 25 % a floor", () => {
    expect(P._floorLook(0)).toEqual({ opacity: 1, scale: 1 });
    expect(P._floorLook(1)).toEqual({ opacity: 0.1, scale: 1.25 });
    expect(P._floorLook(2).opacity).toBe(0.02);
    expect(P._floorLook(2).scale).toBeCloseTo(1.5625, 6);
    expect(P._floorLook(3).opacity).toBe(0);
    expect(P._floorLook(-1)).toEqual({ opacity: 0, scale: 0.75 });
  });
  it("fades a link between floors from one end's opacity to the other's", () => {
    const steps = P._fadeSteps(1, 0.1, 4);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toBeGreaterThan(steps[3]);
    expect(steps[0]).toBeLessThan(1);
    expect(steps[3]).toBeGreaterThan(0.1);
  });
});
