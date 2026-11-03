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
  vlanNames: { "10": "Users_VL10" },
  portVlans: {
    port7:  { nativeVlan: 10, taggedVlans: [], trunksAllVlans: false },
    port32: { nativeVlan: 1, taggedVlans: [10, 20], trunksAllVlans: false },
  },
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

// A FortiGate's managed children. childCounts decides whether the gate's
// Wireless / MAC Table buttons show at all; null = the gate manages nothing.
let childCountsResult: any = null;
const childCounts = vi.fn(async () => childCountsResult);
const childWireless = vi.fn(async () => ({
  accessPoints: [
    { id: "ap", hostname: "AP-1", ipAddress: "10.90.2.48", model: "FortiAP-23JF", monitored: true, lastSystemInfoAt: new Date().toISOString() },
    { id: "ap9", hostname: "AP-9", ipAddress: "10.90.2.62", model: "FortiAP-231G", monitored: true, lastSystemInfoAt: null },
  ],
  stations: [
    { apAssetId: "ap", staMacAddr: "02:5A:A0:12:00:01", staIpAddr: "10.41.30.105", ssid: "CORP", band: "5GHz", signalStrength: -61,
      matchedAsset: { id: "pc", hostname: "PRINTER-4" } },
    { apAssetId: "ap", staMacAddr: "02:5A:BA:01:00:00", staIpAddr: "10.41.40.66", ssid: "GUEST", band: "2.4GHz", signalStrength: -70, matchedAsset: null },
  ],
}));
const childMacTable = vi.fn(async () => ({
  switches: [
    { id: "sw", hostname: "SWITCH-1", ipAddress: "10.90.1.11", model: "FortiSwitch-248E", monitored: true, lastSystemInfoAt: new Date().toISOString() },
    { id: "sw2", hostname: "SWITCH-2", ipAddress: "10.90.1.12", model: "FortiSwitch-108E", monitored: false, lastSystemInfoAt: null },
  ],
  entries: [
    { switchAssetId: "sw", macAddress: "02:5A:EE:00:00:07", vlanId: 30, ifName: "port1", basePort: 1, status: "learned", matchedAsset: { id: "pc", hostname: "PRINTER-4" } },
    { switchAssetId: "sw", macAddress: "02:5A:EE:00:00:08", vlanId: null, ifName: "port3", basePort: 3, status: "learned", matchedAsset: null },
    { switchAssetId: "sw", macAddress: "02:5A:C0:00:00:01", vlanId: 30, ifName: null, basePort: 32768, status: "learned", matchedAsset: null },
  ],
  vlanNames: { "30": "Users_VL30" },
  portVlans: { sw: { port3: { nativeVlan: 30, taggedVlans: [40], trunksAllVlans: false } } },
}));

// The filter boxes debounce 150 ms.
async function typeFilter(id: string, text: string) {
  const box = document.getElementById(id) as HTMLInputElement;
  box.value = text;
  box.dispatchEvent(new Event("input"));
  await new Promise((r) => setTimeout(r, 200));
}

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
    arpTable, macTable, systemInfo, childCounts, childWireless, childMacTable,
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
// The tables are pages of the asset sheet now: the page's own element.
const tableSheet = () => document.querySelector("#asset-host .asset-page") as HTMLElement | null;
const sheetText = () => (tableSheet()?.textContent || "").replace(/\s+/g, " ");

