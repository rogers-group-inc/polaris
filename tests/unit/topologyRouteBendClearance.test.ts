/**
 * tests/unit/topologyRouteBendClearance.test.ts
 *
 * routeInterGroupEdges() in public/js/topology-render.js must never put a
 * bend inside either end device. Cytoscape cannot find where a segment that
 * starts inside a node leaves it, marks the edge badLine and draws nothing —
 * on the Device Map a cross-group link fanned 9 px off its target's row
 * (because another link already ran into that row) vanished, leaving only
 * its selection handles. Runs the vendored Cytoscape headless in a vm
 * context (inputs built inside the context — see topologyEdgeEditor.test.ts)
 * and rebuilds each routed line's bends from its segment style.
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
    "function route(j) {" +
    "  var R = window.PolarisTopologyRender; var spec = JSON.parse(j);" +
    "  var els = spec.nodes.map(function (n) { return { data: Object.assign({ role: 'fortiswitch', hasIcon: 1, nodeColor: '#2e7d32' }, n.data), position: n.position }; })" +
    "    .concat(spec.edges.map(function (e) { return { data: Object.assign({ isIface: 1, isInterGroup: 1, taxiTurn: 40, label: '' }, e) }; }));" +
    "  var cy = cytoscape({ headless: true, styleEnabled: true, elements: els, layout: { name: 'preset' }, style: R.topologyStylesheet('dark', {}) });" +
    // The exported router re-places bent-edge labels AFTER routing, which
    // needs the renderer headless Cytoscape lacks — the routing is done by then.
    "  R.renderLocationGroups(cy);" +
    "  try { R.routeInterGroupEdges(cy); } catch (err) { if (!/getSourceEndpoint/.test(String(err))) throw err; }" +
    "  var out = cy.edges().map(function (e) { var s = e.source(), t = e.target();" +
    "    return { id: e.id(), curve: e.pstyle('curve-style').strValue, w: e.pstyle('segment-weights').strValue, d: e.pstyle('segment-distances').strValue," +
    "      S: { x: s.position('x'), y: s.position('y') }, T: { x: t.position('x'), y: t.position('y') }," +
    "      rS: s.outerWidth() / 2, rT: t.outerWidth() / 2 }; });" +
    "  cy.destroy(); return JSON.stringify(out); }",
    sb,
  );
});

type Routed = { id: string; curve: string; w: string; d: string; S: Pt; T: Pt; rS: number; rT: number };

function route(spec: unknown): Routed[] {
  return JSON.parse(sb.route(JSON.stringify(spec)));
}

// Inverse of the router's projection: weight along S→T, signed distance
// perpendicular to it.
function bends(r: Routed): Pt[] {
  const ws = String(r.w).split(/\s+/).map(parseFloat);
  const ds = String(r.d).split(/\s+/).map(parseFloat);
  const dx = r.T.x - r.S.x, dy = r.T.y - r.S.y;
  const norm = Math.hypot(dx, dy);
  return ws.map((w, i) => ({
    x: r.S.x + w * dx - (ds[i] * dy) / norm,
    y: r.S.y + w * dy + (ds[i] * dx) / norm,
  }));
}

function expectClear(r: Routed) {
  expect(r.curve).toBe("segments");
  for (const p of bends(r)) {
    expect(Math.hypot(p.x - r.S.x, p.y - r.S.y)).toBeGreaterThan(r.rS);
    expect(Math.hypot(p.x - r.T.x, p.y - r.T.y)).toBeGreaterThan(r.rT);
  }
}

const node = (id: string, x: number, y: number, loc: Record<string, string>) => ({ data: { id, label: id, ...loc }, position: { x, y } });

describe("routeInterGroupEdges keeps every bend outside both end devices", () => {
  it("a second link into an already-used target row (the fanned 9 px jog)", () => {
    const routed = route({
      nodes: [
        node("a", 100, 100, { locB: "b1", locBName: "B1" }),
        node("c", 100, 604, { locB: "b3", locBName: "B3" }),
        node("lake", 900, 600, { locB: "lake", locBName: "Lake" }),
      ],
      edges: [
        { id: "ie0", source: "c", target: "lake" },
        { id: "ie1", source: "a", target: "lake" },
      ],
    });
    expect(routed).toHaveLength(2);
    routed.forEach(expectClear);
  });

  it("three links fanned into one row, routed right to left", () => {
    const routed = route({
      nodes: [
        node("a", 900, 100, { locB: "b1" }),
        node("b", 900, 350, { locB: "b2" }),
        node("c", 900, 604, { locB: "b3" }),
        node("t", 100, 600, { locB: "t" }),
      ],
      edges: [
        { id: "ie0", source: "c", target: "t" },
        { id: "ie1", source: "a", target: "t" },
        { id: "ie2", source: "b", target: "t" },
      ],
    });
    routed.forEach(expectClear);
  });

  it("a source with no area or building box (room code only)", () => {
    const [r] = route({
      nodes: [
        node("ent", 100, 100, { locR: "rb", locRName: "Reader Board" }),
        node("lake", 900, 600, { locB: "lake" }),
      ],
      edges: [{ id: "ie0", source: "ent", target: "lake" }],
    });
    expectClear(r);
  });
});
