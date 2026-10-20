/**
 * tests/unit/topologyBentEdgeLabels.test.ts
 *
 * refreshBentEdgeLabels() in public/js/topology-render.js — where a bent
 * topology link's port label is drawn. Operator rule: one bend → halfway
 * along the second leg; two or more bends → halfway along the first leg and
 * again halfway along the last; straight → Cytoscape's midpoint, untouched.
 * The renderer is a browser IIFE, so it is evaluated in a vm sandbox and fed
 * a stand-in for the Cytoscape edge API it reads.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

type Pt = { x: number; y: number };
type Style = Record<string, unknown>;

let refresh: (cy: unknown) => void;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(resolve(here, "../../public/js/topology-render.js"), "utf8");
  const sandbox: { window: Record<string, any> } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  refresh = sandbox.window.PolarisTopologyRender.refreshBentEdgeLabels;
});

// A fake edge: a polyline from src through bends to tgt, drawn with the
// given curve-style. midpoint() is the polyline's arc-length midpoint, as
// Cytoscape reports it for segments / taxi edges.
let nextId = 0;
function fakeEdge(curve: string, pts: Pt[], data: Record<string, unknown> = { label: "port8 ↔ port7" }) {
  const id = "e" + nextId++;
  const bypass: Style = {};
  const removed: string[] = [];
  const writes = { n: 0 };
  const d: Record<string, unknown> = { ...data };
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  const total = lens.reduce((a, b) => a + b, 0);
  function midpoint(): Pt {
    let left = total / 2;
    for (let i = 0; i < lens.length; i++) {
      if (left <= lens[i]) {
        const t = lens[i] ? left / lens[i] : 0;
        return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
      }
      left -= lens[i];
    }
    return pts[pts.length - 1];
  }
  return {
    bypass,
    removed,
    writes,
    style(arg?: string | Style) {
      if (typeof arg === "string") return arg === "curve-style" ? curve : undefined;
      writes.n++;
      Object.assign(bypass, arg);
      return undefined;
    },
    removeStyle(props: string) {
      removed.push(props);
      props.split(" ").forEach((p) => delete bypass[p]);
    },
    data(key: string, value?: unknown) {
      if (value === undefined) return d[key];
      d[key] = value;
      return undefined;
    },
    id: () => id,
    visible: () => true,
    sourceEndpoint: () => pts[0],
    targetEndpoint: () => pts[pts.length - 1],
    segmentPoints: () => pts.slice(1, -1),
    controlPoints: () => undefined,
    midpoint,
  };
}
const at = (e: ReturnType<typeof fakeEdge>) => {
  const m = e.midpoint();
  return { x: m.x + (e.bypass["text-margin-x"] as number), y: m.y + (e.bypass["text-margin-y"] as number) };
};

function fakeCy(edges: ReturnType<typeof fakeEdge>[]) {
  return {
    batch: (fn: () => void) => fn(),
    edges: () => ({ forEach: (fn: (e: unknown) => void) => edges.forEach(fn) }),
  };
}

describe("refreshBentEdgeLabels", () => {
  it("one bend: the label sits halfway along the second leg, laid along it", () => {
    // Right 100, then down 200: second leg is vertical from (100,0) to (100,200).
    const e = fakeEdge("taxi", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 200 }]);
    refresh(fakeCy([e]));
    const mid = e.midpoint();
    expect(mid.x + (e.bypass["text-margin-x"] as number)).toBeCloseTo(100);
    expect(mid.y + (e.bypass["text-margin-y"] as number)).toBeCloseTo(100);
    expect(e.bypass["text-rotation"]).toBeCloseTo(Math.PI / 2);
    expect(e.bypass["target-label"]).toBe("");
  });

  it("two bends: the label sits halfway along the first leg, and a copy halfway along the last", () => {
    // Left 120, down 300, right 80 — the shape of a routed cross-box link.
    const e = fakeEdge("segments", [
      { x: 500, y: 100 }, { x: 380, y: 100 }, { x: 380, y: 400 }, { x: 460, y: 400 },
    ]);
    refresh(fakeCy([e]));
    const mid = e.midpoint();
    expect(mid.x + (e.bypass["text-margin-x"] as number)).toBeCloseTo(440);
    expect(mid.y + (e.bypass["text-margin-y"] as number)).toBeCloseTo(100);
    // A leftward leg still reads left-to-right: angle folded into (-90°, 90°].
    expect(e.bypass["text-rotation"]).toBeCloseTo(0);
    expect(e.bypass["target-label"]).toBe("port8 ↔ port7");
    expect(e.bypass["target-text-offset"]).toBeCloseTo(40);
    expect(e.bypass["target-text-rotation"]).toBe("autorotate");
  });

  it("a zero-length leg or a collinear bend is no bend at all", () => {
    // Taxi turn landing on the target: the reported bend repeats a point.
    const repeated = fakeEdge("taxi", [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 150 }]);
    // A bend point that lies on the straight line.
    const collinear = fakeEdge("segments", [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 100 }]);
    refresh(fakeCy([repeated, collinear]));
    expect(repeated.bypass).toEqual({});
    expect(collinear.bypass).toEqual({});
  });

  it("an edge that straightens drops its placement; bezier and unlabelled edges are left alone", () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 200 }];
    const e = fakeEdge("taxi", pts);
    refresh(fakeCy([e]));
    expect(e.bypass["text-margin-x"]).toBeDefined();
    // Now straight (e.g. the hull toggle cleared its routing).
    const straight = fakeEdge("bezier", [pts[0], pts[2]], { label: "x", _bentLabel: 1 });
    const unlabelled = fakeEdge("taxi", pts, { label: "" });
    refresh(fakeCy([straight, unlabelled]));
    expect(straight.removed).toHaveLength(1);
    expect(straight.removed[0]).toContain("text-margin-x");
    expect(straight.data("_bentLabel")).toBe(0);
    expect(unlabelled.bypass).toEqual({});
    expect(unlabelled.removed).toHaveLength(0);
  });
});

describe("refreshBentEdgeLabels — no label where several lines run together", () => {
  it("a fan-out L whose first leg runs along the spine link labels its vertical leg and its last leg instead", () => {
    // The switch at (0,0): its spine runs straight right; the fan-out link
    // leaves along the same row for 65px, drops 100, then runs right.
    const spine = fakeEdge("bezier", [{ x: 0, y: 0 }, { x: 260, y: 0 }], { label: "port8 ↔ port1" });
    const fan = fakeEdge("taxi", [{ x: 0, y: 0 }, { x: 65, y: 0 }, { x: 65, y: 100 }, { x: 260, y: 100 }]);
    refresh(fakeCy([spine, fan]));
    expect(at(fan).x).toBeCloseTo(65);
    expect(at(fan).y).toBeCloseTo(50);
    expect(fan.bypass["text-rotation"]).toBeCloseTo(Math.PI / 2);
    expect(fan.bypass["target-label"]).toBe("port8 ↔ port7");
    expect(fan.bypass["target-text-offset"]).toBeCloseTo(97.5);
    // The spine's midpoint (130) is past the shared 0–65 stretch: untouched.
    expect(spine.bypass).toEqual({});
  });

  it("a straight link whose midpoint is on a shared stretch moves to the middle of its unshared part", () => {
    const a = fakeEdge("bezier", [{ x: 0, y: 0 }, { x: 300, y: 0 }], { label: "a" });
    const b = fakeEdge("segments", [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 120 }], { label: "b" });
    refresh(fakeCy([a, b]));
    // a's 0–200 is shared with b's first leg; its free run is 200–300.
    expect(at(a).x).toBeCloseTo(250);
    expect(at(a).y).toBeCloseTo(0);
  });

  it("a one-bend link whose second leg is bundled falls back to its first leg", () => {
    // Both turn down the same x = 100 line; e1's bit above e2's join is too short.
    const e1 = fakeEdge("taxi", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 200 }]);
    const e2 = fakeEdge("taxi", [{ x: 0, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 200 }]);
    refresh(fakeCy([e1, e2]));
    expect(at(e1)).toEqual({ x: expect.closeTo(50), y: expect.closeTo(0) });
    expect(at(e2)).toEqual({ x: expect.closeTo(50), y: expect.closeTo(10) });
    expect(e1.bypass["text-rotation"]).toBeCloseTo(0);
  });

  it("a pass that changes nothing re-styles nothing (it runs every frame of a drag)", () => {
    const e = fakeEdge("taxi", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 200 }]);
    const hidden = [fakeEdge("taxi", [{ x: 0, y: 50 }, { x: 0, y: 300 }, { x: 80, y: 300 }]),
      fakeEdge("taxi", [{ x: 0, y: 50 }, { x: 0, y: 300 }, { x: 80, y: 300 }])];
    const cy = fakeCy([e, ...hidden]);
    refresh(cy);
    refresh(cy);
    expect(e.writes.n).toBe(1);
    expect(hidden[0].writes.n).toBe(1);
  });

  it("a link with no unshared stretch shows no label", () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 200 }];
    const e1 = fakeEdge("taxi", pts);
    const e2 = fakeEdge("taxi", pts);
    refresh(fakeCy([e1, e2]));
    expect(e1.bypass.label).toBe("");
    expect(e2.bypass.label).toBe("");
    expect(e1.bypass["target-label"]).toBe("");
  });
});
