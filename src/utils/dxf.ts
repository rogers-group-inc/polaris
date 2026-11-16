/**
 * src/utils/dxf.ts — read a 2D AutoCAD DXF (ASCII) into drawable primitives,
 * and draw the layers an operator keeps as Polaris's own SVG (business rule 182).
 *
 * What is read: LINE, LWPOLYLINE (bulges become arcs), POLYLINE / VERTEX,
 * ARC, CIRCLE, ELLIPSE, SPLINE (through its fit or control points), TEXT,
 * MTEXT (formatting stripped), POINT (skipped) and INSERT (a block's contents,
 * transformed, nested up to MAX_BLOCK_DEPTH; MINSERT grids too). Entities with
 * a negative extrusion (mirrored in AutoCAD's object coordinates) are mirrored
 * back. Everything else — HATCH, SOLID, 3D faces, dimensions, images, proxies
 * — is counted under `skipped` and not drawn. Only MODEL space is read: a
 * shape flagged as paper space (group code 67 = 1 — the printed sheet's
 * title block, legend, viewports) sits in sheet inches near 0,0 and would
 * stretch the extents until the drawing itself is a speck (the first real
 * mine DXF, 2026-11-13). Binary DXF and DWG are refused.
 *
 * The SVG is generated here from numbers and escaped text only, so nothing in
 * the uploaded file reaches the browser as markup.
 */

type DxfPoint = [number, number];

interface DxfPath {
  kind: "path";
  layer: string;
  points: DxfPoint[];
  closed: boolean;
  color: number | null; // ACI colour of the entity; null = by layer
}

interface DxfText {
  kind: "text";
  layer: string;
  x: number;
  y: number;
  height: number;
  rotation: number; // degrees, counter-clockwise
  text: string;
  /** 0 left, 1 centre, 2 right — of the insertion point. */
  align: 0 | 1 | 2;
  color: number | null;
}

export type DxfPrimitive = DxfPath | DxfText;

export interface DxfGeo {
  /** Drawing coordinates of the design point. */
  design: DxfPoint;
  /** Longitude / latitude of that point (WGS84). */
  lng: number;
  lat: number;
  /** Unit vector of north in the drawing. */
  north: DxfPoint;
  /** Metres per drawing unit, as GEODATA states it (horizontal unit scale × unit). */
  metresPerUnit: number | null;
}

export interface DxfDrawing {
  version: string | null;
  /** $INSUNITS (0 unitless, 1 in, 2 ft, 4 mm, 5 cm, 6 m, 21 US survey ft, …). */
  insUnits: number;
  /** $MEASUREMENT: 0 imperial, 1 metric, null when the header has none. */
  measurement: 0 | 1 | null;
  layers: Array<{ name: string; color: number; count: number }>;
  primitives: DxfPrimitive[];
  skipped: Record<string, number>;
  geo: DxfGeo | null;
  /** True when the primitive cap cut the drawing short. */
  truncated: boolean;
}

export class DxfError extends Error {}

const MAX_BLOCK_DEPTH = 8;
/** Primitives kept, blocks expanded; a larger drawing is cut short and flagged. */
const MAX_DXF_PRIMITIVES = 400_000;
const ARC_STEP_DEG = 6;

/** Metres in one drawing unit, by $INSUNITS. Unknown / unitless → null. */
export const DXF_UNIT_METRES: Record<number, { name: string; metres: number }> = {
  1: { name: "Inches", metres: 0.0254 },
  2: { name: "Feet", metres: 0.3048 },
  3: { name: "Miles", metres: 1609.344 },
  4: { name: "Millimeters", metres: 0.001 },
  5: { name: "Centimeters", metres: 0.01 },
  6: { name: "Meters", metres: 1 },
  7: { name: "Kilometers", metres: 1000 },
  10: { name: "Yards", metres: 0.9144 },
  14: { name: "Decimeters", metres: 0.1 },
  21: { name: "US survey feet", metres: 1200 / 3937 },
};

