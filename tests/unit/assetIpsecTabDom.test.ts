/**
 * tests/unit/assetIpsecTabDom.test.ts — the asset slide-over's IPsec tab
 * (`_renderAssetIpsec` in public/js/assets.js) against the real TableSF.
 *
 * Pins what the tab owns now that the System tab no longer lists IPsec
 * tunnels: the tunnel → peer tree, per-column sort + filter (flat while
 * either is active, the Interfaces table's two-mode render), the Poll 1m pin
 * (checked by either pin, clearing BOTH), and the tunnel link to its history.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, any>;
const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);
const tableSfSrc = readFileSync(resolve(__dirname, "../../public/js/table-sf.js"), "utf8");

function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  return assetsLines.slice(start, end + 1).join("\n");
}
function varSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`var ${name} =`));
  if (start < 0) throw new Error(`assets.js: var ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i >= start && /;\s*$/.test(l));
  return assetsLines.slice(start, end + 1).join("\n");
}

const FNS = [
  "_ipsecIsRemoteAccess", "_ipsecUptimeLabel", "_ipsecStatusPill", "_setIpsecTunnelPin",
  "_reloadAssetIpsec", "_renderAssetIpsec", "_treeElbow", "_distinctSorted",
];

const ASSET_ID = "HUB";
const hour = 3600_000;

function payload() {
  return {
    collectedAt: new Date().toISOString(),
    pollIntervalSec: 600,
    tunnels: [
      { tunnelName: "H2H-1", status: "up", remoteGateway: "10.2.1.2", parentInterface: "wan1", overlayIp: "10.10.255.1",
        incomingBytes: 500, outgoingBytes: 50, pinned: false, interfacePinned: true,
        matchedAsset: { id: "HUB2", hostname: "HUB2", ipAddress: null, assetType: "firewall" } },
      { tunnelName: "Overlay-1", status: "dynamic", remoteGateway: "0.0.0.0", parentInterface: "wan1", overlayIp: "10.10.1.1",
        incomingBytes: 9000, outgoingBytes: 10, pinned: true, interfacePinned: false },
      { tunnelName: "Overlay-3", status: "down", remoteGateway: "0.0.0.0", parentInterface: "wan2", overlayIp: null,
        incomingBytes: null, outgoingBytes: null, pinned: false, interfacePinned: false },
    ],
    connections: [
      { name: "Overlay-1_0", kind: "advpn-spoke", parentTunnel: "Overlay-1", peerId: null, userName: null,
        remoteGateway: "10.4.1.2", tunnelIp: "10.254.250.14", status: "up", incomingBytes: 100, outgoingBytes: 1,
        connectedSince: new Date(Date.now() - 5 * hour).toISOString(), matchedAsset: { id: "SPK2", hostname: "SPK2", ipAddress: null, assetType: "firewall" } },
      { name: "Overlay-1_1", kind: "advpn-spoke", parentTunnel: "Overlay-1", peerId: "SPK1-ISP1", userName: null,
        remoteGateway: "10.3.1.2", tunnelIp: "10.254.250.13", status: "up", incomingBytes: 2000, outgoingBytes: 2,
        connectedSince: new Date(Date.now() - 50 * hour).toISOString(), matchedAsset: null },
      { name: "RA_0", kind: "remote-access", parentTunnel: "IPsecRA_VPN", peerId: null, userName: "jdoe",
        remoteGateway: "203.0.113.7", tunnelIp: "10.212.134.200", status: "up", incomingBytes: 5, outgoingBytes: 5,
        connectedSince: new Date(Date.now() - hour).toISOString(), matchedAsset: null },
      { name: "ssl:1", kind: "ssl-vpn", parentTunnel: null, peerId: null, userName: "asmith",
        remoteGateway: "198.51.100.20", tunnelIp: "10.212.134.201", status: "up", incomingBytes: 7, outgoingBytes: 7,
        connectedSince: new Date(Date.now() - 2 * hour).toISOString(), matchedAsset: null },
    ],
  };
}

let win: Window;
let doc: Window["document"];
let putCalls: Record<string, any>[];
let serverAsset: Record<string, any>;
let opened: string | null;
let openedAsset: string | null;

function setup(): void {
  win = new Window();
  doc = win.document;
  putCalls = [];
  opened = null;
  openedAsset = null;
  serverAsset = { id: ASSET_ID, monitoredIpsecTunnels: ["Overlay-1"], monitoredInterfaces: ["port1", "H2H-1"] };
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
  g._fmtBytes = (b: number | null) => (b == null ? "—" : `${b}B`);
  g._currentStateStripHTML = () => '<div class="strip"></div>';
  g._cadenceChipHTML = () => "";
  g._wireCurrentStateRefresh = () => {};
  g._screenshotTableEl = () => {};
  g.applyTableLayout = undefined;
  g.openIpsecTunnelDetailPanel = (_a: unknown, n: string) => { opened = n; };
  g.openViewModal = (id: string) => { openedAsset = id; };
  g.api = {
    assets: {
      get: vi.fn(async () => JSON.parse(JSON.stringify(serverAsset))),
      update: vi.fn(async (_id: string, body: Record<string, any>) => {
        putCalls.push(body);
        Object.assign(serverAsset, body);
        return {};
      }),
      ipsec: vi.fn(async () => payload()),
    },
  };
  (0, eval)(tableSfSrc);
  g.PolarisPrefs = (win as any).PolarisPrefs;
  for (const v of ["_IPSEC_KIND_LABELS", "_assetIpsecAsset"]) (0, eval)(varSrc(v));
  for (const f of FNS) (0, eval)(fnSrc(f));
}

function render(): void {
  doc.body.innerHTML = `<div id="asset-ipsec-mount-${ASSET_ID}"></div>`;
  g._renderAssetIpsec(ASSET_ID, payload(), { id: ASSET_ID });
}

const tunRows = () => Array.from(doc.querySelectorAll(`#ipsec-tunnels-tbody-${ASSET_ID} > tr`));
/** The row's name, without the elbow and the kind sub-line under it. */
const firstCellText = (tr: Element) => {
  const td = tr.querySelectorAll(":scope > td")[1];
  if (!td) return "";
  const c = td.cloneNode(true) as Element;
  c.querySelectorAll("div, span[aria-hidden]").forEach((n) => n.remove());
  return c.textContent!.replace(/[├└─]/g, "").trim();
};
const tunNames = () => tunRows().map(firstCellText).filter(Boolean);
const userNames = () => Array.from(doc.querySelectorAll(`#ipsec-users-tbody-${ASSET_ID} > tr`))
  .map((tr) => tr.querySelector("td")!.textContent!.trim());
