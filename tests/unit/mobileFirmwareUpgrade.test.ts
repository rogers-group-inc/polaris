/**
 * tests/unit/mobileFirmwareUpgrade.test.ts — the phone's firmware upgrade on
 * the asset sheet (business rule 87): an "Upgrade to <version>" button in the
 * OS / Firmware row, a stacked confirm sheet, then "Upgrade started" and live
 * progress.
 *
 * Pinned here:
 *
 *   • WHO GETS THE BUTTON — a switch or access point with an image on offer,
 *     and only for assets:write (rule 43(g)); at assets:read the row says the
 *     version is available and what it needs. Other device types never ask.
 *
 *   • THE CONFIRM IS A SHEET, NEVER window.confirm (suppressed in some
 *     installed PWAs — canon-mobile), names the device and the exact image,
 *     and Cancel sends nothing.
 *
 *   • AFTER CONFIRMING: the POST carries the offered image's id, the snackbar
 *     says "Upgrade started", the row follows the run's stage and percent
 *     through the per-asset run read, and settles on the result.
 *
 *   • DISMISSING THE SHEET STOPS THE POLL.
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

const ASSETS: Record<string, any> = {
  sw:  { id: "sw",  hostname: "SWITCH-1", assetType: "switch", monitored: true, status: "active", macAddresses: [],
         serialNumber: "S124FFTF23000001", os: "FortiSwitchOS", osVersion: "7.6.6 build1137" },
  srv: { id: "srv", hostname: "SERVER-1", assetType: "server", monitored: true, status: "active", macAddresses: [],
         os: "Windows Server", osVersion: "2022" },
};

const IMAGE = { id: "img-primary", versionLabel: "7.6.8 build1164", platform: "S124FF", filename: "FSW_124F-v7-build1164-FORTINET.out" };
let availability: any;
let runs: any[];
const firmwareUpgrade = vi.fn(async () => availability);
const startFirmwareUpgrade = vi.fn(async () => ({ run: { id: "run-1", status: "queued", stage: null, progress: null, toVersion: IMAGE.versionLabel } }));
const firmwareUpgradeRun = vi.fn(async () => ({ run: runs.length > 1 ? runs.shift() : runs[0] }));
// Scheduled upgrades (business rule 93).
const firmwareScheduleDefaults = vi.fn(async () => ({ notifyEmails: ["me@example.com"] }));
const scheduleFirmwareUpgrade = vi.fn(async (_id: string, body: any) => ({ schedule: { id: "sch-1", ...body } }));
const updateFirmwareSchedule = vi.fn(async (_id: string, _sid: string, body: any) => ({ schedule: { id: "sch-1", ...body } }));
const cancelFirmwareSchedule = vi.fn(async () => ({ schedule: { id: "sch-1", status: "cancelled" } }));

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
    get: async (id: string) => ASSETS[id], firmwareUpgrade, startFirmwareUpgrade, firmwareUpgradeRun,
    firmwareScheduleDefaults, scheduleFirmwareUpgrade, updateFirmwareSchedule, cancelFirmwareSchedule,
  };
  g.api = { assets: new Proxy(known, { get: (t, k: string) => (k in t ? t[k] : async () => ({})) }) };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
}

async function openAsset(id: string) {
  g.PolarisAssetDetail.open(id);
  await flush();
}
const osRow = () => Array.from(document.querySelectorAll(".kv-row")).find((r) => r.querySelector(".k")?.textContent === "OS") as HTMLElement | undefined;
const upgradeBtn = () => document.getElementById("asset-fw-upgrade-btn") as HTMLButtonElement | null;
const confirmSheet = () => document.getElementById("fw-confirm-sheet");
const text = (el: Element | null | undefined) => (el?.textContent || "").replace(/\s+/g, " ").trim();

beforeEach(() => {
  vi.useFakeTimers();
  firmwareUpgrade.mockClear();
  startFirmwareUpgrade.mockClear();
  firmwareUpgradeRun.mockClear();
  scheduleFirmwareUpgrade.mockClear();
  updateFirmwareSchedule.mockClear();
  cancelFirmwareSchedule.mockClear();
  perms = { assets: "write" };
  availability = { state: "available", available: true, current: "S124FF-v7.6.6-build1137", image: IMAGE, credential: { credentialName: "FortiSwitch HTTP", scope: "assetType" } };
  runs = [{ id: "run-1", status: "running", stage: "deploying", progress: { erase: 100, write: 46.4, verify: 0 }, toVersion: IMAGE.versionLabel }];
  delete g.PolarisAssetDetail;
  g.confirm = vi.fn(() => true);
  boot();
});
afterEach(() => { vi.useRealTimers(); });

describe("who gets the button", () => {
  it("a switch with an image on offer, at assets:write — in the OS row", async () => {
    await openAsset("sw");
    expect(firmwareUpgrade).toHaveBeenCalledWith("sw");
    const row = osRow()!;
    expect(text(row)).toContain("FortiSwitchOS 7.6.6 build1137");
    expect(row.querySelector("#asset-fw-upgrade-btn")).not.toBeNull();
    expect(text(upgradeBtn())).toBe("Upgrade to 7.6.8 build1164");
  });

  it("at assets:read: no button, the row says what is available and what it needs", async () => {
    perms = { assets: "read" };
    await openAsset("sw");
    expect(upgradeBtn()).toBeNull();
    expect(text(osRow())).toContain("7.6.8 build1164 available — upgrading needs Read-Write on Assets");
  });

  it("no button when nothing newer is on offer", async () => {
    availability = { state: "up-to-date", available: false, current: "7.6.8 build1164", reason: "Current" };
    await openAsset("sw");
    expect(upgradeBtn()).toBeNull();
  });

  it("a server never asks, and its OS row is plain text", async () => {
    await openAsset("srv");
    expect(firmwareUpgrade).not.toHaveBeenCalled();
    expect(document.getElementById("asset-fw-slot")).toBeNull();
    expect(text(osRow())).toBe("OS Windows Server 2022");
  });
});

describe("the confirm", () => {
  it("is a stacked sheet naming the device and the exact image — never window.confirm", async () => {
    await openAsset("sw");
    upgradeBtn()!.click();
    await flush();
    const sheet = confirmSheet()!;
    expect(sheet).not.toBeNull();
    expect(g.confirm).not.toHaveBeenCalled();
    expect(text(sheet.querySelector(".sheet-title"))).toBe("Upgrade firmware?");
    const rows: Record<string, string> = {};
    sheet.querySelectorAll(".kv-row").forEach((r) => { rows[text(r.querySelector(".k"))] = text(r.querySelector(".v")); });
    expect(rows).toEqual({
      Device: "SWITCH-1",
      Serial: "S124FFTF23000001",
      Running: "S124FF-v7.6.6-build1137",
      "Upgrade to": "7.6.8 build1164 (S124FF)",
      Image: "FSW_124F-v7-build1164-FORTINET.out",
      Login: "FortiSwitch HTTP",
    });
    expect(text(sheet)).toContain("reboots");
  });

  it("Cancel sends nothing and closes the sheet", async () => {
    await openAsset("sw");
    upgradeBtn()!.click();
    await flush();
    (document.getElementById("fw-confirm-cancel") as HTMLButtonElement).click();
    await flush();
    expect(confirmSheet()).toBeNull();
    expect(startFirmwareUpgrade).not.toHaveBeenCalled();
  });
});

describe("after confirming", () => {
  it("starts the approved image, says Upgrade started, follows the stage and percent, and settles on the result", async () => {
    runs = [
      { id: "run-1", status: "running", stage: "deploying", progress: { erase: 100, write: 46.4, verify: 0 }, toVersion: IMAGE.versionLabel },
      { id: "run-1", status: "running", stage: "rebooting", progress: { erase: 100, write: 100, verify: 100 }, toVersion: IMAGE.versionLabel },
      { id: "run-1", status: "succeeded", stage: "recovering", verifiedVersion: "7.6.8 build1164", toVersion: IMAGE.versionLabel },
    ];
    await openAsset("sw");
    upgradeBtn()!.click();
    await flush();
    (document.getElementById("fw-confirm-ok") as HTMLButtonElement).click();
    await flush();
    expect(startFirmwareUpgrade).toHaveBeenCalledWith("sw", { imageId: "img-primary" });
    expect(g.PolarisTabs.showSnackbar).toHaveBeenCalledWith("Upgrade started");
    expect(text(document.getElementById("asset-fw-progress-text"))).toBe("Upgrade started");

    await vi.advanceTimersByTimeAsync(3000); await flush();
    expect(firmwareUpgradeRun).toHaveBeenLastCalledWith("sw", "run-1");
    expect(text(document.getElementById("asset-fw-progress-text"))).toBe("Writing image 46%");

    await vi.advanceTimersByTimeAsync(3000); await flush();
    expect(text(document.getElementById("asset-fw-progress-text"))).toBe("Rebooting");

    await vi.advanceTimersByTimeAsync(3000); await flush();
    expect(text(osRow())).toContain("Upgraded to 7.6.8 build1164");
    expect(g.PolarisTabs.showSnackbar).toHaveBeenLastCalledWith("Firmware upgraded to 7.6.8 build1164");
    const calls = firmwareUpgradeRun.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9000); await flush();
    expect(firmwareUpgradeRun.mock.calls.length).toBe(calls);   // stopped at the terminal status
  });

  it("an upgrade already running when the sheet opens is followed too", async () => {
    availability = { state: "running", available: false, activeRun: { id: "run-1", status: "running", stage: "staging", progress: null, toVersion: IMAGE.versionLabel } };
    await openAsset("sw");
    expect(text(document.getElementById("asset-fw-progress-text"))).toBe("Uploading image");
    await vi.advanceTimersByTimeAsync(3000); await flush();
    expect(text(document.getElementById("asset-fw-progress-text"))).toBe("Writing image 46%");
  });

  it("a failed start says why and leaves the button usable", async () => {
    startFirmwareUpgrade.mockImplementationOnce(async () => { throw new Error("SWITCH-1 is down"); });
    await openAsset("sw");
    upgradeBtn()!.click();
    await flush();
    (document.getElementById("fw-confirm-ok") as HTMLButtonElement).click();
    await flush();
    expect(g.PolarisTabs.showSnackbar).toHaveBeenLastCalledWith("SWITCH-1 is down", { error: true });
    expect(upgradeBtn()!.disabled).toBe(false);
  });
});

describe("dismissing the sheet", () => {
  it("stops the poll", async () => {
    availability = { state: "running", available: false, activeRun: { id: "run-1", status: "running", stage: "staging", progress: null, toVersion: IMAGE.versionLabel } };
    await openAsset("sw");
    (document.getElementById("asset-sheet-close") as HTMLButtonElement).click();
    await flush();
    await vi.advanceTimersByTimeAsync(12000); await flush();
    expect(firmwareUpgradeRun).not.toHaveBeenCalled();
  });
});

// ─── Scheduled upgrades (business rule 93) — the same sheet, a box to book it ─
describe("Schedule for later", () => {
  const box = () => document.getElementById("fw-confirm-schedule") as HTMLInputElement | null;
  const okBtn = () => document.getElementById("fw-confirm-ok") as HTMLButtonElement;
  const booking = (over: Record<string, unknown> = {}) => ({
    id: "sch-1", imageId: IMAGE.id, toVersion: IMAGE.versionLabel, scheduledFor: new Date(Date.now() + 9 * 3_600_000).toISOString(),
    notifyEmails: ["ops@example.com"], status: "pending", error: null, createdBy: "alice", ...over,
  });

  it("the sheet has an unticked box; ticking it reveals the time and the pre-filled recipient and makes the verb Schedule", async () => {
    await openAsset("sw");
    upgradeBtn()!.click();
    await flush();
    expect(box()!.checked).toBe(false);
    const fields = document.getElementById("fw-sched-fields") as HTMLElement;
    expect(fields.style.display).toBe("none");
    expect(text(okBtn())).toBe("Upgrade");
    box()!.click();
    await flush();
    expect(fields.style.display).toBe("");
    expect(text(okBtn())).toBe("Schedule");
    expect((document.getElementById("fw-sched-emails") as HTMLInputElement).value).toBe("me@example.com");
    expect((document.getElementById("fw-sched-when") as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("Schedule books the offered image for the chosen time — and starts nothing", async () => {
    await openAsset("sw");
    upgradeBtn()!.click();
    await flush();
    box()!.click();
    (document.getElementById("fw-sched-when") as HTMLInputElement).value = "2030-01-02T03:30";
    okBtn().click();
    await flush();
    expect(startFirmwareUpgrade).not.toHaveBeenCalled();
    expect(scheduleFirmwareUpgrade).toHaveBeenCalledWith("sw", { imageId: IMAGE.id, scheduledFor: new Date("2030-01-02T03:30").toISOString(), notifyEmails: ["me@example.com"] });
    expect(g.PolarisTabs.showSnackbar).toHaveBeenCalledWith(expect.stringContaining("Upgrade scheduled for"));
  });

  it("no recipient = the Schedule verb stays off", async () => {
    await openAsset("sw");
    upgradeBtn()!.click();
    await flush();
    box()!.click();
    const emails = document.getElementById("fw-sched-emails") as HTMLInputElement;
    emails.value = "";
    emails.dispatchEvent(new Event("input"));
    expect(okBtn().disabled).toBe(true);
  });

  it("blocked right now: the Upgrade verb still shows, and the sheet opens with the box ticked and locked", async () => {
    availability = { ...availability, state: "blocked", available: false, reason: "7.6.8 build1164 is available, but the device is down.", blockers: ["the device is down"] };
    await openAsset("sw");
    expect(text(osRow())).toContain("It can be scheduled for later.");
    upgradeBtn()!.click();
    await flush();
    expect(box()!.checked).toBe(true);
    expect(box()!.disabled).toBe(true);
    expect(text(okBtn())).toBe("Schedule");
    expect(text(confirmSheet())).toContain("Right now the device is down");
  });

  it("a pending booking sits on the row with Change and Cancel; Cancel cancels it", async () => {
    availability = { ...availability, schedule: booking() };
    await openAsset("sw");
    expect(text(document.getElementById("asset-fw-schedule"))).toContain("Scheduled: 7.6.8 build1164 at");
    expect(text(document.getElementById("asset-fw-schedule"))).toContain("Results to ops@example.com");
    (document.getElementById("asset-fw-sched-cancel") as HTMLButtonElement).click();
    await flush();
    expect(cancelFirmwareSchedule).toHaveBeenCalledWith("sw", "sch-1");
  });

  it("Change opens the sheet on the booking's own fields and saves to it", async () => {
    availability = { ...availability, schedule: booking({ scheduledFor: "2030-01-02T08:30:00Z" }) };
    await openAsset("sw");
    (document.getElementById("asset-fw-sched-change") as HTMLButtonElement).click();
    await flush();
    expect(text(confirmSheet()!.querySelector(".sheet-title"))).toBe("Change scheduled upgrade");
    expect(box()).toBeNull();
    expect((document.getElementById("fw-sched-emails") as HTMLInputElement).value).toBe("ops@example.com");
    okBtn().click();
    await flush();
    expect(updateFirmwareSchedule).toHaveBeenCalledWith("sw", "sch-1", expect.objectContaining({ notifyEmails: ["ops@example.com"] }));
    expect(scheduleFirmwareUpgrade).not.toHaveBeenCalled();
  });

  it("with a booking pending, Upgrade now offers no second booking", async () => {
    availability = { ...availability, schedule: booking() };
    await openAsset("sw");
    expect(text(upgradeBtn())).toBe("Upgrade to 7.6.8 build1164 now");
    upgradeBtn()!.click();
    await flush();
    expect(box()).toBeNull();
    expect(text(confirmSheet())).toContain("already scheduled");
  });

  it("at assets:read the booking is shown without Change or Cancel", async () => {
    perms = { assets: "read" };
    availability = { ...availability, schedule: booking() };
    await openAsset("sw");
    expect(document.getElementById("asset-fw-schedule")).not.toBeNull();
    expect(document.getElementById("asset-fw-sched-change")).toBeNull();
    expect(document.getElementById("asset-fw-sched-cancel")).toBeNull();
  });
});

describe("fwProgressText", () => {
  it("names the stage, and the percent of the flash stage in progress", () => {
    const f = g.PolarisAssetDetail._fw.fwProgressText;
    expect(f({ stage: "deploying", progress: { erase: 12.3, write: 0, verify: 0 } })).toBe("Erasing flash 12%");
    expect(f({ stage: "deploying", progress: { erase: 100, write: 100, verify: 80 } })).toBe("Verifying image 80%");
    expect(f({ stage: "deploying", progress: null })).toBe("Flashing");
    expect(f({ stage: "recovering" })).toBe("Waiting for monitoring to answer");
    expect(f(null)).toBe("Upgrade started");
  });
});
