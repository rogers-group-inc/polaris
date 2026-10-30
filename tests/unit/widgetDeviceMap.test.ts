/**
 * tests/unit/widgetDeviceMap.test.ts
 *
 * The Device Map dashboard widget (public/js/widgets/deviceMap.js) decides
 * what to draw from its FortiGates pick:
 *   • no pick / several picked → a Leaflet map (several = just those gates);
 *   • ONE picked → no map at all: that gate's topology, read-only.
 * Same harness as widgetAssetTypes: index.js is eval'd into a happy-dom
 * window with the app-shell globals stubbed, then the widget registers itself
 * and is pulled back off the registry. Leaflet is deliberately NOT stubbed —
 * the single-gate path must not need it. Cytoscape and the topology renderer
 * are fakes that record what the widget asked for, which is what "read-only"
 * means here: nothing grabbable, nothing selectable, no editable lines.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";

interface Module {
  fetchData: (config: Record<string, unknown>) => Promise<unknown>;
  renderInstance: (el: unknown, config: Record<string, unknown>, data: unknown, ctx: { onUnmount: (fn: () => void) => void }) => void;
  renderConfig: (el: unknown, config: Record<string, unknown>, onChange: (k: string, v: unknown) => void) => void;
  defaultConfig: Record<string, unknown>;
}
interface Widgets { getByType: (t: string) => Module }

const GATES = [
  { id: "fg-atl", name: "ATLANTA-FG", regions: ["East"] },
  { id: "fg-river", name: "RIVERBEND-FG", regions: ["Central"] },
];
const topology = vi.fn();
const sites = vi.fn();
const cyOptions: Array<Record<string, unknown>> = [];
const editorOpts: Array<{ isEditable: () => boolean }> = [];

let W: Widgets;
let win: Window;
let doc: Window["document"];
const g = globalThis as Record<string, unknown>;

/** A Cytoscape stand-in: enough surface for drawTopology to run end to end. */
function fakeCytoscape(opts: Record<string, unknown>) {
  cyOptions.push(opts);
  const handlers: Record<string, () => void> = {};
  const coll = { forEach: () => {}, panify: () => coll, length: 0 };
  const cy = {
    one: (ev: string, fn: () => void) => { handlers[ev] = fn; },
    on: () => {},
    nodes: () => coll,
    batch: (fn: () => void) => fn(),
    fit: () => {},
    zoom: () => 1,
    pan: () => ({ x: 0, y: 0 }),
    resize: () => {},
    destroy: () => {},
    layout: () => ({ run: () => handlers.layoutstop && handlers.layoutstop() }),
  };
  return cy;
}

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  // The widget loads Cytoscape + the renderer on demand by <script src>,
  // skipping any already on the page. Seat all five (with file loading off),
  // as a page that had loaded them would; the fakes below stand in for what
  // they define.
  win = new Window({ settings: { disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true } });
  doc = win.document;
  for (const src of [
    "/js/vendor/cytoscape.min.js", "/js/vendor/dagre.min.js", "/js/vendor/cytoscape-dagre.js",
    "/js/topology-render.js", "/js/topology-edge-editor.js",
  ]) {
    const s = doc.createElement("script");
    s.setAttribute("src", src);
    doc.head.appendChild(s);
  }
  g.window = win;
  g.document = doc;
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.ResizeObserver = class { observe() {} disconnect() {} };
  g.api = {
    dashboard: { filterOptions: () => Promise.resolve({ assetTypes: [], regions: ["East", "Central"], fortigates: GATES }) },
    map: { topology, sites },
  };
  const w = win as unknown as Record<string, unknown>;
  w.cytoscape = fakeCytoscape;
  w.PolarisTopologyRender = {
    buildTopologyElements: () => [{ data: { id: "fg-river" } }],
    computeGroupedLayout: () => null,
    computeTopologyColumns: () => ({ "fg-river": { depth: 0, lane: 0 } }),
    topologyStylesheet: () => [],
    renderLocationGroups: () => {},
    routeInterGroupEdges: () => {},
    markFanOutEdges: () => {},
    wireBentEdgeLabels: () => {},
  };
  w.PolarisTopologyEdgeEditor = { attach: (_cy: unknown, o: { isEditable: () => boolean }) => { editorOpts.push(o); } };
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/index.js"), "utf8"));
  W = (win as unknown as { PolarisWidgets: Widgets }).PolarisWidgets;
  g.PolarisWidgets = W;
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/deviceMap.js"), "utf8"));
});

