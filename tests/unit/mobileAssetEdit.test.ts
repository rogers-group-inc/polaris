/**
 * tests/unit/mobileAssetEdit.test.ts — the phone's asset edit menu and its
 * General / Monitoring / Maintenance sheets (public/js/mobile/asset-edit.js),
 * opened by tapping the asset's name in the asset sheet header.
 *
 * Pinned here:
 *
 *   • THE MENU IS THE DESKTOP MODAL'S TAB LIST, in its order — read out of
 *     openEditModal in assets.js, so a tab added there fails this until the
 *     phone grows the matching sheet.
 *
 *   • GATES FOLLOW THE ROUTES: General / Monitoring save through PUT
 *     /assets/:id (assets:write) and are drawn disabled without it;
 *     Maintenance reads at assets:read and offers its actions only at
 *     maintenanceManagement:write.
 *
 *   • EACH SHEET SENDS THE DESKTOP'S PAYLOAD for its own fields — the keys
 *     that clear when blank ("" location / notes / description / hostname /
 *     IP), the coordinate pair, tags a registry doesn't list, a STORED
 *     per-stream credential behind "Inherit" — and nothing from the other tabs.
 *
 *   • THE QUESTIONS ASKED BEFORE A NEW ADDRESS LANDS (rule 40(i) duplicate,
 *     rule 103 confidence) are asked as sheets, and a "no" saves nothing.
 *
 *   • THE OFFERED POLLING METHODS ARE THE DESKTOP'S: both come from
 *     polling-methods.js, and the status gate (rule 10) disables monitoring.
 *
 *   • The desktop constants the sheet mirrors (unmonitorable statuses,
 *     description device caps, the type lock, the type seed) still match.
 *
 * asset-detail.js and asset-edit.js are executed as-is (plain script tags on
 * mobile.html), as is polling-methods.js, so the wiring under test ships.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf-8");
const DETAIL_SRC = read("public", "js", "mobile", "asset-detail.js");
const EDIT_SRC = read("public", "js", "mobile", "asset-edit.js");
const POLLING_SRC = read("public", "js", "polling-methods.js");
const DOWN_AFTER_SRC = read("public", "js", "monitor-down-after.js");
const ASSETS_SRC = read("public", "js", "assets.js");

const g = globalThis as any;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

const BASE: Record<string, any> = {
  srv: {
    id: "srv", hostname: "SERVER-1", assetType: "server", status: "active", monitored: true,
    ipAddress: "10.0.0.5", location: "", snmpLocation: "DC1 rack 4", notes: "old note",
    description: "b:Shop", tags: ["prod", "auto-discovered"], latitude: null, longitude: null,
    discoveredByIntegrationId: null, discoveredByIntegration: null,
    responseTimeCredentialId: "c-rest-old", responseTimePolling: null,
  },
  gone: { id: "gone", hostname: "OLD-1", assetType: "server", status: "decommissioned", monitored: false, tags: [] },
  fw: {
    id: "fw", hostname: "GATE-1", assetType: "firewall", status: "active", monitored: true, tags: [],
    discoveredByIntegrationId: "i1", discoveredByIntegration: { id: "i1", type: "fortigate", name: "Lab FG", syncDescriptions: true },
  },
};
let ASSETS: Record<string, any>;

let api: any;
function boot(perms: Record<string, string>, extra: Record<string, any> = {}) {
  ASSETS = JSON.parse(JSON.stringify(BASE));
  document.body.innerHTML = '<div id="app"></div>';
  document.head.innerHTML = "";
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.PolarisTabs = { showSnackbar: vi.fn(), attachSwipeToDismiss: vi.fn() };
  g.PolarisCharts = { lineChart: () => "" };
  g.PolarisMobile = { user: () => ({ permissions: perms }) };
  g.mobileFormatDate = (s: any) => String(s ?? "");
  g.timeAgo = () => "1m ago";
  const known: Record<string, any> = {
    get: vi.fn(async (id: string) => JSON.parse(JSON.stringify(ASSETS[id]))),
    update: vi.fn(async (_id: string, body: any) => ({ ...body })),
    ipCheck: vi.fn(async () => ({ wouldConflict: false, holders: [] })),
    addressCheck: vi.fn(async () => ({ warn: false })),
    agent: vi.fn(async () => null),
    effectiveMonitorSettings: vi.fn(async () => ({
      resolved: { intervalSeconds: 60, probeTimeoutMs: 5000 },
      provenance: { intervalSeconds: "class", probeTimeoutMs: "asset" },
      downDetection: { passive: false, missedPolls: 3, recoveryPolls: 1, automationName: "Down detection" },
    })),
    maintenanceInfo: vi.fn(async () => ({
      openWindows: [],
      schedules: [{ id: "s1", name: "Patch night", enabled: true, activeNow: false, nextStart: null, removable: true }],
      inMaintenance: true,
    })),
    ...extra,
  };
  api = {
    assets: new Proxy(known, { get: (t, k: string) => (k in t ? t[k] : async () => ({})) }),
    serverSettings: {
      tagCatalog: vi.fn(async () => ({ tags: [{ name: "prod", category: "Env", color: "#22aa55" }, { name: "azure:owner", color: "" }] })),
      listMibs: vi.fn(async () => []),
    },
    assetTypes: { list: vi.fn(async () => []) },
    credentials: { list: vi.fn(async () => [{ id: "c-rest-old", name: "METRO REST (old)", type: "restapi" }, { id: "c-snmp", name: "Branch SNMP", type: "snmp" }]) },
    maintenanceSchedules: {
      delete: vi.fn(async () => ({})),
      removeAsset: vi.fn(async () => ({ scheduleDeleted: false })),
    },
  };
  g.api = api;
  // Plain globals, as the page's classic <script> tags leave them.
  (0, eval)(POLLING_SRC);
  (0, eval)(DOWN_AFTER_SRC);
  delete g.PolarisAssetDetail;
  delete g.PolarisAssetEdit;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(DETAIL_SRC)();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(EDIT_SRC)();
}

async function openAsset(id: string) {
  g.PolarisAssetDetail.open(id);
  await flush();
}
async function openMenu(id: string) {
  await openAsset(id);
  (document.getElementById("asset-sheet-name-btn") as HTMLButtonElement).click();
  await flush();
}
const menuItem = (key: string) => document.querySelector(`#asset-edit-menu [data-tab="${key}"]`) as HTMLButtonElement;
async function openTab(id: string, key: string) {
  await openMenu(id);
  menuItem(key).click();
  await flush();
}
const $ = (id: string) => document.getElementById(id) as any;
async function save() { $("ae-save").click(); await flush(); }
async function answer(ok: boolean) {
  const b = $(ok ? "ae-confirm-ok" : "ae-confirm-cancel");
  expect(b).toBeTruthy();
  b.click();
  await flush();
}

const WRITER = { assets: "write", maintenanceManagement: "write" };

beforeEach(() => boot(WRITER));

describe("the name opens the edit menu", () => {
  it("lists the desktop Edit Asset modal's tabs, in its order", async () => {
    const m = /async function openEditModal[\s\S]*?var body = tabbedBodyHTML\("asset-edit", editTabs\)/.exec(ASSETS_SRC);
    expect(m).toBeTruthy();
    const desktop = [...m![0].matchAll(/key: "([a-z]+)"/g)].map((x) => x[1]);
    expect(desktop).toEqual(["general", "monitoring", "maintenance"]);
    expect(g.PolarisAssetEdit.TABS).toEqual(desktop);

    await openMenu("srv");
    const items = [...document.querySelectorAll("#asset-edit-menu .ae-menu-item")].map((b) => b.getAttribute("data-tab"));
    expect(items).toEqual(desktop);
    expect($("asset-edit-menu").textContent).toContain("SERVER-1");
  });

  it("is disabled until the row has loaded", async () => {
    boot(WRITER, { get: vi.fn(() => new Promise(() => { /* never */ })) });
    g.PolarisAssetDetail.open("srv");
    await flush();
    expect($("asset-sheet-name-btn").disabled).toBe(true);
  });

  it("a read-only viewer gets Maintenance only; the others say why", async () => {
    boot({ assets: "read" });
    await openMenu("srv");
    expect(menuItem("general").disabled).toBe(true);
    expect(menuItem("monitoring").disabled).toBe(true);
    expect(menuItem("general").textContent).toContain("Needs Read-Write on Assets");
    expect(menuItem("maintenance").disabled).toBe(false);
  });

  it("closing the asset sheet closes the edit sheets with it", async () => {
    await openTab("srv", "general");
    expect($("asset-edit-sheet")).toBeTruthy();
    $("asset-sheet-close").click();
    expect($("asset-edit-sheet")).toBeNull();
  });
});