beforeEach(() => {
  arpTable.mockClear();
  macTable.mockClear();
  systemInfo.mockClear();
  childCounts.mockClear();
  childWireless.mockClear();
  childMacTable.mockClear();
  childCountsResult = null;
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
    const heads = Array.from(document.querySelectorAll("#asset-host .asset-page .tbl-group-head .mono")).map((e) => e.textContent);
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

  it("a matched device opens that asset a page forward; Back returns to the table", async () => {
    await openAsset("fw");
    btn("arp")!.click();
    await flush();
    (document.querySelector('#asset-host [data-open-asset="pc"]') as HTMLElement).click();
    await flush();
    expect(tableSheet()).toBeNull();
    expect(document.getElementById("asset-sheet-name")!.textContent).toBe("PRINTER-4");
    (document.getElementById("asset-sheet-back") as HTMLButtonElement).click();
    await flush();
    expect(tableSheet()!.dataset.page).toBe("arp");
    expect(document.getElementById("asset-sheet-page-title")!.textContent).toBe("ARP Table");
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
    // Each port's configured VLANs lead its group.
    expect(sheetText()).toContain("Native Users_VL10");
    expect(sheetText()).toContain("Native VLAN 1 · Tagged Users_VL10, VLAN 20");
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
    (document.getElementById("asset-sheet-refresh") as HTMLElement).click();   // the header's Refresh
    await flush();
    expect(systemInfo.mock.calls.length).toBe(calls + 1);
  });
});

describe("Wireless sheet filter box", () => {
  it("narrows the tree to matching clients, MAC fragments with or without separators", async () => {
    await openAsset("ap");
    btn("wireless")!.click();
    await flush();
    await typeFilter("wireless-filter", "beef0001");
    expect(sheetText()).toContain("de:ad:be:ef:00:01");
    expect(sheetText()).not.toContain("de:ad:be:ef:00:02");
    expect(sheetText()).toContain("Radio 1");
    await typeFilter("wireless-filter", "10.9.0");
    expect(sheetText()).toContain("de:ad:be:ef:00:01");
    await typeFilter("wireless-filter", "zzzz");
    expect(sheetText()).toContain("No radios, SSIDs or clients match that filter.");
  });

  it("an SSID that matches keeps its whole subtree", async () => {
    await openAsset("ap");
    btn("wireless")!.click();
    await flush();
    await typeFilter("wireless-filter", "corp");
    expect(sheetText()).toContain("de:ad:be:ef:00:01");
    expect(sheetText()).not.toContain("Not matched to an SSID");
  });
});

