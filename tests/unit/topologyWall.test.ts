/**
 * tests/unit/topologyWall.test.ts — the Wall canvas's pure helpers
 * (public/js/topology-wall.js, business rule 151): the browser's overlap rule
 * must refuse exactly what src/utils/wallGeometry.ts refuses, a dropped item
 * finds the nearest free space, and a rack's footprint follows its U.
 */
// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { polygonsOverlap, type Point } from "../../src/utils/wallGeometry.js";

type Pl = { id: string; wallId: string; points: Point[] };
type Wall = {
  _cellsOf: (p: Point[]) => Record<string, boolean>;
  _overlaps: (all: Pl[], cand: { wallId: string; points: Point[] }, ignore: string | null) => Pl | null;
  _nearestFreeSpot: (all: Pl[], wall: { id: string; width: number; height: number }, x: number, y: number, w: number, h: number) => { x: number; y: number } | null;
  _rackFootprint: (u: number) => { w: number; h: number };
};
let W: Wall;

beforeAll(() => {
  new Function(readFileSync(resolve(__dirname, "../../public/js/topology-wall.js"), "utf8"))();
  W = (window as unknown as { PolarisTopologyWall: Wall }).PolarisTopologyWall;
});

const rect = (x: number, y: number, w: number, h: number): Point[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

describe("Wall canvas helpers", () => {
  it("agrees with the server's overlap rule on the same shapes", () => {
    const ell: Point[] = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]];
    const cases: Array<[Point[], Point[]]> = [
      [rect(0, 0, 4, 4), rect(4, 0, 4, 4)],
      [rect(0, 0, 4, 4), rect(3, 3, 4, 4)],
      [ell, rect(3, 3, 3, 3)],
      [ell, rect(1, 3, 2, 2)],
      [rect(0, 0, 10, 10), rect(2, 2, 2, 2)],
    ];
    for (const [a, b] of cases) {
      const browser = !!W._overlaps([{ id: "b", wallId: "w", points: b }], { wallId: "w", points: a }, null);
      expect(browser).toBe(polygonsOverlap(a, b));
    }
  });

  it("only compares items on the same wall, and ignores the item being moved", () => {
    const all = [{ id: "a", wallId: "w1", points: rect(0, 0, 4, 4) }];
    expect(W._overlaps(all, { wallId: "w2", points: rect(0, 0, 4, 4) }, null)).toBeNull();
    expect(W._overlaps(all, { wallId: "w1", points: rect(1, 1, 2, 2) }, "a")).toBeNull();
  });

  it("finds the nearest free space for a dropped item, or none", () => {
    const wall = { id: "w", width: 20, height: 10 };
    const all = [{ id: "a", wallId: "w", points: rect(0, 0, 10, 10) }];
    expect(W._nearestFreeSpot(all, wall, 2, 2, 4, 4)).toEqual({ x: 10, y: 2 });
    expect(W._nearestFreeSpot(all, wall, 0, 0, 12, 4)).toBeNull();
  });

  it("sizes a wall rack from its U: 24 in wide, 1.75 in per U plus the frame", () => {
    expect(W._rackFootprint(12)).toEqual({ w: 24, h: 24 });
    expect(W._rackFootprint(42)).toEqual({ w: 24, h: 77 });
  });
});
