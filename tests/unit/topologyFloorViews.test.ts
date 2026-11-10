/**
 * tests/unit/topologyFloorViews.test.ts
 *
 * Location-view partitioning for the Device Map topology modal —
 * computeFloorViews (area + building + floor views) / partitionElementsForFloor /
 * compareFloors in public/js/topology-render.js (browser IIFE loaded in a
 * Node vm context, same harness as topologyColumns.test.ts).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

type El = { data: Record<string, any> };
type LocView = {
  key: string;
  kind: "area" | "building" | "floor";
  areaKey: string;
  buildingKey: string;
  areaName: string;
  buildingName: string;
  floorName?: string;
  label: string;
};

let computeFloorViews: (els: El[]) => LocView[];
let partitionElementsForFloor: (els: El[], viewKey: string) => El[];
let compareFloors: (a: string, b: string) => number;
let viewSwitcherRows: (views: LocView[], activeKey: string) => { key: string; label: string; title: string; active: boolean }[][];
let computeTopologyColumns: (els: El[]) => Record<string, { depth: number; lane: number }> | null;
let viewSuppressKinds: (key: string) => string[] | null;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../../public/js/topology-render.js");
  const code = readFileSync(file, "utf8");
  const sandbox: { window: Record<string, any> } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const api = sandbox.window.PolarisTopologyRender;
  computeFloorViews = api.computeFloorViews;
  partitionElementsForFloor = api.partitionElementsForFloor;
  compareFloors = api.compareFloors;
  viewSwitcherRows = api.viewSwitcherRows;
  computeTopologyColumns = api.computeTopologyColumns;
  viewSuppressKinds = api.viewSuppressKinds;
});

// Element builders. loc* are normalized grouping keys; loc*Name the display
// casing (buildTopologyElements stamps both in production).
const node = (id: string, role: string, loc?: { a?: string; b?: string; f?: string; r?: string; ra?: string; jb?: string }): El => ({
  data: {
    id,
    role,
    label: id.toUpperCase(),
    ...(loc?.a ? { locA: loc.a.toLowerCase(), locAName: loc.a } : {}),
    ...(loc?.b ? { locB: loc.b.toLowerCase(), locBName: loc.b } : {}),
    ...(loc?.f ? { locF: loc.f.toLowerCase(), locFName: loc.f } : {}),
    ...(loc?.r ? { locR: loc.r.toLowerCase(), locRName: loc.r } : {}),
    ...(loc?.ra ? { locRa: loc.ra.toLowerCase(), locRaName: loc.ra } : {}),
    ...(loc?.jb ? { locJb: loc.jb.toLowerCase(), locJbName: loc.jb } : {}),
  },
});
const edge = (source: string, target: string, extra?: Record<string, unknown>): El => ({
  data: { id: `e-${source}-${target}`, source, target, isIface: 1, ...(extra || {}) },
});

// Two-building site: Shop floors 1/2, Office floor 1, one untagged switch.
const site = (): El[] => [
  node("fg", "fortigate"),
  node("s1", "fortiswitch", { b: "Shop", f: "1" }),
  node("s2", "fortiswitch", { b: "Shop", f: "2" }),
  node("o1", "fortiswitch", { b: "Office", f: "1" }),
  node("plain", "fortiswitch"),
  node("ap1", "fortiap", { b: "Shop", f: "1" }),
  edge("fg", "s1"),
  edge("s1", "s2"),
  edge("fg", "o1"),
  edge("fg", "plain"),
  edge("s1", "ap1"),
  edge("s2", "plain"),
];

describe("compareFloors", () => {
  it("orders underground, numbered, and named floors: -2 < B1(-1) < 1 < 2 < Mezzanine", () => {
    const sorted = ["Mezzanine", "2", "B1", "-2", "1"].sort(compareFloors);
    expect(sorted).toEqual(["-2", "B1", "1", "2", "Mezzanine"]);
  });

  it("is case-insensitive on B# basement notation", () => {
    expect(compareFloors("b2", "B1")).toBeLessThan(0);
  });

  it("sorts named floors alphabetically after all numbered floors", () => {
    expect(compareFloors("Roof", "99")).toBeGreaterThan(0);
    expect(compareFloors("Attic", "Roof")).toBeLessThan(0);
  });
});

describe("computeFloorViews", () => {
  it("returns a building view for EVERY building plus per-floor views, building chip first", () => {
    const views = computeFloorViews(site());
    expect(views.map((v) => v.key)).toEqual([
      "b||office", "f||office|1",
      "b||shop", "f||shop|1", "f||shop|2",
    ]);
    expect(views.map((v) => v.label)).toEqual([
      "Office", "Office — 1",
      "Shop", "Shop — 1", "Shop — 2",
    ]);
    expect(views.map((v) => v.kind)).toEqual(["building", "floor", "building", "floor", "floor"]);
  });

  it("includes buildings that have no floors at all", () => {
    const views = computeFloorViews([
      node("fg", "fortigate"),
      node("sw", "fortiswitch", { b: "Shop" }),
    ]);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ key: "b||shop", kind: "building", label: "Shop" });
  });

  it("returns empty when no node carries a b: or f: code (no switcher rendered)", () => {
    expect(computeFloorViews([node("fg", "fortigate"), node("sw", "fortiswitch")])).toEqual([]);
    expect(computeFloorViews([])).toEqual([]);
  });

  it("scopes buildings by area and prefixes labels with the area name", () => {
    const views = computeFloorViews([
      node("x", "fortiswitch", { a: "Mine", b: "Shop", f: "1" }),
      node("y", "fortiswitch", { b: "Shop" }), // same building name, no area — distinct
    ]);
    expect(views.map((v) => v.key)).toEqual(["b||shop", "a|mine", "b|mine|shop", "f|mine|shop|1"]);
    expect(views.map((v) => v.label)).toEqual(["Shop", "Mine", "Mine — Shop", "Mine — Shop — 1"]);
  });

  it("adds one area view per area, ahead of its buildings, carrying the raw keys the switcher nests by", () => {
    const views = computeFloorViews([
      node("p1", "fortiswitch", { a: "Pugmill", b: "57 Loadout" }),
      node("p2", "fortiswitch", { a: "Pugmill", b: "CSB Loadout", f: "1" }),
      node("e1", "fortiswitch", { b: "Engineering" }),
    ]);
    expect(views.map((v) => v.key)).toEqual([
      "b||engineering",
      "a|pugmill", "b|pugmill|57 loadout", "b|pugmill|csb loadout", "f|pugmill|csb loadout|1",
    ]);
    expect(views[1]).toMatchObject({ kind: "area", areaKey: "pugmill", buildingKey: "", label: "Pugmill" });
    expect(views[4]).toMatchObject({ kind: "floor", areaKey: "pugmill", buildingKey: "csb loadout" });
  });

  it("an a: code alone earns no view — the switcher still appears only for b: / f:", () => {
    expect(computeFloorViews([node("x", "fortiswitch", { a: "Mine" })])).toEqual([]);
  });

  it("buckets f:-without-b: under an unnamed building, listed last", () => {
    const views = computeFloorViews([
      node("fg", "fortigate"),
      node("x", "fortiswitch", { f: "2" }),
      node("y", "fortiswitch", { b: "Shop", f: "1" }),
    ]);
    expect(views.map((v) => v.label)).toEqual(["Shop", "Shop — 1", "Floor 2"]);
    expect(views[2].key).toBe("f|||2");
  });

  it("orders floors underground-aware within a building", () => {
    const views = computeFloorViews([
      node("a", "fortiswitch", { b: "Shop", f: "2" }),
      node("b", "fortiswitch", { b: "Shop", f: "B1" }),
      node("c", "fortiswitch", { b: "Shop", f: "-2" }),
      node("d", "fortiswitch", { b: "Shop", f: "Mezzanine" }),
    ]);
    expect(views.filter((v) => v.kind === "floor").map((v) => v.floorName)).toEqual(["-2", "B1", "2", "Mezzanine"]);
  });
});

describe("partitionElementsForFloor", () => {
  const ids = (els: El[]) => els.filter((e) => !e.data.source).map((e) => e.data.id).sort();

  // Stubs (2026-11-07, operator: "each group should connect back to the
  // group of the previous level and next level"): one stub per NEIGHBOURING
  // GROUP, "← X" for a group this view is fed from (shallower than the member
  // it links to), "→ X" for one it feeds. A far end with no code at the view's
  // level shows as its nearest coded group, else as "Base".
  const G = (key: string) => "portal:group:" + key;

  it("floor view: that floor's devices, the FortiGate stub (s1 links to it), and the next floor's group", () => {
    const parts = partitionElementsForFloor(site(), "f||shop|1");
    expect(ids(parts)).toEqual(["ap1", "portal:fg", G("f||shop|2"), "s1"]);
    expect(parts.find((e) => e.data.id === G("f||shop|2"))!.data).toMatchObject({ isPortal: 1, label: "→ Shop — 2", targetView: "f||shop|2" });
  });

  it("building view: ALL of the building's devices, any floor; an untagged neighbour shows as Base", () => {
    const parts = partitionElementsForFloor(site(), "b||shop");
    expect(ids(parts)).toEqual(["ap1", "portal:fg", G("flat"), "s1", "s2"]);
    // s2's uplink partner "plain" is shallower (it hangs off the FortiGate): the previous level.
    expect(parts.find((e) => e.data.id === G("flat"))!.data).toMatchObject({ label: "← Base", targetView: "flat", isUpstreamPortal: 1 });
  });

  it("an untagged FortiGate is drawn only in Base: other views get a root portal jumping to Base", () => {
    const parts = partitionElementsForFloor(site(), "b||shop");
    expect(parts.some((e) => e.data.role === "fortigate")).toBe(false);
    const root = parts.find((e) => e.data.id === "portal:fg")!;
    expect(root.data).toMatchObject({ isPortal: 1, isRootPortal: 1, targetView: "flat", label: "→ Base: FG", remoteAssetId: "fg" });
    // fg↔s1 lands on the root portal; fg↔o1 / fg↔plain have no member end — gone.
    const edges = parts.filter((e) => e.data.source).map((e) => `${e.data.source}>${e.data.target}`);
    expect(edges).toContain("portal:fg>s1");
    expect(edges.some((t) => t.includes(">o1") || t.includes(">plain"))).toBe(false);
  });

  it("a FortiGate tagged into a view is drawn there as itself, without portal spray", () => {
    const els = site();
    els[0] = node("fg", "fortigate", { b: "Shop" });
    const parts = partitionElementsForFloor(els, "b||shop");
    expect(parts.find((e) => e.data.id === "fg")!.data.role).toBe("fortigate");
    // No stub from fg's own controller links (o1, plain); s2's link to plain is a member's.
    expect(ids(parts)).toEqual(["ap1", "fg", G("flat"), "s1", "s2"]);
  });

  it("building view: a member's link to another building becomes that building's group stub", () => {
    const els = site();
    els.push(edge("s2", "o1", { isLldp: 1 }));
    const parts = partitionElementsForFloor(els, "b||shop");
    const portal = parts.find((e) => e.data.id === G("b||office"))!;
    expect(portal.data.isPortal).toBe(1);
    expect(portal.data.targetView).toBe("b||office");
    // o1 hangs off the FortiGate, shallower than s2: Office is the previous level.
    expect(portal.data.label).toBe("← Office");
  });

  it("area view: every device in the area, a stub per next-level group — an area-less building included", () => {
    const els = [
      node("fg", "fortigate"),
      node("p1", "fortiswitch", { a: "Pugmill", b: "57 Loadout" }),
      node("p2", "fortiswitch", { a: "Pugmill", b: "CSB Loadout", f: "1" }),
      node("m1", "fortiswitch", { a: "Mine", b: "Shop" }),
      node("e1", "fortiswitch", { b: "Engineering" }),
      edge("fg", "p1"),
      edge("p1", "p2"),
      edge("p2", "m1"),
      edge("p1", "e1"),
    ];
    const parts = partitionElementsForFloor(els, "a|pugmill");
    expect(ids(parts)).toEqual(["p1", "p2", "portal:fg", G("a|mine"), G("b||engineering")]);
    expect(parts.find((e) => e.data.id === G("a|mine"))!.data).toMatchObject({ targetView: "a|mine", label: "→ Mine" });
    expect(parts.find((e) => e.data.id === G("b||engineering"))!.data).toMatchObject({ targetView: "b||engineering", label: "→ Engineering" });
  });

  it("a FortiGate tagged to another floor becomes a root portal jumping to that floor", () => {
    const els = site();
    els[0] = node("fg", "fortigate", { b: "Shop", f: "2" });
    const parts = partitionElementsForFloor(els, "f||shop|1");
    expect(ids(parts)).not.toContain("fg");
    expect(parts.find((e) => e.data.id === "portal:fg")!.data).toMatchObject({
      isRootPortal: 1,
      targetView: "f||shop|2",
      label: "→ Shop — 2: FG",
    });
    // ...and on its own floor it is the real node.
    expect(ids(partitionElementsForFloor(els, "f||shop|2"))).toContain("fg");
  });

  it("excludes untagged devices: links to them go to the Base group stub", () => {
    const parts = partitionElementsForFloor(site(), "f||shop|2");
    // Floor 2 is fed from floor 1 (s1) and from the untagged "plain" switch —
    // both shallower — and nothing on it links to the FortiGate.
    expect(ids(parts)).toEqual([G("flat"), G("f||shop|1"), "s2"]);
    expect(parts.find((e) => e.data.id === G("f||shop|1"))!.data.label).toBe("← Shop — 1");
    expect(parts.find((e) => e.data.id === G("flat"))!.data.label).toBe("← Base");
    expect(parts.some((e) => e.data.id === "plain")).toBe(false);
  });

  // Operator report (2026-11-07): drilling into Pugmill Loadouts showed a
  // "→ Base: FG" stub though no switch there links to the FortiGate — they
  // hang off Scale House, which is now the view's "←" stub.
  it("a view fed from another group shows that group, not the FortiGate, and is rooted on it", () => {
    const els = [
      node("fg", "fortigate"),
      node("sh", "fortiswitch", { b: "Scale House" }),
      node("p57", "fortiswitch", { a: "Pugmill", b: "57 Loudout" }),
      node("ap57", "fortiap", { a: "Pugmill", b: "57 Loudout" }),
      node("p8", "fortiswitch", { a: "Pugmill", b: "8s Loadout" }),
      edge("fg", "sh"), edge("sh", "p57"), edge("sh", "p8"), edge("p57", "ap57"),
    ];
    const parts = partitionElementsForFloor(els, "a|pugmill");
    expect(ids(parts)).toEqual(["ap57", "p57", "p8", G("b||scale house")]);
    expect(parts.find((e) => e.data.id === G("b||scale house"))!.data).toMatchObject({ label: "← Scale House", isUpstreamPortal: 1 });
    // Both switches link to it — two lines, not one.
    expect(parts.filter((e) => e.data.source === G("b||scale house") || e.data.target === G("b||scale house")).length).toBe(2);
    const cols = computeTopologyColumns(parts)!;
    expect(Object.keys(cols).sort()).toEqual(["ap57", "p57", "p8", G("b||scale house")]);
    // The stub it is fed from sits left of what it feeds.
    expect(cols[G("b||scale house")].depth).toBeLessThan(cols.p57.depth);
    expect(cols.ap57.depth).toBeGreaterThan(cols.p57.depth);
  });

  it("several upstream groups all sit in the first column", () => {
    const els = [
      node("fg", "fortigate"),
      node("sh", "fortiswitch", { b: "Scale House" }),
      node("oo", "fortiswitch", { b: "Old Office" }),
      node("p1", "fortiswitch", { a: "Pugmill", b: "57 Loudout" }),
      node("p2", "fortiswitch", { a: "Pugmill", b: "8s Loadout" }),
      node("t1", "fortiswitch", { b: "Tower 1" }),
      edge("fg", "sh"), edge("fg", "oo"), edge("sh", "p1"), edge("oo", "p2"), edge("p2", "t1"),
    ];
    const parts = partitionElementsForFloor(els, "a|pugmill");
    const cols = computeTopologyColumns(parts)!;
    expect(cols[G("b||scale house")].depth).toBe(cols[G("b||old office")].depth);
    expect(cols[G("b||scale house")].depth).toBeLessThan(cols.p1.depth);
    expect(parts.find((e) => e.data.id === G("b||tower 1"))!.data.label).toBe("→ Tower 1");
    expect(cols[G("b||tower 1")].depth).toBeGreaterThan(cols.p2.depth);
  });

  it("rewires a cross-floor edge to the remote floor's group stub, with a jump target", () => {
    const parts = partitionElementsForFloor(site(), "f||shop|1");
    const portal = parts.find((e) => e.data.id === G("f||shop|2"))!;
    expect(portal.data.isPortal).toBe(1);
    expect(portal.data.targetView).toBe("f||shop|2");
    const rewired = parts.find((e) => e.data.source === "s1" && e.data.target === G("f||shop|2"));
    expect(rewired).toBeTruthy();
  });

  it("converges every link to one remote group on a single stub, one line per link", () => {
    const els = site();
    els.push(edge("ap1", "s2", { isLldp: 1 })); // second edge crossing to floor 2
    const parts = partitionElementsForFloor(els, "f||shop|1");
    expect(parts.filter((e) => e.data.id === G("f||shop|2")).length).toBe(1);
    const portalEdges = parts.filter((e) => e.data.source && e.data.target === G("f||shop|2"));
    expect(portalEdges.length).toBe(2);
  });

  it("preserves edge flags (loop halos survive the partition)", () => {
    const els = site();
    const s1s2 = els.find((e) => e.data.id === "e-s1-s2")!;
    s1s2.data.inLoop = 1;
    const parts = partitionElementsForFloor(els, "f||shop|1");
    const rewired = parts.find((e) => e.data.source === "s1" && e.data.target === G("f||shop|2"))!;
    expect(rewired.data.inLoop).toBe(1);
    expect(rewired.data.isIface).toBe(1);
  });

  it("does not mutate the input element set", () => {
    const els = site();
    const snapshot = JSON.parse(JSON.stringify(els));
    partitionElementsForFloor(els, "f||shop|1");
    expect(els).toEqual(snapshot);
  });

  it("produces a subgraph the column solver can lay out (rooted on the FG portal, stubs as leaves)", () => {
    const cols = computeTopologyColumns(partitionElementsForFloor(site(), "f||shop|1"))!;
    expect(cols).toBeTruthy();
    expect(cols["portal:fg"].depth).toBe(0);
    expect(cols.s1.depth).toBe(2);
    // The next floor's stub (no role → leaf weight) hangs in the odd column right of s1.
    expect(cols["portal:group:f||shop|2"].depth).toBe(3);
    expect(cols.ap1.depth).toBe(3);
  });
});

describe("viewSwitcherRows — Base, then the next level under each selection", () => {
  type Chip = { key: string; label: string; title: string; active: boolean };
  const labels = (rows: Chip[][]) => rows.map((r) => r.map((c) => c.label));
  const lit = (rows: Chip[][]) => rows.flat().filter((c) => c.active).map((c) => c.label);
  // Pugmill area with two loadouts (one with floors) + two area-less buildings.
  const plant = () => computeFloorViews([
    node("fg", "fortigate"),
    node("p1", "fortiswitch", { a: "Pugmill", b: "57 Loadout" }),
    node("p2", "fortiswitch", { a: "Pugmill", b: "CSB Loadout", f: "1" }),
    node("p3", "fortiswitch", { a: "Pugmill", b: "CSB Loadout", f: "2" }),
    node("e1", "fortiswitch", { b: "Engineering" }),
    node("f1", "fortiswitch", { b: "Fan" }),
  ]);

  it("on Base: 'Base' alone, then the areas and area-less buildings — no buildings of an area yet", () => {
    const rows = viewSwitcherRows(plant(), "flat");
    expect(labels(rows)).toEqual([["Base"], ["Pugmill", "Engineering", "Fan"]]);
    expect(rows[0][0].key).toBe("flat");
    expect(lit(rows)).toEqual(["Base"]);
  });

  it("selecting an area lists its buildings underneath, named without the area prefix", () => {
    const rows = viewSwitcherRows(plant(), "a|pugmill");
    expect(labels(rows)).toEqual([["Base"], ["Pugmill", "Engineering", "Fan"], ["57 Loadout", "CSB Loadout"]]);
    expect(lit(rows)).toEqual(["Pugmill"]);
  });

  it("selecting a building with floors lists its floors, and the whole path stays lit", () => {
    const building = viewSwitcherRows(plant(), "b|pugmill|csb loadout");
    expect(labels(building)[3]).toEqual(["1", "2"]);
    expect(lit(building)).toEqual(["Pugmill", "CSB Loadout"]);
    const floor = viewSwitcherRows(plant(), "f|pugmill|csb loadout|2");
    expect(labels(floor)).toHaveLength(4);
    expect(lit(floor)).toEqual(["Pugmill", "CSB Loadout", "2"]);
  });

  it("a building with no floors adds no row", () => {
    expect(viewSwitcherRows(plant(), "b|pugmill|57 loadout")).toHaveLength(3);
    expect(viewSwitcherRows(plant(), "b||engineering")).toHaveLength(2);
  });

  it("with no areas, the buildings are the first level and a building's floors follow it", () => {
    const rows = viewSwitcherRows(computeFloorViews(site()), "b||shop");
    expect(labels(rows)).toEqual([["Base"], ["Office", "Shop"], ["1", "2"]]);
    expect(rows[1][1]).toMatchObject({ key: "b||shop", active: true });
  });

  it("an unknown active key falls back to Base being lit", () => {
    expect(lit(viewSwitcherRows(plant(), "b|gone|x"))).toEqual(["Base"]);
  });
});

// Operator (2026-11-09): "if an asset skips a group, then I'd like to see the
// next group in the drill down" — an area holding a room with no building
// offered only its buildings, and rooms / junction boxes had no views at all.
describe("drill-down through every level, skipping the ones a device does not have", () => {
  type Chip = { key: string; label: string; title: string; active: boolean };
  const labels = (rows: Chip[][]) => rows.map((r) => r.map((c) => c.label));
  const quarry = () => [
    node("fg", "fortigate"),
    node("s1", "fortiswitch", { a: "Mine", b: "Shop", f: "1", r: "IDF", jb: "112" }),
    node("s2", "fortiswitch", { a: "Mine", r: "North Closet" }), // area › room
    node("s3", "fortiswitch", { a: "Mine", b: "Shop", jb: "305" }), // building › jb
    node("s4", "fortiswitch", { b: "Office", f: "2" }),
    edge("fg", "s1"), edge("s1", "s2"), edge("s1", "s3"), edge("fg", "s4"),
  ];

  it("gives every room and junction box a view, nested under the nearest level the device has", () => {
    const views = computeFloorViews(quarry()) as unknown as { key: string; kind: string; parentKey: string | null; name: string; label: string }[];
    const byKey = Object.fromEntries(views.map((v) => [v.key, v]));
    expect(byKey["r|mine|||north closet"]).toMatchObject({ kind: "room", parentKey: "a|mine", name: "North Closet", label: "Mine — North Closet" });
    expect(byKey["jb|mine|shop|||305"]).toMatchObject({ kind: "jb", parentKey: "b|mine|shop", name: "305" });
    expect(byKey["r|mine|shop|1|idf"]).toMatchObject({ parentKey: "f|mine|shop|1" });
    expect(byKey["jb|mine|shop|1|idf|112"]).toMatchObject({ parentKey: "r|mine|shop|1|idf", label: "Mine — Shop — 1 — IDF — 112" });
  });

  it("a rack (ra:) is a level between room and junction box; a jb outside a rack keeps its old key", () => {
    const views = computeFloorViews([
      node("fw", "fortigate"),
      node("s1", "fortiswitch", { b: "Shop", r: "MDF", ra: "R2", jb: "7" }),
      node("s2", "fortiswitch", { b: "Shop", r: "MDF", jb: "8" }),
    ]) as unknown as { key: string; kind: string; parentKey: string | null; label: string }[];
    const byKey = Object.fromEntries(views.map((v) => [v.key, v]));
    expect(byKey["ra||shop||mdf|r2"]).toMatchObject({ kind: "ra", parentKey: "r||shop||mdf", label: "Shop — MDF — R2" });
    expect(byKey["jb||shop||mdf|r2|7"]).toMatchObject({ kind: "jb", parentKey: "ra||shop||mdf|r2" });
    // No rack: exactly the key a junction box had before ra: existed.
    expect(byKey["jb||shop||mdf|8"]).toMatchObject({ kind: "jb", parentKey: "r||shop||mdf" });
  });

  it("an area lists its buildings AND a room tagged straight in it", () => {
    expect(labels(viewSwitcherRows(computeFloorViews(quarry()), "a|mine"))).toEqual([
      ["Base"], ["Mine", "Office"], ["Shop", "North Closet"],
    ]);
  });

  it("a building lists its floors AND a junction box tagged straight in it; drilling goes on to rooms and jbs", () => {
    const views = computeFloorViews(quarry());
    expect(labels(viewSwitcherRows(views, "b|mine|shop"))[3]).toEqual(["1", "305"]);
    const jb = viewSwitcherRows(views, "jb|mine|shop|1|idf|112");
    expect(labels(jb)).toEqual([["Base"], ["Mine", "Office"], ["Shop", "North Closet"], ["1", "305"], ["IDF"], ["112"]]);
    expect(jb.flat().filter((c) => c.active).map((c) => c.label)).toEqual(["Mine", "Shop", "1", "IDF", "112"]);
  });

  it("a room view holds that room's devices and its jbs; links out become group stubs", () => {
    const parts = partitionElementsForFloor(quarry(), "r|mine|||north closet");
    const ids = parts.filter((e) => !e.data.source).map((e) => e.data.id).sort();
    // s1 is in room IDF: the stub names its room.
    expect(ids).toEqual(["portal:group:r|mine|shop|1|idf", "s2"]);
    expect(partitionElementsForFloor(quarry(), "r|mine|shop|1|idf").some((e) => e.data.id === "s1")).toBe(true);
  });

  it("each view hides its own box level and every level above it", () => {
    expect(viewSuppressKinds("flat")).toBeNull();
    expect(viewSuppressKinds("a|mine")).toEqual(["area"]);
    expect(viewSuppressKinds("f|mine|shop|1")).toEqual(["area", "building", "floor"]);
    expect(viewSuppressKinds("r|mine|||north closet")).toEqual(["area", "building", "floor", "room"]);
    expect(viewSuppressKinds("ra|mine|shop|||r2")).toEqual(["area", "building", "floor", "room", "ra"]);
    expect(viewSuppressKinds("jb|mine|shop|||305")).toEqual(["area", "building", "floor", "room", "ra", "jb"]);
  });
});
