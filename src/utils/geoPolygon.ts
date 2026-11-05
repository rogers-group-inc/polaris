/**
 * src/utils/geoPolygon.ts
 *
 * Polygon-vs-polygon geometry. Pure, no DB, no I/O.
 *
 * Exists because map-region LEVELS are derived from polygon nesting — a region
 * drawn around several smaller regions is a division — and `geo.ts` only knows
 * how to test a POINT against a ring. This module answers "does ring A contain
 * ring B?", which nothing in Polaris could answer before.
 *
 * Deliberately a sibling of `geo.ts` rather than an extension of it: that file
 * is a 112-line leaf imported by the discovery hot path (`syncDhcpSubnets`,
 * `mapRegionService.computeMembership`), and it should stay that way. This
 * module imports `LatLng` + `pointInPolygon` from it and adds nothing to it.
 *
 * Coordinates are [latitude, longitude] throughout, matching `geo.ts`. Every
 * "area" here is in square degrees — meaningless as a measurement, and used
 * ONLY to compare two rings against each other (which ring is bigger, are two
 * rings the same size). Never surface it to an operator.
 *
 * Does NOT handle polygons crossing the antimeridian, the same documented
 * limitation `pointInPolygon` carries.
 */

import { pointInPolygon, type LatLng } from "./geo.js";

/**
 * Coordinate tolerance in degrees. 1e-9° is ~0.1 mm, so it only ever bites on
 * coordinates that are meant to be identical — a child vertex snapped onto its
 * parent's edge, a ring whose closing vertex repeats the first. Leaflet emits
 * full float precision, so anything an operator actually drew is orders of
 * magnitude away from this.
 */
export const COORD_EPS = 1e-9;

/**
 * Relative tolerance for "these two rings are the same size". Compared against
 * the LARGER area, so it scales from a parking lot to a state.
 */
export const AREA_EPS_REL = 1e-12;

/** Above this vertex count `isSimpleRing`'s O(V²) scan is skipped by callers. */
export const SIMPLE_RING_MAX_VERTICES = 64;

/** Default primitive-operation ceiling for one hierarchy build. See WorkBudget. */
const DEFAULT_WORK_BUDGET = 20_000_000;

export interface Bbox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/**
 * A shared, accumulating ceiling on geometry work.
 *
 * The pathological input is real: 200 regions at the 1000-vertex schema cap,
 * several levels deep, is ~10⁸ primitive operations of edge-crossing tests.
 * Rather than let one badly-drawn region set stall a request, callers thread ONE
 * budget through the whole build; when it runs out, containment degrades to a
 * bounding-box answer marked `"approximate"` instead of taking seconds.
 *
 * Degradation is deterministic as long as the caller iterates candidate pairs in
 * a stable order — a non-deterministic degradation (levels that differ between
 * two reads of the same data) would be far worse than a slow one.
 */
export interface WorkBudget {
  remaining: number;
}

export function makeWorkBudget(ops: number = DEFAULT_WORK_BUDGET): WorkBudget {
  return { remaining: ops };
}

function spend(budget: WorkBudget | undefined, ops: number): boolean {
  if (!budget) return true;
  budget.remaining -= ops;
  return budget.remaining > 0;
}

/** Bounding box of a ring. Throws nothing: an empty ring yields an empty box. */
export function polygonBbox(ring: LatLng[]): Bbox {
  if (ring.length === 0) return { minLat: 0, minLng: 0, maxLat: 0, maxLng: 0 };
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, minLng, maxLat, maxLng };
}

/** Does `outer`'s box fully enclose `inner`'s (within eps)? */
export function bboxContainsBbox(outer: Bbox, inner: Bbox, eps: number = COORD_EPS): boolean {
  return (
    outer.minLat - eps <= inner.minLat &&
    outer.minLng - eps <= inner.minLng &&
    outer.maxLat + eps >= inner.maxLat &&
    outer.maxLng + eps >= inner.maxLng
  );
}

/** Do the two boxes overlap at all (within eps)? Touching counts as overlap. */
export function bboxesIntersect(a: Bbox, b: Bbox, eps: number = COORD_EPS): boolean {
  return !(
    a.maxLat + eps < b.minLat ||
    b.maxLat + eps < a.minLat ||
    a.maxLng + eps < b.minLng ||
    b.maxLng + eps < a.minLng
  );
}

/**
 * Drop a repeated closing vertex and any consecutive duplicates, so callers
 * don't have to care whether Leaflet closed the ring. Sign-independent
 * downstream, so winding direction is left alone.
 */
