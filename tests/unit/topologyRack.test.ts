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
