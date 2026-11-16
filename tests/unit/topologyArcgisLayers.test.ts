/**
 * tests/unit/topologyArcgisLayers.test.ts
 *
 * The ArcGIS layer module's pure helpers (public/js/topology-arcgis-layers.js,
 * business rule 188): the edit session sends exactly the links whose routes
 * changed, a multi-part line is joined in order for routing, a feature
 * reference splits at its first slash only, and the card's length is the 2D
 * ground distance.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

let C: Record<string, any>;

beforeAll(() => {
  const sb: Record<string, any> = { window: {}, console };
  vm.createContext(sb);
  vm.runInContext(readFileSync(resolve(__dirname, "../../public/js/topology-arcgis-layers.js"), "utf8"), sb);
  C = sb.window.PolarisTopologyArcgisLayers;
});

describe("diffLinks (rule 188(a))", () => {
  it("sends only the links whose lines changed, an empty list for one made straight", () => {
    const loaded = { "lldp|a|b": ["L/1"], "lldp|a|c": ["L/1", "L/2"], "lldp|b|c": ["L/2"] };
    const current = { "lldp|a|b": ["L/1"], "lldp|a|c": ["L/2", "L/1"], "lldp|c|d": ["L/3"] };
    const d = JSON.parse(JSON.stringify(C._diffLinks(loaded, current)));
    expect(d).toEqual({ "lldp|a|c": ["L/2", "L/1"], "lldp|b|c": [], "lldp|c|d": ["L/3"] });
  });
});

describe("featurePoints", () => {
  it("joins a multi-part line's paths in order", () => {
    const f = { g: [[[-85, 38], [-85, 38.001]], [[-85.001, 38.001], [-85.002, 38.002]]] };
    expect(JSON.parse(JSON.stringify(C._featurePoints(f)))).toEqual([[-85, 38], [-85, 38.001], [-85.001, 38.001], [-85.002, 38.002]]);
  });
});

describe("splitRef", () => {
  it("splits at the first slash, keeping a feature id that holds braces", () => {
    expect(JSON.parse(JSON.stringify(C._splitRef("abc/{X-1}")))).toEqual({ layerId: "abc", featureId: "{X-1}" });
    expect(C._splitRef("no-slash")).toBeNull();
  });
});

describe("lengthM", () => {
  it("measures the ground distance in 2D", () => {
    // One thousandth of a degree of latitude ≈ 111.2 m.
    expect(C._lengthM([[-85, 38], [-85, 38.001]])).toBeCloseTo(111.19, 1);
  });
});
