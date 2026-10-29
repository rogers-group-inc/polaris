/**
 * tests/unit/assetInterfacesTableDom.test.ts — the asset-details Interfaces
 * table (public/js/assets.js): per-column sort + filter over a nested tree.
 *
 * assets.js is a ~17k-line browser script with no module boundary, so the three
 * functions under test are sliced out by name and eval'd into a happy-dom Window
 * with the app-shell globals stubbed — the eval-with-stubs approach of
 * tests/unit/tableColumnOrder.test.ts, narrowed to the functions that matter.
 *
 * What's pinned here is what silently rots now that the table re-renders itself:
 *  - a sort or filter rewrites the tbody, so every row handler must be delegated
 *    and the pin sets must be mutated in place (a rebound local leaves a
 *    re-render drawing stale checkboxes);
 *  - select-all must not un-pin an interface a filter is hiding — that would
 *    silently stop its fast-cadence polling and drop it to 24h retention;
 *  - the collapse tree has to survive the System tab's refresh-tick rebuild,
 *    which is why collapsed state is baked into the row markup rather than
 *    applied to the DOM afterwards.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, any>;

const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);
const tableSfSrc = readFileSync(resolve(__dirname, "../../public/js/table-sf.js"), "utf8");

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

const FN_NAMES = [
  "_assetTableTypeKey",
  "_getCollapsedIfaces",
  "_setCollapsedIfaces",
  "_lldpNeighborInlineCell",
  "_treeElbow",
  "_distinctSorted",
  "_ifaceMonToggleHTML",
  "_ifaceMonIsOn",
  "_ifaceMonSet",
  "_distinctVlanOptions",
  "_vlanPillHTML",
  "_vlanOptionLabel",
  "_sizeAssetIfaceTableWrapper",
  "_renderInterfacesTable",
  "_ipsecTabPointerHTML",
  "_wireIpsecTabPointer",
  "_buildInterfacesTableDOM",
  "_wireInterfacesTable",
  "_ifaceIpForLookup",
  "_openInterfaceOrNetwork",
];

/** A FortiSwitch-ish device: PoE ports, an aggregate + member, VLAN, tunnels. */
function makeSi() {
  return {
    lastSystemInfoAt: new Date().toISOString(),
    monitoredInterfaces: ["port2"],
    monitoredIpsecTunnels: [],
    lldpNeighbors: [
      { localIfName: "port1", systemName: "core-sw", portId: "ge-0/0/1", matchedAsset: { id: "A1" } },
    ],
    interfaces: [
      { ifName: "port1", ifType: "physical", adminStatus: "up", operStatus: "up", speedBps: 1e9,
        ipAddress: "10.0.0.5", macAddress: "aa:bb:cc:00:00:01", inOctets: 900, outOctets: 100,
        inErrors: 0, outErrors: 0, poeStatus: "delivering", poeClass: "class3", nativeVlan: 10 },
      { ifName: "port2", ifType: "physical", adminStatus: "up", operStatus: "down", speedBps: 1e8,
        ipAddress: null, macAddress: null, inOctets: null, outOctets: null,
        poeStatus: "fault", nativeVlan: 20, taggedVlans: ["30", "40"] },
      { ifName: "port3", ifType: "physical", adminStatus: "down", operStatus: "down",
        poeStatus: "searching", nativeVlan: 10, trunksAllVlans: true },
      // 100 / 200 are here to pin NUMERIC option ordering: alphabetically they
      // sort between 10 and 30. taggedVlans as raw numbers covers the coercion.
      { ifName: "lag1", ifType: "aggregate", adminStatus: "up", operStatus: "up", inOctets: 5000, outOctets: 4000,
        nativeVlan: 100, taggedVlans: [200, 30] },
      { ifName: "port9", ifType: "physical", ifParent: "lag1", adminStatus: "up", operStatus: "up", inOctets: 2500 },
      { ifName: "vlan50", ifType: "vlan", vlanId: 50, adminStatus: "up", operStatus: "up", ipAddress: "10.9.9.1" },
    ],
    ipsecTunnels: [
      { tunnelName: "to-hq", status: "up", parentInterface: "port1", incomingBytes: 10, outgoingBytes: 20 },
      { tunnelName: "orphan-tn", status: "down", parentInterface: "wan9" },
    ],
  };
}
const ASSET = { id: "AST1", assetType: "switch", monitoredInterfaces: ["port2"], monitoredIpsecTunnels: [] };
/** localStorage key the sort/filter state persists under (per user + type). */
const PREFS_KEY = "polaris-prefs-asset-interfaces-switch-tester";

let win: Window;
let doc: Window["document"];
let putCalls: Record<string, any>[];
let openedIface: string | null;
/** What the interface-name click's network fork sees: the viewer's networks grant,
 *  what GET /assets/ip-context answers, and the row menus it opened. */
let canReadNetworks: boolean;
let ipContextResult: Record<string, any> | null;
let menuCalls: { anchor: Element; items: { label: string; onSelect: () => void }[]; opts: any }[];

function setup(): void {
  win = new Window();
  doc = win.document;
  putCalls = [];
  openedIface = null;
  canReadNetworks = false;
  ipContextResult = null;
  menuCalls = [];

  g.window = win;
  g.document = doc;
  g.localStorage = (win as any).localStorage;
  g.MutationObserver = (win as any).MutationObserver;
  g.ResizeObserver = (win as any).ResizeObserver;
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  g.getComputedStyle = (el: Element) => (win as any).getComputedStyle(el);
  g.CSS = (win as any).CSS;
  g.currentUsername = "tester";
  g._assetVlanNames = {};
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.showToast = () => {};
  g.canManageAssets = () => true;
  g._staleBannerHTML = () => "";
  g._streamFailureError = () => null;
  g._fmtSpeed = (b: number) => `${b}bps`;
  g._fmtBytes = (b: number) => `${b}B`;
  g._screenshotTableEl = () => {};
  g.openInterfaceDetailPanel = (_a: unknown, n: string) => { openedIface = n; };
  g.openIpsecTunnelDetailPanel = () => {};
  g.openViewModal = () => {};
  g.permAtLeast = (key: string) => key === "subnets" ? canReadNetworks : true;
  g.showRowMenu = (anchor: Element, items: any[], opts: any) => { menuCalls.push({ anchor, items, opts }); };
  // app.js's "is this click a right click?" — set by rightClick() below.
  g.rowMenuGesture = () => gesture;
  g.PolarisPanels = { openNetwork: vi.fn(async () => true) };
  g.api = {
    assets: {
      update: (_id: string, body: Record<string, any>) => { putCalls.push(body); return Promise.resolve({}); },
      ipContext: vi.fn(async () => ipContextResult),
    },
  };

  (0, eval)(tableSfSrc);
  // table-sf.js publishes this on `window`, which IS the global in a browser.
  g.PolarisPrefs = (win as any).PolarisPrefs;
  for (const name of FN_NAMES) (0, eval)(fnSrc(name));
}

