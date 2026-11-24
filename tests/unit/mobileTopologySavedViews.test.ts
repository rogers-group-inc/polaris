/**
 * tests/unit/mobileTopologySavedViews.test.ts — the phone topology's saved
 * views, legend and eye (public/js/mobile/topology-tab.js).
 *
 * Pinned here:
 *   • THE VIEWS: a site's saved views are offered in a select under the bar
 *     (Layer 2, then Topology, then Room, grouped), hidden for a single view;
 *     the default view opens first.
 *   • A TOPOLOGY or ROOM view mounts the Device Map page's own canvas
 *     (PolarisTopologyPhysical / PolarisTopologyRoom) READ-ONLY — editing and
 *     canEdit off, nothing staged — with placements read under the view's
 *     own layout keys; a tap on a device opens the node sheet.
 *   • THE LEGEND button opens the desktop's key (less "Endpoint"), with the
 *     Topology canvas's ArcGIS section after it; a Room view has no legend.
 *   • THE EYE: on a Topology view it is the canvas's own "Show on the map"
 *     button; on a Layer 2 view it opens the Device types icons, whose taps
 *     redraw the graph with that type hidden or shown for this visit only.
 *   • map.css (the canvases' stylesheet, which also restyles the Map tab) is
 *     on only while the topology screen shows.
 *
 * Cytoscape, the renderer and the two canvases are fakes recording what the
 * screen asked of them.
 *
 * @vitest-environment happy-dom
 * @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf-8");
const TAB = read("public", "js", "mobile", "topology-tab.js");
const g = globalThis as any;

/** What the fakes saw. */
let built: Array<Record<string, unknown> | undefined> = [];
let cyCount = 0;
let mounted: Array<{ kind: string; ctx: any }> = [];
let eyeClicks = 0;
let sheetsOpened = 0;

function fakeCy() {
  cyCount++;
  const handlers: Record<string, () => void> = {};
  const coll = { forEach: () => {}, panify: () => coll, length: 0 };
  return {
    one: (ev: string, fn: () => void) => { handlers[ev] = fn; },
    on: () => {},
    nodes: () => coll,
    getElementById: () => coll,
    fit: () => {},
    resize: () => {},
    destroy: () => {},
    layout: () => ({ run: () => handlers.layoutstop && handlers.layoutstop() }),
  };
}

function fakeCanvas(kind: string, buttons: () => any[]) {
  return {
    render: (host: HTMLElement, ctx: any) => {
      mounted.push({ kind, ctx });
      host.innerHTML = '<div class="fake-' + kind + '"></div>';
      return { cornerButtons: buttons, destroy: () => {}, viewState: () => null };
    },
  };
}

const VIEWS = [
  { id: "v-room", name: "Server room", mode: "room" },
  { id: "v-topo", name: "Campus", mode: "topology", shownTypes: ["firewall", "switch"] },
  { id: "v-l2", name: "Default", mode: "layer2", isDefault: true },
  { id: "v-l2b", name: "Just switches", mode: "layer2", shownTypes: ["firewall", "switch"] },
];
const DATA = {
  fortigate: { id: "fg", hostname: "FG-1" },
  switches: [{ id: "sw1" }],
  views: VIEWS,
  savedLayouts: {
    flat: { positions: { fg: { x: 1, y: 1 } } },
    "v:v-l2b": { positions: { fg: { x: 9, y: 9 } } },
    "v:v-topo|topo": { positions: { sw1: { x: 0.5, y: 0.5 } } },
    "v:v-topo|topo|L1": { positions: { sw1: { x: 0.1, y: 0.2 } } },
  },
};