describe("a FortiGate's Wireless / MAC Table buttons", () => {
  it("are hidden until the gate is known to manage an AP / a switch", async () => {
    childCountsResult = { accessPoints: 2, switches: 0 };
    await openAsset("fw");
    expect(childCounts).toHaveBeenCalledWith("fw");
    const shown = (key: string) => document.getElementById("asset-" + key + "-btn-wrap")!.style.display !== "none";
    expect(shown("childwireless")).toBe(true);
    expect(shown("childmac")).toBe(false);
    // Desktop tab order: Wireless, MAC Table, then ARP Table.
    expect(btn("childwireless")!.compareDocumentPosition(btn("arp")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("are not drawn on anything but a firewall", async () => {
    childCountsResult = { accessPoints: 2, switches: 2 };
    await openAsset("sw");
    expect(btn("childwireless")).toBeNull();
    expect(childCounts).not.toHaveBeenCalled();
  });

  it("Wireless groups clients by AP, filters by AP name / IP / model and client MAC", async () => {
    childCountsResult = { accessPoints: 2, switches: 2 };
    await openAsset("fw");
    btn("childwireless")!.click();
    await flush();
    expect(childWireless).toHaveBeenCalledWith("fw");
    const heads = Array.from(document.querySelectorAll("#asset-host .asset-page .tbl-group-head .mono")).map((e) => e.textContent);
    expect(heads).toEqual(["AP-1", "AP-9"]);
    expect(sheetText()).toContain("No clients connected.");
    await typeFilter("childwireless-filter", "a012");
    expect(sheetText()).toContain("02:5A:A0:12:00:01");
    expect(sheetText()).not.toContain("02:5A:BA:01:00:00");   // "a0" across the BA:01 octet boundary
    await typeFilter("childwireless-filter", "231g");
    expect(sheetText()).toContain("AP-9");
    expect(sheetText()).not.toContain("AP-1");
    await typeFilter("childwireless-filter", "10.90.2.48");
    expect(sheetText()).toContain("02:5A:BA:01:00:00");      // an AP hit keeps all its clients
  });

  it("MAC Table groups entries by switch, hides trunk pseudo-ports until shown, filters", async () => {
    childCountsResult = { accessPoints: 0, switches: 2 };
    await openAsset("fw");
    btn("childmac")!.click();
    await flush();
    expect(childMacTable).toHaveBeenCalledWith("fw");
    expect(sheetText()).toContain("Users_VL30");
    // The entry's port carries its configured VLANs.
    expect(sheetText()).toContain("port3 (Native Users_VL30 · Tagged VLAN 40)");
    expect(sheetText()).toContain("Not monitored");
    expect(sheetText()).not.toContain("02:5A:C0:00:00:01");
    (document.getElementById("childmac-unattributed-toggle") as HTMLElement).click();
    expect(sheetText()).toContain("02:5A:C0:00:00:01");
    await typeFilter("childmac-filter", "ee-00-00-08");
    expect(sheetText()).toContain("02:5A:EE:00:00:08");
    expect(sheetText()).not.toContain("02:5A:EE:00:00:07");
    await typeFilter("childmac-filter", "fortiswitch-108e");
    expect(sheetText()).toContain("SWITCH-2");
    expect(sheetText()).not.toContain("SWITCH-1");
  });
});

describe("every table page has its filter box", () => {
  it("even over an empty table (ARP, MAC Table, Wireless)", async () => {
    arpTable.mockResolvedValueOnce({ entries: [], collectedAt: null, pollIntervalSec: null, retentionDays: 7, range: "current" } as any);
    await openAsset("fw");
    btn("arp")!.click();
    await flush();
    expect(document.getElementById("arp-filter")).not.toBeNull();
    await typeFilter("arp-filter", "zz");
    expect(sheetText()).toContain("No ARP entries.");            // not "nothing matches"

    macTable.mockResolvedValueOnce({ entries: [], collectedAt: null, pollIntervalSec: 300 } as any);
    await openAsset("sw");
    btn("mac")!.click();
    await flush();
    expect(document.getElementById("mac-filter")).not.toBeNull();

    systemInfo.mockResolvedValueOnce({ interfaces: [], hardwareSensors: [], apRadios: [], wirelessStations: [], lastSystemInfoAt: null } as any);
    delete g.PolarisAssetDetail;
    boot();
    await openAsset("ap");
    btn("wireless")!.click();
    await flush();
    expect(document.getElementById("wireless-filter")).not.toBeNull();
    expect(sheetText()).toContain("No radios or wireless clients reported for this AP.");
  });

  it("keeps the typed filter across the header's Refresh", async () => {
    await openAsset("sw");
    btn("mac")!.click();
    await flush();
    await typeFilter("mac-filter", "0003");
    expect(sheetText()).not.toContain("aa:bb:cc:00:00:01");
    (document.getElementById("asset-sheet-refresh") as HTMLElement).click();
    await flush();
    expect(macTable).toHaveBeenCalledTimes(2);
    expect((document.getElementById("mac-filter") as HTMLInputElement).value).toBe("0003");
    expect(sheetText()).toContain("aa:bb:cc:00:00:03");
    expect(sheetText()).not.toContain("aa:bb:cc:00:00:01");
  });

  it("keeps the typed filter across an ARP range change", async () => {
    await openAsset("fw");
    btn("arp")!.click();
    await flush();
    await typeFilter("arp-filter", "12.63");
    const sel = document.getElementById("arp-range-select") as HTMLSelectElement;
    sel.value = "24h";
    sel.dispatchEvent(new Event("change"));
    await flush();
    expect((document.getElementById("arp-filter") as HTMLInputElement).value).toBe("12.63");
    expect(sheetText()).toContain("10.4.12.63");
    expect(sheetText()).not.toContain("10.4.12.7 ");
  });
});
