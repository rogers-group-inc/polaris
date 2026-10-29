/**
 * tests/unit/mobileAssetIpsecDepTree.test.ts — the asset sheet's IPsec and
 * Dependency Tree pages.
 *
 *   • "View Dependency Tree" is the first hero button (above SD-WAN) on every
 *     asset; its page lists upstream / this device / downstream, and every
 *     other device's name is a link that opens it a page forward.
 *   • "View IPsec" sits directly above the Interfaces section, only on a
 *     Fortinet firewall whose read returned tunnels or peers. Its page lists
 *     tunnels with a dial-up template's peers collapsed under it, then the
 *     remote-access users.
 *   • The Interfaces list no longer repeats an IPsec tunnel's interface twin;
 *     a line points at the IPsec page instead. A tunnel interface with no
 *     IPsec twin stays.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "asset-detail.js"), "utf-8");
const g = globalThis as any;
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

const FMG = { type: "fortimanager" };
const ASSETS: Record<string, any> = {
  fw: { id: "fw", hostname: "HUB-1", assetType: "firewall", monitored: true, status: "active", macAddresses: [],
    discoveredByIntegration: FMG, monitoredInterfaces: [] },
  sw: { id: "sw", hostname: "IDF-1", assetType: "switch", monitored: true, status: "active", macAddresses: [], monitoredInterfaces: [] },
  pc: { id: "pc", hostname: "PC-9", assetType: "workstation", monitored: true, status: "active", macAddresses: [] },
};
const INFO: Record<string, any> = {
  fw: {
    hardwareSensors: [],
    interfaces: [
      { ifName: "port1", operStatus: "up", ifType: "physical" },
      { ifName: "advpn", operStatus: "up", ifType: "tunnel" },
      { ifName: "to-dc", operStatus: "up", ifType: "tunnel" },
      { ifName: "gre1", operStatus: "up", ifType: "tunnel" },
    ],
    ipsecTunnels: [{ tunnelName: "advpn" }, { tunnelName: "to-dc" }],
  },
  sw: { hardwareSensors: [], interfaces: [] },
  pc: { hardwareSensors: [], interfaces: [] },
};
const IPSEC = {
  pollIntervalSec: 600,
  tunnels: [
    { tunnelName: "advpn", status: "dynamic", parentInterface: "port1", remoteGateway: "0.0.0.0", incomingBytes: 10, outgoingBytes: 20 },
    { tunnelName: "to-dc", status: "down", parentInterface: "port1", remoteGateway: "203.0.113.9", matchedAsset: { id: "sw", hostname: "DC-GATE" } },
  ],
  connections: [
    { name: "advpn_0", kind: "advpn-spoke", status: "up", parentTunnel: "advpn", remoteGateway: "198.51.100.4",
      matchedAsset: { id: "sw", hostname: "SPOKE-7" }, connectedSince: new Date(Date.now() - 2 * 3600e3).toISOString() },
    { name: "fct_0", kind: "remote-access", status: "up", parentTunnel: "advpn", userName: "jdoe", tunnelIp: "10.9.0.2" },
  ],
};
const DEPS: Record<string, any> = {
  sw: {
    asset: { id: "sw", hostname: "IDF-1", assetType: "switch", dependencyLayer: 2, monitored: true, monitorStatus: "up" },
    effectiveParents: [{ parent: { id: "fw", hostname: "HUB-1", assetType: "firewall", dependencyLayer: 1, monitored: true, monitorStatus: "down" }, source: "auto", detectedVia: "controller" }],
    children: [{ id: "ap", hostname: "AP-1", assetType: "access_point", dependencyLayer: 3, monitored: true, monitorStatus: "up",
      childCount: 3, grandchildren: [{ id: "ap2", hostname: "AP-2", assetType: "access_point", dependencyLayer: 4, monitored: false }] }],
  },
  pc: { asset: { id: "pc", hostname: "PC-9", assetType: "workstation" }, effectiveParents: [], children: [] },
};

const ipsec = vi.fn(async () => IPSEC);
const getDependencies = vi.fn(async (id: string) => DEPS[id]);

beforeEach(() => {
  ipsec.mockClear();
  getDependencies.mockClear();
  delete g.PolarisAssetDetail;
  document.body.innerHTML = '<div id="app"></div>';
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.formatBytes = (n: number) => n + " B";
  g.PolarisTabs = { showSnackbar: vi.fn(), attachSwipeToDismiss: vi.fn() };
  g.PolarisCharts = { lineChart: () => "<svg></svg>" };
  g.PolarisMobile = { user: () => ({ permissions: {} }) };
  g.mobileFormatDate = (s: any) => String(s ?? "");
  g.timeAgo = () => "3d ago";
  const known: Record<string, any> = {
    get: async (id: string) => ASSETS[id],
    systemInfo: async (id: string) => INFO[id],
    ipsec,
    getDependencies,
  };
  g.api = { assets: new Proxy(known, { get: (t, k: string) => (k in t ? t[k] : async () => ({})) }) };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
});

const pageEl = () => document.querySelector("#asset-host .asset-page") as HTMLElement;
const text = () => (pageEl()?.textContent || "").replace(/\s+/g, " ");
async function open(id: string) { g.PolarisAssetDetail.open(id); await flush(); }

describe("the View Dependency Tree button", () => {
  it("is the first hero button, above SD-WAN, on every asset", async () => {
    await open("pc");
    const btn = document.getElementById("asset-deptree-btn")!;
    expect(btn).not.toBeNull();
    const sdwan = document.getElementById("asset-sdwan-btn-wrap")!;
    expect(btn.compareDocumentPosition(sdwan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens a page of upstream, this device and downstream, each other device a link", async () => {
    await open("sw");
    document.getElementById("asset-deptree-btn")!.click();
    await flush();
    expect(pageEl().dataset.page).toBe("deptree");
    expect(getDependencies).toHaveBeenCalledWith("sw");
    const t = text();
    expect(t).toContain("Level 2 · directly under HUB-1");
    expect(t.indexOf("Upstream")).toBeLessThan(t.indexOf("This device"));
    expect(t.indexOf("This device")).toBeLessThan(t.indexOf("Downstream"));
    expect(t).toContain("+2 more below");
    const links = Array.from(pageEl().querySelectorAll("[data-open-asset]")).map((a) => a.getAttribute("data-open-asset"));
    expect(links).toEqual(["fw", "ap", "ap2"]);
    // The parent is down, the unmonitored grandchild reads unknown.
    const dots = Array.from(pageEl().querySelectorAll(".leading .dot")).map((d) => d.className);
    expect(dots).toEqual(["dot down", "dot up", "dot up", "dot unk"]);
  });

  it("a tapped name opens that asset a page forward", async () => {
    await open("sw");
    document.getElementById("asset-deptree-btn")!.click();
    await flush();
    (pageEl().querySelector('[data-open-asset="fw"]') as HTMLElement).click();
    await flush();
    expect(document.getElementById("asset-sheet-name")!.textContent).toBe("HUB-1");
  });

  it("says why an endpoint has no tree", async () => {
    await open("pc");
    document.getElementById("asset-deptree-btn")!.click();
    await flush();
    expect(text()).toContain("No upstream device identified");
  });
});

describe("the View IPsec button", () => {
  it("shows above Interfaces on a Fortinet firewall with tunnels, with a summary", async () => {
    await open("fw");
    const wrap = document.getElementById("asset-ipsec-btn-wrap")!;
    expect(wrap.hidden).toBe(false);
    expect(document.getElementById("asset-ipsec-sub")!.textContent).toBe("2 tunnels · 1 down · 1 peer · 1 user");
    const sensors = document.querySelector('.sect-body[data-sect="temperatures"]')!;
    const ifaces = document.querySelector('.asset-sect-header[data-key="interfaces"]')!;
    expect(sensors.compareDocumentPosition(wrap) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(wrap.compareDocumentPosition(ifaces) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is never asked for on a non-firewall", async () => {
    await open("sw");
    expect(ipsec).not.toHaveBeenCalled();
    expect(document.getElementById("asset-ipsec-btn-wrap")!.hidden).toBe(true);
  });

  it("opens tunnels with the template's peers collapsed, then remote access", async () => {
    await open("fw");
    document.getElementById("asset-ipsec-btn")!.click();
    await flush();
    expect(pageEl().dataset.page).toBe("ipsec");
    const t = text();
    expect(t).toContain("Dial-up template · 2 connected");
    expect(t).toContain("Remote access");
    expect(t).toContain("jdoe");
    expect(t).toContain("re-read every 10 min");
    const peer = pageEl().querySelector('.ipsec-peer[data-parent="advpn"]') as HTMLElement;
    expect(peer.style.display).toBe("none");
    (pageEl().querySelector('.ipsec-toggle[data-parent="advpn"]') as HTMLElement).click();
    expect(peer.style.display).toBe("");
    expect(peer.querySelector('[data-open-asset="sw"]')!.textContent).toBe("SPOKE-7");
    // Drawn from the gate's read — no second request.
    expect(ipsec).toHaveBeenCalledTimes(1);
  });
});

describe("the Interfaces list on a firewall with IPsec", () => {
  it("drops IPsec tunnel twins, keeps other tunnels, and points at the IPsec page", async () => {
    await open("fw");
    (document.getElementById("iface-show-all-btn") as HTMLButtonElement).click();
    const host = document.getElementById("asset-interfaces-host")!;
    const names = Array.from(host.querySelectorAll(".iface-row .headline")).map((h) => h.textContent);
    expect(names).toEqual(["gre1", "port1"]);
    expect(host.textContent).toContain("2 IPsec tunnels are on the IPsec page");
    (document.getElementById("iface-ipsec-link") as HTMLElement).click();
    await flush();
    expect(pageEl().dataset.page).toBe("ipsec");
  });
});