/** Render (or re-render, as the System tab's refresh tick does) the table. */
function render(): void {
  doc.body.innerHTML = '<div id="ifaces"></div>';
  g._renderInterfacesTable(doc.getElementById("ifaces"), makeSi(), ASSET);
}

const allRows = () => Array.from(doc.querySelectorAll("#asset-iface-tbody > tr"));
const dataRows = () => allRows().filter((tr) => tr.querySelectorAll(":scope > td").length > 1);
function nameOf(tr: Element): string {
  const a = tr.querySelector(".asset-iface-link, .asset-ipsec-link");
  return a ? a.textContent!.trim() : "(none)";
}
const names = () => dataRows().map(nameOf);
const rowFor = (name: string) => dataRows().find((tr) => nameOf(tr) === name)!;
const sectionLabels = () =>
  allRows().filter((tr) => tr.querySelectorAll(":scope > td").length === 1)
    .map((tr) => tr.textContent!.replace(/\s+/g, " ").trim());

const click = (el: any) => el.dispatchEvent(new (win as any).Event("click", { bubbles: true, cancelable: true }));
/** A right click as app.js replays it: the click, with rowMenuGesture() answering a point. */
let gesture: { x: number | null; y: number | null } | null = null;
const rightClick = (el: any) => {
  gesture = { x: 40, y: 50 };
  try { click(el); } finally { gesture = null; }
};
const change = (el: any) => el.dispatchEvent(new (win as any).Event("change", { bubbles: true }));
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const sortBy = (key: string) => click(doc.querySelector(`th[data-sf-key="${key}"] .sf-header`));
/** TableSF debounces text filters by 200ms. */
async function typeFilter(key: string, value: string): Promise<void> {
  const inp: any = doc.querySelector(`th[data-sf-key="${key}"] input.sf-filter`);
  inp.value = value;
  inp.dispatchEvent(new (win as any).Event("input", { bubbles: true }));
  await settle(260);
}
function checkboxFilter(key: string, value: string, on: boolean): void {
  const cb: any = Array.from(doc.querySelectorAll(`th[data-sf-key="${key}"] input[type="checkbox"]`))
    .find((el: any) => el.value === value);
  cb.checked = on;
  change(cb);
}

beforeEach(() => { setup(); render(); });

describe("default (tree) view", () => {
  it("renders every interface — nothing is hidden for lack of traffic", () => {
    // The "Show N inactive interfaces" expander is gone: port3 (admin-shut, no
    // counters) is an ordinary visible row. The IPsec tunnels are not here at
    // all — they are the IPsec tab's (see the describe at the end).
    expect(names().sort()).toEqual(
      ["lag1", "port1", "port2", "port3", "port9", "vlan50"],
    );
    expect(dataRows().every((tr) => tr.getAttribute("style") !== "display:none")).toBe(true);
  });

  it("keeps the nesting and the section headers", () => {
    const n = names();
    expect(n.indexOf("port9")).toBe(n.indexOf("lag1") + 1);   // member under its aggregate
    expect(sectionLabels()).toHaveLength(2);
    expect(sectionLabels()[0]).toMatch(/Interfaces \(4\)/);   // top-level count, not row count
  });

  it("offers filter options for only the states this device reports", () => {
    const opts = (key: string) =>
      Array.from(doc.querySelectorAll(`th[data-sf-key="${key}"] .sf-multi-option`))
        .map((l) => l.textContent!.trim());
    expect(opts("poe")).toEqual(["Delivering", "Fault", "Searching"]);
    expect(opts("status")).toEqual(["admin shut", "down", "up"]);
  });

  it("offers the reported VLAN ids as pickable options, ordered numerically", () => {
    const opts = (key: string) =>
      Array.from(doc.querySelectorAll(`th[data-sf-key="${key}"] .sf-multi-option`))
        .map((l) => l.textContent!.trim());
    // A VLAN is an id out of a closed set the switch just reported, so both
    // columns filter by picking rather than typing — and 100 sorting after 20
    // is the point of _distinctVlanOptions over _distinctSorted.
    expect(opts("native-vlan")).toEqual(["10", "20", "100"]);
    expect(opts("tagged-vlans")).toEqual(["30", "40", "200", "all (trunk)"]);
  });

  it("shows VLANs as name pills with the number on hover", () => {
    doc.body.innerHTML = '<div id="ifaces"></div>';
    g._renderInterfacesTable(doc.getElementById("ifaces"),
      { ...makeSi(), vlanNames: { "10": "Users_VL10", "30": "Voice_VL30" } }, ASSET);
    const nativePill = rowFor("port1").querySelector(".vlan-pill")!;
    expect(nativePill.textContent).toBe("Users_VL10");
    expect(nativePill.getAttribute("title")).toBe("VLAN 10");
    // An id nothing names still reads as a VLAN, not a bare number.
    const port2Pills = Array.from(rowFor("port2").querySelectorAll(".vlan-pill")).map((p) => p.textContent);
    expect(port2Pills).toEqual(["VLAN 20", "Voice_VL30", "VLAN 40"]);
    // The picker names them too, keeping the id as the value it filters on.
    const opts = Array.from(doc.querySelectorAll('th[data-sf-key="native-vlan"] .sf-multi-option'))
      .map((l) => l.textContent!.trim());
    expect(opts).toEqual(["10 · Users_VL10", "20", "100"]);
    // The slide-over reads the same names.
    expect(g._assetVlanNames.AST1).toEqual({ "10": "Users_VL10", "30": "Voice_VL30" });
  });

  it("freezes the header by height-bounding the wrapper's own scroll", () => {
    const w = doc.getElementById("asset-iface-wrapper")!;
    expect(w.classList.contains("table-wrapper-panel-sticky")).toBe(true);
    expect(parseInt((w as any).style.maxHeight, 10)).toBeGreaterThanOrEqual(300);
  });
});