function seatScripts() {
  for (const src of [
    "/js/vendor/leaflet/leaflet.js", "/js/vendor/leaflet/leaflet.markercluster.js",
    "/js/topology-device-list.js", "/js/cable-run-geometry.js", "/js/topology-arcgis-layers.js",
    "/js/topology-physical.js", "/js/topology-rack.js", "/js/topology-wall.js", "/js/topology-room.js",
  ]) {
    if (document.querySelector('script[src="' + src + '"]')) continue;
    const s = document.createElement("script");
    s.setAttribute("src", src);
    document.head.appendChild(s);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

async function openScreen() {
  const body = document.getElementById("app-body") as HTMLElement;
  window.location.hash = "#topology/fg";
  g.PolarisTopologyTab.spec.render(body, { route: { parts: ["fg"] } });
  await settle();
  return body;
}
const $ = (id: string) => document.getElementById(id) as any;
async function pick(id: string) {
  const sel = $("topo-viewsel");
  sel.value = id;
  sel.dispatchEvent(new Event("change"));
  await settle();
}

beforeAll(() => {
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.cytoscape = () => fakeCy();
  g.cytoscapeDagre = () => {};
  g._cytoscapeDagreRegistered = true;
  g.PolarisTopologyEdgeEditor = { attach: () => ({}) };
  g.PolarisTabs = { attachSwipeToDismiss: () => {}, showSnackbar: () => {} };
  g.PolarisRouter = { go: () => {} };
  g.PolarisAssetDetail = { open: () => {}, linkHtml: (_id: string, n: string) => n };
  g.ResizeObserver = class { observe() {} disconnect() {} };
  g.api = {
    map: {
      topology: () => Promise.resolve(JSON.parse(JSON.stringify(DATA))),
      topologyBackgroundUrl: (s: string, i: string) => `/bg/${s}/${i}`,
      arcgisLayers: () => Promise.resolve([]),
      arcgisFeatures: () => Promise.resolve({}),
      cableRunLinks: () => Promise.resolve([]),
    },
  };
  g.PolarisTopologyRender = {
    buildTopologyElements: (_d: unknown, opts?: Record<string, unknown>) => {
      built.push(opts);
      return [
        { data: { id: "fg", role: "fortigate", label: "FG-1" } },
        { data: { id: "sw1", role: "fortiswitch", label: "SW-1", assetId: "asset-sw1" } },
        { data: { id: "e1", source: "fg", target: "sw1" } },
      ];
    },
    computeFloorViews: () => [],
    viewSwitcherRows: () => [],
    partitionElementsForFloor: (els: unknown[]) => els,
    computeGroupedLayout: () => null,
    computeTopologyColumns: () => null,
    layoutAspect: () => 1,
    topologyStylesheet: () => [],
    applySavedPositions: () => ({ pinned: {} }),
    renderLocationGroups: () => {},
    routeInterGroupEdges: () => {},
    viewSuppressKinds: () => null,
    markFanOutEdges: () => {},
    wireBentEdgeLabels: () => {},
    topologyLegendSpec: () => ({ nodes: [{ label: "Firewall" }, { label: "Endpoint" }] }),
    topologyLegendHtml: (spec: { nodes: { label: string }[] }) =>
      '<p class="legend-nodes">' + spec.nodes.map((n) => n.label).join("|") + "</p>",
    siteDeviceTypes: () => [{ type: "firewall", count: 1 }, { type: "switch", count: 1 }, { type: "server", count: 4 }],
    typeIconSvg: (t: string) => '<svg data-icon="' + t + '"></svg>',
  };
  g.PolarisTopologyPhysical = fakeCanvas("topology", () => [
    { id: "topology-background", label: "Background", icon: "", onClick: () => {}, editOnly: true },
    { id: "topology-visibility", label: "Show on the map", icon: "", onClick: () => { eyeClicks++; } },
  ]);
  g.PolarisTopologyRoom = fakeCanvas("room", () => [
    { id: "topology-wall-zoom-in", label: "Zoom in", icon: "<circle/>", onClick: () => {} },
  ]);
  new Function(TAB)();
  // The node sheet is the screen's own; count it by its id.
  const orig = document.body.appendChild.bind(document.body);
  document.body.appendChild = ((n: any) => { if (n && n.id === "topo-sheet") sheetsOpened++; return orig(n); }) as any;
});

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div><div id="app-body"></div>';
  document.head.querySelectorAll('link[href="/css/map.css"]').forEach((l) => l.remove());
  seatScripts();
  try { localStorage.clear(); } catch { /* none */ }
  built = [];
  cyCount = 0;
  mounted = [];
  eyeClicks = 0;
  sheetsOpened = 0;
});