type Pair = [number, string];

function toPairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isInteger(code)) throw new DxfError(`Not a readable DXF (line ${i + 1} is not a group code)`);
    pairs.push([code, lines[i + 1]]);
  }
  return pairs;
}

/** One entity: its type and its group codes, in order. */
interface Raw {
  type: string;
  codes: Pair[];
}

function num(r: Raw, code: number, dflt = 0): number {
  for (const [c, v] of r.codes) if (c === code) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }
  return dflt;
}
function str(r: Raw, code: number, dflt = ""): string {
  for (const [c, v] of r.codes) if (c === code) return v.trim();
  return dflt;
}
function all(r: Raw, code: number): string[] {
  return r.codes.filter(([c]) => c === code).map(([, v]) => v);
}
function colorOf(r: Raw): number | null {
  for (const [c, v] of r.codes) if (c === 62) { const n = Number(v); return Number.isFinite(n) && n > 0 && n < 256 ? n : null; }
  return null;
}

/** Split a section's pairs into entities at each group code 0. */
function entities(pairs: Pair[]): Raw[] {
  const out: Raw[] = [];
  let cur: Raw | null = null;
  for (const p of pairs) {
    if (p[0] === 0) {
      cur = { type: p[1].trim().toUpperCase(), codes: [] };
      out.push(cur);
    } else if (cur) {
      cur.codes.push(p);
    }
  }
  return out;
}

