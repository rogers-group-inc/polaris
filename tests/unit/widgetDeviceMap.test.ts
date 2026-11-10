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

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
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
let floorViews: Array<Record<string, unknown>> = [];
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
      // A device from another site: an access point, by its own asset type.
      { data: { id: "rm-ap", role: "remote-asset", assetType: "access_point" } },
      { data: { id: "e1", source: "fg-river", target: "sw-1" } },
      { data: { id: "e2", source: "sw-1", target: "ap-1" } },
      { data: { id: "e3", source: "sw-1", target: "rm-ap" } },
    ],
    topologyLegendSpec: () => ({
      nodes: [{ label: "Firewall" }, { label: "Switch" }, { label: "Access Point" }, { label: "Endpoint" }, { label: "Remote asset" }],
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
    // The shared saved-layout overlay (pins saved devices); nothing to pin here.
    applySavedPositions: () => ({ pinned: {}, restored: [], placed: [] }),
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

  it("offers Asset types, all ticked by default, stores the UNticked ones, and reads the old vendor list", () => {
    const el = doc.createElement("div");
    const changes: Array<[string, unknown]> = [];
    mod().renderConfig(el, { regionScope: "all" }, (k, v) => changes.push([k, v]));
    const boxes = Array.from(el.querySelectorAll("[data-topo-type]")) as unknown as { checked: boolean; getAttribute: (a: string) => string; dispatchEvent: (e: unknown) => void }[];
    expect(boxes.map((b) => b.getAttribute("data-topo-type"))).toEqual(["firewall", "switch", "access_point"]);
    expect(boxes.every((b) => b.checked)).toBe(true);
    boxes[2].checked = false;
    boxes[2].dispatchEvent(new win.Event("change"));
    expect(changes.at(-1)).toEqual(["topologyHideTypes", ["access_point"]]);

    // A widget saved before asset types: its unticked FortiAPs read as Access Points.
    const el2 = doc.createElement("div");
    mod().renderConfig(el2, { regionScope: "all", topologyHide: ["fortiap", "remote-asset"] }, () => {});
    const ap = el2.querySelector('[data-topo-type="access_point"]') as unknown as { checked: boolean };
    expect(ap.checked).toBe(false);
  });

  it("has no Locations or Rotate in the gear — they live on the topology", () => {
    const el = doc.createElement("div");
    mod().renderConfig(el, { fortigateScope: "custom", fortigates: ["RIVERBEND-FG"] }, () => {});
    expect(el.querySelector("[data-loc]")).toBeNull();
    expect(el.querySelector('[data-k="topologyRotateSec"]')).toBeNull();
    expect(el.textContent).not.toContain("Locations");
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

  it("lends its read-only topology pane to the Status Map (the /dash dot popup's link)", () => {
    const api = (win as unknown as Record<string, { open: (el: unknown, gate: unknown, opts: unknown) => { close: () => void } }>).PolarisDeviceMapTopology;
    expect(typeof api.open).toBe("function");
    const host = doc.createElement("div");
    doc.body.appendChild(host);
    let backs = 0;
    const pane = api.open(host, { id: "fg-river", name: "RIVERBEND-FG" }, { hidden: {}, onBack: () => { backs++; } });
    const back = Array.from(host.querySelectorAll(".devmap-topo-bar button")).find((b) => b.textContent === "← Map") as unknown as { click: () => void };
    expect(back).toBeTruthy();
    back.click();
    expect(backs).toBe(1);
    pane.close();
    host.remove();
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
    expect(legend.querySelector(".legend-nodes")!.textContent).toBe("Firewall|Switch|Access Point|Remote asset");
    unmount();
  });

  it("an unticked asset type is not drawn — at this site or another — nor its links, nor its legend row", async () => {
    const el = doc.createElement("div");
    doc.body.appendChild(el);
    const unmounts: Array<() => void> = [];
    mod().renderInstance(el, { fortigateScope: "custom", fortigates: ["RIVERBEND-FG"], topologyHideTypes: ["access_point"] },
      { gate: { id: "fg-river", name: "RIVERBEND-FG" } }, { onUnmount: (fn) => unmounts.push(fn) });
    await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
    const ids = (cyOptions[0].elements as { data: { id: string } }[]).map((e) => e.data.id);
    // The FortiAP AND the other site's access point go, with both their links.
    expect(ids).toEqual(["fg-river", "sw-1", "e1"]);
    // "Remote asset" stays: another site's firewall or switch still draws.
    expect(el.querySelector(".legend-nodes")!.textContent).toBe("Firewall|Switch|Remote asset");
    unmounts.forEach((fn) => fn());
  });

  it("says so when the picked gate has left the fleet", () => {
    const { el, unmount } = renderSolo({ gate: { id: null, name: "RIVERBEND-FG" } });
    expect(el.textContent).toContain("no longer in the fleet");
    expect(topology).not.toHaveBeenCalled();
    unmount();
  });
});

describe("Device Map widget — location chips, pins and rotation", () => {
  const VIEWS = [
    // computeFloorViews' shape: ancestors drive nesting, name is the chip text.
    { key: "a|mine", kind: "area", depth: 0, ancestors: [], name: "Mine", areaKey: "mine", buildingKey: "", label: "Mine" },
    { key: "b|mine|b1", kind: "building", depth: 1, ancestors: ["a|mine"], name: "B1", areaKey: "mine", buildingKey: "b1", label: "Mine — B1" },
    { key: "a|yard", kind: "area", depth: 0, ancestors: [], name: "Yard", areaKey: "yard", buildingKey: "", label: "Yard" },
    { key: "b|yard|scale", kind: "building", depth: 1, ancestors: ["a|yard"], name: "Scale", areaKey: "yard", buildingKey: "scale", label: "Yard — Scale" },
  ];
  const GATE = { gate: { id: "fg-river", name: "RIVERBEND-FG" } };
  type El = { querySelectorAll: (s: string) => ArrayLike<unknown>; querySelector: (s: string) => unknown };
  const w = () => win as unknown as Record<string, unknown>;

  /**
   * The widget in a dashboard article, as dashboard.js mounts it. A fresh id
   * each time: the widget remembers each id's last view (so a pin change's
   * re-render keeps the viewer's place), which would carry between cases.
   */
  let seq = 0;
  let wid = "";
  function render(config: Record<string, unknown>) {
    const article = doc.createElement("article");
    article.className = "dashboard-widget";
    wid = "w" + ++seq;
    article.setAttribute("data-id", wid);
    const el = doc.createElement("div");
    article.appendChild(el);
    doc.body.appendChild(article);
    const unmounts: Array<() => void> = [];
    mod().renderInstance(el, { fortigateScope: "custom", fortigates: ["RIVERBEND-FG"], ...config }, GATE, { onUnmount: (fn) => unmounts.push(fn) });
    return { el: el as unknown as El, unmount: () => { unmounts.forEach((fn) => fn()); article.remove(); } };
  }
  const chipEls = (el: El) =>
    Array.from(el.querySelectorAll(".devmap-topo-views .topology-floor-chip")) as { textContent: string; classList: { contains: (c: string) => boolean }; click: () => void; querySelector: (s: string) => { click: () => void } | null }[];
  const chips = (el: El) =>
    chipEls(el).map((c) => (c.classList.contains("is-active") ? "*" : "") + c.textContent + (c.querySelector("button.devmap-chip-pin") ? "[pin]" : c.querySelector(".devmap-chip-pin-mark") ? "[mark]" : ""));
  const chip = (el: El, label: string) => chipEls(el).find((c) => c.textContent === label)!;
  const rotateBtn = (el: El) => el.querySelector(".devmap-topo-rotate") as { hidden: boolean; classList: { contains: (c: string) => boolean }; click: () => void };

  let stored: Array<[string, string, unknown]> = [];
  let editing = false;
  beforeEach(() => {
    stored = [];
    editing = false;
    w().PolarisDashboard = {
      isEditing: () => editing,
      setWidgetConfig: (id: string, key: string, value: unknown) => { stored.push([id, key, value]); return true; },
    };
  });
  afterEach(() => {
    delete w().PolarisDashboard;
    delete w().POLARIS_DASH_LOCAL;
  });

  it("signed in: Base and every location, each location chip with a pin toggle; a chip drills in", async () => {
    floorViews = VIEWS;
    const { el, unmount } = render({});
    await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
    expect(chips(el)).toEqual(["*Base", "Mine[pin]", "Mine — B1[pin]", "Yard[pin]", "Yard — Scale[pin]"]);
    expect(partitioned).toEqual([]); // the whole site is not partitioned
    chip(el, "Yard").click();
    expect(partitioned).toEqual(["a|yard"]);
    // No pins, nothing to rotate through.
    expect(rotateBtn(el).hidden).toBe(true);
    unmount();
  });

  it("a pin toggle stores the widget's pins; unpinning takes it out", async () => {
    floorViews = VIEWS;
    const { el, unmount } = render({ topologyLock: ["a|mine"] });
    await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
    chip(el, "Yard").querySelector("button.devmap-chip-pin")!.click();
    expect(stored.at(-1)).toEqual([wid, "topologyLock", ["a|mine", "a|yard"]]);
    chip(el, "Mine").querySelector("button.devmap-chip-pin")!.click();
    expect(stored.at(-1)).toEqual([wid, "topologyLock", []]);
    // The pin click is not a chip click.
    expect(partitioned).toEqual([]);
    unmount();
  });

  it("customizing: no pin toggles — a pinned chip wears a mark", async () => {
    editing = true;
    floorViews = VIEWS;
    const { el, unmount } = render({ topologyLock: ["a|mine"] });
    await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
    expect(chips(el)).toEqual(["*Base", "Mine[mark]", "Mine — B1", "Yard", "Yard — Scale"]);
    unmount();
  });

  it("the wallboard: only the pinned locations and what is inside them, no Base, no pin toggles", async () => {
    w().POLARIS_DASH_LOCAL = true;
    floorViews = VIEWS;
    const { el, unmount } = render({ topologyLock: ["a|mine"] });
    await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
    expect(chips(el)).toEqual(["*Mine", "Mine — B1"]);
    expect(partitioned).toEqual(["a|mine"]);
    unmount();
  });

  it("the wallboard with pins the site no longer has shows the whole site", async () => {
    w().POLARIS_DASH_LOCAL = true;
    floorViews = VIEWS;
    const { el, unmount } = render({ topologyLock: ["a|gone"] });
    await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
    expect(chips(el)[0]).toBe("*Base");
    expect(partitioned).toEqual([]);
    unmount();
  });

  it("the chips get their own band: the graph starts below them, and fills the pane without them", async () => {
    const graphTop = (el: El) => (el.querySelector(".devmap-topo-graph") as { style: { top: string } }).style.top;
    floorViews = VIEWS;
    const withChips = render({});
    await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
    expect(graphTop(withChips.el)).toMatch(/^\d+px$/);
    withChips.unmount();

    floorViews = [];
    const without = render({});
    await vi.waitFor(() => expect(cyOptions).toHaveLength(2), { timeout: 2000 });
    expect(graphTop(without.el)).toBe("");
    without.unmount();
  });

  it("Rotate steps through the pins; picking a chip turns it off; the button turns it back on and stores it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      floorViews = VIEWS;
      const { el, unmount } = render({ topologyLock: ["a|mine", "a|yard"], topologyRotate: true });
      await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
      const btn = rotateBtn(el);
      expect(btn.hidden).toBe(false);
      expect(btn.classList.contains("active")).toBe(true);
      vi.advanceTimersByTime(30_000);
      expect(partitioned.at(-1)).toBe("a|mine");
      vi.advanceTimersByTime(30_000);
      expect(partitioned.at(-1)).toBe("a|yard");
      vi.advanceTimersByTime(30_000);
      expect(partitioned.at(-1)).toBe("a|mine"); // wraps round

      chip(el, "Mine — B1").click(); // a viewer's pick turns it off — not stored
      expect(btn.classList.contains("active")).toBe(false);
      expect(stored.filter((s) => s[1] === "topologyRotate")).toEqual([]);
      const n = partitioned.length;
      vi.advanceTimersByTime(90_000);
      expect(partitioned).toHaveLength(n);

      btn.click();
      expect(btn.classList.contains("active")).toBe(true);
      expect(stored.at(-1)).toEqual([wid, "topologyRotate", true]);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the wallboard's rotation toggle is the viewer's own: it changes the screen, never the widget", async () => {
    w().POLARIS_DASH_LOCAL = true;
    floorViews = VIEWS;
    const { el, unmount } = render({ topologyLock: ["a|mine", "a|yard"] });
    await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
    const btn = rotateBtn(el);
    expect(btn.classList.contains("active")).toBe(false);
    btn.click();
    expect(btn.classList.contains("active")).toBe(true);
    expect(stored).toEqual([]);
    chip(el, "Yard").click();
    expect(btn.classList.contains("active")).toBe(false);
    unmount();
  });

  it("the chips are one strip with a divider where the page breaks a row, and the wheel scrolls it sideways", async () => {
    floorViews = VIEWS;
    const { el, unmount } = render({});
    await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
    // The fake switcher answers two rows (Base, then every location): one
    // strip, the page's row break a divider.
    const strip = el.querySelector(".devmap-topo-views") as HTMLElement & { dispatchEvent: (e: unknown) => boolean };
    expect(strip.querySelectorAll(".topology-floor-row")).toHaveLength(0);
    const order = Array.from(strip.children).map((c) => (c.classList.contains("devmap-chip-sep") ? "|" : c.textContent));
    expect(order).toEqual(["Base", "|", "Mine", "Mine — B1", "Yard", "Yard — Scale"]);

    // happy-dom lays nothing out: give the strip a window narrower than its row.
    Object.defineProperty(strip, "scrollWidth", { value: 600, configurable: true });
    Object.defineProperty(strip, "clientWidth", { value: 200, configurable: true });
    const wheel = (deltaY: number, deltaX = 0) => {
      const e = new win.WheelEvent("wheel", { deltaY, deltaX, cancelable: true, bubbles: true });
      strip.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(wheel(100)).toBe(true);        // a vertical notch scrolls sideways
    expect(strip.scrollLeft).toBe(100);
    expect(wheel(-30)).toBe(true);
    expect(strip.scrollLeft).toBe(70);
    expect(wheel(5, 1000)).toBe(true);    // the larger delta wins, clamped to the end
    expect(strip.scrollLeft).toBe(400);
    expect(strip.classList.contains("is-overflow-l")).toBe(true);
    expect(strip.classList.contains("is-overflow-r")).toBe(false);

    // A strip that fits leaves the wheel to the page.
    Object.defineProperty(strip, "scrollWidth", { value: 200, configurable: true });
    expect(wheel(100)).toBe(false);
    unmount();
  });

  it("an older widget whose gear set a rotation period opens rotating", async () => {
    floorViews = VIEWS;
    const { el, unmount } = render({ topologyLock: ["a|mine", "a|yard"], topologyRotateSec: 15 });
    await vi.waitFor(() => expect(cyOptions).toHaveLength(1), { timeout: 2000 });
    expect(rotateBtn(el).classList.contains("active")).toBe(true);
    unmount();
  });
});
