/**
 * tests/unit/topologyFanOutTurn.test.ts
 *
 * retuneFanOutTurns() in public/js/topology-render.js: a fan-out link (a
 * taxi line turning a fixed half column out from its shallow end) whose
 * drawn turn crosses a straight link or a device slides the turn along its
 * span to the nearest clear spot, drawn as explicit segments. Operator
 * report 2026-11-09: a closet switch's uplink rose out of the box through
 * the line to one of its own APs. Real Cytoscape, headless, in a vm context
 * (inputs built inside the context — see topologyEdgeEditor.test.ts).
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
    "function make(j) { var R = window.PolarisTopologyRender; var spec = JSON.parse(j);" +
    "  return cytoscape({ headless: true, styleEnabled: true, layout: { name: 'preset' }, style: R.topologyStylesheet('dark', {})," +
    "    elements: spec.nodes.map(function (n) { return { data: Object.assign({ hasIcon: 1, nodeColor: '#2e7d32' }, n.data), position: n.position }; })" +
    "      .concat(spec.edges.map(function (e) { return { data: Object.assign({ label: '' }, e) }; })) }); }" +
    // The exported pass re-places bent-edge labels last, which needs the
    // renderer headless Cytoscape lacks — the geometry is done by then.
    "function run(cy) { try { window.PolarisTopologyRender.routeInterGroupEdges(cy); } catch (err) { if (!/getSourceEndpoint/.test(String(err))) throw err; } }" +
    "function move(cy, id, x, y) { cy.$id(id).position({ x: x, y: y }); }" +
    "function flag(cy, id, k) { cy.$id(id).data(k, 1); }" +
    "function read(cy, id) { var e = cy.$id(id), s = e.source(), t = e.target();" +
    "  return JSON.stringify({ curve: e.pstyle('curve-style').strValue, w: e.pstyle('segment-weights').strValue, d: e.pstyle('segment-distances').strValue," +
    "    retuned: e.data('turnRetuned') || 0, S: s.position(), T: t.position(), rS: s.outerWidth() / 2, rT: t.outerWidth() / 2 }); }",
    sb,
  );
});

const sw = (id: string, x: number, y: number) => ({ data: { id, label: id, role: "fortiswitch" }, position: { x, y } });
const ap = (id: string, x: number, y: number) => ({ data: { id, label: id, role: "fortiap" }, position: { x, y } });
const apLink = (id: string, s: string, t: string) => ({ id, source: s, target: t, isApLink: 1 });
const fanLink = (id: string, s: string, t: string, turn = 40) =>
  ({ id, source: s, target: t, isIface: 1, isFanOut: 1, fanOutDir: "horizontal", fanOutTurn: turn });

// The screenshot: a switch with one AP up-right and one down-right, and a
// fan-out uplink to a switch further up and right.
function closet(apUp: Pt = { x: 225, y: 262 }) {
  return sb.make(JSON.stringify({
    nodes: [sw("mcc", 100, 393), ap("ap1", apUp.x, apUp.y), ap("ap2", 225, 458), sw("cc8", 420, 130)],
    edges: [apLink("l1", "mcc", "ap1"), apLink("l2", "mcc", "ap2"), fanLink("up", "mcc", "cc8")],
  }));
}

function bends(r: { w: string; d: string; S: Pt; T: Pt }): Pt[] {
  const ws = String(r.w).split(/\s+/).map(parseFloat);
  const ds = String(r.d).split(/\s+/).map(parseFloat);
  const dx = r.T.x - r.S.x, dy = r.T.y - r.S.y;
  const norm = Math.hypot(dx, dy);
  return ws.map((w, i) => ({ x: r.S.x + w * dx - (ds[i] * dy) / norm, y: r.S.y + w * dy + (ds[i] * dx) / norm }));
}
function crosses(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, s: Pt) => (q.x - p.x) * (s.y - p.y) - (q.y - p.y) * (s.x - p.x);
  return o(c, d, a) * o(c, d, b) < 0 && o(a, b, c) * o(a, b, d) < 0;
}

describe("retuneFanOutTurns", () => {
  it("slides a turn that cuts a switch's AP line clear of it, as an orthogonal two-bend path", () => {
    const cy = closet();
    sb.run(cy);
    const r = JSON.parse(sb.read(cy, "up"));
    expect(r.retuned).toBe(1);
    expect(r.curve).toBe("segments");
    const b = bends(r);
    expect(b).toHaveLength(2);
    // Orthogonal: out along the switch's row, up, along the target's row.
    expect(Math.abs(b[0].y - r.S.y)).toBeLessThan(0.5);
    expect(Math.abs(b[0].x - b[1].x)).toBeLessThan(0.5);
    expect(Math.abs(b[1].y - r.T.y)).toBeLessThan(0.5);
    // Every bend outside both end devices (a bend inside one blanks the line).
    for (const p of b) {
      expect(Math.hypot(p.x - r.S.x, p.y - r.S.y)).toBeGreaterThan(r.rS);
      expect(Math.hypot(p.x - r.T.x, p.y - r.T.y)).toBeGreaterThan(r.rT);
    }
    // No run crosses the AP line (trimmed at its two device outlines).
    const l1 = JSON.parse(sb.read(cy, "l1"));
    const L = Math.hypot(l1.T.x - l1.S.x, l1.T.y - l1.S.y);
    const ux = (l1.T.x - l1.S.x) / L, uy = (l1.T.y - l1.S.y) / L;
    const a = { x: l1.S.x + ux * l1.rS, y: l1.S.y + uy * l1.rS };
    const z = { x: l1.T.x - ux * l1.rT, y: l1.T.y - uy * l1.rT };
    const path = [r.S, ...b, r.T];
    for (let i = 1; i < path.length; i++) expect(crosses(path[i - 1], path[i], a, z)).toBe(false);
    // And clear of the AP itself.
    expect(b[0].x).toBeGreaterThan(225);
  });

  it("leaves a turn that crosses nothing on its taxi", () => {
    // The up-right AP moved below the switch's row: the climb is clear.
    const cy = closet({ x: 225, y: 520 });
    sb.run(cy);
    const r = JSON.parse(sb.read(cy, "up"));
    expect(r.retuned).toBe(0);
    expect(r.curve).toBe("taxi");
  });

  it("re-plans on the next pass: a retuned link goes back to its taxi once the way is clear", () => {
    const cy = closet();
    sb.run(cy);
    expect(JSON.parse(sb.read(cy, "up")).retuned).toBe(1);
    sb.move(cy, "ap1", 225, 520);
    sb.run(cy);
    const r = JSON.parse(sb.read(cy, "up"));
    expect(r.retuned).toBe(0);
    expect(r.curve).toBe("taxi");
  });

  it("never touches an operator-drawn path", () => {
    const cy = closet();
    sb.flag(cy, "up", "customPath");
    sb.run(cy);
    expect(JSON.parse(sb.read(cy, "up")).retuned).toBe(0);
  });
});
