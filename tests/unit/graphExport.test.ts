/**
 * tests/unit/graphExport.test.ts
 *
 * The shared graph export (public/js/graph-export.js — Application Map and the
 * Device Map's site topology): page planning under a minimum printed text
 * size, the WinAnsi text mapping, the stored-zip container, the Visio page
 * geometry, and sceneFromCy() reading a computed style. Plus the App Map
 * adapter's header lines and key (public/js/appmap-export.js).
 *
 * Both files are browser IIFEs, so they are evaluated in a Node vm with a stub
 * `window` (the appmapFilter.test.ts approach).
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
let G: Record<string, any>;
let A: Record<string, any>;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sandbox: Record<string, any> = {
    window: {},
    document: { addEventListener() {}, getElementById: () => null },
    TextEncoder,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/graph-export.js"), "utf8"), sandbox);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/appmap-export.js"), "utf8"), sandbox);
  G = sandbox.window.PolarisGraphExport;
  A = sandbox.window.PolarisAppMapExport;
});

describe("planPages", () => {
  const plan = (gw: number, gh: number, minPt = 7): Plan =>
    G.planPages(gw, gh, 9, minPt, 700, 500, 24, 1.5);

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
    const s = G.occupiedSections(3, 3, 0, 0, 100, 100, 100, 100, [
      { x1: 10, y1: 10, x2: 20, y2: 20 },
      { x1: 250, y1: 250, x2: 260, y2: 260 },
    ]);
    expect(s).toEqual([{ row: 0, col: 0 }, { row: 2, col: 2 }]);
  });

  it("marks every section a rect straddles, including through an overlap", () => {
    // Sections 120px wide every 100px: x=105 sits in both column 0 and column 1.
    const s = G.occupiedSections(1, 3, 0, 0, 100, 0, 120, 100, [{ x1: 105, y1: 0, x2: 110, y2: 5 }]);
    expect(s).toEqual([{ row: 0, col: 0 }, { row: 0, col: 1 }]);
  });
});

describe("small helpers", () => {
  it("names sections by row letter and column number", () => {
    expect(G.sectionName(0, 0)).toBe("A1");
    expect(G.sectionName(1, 2)).toBe("B3");
    expect(G.sectionName(26, 0)).toBe("AA1");
  });

  it("resolves translucency against paper white and reads Cytoscape colour values", () => {
    expect(G.mixWithWhite("#000000", 0.5)).toBe("#808080");
    expect(G.mixWithWhite([79, 195, 247], 1)).toBe("#4fc3f7");
    expect(G.mixWithWhite("not a colour", 0.5)).toBe("#999999");
    expect(G.toHex("#ABC")).toBe("#aabbcc");
  });

  it("converts a quadratic to the equivalent cubic", () => {
    const c = G.quadToCubic({ x: 0, y: 0 }, { x: 3, y: 3 }, { x: 6, y: 0 });
    expect(c[0]).toEqual({ x: 2, y: 2 });
    expect(c[1]).toEqual({ x: 4, y: 2 });
  });

  it("chains several bezier control points through their midpoints", () => {
    const p = G.edgePath({ x: 0, y: 0 }, { x: 40, y: 0 }, [{ x: 10, y: 10 }, { x: 30, y: 10 }], null);
    expect(p.map((s: { type: string }) => s.type)).toEqual(["M", "Q", "Q"]);
    expect(p[1]).toMatchObject({ cx: 10, cy: 10, x: 20, y: 10 });
    expect(p[2]).toMatchObject({ cx: 30, cy: 10, x: 40, y: 0 });
  });

  it("draws taxi / segment bends as straight runs", () => {
    const p = G.edgePath({ x: 0, y: 0 }, { x: 10, y: 10 }, null, [{ x: 5, y: 0 }, { x: 5, y: 10 }]);
    expect(p.map((s: { type: string }) => s.type)).toEqual(["M", "L", "L", "L"]);
  });

  it("points an arrowhead along the curve's last control point", () => {
    const curve = G.edgePath({ x: 0, y: 0 }, { x: 10, y: 0 }, [{ x: 5, y: 8 }], null);
    expect(G.arrowFrom(curve, true)).toEqual({ x: 5, y: 8 });
    const bent = G.edgePath({ x: 0, y: 0 }, { x: 10, y: 10 }, null, [{ x: 10, y: 0 }]);
    expect(G.arrowFrom(bent, true)).toEqual({ x: 10, y: 0 });
    expect(G.arrowFrom(bent, false)).toEqual({ x: 10, y: 0 });
  });

  it("sorts Cytoscape shapes into the three a writer draws", () => {
    expect(G.shapeKind("ellipse")).toBe("ellipse");
    expect(G.shapeKind("round-rectangle")).toBe("round");
    expect(G.shapeKind("diamond")).toBe("polygon");
    expect(G.shapeKind("rectangle")).toBe("rect");
  });
});

describe("pdfText (WinAnsi)", () => {
  it("turns arrows into ASCII so a port pair stays readable", () => {
    expect(G.pdfText("port1 ↔ port49")).toBe("port1 <-> port49");
    expect(G.pdfText("a → b")).toBe("a -> b");
  });

  it("keeps Latin-1 and the WinAnsi extras, replaces the rest with one ?", () => {
    expect(G.pdfText("Café — 10 · 2…")).toBe("Café — 10 · 2…");
    expect(G.pdfText("東京")).toBe("??");
    expect(G.pdfText("x😀y")).toBe("x?y"); // a surrogate pair is ONE character
  });
});

describe("zipStore", () => {
  it("computes the standard CRC-32", () => {
    const bytes = new TextEncoder().encode("123456789");
    expect(G.crc32(bytes)).toBe(0xcbf43926);
  });

  it("writes a readable stored zip: local headers, central directory, end record", () => {
    const zip: Uint8Array = G.zipStore([{ name: "a.txt", data: "hello" }, { name: "dir/b.xml", data: "<x/>" }], new Date(2026, 9, 6, 12, 0, 0));
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    const eocd = zip.length - 22;
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 10, true)).toBe(2);           // entries
    const cdOffset = dv.getUint32(eocd + 16, true);
    expect(dv.getUint32(cdOffset, true)).toBe(0x02014b50);
    // First entry: stored (method 0), sizes equal, data follows the name.
    expect(dv.getUint16(8, true)).toBe(0);
    expect(dv.getUint32(18, true)).toBe(5);
    const nameLen = dv.getUint16(26, true);
    expect(new TextDecoder().decode(zip.slice(30, 30 + nameLen))).toBe("a.txt");
    expect(new TextDecoder().decode(zip.slice(30 + nameLen, 30 + nameLen + 5))).toBe("hello");
    expect(dv.getUint32(14, true)).toBe(G.crc32(new TextEncoder().encode("hello")));
  });
});

// A tiny two-node, one-edge scene in model px.
function tinyScene() {
  const label = (s: string, fontPx = 10) => ({ lines: [s], pdfLines: [s], fontPx, mono: false, bold: false, italic: false, color: "#111111", bg: null, valign: "bottom", halign: "center", mx: 0, my: 4 });
  return {
    under: [], parents: [],
    nodes: [
      { shape: "ellipse", polygon: null, x1: 0, y1: 0, x2: 20, y2: 20, fill: "#2e7d32", stroke: "#ffffff", strokeWidth: 2, strokeStyle: "solid", icon: null, label: label("FG ↔ 1"), z: 0 },
      { shape: "polygon", polygon: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]], x1: 180, y1: 80, x2: 200, y2: 100, fill: "#0288d1", stroke: null, strokeWidth: 0, strokeStyle: "solid", icon: null, label: null, z: 0 },
    ],
    edges: [{ path: [{ type: "M", x: 10, y: 10 }, { type: "L", x: 190, y: 90 }], color: "#999999", width: 2, style: "dashed",
      arrowTarget: { from: { x: 10, y: 10 }, to: { x: 190, y: 90 }, color: "#999999", scale: 1 }, arrowSource: null,
      label: label("port1", 9), mid: { x: 100, y: 50 }, z: 0 }],
    minFontPx: 9, icons: [],
    bbox: { x1: 0, y1: 0, x2: 200, y2: 120, w: 200, h: 120 },
  };
}

describe("vsdxPageXml / vsdxParts", () => {
  it("sizes the page to the drawing at 1 px = 1 pt plus margins", () => {
    const p = G.vsdxPageXml(tinyScene());
    expect(p.pageW).toBeCloseTo(200 / 72 + 1, 6);
    expect(p.pageH).toBeCloseTo(120 / 72 + 1, 6);
    expect(p.shapeCount).toBe(3);
  });

  it("flips y: a node at the top of the drawing sits near the top of the page", () => {
    const p = G.vsdxPageXml(tinyScene());
    // Shapes are written in paint order — the edge (ID 1) before the nodes —
    // so the first node is ID 2.
    const first = /<Shape ID="2"[\s\S]*?<\/Shape>/.exec(p.xml)![0];
    const pinY = Number(/<Cell N="PinY" V="([^"]+)"/.exec(first)![1]);
    expect(pinY).toBeCloseTo(p.pageH - 0.5 - 10 / 72, 4);
  });

  it("keeps the real arrow in Visio text (UTF-8) and escapes XML", () => {
    const s = tinyScene();
    s.nodes[0].label!.lines = ["a < b ↔ c"];
    const p = G.vsdxPageXml(s);
    expect(p.xml).toContain("<Text>a &lt; b ↔ c</Text>");
  });

  it("draws dashes, the arrowhead as a second filled geometry, and the diamond as a polygon", () => {
    const xml = G.vsdxPageXml(tinyScene()).xml;
    expect(xml).toContain('<Cell N="LinePattern" V="2"/>');
    expect(xml).toContain('<Section N="Geometry" IX="1">');
    expect(xml).toMatch(/<Row T="Ellipse"/);
  });

  it("packages every part the OPC relationships point at", () => {
    const parts = G.vsdxParts(tinyScene(), "Polaris Test", "Test page");
    const names = parts.map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining([
      "[Content_Types].xml", "_rels/.rels", "visio/document.xml", "visio/_rels/document.xml.rels",
      "visio/pages/pages.xml", "visio/pages/_rels/pages.xml.rels", "visio/pages/page1.xml",
    ]));
    const ct = parts.find((p: { name: string }) => p.name === "[Content_Types].xml").data;
    expect(ct).toContain('PartName="/visio/pages/page1.xml"');
    expect(parts.find((p: { name: string }) => p.name === "visio/pages/pages.xml").data).toContain('Name="Test page"');
  });
});

describe("sceneFromCy (computed style)", () => {
  // A cy-shaped stub whose elements answer pstyle() like Cytoscape does.
  const ele = (style: Record<string, any>, extra: Record<string, any>) => ({
    pstyle: (n: string) => (n in style ? style[n] : undefined),
    visible: () => true,
    effectiveOpacity: () => 1,
    ...extra,
  });
  const val = (v: any) => ({ value: v, strValue: String(v), pfValue: typeof v === "number" ? v : undefined });
  const coll = <T>(items: T[]) => ({ forEach: (f: (x: T) => void) => items.forEach(f), length: items.length });
  const swaps: string[] = [];
  const cy = {
    style: () => ({
      json: () => { swaps.push("read"); return [{ selector: "node", style: {} }]; },
      fromJson: (j: unknown) => { swaps.push(Array.isArray(j) && (j as any[]).length === 2 ? "light" : "restore"); return { update() {} }; },
    }),
    nodes: () => coll([
      ele({ shape: val("diamond"), "background-color": val([2, 136, 209]), "background-opacity": val(1), "border-width": val(0),
        label: val("AP-1"), "font-size": val(10), color: val([17, 17, 17]), "text-valign": val("bottom"), "text-halign": val("center") },
        { boundingBox: () => ({ x1: 0, y1: 0, x2: 20, y2: 20, w: 20, h: 20 }), isParent: () => false }),
      ele({ shape: val("round-rectangle"), "background-color": val([79, 195, 247]), "background-opacity": val(0.08),
        "border-width": val(2), "border-color": val([79, 195, 247]), "border-style": val("dashed"), "z-compound-depth": val("bottom"),
        label: val("Floor 2"), "font-size": val(16), "font-weight": val("700") },
        { boundingBox: () => ({ x1: -40, y1: -40, x2: 200, y2: 120, w: 240, h: 160 }), isParent: () => false }),
    ]),
    edges: () => coll([
      ele({ "curve-style": val("taxi"), "line-color": val([245, 158, 11]), width: val(2), "line-style": val("dashed"),
        "target-arrow-shape": val("none"), "source-arrow-shape": val("none"), label: val("port1 ↔ port2"), "font-size": val(8) },
        { sourceEndpoint: () => ({ x: 10, y: 10 }), targetEndpoint: () => ({ x: 100, y: 60 }), segmentPoints: () => [{ x: 55, y: 10 }, { x: 55, y: 60 }],
          controlPoints: () => undefined, midpoint: () => ({ x: 55, y: 35 }) }),
    ]),
    elements: () => ({ boundingBox: () => ({ x1: -40, y1: -60, x2: 200, y2: 140, w: 240, h: 200 }) }),
  };

  it("reads shapes, hull layer, taxi bends, dashes and the smallest font — and restores the on-screen style", () => {
    const light = [{ selector: "node", style: {} }, { selector: "edge", style: {} }];
    const s = G.sceneFromCy(cy, light);
    expect(swaps).toEqual(["read", "light", "restore"]);
    expect(s.nodes[0]).toMatchObject({ shape: "polygon", fill: "#0288d1", stroke: null });
    expect(s.under[0]).toMatchObject({ shape: "round", strokeStyle: "dashed" });
    expect(s.under[0].label.bold).toBe(true);
    expect(s.edges[0].path.map((p: { type: string }) => p.type)).toEqual(["M", "L", "L", "L"]);
    expect(s.edges[0]).toMatchObject({ style: "dashed", arrowTarget: null });
    expect(s.edges[0].label.pdfLines).toEqual(["port1 <-> port2"]);
    expect(s.edges[0].label.lines).toEqual(["port1 ↔ port2"]);
    expect(s.minFontPx).toBe(8);
  });
});

describe("appmap-export adapter", () => {
  const raw = {
    seenWithin: "24 hours", status: "10 assets", pills: [{ kind: "asset", value: "web01" }, { kind: "proto", value: "tcp" }],
    hiddenPorts: ["tcp/22", "other"], hideExternal: true, hideWorkstations: false,
    legend: { rows: [{ key: "tcp/443", color: "#2f7fe0", count: 3, hidden: false }, { key: "tcp/22", color: "#f07c1e", count: 2, hidden: true }], other: { count: 4, hidden: true } },
    portServiceName: (k: string) => (k === "tcp/443" ? "https" : ""), neutralEdgeColor: "#9aa2b1",
  };

  it("states the window, the filters and the hidden ports under the title", () => {
    expect(A.metaLines(raw)).toEqual([
      "Seen within: 24 hours  |  10 assets",
      "Filters: host: web01, proto: tcp  |  Hidden ports: tcp/22, Other  |  External hidden",
    ]);
  });

  it("keys only what is drawn: hidden rows and a hidden Other are left out", () => {
    const k = A.keyItems(raw);
    expect(k[0]).toMatchObject({ color: "#2f7fe0", text: "tcp/443 https" });
    expect(k.map((i: { text: string }) => i.text)).not.toContain("tcp/22");
    expect(k.map((i: { text: string }) => i.text)).not.toContain("Other");
  });
});
