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
  "_distinctVlanOptions",
  "_sizeAssetIfaceTableWrapper",
  "_renderInterfacesTable",
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
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.showToast = () => {};
  g.canManageAssets = () => true;
  g._staleBannerHTML = () => "";
  g._fmtSpeed = (b: number) => `${b}bps`;
  g._fmtBytes = (b: number) => `${b}B`;
  g._screenshotTableEl = () => {};
  g.openInterfaceDetailPanel = (_a: unknown, n: string) => { openedIface = n; };
  g.openIpsecTunnelDetailPanel = () => {};
  g.openViewModal = () => {};
  g.permAtLeast = (key: string) => key === "subnets" ? canReadNetworks : true;
  g.showRowMenu = (anchor: Element, items: any[], opts: any) => { menuCalls.push({ anchor, items, opts }); };
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
  it("renders every interface and tunnel — nothing is hidden for lack of traffic", () => {
    // The "Show N inactive interfaces" expander is gone: port3 (admin-shut, no
    // counters) and orphan-tn (dead tunnel) are ordinary visible rows now.
    expect(names().sort()).toEqual(
      ["lag1", "orphan-tn", "port1", "port2", "port3", "port9", "to-hq", "vlan50"],
    );
    expect(dataRows().every((tr) => tr.getAttribute("style") !== "display:none")).toBe(true);
  });

  it("keeps the nesting and the section headers", () => {
    const n = names();
    expect(n.indexOf("port9")).toBe(n.indexOf("lag1") + 1);   // member under its aggregate
    expect(sectionLabels()).toHaveLength(3);
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

  it("freezes the header by height-bounding the wrapper's own scroll", () => {
    const w = doc.getElementById("asset-iface-wrapper")!;
    expect(w.classList.contains("table-wrapper-panel-sticky")).toBe(true);
    expect(parseInt((w as any).style.maxHeight, 10)).toBeGreaterThanOrEqual(300);
  });
});

