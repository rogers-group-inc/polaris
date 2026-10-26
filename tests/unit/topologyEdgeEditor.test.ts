/**
 * tests/unit/topologyEdgeEditor.test.ts
 *
 * Operator-drawn connection paths on the Device Map topology graph —
 * public/js/topology-edge-editor.js. The pure geometry / persistence helpers
 * run directly; the editor itself runs against a HEADLESS Cytoscape (the
 * vendored build) in the same Node vm context. Objects handed to Cytoscape
 * are built inside that context (`P`, `make`): Cytoscape's plain-object test
 * compares constructors, and an object from this realm fails it silently.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

type Pt = { x: number; y: number };
type Path = { bends: Pt[]; s: Pt | null; t: Pt | null };
type Api = {
  KEY_PREFIX: string;
  MAX_BENDS: number;
  edgeKind: (id: string) => string;
  assignPathKeys: (edges: { id: string; source: string; target: string }[]) => string[];
  parsePaths: (positions: unknown) => Record<string, Path>;
  serializePaths: (paths: Record<string, Path>, onlyKeys?: Record<string, boolean>) => Record<string, Pt>;
  perimeterOffset: (shape: string, w: number, h: number, dir: Pt) => Pt;
  segmentGeometry: (S: Pt, T: Pt, bends: Pt[]) => { weights: number[]; distances: number[] } | null;
  insertIndex: (S: Pt, T: Pt, bends: Pt[], P: Pt) => number;
  carriedBends: (bends: Pt[], dS: Pt, dT: Pt) => Pt[];
  attach: (cy: any, opts: any) => any;
};

let api: Api;
let sb: Record<string, any>;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  sb = {
    window: { addEventListener() {}, removeEventListener() {} },
    setTimeout,
    clearTimeout,
    console,
  };
  sb.self = sb.window;
  vm.createContext(sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/vendor/cytoscape.min.js"), "utf8"), sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/topology-edge-editor.js"), "utf8"), sb);
  vm.runInContext(
    "function make(j) { return cytoscape(JSON.parse(j)); }" +
    "function P(x, y) { return { x: x, y: y }; }" +
    "function J(j) { return JSON.parse(j); }",
    sb,
  );
  api = sb.window.PolarisTopologyEdgeEditor;
});

const close = (a: number, b: number) => Math.abs(a - b) < 0.05;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("path keys", () => {
  it("strips the payload index (and a location view's portal- prefix) from the element id", () => {
    expect(api.edgeKind("e7")).toBe("e");
    expect(api.edgeKind("le12")).toBe("le");
    expect(api.edgeKind("portal-ie3")).toBe("ie");
    // Mesh ids carry their endpoints, not an index — already stable.
    expect(api.edgeKind("mesh-ap1-st9")).toBe("mesh-ap1-st9");
  });

  it("keys by kind + source + target, so a re-indexed payload keeps its paths", () => {
    const before = api.assignPathKeys([{ id: "e0", source: "fg", target: "sw1" }]);
    const after = api.assignPathKeys([
      { id: "e0", source: "fg", target: "sw9" },
      { id: "e1", source: "fg", target: "sw1" },
    ]);
    expect(after[1]).toBe(before[0]);
  });

  it("numbers parallel links of one kind between one pair", () => {
    expect(api.assignPathKeys([
      { id: "le0", source: "a", target: "b" },
      { id: "le1", source: "a", target: "b" },
      { id: "e2", source: "a", target: "b" },
    ])).toEqual(["le|a|b", "le|a|b#1", "e|a|b"]);
  });
});

describe("parsePaths / serializePaths", () => {
  it("round-trips bends (in order) and end directions through the layout blob, ignoring node entries", () => {
    const blob = {
      sw1: { x: 1, y: 2 },
      "edgepath:e|fg|sw1:b1": { x: 30, y: 40 },
      "edgepath:e|fg|sw1:b0": { x: 10, y: 20 },
      "edgepath:e|fg|sw1:s": { x: 0, y: 2 }, // normalised to a unit direction
    };
    const paths = api.parsePaths(blob);
    expect(paths["e|fg|sw1"].bends).toEqual([{ x: 10, y: 20 }, { x: 30, y: 40 }]);
    expect(paths["e|fg|sw1"].s).toEqual({ x: 0, y: 1 });
    expect(paths["e|fg|sw1"].t).toBeNull();
    expect(api.serializePaths(paths)).toEqual({
      "edgepath:e|fg|sw1:b0": { x: 10, y: 20 },
      "edgepath:e|fg|sw1:b1": { x: 30, y: 40 },
      "edgepath:e|fg|sw1:s": { x: 0, y: 1 },
    });
  });

  it("keeps a key whose node ids contain colons intact (the part is after the LAST colon)", () => {
    const paths = api.parsePaths({ "edgepath:e|portal:fg|lldp:x:b0": { x: 1, y: 1 } });
    expect(Object.keys(paths)).toEqual(["e|portal:fg|lldp:x"]);
  });

  it("drops malformed entries and empty paths", () => {
    expect(api.parsePaths({
      "edgepath:e|a|b:s": { x: 0, y: 0 },        // no direction
      "edgepath:e|a|b:bx": { x: 1, y: 1 },       // not a bend index
      "edgepath:e|c|d:b0": { x: "1", y: 1 },     // not numeric
    })).toEqual({});
  });

  it("serializes only the lines still on the canvas, so a departed line's path ages out", () => {
    const paths = { "e|a|b": { bends: [{ x: 1, y: 1 }], s: null, t: null }, "e|c|d": { bends: [{ x: 2, y: 2 }], s: null, t: null } };
    expect(Object.keys(api.serializePaths(paths, { "e|a|b": true }))).toEqual(["edgepath:e|a|b:b0"]);
  });

  it("never writes a blob key the server would refuse (> 300 chars)", () => {
    const long = "x".repeat(300);
    expect(api.serializePaths({ [long]: { bends: [{ x: 1, y: 1 }], s: null, t: null } })).toEqual({});
  });
});

describe("geometry", () => {
  it("perimeterOffset: a circle's edge at its radius, a box's edge on its side", () => {
    const c = api.perimeterOffset("ellipse", 20, 20, { x: Math.SQRT1_2, y: Math.SQRT1_2 });
    expect(close(Math.hypot(c.x, c.y), 10)).toBe(true);
    const r = api.perimeterOffset("round-rectangle", 40, 20, { x: Math.SQRT1_2, y: Math.SQRT1_2 });
    expect(close(r.y, 10)).toBe(true); // hits the top/bottom side first
    const d = api.perimeterOffset("diamond", 20, 20, { x: 1, y: 0 });
    expect(close(d.x, 10)).toBe(true);
  });

  it("segmentGeometry projects bends onto the centre line (weight along, signed distance across)", () => {
    const g = api.segmentGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, [{ x: 25, y: 10 }])!;
    expect(g.weights).toEqual([0.25]);
    expect(g.distances).toEqual([10]);
    expect(api.segmentGeometry({ x: 5, y: 5 }, { x: 5, y: 5 }, [{ x: 1, y: 1 }])).toBeNull();
  });

  it("insertIndex puts a new bend on the leg nearest the press", () => {
    const S = { x: 0, y: 0 }, T = { x: 100, y: 0 };
    const bends = [{ x: 30, y: 50 }, { x: 70, y: 50 }];
    expect(api.insertIndex(S, T, bends, { x: 10, y: 20 })).toBe(0);  // S → b0
    expect(api.insertIndex(S, T, bends, { x: 50, y: 52 })).toBe(1);  // b0 → b1
    expect(api.insertIndex(S, T, bends, { x: 90, y: 20 })).toBe(2);  // b1 → T
    expect(api.insertIndex(S, T, [], { x: 50, y: 5 })).toBe(0);
  });

  it("carriedBends: both ends moved together → bends move with them; otherwise they stay", () => {
    const b = [{ x: 10, y: 10 }];
    expect(api.carriedBends(b, { x: 5, y: -3 }, { x: 5, y: -3 })).toEqual([{ x: 15, y: 7 }]);
    expect(api.carriedBends(b, { x: 5, y: 0 }, { x: 0, y: 0 })).toEqual([{ x: 10, y: 10 }]);
    expect(api.carriedBends(b, { x: 0, y: 0 }, { x: 0, y: 0 })).toEqual([{ x: 10, y: 10 }]);
  });
});

describe("editor on a headless graph", () => {
  let cy: any;
  afterEach(() => { if (cy && !cy.destroyed()) cy.destroy(); });

  function graph(blob: Record<string, Pt>, onChange?: () => void, extra: Record<string, unknown> = {}) {
    cy = sb.make(JSON.stringify({
      headless: true,
      styleEnabled: true,
      layout: { name: "preset" },
      elements: [
        { data: { id: "a" }, position: { x: 0, y: 0 } },
        { data: { id: "b" }, position: { x: 100, y: 0 } },
        { data: { id: "c" }, position: { x: 200, y: 0 } },
        { data: { id: "e0", source: "a", target: "b" } },
        { data: { id: "e1", source: "b", target: "c" } },
      ],
      style: [{ selector: "node", style: { width: 20, height: 20, shape: "ellipse" } }],
    }));
    const ed = api.attach(cy, { positions: sb.J(JSON.stringify(blob)), onChange, ...extra });
    return { ed, edge: cy.getElementById("e0") };
  }
  const blobOf = (ed: any) => JSON.parse(JSON.stringify(ed.serialize()));

  it("draws a saved path as segments through its bends and marks the line customised", () => {
    const { edge } = graph({ "edgepath:e|a|b:b0": { x: 50, y: 40 } });
    expect(edge.style("curve-style")).toBe("segments");
    expect(edge.style("segment-weights")).toBe("0.5");
    expect(edge.data("customPath")).toBe(1);
  });

  it("selecting the line shows a handle per bend plus one end point on each device's outline", async () => {
    const { edge } = graph({ "edgepath:e|a|b:b0": { x: 50, y: 0 } });
    edge.select();
    await tick();
    const ids = cy.nodes("[isEdgeHandle]").map((n: any) => n.id()).sort();
    expect(ids).toEqual(["edgehandle:e|a|b:b0", "edgehandle:e|a|b:s", "edgehandle:e|a|b:t"]);
    const s = cy.getElementById("edgehandle:e|a|b:s").position();
    expect(close(s.x, 10) && close(s.y, 0)).toBe(true); // a's outline, toward the bend
    expect(cy.getElementById("edgehandle:e|a|b:s").data("noExport")).toBe(1);
    edge.unselect();
    await tick();
    expect(cy.nodes("[isEdgeHandle]").length).toBe(0);
  });

  it("moving both ends together carries the bends; moving one end leaves them in place", async () => {
    const { ed } = graph({ "edgepath:e|a|b:b0": { x: 50, y: 40 } });
    cy.getElementById("a").emit("grab");
    cy.getElementById("a").position(sb.P(10, 5));
    cy.getElementById("b").position(sb.P(110, 5));
    expect(blobOf(ed)["edgepath:e|a|b:b0"]).toEqual({ x: 60, y: 45 });
    cy.getElementById("a").emit("free");
    await tick();
    cy.getElementById("a").emit("grab");
    cy.getElementById("b").position(sb.P(200, 5));
    expect(blobOf(ed)["edgepath:e|a|b:b0"]).toEqual({ x: 60, y: 45 });
  });

  it("an end point slides around its device and never leaves the outline", async () => {
    const { ed, edge } = graph({ "edgepath:e|a|b:b0": { x: 50, y: 40 } });
    edge.select();
    await tick();
    const s = cy.getElementById("edgehandle:e|a|b:s");
    s.position(sb.P(0, 300)); // dragged far below the device
    const p = s.position();
    expect(close(p.x, 0) && close(p.y, 10)).toBe(true); // pinned to a's outline
    expect(blobOf(ed)["edgepath:e|a|b:s"]).toEqual({ x: 0, y: 1 });
    expect(edge.style("source-endpoint")).toBe("0px 10px");
  });

  it("Delete removes a selected bend; an emptied line goes back to automatic", async () => {
    let changes = 0;
    const { ed, edge } = graph({ "edgepath:e|a|b:b0": { x: 50, y: 40 }, "edgepath:e|a|b:s": { x: 0, y: 1 } }, () => { changes++; });
    edge.select();
    await tick();
    cy.getElementById("edgehandle:e|a|b:b0").select();
    expect(ed.deleteSelected()).toBe(true);
    expect(blobOf(ed)).toEqual({ "edgepath:e|a|b:s": { x: 0, y: 1 } });
    cy.getElementById("edgehandle:e|a|b:s").select();
    expect(ed.deleteSelected()).toBe(true);
    expect(blobOf(ed)).toEqual({});
    expect(edge.data("customPath")).toBe(0);
    expect(changes).toBe(2);
    expect(ed.deleteSelected()).toBe(false); // nothing selected → key press not swallowed
  });

  it("handles follow the selection: switching to another link swaps its handles in", async () => {
    const { edge } = graph({ "edgepath:e|a|b:b0": { x: 50, y: 40 } });
    const other = cy.getElementById("e1");
    edge.select();
    await tick();
    edge.unselect();
    other.select();
    await tick();
    expect(cy.nodes("[isEdgeHandle]").map((n: any) => n.data("pathKey"))).toEqual(["e|b|c", "e|b|c"]);
  });

  it("view-only (isEditable false): drawn paths still draw, but no handles and Delete removes nothing", async () => {
    let editable = false;
    const { ed, edge } = graph({ "edgepath:e|a|b:b0": { x: 50, y: 40 } }, undefined, { isEditable: () => editable });
    expect(edge.style("curve-style")).toBe("segments"); // still drawn
    edge.select();
    await tick();
    expect(cy.nodes("[isEdgeHandle]").length).toBe(0);
    expect(ed.deleteSelected()).toBe(false);
    editable = true;
    ed.refresh(); // the host flips edit mode on
    expect(cy.nodes("[isEdgeHandle]").length).toBe(3);
    editable = false;
    ed.refresh();
    expect(cy.nodes("[isEdgeHandle]").length).toBe(0);
    expect(blobOf(ed)["edgepath:e|a|b:b0"]).toEqual({ x: 50, y: 40 });
  });

  it("suspends custom geometry while the connection-path overlay is up", () => {
    const { ed, edge } = graph({ "edgepath:e|a|b:b0": { x: 50, y: 40 } });
    ed.setSuspended(true);
    expect(edge.data("customPath")).toBe(0);
    ed.setSuspended(false);
    expect(edge.style("curve-style")).toBe("segments");
    // The path itself survived the suspension.
    expect(blobOf(ed)["edgepath:e|a|b:b0"]).toEqual({ x: 50, y: 40 });
  });
});