describe("sorting", () => {
  // A sort reorders clusters, it does not dissolve them: the switch's
  // FortiLink trunk kept its members only in the unsorted view, and a sort by
  // name is the one operators leave on.
  it("keeps the tree — section headers, expand toggle, the member under its aggregate", () => {
    sortBy("ifname");
    expect(sectionLabels()).toHaveLength(2);
    expect(doc.querySelectorAll('.iface-expand-toggle[data-parent="lag1"]')).toHaveLength(1);
    const n = names();
    expect(n.indexOf("port9")).toBe(n.indexOf("lag1") + 1);
    expect(rowFor("port9").textContent).toContain("└─");
  });

  it("orders clusters by the numeric counter, unreported rows last, members riding along", () => {
    sortBy("in");
    expect(names().slice(0, 3)).toEqual(["port1", "lag1", "port9"]);
    sortBy("in");
    expect(names().slice(0, 2)).toEqual(["lag1", "port9"]);   // second click reverses
  });

  it("keeps a collapsed parent collapsed when sorted", () => {
    click(doc.querySelector('.iface-expand-toggle[data-parent="lag1"]'));
    sortBy("ifname");
    expect(rowFor("port9").style.display).toBe("none");
  });

  it("goes flat when filtered, revealing the children of a collapsed parent", async () => {
    click(doc.querySelector('.iface-expand-toggle[data-parent="lag1"]'));
    await typeFilter("ifname", "port");
    expect(sectionLabels()).toEqual([]);
    expect(doc.querySelectorAll(".iface-expand-toggle")).toHaveLength(0);
    // Not indented under anything, so the badge is what identifies a member.
    expect(rowFor("port9").outerHTML).toMatch(/Member/);
    expect(dataRows().every((tr) => tr.getAttribute("style") !== "display:none")).toBe(true);
  });

  // A filter that keeps the aggregate AND its member (a Status filter keeps a
  // switch's FortiLink trunk and the ports in it) still draws the connector.
  it("nests a member under its aggregate when both match the filter", async () => {
    await typeFilter("ifname", "9");   // matches port9 only — its aggregate is out
    expect(rowFor("port9").textContent).not.toContain("└─");
    await typeFilter("ifname", "");
    click(doc.querySelector('.iface-expand-toggle[data-parent="lag1"]'));
    checkboxFilter("status", "up", true);
    await settle();
    const n = names();
    expect(n.indexOf("port9")).toBe(n.indexOf("lag1") + 1);
    expect(rowFor("port9").textContent).toContain("└─");
    expect(rowFor("port9").classList.contains("iface-child")).toBe(true);
    // A match is never hidden by a collapsed parent, and there is no toggle.
    expect(rowFor("port9").getAttribute("style")).not.toBe("display:none");
    expect(doc.querySelectorAll(".iface-expand-toggle")).toHaveLength(0);
  });
});

// IF-MIB carries no parent column, so a FortiAP's br0.10 arrives unparented.
describe("a dotted sub-interface nests under its base", () => {
  function renderSi(interfaces: Record<string, any>[]): void {
    doc.body.innerHTML = '<div id="ifaces"></div>';
    g._renderInterfacesTable(doc.getElementById("ifaces"), {
      lastSystemInfoAt: new Date().toISOString(),
      monitoredInterfaces: [], monitoredIpsecTunnels: [], lldpNeighbors: [], ipsecTunnels: [],
      interfaces,
    }, ASSET);
  }

  it("puts br0.10 / br0.11 under br0 as VLANs, with a toggle on br0", () => {
    renderSi([
      { ifName: "br0",    ifType: "physical", adminStatus: "up", operStatus: "up" },
      { ifName: "br0.11", adminStatus: "up", operStatus: "up" },
      { ifName: "br0.10", ifType: "physical", adminStatus: "up", operStatus: "up" },
      { ifName: "wan0",   ifType: "physical", adminStatus: "up", operStatus: "up" },
    ]);
    expect(names()).toEqual(["br0", "br0.10", "br0.11", "wan0"]);
    expect(rowFor("br0.10").classList.contains("iface-child")).toBe(true);
    expect(rowFor("br0.11").textContent).toContain("└─");
    expect(rowFor("br0.10").textContent).toContain("VLAN 10");
    expect(doc.querySelectorAll('.iface-expand-toggle[data-parent="br0"]')).toHaveLength(1);
  });

  it("puts a FortiAP's w01.12 under wlan01 as a sub-interface", () => {
    renderSi([
      { ifName: "wlan01", ifType: "physical", adminStatus: "up", operStatus: "up" },
      { ifName: "wlan10", ifType: "physical", adminStatus: "up", operStatus: "up" },
      { ifName: "w01.12", ifType: "physical", adminStatus: "up", operStatus: "up" },
      { ifName: "w10.10", ifType: "physical", adminStatus: "up", operStatus: "up" },
      { ifName: "w02.0",  ifType: "physical", adminStatus: "up", operStatus: "up" },
    ]);
    expect(names()).toEqual(["w02.0", "wlan01", "w01.12", "wlan10", "w10.10"]);
    expect(rowFor("w01.12").getAttribute("data-parent")).toBe("wlan01");
    expect(rowFor("w10.10").textContent).toContain("└─");
    expect(rowFor("w10.10").textContent).toContain("Sub-interface");
    expect(rowFor("w10.10").textContent).not.toContain("VLAN");
    // wlan02 is not listed, so w02.0 stays where it was.
    expect(rowFor("w02.0").classList.contains("iface-child")).toBe(false);
  });

  it("puts a FortiAP's br.10 under br0 as a sub-interface", () => {
    renderSi([
      { ifName: "br.10", ifType: "physical", adminStatus: "up", operStatus: "up" },
      { ifName: "br.12", ifType: "physical", adminStatus: "up", operStatus: "up" },
      { ifName: "br0",   ifType: "physical", adminStatus: "up", operStatus: "up" },
    ]);
    expect(names()).toEqual(["br0", "br.10", "br.12"]);
    expect(rowFor("br.10").getAttribute("data-parent")).toBe("br0");
    expect(rowFor("br.12").textContent).toContain("└─");
    expect(rowFor("br.12").textContent).toContain("Sub-interface");
    expect(rowFor("br.12").textContent).not.toContain("VLAN");
  });

  it("leaves br.10 at top level when br0 is not listed", () => {
    renderSi([{ ifName: "br.10", ifType: "physical", adminStatus: "up", operStatus: "up" }]);
    expect(rowFor("br.10").classList.contains("iface-child")).toBe(false);
  });

  it("leaves a dotted name at top level when its base is not listed", () => {
    renderSi([{ ifName: "eth0.20", ifType: "physical", adminStatus: "up", operStatus: "up" }]);
    expect(rowFor("eth0.20").classList.contains("iface-child")).toBe(false);
  });

  it("keeps a reported ifParent over the name", () => {
    renderSi([
      { ifName: "lag1",   ifType: "aggregate", adminStatus: "up", operStatus: "up" },
      { ifName: "port1",  ifType: "physical", adminStatus: "up", operStatus: "up" },
      { ifName: "port1.5", ifType: "physical", ifParent: "lag1", adminStatus: "up", operStatus: "up" },
    ]);
    expect(rowFor("port1.5").getAttribute("data-parent")).toBe("lag1");
  });
});