const click = (el: any) => el.dispatchEvent(new (win as any).Event("click", { bubbles: true, cancelable: true }));
const change = (el: any) => el.dispatchEvent(new (win as any).Event("change", { bubbles: true }));
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const sortBy = (key: string) => click(doc.querySelector(`#ipsec-tunnels-table-${ASSET_ID} th[data-sf-key="${key}"] .sf-header`));
async function typeFilter(table: string, key: string, value: string): Promise<void> {
  const inp: any = doc.querySelector(`#${table}-${ASSET_ID} th[data-sf-key="${key}"] input.sf-filter`);
  inp.value = value;
  inp.dispatchEvent(new (win as any).Event("input", { bubbles: true }));
  await settle(260);
}

beforeEach(() => { setup(); render(); });

describe("tunnel table — default view", () => {
  it("nests each site peer under its tunnel, with remote users kept out of it", () => {
    expect(tunNames()).toEqual(["H2H-1", "Overlay-1", "Overlay-1_0", "Overlay-1_1", "Overlay-3"]);
    expect(tunRows()[2].textContent).toContain("├─");
    expect(tunRows()[3].textContent).toContain("└─");
    expect(userNames()).toEqual(["asmith", "jdoe"]);
  });

  it("shows the tunnel interface's own address under the interface it rides", () => {
    expect(tunRows()[0].textContent).toContain("10.10.255.1");
  });

  it("puts a pin on tunnels only — peers come and go", () => {
    expect(doc.querySelectorAll(".asset-ipsec-pin")).toHaveLength(3);
    expect(tunRows()[2].querySelector(".asset-ipsec-pin")).toBeNull();
  });

  it("checks the pin when EITHER the tunnel or its interface twin is polled", () => {
    const box = (n: string) => doc.querySelector(`.asset-ipsec-pin[data-name="${n}"]`) as any;
    expect(box("H2H-1").checked).toBe(true);       // interface twin only
    expect(box("Overlay-1").checked).toBe(true);   // IPsec pin
    expect(box("Overlay-3").checked).toBe(false);
  });
});

