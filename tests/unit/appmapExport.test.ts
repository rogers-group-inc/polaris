/**
 * tests/unit/appmapExport.test.ts
 *
 * The Application Map PDF export's layout core — planPages(), occupiedSections()
 * and buildScene() in public/js/appmap-export.js. The file is a browser IIFE,
 * so it is evaluated in a Node vm with a stub `window` (the appmapFilter.test.ts
 * approach) and the helpers are read off window.PolarisAppMapExport.
 *
 * The promise under test is the one the operator was given: no label on the
 * printed map is smaller than the chosen minimum, and a map too big for one
 * sheet at that size is split into sections rather than shrunk.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

interface Plan { scale: number; cols: number; rows: number; single: boolean; offsetX: number; offsetY: number; stepX: number; stepY: number }
let X: Record<string, any>;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(resolve(here, "../../public/js/appmap-export.js"), "utf8");
  const sandbox: { window: Record<string, any>; document: any } = {
    window: {},
    document: { addEventListener() {}, getElementById: () => null },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  X = sandbox.window.PolarisAppMapExport;
});

describe("planPages", () => {
  const plan = (gw: number, gh: number, minPt = 7): Plan =>
    X.planPages(gw, gh, 9, minPt, 700, 500, 24, 1.5);

  it("fits a small map on one sheet, centred, and never prints below the minimum", () => {
    const p = plan(600, 300);
    expect(p.single).toBe(true);
    expect(p.scale * 9).toBeGreaterThanOrEqual(7);
    // Width-bound (600 × 7/6 fills 700pt exactly), so the slack is vertical
    // and the drawing is centred top-to-bottom.
    expect(p.offsetX).toBeCloseTo(0, 6);
    expect(p.offsetY).toBeLessThan(0);
  });

  it("caps the enlargement of a tiny map", () => {
    expect(plan(50, 20).scale).toBe(1.5);
  });

  it("pins the scale to the minimum and splits a map too big for one sheet", () => {
    const p = plan(3000, 1000);
    expect(p.single).toBe(false);
    expect(p.scale * 9).toBeCloseTo(7, 6);
    // 3000px × 7/9 = 2333pt over 700pt sheets that overlap by 24pt.
    expect(p.cols).toBe(Math.ceil((3000 * 7 / 9 - 24) / (700 - 24)));
    expect(p.rows).toBe(Math.ceil((1000 * 7 / 9 - 24) / (500 - 24)));
    // Neighbouring sections overlap by exactly the overlap.
    expect((700 / p.scale - p.stepX) * p.scale).toBeCloseTo(24, 6);
  });

  it("a larger minimum means more sheets, never smaller text", () => {
    const a = plan(3000, 1000, 7), b = plan(3000, 1000, 10);
    expect(b.cols * b.rows).toBeGreaterThan(a.cols * a.rows);
    expect(b.scale * 9).toBeCloseTo(10, 6);
  });

  it("centres a map that is one section wide", () => {
    const p = plan(400, 3000);
    expect(p.cols).toBe(1);
    expect(p.offsetX).toBeLessThan(0);
    expect(p.offsetY).toBe(0);
  });
});

describe("occupiedSections", () => {
  it("skips sections with nothing in them", () => {
    // 3 × 3 grid of 100px sections, no overlap; one rect top-left, one bottom-right.
    const s = X.occupiedSections(3, 3, 0, 0, 100, 100, 100, 100, [
      { x1: 10, y1: 10, x2: 20, y2: 20 },
      { x1: 250, y1: 250, x2: 260, y2: 260 },
    ]);
    expect(s).toEqual([{ row: 0, col: 0 }, { row: 2, col: 2 }]);
  });

  it("marks every section a rect straddles, including through an overlap", () => {
    // Sections 120px wide every 100px: x=105 sits in both column 0 and column 1.
    const s = X.occupiedSections(1, 3, 0, 0, 100, 0, 120, 100, [{ x1: 105, y1: 0, x2: 110, y2: 5 }]);
    expect(s).toEqual([{ row: 0, col: 0 }, { row: 0, col: 1 }]);
  });
});

describe("sectionName", () => {
  it("names rows by letter and columns by number", () => {
    expect(X.sectionName(0, 0)).toBe("A1");
    expect(X.sectionName(1, 2)).toBe("B3");
    expect(X.sectionName(26, 0)).toBe("AA1");
  });
});

describe("mixWithWhite / quadToCubic / edgePath", () => {
  it("resolves translucency against paper white", () => {
    expect(X.mixWithWhite("#000000", 0.5)).toBe("#808080");
    expect(X.mixWithWhite("#4fc3f7", 1)).toBe("#4fc3f7");
    expect(X.mixWithWhite("not a colour", 0.5)).toBe("#999999");
  });

  it("converts a quadratic to the equivalent cubic", () => {
    const c = X.quadToCubic({ x: 0, y: 0 }, { x: 3, y: 3 }, { x: 6, y: 0 });
    expect(c[0]).toEqual({ x: 2, y: 2 });
    expect(c[1]).toEqual({ x: 4, y: 2 });
  });

  it("chains several control points through their midpoints", () => {
    const p = X.edgePath({ x: 0, y: 0 }, { x: 40, y: 0 }, [{ x: 10, y: 10 }, { x: 30, y: 10 }], null);
    expect(p.map((s: { type: string }) => s.type)).toEqual(["M", "Q", "Q"]);
    expect(p[1]).toMatchObject({ cx: 10, cy: 10, x: 20, y: 10 });
    expect(p[2]).toMatchObject({ cx: 30, cy: 10, x: 40, y: 0 });
  });

  it("draws a straight edge as one line", () => {
    const p = X.edgePath({ x: 0, y: 0 }, { x: 5, y: 5 }, undefined, undefined);
    expect(p).toEqual([{ type: "M", x: 0, y: 0 }, { type: "L", x: 5, y: 5 }]);
  });
});

describe("buildScene", () => {
  // A cy-shaped stub: just enough of the collection API for buildScene.
  const node = (data: Record<string, unknown>, bb: { x1: number; y1: number; x2: number; y2: number }) => ({
    data: (k: string) => data[k],
    boundingBox: () => ({ ...bb, w: bb.x2 - bb.x1, h: bb.y2 - bb.y1 }),
  });
  const edge = (data: Record<string, unknown>) => ({
    data: (k: string) => data[k],
    sourceEndpoint: () => ({ x: 0, y: 0 }),
    targetEndpoint: () => ({ x: 100, y: 0 }),
    controlPoints: () => undefined,
    segmentPoints: () => undefined,
    midpoint: () => ({ x: 50, y: 0 }),
  });
  const coll = <T>(items: T[]) => ({ forEach: (f: (x: T) => void) => items.forEach(f), length: items.length });
  const sheet = [
    { selector: 'node[kind="asset"]', style: { "background-color": "#4fc3f7", "background-opacity": 0.1, "border-color": "#4fc3f7", "font-size": "12px", color: "#1a1a1a" } },
    { selector: 'node[kind="process"]', style: { "background-color": "#7e57c2", "border-color": "#5e35b1", "font-size": "11px", color: "#ffffff" } },
    { selector: "edge", style: { width: 1.8, "font-size": "9px", color: "#1a1a1a" } },
    { selector: 'edge[kind="process"]', style: { width: 2.6 } },
  ];
  const cy = {
    nodes: () => coll([
      node({ kind: "asset", label: "web01" }, { x1: 0, y1: 0, x2: 200, y2: 100 }),
      node({ kind: "process", label: "nginx\ntcp/443" }, { x1: 20, y1: 20, x2: 180, y2: 80 }),
    ]),
    edges: () => coll([
      edge({ kind: "process", label: "tcp/443", pcolor: "#2f7fe0", stale: 0 }),
      edge({ kind: "external", label: "tcp/53", stale: 1 }),
    ]),
    elements: () => ({ boundingBox: () => ({ x1: -10, y1: -30, x2: 210, y2: 110, w: 220, h: 140 }) }),
  };

  it("takes the smallest drawn font as the size the minimum is measured against", () => {
    expect(X.buildScene(cy, sheet, "#9aa2b1").minFontPx).toBe(9);
  });

  it("splits multi-line labels and resolves the asset fill against white", () => {
    const s = X.buildScene(cy, sheet, "#9aa2b1");
    expect(s.children[0].label).toEqual(["nginx", "tcp/443"]);
    expect(s.boxes[0].fill).toBe(X.mixWithWhite("#4fc3f7", 0.1));
  });

  it("colours edges by port, falls back to neutral, fades stale ones and dashes externals", () => {
    const s = X.buildScene(cy, sheet, "#9aa2b1");
    expect(s.edges[0]).toMatchObject({ color: "#2f7fe0", width: 2.6, dashed: false });
    expect(s.edges[1].color).toBe(X.mixWithWhite("#9aa2b1", 0.35));
    expect(s.edges[1].dashed).toBe(true);
  });
});
