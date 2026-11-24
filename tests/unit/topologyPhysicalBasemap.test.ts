/**
 * tests/unit/topologyPhysicalBasemap.test.ts
 *
 * A read-only Topology canvas (public/js/topology-physical.js) as the Device
 * Map widget mounts it on the Dashboard and the /dash wallboard (operator
 * report 2026-11-24: no Map | Satellite switch on dash, and the eye "doesn't
 * work"):
 *   - the satellite tiles come from the API base (api.map.satelliteTileUrl),
 *     so the wallboard asks its own listener, not the signed-in /api/v1;
 *   - viewState() carries the viewer's basemap pick and whether the eye panel
 *     is open, and a canvas mounted with that as ctx.initial (the widget's
 *     minute refresh) keeps the pick instead of reverting to the view's own.
 *
 * Mounts the real canvas with the vendored Leaflet.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const js = (f: string) => readFileSync(join(process.cwd(), "public", "js", f), "utf-8");
const w = () => window as any;
const DASH_TILES = "/dash/api/v1/map/satellite/{z}/{x}/{y}";

let maps: any[] = [];
let mounted: { inst: any; host: HTMLElement }[] = [];

function mount(initial: any = null, editing = false) {
  const host = document.createElement("div");
  host.style.width = "800px";
  host.style.height = "600px";
  document.body.appendChild(host);
  const inst = w().PolarisTopologyPhysical.render(host, {
    data: { nodes: [], edges: [] },
    view: { id: "v1", polygons: [] },
    editing,
    canEdit: editing,
    initial,
    stagedViewPatch: () => ({}),
    stageViewPatch: () => false,
    stagePlacements: () => false,
    stageLocationCode: () => {},
    loadPlacements: () => ({}),
    historyChanged: () => {},
    refreshSidebar: () => {},
    listViews: () => [],
    toast: () => {},
    linkTip: { show() {}, move() {}, hide() {} },
    closePopovers: () => {},
    selectedId: () => null,
  });
  mounted.push({ inst, host });
  return { inst, host, map: maps[maps.length - 1] };
}

function tileUrl(map: any): string | null {
  let url: string | null = null;
  map.eachLayer((l: any) => { if (l instanceof w().L.TileLayer) url = l._url; });
  return url;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  // The eye's choices persist per view in localStorage; each test starts clean.
  window.localStorage.clear();
  (globalThis as any).api = {
    map: {
      satellite: () => Promise.resolve({ available: true, attribution: "", maxNativeZoom: 19, source: "custom" }),
      satelliteTileUrl: () => DASH_TILES,
    },
  };
  (globalThis as any).esc = (s: unknown) => String(s ?? "");
  if (!w().L) {
    (0, eval)(js("vendor/leaflet/leaflet.js"));
    (0, eval)(js("topology-render.js"));
    (0, eval)(js("topology-physical.js"));
    for (const k of ["L", "PolarisTopologyRender", "PolarisTopologyPhysical"]) w()[k] = (globalThis as any)[k] ?? w()[k];
    w().L.Map.addInitHook(function (this: any) { maps.push(this); });
  }
  maps = [];
});

afterEach(() => {
  for (const m of mounted) {
    try { m.inst?.destroy?.(); } catch { /* already gone */ }
    m.host.remove();
  }
  mounted = [];
});

describe("Topology canvas basemap and eye on the Device Map widget", () => {
  it("draws satellite tiles from the API base, and the switch appears once satellite is configured", async () => {
    const { host, map } = mount();
    await flush();
    const sw = host.querySelector(".topo-phys-layer-switch");
    expect(sw).toBeTruthy();
    (sw!.querySelector('[data-layer="satellite"]') as HTMLElement).click();
    expect(tileUrl(map)).toBe(DASH_TILES);
  });

  it("a re-mount with viewState() as ctx.initial keeps the viewer's Satellite pick", async () => {
    const first = mount();
    await flush();
    (first.host.querySelector('[data-layer="satellite"]') as HTMLElement).click();
    const state = first.inst.viewState();
    expect(state.basemap).toBe("satellite");
    first.inst.destroy();

    const second = mount(state);
    await flush();
    expect(tileUrl(second.map)).toBe(DASH_TILES);
    expect(second.host.querySelector('[data-layer="satellite"]')!.classList.contains("is-on")).toBe(true);
  });

  it("viewState() reports an open eye panel, so the widget can reopen it after a refresh", async () => {
    const { inst } = mount();
    await flush();
    const eye = inst.cornerButtons().find((b: any) => !b.editOnly);
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    eye.onClick(anchor);
    expect(document.querySelector(".topo-vis-panel")).toBeTruthy();
    expect(inst.viewState().visOpen).toBe(true);
    inst.destroy();
    expect(document.querySelector(".topo-vis-panel")).toBeNull();
    anchor.remove();
  });

  // Operator request 2026-11-24: editing used to show everything, and its
  // eye held only the ArcGIS section (or did nothing without ArcGIS).
  it("offers the device, group and connection switches while editing, and honours them", async () => {
    const { inst, host } = mount(null, true);
    await flush();
    const eye = inst.cornerButtons().find((b: any) => b.id === "topology-visibility");
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    eye.onClick(anchor);
    const panel = document.querySelector(".topo-vis-panel") as HTMLElement;
    expect(panel).toBeTruthy();
    for (const k of ["devices", "groups", "links"]) {
      expect(panel.querySelector(`[data-vis-show="${k}"]`), k).toBeTruthy();
    }
    expect(panel.querySelector('[data-vis-labels="devices"]')).toBeTruthy();
    expect(panel.querySelector('[data-vis-labels="groups"]')).toBeTruthy();
    // Unticking device labels hides them on the map while editing.
    const labels = panel.querySelector('[data-vis-labels="devices"]') as HTMLInputElement;
    labels.checked = false;
    labels.dispatchEvent(new Event("change", { bubbles: true }));
    const mapEl = host.querySelector(".leaflet-container") as HTMLElement;
    expect(mapEl.classList.contains("vis-no-device-labels")).toBe(true);
    anchor.remove();
  });
});
