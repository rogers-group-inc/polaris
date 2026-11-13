/**
 * tests/unit/dxf.test.ts — src/utils/dxf.ts (business rule 182): reading a
 * 2D DXF, expanding blocks, the extents, and the SVG Polaris draws from it.
 */
import { describe, it, expect } from "vitest";
import { parseDxf, extentsOf, renderDxfSvg, dxfPreview, plainMText, looksLikeDwg, DxfError } from "../../src/utils/dxf.js";

/** A DXF from [code, value] pairs per section. */
function dxf(opts: { header?: Array<[number, string | number]>; tables?: Array<[number, string | number]>; blocks?: Array<[number, string | number]>; entities: Array<[number, string | number]>; objects?: Array<[number, string | number]> }): Buffer {
  const out: string[] = [];
  const sec = (name: string, body: Array<[number, string | number]>) => {
    out.push("0", "SECTION", "2", name);
    for (const [c, v] of body) out.push(String(c), String(v));
    out.push("0", "ENDSEC");
  };
  sec("HEADER", opts.header ?? [[9, "$ACADVER"], [1, "AC1032"], [9, "$INSUNITS"], [70, 2]]);
  if (opts.tables) sec("TABLES", opts.tables);
  if (opts.blocks) sec("BLOCKS", opts.blocks);
  sec("ENTITIES", opts.entities);
  if (opts.objects) sec("OBJECTS", opts.objects);
  out.push("0", "EOF");
  return Buffer.from(out.join("\r\n"), "utf8");
}

describe("parseDxf", () => {
  it("reads units, layers, lines, closed polylines with bulges, circles and text", () => {
    const d = parseDxf(dxf({
      tables: [[0, "TABLE"], [2, "LAYER"], [0, "LAYER"], [2, "PILLARS"], [62, 3], [0, "ENDTAB"]],
      entities: [
        [0, "LINE"], [8, "OUTLINE"], [10, 0], [20, 0], [11, 100], [21, 0],
        [0, "LWPOLYLINE"], [8, "PILLARS"], [90, 4], [70, 1], [10, 10], [20, 10], [10, 20], [20, 10], [42, 1], [10, 20], [20, 20], [10, 10], [20, 20],
        [0, "CIRCLE"], [8, "PILLARS"], [10, 50], [20, 50], [40, 5],
        [0, "TEXT"], [8, "LABELS"], [10, 1], [20, 2], [40, 3], [1, "PORTAL %%d"],
        [0, "HATCH"], [8, "FILL"],
      ],
    }));
    expect(d.version).toBe("AC1032");
    expect(d.insUnits).toBe(2);
    expect(d.layers.map((l) => [l.name, l.count])).toEqual([["LABELS", 1], ["OUTLINE", 1], ["PILLARS", 2]]);
    expect(d.layers.find((l) => l.name === "PILLARS")!.color).toBe(3);
    expect(d.skipped).toEqual({ HATCH: 1 });
    const poly = d.primitives.find((p) => p.kind === "path" && p.closed && p.layer === "PILLARS" && p.points.length > 4)!;
    // The bulge of 1 is a half circle bowing out to x = 25.
    expect(Math.max(...(poly as { points: number[][] }).points.map((q) => q[0]))).toBeCloseTo(25, 0);
    const t = d.primitives.find((p) => p.kind === "text")!;
    expect(t).toMatchObject({ text: "PORTAL °", x: 1, y: 2, height: 3 });
  });

  it("expands a block at its insertion point, scale and rotation, layer 0 taking the insert's layer", () => {
    const d = parseDxf(dxf({
      blocks: [[0, "BLOCK"], [2, "STOPPING"], [10, 0], [20, 0], [0, "LINE"], [8, "0"], [10, 0], [20, 0], [11, 1], [21, 0], [0, "ENDBLK"]],
      entities: [[0, "INSERT"], [8, "VENT"], [2, "STOPPING"], [10, 100], [20, 200], [41, 10], [42, 10], [50, 90]],
    }));
    const p = d.primitives[0] as { layer: string; points: number[][] };
    expect(p.layer).toBe("VENT");
    expect(p.points[0][0]).toBeCloseTo(100); expect(p.points[0][1]).toBeCloseTo(200);
    expect(p.points[1][0]).toBeCloseTo(100); expect(p.points[1][1]).toBeCloseTo(210);
  });

  it("mirrors an arc drawn with a negative extrusion", () => {
    const d = parseDxf(dxf({ entities: [[0, "CIRCLE"], [8, "A"], [10, 50], [20, 0], [40, 1], [230, -1]] }));
    const xs = (d.primitives[0] as { points: number[][] }).points.map((q) => q[0]);
    expect(Math.min(...xs)).toBeCloseTo(-51);
  });

  it("reads a geographic location only when its reference point is longitude / latitude", () => {
    const geo = (cs: string): Array<[number, string | number]> => [[0, "GEODATA"], [10, 1000], [20, 2000], [11, -85.7], [21, 38.1], [12, 0], [22, 1], [40, 1], [301, cs]];
    const ok = parseDxf(dxf({ entities: [[0, "LINE"], [10, 0], [20, 0], [11, 1], [21, 1]], objects: geo("<GeographicCoordinateSystem>LL84") }));
    expect(ok.geo).toMatchObject({ design: [1000, 2000], lng: -85.7, lat: 38.1, north: [0, 1] });
    expect(ok.geo!.metresPerUnit).toBeCloseTo(0.3048);
    const proj = parseDxf(dxf({ entities: [[0, "LINE"], [10, 0], [20, 0], [11, 1], [21, 1]], objects: geo("<ProjectedCoordinateSystem>KY83-N") }));
    expect(proj.geo).toBeNull();
  });

  it("refuses a DWG, a binary DXF and a file that is not a drawing", () => {
    expect(looksLikeDwg(Buffer.from("AC1032\0\0\0"))).toBe(true);
    expect(() => parseDxf(Buffer.from("AC1027xxxxxxxx"))).toThrow(DxfError);
    expect(() => parseDxf(Buffer.from("AutoCAD Binary DXF\r\n\x1a\0"))).toThrow(/Binary DXF/);
    expect(() => parseDxf(Buffer.from("hello\nworld\n"))).toThrow(DxfError);
  });
});