export function normalizeRing(ring: LatLng[]): LatLng[] {
  const out: LatLng[] = [];
  for (const v of ring) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev[0] - v[0]) <= COORD_EPS && Math.abs(prev[1] - v[1]) <= COORD_EPS) continue;
    out.push(v);
  }
  // The closing vertex, if the caller repeated the first point at the end.
  while (out.length > 1) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    if (Math.abs(first[0] - last[0]) <= COORD_EPS && Math.abs(first[1] - last[1]) <= COORD_EPS) {
      out.pop();
      continue;
    }
    break;
  }
  return out;
}

/**
 * |shoelace| / 2 in square degrees. Absolute, so clockwise and
 * counter-clockwise rings of the same shape return the same number — nothing
 * here depends on winding, and requiring a winding convention would mean
 * validating one on input.
 */
export function polygonAreaAbs(ring: LatLng[]): number {
  const r = normalizeRing(ring);
  if (r.length < 3) return 0;
  let sum = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [iy, ix] = r[i]!;
    const [jy, jx] = r[j]!;
    sum += jx * iy - ix * jy;
  }
  return Math.abs(sum) / 2;
}

/** Signed area of the triangle (a, b, c), doubled. Sign gives orientation. */
function orient(a: LatLng, b: LatLng, c: LatLng): number {
  return (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
}

function segLength(a: LatLng, b: LatLng): number {
  const dy = b[0] - a[0];
  const dx = b[1] - a[1];
  return Math.sqrt(dy * dy + dx * dx);
}

/** −1 / 0 / +1, with anything within `eps * scale` of zero treated as zero. */
function sign(value: number, scale: number, eps: number): number {
  if (Math.abs(value) <= eps * Math.max(scale, 1)) return 0;
  return value > 0 ? 1 : -1;
}

/** Is `p` on the segment a→b, within eps of it? */
function pointOnSegment(p: LatLng, a: LatLng, b: LatLng, eps: number): boolean {
  const len = segLength(a, b);
  if (len <= eps) {
    return Math.abs(p[0] - a[0]) <= eps && Math.abs(p[1] - a[1]) <= eps;
  }
  // |cross| / len is the perpendicular distance from p to the infinite line.
  if (Math.abs(orient(a, b, p)) > eps * len) return false;
  // Then require the projection to land within the segment.
  const dot = (p[1] - a[1]) * (b[1] - a[1]) + (p[0] - a[0]) * (b[0] - a[0]);
  if (dot < -eps * len) return false;
  if (dot > len * len + eps * len) return false;
  return true;
}

/**
 * Where a point sits relative to a ring: strictly inside, ON the boundary, or
 * outside.
 *
 * The `"boundary"` answer is the deliberate fix for `pointInPolygon`'s
 * documented "on-boundary behavior is unspecified". Containment treats boundary
 * as inside, because a child region drawn with a vertex snapped onto its
 * parent's edge is still a child — and leaving that to `pointInPolygon`'s
 * ray-casting coin flip would make nesting depend on which edge the operator
 * happened to snap to.
 */
export function pointRingPosition(
  p: LatLng,
  ring: LatLng[],
  eps: number = COORD_EPS,
): "inside" | "boundary" | "outside" {
  const r = normalizeRing(ring);
  if (r.length < 3) return "outside";
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (pointOnSegment(p, r[j]!, r[i]!, eps)) return "boundary";
  }
  return pointInPolygon(p, r) ? "inside" : "outside";
}

/**
 * Do segments a1→a2 and b1→b2 cross PROPERLY — each strictly straddling the
 * other's line?
 *
 * Returns false for a shared endpoint and for collinear overlap, and that is
 * the load-bearing part: a child region sharing an edge or a vertex with its
 * parent is nesting, not overlap, so treating a touch as a crossing would kick
 * every carefully-drawn child out of its parent.
 */
