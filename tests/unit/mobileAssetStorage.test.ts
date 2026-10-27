/**
 * tests/unit/mobileAssetStorage.test.ts — the asset sheet's Storage page.
 *
 * "View Storage" sits between the Interfaces and Discovery sources sections
 * and opens a page of the sheet. Pinned here:
 *
 *   • THE BUTTON'S PLACE and its summary line ("2 arrays · 3 drives · 1
 *     volume · 1 degraded"), painted from the asset row's pools and the
 *     storage stream's volumes.
 *   • A SERVER shows its volumes (the storage stream) with the desktop's
 *     75 / 90 % tones and a Poll 1m mark, and says it has no drive data.
 *   • A HYPERVISOR (Unraid / TrueNAS / Proxmox host) shows its pools as
 *     arrays — a degraded one open, a healthy one collapsed — with each
 *     group's member drives; a pool's own storage row is not repeated as a
 *     volume.
 *   • A DRIVE opens its page (errors split R / W / C); a VOLUME its usage
 *     chart from storage-history.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "asset-detail.js"), "utf-8");
const g = globalThis as any;
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

const GB = 1024 ** 3;

const TANK = {
  name: "tank", kind: "zfs", filesystem: "zfs", health: "DEGRADED", totalBytes: 40 * GB, usedBytes: 28 * GB,
  healthDetail: "One or more devices are faulted.", scan: { kind: "scrub", state: "finished", at: "2026-10-24T00:00:00Z", percent: null, errors: 0 },
  groups: [{
    role: "data", layout: "raidz2", name: "raidz2-0", health: "DEGRADED",
    members: [
      { name: "sda", device: null, serial: "S1", model: "WD80", health: "ONLINE", sizeBytes: 8 * GB, readErrors: 0, writeErrors: 0, checksumErrors: 0, errors: null, temperatureC: 34, filesystem: null, mediaType: "HDD", smart: "OK" },
      { name: "sdc", device: null, serial: "S3", model: "WD80", health: "FAULTED", sizeBytes: 8 * GB, readErrors: 0, writeErrors: 14, checksumErrors: 3, errors: null, temperatureC: 41, filesystem: null, mediaType: "HDD", smart: "OK" },
    ],
  }],
};
const BOOT = {
  name: "boot-pool", kind: "zfs", filesystem: "zfs", health: "ONLINE", totalBytes: 232 * GB, usedBytes: 20 * GB,
  groups: [{ role: "data", layout: "mirror", name: "mirror-0", health: "ONLINE",
    members: [{ name: "nvme0n1", device: null, serial: "N1", model: "SSD", health: "ONLINE", sizeBytes: 250 * GB, readErrors: 0, writeErrors: 0, checksumErrors: 0, errors: null, temperatureC: 40, filesystem: null, mediaType: "NVMe", smart: null }] }],
};

const ASSETS: Record<string, any> = {
  srv: { id: "srv", hostname: "SQL-2", assetType: "server", monitored: true, status: "active", macAddresses: [], monitoredStorage: ["C:\\"] },
  nas: { id: "nas", hostname: "NAS-1", assetType: "server", monitored: true, status: "active", macAddresses: [],
    virtualization: { role: "host", platform: "truenas", pools: [TANK, BOOT] } },
};
const INFO: Record<string, any> = {
  srv: { interfaces: [], hardwareSensors: [], monitoredStorage: ["C:\\"], storage: [
    { mountPath: "C:\\", usedBytes: 92 * GB, totalBytes: 100 * GB },
    { mountPath: "D:\\", usedBytes: 41 * GB, totalBytes: 100 * GB },
  ] },
  nas: { interfaces: [], hardwareSensors: [], storage: [
    { mountPath: "tank", usedBytes: 28 * GB, totalBytes: 40 * GB },
    { mountPath: "boot-pool", usedBytes: 20 * GB, totalBytes: 232 * GB },
    { mountPath: "/mnt/scratch", usedBytes: 1 * GB, totalBytes: 10 * GB },
  ] },
};

const storageHistory = vi.fn(async () => ({
  since: "2026-10-26T12:00:00Z",
  samples: [
    { timestamp: "2026-10-26T13:00:00Z", usedBytes: 90 * GB, totalBytes: 100 * GB },
    { timestamp: "2026-10-27T11:00:00Z", usedBytes: 92 * GB, totalBytes: 100 * GB },
  ],
}));
let charts: any[] = [];

beforeEach(() => {
  storageHistory.mockClear();
  charts = [];
  delete g.PolarisAssetDetail;
  document.body.innerHTML = '<div id="app"></div>';
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.formatBytes = (n: number) => (n / GB).toFixed(1) + " GB";
  g.PolarisTabs = { showSnackbar: vi.fn(), attachSwipeToDismiss: vi.fn() };
  g.PolarisCharts = { lineChart: (o: any) => { charts.push(o); return "<svg></svg>"; } };
  g.PolarisMobile = { user: () => ({ permissions: {} }) };
  g.mobileFormatDate = (s: any) => String(s ?? "");
  g.timeAgo = () => "3d ago";
  const known: Record<string, any> = {
    get: async (id: string) => ASSETS[id],
    systemInfo: async (id: string) => INFO[id],
    virtualization: async (id: string) => ({ virtualization: ASSETS[id].virtualization }),
    storageHistory,
  };
  g.api = { assets: new Proxy(known, { get: (t, k: string) => (k in t ? t[k] : async () => ({})) }) };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
});

async function openStorage(id: string) {
  g.PolarisAssetDetail.open(id);
  await flush();
  (document.getElementById("asset-storage-btn") as HTMLButtonElement).click();
  await flush();
}
const pageEl = () => document.querySelector("#asset-host .asset-page") as HTMLElement;
const text = () => (pageEl()?.textContent || "").replace(/\s+/g, " ");

describe("the View Storage button", () => {
  it("sits between Interfaces and Discovery sources", async () => {
    g.PolarisAssetDetail.open("srv");
    await flush();
    const ifaces = document.querySelector('.sect-body[data-sect="interfaces"]')!;
    const btn = document.getElementById("asset-storage-btn")!;
    const sources = document.querySelector('.asset-sect-header[data-key="sources"]')!;
    expect(ifaces.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(btn.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("summarises arrays, drives, volumes and the degraded count", async () => {
    g.PolarisAssetDetail.open("nas");
    await flush();
    const sub = document.getElementById("asset-storage-sub")!;
    expect(sub.textContent).toBe("2 arrays · 3 drives · 1 volume · 1 degraded");
    expect(sub.classList.contains("bad")).toBe(true);
  });
});

describe("a server's Storage page", () => {
  it("lists its volumes with the desktop's tones and the Poll 1m mark", async () => {
    await openStorage("srv");
    expect(pageEl().dataset.page).toBe("storage");
    const fills = Array.from(pageEl().querySelectorAll(".storage-bar-fill")).map((e) => e.className);
    expect(fills).toEqual(["storage-bar-fill crit", "storage-bar-fill"]);
    expect(text()).toContain("Poll 1m");
    expect(text()).toContain("8.0 GB free");
    expect(text()).toContain("Physical drives are reported only by Unraid, TrueNAS and Proxmox hosts");
    expect(pageEl().querySelector(".pool-card")).toBeNull();
  });

  it("a volume opens its usage chart", async () => {
    await openStorage("srv");
    (pageEl().querySelector(".storage-vol") as HTMLElement).click();
    await flush();
    expect(pageEl().dataset.page).toBe("volume");
    expect(document.getElementById("asset-sheet-page-title")!.textContent).toBe("C:\\");
    expect(storageHistory).toHaveBeenCalledWith("srv", "C:\\", { range: "24h" });
    expect(charts.at(-1).series[0].values.map((v: any) => v.v)).toEqual([90, 92]);
    expect(document.getElementById("vol-chart-sub")!.textContent).toBe("now 92% · peak 92%");
  });
});

describe("a hypervisor's Storage page", () => {
  it("shows a degraded array open and a healthy one collapsed; pool rows are not volumes", async () => {
    await openStorage("nas");
    const cards = Array.from(pageEl().querySelectorAll(".pool-card"));
    expect(cards.length).toBe(2);
    expect(cards[0].querySelector(".pool-head")!.getAttribute("aria-expanded")).toBe("true");
    expect(cards[1].querySelector(".pool-head")!.getAttribute("aria-expanded")).toBe("false");
    expect(cards[0].querySelectorAll(".pool-drive").length).toBe(2);
    expect(cards[1].querySelectorAll(".pool-drive").length).toBe(0);
    expect(text()).toContain("Data · raidz2");
    expect(text()).toContain("errors 0/14/3");
    expect(text()).toContain("One or more devices are faulted.");
    const vols = Array.from(pageEl().querySelectorAll(".storage-vol-name")).map((e) => e.textContent);
    expect(vols).toEqual(["/mnt/scratch"]);
  });

  it("a tap opens and closes an array", async () => {
    await openStorage("nas");
    (pageEl().querySelectorAll(".pool-head")[1] as HTMLElement).click();
    expect(pageEl().querySelectorAll(".pool-card")[1].querySelectorAll(".pool-drive").length).toBe(1);
  });

  it("a drive opens its page; Back returns to Storage with the array still open", async () => {
    await openStorage("nas");
    const bad = Array.from(pageEl().querySelectorAll(".pool-drive")).find((b) => b.textContent!.includes("sdc")) as HTMLElement;
    expect(bad.classList.contains("bad")).toBe(true);
    bad.click();
    await flush();
    expect(pageEl().dataset.page).toBe("drive");
    expect(document.getElementById("asset-sheet-page-title")!.textContent).toBe("sdc");
    expect(document.getElementById("asset-sheet-page-sub")!.textContent).toBe("NAS-1 · tank · raidz2-0");
    expect(text()).toContain("Write errors14");
    expect(text()).toContain("Checksum errors3");
    expect(pageEl().querySelector(".kv-row .v.bad")).not.toBeNull();

    (document.getElementById("asset-sheet-back") as HTMLButtonElement).click();
    await flush();
    expect(pageEl().dataset.page).toBe("storage");
    expect(pageEl().querySelector(".pool-head")!.getAttribute("aria-expanded")).toBe("true");
  });
});
