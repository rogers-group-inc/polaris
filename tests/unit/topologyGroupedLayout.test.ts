/**
 * tests/unit/topologyGroupedLayout.test.ts
 *
 * Quotient (two-level) layout for location-coded sites —
 * computeGroupedLayout in public/js/topology-render.js (browser IIFE loaded
 * in a Node vm context, same harness as topologyColumns.test.ts).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

type El = { data: Record<string, any> };
type Pos = Record<string, { depth: number; lane: number }>;

let computeGroupedLayout: (els: El[], opts?: { aspect?: number }) => Pos | null;
let layoutAspect: (el: unknown) => number | undefined;
let computeTopologyColumns: (els: El[]) => Pos | null;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../../public/js/topology-render.js");
  const code = readFileSync(file, "utf8");
  const sandbox: { window: Record<string, any> } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const api = sandbox.window.PolarisTopologyRender;
  computeGroupedLayout = api.computeGroupedLayout;
  computeTopologyColumns = api.computeTopologyColumns;
  layoutAspect = api.layoutAspect;
});

const node = (id: string, role: string, loc?: { a?: string; b?: string; f?: string }): El => ({
  data: {
    id,
    role,
    ...(loc?.a ? { locA: loc.a.toLowerCase(), locAName: loc.a } : {}),
    ...(loc?.b ? { locB: loc.b.toLowerCase(), locBName: loc.b } : {}),
    ...(loc?.f ? { locF: loc.f.toLowerCase(), locFName: loc.f } : {}),
  },
});
const edge = (source: string, target: string): El => ({
  data: { id: `e-${source}-${target}`, source, target, isIface: 1 },
});

// Bounding box of a set of node ids in a layout.
function box(pos: Pos, ids: string[]) {
  const xs = ids.map((i) => pos[i].depth);
  const ys = ids.map((i) => pos[i].lane);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}
function disjoint(a: ReturnType<typeof box>, b: ReturnType<typeof box>) {
  return a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1;
}

// A RIVERBEND-shaped miniature: FG in Scale House; a deep chain into the
// Mine building whose members sit far right in GLOBAL depth; a mid-chain
// untagged switch; a small QC Lab building; a FortiLink fallback.
const site = (): El[] => {
  const els = [
    node("fg", "fortigate", { b: "Scale House" }),
    node("sh1", "fortiswitch", { b: "Scale House" }),
    node("sh2", "fortiswitch", { b: "Scale House" }),
    node("shap", "fortiap", { b: "Scale House" }),
    node("mid", "fortiswitch"), // untagged mid-chain hop
    node("m1", "fortiswitch", { b: "Mine", f: "Surface" }),
    node("m2", "fortiswitch", { b: "Mine", f: "Surface" }),
    node("m3", "fortiswitch", { b: "Mine", f: "Slope" }),
    node("map1", "fortiap", { b: "Mine", f: "Surface" }),
    node("map2", "fortiap", { b: "Mine", f: "Slope" }),
    node("qc1", "fortiswitch", { b: "QC Lab" }),
    node("qcap", "fortiap", { b: "QC Lab" }),
    node("fb", "fortiswitch"), // FortiLink fallback (controller edge only)
    edge("fg", "sh1"),
    edge("sh1", "sh2"),
    edge("sh1", "shap"),
    edge("sh2", "mid"),
    edge("mid", "m1"),
    edge("m1", "m2"),
    edge("m2", "m3"),
    edge("m1", "map1"),
    edge("m3", "map2"),
    edge("fg", "qc1"),
    edge("qc1", "qcap"),
  ];
  els.push({ data: { id: "c-fg-fb", source: "fg", target: "fb" } }); // unverified controller edge
  return els;
};

const SCALE = ["fg", "sh1", "sh2", "shap"];
const MINE = ["m1", "m2", "m3", "map1", "map2"];
const QC = ["qc1", "qcap"];
const UNGROUPED = ["mid", "fb"];

describe("computeGroupedLayout", () => {
  it("returns null when the flat solver has no FortiGate root", () => {
    expect(computeGroupedLayout([node("sw", "fortiswitch", { b: "Shop" })])).toBeNull();
  });

  it("keeps location boxes pairwise disjoint", () => {
    const pos = computeGroupedLayout(site())!;
    const boxes = [SCALE, MINE, QC].map((ids) => box(pos, ids));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(disjoint(boxes[i], boxes[j])).toBe(true);
      }
    }
  });

  it("orders boxes by level (the FG's box leftmost of the coded boxes)", () => {
    const pos = computeGroupedLayout(site())!;
    const scale = box(pos, SCALE);
    const mine = box(pos, MINE);
    // Scale House contains the FG (entry) — its box starts left of Mine's.
    expect(scale.x1).toBeLessThan(mine.x1);
  });

  it("keeps each chain flowing left to right inside its box", () => {
    const pos = computeGroupedLayout(site())!;
    const flat = computeTopologyColumns(site())!;
    // Chain m1 → m2 → m3 keeps strictly increasing x in both layouts.
    expect(pos.m1.depth).toBeLessThan(pos.m2.depth);
    expect(pos.m2.depth).toBeLessThan(pos.m3.depth);
    expect(flat.m1.depth).toBeLessThan(flat.m2.depth);
    // APs stay right of their parent switch.
    expect(pos.map1.depth).toBeGreaterThan(pos.m1.depth);
    expect(pos.map2.depth).toBeGreaterThan(pos.m3.depth);
  });

  it("covers every node exactly once", () => {
    const pos = computeGroupedLayout(site())!;
    const all = [...SCALE, ...MINE, ...QC, ...UNGROUPED];
    all.forEach((id) => expect(pos[id]).toBeTruthy());
    expect(Object.keys(pos).sort()).toEqual([...all].sort());
  });

  it("is deterministic across repeated calls", () => {
    const els = site();
    expect(computeGroupedLayout(els)).toEqual(computeGroupedLayout(els));
  });

  it("groups by area when present — buildings sharing an area share one box", () => {
    const els = [
      node("fg", "fortigate", { b: "HQ" }),
      node("x1", "fortiswitch", { a: "Mine", b: "Shop" }),
      node("x2", "fortiswitch", { a: "Mine", b: "Office" }),
      node("y1", "fortiswitch", { b: "Depot" }),
      edge("fg", "x1"),
      edge("x1", "x2"),
      edge("fg", "y1"),
    ];
    const pos = computeGroupedLayout(els)!;
    const mineBox = box(pos, ["x1", "x2"]);
    const depotBox = box(pos, ["y1"]);
    const hqBox = box(pos, ["fg"]);
    expect(disjoint(mineBox, depotBox)).toBe(true);
    expect(disjoint(mineBox, hqBox)).toBe(true);
  });
  it("lays out an untagged site too, so the first code never switches layouts", () => {
    const pos = computeGroupedLayout([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("ap", "fortiap"),
      edge("fg", "sw"),
      edge("sw", "ap"),
    ])!;
    expect(pos).not.toBeNull();
    expect(pos.fg.depth).toBeLessThan(pos.sw.depth);
    expect(pos.sw.depth).toBeLessThan(pos.ap.depth);
    // Each device sits on the row of the device it hangs off.
    expect(pos.sw.lane).toBe(pos.fg.lane);
    expect(pos.ap.lane).toBe(pos.sw.lane);
  });

  it("gives a box the level of its shallowest device", () => {
    // East holds a level-2 device (behind sw1); West holds the level-1 one.
    const els = [
      node("fg", "fortigate"),
      node("sw1", "fortiswitch", { a: "West" }),
      node("sw2", "fortiswitch", { a: "East" }),
      node("sw3", "fortiswitch", { a: "West" }),
      edge("fg", "sw1"),
      edge("sw1", "sw2"),
      edge("sw2", "sw3"),
    ];
    const pos = computeGroupedLayout(els)!;
    const west = box(pos, ["sw1", "sw3"]);
    const east = box(pos, ["sw2"]);
    expect(west.x1).toBeLessThan(east.x1); // level 1 before level 2
    expect(disjoint(west, east)).toBe(true);
  });

  it("nests boxes: a building lies inside its area, clear of its sibling", () => {
    const els = [
      node("fg", "fortigate"),
      node("a1", "fortiswitch", { a: "Mine" }),
      node("b1", "fortiswitch", { a: "Mine", b: "Shop" }),
      node("b2", "fortiap", { a: "Mine", b: "Shop" }),
      node("c1", "fortiswitch", { a: "Mine", b: "Office" }),
      edge("fg", "a1"),
      edge("a1", "b1"),
      edge("b1", "b2"),
      edge("a1", "c1"),
    ];
    const pos = computeGroupedLayout(els)!;
    const mine = box(pos, ["a1", "b1", "b2", "c1"]);
    const shop = box(pos, ["b1", "b2"]);
    const office = box(pos, ["c1"]);
    expect(shop.x1).toBeGreaterThanOrEqual(mine.x1);
    expect(shop.x2).toBeLessThanOrEqual(mine.x2);
    // Sibling buildings: half a cell of margin each, so never overlapping.
    expect(disjoint(shop, office)).toBe(true);
    expect(Math.abs(pos.b1.lane - pos.c1.lane)).toBeGreaterThanOrEqual(1);
  });

  it("keeps every device on the half-cell grid (the 65 px snap lattice)", () => {
    const pos = computeGroupedLayout(site())!;
    Object.values(pos).forEach((p) => {
      expect((p.depth * 2) % 1).toBe(0);
      expect((p.lane * 2) % 1).toBe(0);
    });
  });

  it("adding a code to one device leaves the shallower boxes where they were", () => {
    const before = computeGroupedLayout(site())!;
    // Tag the untagged mid-chain hop into its own new building.
    const els = site().map((el) =>
      el.data.id === "mid" ? node("mid", "fortiswitch", { b: "Pump House" }) : el,
    );
    const after = computeGroupedLayout(els)!;
    // Scale House (the FG's box, level 0) and QC Lab (hangs off the FG) sit
    // at shallower levels than the hop — neither moves.
    [...SCALE, ...QC].forEach((id) => expect(after[id]).toEqual(before[id]));
  });

  it("keeps a switch chain on one flat row; APs between step below it", () => {
    // sw's child switch skips the AP column: the spine (fg → sw → sw2) keeps
    // one row, and the APs in the column it crosses stack under it, so the
    // straight link never runs through a device.
    const els = [
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("ap", "fortiap"),
      node("ap2", "fortiap"),
      node("sw2", "fortiswitch"),
      edge("fg", "sw"),
      edge("sw", "ap"),
      edge("sw", "ap2"),
      edge("sw", "sw2"),
    ];
    const pos = computeGroupedLayout(els)!;
    expect(pos.sw.lane).toBe(pos.fg.lane);
    expect(pos.sw2.lane).toBe(pos.sw.lane);
    expect(pos.ap.lane).not.toBe(pos.sw.lane);
    expect(pos.ap2.lane).not.toBe(pos.sw.lane);
    expect(pos.ap.lane).not.toBe(pos.ap2.lane);
  });
  it("puts a branch beside its uplink, not past a wide sibling box", () => {
    // Scale House feeds a long Mine chain, and — one hop deeper, through a
    // second Scale House switch — a small Tower 1. With site-wide columns
    // Tower 1 (a level deeper than Mine) had to start past Mine's right
    // edge; now it sits next to its uplink and only Mine's rows push it.
    const els = [
      node("fg", "fortigate"),
      node("core", "fortiswitch", { b: "Scale House" }),
      node("sh2", "fortiswitch", { b: "Scale House" }),
      ...["m1", "m2", "m3", "m4", "m5", "m6"].map((id) => node(id, "fortiswitch", { a: "Mine", b: "Underground" })),
      node("t1", "fortiswitch", { b: "Tower 1" }),
      node("t1ap", "fortiap", { b: "Tower 1" }),
      edge("fg", "core"),
      edge("core", "m1"), edge("m1", "m2"), edge("m2", "m3"), edge("m3", "m4"), edge("m4", "m5"), edge("m5", "m6"),
      edge("core", "sh2"), edge("sh2", "t1"), edge("t1", "t1ap"),
    ];
    const pos = computeGroupedLayout(els)!;
    const mine = box(pos, ["m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(pos.t1.depth).toBeLessThan(mine.x2);
    expect(pos.t1.depth).toBeGreaterThan(pos.sh2.depth);
    expect(pos.t1.depth - pos.sh2.depth).toBeLessThanOrEqual(2);
    // ...and off Mine's rows, so its box and Mine's never overlap.
    expect(pos.t1.lane < mine.y1 || pos.t1.lane > mine.y2).toBe(true);
  });
  it("lays a deep site out to the shape of its window: wide for a wide screen, tall for a phone", () => {
    // A core feeding eight buildings, each a switch chain three deep with
    // an AP: with no aspect weighting it stacked into a tall column
    // (operator screenshot 2026-11-07, on a 16:9 screen).
    const els: El[] = [node("fg", "fortigate"), node("core", "fortiswitch", { b: "Core" }), edge("fg", "core")];
    for (let i = 0; i < 8; i++) {
      const b = { b: "Building " + i };
      els.push(node(`s${i}a`, "fortiswitch", b), node(`s${i}b`, "fortiswitch", b), node(`s${i}c`, "fortiswitch", b), node(`ap${i}`, "fortiap", b));
      els.push(edge("core", `s${i}a`), edge(`s${i}a`, `s${i}b`), edge(`s${i}b`, `s${i}c`), edge(`s${i}c`, `ap${i}`));
    }
    const shape = (pos: Pos) => {
      const b = box(pos, Object.keys(pos));
      return (b.x2 - b.x1 + 1) / (b.y2 - b.y1 + 1);
    };
    const wide = shape(computeGroupedLayout(els, { aspect: 16 / 9 })!);
    const tall = shape(computeGroupedLayout(els, { aspect: 9 / 16 })!);
    expect(wide).toBeGreaterThan(1);
    expect(tall).toBeLessThan(wide);
    // No aspect given: laid out for 16:9.
    expect(shape(computeGroupedLayout(els)!)).toBeCloseTo(wide, 5);
  });
  it("reads the aspect from the container, or none when it has no size", () => {
    expect(layoutAspect({ clientWidth: 1600, clientHeight: 900 })).toBeCloseTo(16 / 9, 5);
    expect(layoutAspect({ clientWidth: 0, clientHeight: 900 })).toBeUndefined();
    expect(layoutAspect(null)).toBeUndefined();
  });
  it("never puts a device on the straight line between two linked devices", () => {
    // Operator report (2026-11-07): PUG57 → its AP → PUG8 read as one chain
    // on one row. Every same-row link is a corridor, sideways links too.
    const els = [
      node("fg", "fortigate"), node("sh2", "fortiswitch", { b: "Scale House" }),
      node("pug57", "fortiswitch", { a: "Pugmill", b: "57 Loudout" }), node("ap57", "fortiap", { a: "Pugmill", b: "57 Loudout" }),
      node("pug8", "fortiswitch", { a: "Pugmill", b: "8s Loadout" }),
      node("csb", "fortiswitch", { a: "Pugmill", b: "CSB Loadout" }), node("apcsb", "fortiap", { a: "Pugmill", b: "CSB Loadout" }),
      edge("fg", "sh2"), edge("sh2", "pug57"), edge("sh2", "pug8"), edge("pug57", "ap57"),
      edge("pug57", "pug8"), edge("pug8", "csb"), edge("csb", "apcsb"), edge("pug57", "csb"),
    ];
    const pos = computeGroupedLayout(els)!;
    const ids = Object.keys(pos);
    for (const e of els.filter((x) => x.data.source)) {
      const a = pos[e.data.source as string], b = pos[e.data.target as string];
      if (a.lane !== b.lane) continue;
      for (const id of ids) {
        if (id === e.data.source || id === e.data.target) continue;
        const p = pos[id];
        const between = p.lane === a.lane && p.depth > Math.min(a.depth, b.depth) && p.depth < Math.max(a.depth, b.depth);
        expect(between, `${id} sits on ${e.data.source}–${e.data.target}`).toBe(false);
      }
    }
  });
  it("puts devices with no link in a strip under the site", () => {
    const els = [
      node("fg", "fortigate"), node("sw", "fortiswitch"), node("ap", "fortiap"),
      node("zz", "fortiswitch"), node("aa", "fortiap"),
      edge("fg", "sw"), edge("sw", "ap"),
    ];
    const pos = computeGroupedLayout(els)!;
    const linkedBottom = Math.max(pos.fg.lane, pos.sw.lane, pos.ap.lane);
    expect(pos.aa.lane).toBeGreaterThan(linkedBottom);
    expect(pos.zz.lane).toBe(pos.aa.lane);
    expect(pos.aa.depth).toBeLessThan(pos.zz.depth); // by name, from the left
    expect(Math.min(pos.aa.depth, pos.zz.depth)).toBe(Math.min(pos.fg.depth, pos.sw.depth, pos.ap.depth));
  });
  it("keeps a link that leaves a box clear of the devices inside it", () => {
    // SW-CORE (in Scale House) links out to the Mine box; the AP beside it in
    // Scale House must not sit on that row.
    const els = [
      node("fg", "fortigate", { b: "Scale House" }),
      node("core", "fortiswitch", { b: "Scale House" }),
      node("ap", "fortiap", { b: "Scale House" }),
      node("m1", "fortiswitch", { a: "Mine" }),
      edge("fg", "core"),
      edge("core", "ap"),
      edge("core", "m1"),
    ];
    const pos = computeGroupedLayout(els)!;
    expect(pos.m1.lane).toBe(pos.core.lane);
    expect(pos.ap.lane).not.toBe(pos.core.lane);
  });
});