describe("parseDxf — model space only, and the units it says", () => {
  it("skips the sheet layout (paper space, code 67 = 1), so the extents are the drawing's", () => {
    const d = parseDxf(dxf({ entities: [
      [0, "LINE"], [8, "MINE"], [10, 1280000], [20, 280000], [11, 1281000], [21, 281000],
      [0, "LWPOLYLINE"], [67, 1], [8, "Title Block"], [90, 4], [70, 1], [10, 0], [20, 0], [10, 17], [20, 0], [10, 17], [20, 11], [10, 0], [20, 11],
    ] }));
    expect(d.layers.map((l) => l.name)).toEqual(["MINE"]);
    expect(d.skipped["on the sheet layout"]).toBe(1);
    expect(extentsOf(d.primitives)).toEqual({ minX: 1280000, minY: 280000, maxX: 1281000, maxY: 281000 });
  });

  it("reads $MEASUREMENT so a drawing with no units can be offered feet or metres", () => {
    const imperial = parseDxf(dxf({ header: [[9, "$INSUNITS"], [70, 0], [9, "$MEASUREMENT"], [70, 0]], entities: [[0, "LINE"], [10, 0], [20, 0], [11, 1], [21, 1]] }));
    expect(imperial).toMatchObject({ insUnits: 0, measurement: 0 });
    const metric = parseDxf(dxf({ header: [[9, "$MEASUREMENT"], [70, 1]], entities: [[0, "LINE"], [10, 0], [20, 0], [11, 1], [21, 1]] }));
    expect(metric.measurement).toBe(1);
  });
});

describe("plainMText", () => {
  it("strips formatting and keeps line breaks", () => {
    expect(plainMText("{\\fArial|b1;MAIN}\\PENTRY \\A1;1")).toBe("MAIN\nENTRY 1");
  });
});

describe("renderDxfSvg / dxfPreview", () => {
  const d = parseDxf(dxf({ entities: [
    [0, "LINE"], [8, "A"], [10, 0], [20, 0], [11, 200], [21, 100],
    [0, "TEXT"], [8, "B"], [10, 10], [20, 10], [40, 5], [1, "<script>alert(1)</script> & co"],
  ] }));
  const ext = extentsOf(d.primitives)!;

  it("fits the long side to 4096 px, flips y and escapes text", () => {
    const r = renderDxfSvg(d.primitives, ext, new Map());
    expect(r.width).toBe(4096);
    expect(r.height).toBe(2048);
    expect(r.svg).toContain('d="M0.0 2048.0L4096.0 0.0"');
    expect(r.svg).not.toContain("<script>");
    expect(r.svg).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
  });

  it("previews in 0-1000 units with a layer index", () => {
    const pv = dxfPreview(d.primitives, ext);
    expect(pv.layerIndex).toEqual(["A", "B"]);
    expect(pv.paths[0].p).toEqual([0, 0, 1000, 500]);
    expect(pv.texts[0]).toMatchObject({ l: 1, x: 50, y: 50 });
  });
});
