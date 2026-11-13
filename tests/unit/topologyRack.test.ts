/**
 * tests/unit/topologyRack.test.ts
 *
 * Rack mode's occupancy rules (public/js/topology-rack.js, business rule 149),
 * the client half of topologyViewService → sanitizeRackPlacements: an item
 * stays inside its rack, a full-depth item blocks its U on BOTH faces, two
 * half-depth items share a U front and back, and a drop lands on the nearest
 * free U.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

let K: Record<string, any>;

beforeAll(() => {
  const sb: Record<string, any> = { window: {}, console };
  vm.createContext(sb);
  vm.runInContext(readFileSync(resolve(__dirname, "../../public/js/topology-rack.js"), "utf8"), sb);
  K = sb.window.PolarisTopologyRack;
});

const racks = [{ id: "A", name: "Rack A", units: 42, order: 0, face: "front" }, { id: "B", name: "Rack B", units: 24, order: 1, face: "front" }];
const full = (id: string, startU: number, heightU = 1, face = "front") => ({ id, kind: "asset", assetId: id, rackId: "A", face, startU, heightU, fullDepth: true });
const half = (id: string, startU: number, face: string) => ({ id, kind: "cableManagement", assetId: null, rackId: "A", face, startU, heightU: 1, fullDepth: false });

describe("fits", () => {
  it("keeps an item inside its rack", () => {
    expect(K._fits([], racks, { rackId: "B", face: "front", startU: 24, heightU: 1, fullDepth: true })).toBe(true);
    expect(K._fits([], racks, { rackId: "B", face: "front", startU: 24, heightU: 2, fullDepth: true })).toBe(false);
    expect(K._fits([], racks, { rackId: "B", face: "front", startU: 0, heightU: 1, fullDepth: true })).toBe(false);
    expect(K._fits([], racks, { rackId: "Z", face: "front", startU: 1, heightU: 1, fullDepth: true })).toBe(false);
  });

  it("a full-depth device blocks the rear of its U", () => {
    const placed = [full("sw", 10, 2)];
    expect(K._fits(placed, racks, { rackId: "A", face: "rear", startU: 11, heightU: 1, fullDepth: false })).toBe(false);
    expect(K._fits(placed, racks, { rackId: "A", face: "rear", startU: 12, heightU: 1, fullDepth: false })).toBe(true);
  });

  it("half-depth items share a U on opposite faces, never on the same face", () => {
    const placed = [half("cm1", 5, "front")];
    expect(K._fits(placed, racks, { rackId: "A", face: "rear", startU: 5, heightU: 1, fullDepth: false })).toBe(true);
    expect(K._fits(placed, racks, { rackId: "A", face: "front", startU: 5, heightU: 1, fullDepth: false })).toBe(false);
    expect(K._fits(placed, racks, { rackId: "A", face: "rear", startU: 5, heightU: 1, fullDepth: true })).toBe(false);
  });

  it("ignores the item being moved", () => {
    const placed = [full("sw", 10, 2)];
    expect(K._fits(placed, racks, { rackId: "A", face: "front", startU: 11, heightU: 2, fullDepth: true }, "sw")).toBe(true);
  });
});

describe("nearestFreeU", () => {
  it("takes the wanted U when free, else the nearest free one", () => {
    expect(K._nearestFreeU([], racks, "A", "front", 20, 1, true, null)).toBe(20);
    const placed = [full("a", 20), full("b", 21)];
    expect(K._nearestFreeU(placed, racks, "A", "front", 20, 1, true, null)).toBe(19);
  });

  it("answers null for a full rack", () => {
    const placed = Array.from({ length: 24 }, (_, i) => ({ ...full("x" + i, i + 1), rackId: "B" }));
    expect(K._nearestFreeU(placed, racks, "B", "front", 5, 1, true, null)).toBeNull();
  });
});

describe("rule 179: items beside a rack and cable routing", () => {
  it("an item beside the rack takes no U", () => {
    const side = { id: "pdu", kind: "asset", assetId: "pdu", rackId: "A", face: "front", startU: 1, heightU: 1, fullDepth: true, mount: "side", side: "left", slot: 0 };
    expect(K._fits([side], racks, { rackId: "A", face: "front", startU: 1, heightU: 1, fullDepth: true })).toBe(true);
  });

  // Two racks side by side, managers on both sides, troughs on top.
  const geo = (x: number, index: number, troughs = true) => ({
    index,
    head: { x0: x, x1: x + 440, y0: 0, y1: 30 },
    trough: troughs ? { x0: x, x1: x + 440, y0: 30, y1: 52 } : null,
    vcm: { left: { x0: x, x1: x + 30, y0: 52, y1: 900 }, right: { x0: x + 410, x1: x + 440, y0: 52, y1: 900 } },
    body: { x0: x + 30, x1: x + 410, y0: 52, y1: 900 },
  });
  const dev = (rackId: string, x: number, y: number) => ({ rackId, x0: x + 73, x1: x + 405, y0: y, y1: y + 20 });

  it("routes within one rack through a cable manager only", () => {
    const racksG = { A: geo(0, 0) };
    const pts = K._autoRoute(dev("A", 0, 100), dev("A", 0, 300), racksG, K._makeLanes(), "k");
    expect(pts).toHaveLength(4);
    expect(pts[1][0]).toBe(pts[2][0]); // straight down the manager
    expect(pts[1][0]).toBeGreaterThanOrEqual(410);
    expect(pts[1][0]).toBeLessThanOrEqual(440);
  });

  it("routes between racks up the facing manager, along the trough and down the other", () => {
    const racksG = { A: geo(0, 0), B: geo(520, 1) };
    const pts = K._autoRoute(dev("A", 0, 100), dev("B", 520, 300), racksG, K._makeLanes(), "k");
    expect(pts).toHaveLength(6);
    expect(pts[1][0]).toBeGreaterThanOrEqual(410); // A's right manager
    expect(pts[2][1]).toBeGreaterThanOrEqual(30);  // in the trough
    expect(pts[2][1]).toBeLessThanOrEqual(52);
    expect(pts[3][0]).toBeGreaterThanOrEqual(520);  // B's left manager
    expect(pts[3][0]).toBeLessThanOrEqual(550);
    expect(pts[5][0]).toBe(520 + 73);               // into B's device from its left
  });

  it("goes over the top when a rack has no trough, and uses the other manager when one is off", () => {
    const a = geo(0, 0, false), b = geo(520, 1);
    (a.vcm as any).right = null;
    const pts = K._autoRoute(dev("A", 0, 100), dev("B", 520, 300), { A: a, B: b }, K._makeLanes(), "k");
    expect(pts[1][0]).toBeLessThanOrEqual(30); // A's left manager
    expect(pts[2][1]).toBeLessThan(0);         // above the headers
  });

  it("gives two cables in one manager different lanes", () => {
    const racksG = { A: geo(0, 0) };
    const lanes = K._makeLanes();
    const p1 = K._autoRoute(dev("A", 0, 100), dev("A", 0, 300), racksG, lanes, "k1");
    const p2 = K._autoRoute(dev("A", 0, 140), dev("A", 0, 340), racksG, lanes, "k2");
    expect(p1[1][0]).not.toBe(p2[1][0]);
  });

  it("drops a new corner on the nearest segment, and ends stay on a device side", () => {
    const pts = [[0, 0], [100, 0], [100, 100], [0, 100]];
    expect(K._insertAt(pts, [50, 2])).toBe(0);
    expect(K._insertAt(pts, [98, 50])).toBe(1);
    const end = { x0: 10, x1: 110, y0: 0, y1: 20 };
    expect(K._nearestEnd(end, 20, 5)).toEqual({ side: "left", f: 0.25 });
    expect(K._endPoint(end, { side: "right", f: 0.5 })).toEqual([110, 10]);
  });
});
