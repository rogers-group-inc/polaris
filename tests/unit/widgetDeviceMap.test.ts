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
/** The last fake graph's handlers, keyed "<event> <selector>". */
let cyHandlers: Record<string, (evt: unknown) => void> = {};
const editorOpts: Array<{ isEditable: () => boolean }> = [];
/** The site's location views the fake computeFloorViews reports (none by default). */
let floorViews: Array<Record<string, string>> = [];
/** Every view key the widget asked partitionElementsForFloor to cut to. */
const partitioned: string[] = [];

let W: Widgets;
let win: Window;
let doc: Window["document"];
const g = globalThis as Record<string, unknown>;

/** A Cytoscape stand-in: enough surface for drawTopology to run end to end. */
function fakeCytoscape(opts: Record<string, unknown>) {
  cyOptions.push(opts);
  const handlers: Record<string, () => void> = {};
  cyHandlers = {};
  const coll = { forEach: () => {}, panify: () => coll, length: 0 };
  const cy = {
    one: (ev: string, fn: () => void) => { handlers[ev] = fn; },
    on: (ev: string, sel: unknown, fn?: (evt: unknown) => void) => {
      if (typeof sel === "string" && fn) cyHandlers[ev + " " + sel] = fn;
    },
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
    buildTopologyElements: () => [
      { data: { id: "fg-river", role: "fortigate" } },
      { data: { id: "sw-1", role: "fortiswitch" } },
      { data: { id: "ap-1", role: "fortiap" } },
      { data: { id: "e1", source: "fg-river", target: "sw-1" } },
      { data: { id: "e2", source: "sw-1", target: "ap-1" } },
    ],
    topologyLegendSpec: () => ({
      nodes: [{ label: "FortiGate" }, { label: "FortiSwitch" }, { label: "FortiAP" }, { label: "Endpoint" }, { label: "Remote asset" }],
      health: [], edges: [],
    }),
    // Records the node rows it was handed, as the real one would draw them.
    topologyLegendHtml: (spec: { nodes: { label: string }[] }) =>
      '<p class="legend-nodes">' + spec.nodes.map((n) => n.label).join("|") + "</p>",
    computeFloorViews: () => floorViews,
    // The real switcher's shape: a Base row, then one chip per view handed in.
    viewSwitcherRows: (views: Array<Record<string, string>>, active: string) => [
      [{ key: "flat", label: "Base", title: "Whole site", active: active === "flat" }],
      views.map((v) => ({ key: v.key, label: v.label, title: v.label, active: v.key === active })),
    ],
    partitionElementsForFloor: (els: unknown[], key: string) => { partitioned.push(key); return els; },
    computeGroupedLayout: () => null,
    computeTopologyColumns: () => ({ "fg-river": { depth: 0, lane: 0 } }),
    topologyStylesheet: () => [],
    renderLocationGroups: () => {},
    routeInterGroupEdges: () => {},
    markFanOutEdges: () => {},
    wireBentEdgeLabels: () => {},
    edgeTooltipHtml: () => "<div>SW-A ⇄ SW-B</div>",
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
  floorViews = [];
  partitioned.length = 0;
});

const mod = () => W.getByType("deviceMap");

