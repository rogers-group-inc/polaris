/**
 * tests/unit/topologyNodeSeparation.test.ts
 *
 * No two devices on one spot on the Device Map: separatePositions (pure) and
 * separateNodes (live Cytoscape) in public/js/topology-render.js. A device
 * dropped or snapped onto another moves to the nearest free spot on its own
 * lattice; the device already there — and every device not being moved —
 * holds its spot. Runs the vendored Cytoscape headless in a vm context with
 * inputs built inside the context (see topologyRouteBendClearance.test.ts).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

type Pt = { x: number; y: number };
type Item = { id: string; x: number; y: number; w: number; h: number };
let sb: Record<string, any>;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  sb = { window: { addEventListener() {}, removeEventListener() {} }, setTimeout, clearTimeout, console };
  sb.self = sb.window;
  vm.createContext(sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/vendor/cytoscape.min.js"), "utf8"), sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/topology-render.js"), "utf8"), sb);
  vm.runInContext(
    "function sepPos(j) { var a = JSON.parse(j); return JSON.stringify(window.PolarisTopologyRender.separatePositions(a.items, a.opts)); }" +
    "function sepNodes(j) {" +
    "  var R = window.PolarisTopologyRender; var spec = JSON.parse(j);" +
    "  var els = spec.nodes.map(function (n) { return { data: Object.assign({ role: 'fortiswitch', nodeColor: '#2e7d32' }, n.data), position: n.position }; });" +
    "  var cy = cytoscape({ headless: true, styleEnabled: true, elements: els, layout: { name: 'preset' }, style: R.topologyStylesheet('dark', {}) });" +
    "  var moved = spec.moved ? spec.moved.map(function (id) { return cy.getElementById(id); }) : undefined;" +
    "  var count = R.separateNodes(cy, moved, spec.opts);" +
    "  var out = { count: count, pos: {} };" +
    "  cy.nodes().forEach(function (n) { out.pos[n.id()] = { x: n.position('x'), y: n.position('y') }; });" +
    "  cy.destroy(); return JSON.stringify(out); }",
    sb,
  );
});

const GRID = { stepX: 130, stepY: 95 };

function sepPos(items: Item[], opts: Record<string, unknown> = GRID): Record<string, Pt> {
  return JSON.parse(sb.sepPos(JSON.stringify({ items, opts })));
}
function sepNodes(spec: unknown): { count: number; pos: Record<string, Pt> } {
  return JSON.parse(sb.sepNodes(JSON.stringify(spec)));
}

function overlaps(a: Item, b: Item, gap = 6): boolean {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + gap;
}

describe("separatePositions", () => {
  it("leaves devices that do not overlap where they are", () => {
    const items: Item[] = [
      { id: "a", x: 0, y: 0, w: 44, h: 44 },
      { id: "b", x: 130, y: 0, w: 44, h: 44 },
      { id: "c", x: 0, y: 95, w: 44, h: 44 },
    ];
    expect(sepPos(items)).toEqual({ a: { x: 0, y: 0 }, b: { x: 130, y: 0 }, c: { x: 0, y: 95 } });
  });

  it("moves the LATER of two devices on the same x/y to the nearest free grid cell", () => {
    const out = sepPos([
      { id: "a", x: 260, y: 190, w: 44, h: 44 },
      { id: "b", x: 260, y: 190, w: 44, h: 44 },
    ]);
    expect(out.a).toEqual({ x: 260, y: 190 });
    // Nearest whole-cell offset is one row (95 < 130), down before up.
    expect(out.b).toEqual({ x: 260, y: 285 });
  });

  it("never moves a fixed device, and skips cells fixed devices hold", () => {
    const out = sepPos([{ id: "m", x: 0, y: 0, w: 44, h: 44 }], {
      ...GRID,
      fixed: [
        { x: 0, y: 0, w: 44, h: 44 },
        { x: 0, y: 95, w: 44, h: 44 },
        { x: 0, y: -95, w: 44, h: 44 },
      ],
    });
    expect(out.m).toEqual({ x: 130, y: 0 });
  });

  it("treats overlapping bodies (not just equal x/y) as the same spot", () => {
    const out = sepPos([
      { id: "a", x: 0, y: 0, w: 64, h: 64 },
      { id: "b", x: 30, y: 10, w: 44, h: 44 },
    ], { stepX: 130 / 4, stepY: 95 / 4 });
    const a = { id: "a", w: 64, h: 64, ...out.a };
    const b = { id: "b", w: 44, h: 44, ...out.b };
    expect(out.a).toEqual({ x: 0, y: 0 });
    expect(overlaps(a, b)).toBe(false);
    // A quarter-cell lattice nudges rather than jumping a whole cell away.
    expect(Math.hypot(out.b.x - 30, out.b.y - 10)).toBeLessThan(130);
  });

  it("separates a whole pile-up so no pair overlaps, deterministically", () => {
    const items: Item[] = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, x: 130, y: 95, w: 44, h: 44 }));
    const out = sepPos(items);
    const placed = items.map((it) => ({ ...it, ...out[it.id] }));
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) expect(overlaps(placed[i], placed[j])).toBe(false);
      // Stays on the grid lattice.
      expect(Math.abs(placed[i].x % 130)).toBe(0);
      expect(Math.abs(placed[i].y % 95)).toBe(0);
    }
    expect(sepPos(items)).toEqual(out);
  });

  it("finds a big neighbour whose centre is several buckets away", () => {
    // A 300px-wide body centred 200px left still covers x=0.
    const out = sepPos([{ id: "m", x: 0, y: 0, w: 20, h: 20 }], {
      stepX: 10, stepY: 10, fixed: [{ x: -200, y: 0, w: 420, h: 20 }],
    });
    expect(overlaps({ id: "m", w: 20, h: 20, ...out.m }, { id: "f", x: -200, y: 0, w: 420, h: 20 })).toBe(false);
  });
});

describe("separateNodes (live Cytoscape)", () => {
  const node = (id: string, x: number, y: number, data: Record<string, unknown> = {}) =>
    ({ data: { id, label: id, ...data }, position: { x, y } });

  it("moves the dropped device off the one already there, not the other way round", () => {
    const r = sepNodes({
      nodes: [node("still", 0, 0), node("dropped", 0, 0)],
      moved: ["dropped"],
      opts: GRID,
    });
    expect(r.count).toBe(1);
    expect(r.pos.still).toEqual({ x: 0, y: 0 });
    expect(r.pos.dropped).not.toEqual({ x: 0, y: 0 });
  });

  it("ignores group boxes, floor portals and line handles", () => {
    const r = sepNodes({
      nodes: [
        node("dev", 0, 0),
        node("hull", 0, 0, { isLocGroup: 1 }),
        node("portal", 0, 0, { isPortal: 1 }),
        node("handle", 0, 0, { isEdgeHandle: 1 }),
      ],
      opts: GRID,
    });
    expect(r.count).toBe(0);
    expect(r.pos.dev).toEqual({ x: 0, y: 0 });
  });

  it("with no moved list, re-checks every device — first in graph order keeps its spot", () => {
    const r = sepNodes({
      nodes: [node("a", 130, 0), node("b", 130, 0), node("c", 130, 0)],
      opts: GRID,
    });
    expect(r.count).toBe(2);
    expect(r.pos.a).toEqual({ x: 130, y: 0 });
    const pts = Object.values(r.pos).map((p) => `${p.x},${p.y}`);
    expect(new Set(pts).size).toBe(3);
  });
});