describe("General sheet", () => {
  it("re-reads the asset and saves the desktop's General payload — and only it", async () => {
    await openTab("srv", "general");
    expect(api.assets.get).toHaveBeenCalledTimes(2);   // the sheet behind, then the edit sheet
    // The Arc-owned tag is never offered; a tag the registry lacks is kept, ticked.
    expect($("ae-tags").textContent).not.toContain("azure:owner");
    expect($("ae-tags").textContent).toContain("Not in tag list");
    $("ae-notes").value = "";
    $("ae-department").value = "Infra";
    await save();
    expect(api.assets.update).toHaveBeenCalledTimes(1);
    const [id, body] = api.assets.update.mock.calls[0];
    expect(id).toBe("srv");
    expect(body).toMatchObject({
      hostname: "SERVER-1", ipAddress: "10.0.0.5", location: "DC1 rack 4", notes: "", description: "b:Shop",
      department: "Infra", assetType: "server", status: "active", latitude: null, longitude: null,
    });
    expect(body.tags.sort()).toEqual(["auto-discovered", "prod"]);
    expect(Object.keys(body).some((k) => /Polling|CredentialId|monitored/.test(k))).toBe(false);
    // Unchanged address: no duplicate or confidence question.
    expect(api.assets.ipCheck).not.toHaveBeenCalled();
    expect(api.assets.addressCheck).not.toHaveBeenCalled();
    // Saved → the sheet closes and the asset sheet re-reads.
    expect($("asset-edit-sheet")).toBeNull();
    expect(api.assets.get).toHaveBeenCalledTimes(3);
  });

  it("a half-filled coordinate pair is refused before anything is sent", async () => {
    await openTab("srv", "general");
    $("ae-latitude").value = "40.1";
    await save();
    expect(api.assets.update).not.toHaveBeenCalled();
    expect($("ae-error").hidden).toBe(false);
    expect($("ae-error").textContent).toContain("both");
  });

  it("a new address that another asset holds asks first; no means no save", async () => {
    boot(WRITER, {
      ipCheck: vi.fn(async () => ({ wouldConflict: true, holders: [{ assetId: "x", hostname: "OTHER-9", claimCurrent: true }] })),
    });
    await openTab("srv", "general");
    $("ae-ipAddress").value = "10.0.0.9";
    await save();
    expect($("ae-confirm-sheet").textContent).toContain("OTHER-9");
    await answer(false);
    expect(api.assets.update).not.toHaveBeenCalled();
    await save();
    await answer(true);
    expect(api.assets.update).toHaveBeenCalledTimes(1);
    expect(api.assets.update.mock.calls[0][1].ipAddress).toBe("10.0.0.9");
  });

  it("a low-confidence typed address is questioned with the probe on (rule 103)", async () => {
    boot(WRITER, {
      addressCheck: vi.fn(async () => ({ warn: true, evidenceBand: "very-low", evidenceScore: 0.1, warnBelow: 0.4, parts: [], probe: { answered: false } })),
    });
    await openTab("srv", "general");
    $("ae-ipAddress").value = "10.0.0.77";
    await save();
    expect(api.assets.addressCheck).toHaveBeenCalledWith("srv", "10.0.0.77", true);
    expect($("ae-confirm-sheet").textContent).toContain("never seen this address");
    await answer(false);
    expect(api.assets.update).not.toHaveBeenCalled();
  });

  it("discovered Fortinet infrastructure keeps its type locked", async () => {
    await openTab("fw", "general");
    expect($("ae-assetType").disabled).toBe(true);
  });
});

