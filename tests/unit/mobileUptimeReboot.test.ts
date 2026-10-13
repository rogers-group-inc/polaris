/**
 * tests/unit/mobileUptimeReboot.test.ts — the phone's asset sheet, General:
 * the Uptime row with the Reboot verb in it (business rule 115), and the
 * "Up to date" mark on the OS line.
 *
 * Pinned here:
 *
 *   • UPTIME — the last reading plus the time since it was taken, frozen while
 *     the device is down (the desktop System tab's rule), with "since".
 *
 *   • THE VERB — "Reboot…" only when the server says something may reboot the
 *     device and the user holds assets:write; a device that cannot reboot now
 *     but can be booked gets "Schedule reboot…" and the reason; the confirm is
 *     a stacked sheet that refuses to proceed until "I understand this device
 *     will go down" is ticked; reboot now POSTs, a booking sends the time and
 *     recipients.
 *
 *   • NO EMPTY ROW — a device that reports no uptime and that Polaris cannot
 *     reboot shows no Uptime row at all.
 *
 *   • "UP TO DATE" — only when the Repository's active image for the
 *     platform is exactly what the device runs (vsPrimary "current"); never
 *     for a device past it, or one the Repository cannot place.
 *
 * asset-detail.js is executed as-is, so the wiring under test is the wiring
 * that ships.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "asset-detail.js"), "utf-8");
const g = globalThis as any;

const NOW = new Date("2026-10-13T12:00:00Z").getTime();
const ASSETS: Record<string, any> = {
  gate: {
    id: "gate", hostname: "SPK1", assetType: "firewall", monitored: true, status: "active", monitorStatus: "up", macAddresses: [],
    serialNumber: "FGT61FTK20009142", os: "FortiOS", osVersion: "7.6.7",
    // 2 days at the last probe, taken 1 hour ago.
    lastUptimeSec: 2 * 86400, lastMonitorAt: new Date(NOW - 3600_000).toISOString(),
  },
  bare: { id: "bare", hostname: "PRINTER", assetType: "printer", monitored: false, status: "active", macAddresses: [] },
};

let reboot: any;
let firmware: any;
const rebootFn = vi.fn(async () => reboot);
const startReboot = vi.fn(async () => ({ run: { id: "rb-1", status: "queued", stage: null } }));
const rebootRun = vi.fn(async () => ({ run: { id: "rb-1", status: "rebooting", stage: "down" } }));
const rebootScheduleDefaults = vi.fn(async () => ({ notifyEmails: ["me@example.com"] }));
const scheduleReboot = vi.fn(async (_id: string, body: any) => ({ schedule: { id: "s-1", ...body } }));
const firmwareUpgrade = vi.fn(async () => firmware);

let perms: Record<string, string>;
const flush = async () => { for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0); };

function boot() {
  document.body.innerHTML = '<div id="app"></div>';
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.PolarisTabs = { showSnackbar: vi.fn(), attachSwipeToDismiss: vi.fn() };
  g.PolarisCharts = { lineChart: () => "" };
  g.PolarisMobile = { user: () => ({ permissions: perms }) };
  g.mobileFormatDate = (s: any) => String(s ?? "");
  g.timeAgo = () => "1m ago";
  const known: Record<string, any> = {
    get: async (id: string) => ASSETS[id], reboot: rebootFn, startReboot, rebootRun, rebootScheduleDefaults, scheduleReboot, firmwareUpgrade,
  };
  g.api = { assets: new Proxy(known, { get: (t, k: string) => (k in t ? t[k] : async () => ({})) }) };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
}

async function openAsset(id: string) {
  g.PolarisAssetDetail.open(id);
  await flush();
}
const rowNamed = (k: string) => Array.from(document.querySelectorAll(".kv-row")).find((r) => r.querySelector(".k")?.textContent === k) as HTMLElement | undefined;
const text = (el: Element | null | undefined) => (el?.textContent || "").replace(/\s+/g, " ").trim();
const btn = () => document.getElementById("asset-reboot-btn") as HTMLButtonElement | null;
const sheet = () => document.getElementById("rb-confirm-sheet");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  [rebootFn, startReboot, rebootRun, scheduleReboot, firmwareUpgrade].forEach((f) => f.mockClear());
  perms = { assets: "write" };
  reboot = { state: "available", available: true, kind: "fortinet", method: "fortigate-rest", authority: "Integration API token (lab-spoke1)", via: null, activeRun: null, lastRun: null, schedule: null };
  firmware = { state: "up-to-date", available: false, current: "7.6.7", vsPrimary: "current", primaryVersion: "7.6.7 build3704" };
  delete g.PolarisAssetDetail;
  boot();
});
afterEach(() => { vi.useRealTimers(); });

describe("the Uptime row", () => {
  it("shows the reading plus the time since, and the Reboot verb", async () => {
    await openAsset("gate");
    const row = rowNamed("Uptime")!;
    expect(row).toBeTruthy();
    expect(text(row)).toMatch(/^Uptime 2d 1h · since /);
    expect(text(btn())).toBe("Reboot…");
  });

  it("freezes the figure while the device is down", () => {
    const f = g.PolarisAssetDetail._rb;
    expect(f.uptimeSecondsNow({ ...ASSETS.gate, monitorStatus: "down" }, NOW)).toBe(2 * 86400);
    expect(f.uptimeSecondsNow(ASSETS.gate, NOW)).toBe(2 * 86400 + 3600);
    expect(f.uptimeSecondsNow({ id: "x" }, NOW)).toBeNull();
    expect(f.formatUptime(45)).toBe("<1m");
    expect(f.formatUptime(3 * 3600 + 20 * 60)).toBe("3h 20m");
  });

  it("is gone entirely when there is no uptime and nothing can reboot the device", async () => {
    reboot = { state: "unsupported", available: false, kind: null };
    await openAsset("bare");
    expect(rowNamed("Uptime")).toBeUndefined();
  });

  it("stays, with the reason, when the device reports uptime but cannot be rebooted", async () => {
    reboot = { state: "no-credential", available: false, kind: "fortinet", reason: "Nothing is allowed to reboot this FortiGate." };
    await openAsset("gate");
    expect(btn()).toBeNull();
    expect(text(rowNamed("Uptime"))).toContain("Nothing is allowed to reboot this FortiGate.");
  });

  it("offers a booking when the device cannot reboot right now but can later", async () => {
    reboot = { ...reboot, state: "agent-offline", available: false, reason: "The agent has not been heard from." };
    await openAsset("gate");
    expect(text(btn())).toBe("Schedule reboot…");
    expect(text(rowNamed("Uptime"))).toContain("It can be scheduled for later.");
  });

  it("shows no button at assets:read", async () => {
    perms = { assets: "read" };
    await openAsset("gate");
    expect(btn()).toBeNull();
    expect(text(rowNamed("Uptime"))).toContain("Rebooting needs Read-Write on Assets");
  });
});

describe("rebooting from the phone", () => {
  it("needs the acknowledgement, then POSTs and watches the run", async () => {
    await openAsset("gate");
    btn()!.click();
    await flush();
    expect(sheet()).not.toBeNull();
    const ok = document.getElementById("rb-confirm-ok") as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    const ack = document.getElementById("rb-confirm-ack") as HTMLInputElement;
    ack.checked = true;
    ack.dispatchEvent(new Event("change"));
    expect(ok.disabled).toBe(false);
    ok.click();
    await flush();
    expect(startReboot).toHaveBeenCalledWith("gate");
    expect(sheet()).toBeNull();
    expect(text(document.getElementById("asset-reboot-slot"))).toContain("Sending the reboot");
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(rebootRun).toHaveBeenCalledWith("gate", "rb-1");
    expect(text(document.getElementById("asset-reboot-slot"))).toContain("Rebooting — device is down");
  });

  it("Cancel sends nothing", async () => {
    await openAsset("gate");
    btn()!.click();
    await flush();
    (document.getElementById("rb-confirm-cancel") as HTMLButtonElement).click();
    await flush();
    expect(sheet()).toBeNull();
    expect(startReboot).not.toHaveBeenCalled();
  });

  it("books a reboot with the time and the recipients", async () => {
    await openAsset("gate");
    btn()!.click();
    await flush();
    const later = document.getElementById("rb-confirm-schedule") as HTMLInputElement;
    later.checked = true;
    later.dispatchEvent(new Event("change"));
    const ack = document.getElementById("rb-confirm-ack") as HTMLInputElement;
    ack.checked = true;
    ack.dispatchEvent(new Event("change"));
    const ok = document.getElementById("rb-confirm-ok") as HTMLButtonElement;
    expect(text(ok)).toBe("Schedule");
    expect((document.getElementById("rb-sched-emails") as HTMLInputElement).value).toBe("me@example.com");
    ok.click();
    await flush();
    expect(scheduleReboot).toHaveBeenCalledWith("gate", expect.objectContaining({ notifyEmails: ["me@example.com"], scheduledFor: expect.stringMatching(/Z$/) }));
    expect(startReboot).not.toHaveBeenCalled();
  });
});

describe("Up to date on the OS line", () => {
  const osRow = () => rowNamed("OS");
  it("says so when the device runs exactly the Repository's active image", async () => {
    await openAsset("gate");
    expect(text(osRow())).toContain("FortiOS 7.6.7");
    expect(text(osRow())).toContain("Up to date");
  });

  it("says nothing for a device past the active image", async () => {
    firmware = { ...firmware, vsPrimary: "newer" };
    await openAsset("gate");
    expect(text(osRow())).not.toContain("Up to date");
  });

  it("says nothing when the Repository cannot place the device", async () => {
    firmware = { ...firmware, vsPrimary: null, primaryVersion: null };
    await openAsset("gate");
    expect(text(osRow())).not.toContain("Up to date");
  });

  it("says nothing when an upgrade is on offer", async () => {
    firmware = { state: "available", available: true, image: { id: "i", versionLabel: "7.6.8" }, vsPrimary: null };
    await openAsset("gate");
    expect(text(osRow())).not.toContain("Up to date");
  });
});