// The asset panel's tables have no page-controls row, so TableSF puts its own
// Clear above the table — disabled until a filter is live.
describe("Clear button", () => {
  const clearBtn = () => doc.querySelector(".sf-clear-bar .sf-clear-btn") as any;

  it("sits above the table, disabled while nothing is filtered", () => {
    expect(clearBtn()).not.toBeNull();
    expect(clearBtn().disabled).toBe(true);
    expect(doc.querySelectorAll(".sf-clear-btn")).toHaveLength(1);
  });

  it("clears every filter, re-renders and saves", async () => {
    await typeFilter("ifname", "port");
    expect(clearBtn().disabled).toBe(false);
    click(clearBtn());
    expect(names().sort()).toEqual(["lag1", "port1", "port2", "port3", "port9", "vlan50"]);
    expect(rowFor("port9").textContent).toContain("└─");
    expect(JSON.parse(g.localStorage.getItem(PREFS_KEY)).sfFilters).toEqual({});
    expect(clearBtn().disabled).toBe(true);
  });

  it("is enabled by a restored filter, and not duplicated by a re-render", () => {
    g.localStorage.setItem(PREFS_KEY, JSON.stringify({ sortKey: null, sortDir: "asc", sfFilters: { ifname: "port" } }));
    render();
    render();
    expect(doc.querySelectorAll(".sf-clear-btn")).toHaveLength(1);
    expect(clearBtn().disabled).toBe(false);
  });
});

describe("filtering", () => {
  it("matches text against the interface name", async () => {
    await typeFilter("ifname", "port");
    expect(names().sort()).toEqual(["port1", "port2", "port3", "port9"]);
  });

  it("renders an empty state rather than a blank table", async () => {
    await typeFilter("ifname", "no-such-port");
    expect(dataRows()).toHaveLength(0);
    expect(doc.getElementById("asset-iface-tbody")!.textContent).toMatch(/No interfaces match/);
  });

  it("matches a PoE status exactly", () => {
    checkboxFilter("poe", "fault", true);
    expect(names()).toEqual(["port2"]);
  });

  it("selects every port carrying one tagged VLAN out of its full set", () => {
    // The row value is the whole set, not the cell's "+N more" summary, so
    // picking 30 finds it wherever it sits in a trunk's list. port3 trunks ALL
    // VLANs and deliberately does NOT match — the device enumerated none.
    checkboxFilter("tagged-vlans", "30", true);
    expect(names().sort()).toEqual(["lag1", "port2"]);
  });

  it("selects ports by native VLAN without matching a longer id", () => {
    // The old free-text filter matched substrings: "10" also selected 100.
    checkboxFilter("native-vlan", "10", true);
    expect(names().sort()).toEqual(["port1", "port3"]);
  });
});

