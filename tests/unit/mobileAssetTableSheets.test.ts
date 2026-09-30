/**
 * tests/unit/mobileAssetTableSheets.test.ts — the phone's current-state table
 * buttons on the asset sheet: "View ARP Table" on a firewall, "View MAC Table"
 * on a switch, "View Wireless" on a monitored access point.
 *
 * Pinned here:
 *
 *   • WHICH DEVICE GETS WHICH BUTTON. The classes are the desktop's — the
 *     ARP Table tab is every firewall, MAC Table every switch, Wireless a
 *     MONITORED access point — so the two surfaces never disagree about
 *     whether a device has the table.
 *
 *   • EACH SHEET READS ITS OWN ENDPOINT and draws it grouped the desktop's
 *     way: ARP by interface, MAC by port (trunk pseudo-ports hidden until
 *     asked for), Wireless as radio → SSID → client.
 *
 *   • A MATCHED DEVICE OPENS THAT ASSET — the pivot the desktop tables offer.
 *
 * asset-detail.js is executed as-is (the mobile SPA is plain script tags), so
 * the wiring under test is the wiring that ships.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "asset-detail.js"), "utf-8");

const g = globalThis as any;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

const ASSETS: Record<string, any> = {
  fw:  { id: "fw",  hostname: "GATE-1",   assetType: "firewall",     monitored: false, status: "active", macAddresses: [] },
  sw:  { id: "sw",  hostname: "SWITCH-1", assetType: "switch",       monitored: true,  status: "active", macAddresses: [] },
  ap:  { id: "ap",  hostname: "AP-1",     assetType: "access_point", monitored: true,  status: "active", macAddresses: [] },
  ap0: { id: "ap0", hostname: "AP-2",     assetType: "access_point", monitored: false, status: "active", macAddresses: [] },
  srv: { id: "srv", hostname: "SERVER-1", assetType: "server",       monitored: true,  status: "active", macAddresses: [] },
  pc:  { id: "pc",  hostname: "PRINTER-4", assetType: "printer",     monitored: false, status: "active", macAddresses: [] },
};

const arpTable = vi.fn(async (_id: string, range?: string) => ({
  entries: [
    { ipAddress: "10.4.12.63", macAddress: "aa:bb:cc:00:00:01", ifName: "port2", ageSec: 45, lastSeen: new Date().toISOString(),
      matchedAsset: { id: "pc", hostname: "PRINTER-4" } },
    { ipAddress: "10.4.12.7",  macAddress: "aa:bb:cc:00:00:02", ifName: "port1", ageSec: 3700, lastSeen: new Date().toISOString(), matchedAsset: null },
  ],
  collectedAt: new Date().toISOString(),
  pollIntervalSec: 600,
  retentionDays: 7,
  range: range || "current",
}));

const macTable = vi.fn(async () => ({
  entries: [
    { macAddress: "aa:bb:cc:00:00:01", vlanId: 10, ifName: "port7",  basePort: 7, status: "learned", matchedAsset: { id: "pc", hostname: "PRINTER-4" } },
    { macAddress: "aa:bb:cc:00:00:03", vlanId: 10, ifName: "port32", basePort: 32, status: "learned", matchedAsset: null },
    { macAddress: "aa:bb:cc:00:00:04", vlanId: 10, ifName: "port32", basePort: 32, status: "learned", matchedAsset: null },
    { macAddress: "aa:bb:cc:00:00:05", vlanId: 1,  ifName: null,     basePort: 32768, status: "learned", matchedAsset: null },
  ],
  collectedAt: new Date().toISOString(),
  pollIntervalSec: 300,
}));

const systemInfo = vi.fn(async () => ({
  interfaces: [],
  hardwareSensors: [],
  lastSystemInfoAt: new Date().toISOString(),
  apRadios: [
    { radioIndex: 1, band: "5GHz", channel: 36, bandwidthMhz: 80,
      vaps: [{ ssid: "CORP", vapName: "corp-vap", bssid: "11:22:33:44:55:66", vlanId: 20 }] },
  ],
  wirelessStations: [
    { staMacAddr: "de:ad:be:ef:00:01", staIpAddr: "10.9.0.5", bssid: "11:22:33:44:55:66", ssid: "CORP", radioId: 1, band: "5GHz", signalStrength: -61,
      matchedAsset: { id: "pc", hostname: "PRINTER-4" } },
    { staMacAddr: "de:ad:be:ef:00:02", staIpAddr: null, bssid: "99:99:99:99:99:99", ssid: "GUEST", radioId: 2, band: "2.4GHz", signalStrength: -70, matchedAsset: null },
  ],
}));

function boot() {
  document.body.innerHTML = '<div id="app"></div>';
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.PolarisTabs = { showSnackbar: vi.fn(), attachSwipeToDismiss: vi.fn() };
  g.PolarisCharts = { lineChart: () => "" };
  g.PolarisMobile = { user: () => ({ permissions: { assets: "read" } }) };
  g.mobileFormatDate = (s: any) => String(s ?? "");
  g.timeAgo = () => "1m ago";
  // Every endpoint the sheet fires that this test does not care about
  // resolves empty; the three table endpoints and get() are real stubs.
  const known: Record<string, any> = {
    get: async (id: string) => ASSETS[id],
    arpTable, macTable, systemInfo,
  };
  g.api = {
    assets: new Proxy(known, {
      get: (t, k: string) => (k in t ? t[k] : async () => ({})),
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
}

async function openAsset(id: string) {
  g.PolarisAssetDetail.open(id);
  await flush();
}

const btn = (key: string) => document.getElementById("asset-" + key + "-btn") as HTMLButtonElement | null;
const tableSheet = () => document.getElementById("table-sheet");
const sheetText = () => (tableSheet()?.textContent || "").replace(/\s+/g, " ");

beforeEach(() => {
  arpTable.mockClear();
  macTable.mockClear();
  systemInfo.mockClear();
  delete g.PolarisAssetDetail;
  boot();
});

describe("which device gets which table button", () => {
  it.each([
    ["fw",  ["arp"]],
    ["sw",  ["mac"]],
    ["ap",  ["wireless"]],
    ["ap0", []],          // an unmonitored AP has no Wireless tab on desktop either
    ["srv", []],
  ])("%s → %j", async (id, want) => {
    await openAsset(id);
    const have = ["arp", "mac", "wireless"].filter((k) => !!btn(k));
    expect(have).toEqual(want);
  });

  it("the table buttons sit below the SD-WAN button", async () => {
    await openAsset("fw");
    const sdwan = document.getElementById("asset-sdwan-btn-wrap")!;
    const arp = btn("arp")!;
    expect(sdwan.compareDocumentPosition(arp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("ARP Table sheet", () => {
  it("reads the arp-table endpoint on Current and groups by interface", async () => {
    await openAsset("fw");
    btn("arp")!.click();
    await flush();
    expect(arpTable).toHaveBeenCalledWith("fw", "current");
    const heads = Array.from(document.querySelectorAll("#table-sheet .tbl-group-head .mono")).map((e) => e.textContent);
    expect(heads).toEqual(["port1", "port2"]);   // natural order
    expect(sheetText()).toContain("10.4.12.63");
    expect(sheetText()).toContain("1h 01m");
  });

  it("changing the range re-fetches that window", async () => {
    await openAsset("fw");
    btn("arp")!.click();
    await flush();
    const sel = document.getElementById("arp-range-select") as HTMLSelectElement;
    sel.value = "24h";
    sel.dispatchEvent(new Event("change"));
    await flush();
    expect(arpTable).toHaveBeenLastCalledWith("fw", "24h");
  });

  it("disables ranges past retention", async () => {
    await openAsset("fw");
    btn("arp")!.click();
    await flush();
    const opt = document.querySelector('#arp-range-select option[value="30d"]') as HTMLOptionElement;
    expect(opt.disabled).toBe(true);
  });

  it("a matched device opens that asset and closes the table sheet", async () => {
    await openAsset("fw");
    btn("arp")!.click();
    await flush();
    (document.querySelector('#table-sheet [data-open-asset="pc"]') as HTMLElement).click();
    await flush();
    expect(tableSheet()).toBeNull();
    expect(document.getElementById("asset-sheet-name")!.textContent).toBe("PRINTER-4");
  });
});

describe("MAC Table sheet", () => {
  it("groups by port, reads uplink vs access, hides trunk pseudo-ports until shown", async () => {
    await openAsset("sw");
    btn("mac")!.click();
    await flush();
    expect(macTable).toHaveBeenCalledWith("sw");
    expect(sheetText()).toContain("port7");
    expect(sheetText()).toContain("access port");
    expect(sheetText()).toContain("uplink / trunk");
    expect(sheetText()).not.toContain("aa:bb:cc:00:00:05");
    (document.getElementById("mac-unattributed-toggle") as HTMLElement).click();
    expect(sheetText()).toContain("aa:bb:cc:00:00:05");
  });
});

describe("Wireless sheet", () => {
  it("reuses the system-info snapshot and files clients under their SSID", async () => {
    await openAsset("ap");
    const calls = systemInfo.mock.calls.length;
    btn("wireless")!.click();
    await flush();
    expect(systemInfo.mock.calls.length).toBe(calls);   // no second fetch on open
    expect(sheetText()).toContain("Radio 1");
    expect(sheetText()).toContain("CORP");
    expect(sheetText()).toContain("de:ad:be:ef:00:01");
    // The GUEST client matches no broadcast SSID — shown, not dropped.
    expect(sheetText()).toContain("Not matched to an SSID");
    expect(sheetText()).toContain("de:ad:be:ef:00:02");
  });

  it("Reload fetches a fresh snapshot", async () => {
    await openAsset("ap");
    btn("wireless")!.click();
    await flush();
    const calls = systemInfo.mock.calls.length;
    (document.getElementById("table-sheet-reload") as HTMLElement).click();
    await flush();
    expect(systemInfo.mock.calls.length).toBe(calls + 1);
  });
});