describe("sorting and filtering", () => {
  it("flattens on sort and orders by the counter", () => {
    sortBy("in");
    expect(tunNames().slice(0, 4)).toEqual(["Overlay-1_0", "H2H-1", "Overlay-1_1", "Overlay-1"]);
    expect(doc.body.textContent).not.toContain("├─");
    // A flat peer has no parent row above it, so its second line names it.
    expect(tunRows()[0].textContent).toContain("via Overlay-1");
  });

  it("filters by name, kind or the peer's IKE id", async () => {
    await typeFilter("ipsec-tunnels-table", "name", "SPK1-ISP1");
    expect(tunNames()).toEqual(["Overlay-1_1"]);
    await typeFilter("ipsec-tunnels-table", "name", "spoke");
    expect(tunNames()).toEqual(["Overlay-1_0", "Overlay-1_1"]);
  });

  it("filters by the matched device", async () => {
    await typeFilter("ipsec-tunnels-table", "device", "spk2");
    expect(tunNames()).toEqual(["Overlay-1_0"]);
  });

  it("offers only the statuses this gate reports", () => {
    const opts = Array.from(doc.querySelectorAll(`#ipsec-tunnels-table-${ASSET_ID} th[data-sf-key="status"] .sf-multi-option`))
      .map((l) => l.textContent!.trim());
    expect(opts).toEqual(["down", "dynamic", "up"]);
  });

  it("says so when nothing matches", async () => {
    await typeFilter("ipsec-tunnels-table", "name", "no-such-tunnel");
    expect(doc.getElementById(`ipsec-tunnels-tbody-${ASSET_ID}`)!.textContent).toMatch(/No tunnels or peers match/);
  });

  it("persists the state per user and restores it on the next render", async () => {
    sortBy("in");
    render();
    expect(tunNames()[0]).toBe("Overlay-1_0");
  });

  it("sorts and filters the remote-access table on its own", async () => {
    await typeFilter("ipsec-users-table", "user", "jdo");
    expect(userNames()).toEqual(["jdoe"]);
    expect(tunNames()).toHaveLength(5);
  });
});

describe("Poll 1m pin", () => {
  it("checking adds the IPsec pin from a FRESH read of the asset", async () => {
    const box: any = doc.querySelector('.asset-ipsec-pin[data-name="Overlay-3"]');
    box.checked = true;
    change(box);
    await settle();
    expect(g.api.assets.get).toHaveBeenCalled();
    expect(putCalls.at(-1)).toEqual({ monitoredIpsecTunnels: ["Overlay-1", "Overlay-3"] });
  });

  it("clearing removes the interface twin's pin too, and leaves other interface pins alone", async () => {
    const box: any = doc.querySelector('.asset-ipsec-pin[data-name="H2H-1"]');
    box.checked = false;
    change(box);
    await settle();
    expect(putCalls.at(-1)).toEqual({ monitoredIpsecTunnels: ["Overlay-1"], monitoredInterfaces: ["port1"] });
  });

  it("survives a sort — the handler is delegated", async () => {
    sortBy("name");
    const box: any = doc.querySelector('.asset-ipsec-pin[data-name="Overlay-1"]');
    box.checked = false;
    change(box);
    await settle();
    expect(putCalls.at(-1)).toEqual({ monitoredIpsecTunnels: [] });
  });
});

describe("links", () => {
  it("opens the tunnel's history from its name, after a re-render too", () => {
    sortBy("name");
    click(doc.querySelector('.asset-ipsec-link[data-name="Overlay-1"]'));
    expect(opened).toBe("Overlay-1");
  });

  it("links a site-to-site tunnel to the device at its far end", () => {
    click(doc.querySelector('.asset-link[data-asset-id="HUB2"]'));
    expect(openedAsset).toBe("HUB2");
  });

  it("opens the peer's asset", () => {
    sortBy("in");
    click(doc.querySelector('.asset-link[data-asset-id="SPK2"]'));
    expect(openedAsset).toBe("SPK2");
  });
});
