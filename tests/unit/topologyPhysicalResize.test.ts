/**
 * tests/unit/topologyPhysicalResize.test.ts
 *
 * A Topology view opens centred on its ground (the saved centre, else the
 * FortiGate's latitude / longitude), and STAYS centred when the canvas's box
 * changes size after mount — the modal settling, the device list pane
 * filling. Leaflet only watches the window, so before the canvas's
 * ResizeObserver a late resize left the map pinned at its top-left and a new
 * view opened beside its FortiGate (operator report 2026-11-24).
 *
 * happy-dom lays nothing out: the container's size and ResizeObserver are stubbed.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const js = (f: string) => readFileSync(join(process.cwd(), "public", "js", f), "utf-8");
const w = () => window as any;
const CENTER: [number, number] = [36.1627, -86.7816];

let maps: any[] = [];
let observers: { cb: () => void; targets: Element[]; live: boolean }[] = [];
let inst: any;
let host: HTMLElement;

class FakeResizeObserver {
  rec: { cb: () => void; targets: Element[]; live: boolean };
  constructor(cb: () => void) { this.rec = { cb, targets: [], live: true }; observers.push(this.rec); }
  observe(el: Element) { this.rec.targets.push(el); }
  disconnect() { this.rec.live = false; }
}

function sizeOf(el: Element, width: number, height: number) {
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => height });
}

const nextFrame = () => new Promise((r) => setTimeout(r, 40));

beforeEach(() => {
  (globalThis as any).api = { map: { satellite: () => Promise.resolve({ available: false }) } };
  (globalThis as any).esc = (s: unknown) => String(s ?? "");
  w().ResizeObserver = FakeResizeObserver;
  (globalThis as any).ResizeObserver = FakeResizeObserver;
  if (!w().L) {
    (0, eval)(js("vendor/leaflet/leaflet.js"));
    (0, eval)(js("topology-render.js"));
    (0, eval)(js("topology-physical.js"));
    for (const k of ["L", "PolarisTopologyRender", "PolarisTopologyPhysical"]) w()[k] = (globalThis as any)[k] ?? w()[k];
    w().L.Map.addInitHook(function (this: any) { maps.push(this); });
  }
  maps = [];
  observers = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  inst = w().PolarisTopologyPhysical.render(host, {
    data: { nodes: [], edges: [] },
    view: { id: "v1", polygons: [], background: { kind: "osm", center: CENTER, zoom: 19 } },
    editing: false,
    canEdit: false,
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
});

afterEach(() => {
  try { inst?.destroy?.(); } catch { /* already gone */ }
  host.remove();
});

describe("Topology canvas keeps its centre through a resize", () => {
  it("watches the map's box and re-centres after it grows", async () => {
    const map = maps[maps.length - 1];
    const mapEl = map.getContainer();
    const obs = observers.find((o) => o.targets.includes(mapEl));
    expect(obs).toBeTruthy();

    // Mounted while the box had no size (the modal still animating in).
    const before = map.getCenter();
    expect(before.lat).toBeCloseTo(CENTER[0], 4);

    sizeOf(mapEl, 1200, 800);
    obs!.cb();
    await nextFrame();

    const after = map.getCenter();
    expect(after.lat).toBeCloseTo(CENTER[0], 4);
    expect(after.lng).toBeCloseTo(CENTER[1], 4);
  });

  it("stops watching when the canvas is torn down", () => {
    const map = maps[maps.length - 1];
    const obs = observers.find((o) => o.targets.includes(map.getContainer()));
    inst.destroy();
    inst = null;
    expect(obs!.live).toBe(false);
  });
});