export function segmentsProperlyCross(
  a1: LatLng,
  a2: LatLng,
  b1: LatLng,
  b2: LatLng,
  eps: number = COORD_EPS,
): boolean {
  const lenA = segLength(a1, a2);
  const lenB = segLength(b1, b2);
  if (lenA <= eps || lenB <= eps) return false;
  const d1 = sign(orient(b1, b2, a1), lenB, eps);
  const d2 = sign(orient(b1, b2, a2), lenB, eps);
  const d3 = sign(orient(a1, a2, b1), lenA, eps);
  const d4 = sign(orient(a1, a2, b2), lenA, eps);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Does any edge of `a` properly cross any edge of `b`?
 *
 * Returns `"budget"` when the shared work budget ran out mid-scan — the caller
 * must treat that as "unknown", never as "no crossing".
 */
export function ringsProperlyCross(
  a: LatLng[],
  b: LatLng[],
  budget?: WorkBudget,
): boolean | "budget" {
  const ra = normalizeRing(a);
  const rb = normalizeRing(b);
  if (ra.length < 3 || rb.length < 3) return false;
  for (let i = 0, ip = ra.length - 1; i < ra.length; ip = i++) {
    if (!spend(budget, rb.length)) return "budget";
    for (let j = 0, jp = rb.length - 1; j < rb.length; jp = j++) {
      if (segmentsProperlyCross(ra[ip]!, ra[i]!, rb[jp]!, rb[j]!)) return true;
    }
  }
  return false;
}

/**
 * Does the ring cross itself? O(V²), so callers gate on
 * SIMPLE_RING_MAX_VERTICES — real operator-drawn regions are 4–30 vertices.
 *
 * Worth checking because `leaflet-draw` only enforces `allowIntersection:false`
 * on a NEWLY drawn ring; dragging a vertex afterwards can still produce a
 * bow-tie.
 */
export function isSimpleRing(ring: LatLng[]): boolean {
  const r = normalizeRing(ring);
  if (r.length < 4) return true;
  for (let i = 0; i < r.length; i++) {
    const a1 = r[i]!;
    const a2 = r[(i + 1) % r.length]!;
    for (let j = i + 1; j < r.length; j++) {
      // Skip adjacent edges (they legitimately share an endpoint) and the
      // wrap-around pair of the first and last edge.
      if (j === i || j === i + 1) continue;
      if (i === 0 && j === r.length - 1) continue;
      const b1 = r[j]!;
      const b2 = r[(j + 1) % r.length]!;
      if (segmentsProperlyCross(a1, a2, b1, b2)) return false;
    }
  }
  return true;
}

/**
 * `"contains"`   — every point of `inner` is inside-or-on `outer`.
 * `"overlaps"`   — they intersect but `outer` does not contain `inner`.
 * `"disjoint"`   — no intersection.
 * `"equal-area"` — the same size within AREA_EPS_REL, so neither contains the
 *                  other. This is what makes containment a STRICT partial order
 *                  and therefore acyclic: no pair can each contain the other.
 * `"approximate"`— the work budget ran out; the answer is the bounding-box
 *                  answer and the caller should flag it to the operator.
 */
export type PolygonRelation = "contains" | "overlaps" | "disjoint" | "equal-area" | "approximate";

export interface ContainsOptions {
  budget?: WorkBudget;
  /** Precomputed, to avoid recomputing per candidate pair in a hierarchy build. */
  outerBbox?: Bbox;
  innerBbox?: Bbox;
  outerArea?: number;
  innerArea?: number;
}

/**
 * Does `outer` contain `inner`? Answers about that ONE direction, so a caller
 * comparing a pair either tests both orders or (better) only tests the
 * larger-area ring as the outer.
 *
 * Three tests, in this order, and all three are needed:
 *
 *  1. **Bbox prefilter** — rejects nearly every real pair in O(1), which is
 *     what makes the whole build cheap.
 *  2. **Every vertex of `inner` is inside-or-on `outer`**, early-exiting on the
 *     first outside vertex. The early exit is why a rejected candidate normally
 *     costs one point test rather than V_inner of them.
 *  3. **No edge of `inner` properly crosses an edge of `outer`.** Step 2 alone
 *     is WRONG for a concave outer: a child can have every vertex inside a
 *     C-shaped parent while its body cuts straight across the notch. This is
 *     the case a naive implementation gets wrong and the reason this function
 *     is not four lines.
 */
export function polygonContainsPolygon(
  outer: LatLng[],
  inner: LatLng[],
  opts: ContainsOptions = {},
): PolygonRelation {
  const ro = normalizeRing(outer);
  const ri = normalizeRing(inner);
  if (ro.length < 3 || ri.length < 3) return "disjoint";

  const outerBox = opts.outerBbox ?? polygonBbox(ro);
  const innerBox = opts.innerBbox ?? polygonBbox(ri);

  const areaOuter = opts.outerArea ?? polygonAreaAbs(ro);
  const areaInner = opts.innerArea ?? polygonAreaAbs(ri);
  const areaScale = Math.max(areaOuter, areaInner);
  if (areaScale > 0 && Math.abs(areaOuter - areaInner) <= AREA_EPS_REL * areaScale) {
    return "equal-area";
  }

  if (!bboxesIntersect(outerBox, innerBox)) return "disjoint";

  // A zero-area ring (all vertices collinear) can be a child but can never be
  // a parent — `pointInPolygon` reports every point outside it.
  if (areaOuter <= 0) return "overlaps";

  if (!bboxContainsBbox(outerBox, innerBox)) return "overlaps";

  if (!spend(opts.budget, ri.length * ro.length)) {
    // Budget gone. The bbox already says outer encloses inner, so report that
    // as an explicitly approximate containment rather than guessing either way.
    return "approximate";
  }

  for (const v of ri) {
    if (pointRingPosition(v, ro) === "outside") return "overlaps";
  }

  const crosses = ringsProperlyCross(ri, ro, opts.budget);
  if (crosses === "budget") return "approximate";
  return crosses ? "overlaps" : "contains";
}