describe("re-render safety", () => {
  it("keeps the drill-down link working after the tbody is rewritten", () => {
    sortBy("ifname");
    click(rowFor("port1").querySelector(".asset-iface-link"));
    expect(openedIface).toBe("port1");
  });

  it("still renders a pin made after load as Monitored", async () => {
    const btn: any = rowFor("port1").querySelector(".asset-iface-toggle");
    expect(btn.textContent).toBe("Unmonitored");
    click(btn);
    await settle();
    expect(putCalls.at(-1)!.monitoredInterfaces).toContain("port1");
    expect(btn.textContent).toBe("Monitored");
    sortBy("mac");   // re-render from the row model
    const after: any = rowFor("port1").querySelector(".asset-iface-toggle");
    expect(after.getAttribute("aria-pressed")).toBe("true");
    expect(after.textContent).toBe("Monitored");
  });

  it("switches a Monitored interface back to Unmonitored", async () => {
    click(rowFor("port1").querySelector(".asset-iface-toggle"));
    await settle();
    click(rowFor("port1").querySelector(".asset-iface-toggle"));
    await settle();
    expect(putCalls.at(-1)!.monitoredInterfaces).not.toContain("port1");
    expect(rowFor("port1").querySelector(".asset-iface-toggle")!.textContent).toBe("Unmonitored");
  });

  it("persists sort + filter state per user and device type", async () => {
    sortBy("mac");
    await typeFilter("ifname", "port");
    const saved = JSON.parse(g.localStorage.getItem(PREFS_KEY));
    expect(saved.sortKey).toBe("mac");
    expect(saved.sfFilters.ifname).toBe("port");
    render();   // a refresh tick rebuilds the whole container
    expect(names().sort()).toEqual(["port1", "port2", "port3", "port9"]);
  });

  // A Status picker with every state ticked reads "All": it is no filter.
  it("keeps the tree under a saved filter that removes no row", () => {
    g.localStorage.setItem(PREFS_KEY, JSON.stringify({
      sortKey: null, sortDir: "asc", sfFilters: { status: ["admin shut", "down", "up"] },
    }));
    render();
    expect(sectionLabels()).toHaveLength(2);
    expect(rowFor("port9").textContent).toContain("└─");
    expect(doc.querySelectorAll('.iface-expand-toggle[data-parent="lag1"]')).toHaveLength(1);
  });

  it("stores no filter once every option of a multi-select is ticked", () => {
    for (const v of ["admin shut", "down", "up"]) checkboxFilter("status", v, true);
    const saved = JSON.parse(g.localStorage.getItem(PREFS_KEY));
    expect(saved.sfFilters.status).toBeUndefined();
    expect(rowFor("port9").textContent).toContain("└─");
  });

  it("drops a VLAN filter saved as free text before the column became a picker", () => {
    // Upgrade path: both VLAN columns used to render text inputs, so installs
    // carry saved string filters under these keys. Left in place, a string
    // filters by substring ("10" also selecting 100) through a control that can
    // no longer display or clear it.
    g.localStorage.setItem(PREFS_KEY, JSON.stringify({ sortKey: null, sortDir: "asc", sfFilters: { "native-vlan": "10" } }));
    render();
    expect(names()).toHaveLength(6);
    expect(doc.querySelector('th[data-sf-key="native-vlan"] .sf-multi-button')!.textContent).toBe("All");
  });

  it("keeps a collapsed parent collapsed across a rebuild", () => {
    click(doc.querySelector('.iface-expand-toggle[data-parent="lag1"]'));
    render();
    expect(rowFor("port9").getAttribute("style")).toBe("display:none");
    expect(doc.querySelector('.iface-expand-toggle[data-parent="lag1"]')!.textContent!.trim()).toBe("▶");
  });
});

describe("Monitor all / Unmonitor all", () => {
  const all = () => doc.getElementById("iface-poll-all") as any;

  it("offers Unmonitor all once every listed row is monitored, and clears them", async () => {
    click(all());
    await settle();
    expect(all().textContent).toBe("Unmonitor all");
    click(all());
    await settle();
    expect(putCalls.at(-1)!.monitoredInterfaces).toEqual([]);
    expect(all().textContent).toBe("Monitor all");
  });

  it("leaves a filtered-out pin alone — un-monitoring it would silently stop its polling", async () => {
    // port2 ships pinned; filter it out of the list, then monitor + unmonitor all.
    await typeFilter("ifname", "port1");
    click(all());
    await settle();
    click(all());
    await settle();
    expect(putCalls.at(-1)!.monitoredInterfaces).toEqual(["port2"]);
  });

  it("monitors only the listed rows", async () => {
    await typeFilter("ifname", "port3");
    click(all());
    await settle();
    expect(putCalls[0].monitoredInterfaces.sort()).toEqual(["port2", "port3"]);
  });
});

describe("a member whose parent isn't in the list", () => {
  /** Render an arbitrary system-info payload instead of the shared fixture. */
  function renderSi(si: Record<string, any>): void {
    doc.body.innerHTML = '<div id="ifaces"></div>';
    g._renderInterfacesTable(doc.getElementById("ifaces"), si, ASSET);
  }

  // A FortiLink trunk aggregate leaves the switch's ifTable while its link is
  // down, but its member ports keep naming it — so nesting strictly under a
  // present parent used to render them NOWHERE: not top-level (they have an
  // ifParent) and not under a cluster (the parent row was never built). The
  // ports disappeared from the System tab at the moment the trunk went down.
  it("renders it at top level instead of dropping it", () => {
    renderSi({
      lastSystemInfoAt: new Date().toISOString(),
      monitoredInterfaces: [], monitoredIpsecTunnels: [], lldpNeighbors: [], ipsecTunnels: [],
      interfaces: [
        { ifName: "port1",  ifType: "physical", adminStatus: "up", operStatus: "up" },
        { ifName: "port23", ifType: "physical", ifParent: "8EF5920000001-0", adminStatus: "up", operStatus: "up" },
      ],
    });
    expect(names().sort()).toEqual(["port1", "port23"]);
    expect(sectionLabels()[0]).toMatch(/Interfaces \(2\)/);
  });

  it("still nests it once the trunk row is present", () => {
    renderSi({
      lastSystemInfoAt: new Date().toISOString(),
      monitoredInterfaces: [], monitoredIpsecTunnels: [], lldpNeighbors: [], ipsecTunnels: [],
      interfaces: [
        { ifName: "8EF5920000001-0", ifType: "aggregate", adminStatus: "up", operStatus: "up" },
        { ifName: "port23", ifType: "physical", ifParent: "8EF5920000001-0", adminStatus: "up", operStatus: "up" },
      ],
    });
    const n = names();
    expect(n.indexOf("port23")).toBe(n.indexOf("8EF5920000001-0") + 1);
    expect(sectionLabels()[0]).toMatch(/Interfaces \(1\)/);
  });
});