describe("Monitoring sheet", () => {
  it("offers exactly the desktop's methods per stream (polling-methods.js)", async () => {
    await openTab("fw", "monitoring");
    const offered = [...$("ae-cpuMemoryPolling").options].map((o: any) => o.value).filter(Boolean);
    const allowed = g._streamAllowedMethods("fortigate", "telemetry").filter((m: string) => m !== "icmp");
    expect(offered).toEqual(allowed);
  });

  it("keeps a stored credential behind Inherit visible, and saves it", async () => {
    await openTab("srv", "monitoring");
    expect($("ae-responseTimeCredentialId-wrap").hidden).toBe(false);
    expect($("ae-responseTimeCredentialId").innerHTML).toContain("METRO REST (old) (restapi)");
    await save();
    const body = api.assets.update.mock.calls[0][1];
    expect(body.responseTimeCredentialId).toBe("c-rest-old");
    expect(body.monitored).toBe(true);
    expect(body).not.toHaveProperty("storageCredentialId");
    expect(Object.keys(body).some((k) => ["hostname", "tags", "status", "notes"].includes(k))).toBe(false);
  });

  it("names the inherited tier and the automation that declares Down", async () => {
    await openTab("srv", "monitoring");
    expect($("ae-tier-intervalSeconds").textContent).toContain("class override: 60 s");
    expect($("ae-down-detection").textContent).toContain("3 missed polls");
    expect($("ae-down-detection").textContent).toContain("Down detection");
  });

  it("a status that is never polled disables monitoring (rule 10)", async () => {
    await openTab("gone", "monitoring");
    expect($("ae-monitored").disabled).toBe(true);
    expect($("ae-monitored").checked).toBe(false);
    expect($("ae-monitored-blocked").textContent).toContain("decommissioned");
  });

  it("an active agent owns the streams: no polling fields are drawn or sent", async () => {
    boot(WRITER, { agent: vi.fn(async () => ({ installStatus: "active", agentVersion: "1.2.3" })) });
    await openTab("srv", "monitoring");
    expect($("ae-transport")).toBeNull();
    await save();
    const body = api.assets.update.mock.calls[0][1];
    expect(Object.keys(body).some((k) => /Polling$|CredentialId$|MibId$/.test(k))).toBe(false);
  });
});