describe("pure helpers", () => {
  it("orders views Layer 2, Topology, Room, keeping the site's order within a mode", () => {
    expect(g.PolarisTopologyTab.sortedViews(VIEWS).map((v: any) => v.id)).toEqual(["v-l2", "v-l2b", "v-topo", "v-room"]);
  });
  it("scopes a layout key to a non-default view", () => {
    const k = g.PolarisTopologyTab.scopedLayoutKey;
    expect(k({ id: "a", isDefault: true }, "flat")).toBe("flat");
    expect(k({ id: "a" }, "flat")).toBe("v:a");
    expect(k({ id: "a" }, "b||x")).toBe("v:a|b||x");
    expect(k(null, "flat")).toBe("flat");
  });
  it("reads a visit's toggles, else the view's types, else the desktop default", () => {
    const e = g.PolarisTopologyTab.effectiveShownTypes;
    expect(e({ id: "a" }, {})).toEqual(["firewall", "router", "switch", "access_point"]);
    expect(e({ id: "a", shownTypes: ["switch"] }, {})).toEqual(["switch"]);
    expect(e({ id: "a", shownTypes: ["switch"] }, { a: ["server"] })).toEqual(["server"]);
  });
  it("toggles a type but never the FortiGate", () => {
    const n = g.PolarisTopologyTab.nextShownTypes;
    expect(n(["firewall", "switch"], "switch")).toEqual(["firewall"]);
    expect(n(["firewall"], "server")).toEqual(["firewall", "server"]);
    expect(n(["firewall"], "firewall")).toEqual(["firewall"]);
  });
});

describe("saved views on the phone", () => {
  it("offers every view grouped by mode, opens on the default, and draws its device types", async () => {
    await openScreen();
    expect($("topo-viewbar").hidden).toBe(false);
    const groups = Array.from(document.querySelectorAll("#topo-viewsel optgroup")).map((o: any) => o.label);
    expect(groups).toEqual(["Layer 2", "Topology", "Room"]);
    expect($("topo-viewsel").value).toBe("v-l2");
    expect(cyCount).toBe(1);
    expect(built.at(-1)).toEqual({ shownTypes: ["firewall", "router", "switch", "access_point"] });
    expect(mounted).toHaveLength(0);
  });

  it("switches map.css on with the screen and off when the screen is left", async () => {
    await openScreen();
    const link = document.querySelector('link[href="/css/map.css"]') as HTMLLinkElement;
    expect(link).not.toBeNull();
    expect(link.disabled).toBe(false);
    window.location.hash = "#map";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(link.disabled).toBe(true);
  });

  it("mounts a Topology view's canvas read-only, under the view's own layout keys", async () => {
    await openScreen();
    await pick("v-topo");
    expect(mounted.map((m) => m.kind)).toEqual(["topology"]);
    const ctx = mounted[0].ctx;
    expect(ctx.editing).toBe(false);
    expect(ctx.canEdit).toBe(false);
    expect(ctx.stagePlacements()).toBe(false);
    expect(ctx.stageViewPatch()).toBe(false);
    expect(ctx.shownTypes).toEqual(["firewall", "switch"]);
    expect(ctx.loadPlacements(0)).toEqual({ sw1: { x: 0.5, y: 0.5 } });
    expect(ctx.loadPlacements(1)).toEqual({ sw1: { x: 0.1, y: 0.2 } });
    expect(ctx.backgroundUrl("img")).toBe("/bg/fg/img");
    expect(document.querySelector("#topo-graph .fake-topology")).not.toBeNull();
    // Search is Layer 2's.
    expect($("topo-search-input").disabled).toBe(true);
  });

  it("opens the node sheet for a device tapped on a canvas", async () => {
    await openScreen();
    await pick("v-topo");
    mounted[0].ctx.selectAsset("sw1");
    expect(sheetsOpened).toBe(1);
    expect(document.getElementById("topo-sheet")).not.toBeNull();
  });

  it("mounts a Room view with no legend, its own zoom button in the tools", async () => {
    await openScreen();
    await pick("v-room");
    expect(mounted.map((m) => m.kind)).toEqual(["room"]);
    expect($("topo-legend-btn").hidden).toBe(true);
    expect($("topo-eye-btn").hidden).toBe(true);
    const extra = Array.from(document.querySelectorAll("#topo-mode-tools .topo-tool")).map((b: any) => b.getAttribute("aria-label"));
    expect(extra).toEqual(["Zoom in"]);
  });

  it("goes back to the graph from a canvas", async () => {
    await openScreen();
    await pick("v-topo");
    await pick("v-l2b");
    expect(document.querySelector(".fake-topology")).toBeNull();
    expect(cyCount).toBe(2);
    expect(built.at(-1)).toEqual({ shownTypes: ["firewall", "switch"] });
  });
});