describe("Device Map widget — config", () => {
  it("no longer carries the issues-only toggle", () => {
    expect(mod().defaultConfig).not.toHaveProperty("issuesOnly");
    const el = doc.createElement("div");
    mod().renderConfig(el, { regionScope: "all" }, () => {});
    expect(el.querySelector('[data-k="issuesOnly"]')).toBeNull();
  });

  it("offers Device types, all ticked by default, and stores the UNticked ones", () => {
    const el = doc.createElement("div");
    const changes: Array<[string, unknown]> = [];
    mod().renderConfig(el, { regionScope: "all" }, (k, v) => changes.push([k, v]));
    const boxes = Array.from(el.querySelectorAll("[data-topo-role]")) as unknown as { checked: boolean; getAttribute: (a: string) => string; dispatchEvent: (e: unknown) => void }[];
    expect(boxes.map((b) => b.getAttribute("data-topo-role"))).toEqual(["fortigate", "fortiswitch", "fortiap", "remote-asset"]);
    expect(boxes.every((b) => b.checked)).toBe(true);
    boxes[2].checked = false;
    boxes[2].dispatchEvent(new win.Event("change"));
    expect(changes.at(-1)).toEqual(["topologyHide", ["fortiap"]]);

    const el2 = doc.createElement("div");
    mod().renderConfig(el2, { regionScope: "all", topologyHide: ["fortiap"] }, () => {});
    const ap = el2.querySelector('[data-topo-role="fortiap"]') as unknown as { checked: boolean };
    expect(ap.checked).toBe(false);
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

  it("hovering a link shows the Device Map's link tooltip; leaving hides it", async () => {
    const { unmount } = renderSolo({ gate: { id: "fg-river", name: "RIVERBEND-FG" } });
    await vi.waitFor(() => expect(cyHandlers["mouseover edge"]).toBeTypeOf("function"), { timeout: 2000 });
    cyHandlers["mouseover edge"]({ target: {}, originalEvent: { clientX: 10, clientY: 10 } });
    const tip = doc.getElementById("topology-edge-tooltip")!;
    expect(tip.classList.contains("visible")).toBe(true);
    expect(tip.textContent).toContain("SW-A ⇄ SW-B");
    cyHandlers["mouseout edge"]({});
    expect(tip.classList.contains("visible")).toBe(false);
    // An unmount under the cursor must not strand an open tooltip.
    cyHandlers["mouseover edge"]({ target: {} });
    unmount();
    expect(tip.classList.contains("visible")).toBe(false);
  });

  it("on the /dash wallboard there is no Open button (the kiosk does not navigate)", () => {
    const w = win as unknown as Record<string, unknown>;
    w.POLARIS_DASH_LOCAL = true;
    try {
      const { el, unmount } = renderSolo({ gate: { id: "fg-river", name: "RIVERBEND-FG" } });
      const labels = Array.from(el.querySelectorAll(".devmap-topo-bar button")).map((b) => b.textContent);
      expect(labels).not.toContain("Open ↗");
      expect(labels).toContain("Fit");
      unmount();
    } finally {
      delete w.POLARIS_DASH_LOCAL;
    }
  });

  it("on the Dashboard the Open button leads to the Device Map page", () => {
    const { el, unmount } = renderSolo({ gate: { id: "fg-river", name: "RIVERBEND-FG" } });
    const labels = Array.from(el.querySelectorAll(".devmap-topo-bar button")).map((b) => b.textContent);
    expect(labels).toContain("Open ↗");
    unmount();
  });

  it("draws a legend from the Device Map's key, without the endpoint-search row", async () => {
    const { el, unmount } = renderSolo({ gate: { id: "fg-river", name: "RIVERBEND-FG" } });
    await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
    const legend = el.querySelector(".devmap-topo-legend")!;
    expect(legend).not.toBeNull();
    expect(legend.hasAttribute("hidden")).toBe(false);
    expect(legend.querySelector(".legend-nodes")!.textContent).toBe("FortiGate|FortiSwitch|FortiAP|Remote asset");
    unmount();
  });

  it("the gear's unticked device types are not drawn, nor their links, nor their legend rows", async () => {
    const el = doc.createElement("div");
    doc.body.appendChild(el);
    const unmounts: Array<() => void> = [];
    mod().renderInstance(el, { fortigateScope: "custom", fortigates: ["RIVERBEND-FG"], topologyHide: ["fortiap", "remote-asset"] },
      { gate: { id: "fg-river", name: "RIVERBEND-FG" } }, { onUnmount: (fn) => unmounts.push(fn) });
    await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
    const ids = (cyOptions[0].elements as { data: { id: string } }[]).map((e) => e.data.id);
    expect(ids).toEqual(["fg-river", "sw-1", "e1"]);
    expect(el.querySelector(".legend-nodes")!.textContent).toBe("FortiGate|FortiSwitch");
    unmounts.forEach((fn) => fn());
  });

  it("says so when the picked gate has left the fleet", () => {
    const { el, unmount } = renderSolo({ gate: { id: null, name: "RIVERBEND-FG" } });
    expect(el.textContent).toContain("no longer in the fleet");
    expect(topology).not.toHaveBeenCalled();
    unmount();
  });
});

describe("Device Map widget — location drill-down and lock", () => {
  const VIEWS = [
    { key: "a|mine", kind: "area", areaKey: "mine", buildingKey: "", label: "Mine" },
    { key: "b|mine|b1", kind: "building", areaKey: "mine", buildingKey: "b1", label: "Mine — B1" },
    { key: "a|yard", kind: "area", areaKey: "yard", buildingKey: "", label: "Yard" },
    { key: "b|yard|scale", kind: "building", areaKey: "yard", buildingKey: "scale", label: "Yard — Scale" },
  ];
  const GATE = { gate: { id: "fg-river", name: "RIVERBEND-FG" } };
  type El = { querySelectorAll: (s: string) => ArrayLike<unknown>; querySelector: (s: string) => unknown };

  function render(config: Record<string, unknown>) {
    const el = doc.createElement("div");
    doc.body.appendChild(el);
    const unmounts: Array<() => void> = [];
    mod().renderInstance(el, { fortigateScope: "custom", fortigates: ["RIVERBEND-FG"], ...config }, GATE, { onUnmount: (fn) => unmounts.push(fn) });
    return { el: el as unknown as El, unmount: () => unmounts.forEach((fn) => fn()) };
  }
  const chips = (el: El) =>
    (Array.from(el.querySelectorAll(".devmap-topo-views .topology-floor-chip")) as { textContent: string; classList: { contains: (c: string) => boolean } }[])
      .map((c) => (c.classList.contains("is-active") ? "*" : "") + c.textContent);
  const clickChip = (el: El, label: string) =>
    (Array.from(el.querySelectorAll(".devmap-topo-views .topology-floor-chip")) as { textContent: string; click: () => void }[])
      .find((c) => c.textContent === label)!.click();

  it("unlocked: Base and every location, the whole site drawn, chips drill in", async () => {
    floorViews = VIEWS;
    const { el, unmount } = render({});
    await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
    expect(chips(el)).toEqual(["*Base", "Mine", "Mine — B1", "Yard", "Yard — Scale"]);
    expect(partitioned).toEqual([]); // the whole site is not partitioned
    clickChip(el, "Yard");
    expect(partitioned).toEqual(["a|yard"]);
    expect(chips(el)).toContain("*Yard");
    unmount();
  });

  it("locked: no Base, only the locked locations and what is inside them, opening on the first", async () => {
    floorViews = VIEWS;
    const { el, unmount } = render({ topologyLock: ["a|mine"] });
    await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
    expect(chips(el)).toEqual(["*Mine", "Mine — B1"]);
    expect(partitioned).toEqual(["a|mine"]);
    // No rotation with one locked location.
    expect((el.querySelector(".devmap-topo-rotate") as { hidden: boolean }).hidden).toBe(true);
    unmount();
  });

  it("a lock naming locations the site no longer has falls back to the whole site", async () => {
    floorViews = VIEWS;
    const { el, unmount } = render({ topologyLock: ["a|gone"] });
    await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
    expect(chips(el)[0]).toBe("*Base");
    expect(partitioned).toEqual([]);
    unmount();
  });

  it("rotates through the locked locations, and ⏸ (or picking a chip) pauses it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      floorViews = VIEWS;
      const { el, unmount } = render({ topologyLock: ["a|mine", "a|yard"], topologyRotateSec: 15 });
      await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
      const btn = el.querySelector(".devmap-topo-rotate") as { hidden: boolean; textContent: string; click: () => void };
      expect(btn.hidden).toBe(false);
      expect(btn.textContent).toBe("⏸");
      vi.advanceTimersByTime(15_000);
      expect(partitioned.at(-1)).toBe("a|yard");
      vi.advanceTimersByTime(15_000);
      expect(partitioned.at(-1)).toBe("a|mine"); // wraps round

      btn.click();
      expect(btn.textContent).toBe("▶");
      const n = partitioned.length;
      vi.advanceTimersByTime(60_000);
      expect(partitioned).toHaveLength(n);

      btn.click(); // resume
      vi.advanceTimersByTime(15_000);
      expect(partitioned.at(-1)).toBe("a|yard");

      clickChip(el, "Mine — B1"); // a viewer's pick pauses it
      expect(btn.textContent).toBe("▶");
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the gear lists the gate's locations with the lock ticked, and writes ticks and the period", async () => {
    floorViews = VIEWS;
    const el = doc.createElement("div");
    doc.body.appendChild(el);
    const changes: Array<[string, unknown]> = [];
    mod().renderConfig(el, { fortigateScope: "custom", fortigates: ["RIVERBEND-FG"], topologyLock: ["a|mine"] }, (k, v) => changes.push([k, v]));
    await vi.waitFor(() => expect(el.querySelectorAll("[data-loc]").length).toBe(4), { timeout: 2000 });
    const boxes = Array.from(el.querySelectorAll("[data-loc]")) as unknown as { checked: boolean; getAttribute: (a: string) => string; dispatchEvent: (e: unknown) => void }[];
    expect(boxes.filter((b) => b.checked).map((b) => b.getAttribute("data-loc"))).toEqual(["a|mine"]);
    const sel = el.querySelector('[data-k="topologyRotateSec"]') as unknown as { disabled: boolean; value: string; dispatchEvent: (e: unknown) => void };
    expect(sel.disabled).toBe(true); // one location: nothing to rotate through
    boxes[2].checked = true;
    boxes[2].dispatchEvent(new win.Event("change"));
    expect(changes.at(-1)).toEqual(["topologyLock", ["a|mine", "a|yard"]]);
    expect(sel.disabled).toBe(false);
    sel.value = "30";
    sel.dispatchEvent(new win.Event("change"));
    expect(changes.at(-1)).toEqual(["topologyRotateSec", 30]);
    el.remove();
  });

  it("the gear asks for one gate before it can lock", () => {
    const el = doc.createElement("div");
    mod().renderConfig(el, { regionScope: "all" }, () => {});
    expect(el.querySelector(".devmap-cfg-locations")!.textContent).toContain("Tick exactly one FortiGate");
  });
});