describe("a member port belongs to its aggregate", () => {
  /** Render an arbitrary system-info payload instead of the shared fixture. */
  function renderSi(si: Record<string, any>): void {
    doc.body.innerHTML = '<div id="ifaces"></div>';
    g._renderInterfacesTable(doc.getElementById("ifaces"), si, ASSET);
  }
  const pollCellOf = (name: string) => rowFor(name).querySelector(":scope > td")!;

  // The elbow is what says "this row hangs off the one above". It was a lone
  // U+2514 at half opacity and read as a stray character; the two-glyph run
  // draws the line into the row, and the tee distinguishes a middle member
  // from the last one without counting.
  it("draws a tree connector on the nested row, tee then elbow", () => {
    renderSi({
      lastSystemInfoAt: new Date().toISOString(),
      monitoredInterfaces: [], monitoredIpsecTunnels: [], lldpNeighbors: [], ipsecTunnels: [],
      interfaces: [
        { ifName: "lag1",  ifType: "aggregate", adminStatus: "up", operStatus: "up" },
        { ifName: "port1", ifType: "physical", ifParent: "lag1", adminStatus: "up", operStatus: "up" },
        { ifName: "port2", ifType: "physical", ifParent: "lag1", adminStatus: "up", operStatus: "up" },
      ],
    });
    expect(rowFor("port1").textContent).toContain("├─");
    expect(rowFor("port2").textContent).toContain("└─");
    expect(rowFor("lag1").textContent).not.toContain("└─");
  });

  // The trunk answers "how busy is the link"; only the members show how the
  // load splits across it, so each member is pinnable on its own row.
  it("gives the nested member its own pin checkbox", () => {
    expect(rowFor("port9").querySelector(".asset-iface-toggle")).not.toBeNull();
    expect(rowFor("lag1").querySelector(".asset-iface-toggle")).not.toBeNull();
  });

  it("checks the box on a member that is already pinned", () => {
    renderSi({
      lastSystemInfoAt: new Date().toISOString(),
      monitoredInterfaces: ["port9"], monitoredIpsecTunnels: [], lldpNeighbors: [], ipsecTunnels: [],
      interfaces: [
        { ifName: "lag1",  ifType: "aggregate", adminStatus: "up", operStatus: "up" },
        { ifName: "port9", ifType: "physical", ifParent: "lag1", adminStatus: "up", operStatus: "up" },
      ],
    });
    const box: any = rowFor("port9").querySelector(".asset-iface-toggle");
    expect(box).not.toBeNull();
    expect(box.getAttribute("aria-pressed")).toBe("true");
    expect(box.textContent).toBe("Monitored");
  });

  it("keeps the checkbox on a member whose aggregate is absent", () => {
    renderSi({
      lastSystemInfoAt: new Date().toISOString(),
      monitoredInterfaces: [], monitoredIpsecTunnels: [], lldpNeighbors: [], ipsecTunnels: [],
      interfaces: [
        { ifName: "port23", ifType: "physical", ifParent: "8EF5920000001-0", adminStatus: "up", operStatus: "up" },
      ],
    });
    expect(rowFor("port23").querySelector(".asset-iface-toggle")).not.toBeNull();
  });

  // A VLAN subinterface nests under its parent the same way, but it is its own
  // segment with its own counters -- it is pinned on its own row.
  it("gives a nested VLAN subinterface its own pin checkbox", () => {
    renderSi({
      lastSystemInfoAt: new Date().toISOString(),
      monitoredInterfaces: [], monitoredIpsecTunnels: [], lldpNeighbors: [], ipsecTunnels: [],
      interfaces: [
        { ifName: "fortilink", ifType: "aggregate", adminStatus: "up", operStatus: "up" },
        { ifName: "x2",        ifType: "physical", ifParent: "fortilink", adminStatus: "up", operStatus: "up" },
        { ifName: "voice.fortilink", ifType: "vlan", vlanId: 30, ifParent: "fortilink", adminStatus: "up", operStatus: "up" },
      ],
    });
    expect(rowFor("voice.fortilink").classList.contains("iface-child")).toBe(true);
    expect(rowFor("voice.fortilink").querySelector(".asset-iface-toggle")).not.toBeNull();
    expect(rowFor("x2").querySelector(".asset-iface-toggle")).not.toBeNull();
    sortBy("ifname");
    expect(rowFor("voice.fortilink").querySelector(".asset-iface-toggle")).not.toBeNull();
  });

  it("keeps the member's checkbox in flat (filtered) mode", async () => {
    await typeFilter("ifname", "port");
    expect(rowFor("port9").querySelector(".asset-iface-toggle")).not.toBeNull();
  });

  // Select-all sweeps every rendered box, and a member is one of them now.
  it("is pinned by select-all alongside its aggregate", async () => {
    const all: any = doc.getElementById("iface-poll-all");
    expect(all.textContent).toBe("Monitor all");
    click(all);
    await settle();
    expect(putCalls[0].monitoredInterfaces).toContain("port9");
    expect(putCalls[0].monitoredInterfaces).toContain("lag1");
    expect(all.textContent).toBe("Unmonitor all");
  });
});

