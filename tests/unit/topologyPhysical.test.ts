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
  it("numbers floors the building's way: the ground is 1, there is no 0", () => {
    expect([-2, -1, 0, 1, 2].map((l) => P._floorNumber(l))).toEqual([-2, -1, 1, 2, 3]);
    // f: codes follow the numbers; the ground writes f:1 only beside other floors.
    expect(P._floorCodeFor(0, true)).toBe("1");
    expect(P._floorCodeFor(0, false)).toBeNull();
    expect(P._floorCodeFor(1, true)).toBe("2");
    expect(P._floorCodeFor(-1, true)).toBe("-1");
  });
  it("a corner drag moves only that corner: the opposite one stays put", () => {
    const start = { cx: 100, cy: 200, sx: 2, sy: 0.5, rot: 30 };
    const corners = [[0, 0], [1000, 0], [1000, 500], [0, 500]];
    for (let ci = 0; ci < 4; ci++) {
      const anchor = corners[(ci + 2) % 4];
      const before = P._planToGround(start, ext, anchor[0], anchor[1]);
      const was = P._planToGround(start, ext, corners[ci][0], corners[ci][1]);
      const pointer = [was[0] + 37, was[1] - 21];
      // Free stretch (Ctrl): the grabbed corner lands on the pointer.
      const free = P._cornerDragPlan(start, ext, ci, pointer, false);
      const fa = P._planToGround(free, ext, anchor[0], anchor[1]);
      expect(fa[0]).toBeCloseTo(before[0], 6);
      expect(fa[1]).toBeCloseTo(before[1], 6);
      const fd = P._planToGround(free, ext, corners[ci][0], corners[ci][1]);
      expect(fd[0]).toBeCloseTo(pointer[0], 6);
      expect(fd[1]).toBeCloseTo(pointer[1], 6);
      // Default: the shape is kept, the opposite corner still holds.
      const kept = P._cornerDragPlan(start, ext, ci, pointer, true);
      expect(kept.sx / kept.sy).toBeCloseTo(start.sx / start.sy, 9);
      const ka = P._planToGround(kept, ext, anchor[0], anchor[1]);
      expect(ka[0]).toBeCloseTo(before[0], 6);
      expect(ka[1]).toBeCloseTo(before[1], 6);
      expect(kept.rot).toBe(30);
    }
  });
  it("fades floors above, hides floors below, and scales by 25 % a floor", () => {
    expect(P._floorLook(0)).toEqual({ opacity: 1, scale: 1 });
    // No zoom between floors (operator decision 2026-11-16).
    expect(P._floorLook(1)).toEqual({ opacity: 0.05, scale: 1 });
    expect(P._floorLook(2)).toEqual({ opacity: 0.02, scale: 1 });
    expect(P._floorLook(3).opacity).toBe(0);
    expect(P._floorLook(-1)).toEqual({ opacity: 0, scale: 1 });
  });
  it("fades a link between floors from one end's opacity to the other's", () => {
    const steps = P._fadeSteps(1, 0.1, 4);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toBeGreaterThan(steps[3]);
    expect(steps[0]).toBeLessThan(1);
    expect(steps[3]).toBeGreaterThan(0.1);
  });
});

describe("room outlines", () => {
  it("convexHull keeps only the outer points", () => {
    const h = P._convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [3, 7]]);
    expect(h.length).toBe(4);
    expect(h).not.toContainEqual([5, 5]);
  });
  it("roundedHull rings one device and wraps every point with the pad", () => {
    const one = P._roundedHull([[100, 100]], 30, 16);
    expect(one.length).toBe(16);
    one.forEach((q: number[]) => expect(Math.hypot(q[0] - 100, q[1] - 100)).toBeCloseTo(30, 6));
    const two = P._roundedHull([[0, 0], [200, 0]], 30, 16);
    const xs = two.map((q: number[]) => q[0]);
    expect(Math.min(...xs)).toBeCloseTo(-30, 6);
    expect(Math.max(...xs)).toBeCloseTo(230, 6);
  });
});

describe("CAD drawings (rule 182): placement maths", () => {
  const ext = { w: 1000, h: 500 };
  it("fitTwoPoints puts both plan points exactly on their ground points", () => {
    const p1 = [100, 50], p2 = [900, 400], g1 = [5000, -2000], g2 = [5300, -1700];
    const plan = P._fitTwoPoints(p1, p2, g1, g2, ext);
    const a = P._planToGround(plan, ext, p1[0], p1[1]);
    const b = P._planToGround(plan, ext, p2[0], p2[1]);
    expect(a[0]).toBeCloseTo(g1[0], 6); expect(a[1]).toBeCloseTo(g1[1], 6);
    expect(b[0]).toBeCloseTo(g2[0], 6); expect(b[1]).toBeCloseTo(g2[1], 6);
    expect(plan.sx).toBe(plan.sy);
    expect(P._fitTwoPoints(p1, p1, g1, g2, ext)).toBeNull();
  });
  it("cadToPlan maps the drawing's extents onto the plan, y up", () => {
    const bg = { cad: { ext: { minX: 1000, minY: 2000, maxX: 3000, maxY: 3000 } } };
    expect(P._cadToPlan(bg, ext, [1000, 2000])).toEqual([0, 0]);
    expect(P._cadToPlan(bg, ext, [3000, 3000])).toEqual([1000, 500]);
  });
  it("overlapShare is the shared area over the smaller drawing", () => {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(P._overlapShare(a, { minX: 5, minY: 0, maxX: 15, maxY: 10 })).toBeCloseTo(0.5);
    expect(P._overlapShare(a, { minX: 2, minY: 2, maxX: 4, maxY: 4 })).toBeCloseTo(1);
    expect(P._overlapShare(a, { minX: 20, minY: 20, maxX: 30, maxY: 30 })).toBe(0);
  });
});
