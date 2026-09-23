/**
 * tests/unit/mobileNetworksTab.test.ts
 *
 * The phone's Networks tab (networks-tab.js) and the network IP sheet it
 * opens (subnet-detail.js → PolarisNetworkSheet). What's pinned:
 *
 *   - sorting runs over the whole list, and "Network" is ADDRESS order
 *     through the desktop's own TableSF._ipNum (10.0.2.0 before 10.0.10.0,
 *     IPv6 after IPv4), not string order;
 *   - a row with no value sorts last in both directions;
 *   - the filter is every-term-must-match over name / CIDR / purpose / VLAN /
 *     FortiGate / block / tags, and the status chips narrow on `status`;
 *   - tapping a network opens the IP sheet over the list — no navigation;
 *   - the sheet lists the network's IPs, offers no Edit / Release on a
 *     device-owned (VIP / interface) row, and closes on a route change;
 *   - the old #subnet/<id> route lands on the Networks tab with that
 *     network's sheet open.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), "public", "js", ...p), "utf-8");
const TABLE_SF_SRC = read("table-sf.js");
const LIST_SRC = read("mobile", "list-controls.js");
const ACTIONS_SRC = read("mobile", "reservation-actions.js");
const SHEET_SRC = read("mobile", "subnet-detail.js");
const TAB_SRC = read("mobile", "networks-tab.js");

const g = globalThis as any;
const flush = () => new Promise((r) => setTimeout(r, 0));

function subnet(over: Record<string, unknown>) {
  return {
    id: "s-" + String(over.cidr),
    name: "",
    cidr: "10.0.0.0/24",
    status: "available",
    purpose: null,
    vlan: null,
    fortigateDevice: null,
    tags: [],
    block: { name: "Corp", cidr: "10.0.0.0/8" },
    utilizationPercent: 0,
    usableHosts: 254,
    _count: { reservations: 0 },
    ...over,
  };
}

const ROWS = [
  subnet({ name: "Branch", cidr: "10.0.10.0/24", vlan: 20, purpose: "Wireless", utilizationPercent: 50, _count: { reservations: 127 }, fortigateDevice: "FGT-BR1" }),
  subnet({ name: "alpha",  cidr: "10.0.2.0/24",  vlan: 10, purpose: "Servers",  utilizationPercent: 90, _count: { reservations: 229 }, status: "reserved" }),
  subnet({ name: "v6",     cidr: "2001:db8::/64", utilizationPercent: null, usableHosts: null, tags: ["lab"] }),
  subnet({ name: "Core",   cidr: "10.0.2.0/23",  utilizationPercent: 5, status: "deprecated" }),
];

let ipsCalls: string[] = [];
let IPS: any[] = [];

function load(user: any = { username: "u", permissions: { reservations: "fullwrite", subnets: "read" } }) {
  document.body.innerHTML =
    '<div id="app"><div id="topbar-slot"></div><main class="app-body" id="app-body"></main></div>';
  ipsCalls = [];
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  g.mobileFormatDate = (d: any) => String(d ?? "");
  g.api = {
    subnets: {
      list: vi.fn(async () => ({ subnets: ROWS.map((r) => ({ ...r })), total: ROWS.length })),
      ips: vi.fn(async (id: string) => {
        ipsCalls.push(id);
        return {
          subnet: { id, name: "Branch", cidr: "10.0.10.0/24", fortigateDevice: "FGT-BR1", pushEligible: false },
          ips: IPS,
          page: 1,
          totalIps: IPS.length,
        };
      }),
      refresh: vi.fn(async () => ({})),
    },
    reservations: { create: vi.fn(), update: vi.fn(), release: vi.fn(), get: vi.fn() },
    search: { query: vi.fn() },
  };
  g.PolarisRouter = { go: vi.fn(), current: () => ({ name: "networks", parts: [] }) };
  g.PolarisTabs = { showSnackbar: vi.fn(), attachSwipeToDismiss: vi.fn() };
  g.PolarisAssetDetail = { open: vi.fn() };
  g.PolarisMobile = { user: () => user };
  for (const src of [TABLE_SF_SRC, LIST_SRC, ACTIONS_SRC, SHEET_SRC, TAB_SRC]) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(src)();
  }
  // table-sf.js declares TableSF as a script-level function; lift it onto the
  // global the way a browser <script> would.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  if (!g.TableSF) g.TableSF = new Function(TABLE_SF_SRC + "\nreturn TableSF;")();
  return user;
}

function render(user?: any) {
  const u = load(user);
  const spec = g.PolarisNetworksTab.spec;
  document.getElementById("topbar-slot")!.innerHTML = spec.renderTopbar();
  spec.render(document.getElementById("app-body")!, { user: u, route: { name: "networks", parts: [] } });
  return spec;
}

const names = () => Array.from(document.querySelectorAll(".network-row .headline")).map((h) => h.childNodes[0].textContent);

describe("Networks tab — sort + filter helpers", () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } load(); });

  it("sorts Network in ADDRESS order, IPv4 before IPv6, shorter prefix first on a tie", () => {
    const out = g.PolarisNetworksTab._sortRows(ROWS, "cidr", "asc").map((r: any) => r.cidr);
    expect(out).toEqual(["10.0.2.0/23", "10.0.2.0/24", "10.0.10.0/24", "2001:db8::/64"]);
  });

  it("reverses address order on descending", () => {
    const out = g.PolarisNetworksTab._sortRows(ROWS, "cidr", "desc").map((r: any) => r.cidr);
    expect(out).toEqual(["2001:db8::/64", "10.0.10.0/24", "10.0.2.0/24", "10.0.2.0/23"]);
  });

  it("keeps rows with no value LAST in both directions", () => {
    const asc = g.PolarisNetworksTab._sortRows(ROWS, "utilization", "asc").map((r: any) => r.name);
    const desc = g.PolarisNetworksTab._sortRows(ROWS, "utilization", "desc").map((r: any) => r.name);
    expect(asc).toEqual(["Core", "Branch", "alpha", "v6"]);
    expect(desc).toEqual(["alpha", "Branch", "Core", "v6"]);
  });

  it("sorts names case-insensitively", () => {
    expect(g.PolarisNetworksTab._sortRows(ROWS, "name", "asc").map((r: any) => r.name))
      .toEqual(["alpha", "Branch", "Core", "v6"]);
  });

  it("requires EVERY term to match, across the columns the desktop list shows", () => {
    const f = g.PolarisNetworksTab._filterRows;
    expect(f(ROWS, "vlan 20", "all").map((r: any) => r.name)).toEqual(["Branch"]);
    expect(f(ROWS, "fgt-br1", "all").map((r: any) => r.name)).toEqual(["Branch"]);
    expect(f(ROWS, "10.0.2", "all").map((r: any) => r.name).sort()).toEqual(["Core", "alpha"]);
    expect(f(ROWS, "lab", "all").map((r: any) => r.name)).toEqual(["v6"]);
    expect(f(ROWS, "corp servers", "all").map((r: any) => r.name)).toEqual(["alpha"]);
    expect(f(ROWS, "servers wireless", "all")).toEqual([]);
  });

  it("narrows on status", () => {
    const f = g.PolarisNetworksTab._filterRows;
    expect(f(ROWS, "", "reserved").map((r: any) => r.name)).toEqual(["alpha"]);
    expect(f(ROWS, "", "deprecated").map((r: any) => r.name)).toEqual(["Core"]);
  });
});

describe("Networks tab — list", () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } IPS = []; });

  it("loads the WHOLE list once, like the desktop Networks page", async () => {
    render();
    await flush();
    expect(g.api.subnets.list).toHaveBeenCalledWith({ limit: 10000 });
    expect(names()).toEqual(["alpha", "Branch", "Core", "v6"]);
    expect(document.querySelector(".list-count")!.textContent).toBe("4 networks");
  });

  it("filters as the operator types and counts what is shown", async () => {
    render();
    await flush();
    const input = document.getElementById("networks-filter") as HTMLInputElement;
    input.value = "wireless";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(names()).toEqual(["Branch"]);
    expect(document.querySelector(".list-count")!.textContent).toBe("1 of 4 networks");
    expect(g.api.subnets.list).toHaveBeenCalledTimes(1); // client-side — no re-fetch
  });

  it("re-sorts from the sheet and persists the choice", async () => {
    render();
    await flush();
    (document.getElementById("networks-sort") as HTMLButtonElement).click();
    (document.querySelector('#list-sort-sheet [data-sort="utilization"]') as HTMLButtonElement).click();
    expect(names()).toEqual(["alpha", "Branch", "Core", "v6"]);
    expect(JSON.parse(localStorage.getItem("polaris-mobile-networks-list")!)).toMatchObject({ sortKey: "utilization", sortDir: "desc" });
    expect(document.getElementById("networks-sort")!.textContent).toContain("Utilization");
  });

  it("narrows with the status chips", async () => {
    render();
    await flush();
    (document.querySelector('#networks-chips [data-key="deprecated"]') as HTMLButtonElement).click();
    expect(names()).toEqual(["Core"]);
  });

  it("opens the tapped network in a sheet over the list — no navigation", async () => {
    render();
    await flush();
    (document.querySelector('.network-row[data-id="s-10.0.10.0/24"]') as HTMLButtonElement).click();
    await flush();
    expect(g.PolarisRouter.go).not.toHaveBeenCalled();
    expect(document.getElementById("network-sheet")).not.toBeNull();
    expect(ipsCalls).toEqual(["s-10.0.10.0/24"]);
    // The list is still underneath.
    expect(document.querySelectorAll(".network-row").length).toBe(4);
  });

  it("hides the Reserve FAB from a read-only viewer", async () => {
    render({ username: "ro", permissions: { reservations: "read", subnets: "read" } });
    await flush();
    expect(document.getElementById("networks-fab")).toBeNull();
  });
});

describe("network IP sheet", () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
    IPS = [
      { address: "10.0.10.1", type: "host", assetId: null, reservation: { id: "r1", sourceType: "vip", hostname: "web-vip", createdBy: "u" } },
      { address: "10.0.10.2", type: "host", assetId: "a9", reservation: { id: "r2", sourceType: "manual", hostname: "printer", createdBy: "u" } },
      { address: "10.0.10.3", type: "host", assetId: null, reservation: null },
    ];
  });

  async function openSheet() {
    const user = load();
    g.PolarisNetworkSheet.open("s1", user, { title: "Branch" });
    await flush();
  }

  const expand = (ip: string) =>
    (document.querySelector(`#network-sheet .list-item[data-ip="${ip}"]`) as HTMLButtonElement).click();

  it("lists the network's addresses with its header verbs", async () => {
    await openSheet();
    const rows = document.querySelectorAll("#network-sheet .list-item[data-ip]");
    expect(rows.length).toBe(3);
    expect(document.getElementById("network-sheet-title")!.textContent).toBe("Branch");
    expect(document.getElementById("subnet-reserve-btn")).not.toBeNull();
    expect(document.getElementById("subnet-refresh-btn")).not.toBeNull(); // FortiGate-discovered + write
  });

  it("offers no Edit or Release on a device-owned VIP row", async () => {
    await openSheet();
    expand("10.0.10.1");
    const panel = document.querySelector("#network-sheet .reservation-expand")!;
    expect(panel.querySelector('[data-act="edit"]')).toBeNull();
    expect(panel.querySelector('[data-act="free"]')).toBeNull();
  });

  it("offers Edit, Release and Open asset on a manual reservation", async () => {
    await openSheet();
    expand("10.0.10.2");
    const panel = document.querySelector("#network-sheet .reservation-expand")!;
    expect(panel.querySelector('[data-act="edit"]')).not.toBeNull();
    expect(panel.querySelector('[data-act="free"]')).not.toBeNull();
    (panel.querySelector('[data-act="open-asset"]') as HTMLButtonElement).click();
    expect(g.PolarisAssetDetail.open).toHaveBeenCalledWith("a9");
  });

  it("opens the Reserve sheet on a free address, stacked over the network sheet", async () => {
    await openSheet();
    expand("10.0.10.3");
    expect(document.getElementById("reserve-sheet")).not.toBeNull();
    expect(document.getElementById("network-sheet")).not.toBeNull();
    expect((document.getElementById("r-ip") as HTMLInputElement).value).toBe("10.0.10.3");
  });

  it("closes on a route change", async () => {
    await openSheet();
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(document.getElementById("network-sheet")).toBeNull();
    expect(document.getElementById("network-sheet-scrim")).toBeNull();
  });

  it("ignores a response that lands after the sheet was closed", async () => {
    const user = load();
    g.PolarisNetworkSheet.open("s1", user, {});
    g.PolarisNetworkSheet.close();
    await flush();
    expect(document.getElementById("network-sheet")).toBeNull();
    expect(document.getElementById("subnet-ip-list")).toBeNull();
  });

  it("the old #subnet/<id> route lands on the Networks tab with that sheet open", async () => {
    const user = load();
    const spyOpen = vi.spyOn(g.PolarisNetworksTab, "openNetwork");
    g.PolarisSubnetDetail.spec.render(document.getElementById("app-body")!, { user, route: { name: "subnet", parts: ["s1"] } });
    // Deferred a tick so app.js finishes mounting the route first.
    expect(g.PolarisRouter.go).not.toHaveBeenCalled();
    await flush();
    expect(g.PolarisRouter.go).toHaveBeenCalledWith("networks", { replace: true });
    expect(spyOpen).toHaveBeenCalledWith("s1");
  });
});
