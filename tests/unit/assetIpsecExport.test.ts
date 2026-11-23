/**
 * tests/unit/assetIpsecExport.test.ts — the asset slide-over's IPsec tab
 * Export (public/js/assets-network.js → _openIpsecExportOptions and the pure
 * model / writers behind it).
 *
 * Pins what the dialog promises: every row of the last read is written
 * whatever the table shows; a tunnel's connected sessions are listed only
 * when ticked (collapsed = one row with its session count); remote-access
 * users and the interfaces carrying tunnels are their own sections; CSV keeps
 * every field raw, the PDF prints the tab's columns.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Window } from "happy-dom";
import { loadSharedModules } from "./_sharedModules.js";
import { assetsSource } from "./_assetsSource.js";

loadSharedModules();

const g = globalThis as Record<string, any>;
const assetsLines = assetsSource().split(/\r?\n/);

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
  "_ipsecIsRemoteAccess", "_ipsecUptimeLabel", "_getCollapsedIfaces", "_setCollapsedIfaces",
  "_ipsecExportTemplates", "_ipsecExportModel", "_ipsecExportCellText", "_ipsecExportCsvText",
  "_ipsecExportSaveCsv", "_ipsecExportSavePdf", "_openIpsecExportOptions", "_runIpsecExport",
  "_fmtSpeed", "_assetExportSubject",
];

const ASSET = { id: "HUB", hostname: "HUB1" };
const hour = 3600_000;

function payload() {
  return {
    collectedAt: "2026-11-23T10:00:00.000Z",
    pollIntervalSec: 600,
    tunnels: [
      { tunnelName: "H2H-1", status: "up", remoteGateway: "10.2.1.2", parentInterface: "wan1", overlayIp: "10.10.255.1",
        incomingBytes: 500, outgoingBytes: 50, proxyIdCount: 2, pinned: false, interfacePinned: true,
        matchedAsset: { id: "HUB2", hostname: "HUB2", ipAddress: "10.2.1.2", assetType: "firewall" } },
      { tunnelName: "Overlay-1", status: "dynamic", remoteGateway: "0.0.0.0", parentInterface: "wan1", overlayIp: "10.10.1.1",
        incomingBytes: 9000, outgoingBytes: 10, proxyIdCount: 1, pinned: true, interfacePinned: false, matchedAsset: null },
      { tunnelName: "Overlay-3", status: "down", remoteGateway: "0.0.0.0", parentInterface: "wan2", overlayIp: null,
        incomingBytes: null, outgoingBytes: null, proxyIdCount: null, pinned: false, interfacePinned: false, matchedAsset: null },
    ],
    connections: [
      { name: "Overlay-1_0", kind: "advpn-spoke", parentTunnel: "Overlay-1", peerId: null, userName: null,
        remoteGateway: "10.4.1.2", tunnelIp: "10.254.250.14", status: "up", incomingBytes: 100, outgoingBytes: 1,
        connectedSince: new Date(Date.now() - 5 * hour).toISOString(), firstSeen: "2026-11-20T08:00:00.000Z", lastSeen: "2026-11-23T10:00:00.000Z",
        matchedAsset: { id: "SPK2", hostname: "SPK2", ipAddress: "10.4.1.2", assetType: "firewall" } },
      { name: "Overlay-1_1", kind: "advpn-spoke", parentTunnel: "Overlay-1", peerId: "SPK1-ISP1", userName: null,
        remoteGateway: "10.3.1.2", tunnelIp: "10.254.250.13", status: "up", incomingBytes: 2000, outgoingBytes: 2,
        connectedSince: new Date(Date.now() - 50 * hour).toISOString(), firstSeen: "2026-11-21T08:00:00.000Z", lastSeen: "2026-11-23T10:00:00.000Z",
        matchedAsset: null },
      { name: "RA_0", kind: "remote-access", parentTunnel: "IPsecRA_VPN", peerId: null, userName: "jdoe",
        remoteGateway: "203.0.113.7", tunnelIp: "10.212.134.200", status: "up", incomingBytes: 5, outgoingBytes: 5,
        connectedSince: new Date(Date.now() - hour).toISOString(), firstSeen: "2026-11-23T09:00:00.000Z", lastSeen: "2026-11-23T10:00:00.000Z",
        matchedAsset: null },
      { name: "ssl:1", kind: "ssl-vpn", parentTunnel: null, peerId: null, userName: "asmith, jr",
        remoteGateway: "198.51.100.20", tunnelIp: "10.212.134.201", status: "up", incomingBytes: 7, outgoingBytes: 7,
        connectedSince: new Date(Date.now() - 2 * hour).toISOString(), firstSeen: "2026-11-23T08:00:00.000Z", lastSeen: "2026-11-23T10:00:00.000Z",
        matchedAsset: null },
    ],
  };
}

const IFACES = [
  { ifName: "wan1", alias: "ISP-A", ipAddress: "203.0.113.1", operStatus: "UP", adminStatus: "up", speedBps: 1_000_000_000 },
  { ifName: "wan2", ipAddress: "198.51.100.1", operStatus: "down", adminStatus: "up", speedBps: 100_000_000 },
];

let win: Window;
let doc: Window["document"];
let blobs: string[];
let downloads: string[];
let autoTables: any[];
let saved: string | null;
let toasts: string[];

function setup(): void {
  win = new Window();
  doc = win.document;
  blobs = [];
  downloads = [];
  autoTables = [];
  saved = null;
  toasts = [];
  g.window = win;
  g.document = doc;
  g.localStorage = (win as any).localStorage;
  g.currentUsername = "tester";
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.showToast = (m: string) => { toasts.push(m); };
  g.formatDateTime = (v: unknown) => new Date(v as string).toISOString();
  g._fmtBytes = (b: number | null) => (b == null ? "—" : `${b}B`);
  g._csvRow = (cells: unknown[]) => cells.map((c) => {
    const s = String(c ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",");
  g.openModal = (_title: string, body: string, footer: string) => {
    doc.body.innerHTML = `<div id="modal">${body}<div class="footer">${footer}</div></div>`;
  };
  g.closeModal = () => {};
  g.trackedPdfExport = async (_label: string, fn: (s: AbortSignal) => Promise<void>) => fn(new AbortController().signal);
  g.api = { assets: { systemInfo: vi.fn(async () => ({ interfaces: IFACES })) } };
  g.PolarisPrefs = {
    _s: {} as Record<string, any>,
    load(k: string, u: string) { return this._s[k + u] ?? null; },
    save(k: string, u: string, v: unknown) { this._s[k + u] = v; },
  };
  g.Blob = class { parts: string[]; constructor(parts: string[]) { this.parts = parts; blobs.push(parts.join("")); } };
  URL.createObjectURL = () => "blob:x";
  URL.revokeObjectURL = () => {};
  // happy-dom anchors navigate on click; record the download name instead.
  (win as any).HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  (win as any).jspdf = {
    jsPDF: class {
      internal = { pageSize: { getWidth: () => 792, getHeight: () => 612 }, getNumberOfPages: () => 1 };
      lastAutoTable = { finalY: 100 };
      setFontSize() {} setTextColor() {} text() {} addPage() {} setPage() {}
      autoTable(opts: any) { autoTables.push(opts); }
      save(name: string) { saved = name; }
    },
  };
  for (const v of ["_IPSEC_KIND_LABELS", "_IPSEC_EXPORT_COLUMNS", "_assetIpsecData"]) (0, eval)(varSrc(v));
  for (const f of FNS) (0, eval)(fnSrc(f));
  g._assetIpsecData[ASSET.id] = payload();
}

beforeEach(setup);

const names = (s: any) => s.rows.map((r: any) => (r.group != null ? `# ${r.group}` : r.cells.name ?? r.cells.user));
const ALL = { tunnels: true, remote: true, interfaces: true };

describe("templates offered for expansion", () => {
  it("lists every tunnel with site sessions under it, with its interface and count — never remote-access templates", () => {
    expect(g._ipsecExportTemplates(payload())).toEqual([
      { name: "Overlay-1", sessions: 2, iface: "wan1", status: "dynamic", orphan: false },
    ]);
  });

  it("still offers sessions whose tunnel was not in the read", () => {
    const p = payload();
    p.connections.push({ ...p.connections[0], name: "Lost_0", parentTunnel: "Gone" });
    expect(g._ipsecExportTemplates(p).map((t: any) => [t.name, t.orphan])).toEqual([["Overlay-1", false], ["Gone", true]]);
  });
});

describe("tunnels section — collapsed and expanded", () => {
  it("collapsed: one row per tunnel, the template carrying its session count", () => {
    const [s] = g._ipsecExportModel(payload(), { tunnels: true, expand: {} }, []);
    expect(names(s)).toEqual(["H2H-1", "Overlay-1", "Overlay-3"]);
    expect(s.rows[1].cells.sessions).toBe(2);
    expect(s.rows[0].cells.sessions).toBeNull(); // site-to-site, nothing under it
  });

  it("expanded: the sessions follow their tunnel, with parent, interface, peer ID and device", () => {
    const [s] = g._ipsecExportModel(payload(), { tunnels: true, expand: { "Overlay-1": true } }, []);
    expect(names(s)).toEqual(["H2H-1", "Overlay-1", "Overlay-1_0", "Overlay-1_1", "Overlay-3"]);
    const spoke = s.rows[3];
    expect(spoke.depth).toBe(1);
    expect(spoke.cells).toMatchObject({
      type: "ADVPN spoke", parent: "Overlay-1", iface: "wan1", peerId: "SPK1-ISP1",
      gw: "10.3.1.2", tunnelIp: "10.254.250.13", firstSeen: "2026-11-21T08:00:00.000Z",
    });
    expect(s.rows[2].cells).toMatchObject({ device: "SPK2", deviceIp: "10.4.1.2" });
  });

  it("drops 0.0.0.0 gateways and carries the pin and selector count", () => {
    const [s] = g._ipsecExportModel(payload(), { tunnels: true }, []);
    expect(s.rows[1].cells).toMatchObject({ gw: "", poll: "yes", selectors: 1, type: "Dial-up template" });
    expect(s.rows[0].cells).toMatchObject({ poll: "yes", device: "HUB2" }); // interface-twin pin counts
  });

  it("puts orphaned sessions under a group row, listed only when ticked", () => {
    const p = payload();
    p.connections.push({ ...p.connections[0], name: "Lost_0", parentTunnel: "Gone" });
    const [collapsed] = g._ipsecExportModel(p, { tunnels: true, expand: {} }, []);
    expect(names(collapsed).at(-1)).toMatch(/^# Gone — tunnel not in the last read · 1 session$/);
    const [open] = g._ipsecExportModel(p, { tunnels: true, expand: { Gone: true } }, []);
    expect(names(open).slice(-2)).toEqual([expect.stringMatching(/^# Gone/), "Lost_0"]);
  });
});

describe("remote access and interfaces sections", () => {
  it("lists every remote user, sorted, with the session's fields", () => {
    const s = g._ipsecExportModel(payload(), { remote: true }, [])[0];
    expect(s.title).toBe("Remote access sessions");
    expect(names(s)).toEqual(["asmith, jr", "jdoe"]);
    expect(s.rows[1].cells).toMatchObject({ type: "FortiClient (IPsec)", tunnel: "IPsecRA_VPN", tunnelIp: "10.212.134.200", session: "RA_0" });
  });

  it("groups tunnels under the interface they ride, named with its address, status and speed", () => {
    const s = g._ipsecExportModel(payload(), { interfaces: true }, IFACES)[0];
    expect(names(s)).toEqual([
      "# wan1 (ISP-A) · 203.0.113.1 · up · 1 Gbps · 2 tunnels", "H2H-1", "Overlay-1",
      "# wan2 · 198.51.100.1 · down · 100 Mbps · 1 tunnel", "Overlay-3",
    ]);
    expect(s.rows[2].cells).toMatchObject({ iface: "wan1", ifaceIp: "203.0.113.1", ifaceStatus: "up", ifaceSpeed: 1e9, sessions: 2 });
  });

  it("still lists the interfaces when system info is unavailable", () => {
    const s = g._ipsecExportModel(payload(), { interfaces: true }, [])[0];
    expect(names(s)[0]).toBe("# wan1 · 2 tunnels");
  });

  it("emits sections in a fixed order, only those chosen", () => {
    expect(g._ipsecExportModel(payload(), ALL, []).map((s: any) => s.key)).toEqual(["tunnels", "remote", "interfaces"]);
    expect(g._ipsecExportModel(payload(), { remote: true }, []).map((s: any) => s.key)).toEqual(["remote"]);
  });
});

describe("writers", () => {
  it("CSV: section blocks, every column, raw byte counts, quoted commas, no group rows", () => {
    const sections = g._ipsecExportModel(payload(), { ...ALL, expand: { "Overlay-1": true } }, IFACES);
    const csv: string = g._ipsecExportCsvText(sections, { subject: "HUB1", collectedAt: null, generatedAt: "2026-11-23T10:00:00.000Z" });
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe("Last read,never");
    expect(lines).toContain("Tunnels & ADVPN sessions");
    expect(lines).toContain(g._IPSEC_EXPORT_COLUMNS.tunnels.map((c: any) => c.label).join(","));
    expect(lines.find((l) => l.startsWith("Overlay-1_1,"))).toContain(",2000,2,");
    expect(lines.find((l) => l.startsWith("Overlay-1_1,"))).toContain("2026-11-21T08:00:00.000Z");
    expect(lines.some((l) => /^"asmith, jr",FortiClient \(SSL-VPN\),/.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith("wan1,203.0.113.1,up,1000000000,H2H-1,"))).toBe(true);
    expect(csv).not.toContain("tunnels ·"); // group rows stay out of the CSV
  });

  it("PDF: the tab's columns only, sessions indented, interface groups spanning the row", () => {
    const sections = g._ipsecExportModel(payload(), { ...ALL, expand: { "Overlay-1": true } }, IFACES);
    g._ipsecExportSavePdf(sections, { subject: "HUB1", collectedAt: null, generatedAt: "2026-11-23T10:00:00.000Z", counts: "", fileBase: "f" });
    expect(saved).toBe("f.pdf");
    expect(autoTables).toHaveLength(3);
    const tunHead = autoTables[0].head[0];
    expect(tunHead).toContain("Peer ID");
    expect(tunHead).not.toContain("First seen");
    expect(tunHead).not.toContain("Poll 1m");
    const spoke = autoTables[0].body[2];
    expect(spoke[0].content).toBe("Overlay-1_0");
    expect(spoke[0].styles.cellPadding.left).toBeGreaterThan(3);
    const grp = autoTables[2].body[0][0];
    expect(grp.colSpan).toBe(autoTables[2].head[0].length);
    expect(grp.content).toMatch(/^wan1/);
  });
});

describe("dialog", () => {
  const tick = (sel: string, v: boolean) => { (doc.querySelector(sel) as any).checked = v; };
  const clickEl = (sel: string) => (doc.querySelector(sel) as any).dispatchEvent(new (win as any).Event("click", { bubbles: true }));
  const settle = () => new Promise((r) => setTimeout(r, 5));

  it("lists the ADVPN templates, ticked as the tab shows them", () => {
    g._openIpsecExportOptions(ASSET);
    const tpl = doc.querySelector('.ipsec-exp-tpl[data-name="Overlay-1"]') as any;
    expect(tpl).not.toBeNull();
    expect(tpl.checked).toBe(false); // collapsed on screen by default
    g._setCollapsedIfaces(ASSET.id, new Set(["Overlay-1"]), "ipsec-open");
    g._openIpsecExportOptions(ASSET);
    expect((doc.querySelector('.ipsec-exp-tpl[data-name="Overlay-1"]') as any).checked).toBe(true);
  });

  it("exports a CSV with the chosen sections and expanded sessions, and remembers the format", async () => {
    g._openIpsecExportOptions(ASSET);
    tick('input[name="ipsec-exp-fmt"][value="csv"]', true);
    tick('input[name="ipsec-exp-fmt"][value="pdf"]', false);
    tick('.ipsec-exp-sec[data-key="remote"]', false);
    clickEl("#ipsec-exp-all");
    clickEl("#btn-ipsec-export");
    await settle();
    expect(downloads).toEqual([expect.stringMatching(/^polaris-ipsec-HUB1-\d{4}-\d{2}-\d{2}\.csv$/)]);
    const csv = blobs[0];
    expect(csv).toContain("Overlay-1_1,");
    expect(csv).not.toContain("Remote access sessions");
    expect(csv).toContain("Interfaces carrying IPsec tunnels");
    expect(g.api.assets.systemInfo).toHaveBeenCalledWith("HUB");
    expect(g.PolarisPrefs.load("asset-ipsec-export", "tester")).toMatchObject({ format: "csv", sections: { remote: false } });
  });

  it("refuses to export with no section ticked", async () => {
    g._openIpsecExportOptions(ASSET);
    for (const k of ["tunnels", "remote", "interfaces"]) tick(`.ipsec-exp-sec[data-key="${k}"]`, false);
    clickEl("#btn-ipsec-export");
    await settle();
    expect(downloads).toEqual([]);
    expect(saved).toBeNull();
    expect(toasts).toContain("Select at least one section");
  });

  it("skips the system-info read when interfaces are not exported", async () => {
    g._openIpsecExportOptions(ASSET);
    tick('.ipsec-exp-sec[data-key="interfaces"]', false);
    clickEl("#btn-ipsec-export");
    await settle();
    expect(saved).toMatch(/\.pdf$/);
    expect(g.api.assets.systemInfo).not.toHaveBeenCalled();
  });
});
