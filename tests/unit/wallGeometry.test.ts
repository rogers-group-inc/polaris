/**
 * tests/unit/wallGeometry.test.ts — a Wall view's overlap rule (business rule
 * 151): items on a wall may share an edge (mounted side by side) but never a
 * 1-inch cell; concave shapes (an L) count only the cells they cover.
 */
import { describe, it, expect } from "vitest";
import { cellsOf, polygonsOverlap, pointInPolygon, doubleArea, type Point } from "../../src/utils/wallGeometry.js";

const rect = (x: number, y: number, w: number, h: number): Point[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
// An L: a 6x2 bar along the top and a 2x6 leg down the left.
const ell: Point[] = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]];

describe("wall geometry", () => {
  it("counts the cells a shape covers", () => {
    expect(cellsOf(rect(0, 0, 3, 2)).size).toBe(6);
    expect(cellsOf(ell).size).toBe(12 + 12 - 4); // bar + leg, the shared 2x2 corner once
  });

  it("lets two items share an edge or a corner", () => {
    expect(polygonsOverlap(rect(0, 0, 4, 4), rect(4, 0, 4, 4))).toBe(false);
    expect(polygonsOverlap(rect(0, 0, 4, 4), rect(4, 4, 2, 2))).toBe(false);
  });

  it("refuses a shared cell, containment and an identical shape", () => {
    expect(polygonsOverlap(rect(0, 0, 4, 4), rect(3, 3, 4, 4))).toBe(true);
    expect(polygonsOverlap(rect(0, 0, 10, 10), rect(2, 2, 2, 2))).toBe(true);
    expect(polygonsOverlap(rect(5, 5, 3, 3), rect(5, 5, 3, 3))).toBe(true);
  });

  it("reads an L's notch as empty", () => {
    expect(polygonsOverlap(ell, rect(3, 3, 3, 3))).toBe(false);
    expect(polygonsOverlap(ell, rect(1, 3, 2, 2))).toBe(true);
    expect(pointInPolygon(4.5, 4.5, ell)).toBe(false);
  });

  it("measures a degenerate shape as zero area", () => {
    expect(doubleArea([[0, 0], [4, 0], [8, 0]])).toBe(0);
    expect(Math.abs(doubleArea(rect(0, 0, 2, 3)))).toBe(12);
  });
});