describe("Maintenance sheet", () => {
  function stubMaintHelpers() {
    g.maintCreateAdhoc = vi.fn(async () => ({}));
    g.maintValidateAdhocEnd = vi.fn((v: string) => (v ? { ok: true, value: v.slice(0, 16) } : { ok: false, error: "Pick the date AND time." }));
    g.maintLocalIso = (d: Date) => d.toISOString().slice(0, 16);
    g.maintServerNow = () => new Date("2026-10-12T10:00:00Z");
    g.maintLoadServerClock = vi.fn(async () => undefined);
    g.maintServerClockLabel = () => "America/Chicago";
  }

  it("enters maintenance through the desktop's ad-hoc helper", async () => {
    stubMaintHelpers();
    await openTab("srv", "maintenance");
    expect($("ae-maint-until").value).toBe("2026-10-12T12:00");   // server now + 2h
    $("ae-maint-suppress").checked = false;
    await save();
    expect(g.maintCreateAdhoc).toHaveBeenCalledWith("srv", "SERVER-1", "2026-10-12T12:00", { suppressChildren: false });
    expect(g.PolarisTabs.showSnackbar).toHaveBeenCalledWith("Maintenance mode active", undefined);
  });

  it("refuses an empty end time with the validator's reason", async () => {
    stubMaintHelpers();
    await openTab("srv", "maintenance");
    $("ae-maint-until").value = "";
    await save();
    expect(g.maintCreateAdhoc).not.toHaveBeenCalled();
    expect($("ae-error").textContent).toContain("date AND time");
  });

  it("removes the asset from a covering schedule after a confirm", async () => {
    stubMaintHelpers();
    await openTab("srv", "maintenance");
    (document.querySelector('[data-maint-act="remove"]') as HTMLButtonElement).click();
    await flush();
    await answer(true);
    expect(api.maintenanceSchedules.removeAsset).toHaveBeenCalledWith("s1", "srv");
  });

  it("without maintenanceManagement:write it shows the schedules, no actions", async () => {
    boot({ assets: "read" });
    await openTab("srv", "maintenance");
    expect($("ae-maint-info").textContent).toContain("Patch night");
    expect(document.querySelector("[data-maint-act]")).toBeNull();
    expect($("ae-maint-until")).toBeNull();
    expect($("ae-save")).toBeNull();
  });
});

describe("mirrors of desktop constants", () => {
  const grab = (src: string, re: RegExp) => { const m = re.exec(src); expect(m, String(re)).toBeTruthy(); return m![1]; };
  const norm = (s: string) => s.replace(/\s+/g, " ").replace(/,\s*([\]}])/g, "$1").trim();

  it("unmonitorable statuses (rule 10)", () => {
    expect(norm(grab(EDIT_SRC, /var UNMONITORABLE_STATUSES = (\[[^\]]*\])/)))
      .toBe(norm(grab(ASSETS_SRC, /var UNMONITORABLE_STATUSES = (\[[^\]]*\])/)));
  });
  it("description device caps", () => {
    const re = /var DESCRIPTION_DEVICE_TARGETS = (\{[\s\S]*?\n\s*\});/;
    expect(norm(grab(EDIT_SRC, re))).toBe(norm(grab(ASSETS_SRC, re)));
  });
  it("the type lock", () => {
    const body = (src: string) => norm(grab(src, /function isAssetTypeLocked\((?:asset|a)\) \{([\s\S]*?)\n\s*\}/).replace(/\basset\b/g, "a"));
    expect(body(EDIT_SRC)).toBe(body(ASSETS_SRC));
  });
  it("the asset type seed", () => {
    const vals = (src: string, re: RegExp) => [...grab(src, re).matchAll(/value: "([a-z_]+)"/g)].map((m) => m[1]);
    expect(vals(EDIT_SRC, /var ASSET_TYPE_SEED = (\[[\s\S]*?\]);/))
      .toEqual(vals(ASSETS_SRC, /var ASSET_TYPE_OPTIONS = (\[[\s\S]*?\]);/));
  });
});