function sections(pairs: Pair[]): Record<string, Pair[]> {
  const out: Record<string, Pair[]> = {};
  let i = 0;
  while (i < pairs.length) {
    if (pairs[i][0] === 0 && pairs[i][1].trim() === "SECTION" && pairs[i + 1] && pairs[i + 1][0] === 2) {
      const name = pairs[i + 1][1].trim().toUpperCase();
      let j = i + 2;
      while (j < pairs.length && !(pairs[j][0] === 0 && pairs[j][1].trim() === "ENDSEC")) j++;
      out[name] = pairs.slice(i + 2, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

// ── Geometry helpers ──────────────────────────────────────────────────────

function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number): DxfPoint[] {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += 360;
  const n = Math.max(2, Math.ceil(sweep / ARC_STEP_DEG));
  const pts: DxfPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (a0 + (sweep * i) / n) * Math.PI / 180;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** The points of a bulged segment p → q (bulge = tan(sweep / 4)), q excluded. */
function bulgePoints(p: DxfPoint, q: DxfPoint, bulge: number): DxfPoint[] {
  if (!bulge || !Number.isFinite(bulge)) return [p];
  const sweep = 4 * Math.atan(bulge);
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const chord = Math.hypot(dx, dy);
  if (chord === 0) return [p];
  const r = chord / (2 * Math.sin(Math.abs(sweep) / 2));
  const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
  const h = r * Math.cos(Math.abs(sweep) / 2);
  const s = sweep > 0 ? 1 : -1;
  const cx = mx - s * h * dy / chord, cy = my + s * h * dx / chord;
  const a0 = Math.atan2(p[1] - cy, p[0] - cx);
  const n = Math.max(2, Math.ceil(Math.abs(sweep) * 180 / Math.PI / ARC_STEP_DEG));
  const pts: DxfPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** A 2D affine transform [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
type M = [number, number, number, number, number, number];
const IDENT: M = [1, 0, 0, 1, 0, 0];
function mul(m: M, n: M): M {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function apply(m: M, p: DxfPoint): DxfPoint { return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]; }
/** The angle a transform turns the x axis by, and how much it scales lengths. */
function rotScale(m: M): { rot: number; scale: number; mirrored: boolean } {
  const det = m[0] * m[3] - m[1] * m[2];
  return { rot: Math.atan2(m[1], m[0]) * 180 / Math.PI, scale: Math.sqrt(Math.abs(det)) || 1, mirrored: det < 0 };
}

/** Strip MTEXT formatting: \P breaks, {\f…;} fonts, \A1; alignment, %%d symbols. */
export function plainMText(s: string): string {
  return s
    .replace(/\\P/g, "\n")
    .replace(/\\[ACcFfHhQTWp][^;]*;/g, "")
    .replace(/\\S([^;]*?)[#^/]([^;]*);/g, "$1/$2")
    .replace(/\\[LlOoKk]/g, "")
    .replace(/\\~/g, " ")
    .replace(/\\\\/g, "\\")
    .replace(/[{}]/g, "")
    .replace(/%%[dD]/g, "°").replace(/%%[pP]/g, "±").replace(/%%[cC]/g, "⌀")
    .trim();
}
function plainText(s: string): string {
  return s.replace(/%%[dD]/g, "°").replace(/%%[pP]/g, "±").replace(/%%[cC]/g, "⌀").replace(/%%[uUoO]/g, "").trim();
}

// ── Parsing ───────────────────────────────────────────────────────────────

/** True when a buffer looks like a DWG (a binary AutoCAD drawing) rather than a DXF. */
export function looksLikeDwg(buf: Buffer): boolean {
  return buf.length >= 6 && buf.subarray(0, 4).toString("latin1") === "AC10" && /^\d{2}$/.test(buf.subarray(4, 6).toString("latin1"));
}

export function parseDxf(buf: Buffer): DxfDrawing {
  if (looksLikeDwg(buf)) throw new DxfError("That is a DWG file. Save it from AutoCAD as DXF (Save As → AutoCAD DXF) and import that");
  if (buf.subarray(0, 22).toString("latin1").startsWith("AutoCAD Binary DXF")) {
    throw new DxfError("Binary DXF is not supported. Save it from AutoCAD as an ASCII DXF");
  }
  const text = buf.toString("utf8").replace(/^\uFEFF/, "");
  const pairs = toPairs(text);
  const sec = sections(pairs);
  if (!sec.ENTITIES) throw new DxfError("Not a DXF drawing: it has no ENTITIES section");

  // Header: version and units.
  let version: string | null = null;
  let insUnits = 0;
  let measurement: 0 | 1 | null = null;
  const hdr = sec.HEADER || [];
  for (let i = 0; i < hdr.length; i++) {
    if (hdr[i][0] !== 9) continue;
    const v = hdr[i][1].trim();
    if (v === "$ACADVER" && hdr[i + 1]) version = hdr[i + 1][1].trim();
    if (v === "$INSUNITS" && hdr[i + 1]) { const n = Number(hdr[i + 1][1]); insUnits = Number.isInteger(n) ? n : 0; }
    if (v === "$MEASUREMENT" && hdr[i + 1]) { const n = Number(hdr[i + 1][1]); measurement = n === 1 ? 1 : n === 0 ? 0 : null; }
  }

  // Layers: name → colour (ACI; negative = off, kept but noted by abs).
  const layerColor = new Map<string, number>();
  for (const e of entities(sec.TABLES || [])) {
    if (e.type !== "LAYER") continue;
    const name = str(e, 2);
    if (name) layerColor.set(name, Math.abs(num(e, 62, 7)) || 7);
  }

  // Blocks: name → { base, entities }.
  const blocks = new Map<string, { base: DxfPoint; ents: Raw[] }>();
  {
    const ents = entities(sec.BLOCKS || []);
    let cur: { name: string; base: DxfPoint; ents: Raw[] } | null = null;
    for (const e of ents) {
      if (e.type === "BLOCK") { cur = { name: str(e, 2), base: [num(e, 10), num(e, 20)], ents: [] }; continue; }
      if (e.type === "ENDBLK") { if (cur && cur.name) blocks.set(cur.name, { base: cur.base, ents: cur.ents }); cur = null; continue; }
      if (cur) cur.ents.push(e);
    }
  }

  const primitives: DxfPrimitive[] = [];
  const skipped: Record<string, number> = {};
  let truncated = false;
  const skip = (t: string) => { skipped[t] = (skipped[t] || 0) + 1; };

  function emitPath(layer: string, color: number | null, m: M, pts: DxfPoint[], closed: boolean) {
    if (pts.length < 2) return;
    if (primitives.length >= MAX_DXF_PRIMITIVES) { truncated = true; return; }
    primitives.push({ kind: "path", layer, color, points: pts.map((p) => apply(m, p)), closed });
  }
  function emitText(layer: string, color: number | null, m: M, at: DxfPoint, height: number, rotation: number, text: string, align: 0 | 1 | 2) {
    if (!text) return;
    if (primitives.length >= MAX_DXF_PRIMITIVES) { truncated = true; return; }
    const rs = rotScale(m);
    const p = apply(m, at);
    primitives.push({ kind: "text", layer, color, x: p[0], y: p[1], height: Math.abs(height) * rs.scale, rotation: rotation + rs.rot, text: text.slice(0, 500), align });
  }

  function walk(list: Raw[], m: M, inheritLayer: string | null, depth: number) {
    for (let i = 0; i < list.length; i++) {
      if (truncated) return;
      const e = list[i];
      // Paper space (the sheet layout) is not the drawing.
      if (num(e, 67, 0) === 1) {
        if (e.type !== "VERTEX" && e.type !== "SEQEND" && e.type !== "ATTRIB") skip("on the sheet layout");
        continue;
      }
      let layer = str(e, 8, "0");
      if (inheritLayer !== null && layer === "0") layer = inheritLayer;
      const color = colorOf(e);
      // Object coordinates with a negative extrusion are mirrored in x.
      const ocs: M = num(e, 230, 1) < 0 ? [-1, 0, 0, 1, 0, 0] : IDENT;
      const mo = mul(m, ocs);
      switch (e.type) {
        case "LINE":
          emitPath(layer, color, m, [[num(e, 10), num(e, 20)], [num(e, 11), num(e, 21)]], false);
          break;
        case "LWPOLYLINE": {
          const verts: Array<{ p: DxfPoint; b: number }> = [];
          for (const [c, v] of e.codes) {
            if (c === 10) verts.push({ p: [Number(v), 0], b: 0 });
            else if (c === 20 && verts.length) verts[verts.length - 1].p[1] = Number(v);
            else if (c === 42 && verts.length) verts[verts.length - 1].b = Number(v);
          }
          const closed = (num(e, 70) & 1) === 1;
          const pts: DxfPoint[] = [];
          for (let k = 0; k < verts.length; k++) {
            const next = verts[k + 1] || (closed ? verts[0] : null);
            if (next) pts.push(...bulgePoints(verts[k].p, next.p, verts[k].b));
            else pts.push(verts[k].p);
          }
          emitPath(layer, color, mo, pts, closed);
          break;
        }
        case "POLYLINE": {
          const closed = (num(e, 70) & 1) === 1;
          const flags = num(e, 70);
          const verts: Array<{ p: DxfPoint; b: number }> = [];
          let k = i + 1;
          for (; k < list.length && list[k].type !== "SEQEND"; k++) {
            if (list[k].type === "VERTEX") verts.push({ p: [num(list[k], 10), num(list[k], 20)], b: num(list[k], 42) });
          }
          i = k; // past SEQEND
          if (flags & (16 | 64)) { skip("POLYLINE (mesh)"); break; }
          const pts: DxfPoint[] = [];
          for (let j = 0; j < verts.length; j++) {
            const next = verts[j + 1] || (closed ? verts[0] : null);
            if (next) pts.push(...bulgePoints(verts[j].p, next.p, verts[j].b));
            else pts.push(verts[j].p);
          }
          emitPath(layer, color, mo, pts, closed);
          break;
        }
        case "ARC":
          emitPath(layer, color, mo, arcPoints(num(e, 10), num(e, 20), num(e, 40), num(e, 50), num(e, 51)), false);
          break;
        case "CIRCLE":
          emitPath(layer, color, mo, arcPoints(num(e, 10), num(e, 20), num(e, 40), 0, 360), true);
          break;
        case "ELLIPSE": {
          const cx = num(e, 10), cy = num(e, 20), mx = num(e, 11), my = num(e, 21), ratio = num(e, 40, 1);
          const t0 = num(e, 41, 0);
          let t1 = num(e, 42, Math.PI * 2);
          while (t1 <= t0) t1 += Math.PI * 2;
          const n = Math.max(8, Math.ceil(((t1 - t0) * 180 / Math.PI) / ARC_STEP_DEG));
          const pts: DxfPoint[] = [];
          for (let k = 0; k <= n; k++) {
            const t = t0 + ((t1 - t0) * k) / n;
            const u = Math.cos(t), v = Math.sin(t) * ratio;
            pts.push([cx + mx * u - my * v, cy + my * u + mx * v]);
          }
          emitPath(layer, color, mo, pts, Math.abs(t1 - t0 - Math.PI * 2) < 1e-6);
          break;
        }
        case "SPLINE": {
          const fx = all(e, 11), fy = all(e, 21);
          const cxs = all(e, 10), cys = all(e, 20);
          const xs = fx.length >= 2 ? fx : cxs, ys = fx.length >= 2 ? fy : cys;
          const pts: DxfPoint[] = xs.map((x, k) => [Number(x), Number(ys[k] ?? 0)] as DxfPoint).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
          emitPath(layer, color, m, pts, (num(e, 70) & 1) === 1);
          break;
        }
        case "TEXT":
        case "ATTRIB": {
          const h = num(e, 40, 1);
          const just = num(e, 72, 0);
          const aligned = just !== 0 || num(e, 73, 0) !== 0;
          const at: DxfPoint = aligned && e.codes.some(([c]) => c === 11) ? [num(e, 11), num(e, 21)] : [num(e, 10), num(e, 20)];
          const align: 0 | 1 | 2 = just === 1 || just === 4 ? 1 : just === 2 ? 2 : 0;
          emitText(layer, color, mo, at, h, num(e, 50, 0), plainText(str(e, 1)), align);
          break;
        }
        case "MTEXT": {
          const raw = all(e, 3).join("") + str(e, 1);
          let rot = num(e, 50, 0);
          if (e.codes.some(([c]) => c === 11)) rot = Math.atan2(num(e, 21), num(e, 11)) * 180 / Math.PI;
          const attach = num(e, 71, 1);
          const col = (attach - 1) % 3;
          emitText(layer, color, m, [num(e, 10), num(e, 20)], num(e, 40, 1), rot, plainMText(raw), (col === 1 ? 1 : col === 2 ? 2 : 0));
          break;
        }
        case "INSERT": {
          const blk = blocks.get(str(e, 2));
          // Attributes follow an INSERT up to SEQEND; their text is drawn as text.
          if (num(e, 66, 0) === 1) {
            let k = i + 1;
            const attribs: Raw[] = [];
            for (; k < list.length && list[k].type !== "SEQEND"; k++) if (list[k].type === "ATTRIB") attribs.push(list[k]);
            i = k;
            walk(attribs, m, inheritLayer, depth);
          }
          if (!blk) { skip("INSERT (missing block)"); break; }
          if (depth >= MAX_BLOCK_DEPTH) { skip("INSERT (nested too deep)"); break; }
          const sx = num(e, 41, 1), sy = num(e, 42, 1), rot = num(e, 50, 0) * Math.PI / 180;
          const cols = Math.max(1, Math.min(100, num(e, 70, 1))), rows = Math.max(1, Math.min(100, num(e, 71, 1)));
          const cs = num(e, 44, 0), rsp = num(e, 45, 0);
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              // insert ∘ rotate ∘ scale ∘ (grid offset) ∘ (− base point)
              const t: M = [Math.cos(rot), Math.sin(rot), -Math.sin(rot), Math.cos(rot), num(e, 10), num(e, 20)];
              const s: M = [sx, 0, 0, sy, c * cs, r * rsp];
              const b: M = [1, 0, 0, 1, -blk.base[0], -blk.base[1]];
              walk(blk.ents, mul(mul(mul(mo, t), s), b), layer, depth + 1);
            }
          }
          break;
        }
        case "POINT":
        case "SEQEND":
        case "VERTEX":
        case "ATTDEF":
          break;
        default:
          skip(e.type);
      }
    }
  }
  walk(entities(sec.ENTITIES), IDENT, null, 0);

  // Layer table: every layer something was drawn on, with its count.
  const counts = new Map<string, number>();
  for (const p of primitives) counts.set(p.layer, (counts.get(p.layer) || 0) + 1);
  const layers = [...counts.entries()]
    .map(([name, count]) => ({ name, count, color: layerColor.get(name) ?? 7 }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  return { version, insUnits, measurement, layers, primitives, skipped, geo: readGeoData(sec.OBJECTS || [], insUnits), truncated };
}

/**
 * AutoCAD's geographic location (the GEODATA object), when its reference
 * point is longitude / latitude. A location in a projected coordinate system
 * (state plane, UTM) would need that system's projection, which Polaris does
 * not carry: such a drawing is placed by two points instead.
 */
function readGeoData(objects: Pair[], insUnits: number): DxfGeo | null {
  const geo = entities(objects).find((e) => e.type === "GEODATA");
  if (!geo) return null;
  const lng = num(geo, 11, NaN), lat = num(geo, 21, NaN);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
  const cs = all(geo, 301).join("") + all(geo, 303).join("");
  // A projected system's reference point is easting / northing; only a geographic one is lng / lat.
  if (cs && /<ProjectedCoordinateSystem|PROJCS\[/i.test(cs)) return null;
  let nx = num(geo, 12, 0), ny = num(geo, 22, 1);
  const len = Math.hypot(nx, ny) || 1;
  nx /= len; ny /= len;
  const scale = num(geo, 40, 1);
  const unit = DXF_UNIT_METRES[insUnits];
  return {
    design: [num(geo, 10), num(geo, 20)],
    lng, lat,
    north: [nx, ny],
    metresPerUnit: unit ? unit.metres * (scale || 1) : null,
  };
}

// ── Extents and SVG ───────────────────────────────────────────────────────

export interface DxfExtents { minX: number; minY: number; maxX: number; maxY: number }

export function extentsOf(prims: DxfPrimitive[]): DxfExtents | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const p of prims) {
    if (p.kind === "path") for (const q of p.points) add(q[0], q[1]);
    else add(p.x, p.y);
  }
  if (!Number.isFinite(minX)) return null;
  if (maxX === minX) maxX = minX + 1;
  if (maxY === minY) maxY = minY + 1;
  return { minX, minY, maxX, maxY };
}

// AutoCAD colour index → hex for the common ones; 7 (white / black) and
// anything unlisted draw dark, which reads on the map and on a plain plan.
const ACI: Record<number, string> = {
  1: "#d32f2f", 2: "#b8860b", 3: "#2e7d32", 4: "#00838f", 5: "#1565c0", 6: "#ad1457", 8: "#616161", 9: "#9e9e9e",
};
function hexOf(aci: number | null, layerAci: number): string {
  const c = aci ?? layerAci;
  return ACI[c] || "#263238";
}

function escXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** The long side of the generated SVG, in its own pixels. */
const DXF_SVG_SIDE = 4096;

/**
 * Draw `prims` as an SVG whose image space maps the extents onto
 * DXF_SVG_SIDE pixels on the long side, y flipped (DXF y is up).
 */
export function renderDxfSvg(prims: DxfPrimitive[], ext: DxfExtents, layerColors: Map<string, number>): { svg: string; width: number; height: number } {
  const W = ext.maxX - ext.minX, H = ext.maxY - ext.minY;
  const s = DXF_SVG_SIDE / Math.max(W, H);
  const width = Math.max(1, Math.round(W * s)), height = Math.max(1, Math.round(H * s));
  const X = (x: number) => ((x - ext.minX) * s).toFixed(1);
  const Y = (y: number) => ((ext.maxY - y) * s).toFixed(1);
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(`<g fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">`);
  for (const p of prims) {
    if (p.kind !== "path") continue;
    const d = p.points.map((q, i) => (i ? "L" : "M") + X(q[0]) + " " + Y(q[1])).join("") + (p.closed ? "Z" : "");
    parts.push(`<path d="${d}" stroke="${hexOf(p.color, layerColors.get(p.layer) ?? 7)}"/>`);
  }
  parts.push(`</g><g font-family="Arial, Helvetica, sans-serif">`);
  for (const p of prims) {
    if (p.kind !== "text") continue;
    const size = Math.max(0.5, p.height * s);
    const anchor = p.align === 1 ? "middle" : p.align === 2 ? "end" : "start";
    const fill = hexOf(p.color, layerColors.get(p.layer) ?? 7);
    const lines = p.text.split("\n");
    const tx = X(p.x), ty = Y(p.y);
    const tsp = lines.map((l, i) => `<tspan x="${tx}" dy="${i ? (size * 1.25).toFixed(1) : 0}">${escXml(l)}</tspan>`).join("");
    parts.push(`<text x="${tx}" y="${ty}" font-size="${size.toFixed(1)}" fill="${fill}" text-anchor="${anchor}"` +
      (p.rotation ? ` transform="rotate(${(-p.rotation).toFixed(2)} ${tx} ${ty})"` : "") + `>${tsp}</text>`);
  }
  parts.push(`</g></svg>`);
  return { svg: parts.join(""), width, height };
}

/**
 * The preview the import dialog draws: per layer, its paths' points in
 * 0-1000 preview units (y up), thinned to stay small, and up to 400 labels.
 */
export function dxfPreview(prims: DxfPrimitive[], ext: DxfExtents, maxPoints = 60_000): {
  paths: Array<{ l: number; p: number[] }>;
  texts: Array<{ l: number; x: number; y: number; h: number; r: number; t: string }>;
  layerIndex: string[];
} {
  const W = ext.maxX - ext.minX, H = ext.maxY - ext.minY;
  const k = 1000 / Math.max(W, H);
  const layerIndex: string[] = [];
  const idx = new Map<string, number>();
  const li = (name: string) => { let n = idx.get(name); if (n === undefined) { n = layerIndex.length; idx.set(name, n); layerIndex.push(name); } return n; };
  let total = 0;
  for (const p of prims) if (p.kind === "path") total += p.points.length;
  const step = Math.max(1, Math.ceil(total / maxPoints));
  const paths: Array<{ l: number; p: number[] }> = [];
  for (const p of prims) {
    if (p.kind !== "path") continue;
    const flat: number[] = [];
    for (let i = 0; i < p.points.length; i += step) flat.push(Math.round((p.points[i][0] - ext.minX) * k * 10) / 10, Math.round((p.points[i][1] - ext.minY) * k * 10) / 10);
    const last = p.points[p.points.length - 1];
    if ((p.points.length - 1) % step) flat.push(Math.round((last[0] - ext.minX) * k * 10) / 10, Math.round((last[1] - ext.minY) * k * 10) / 10);
    // A closed shape ends where it began.
    if (p.closed && flat.length >= 4) flat.push(flat[0], flat[1]);
    if (flat.length >= 4) paths.push({ l: li(p.layer), p: flat });
  }
  const texts: Array<{ l: number; x: number; y: number; h: number; r: number; t: string }> = [];
  for (const p of prims) {
    if (p.kind !== "text" || texts.length >= 400) continue;
    texts.push({ l: li(p.layer), x: Math.round((p.x - ext.minX) * k), y: Math.round((p.y - ext.minY) * k), h: Math.max(1, Math.round(p.height * k * 10) / 10), r: Math.round(p.rotation), t: p.text.slice(0, 80) });
  }
  return { paths, texts, layerIndex };
}