// An interface name is a link to its history panel — and, when its address
// sits in a Polaris network, a RIGHT click forks between the interface and
// that network's slide-over. The network is looked up on the right click (one
// ip-context request), so a plain click costs nothing and the fork appears
// only when there is somewhere to go.
describe("interface name → interface or network", () => {
  const SUBNET = { id: "S1", cidr: "10.0.0.0/24", name: "Servers" };
  const clickName = (name: string) => rightClick(rowFor(name).querySelector(".asset-iface-link"));

  it("a plain click opens the interface without a lookup", async () => {
    canReadNetworks = true;
    ipContextResult = { ip: "10.0.0.5", subnet: SUBNET };
    click(rowFor("port1").querySelector(".asset-iface-link"));
    await settle();
    expect(g.api.assets.ipContext).not.toHaveBeenCalled();
    expect(openedIface).toBe("port1");
    expect(menuCalls).toHaveLength(0);
  });

  it("marks the name for the right-click listener", () => {
    expect(rowFor("port1").querySelector(".asset-iface-link")!.hasAttribute("data-row-menu")).toBe(true);
  });
  const menuLabels = () => menuCalls[0].items.map((i) => i.label);
  const pick = (label: string) => menuCalls[0].items.find((i) => i.label === label)!.onSelect();

  it("reads the lookup address off a row the way devices report it", () => {
    expect(g._ifaceIpForLookup("10.0.0.5")).toBe("10.0.0.5");
    expect(g._ifaceIpForLookup("10.0.0.5/24")).toBe("10.0.0.5");
    expect(g._ifaceIpForLookup("10.0.0.5 255.255.255.0")).toBe("10.0.0.5");
    expect(g._ifaceIpForLookup("10.0.0.5, 10.0.0.6")).toBe("10.0.0.5");
    expect(g._ifaceIpForLookup("fd00::1/64")).toBe("fd00::1");
    // The unconfigured placeholders a FortiGate / Linux host reports are not addresses.
    expect(g._ifaceIpForLookup("0.0.0.0 0.0.0.0")).toBeNull();
    expect(g._ifaceIpForLookup("::")).toBeNull();
    expect(g._ifaceIpForLookup(null)).toBeNull();
    expect(g._ifaceIpForLookup("")).toBeNull();
    expect(g._ifaceIpForLookup("dhcp")).toBeNull();
  });

  it("offers Open interface / Open network when the address is in a network, and the pick lands on that address", async () => {
    canReadNetworks = true;
    ipContextResult = { ip: "10.0.0.5", subnet: SUBNET };
    clickName("port1");
    await settle();
    expect(g.api.assets.ipContext).toHaveBeenCalledWith("10.0.0.5");
    expect(openedIface).toBeNull();                       // a menu, not the panel
    expect(menuLabels()).toEqual(["Open interface", "Open network"]);
    expect(menuCalls[0].anchor).toBe(rowFor("port1").querySelector(".asset-iface-link"));
    // Opened where the pointer was, not under the name.
    expect(menuCalls[0].opts.menuAt).toEqual({ x: 40, y: 50 });
    pick("Open network");
    expect(g.PolarisPanels.openNetwork).toHaveBeenCalledWith("S1", { focusIp: "10.0.0.5", subnetCidr: "10.0.0.0/24" });
    pick("Open interface");
    expect(openedIface).toBe("port1");
  });

  it("offers only Open interface when the address is in no network", async () => {
    canReadNetworks = true;
    ipContextResult = { ip: "10.0.0.5", subnet: null };
    clickName("port1");
    await settle();
    expect(menuLabels()).toEqual(["Open interface"]);
  });

  it("never looks up an interface with no address", async () => {
    canReadNetworks = true;
    ipContextResult = { ip: "x", subnet: SUBNET };
    clickName("port2");
    await settle();
    expect(g.api.assets.ipContext).not.toHaveBeenCalled();
    expect(menuLabels()).toEqual(["Open interface"]);
  });

  it("never looks up for a viewer who cannot read networks", async () => {
    canReadNetworks = false;
    ipContextResult = { ip: "10.0.0.5", subnet: SUBNET };
    clickName("port1");
    await settle();
    expect(g.api.assets.ipContext).not.toHaveBeenCalled();
    expect(menuLabels()).toEqual(["Open interface"]);
  });

  it("opens the interface when the lookup fails, or lands after the table re-rendered", async () => {
    canReadNetworks = true;
    g.api.assets.ipContext = vi.fn(async () => { throw new Error("503"); });
    clickName("port1");
    await settle();
    expect(openedIface).toBe("port1");
    // Re-render between click and answer: the anchor is gone, so no menu.
    openedIface = null;
    ipContextResult = { ip: "10.0.0.5", subnet: SUBNET };
    let answer: (v: unknown) => void = () => {};
    g.api.assets.ipContext = vi.fn(() => new Promise((r) => { answer = r; }));
    clickName("port1");
    render();
    answer(ipContextResult);
    await settle();
    expect(menuCalls).toHaveLength(0);
    expect(openedIface).toBe("port1");
  });
});

// IPsec tunnels are the IPsec tab's: it lists them with their connected peers,
// their pins and their history. A FortiGate reports each one twice — as an
// IPsec-stream tunnel and as a `tunnel`-typed interface row (the CMDB back-fill
// on REST, IF-MIB on SNMP) — and this table carries neither, pinned or not.
// A tunnel interface with no IPsec twin (GRE / VXLAN / ssl.root) stays.
describe("IPsec tunnels live on the IPsec tab, not here", () => {
  function renderSi(monitoredInterfaces: string[]): void {
    doc.body.innerHTML = '<div id="ifaces"></div>';
    g._renderInterfacesTable(doc.getElementById("ifaces"), {
      lastSystemInfoAt: new Date().toISOString(),
      monitoredInterfaces, monitoredIpsecTunnels: [], lldpNeighbors: [],
      interfaces: [
        { ifName: "wan1",   ifType: "physical", adminStatus: "up", operStatus: "up", ipAddress: "198.51.100.2" },
        { ifName: "vpn-hq", ifType: "tunnel",   adminStatus: "up", operStatus: null, ipAddress: "10.255.0.1" },
        { ifName: "gre1",   ifType: "tunnel",   adminStatus: "up", operStatus: null, ipAddress: "10.254.0.1" },
      ],
      ipsecTunnels: [
        { tunnelName: "vpn-hq", status: "up", parentInterface: "wan1", remoteGateway: "203.0.113.7" },
      ],
    }, ASSET);
  }

  it("lists neither the tunnel nor its interface twin", () => {
    renderSi([]);
    expect(names()).not.toContain("vpn-hq");
    expect(doc.querySelector(".asset-ipsec-link, .asset-ipsec-toggle")).toBeNull();
  });

  it("leaves out a PINNED interface twin too — its pin is shown and cleared on the IPsec tab", () => {
    renderSi(["vpn-hq"]);
    expect(names()).not.toContain("vpn-hq");
  });

  it("points at the IPsec tab, and the link switches to it", () => {
    renderSi([]);
    const hint = doc.querySelector(".hint")!;
    expect(hint.textContent).toMatch(/1 IPsec tunnel is on the IPsec tab/);
    doc.body.insertAdjacentHTML("beforeend",
      '<div id="asset-view-tabs"><button class="page-tab" data-tab="ipsec"></button></div>');
    let switched = false;
    doc.querySelector('#asset-view-tabs .page-tab[data-tab="ipsec"]')!.addEventListener("click", () => { switched = true; });
    // The pointer was wired at render, before the tab strip existed in this
    // fixture — the lookup happens at click time, as in the slide-over.
    click(doc.querySelector(".asset-ipsec-tab-link"));
    expect(switched).toBe(true);
  });

  it("leaves a tunnel interface with no IPsec twin (GRE / VXLAN) where it was", () => {
    renderSi([]);
    expect(rowFor("gre1").querySelector(".asset-iface-link")).not.toBeNull();
    expect(sectionLabels().some((s) => /Other Interfaces \(1\)/.test(s))).toBe(true);
  });

  it("says where the tunnels went when they were all the gate reported", () => {
    doc.body.innerHTML = '<div id="ifaces"></div>';
    g._renderInterfacesTable(doc.getElementById("ifaces"), {
      lastSystemInfoAt: new Date().toISOString(), monitoredInterfaces: [], monitoredIpsecTunnels: [], lldpNeighbors: [],
      interfaces: [{ ifName: "vpn-hq", ifType: "tunnel", adminStatus: "up" }],
      ipsecTunnels: [{ tunnelName: "vpn-hq", status: "up" }],
    }, ASSET);
    expect(doc.getElementById("ifaces")!.textContent).toMatch(/on the IPsec tab/);
  });
});

