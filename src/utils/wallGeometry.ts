/**
 * src/utils/wallGeometry.ts — pure geometry for a Wall view (business rule 151).
 *
 * A wall is a grid of 1-inch cells (the pegboard). An item mounted on it is a
 * polygon whose corners sit on whole inches. Two items OVERLAP when they claim
 * a common cell — a cell belongs to an item when the cell's centre lies inside
 * the item's polygon. That rule is exact for the shapes the editor makes (every
 * corner snaps to the grid), lets two items share an edge (mounted side by
 * side), and is the same few lines in the browser (public/js/topology-wall.js
 * → cellsOf / overlaps), so the client refuses exactly what the server refuses.
 */

export type Point = [number, number];

/** Even-odd point-in-polygon. */
export function pointInPolygon(x: number, y: number, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The 1-inch cells ("x,y" of the cell's top-left corner) a polygon claims. */
export function cellsOf(ring: Point[]): Set<string> {
  const out = new Set<string>();
  if (ring.length < 3) return out;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  for (let cy = Math.floor(minY); cy < Math.ceil(maxY); cy++) {
    for (let cx = Math.floor(minX); cx < Math.ceil(maxX); cx++) {
      if (pointInPolygon(cx + 0.5, cy + 0.5, ring)) out.add(cx + "," + cy);
    }
  }
  return out;
}

/** Do two polygons claim a common cell? */
export function polygonsOverlap(a: Point[], b: Point[]): boolean {
  const small = cellsOf(a.length <= b.length ? a : b);
  const big = a.length <= b.length ? b : a;
  for (const key of small) {
    const [cx, cy] = key.split(",").map(Number);
    if (pointInPolygon(cx + 0.5, cy + 0.5, big)) return true;
  }
  return false;
}

/** Twice the signed area; 0 = degenerate (a line or a point). */
export function doubleArea(ring: Point[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return s;
}
