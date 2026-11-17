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

describe("layers by area and types (rules 188(b), 188(c))", () => {
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const N = "cccccccc-0000-4000-8000-000000000003";
  const st = (color: string) => ({ color, width: 3, dash: "solid" });
  const LAYERS = [
    { id: A, title: "Lines — here", geometry: "line", style: { color: "accent", width: 3, dash: "solid" }, extent: [-86, 37, -85, 38],
      types: { field: "T", numeric: false, values: [{ value: "GAS", label: "Gas line", on: true, style: st("#f4e04d") }, { value: "WATER", label: "Water line", on: true, style: st("#1e88e5") }],
        other: { on: true, style: st("#9aa0a6") } } },
    { id: B, title: "Lines — elsewhere", geometry: "line", style: { color: "accent", width: 3, dash: "solid" }, extent: [-80, 40, -79, 41] },
    { id: N, title: "No area known", geometry: "point", style: { color: "green", width: 3, dash: "solid" } },
  ];

  async function mount(hidden: string[]) {
    let keys = hidden.slice();
    const fetched: string[] = [];
    const bounds = { getWest: () => -85.6, getEast: () => -85.5, getSouth: () => 37.5, getNorth: () => 37.6 };
    const map = { getBounds: () => bounds, getZoom: () => 15, on() {}, off() {} };
    const L = { layerGroup: () => ({ addTo() { return this; }, clearLayers() {} }) };
    const layer = C.create({
      L, map: () => map, pane: () => ({}), editing: () => false, visible: () => false,
      fetchLayers: () => Promise.resolve({ layers: LAYERS }),
      fetchFeatures: (id: string) => { fetched.push(id); return Promise.resolve({ features: [] }); },
      fetchLinks: () => Promise.resolve({ links: {} }),
      hidden: () => keys, setHidden: (k: string[]) => { keys = k; }, canSaveShown: () => false,
      toast() {},
    });
    await layer.load();
    return { layer, keys: () => keys, fetched };
  }

  it("lists the layers covering the map for the eye menu, a by-type layer's types under it, and names the rest", async () => {
    const { layer } = await mount([`${A}:GAS`]);
    const list = JSON.parse(JSON.stringify(layer.layerList()));
    expect(list.map((l: { id: string }) => l.id)).toEqual([A, N]);
    const types = list[0].types.map((t: { key: string; label: string; shown: boolean }) => [t.key, t.label, t.shown]);
    expect(types).toEqual([[`${A}:GAS`, "Gas line", false], [`${A}:WATER`, "Water line", true], [`${A}#other`, "Other types", true]]);
    expect(list[0].types[1].swatch).toContain("#1e88e5");
    expect(list[1].types).toEqual([]);
    expect(JSON.parse(JSON.stringify(layer.notHere()))).toEqual(["Lines — elsewhere"]);
    expect(layer.brokenCount()).toBe(0);
    expect(layer).not.toHaveProperty("sidebarHtml");
  });

  it("gives the Legend panel an ArcGIS section: shown layers, a by-type layer's visible types under its name", async () => {
    let legend = "";
    const bounds = { getWest: () => -85.6, getEast: () => -85.5, getSouth: () => 37.5, getNorth: () => 37.6 };
    const map = { getBounds: () => bounds, getZoom: () => 15, on() {}, off() {} };
    const L = { layerGroup: () => ({ addTo() { return this; }, clearLayers() {} }) };
    const layer = C.create({
      L, map: () => map, pane: () => ({}), editing: () => false, visible: () => true,
      fetchLayers: () => Promise.resolve({ layers: LAYERS }),
      fetchFeatures: () => Promise.resolve({ features: [] }),
      fetchLinks: () => Promise.resolve({ links: {} }),
      hidden: () => [`${A}:GAS`, N], setHidden() {}, canSaveShown: () => false, toast() {},
      paintLegend: (html: string) => { legend = html; },
    });
    await layer.load();
    expect(legend).toContain("ArcGIS layers");
    expect(legend).toContain("Lines — here");
    expect(legend).toContain("Water line");
    expect(legend).not.toContain("Gas line");
    expect(legend).not.toContain("No area known");
    expect(legend).not.toContain("Lines — elsewhere");
    layer.destroy();
    expect(legend).toBe("");
  });

  it("hides a layer or a type by adding its key, and shows it again by removing it", async () => {
    const { layer, keys } = await mount([]);
    layer.setHidden(`${A}:WATER`, true);
    expect(keys()).toEqual([`${A}:WATER`]);
    layer.setHidden(B, true);
    layer.setHidden(`${A}:WATER`, false);
    expect(keys()).toEqual([B]);
    expect(layer.layerList().find((l: { id: string }) => l.id === A).shown).toBe(true);
  });
});