describe("legend and eye", () => {
  it("opens the desktop's key without Endpoint, and remembers it open", async () => {
    await openScreen();
    expect($("topo-legend-btn").hidden).toBe(false);
    expect($("topo-legend").hidden).toBe(true);
    $("topo-legend-btn").click();
    expect($("topo-legend").hidden).toBe(false);
    expect($("topo-legend-body").textContent).toBe("Firewall");
    expect(localStorage.getItem("polaris.mobile.topologyLegend")).toBe("1");
    $("topo-legend-close").click();
    expect($("topo-legend").hidden).toBe(true);
    expect(localStorage.getItem("polaris.mobile.topologyLegend")).toBe("0");
  });

  it("adds the Topology canvas's ArcGIS section to the legend", async () => {
    await openScreen();
    await pick("v-topo");
    mounted[0].ctx.setArcgisLegend('<p class="arc">Fiber</p>');
    $("topo-legend-btn").click();
    expect($("topo-legend-body").querySelector(".topology-legend-arcgis .arc")).not.toBeNull();
  });

  it("is the canvas's own Show-on-the-map button on a Topology view", async () => {
    await openScreen();
    await pick("v-topo");
    expect($("topo-eye-btn").hidden).toBe(false);
    $("topo-eye-btn").click();
    expect(eyeClicks).toBe(1);
    // The edit-only Background button is not offered.
    expect(document.querySelectorAll("#topo-mode-tools .topo-tool")).toHaveLength(0);
  });

  it("opens a Layer 2 view's device types, and a tap hides that type for this visit", async () => {
    await openScreen();
    $("topo-eye-btn").click();
    const panel = document.querySelector(".topo-types-panel") as HTMLElement;
    expect(panel).not.toBeNull();
    const icons = Array.from(panel.querySelectorAll("button[data-topo-type]")) as HTMLButtonElement[];
    expect(icons.map((b) => b.getAttribute("data-topo-type"))).toEqual(["firewall", "switch", "server"]);
    expect(icons[0].disabled).toBe(true);
    expect(icons[1].classList.contains("is-on")).toBe(true);
    expect(icons[2].classList.contains("is-on")).toBe(false);
    icons[1].click();
    expect(built.at(-1)).toEqual({ shownTypes: ["firewall", "router", "access_point"] });
    const again = document.querySelector('.topo-types-panel button[data-topo-type="switch"]') as HTMLElement;
    expect(again.classList.contains("is-on")).toBe(false);
    // Not saved anywhere: a fresh visit draws the view's own types again.
    await openScreen();
    expect(built.at(-1)).toEqual({ shownTypes: ["firewall", "router", "switch", "access_point"] });
  });
});