describe("sorting", () => {
  it("flattens the tree — no section headers, no expand toggles", () => {
    sortBy("in");
    expect(sectionLabels()).toEqual([]);
    expect(doc.querySelectorAll(".iface-expand-toggle")).toHaveLength(0);
    // A member port is no longer indented under anything, so its badge is the
    // only thing left identifying it as one.
    expect(rowFor("port9").outerHTML).toMatch(/Member/);
  });

  it("orders by the numeric counter, with unreported rows last", () => {
    sortBy("in");
    expect(names().slice(0, 4)).toEqual(["to-hq", "port1", "port9", "lag1"]);
    sortBy("in");
    expect(names()[0]).toBe("lag1");   // second click reverses
  });

  it("reveals the children of a collapsed parent instead of stranding them", () => {
    click(doc.querySelector('.iface-expand-toggle[data-parent="lag1"]'));
    expect(rowFor("port9").style.display).toBe("none");
    sortBy("ifname");
    expect(names()).toContain("port9");
    expect(dataRows().every((tr) => tr.getAttribute("style") !== "display:none")).toBe(true);
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

  it("excludes tunnels from a PoE filter — they report null, not zero", () => {
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

  it("still renders a pin made after load as checked", async () => {
    const cb: any = rowFor("port1").querySelector(".asset-iface-toggle");
    cb.checked = true;
    change(cb);
    await settle();
    expect(putCalls.at(-1)!.monitoredInterfaces).toContain("port1");
    sortBy("mac");   // re-render from the row model
    expect((rowFor("port1").querySelector(".asset-iface-toggle") as any).checked).toBe(true);
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

  it("drops a VLAN filter saved as free text before the column became a picker", () => {
    // Upgrade path: both VLAN columns used to render text inputs, so installs
    // carry saved string filters under these keys. Left in place, a string
    // filters by substring ("10" also selecting 100) through a control that can
    // no longer display or clear it.
    g.localStorage.setItem(PREFS_KEY, JSON.stringify({ sortKey: null, sortDir: "asc", sfFilters: { "native-vlan": "10" } }));
    render();
    expect(names()).toHaveLength(8);
    expect(doc.querySelector('th[data-sf-key="native-vlan"] .sf-multi-button')!.textContent).toBe("All");
  });

  it("keeps a collapsed parent collapsed across a rebuild", () => {
    click(doc.querySelector('.iface-expand-toggle[data-parent="lag1"]'));
    render();
    expect(rowFor("port9").getAttribute("style")).toBe("display:none");
    expect(doc.querySelector('.iface-expand-toggle[data-parent="lag1"]')!.textContent!.trim()).toBe("▶");
  });
});

describe("select-all", () => {
  it("clears every listed row when nothing is filtered", async () => {
    const all: any = doc.getElementById("iface-poll-all");
    all.checked = false;
    change(all);
    await settle();
    expect(putCalls[0].monitoredInterfaces).toEqual([]);
  });

  it("leaves a filtered-out pin alone — un-pinning it would silently stop its polling", async () => {
    // port2 ships pinned; filter it out of the list, then clear-all.
    await typeFilter("ifname", "port1");
    const all: any = doc.getElementById("iface-poll-all");
    all.checked = false;
    change(all);
    await settle();
    expect(putCalls[0].monitoredInterfaces).toEqual(["port2"]);
  });

  it("pins only the listed rows when checked", async () => {
    await typeFilter("ifname", "port3");
    const all: any = doc.getElementById("iface-poll-all");
    all.checked = true;
    change(all);
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

  // A LAG is one link as far as history goes: three checkboxes answering one
  // question is what the member boxes were.
  it("gives the nested member no pin checkbox", () => {
    expect(rowFor("port9").querySelector(".asset-iface-toggle")).toBeNull();
    expect(pollCellOf("port9").getAttribute("title")).toMatch(/Member of lag1/);
    expect(rowFor("lag1").querySelector(".asset-iface-toggle")).not.toBeNull();
  });

  // ...unless it is already pinned. Hiding THAT box would leave the pin
  // collecting history and feeding interface triggers with nothing in the UI
  // saying so, and no way to switch it off.
  it("keeps the checkbox on a member that is already pinned", () => {
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
    expect(box.checked).toBe(true);
  });

  // A member rendered at TOP level has no aggregate to be pinned through --
  // the trunk is out of the ifTable because the link is down, which is exactly
  // when the member port is the signal worth recording.
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

  // Flat mode has no row above to hang off, so the Member badge carries the
  // relationship -- but the pin still belongs to the aggregate.
  it("withholds the checkbox in flat (sorted) mode too", () => {
    sortBy("ifname");
    expect(rowFor("port9").querySelector(".asset-iface-toggle")).toBeNull();
  });

  // Select-all iterates the rendered boxes, so a member simply is not one of
  // them -- it must not be swept into a pin-everything.
  it("is not pinned by select-all", async () => {
    const all: any = doc.getElementById("iface-poll-all");
    all.checked = true;
    change(all);
    await settle();
    expect(putCalls[0].monitoredInterfaces).not.toContain("port9");
    expect(putCalls[0].monitoredInterfaces).toContain("lag1");
  });
});

// An interface name is a link to its history panel — and, when its address
// sits in a Polaris network, a fork between the interface and that network's
// slide-over. The network is looked up on click (one ip-context request), so
// the fork appears only when there is somewhere to go.
describe("interface name → interface or network", () => {
  const SUBNET = { id: "S1", cidr: "10.0.0.0/24", name: "Servers" };
  const clickName = (name: string) => click(rowFor(name).querySelector(".asset-iface-link"));
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
    pick("Open network");
    expect(g.PolarisPanels.openNetwork).toHaveBeenCalledWith("S1", { focusIp: "10.0.0.5", subnetCidr: "10.0.0.0/24" });
    pick("Open interface");
    expect(openedIface).toBe("port1");
  });

  it("opens the interface straight away when the address is in no network", async () => {
    canReadNetworks = true;
    ipContextResult = { ip: "10.0.0.5", subnet: null };
    clickName("port1");
    await settle();
    expect(openedIface).toBe("port1");
    expect(menuCalls).toHaveLength(0);
  });

  it("never looks up an interface with no address", async () => {
    canReadNetworks = true;
    ipContextResult = { ip: "x", subnet: SUBNET };
    clickName("port2");
    await settle();
    expect(g.api.assets.ipContext).not.toHaveBeenCalled();
    expect(openedIface).toBe("port2");
  });

  it("never looks up for a viewer who cannot read networks", async () => {
    canReadNetworks = false;
    ipContextResult = { ip: "10.0.0.5", subnet: SUBNET };
    clickName("port1");
    await settle();
    expect(g.api.assets.ipContext).not.toHaveBeenCalled();
    expect(openedIface).toBe("port1");
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