beforeEach(() => {
  topology.mockReset().mockResolvedValue({ nodes: [], edges: [], savedLayouts: {} });
  sites.mockReset().mockResolvedValue([]);
  cyOptions.length = 0;
  editorOpts.length = 0;
});

const mod = () => W.getByType("deviceMap");

describe("Device Map widget — config", () => {
  it("no longer carries the issues-only toggle", () => {
    expect(mod().defaultConfig).not.toHaveProperty("issuesOnly");
    const el = doc.createElement("div");
    mod().renderConfig(el, { regionScope: "all" }, () => {});
    expect(el.querySelector('[data-k="issuesOnly"]')).toBeNull();
  });

  it("offers Regions and FortiGates, but no asset types", () => {
    const el = doc.createElement("div");
    mod().renderConfig(el, { regionScope: "all" }, () => {});
    expect(el.querySelector('[data-filter="regions"]')).not.toBeNull();
    expect(el.querySelector('[data-filter="fortigates"]')).not.toBeNull();
    expect(el.querySelector('[data-filter="assetTypes"]')).toBeNull();
  });
});

describe("Device Map widget — fetchData by FortiGates pick", () => {
  it("one gate → resolves that gate's asset id, no /map/sites fetch", async () => {
    const data = await mod().fetchData({ fortigateScope: "custom", fortigates: ["RIVERBEND-FG"] });
    expect(data).toEqual({ gate: { id: "fg-river", name: "RIVERBEND-FG" } });
    expect(sites).not.toHaveBeenCalled();
  });

  it("one gate no longer in the fleet → a null id", async () => {
    const data = await mod().fetchData({ fortigateScope: "custom", fortigates: ["GONE-FG"] });
    expect(data).toEqual({ gate: { id: null, name: "GONE-FG" } });
  });

  it("several gates → the map's /map/sites rows", async () => {
    sites.mockResolvedValue([{ id: "fg-atl" }]);
    const data = await mod().fetchData({ regionScope: "all", fortigateScope: "custom", fortigates: ["ATLANTA-FG", "RIVERBEND-FG"] });
    expect(data).toEqual([{ id: "fg-atl" }]);
  });

  it("the (No FortiGate) sentinel is not a gate", async () => {
    // A region scope of its own: getMapSites memoizes per region list, and the
    // test above already filled the unscoped slot.
    sites.mockResolvedValue([{ id: "fg-river" }]);
    const data = await mod().fetchData({ regionScope: "custom", regions: ["Central"], fortigateScope: "custom", fortigates: ["__none__"] });
    expect(data).toEqual([{ id: "fg-river" }]);
  });
});

describe("Device Map widget — one gate picked", () => {
  function renderSolo(data: unknown) {
    const el = doc.createElement("div");
    doc.body.appendChild(el);
    const unmounts: Array<() => void> = [];
    mod().renderInstance(el, { fortigateScope: "custom", fortigates: ["RIVERBEND-FG"] }, data, { onUnmount: (fn) => unmounts.push(fn) });
    return { el, unmount: () => unmounts.forEach((fn) => fn()) };
  }

  it("draws the gate's topology with no map, read-only", async () => {
    const { el, unmount } = renderSolo({ gate: { id: "fg-river", name: "RIVERBEND-FG" } });
    expect(el.querySelector(".leaflet-container")).toBeNull();
    expect(el.querySelector(".devmap-topo")).not.toBeNull();
    expect(el.querySelector(".devmap-topo-title")!.textContent).toBe("RIVERBEND-FG");
    // The renderer scripts load on demand; the graph follows once they have.
    await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
    expect(topology).toHaveBeenCalledWith("fg-river");
    expect(cyOptions).toHaveLength(1);
    expect(cyOptions[0]).toMatchObject({ autoungrabify: true, autounselectify: true, boxSelectionEnabled: false });
    expect(editorOpts).toHaveLength(1);
    expect(editorOpts[0].isEditable()).toBe(false);
    unmount();
    expect(el.querySelector(".devmap-topo")).toBeNull();
  });

  it("has no back-to-map button (there is no map to go back to)", () => {
    const { el, unmount } = renderSolo({ gate: { id: "fg-river", name: "RIVERBEND-FG" } });
    const labels = Array.from(el.querySelectorAll(".devmap-topo-bar button")).map((b) => b.textContent);
    expect(labels).not.toContain("← Map");
    expect(labels).toContain("Fit");
    unmount();
  });

  it("says so when the picked gate has left the fleet", () => {
    const { el, unmount } = renderSolo({ gate: { id: null, name: "RIVERBEND-FG" } });
    expect(el.textContent).toContain("no longer in the fleet");
    expect(topology).not.toHaveBeenCalled();
    unmount();
  });
});
