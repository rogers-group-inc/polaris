/**
 * tests/unit/topologyPhysicalReshape.test.ts
 *
 * The Topology-mode canvas's polygon Reshape (public/js/topology-physical.js
 * → reshapePolygon / endReshape). The new corners used to reach the polygon
 * only on a click on the map outside it, so an operator who reshaped and then
 * pressed the check mark saved the OLD shape and watched it snap back
 * (operator report 2026-11-18). The check mark (beforeCommit) now lands an
 * open reshape first; × / leaving edit mode drops it.
 *
 * Mounts the real canvas with the vendored Leaflet + Leaflet.draw.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const js = (f: string) => readFileSync(join(process.cwd(), "public", "js", f), "utf-8");
const w = () => window as any;

let menuItems: any[] = [];
let staged: any[] = [];
let inst: any;
let host: HTMLElement;
let lastMap: any = null;

const SQUARE = [[0, 0], [100, 0], [100, 100], [0, 100]];

beforeEach(() => {
  if (!w().L) {
    (0, eval)(js("vendor/leaflet/leaflet.js"));
    (0, eval)(js("vendor/leaflet/leaflet.draw.js"));
    (0, eval)(js("topology-render.js"));
    (0, eval)(js("topology-physical.js"));
    for (const k of ["L", "PolarisTopologyRender", "PolarisTopologyPhysical"]) w()[k] = (globalThis as any)[k] ?? w()[k];
    // Leaflet init hooks receive the new map only as `this`.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    w().L.Map.addInitHook(function (this: any) { lastMap = this; });
  }
  menuItems = [];
  staged = [];
  (globalThis as any).showRowMenu = (_a: unknown, items: any[]) => { menuItems = items; };
  (globalThis as any).esc = (s: unknown) => String(s ?? "");
  host = document.createElement("div");
  host.style.width = "800px";
  host.style.height = "600px";
  document.body.appendChild(host);
  inst = w().PolarisTopologyPhysical.render(host, {
    data: { nodes: [], edges: [] },
    view: { polygons: [{ id: "p1", codes: { building: "B1" }, points: SQUARE.map((q) => q.slice()), layer: 0 }] },
    editing: true,
    canEdit: true,
    stagedViewPatch: () => null,
    stageViewPatch: (patch: any) => { if (patch.polygons) staged.push(JSON.parse(JSON.stringify(patch.polygons))); },
    stagePlacements: () => {},
    stageLocationCode: () => {},
    loadPlacements: () => ({}),
    historyChanged: () => {},
    refreshSidebar: () => {},
    listViews: () => [],
    toast: () => {},
    linkTip: () => "",
    closePopovers: () => {},
    selectedId: () => null,
  });
});

afterEach(() => {
  try { inst?.destroy?.(); } catch { /* already gone */ }
  host.remove();
});

/** Open the polygon's menu, choose Reshape, drag its second corner, return the shape. */
function reshapeSecondCorner(): any {
  const map = findMap();
  let shape: any = null;
  map.eachLayer((l: any) => { if (l instanceof w().L.Polygon && !shape) shape = l; });
  expect(shape).toBeTruthy();
  shape.fire("contextmenu", { originalEvent: { clientX: 1, clientY: 1, preventDefault() {} } });
  const reshape = menuItems.find((i) => i.label === "Reshape");
  expect(reshape).toBeTruthy();
  reshape.onSelect();
  const ring = shape.getLatLngs()[0];
  const far = map.containerPointToLatLng(map.latLngToContainerPoint(ring[1]).add([60, 0]));
  ring[1] = far;
  shape.setLatLngs([ring]);
  return shape;
}

/** The canvas keeps its map private: an init hook records each map made. */
function findMap(): any {
  expect(lastMap).toBeTruthy();
  return lastMap;
}

describe("Topology polygon Reshape", () => {
  it("the check mark saves a reshape that was never ended with a map click", () => {
    reshapeSecondCorner();
    expect(staged).toHaveLength(0); // nothing landed yet — this is the old bug's state
    inst.beforeCommit();
    expect(staged.length).toBeGreaterThan(0);
    const saved = staged[staged.length - 1][0].points;
    expect(saved[1][0]).toBeGreaterThan(SQUARE[1]![0]! + 1); // the corner moved right
    expect(saved[0]).toEqual(SQUARE[0]);
  });

  it("leaving edit mode without the check mark drops it", () => {
    reshapeSecondCorner();
    inst.setEditing(false);
    expect(staged).toHaveLength(0);
    inst.beforeCommit(); // nothing open any more: nothing lands
    expect(staged).toHaveLength(0);
  });
});
