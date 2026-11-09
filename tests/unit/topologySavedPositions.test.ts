/**
 * tests/unit/topologySavedPositions.test.ts
 *
 * applySavedPositions + renderLocationGroups({ fixedIds }) in
 * public/js/topology-render.js — the saved-layout half of the level layout,
 * shared by the Device Map page, the phone topology tab and the dashboard
 * Device Map widget. Saved devices keep their saved spots and are never
 * pushed by the box-overlap pass; a device the save has no spot for lands
 * at its level-layout offset from its nearest saved upstream device.
 * Vendored Cytoscape runs headless in a vm context (inputs built inside it —
 * see topologyRouteBendClearance.test.ts).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

type Pt = { x: number; y: number };
let sb: Record<string, any>;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  sb = { window: { addEventListener() {}, removeEventListener() {} }, setTimeout, clearTimeout, console };
  sb.self = sb.window;
  vm.createContext(sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/vendor/cytoscape.min.js"), "utf8"), sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/topology-render.js"), "utf8"), sb);
  vm.runInContext(
    "function run(j) {" +
    "  var R = window.PolarisTopologyRender; var spec = JSON.parse(j);" +
    "  var els = spec.elements.map(function (e) { return { data: Object.assign({}, e) }; });" +
    "  var cols = R.computeGroupedLayout(els); var pos = {};" +
    "  Object.keys(cols).forEach(function (id) { pos[id] = { x: cols[id].depth * 130, y: cols[id].lane * 130 }; });" +
    "  var cy = cytoscape({ headless: true, styleEnabled: true, elements: els, style: R.topologyStylesheet('dark', {}) });" +
    "  var auto = {};" +
    "  cy.one('layoutstop', function () {" +
    "    cy.nodes().forEach(function (n) { auto[n.id()] = { x: n.position('x'), y: n.position('y') }; });" +
    "    var a = R.applySavedPositions(cy, spec.saved, els);" +
    "    R.renderLocationGroups(cy, { fixedIds: a.pinned });" +
    "  });" +
    "  cy.layout({ name: 'preset', positions: pos }).run();" +
    "  var out = { auto: auto, pos: {} };" +
    "  cy.nodes().forEach(function (n) { if (!n.data('isLocGroup')) out.pos[n.id()] = { x: n.position('x'), y: n.position('y') }; });" +
    "  cy.destroy(); return JSON.stringify(out); }",
    sb,
  );
});

function run(elements: Record<string, unknown>[], saved: Record<string, Pt> | null) {
  return JSON.parse(sb.run(JSON.stringify({ elements, saved }))) as { auto: Record<string, Pt>; pos: Record<string, Pt> };
}

const n = (id: string, role: string, extra: Record<string, unknown> = {}) => ({ id, label: id, role, ...extra });
const e = (s: string, t: string) => ({ id: `e-${s}-${t}`, source: s, target: t, isIface: 1 });

describe("applySavedPositions", () => {
  const site = [
    n("fg", "fortigate"),
    n("sw", "fortiswitch", { locA: "mine", locAName: "Mine" }),
    n("ap", "fortiap", { locA: "mine", locAName: "Mine" }),
    n("new", "fortiswitch", { locA: "mine", locAName: "Mine" }),
    e("fg", "sw"),
    e("sw", "ap"),
    e("sw", "new"),
  ];

  it("puts saved devices exactly on their saved spots", () => {
    const saved = { fg: { x: -500, y: 40 }, sw: { x: 900, y: 600 }, ap: { x: 1100, y: 800 } };
    const r = run(site, saved);
    expect(r.pos.fg).toEqual(saved.fg);
    expect(r.pos.sw).toEqual(saved.sw);
    expect(r.pos.ap).toEqual(saved.ap);
  });

  it("places an unsaved device at its level-layout offset from its saved parent", () => {
    const saved = { fg: { x: -500, y: 40 }, sw: { x: 900, y: 600 }, ap: { x: 1100, y: 800 } };
    const r = run(site, saved);
    const off = { x: r.auto.new.x - r.auto.sw.x, y: r.auto.new.y - r.auto.sw.y };
    expect(r.pos.new).toEqual({ x: saved.sw.x + off.x, y: saved.sw.y + off.y });
  });

  it("never pushes a box that holds a saved device, even when boxes overlap", () => {
    // Two areas saved on top of each other: the overlap pass would push the
    // lower one down; pinned, both stay where the operator left them.
    const els = [
      n("fg", "fortigate"),
      n("w", "fortiswitch", { locA: "west", locAName: "West" }),
      n("x", "fortiswitch", { locA: "east", locAName: "East" }),
      e("fg", "w"),
      e("fg", "x"),
    ];
    const saved = { fg: { x: 0, y: 0 }, w: { x: 200, y: 0 }, x: { x: 200, y: 30 } };
    const r = run(els, saved);
    expect(r.pos.w).toEqual(saved.w);
    expect(r.pos.x).toEqual(saved.x);
  });

  it("with no saved layout, leaves the level layout untouched", () => {
    const r = run(site, null);
    expect(r.pos).toEqual(r.auto);
  });

  // Operator exports (2026-11-07): drill-down views saved before group stubs
  // existed placed a new stub at its spot on an EMPTY map — meaningless in
  // the saved frame, and here and there exactly on a device.
  it("puts a stub the save has no spot for beside the saved devices it links to", () => {
    const els = [
      n("s1", "fortiswitch"), n("s2", "fortiswitch"),
      { id: "up", label: "← Scale House", isPortal: 1, isUpstreamPortal: 1, targetView: "b||scale" },
      { id: "down", label: "→ Mine", isPortal: 1, targetView: "a|mine" },
      e("up", "s1"), e("s1", "s2"), e("s2", "down"),
    ];
    const saved = { s1: { x: 1000, y: 500 }, s2: { x: 1260, y: 760 } };
    const { pos } = run(els, saved);
    expect(pos.s1).toEqual({ x: 1000, y: 500 });
    expect(pos.up).toEqual({ x: 740, y: 500 }); // two columns left, on s1's row
    expect(pos.down).toEqual({ x: 1520, y: 760 }); // two columns right, on s2's row
  });
});