// A neighbor that resolved to an asset with an active alert carries the same
// strobing severity dot the Assets list draws (app.js → alertSummaryDotHTML),
// from the `alert` summary GET /assets/:id/system-info stamps on matchedAsset.
describe("neighbor alert dot", () => {
  const appLines = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8").split(/\r?\n/);
  function appFnSrc(name: string): string {
    const start = appLines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = appLines.findIndex((l, i) => i > start && l === "}");
    return appLines.slice(start, end + 1).join("\n");
  }
  function renderNeighbor(matchedAsset: Record<string, any> | null): void {
    (0, eval)(appFnSrc("assetAlertStrobeColor"));
    (0, eval)(appFnSrc("alertSummaryDotHTML"));
    const si = makeSi();
    si.lldpNeighbors = [{ localIfName: "port1", systemName: "core-sw", portId: "ge-0/0/1", matchedAsset } as any];
    doc.body.innerHTML = '<div id="ifaces"></div>';
    g._renderInterfacesTable(doc.getElementById("ifaces"), si, ASSET);
  }

  it("strobes in the worst severity's colour while an alert is unacknowledged", () => {
    renderNeighbor({ id: "A1", alert: { severity: "serious", count: 2, unacknowledged: 1 } });
    const dot = rowFor("port1").querySelector(".alert-strobe-dot") as any;
    expect(dot).not.toBeNull();
    expect(dot.classList.contains("is-handled")).toBe(false);
    expect(dot.getAttribute("style")).toContain("--color-sev-serious");
  });

  it("stays marked but still once every alert is acknowledged", () => {
    renderNeighbor({ id: "A1", alert: { severity: "warning", count: 1, unacknowledged: 0 } });
    expect(rowFor("port1").querySelector(".alert-strobe-dot")!.classList.contains("is-handled")).toBe(true);
  });

  it("draws nothing for a quiet neighbor or an unmatched one", () => {
    renderNeighbor({ id: "A1", alert: null });
    expect(rowFor("port1").querySelector(".alert-strobe-dot")).toBeNull();
    renderNeighbor(null);
    expect(rowFor("port1").querySelector(".alert-strobe-dot")).toBeNull();
  });
});

// Business rule 126: the interface's IPv6 gets its own column — only on a
// device that reports one — filterable like IP, and an IPv6-only interface
// looks up its network by its IPv6.
describe("IPv6 column", () => {
  function renderWithV6(ipv6On = true): void {
    // Business rule 128: the install's IPv6 switch, from /auth/me.
    g.polarisIpv6Enabled = ipv6On;
    const si = makeSi();
    si.interfaces[0] = { ...si.interfaces[0], ipv6Address: "2001:db8::5" };
    si.interfaces[5] = { ...si.interfaces[5], ipAddress: null, ipv6Address: "2001:db8:50::1" };
    doc.body.innerHTML = '<div id="ifaces"></div>';
    g._renderInterfacesTable(doc.getElementById("ifaces"), si, ASSET);
  }
  const cellTexts = (tr: Element) => Array.from(tr.querySelectorAll(":scope > td")).map((td) => td.textContent!.trim());

  it("is absent on a device whose interfaces carry no IPv6", () => {
    expect(doc.querySelector('th[data-sf-key="ipv6"]')).toBeNull();
  });

  it("is absent while IPv6 is off for the install, even when rows carry IPv6", () => {
    renderWithV6(false);
    expect(doc.querySelector('th[data-sf-key="ipv6"]')).toBeNull();
    expect(dataRows().map((tr) => tr.textContent).join(" ")).not.toContain("2001:db8");
  });

  it("appears beside IP once an interface reports one, and filters by text", async () => {
    renderWithV6();
    const heads = Array.from(doc.querySelectorAll("thead th")).map((th) => th.getAttribute("data-col-id"));
    expect(heads.indexOf("ipv6")).toBe(heads.indexOf("ip") + 1);
    expect(cellTexts(rowFor("port1"))).toContain("2001:db8::5");
    await typeFilter("ipv6", "2001:db8:50");
    expect(names()).toEqual(["vlan50"]);
  });

  it("looks up an IPv6-only interface's network by its IPv6", async () => {
    renderWithV6();
    canReadNetworks = true;
    ipContextResult = { ip: "2001:db8:50::1", subnet: { id: "S6", cidr: "2001:db8:50::/64", name: "v6" } };
    rightClick(rowFor("vlan50").querySelector(".asset-iface-link"));
    await settle();
    expect(g.api.assets.ipContext).toHaveBeenCalledWith("2001:db8:50::1");
  });
});
