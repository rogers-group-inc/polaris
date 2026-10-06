/**
 * tests/unit/mobileAlertsTab.test.ts
 *
 * The phone's Alerts tab: filtering and ordering, and its place in the navbar
 * (Search · Alerts · Assets · Networks · More — the Device Map moved under
 * More). Acknowledging is covered by mobileAlertsAckDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(process.cwd(), "public", "js", "mobile", f), "utf-8");
const SRC = read("alerts-tab.js");
const ALERTS_SRC = read("alerts.js");
const LIST_CONTROLS_SRC = read("list-controls.js");
const TABS_SRC = read("tabs.js");

const g = globalThis as any;

const ROWS = [
  { id: "a", severity: "warning",  message: "cpu high",         assetHostname: "sw-2",   triggeredAt: "2026-10-05T09:00:00Z", acknowledged: false },
  { id: "b", severity: "critical", message: "device down",      assetHostname: "fw-1",   triggeredAt: "2026-10-05T08:00:00Z", acknowledged: true, acknowledgedBy: "jsmith" },
  { id: "c", severity: "error",    message: "packet loss 40%",  assetHostname: "core-1", triggeredAt: "2026-10-05T10:00:00Z", acknowledged: false },
  { id: "d", severity: "info",     message: "config changed",   assetHostname: null,     triggeredAt: "2026-10-05T07:00:00Z", acknowledged: false },
];

function load() {
  g.escapeHtml = (s: any) => String(s ?? "");
  g.timeAgo = () => "just now";
  g.PolarisRouter = { go: vi.fn() };
  g.PolarisTabs = { showSnackbar: vi.fn(), attachSwipeToDismiss: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(ALERTS_SRC)();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(LIST_CONTROLS_SRC)();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
  return g.PolarisAlertsTab;
}

async function render(rows: any[] = ROWS, total?: number, user: any = { permissions: { alerts: "write" } }) {
  document.body.innerHTML = '<div id="app"><main class="app-body" id="app-body"></main></div>';
  g.api = {
    alerts: {
      list: vi.fn(async () => ({ notifications: rows.map((r) => ({ ...r })), total: total ?? rows.length })),
      acknowledge: vi.fn(),
      clear: vi.fn(async (ids: string[]) => { rows = rows.filter((r) => !ids.includes(r.id)); return { cleared: ids.length }; }),
    },
  };
  const tab = load();
  await tab.spec.render(document.getElementById("app-body")!, { route: { name: "alerts", parts: [] }, user });
  await new Promise((r) => setTimeout(r, 0));
  return tab;
}

const shownIds = () =>
  Array.from(document.querySelectorAll(".alert-row [data-ack], .alert-row .list-item"))
    .filter((el) => el.classList.contains("list-item"))
    .map((el) => (el.querySelector(".headline") as HTMLElement).textContent);

beforeEach(() => {
  document.body.innerHTML = "";
  try { localStorage.clear(); } catch { /* happy-dom always has it */ }
});

describe("alerts tab ordering", () => {
  it("defaults to newest first", async () => {
    await render();
    expect(shownIds()).toEqual(["ERROR · core-1", "WARNING · sw-2", "CRITICAL · fw-1", "INFO"]);
  });

  it("ranks severity by rank, not by the text (critical/error above warning)", () => {
    const tab = load();
    const out = tab.sortRows(ROWS, "severity", "desc").map((r: any) => r.id);
    // c (error) and b (critical) share rank 5 — the newer one first.
    expect(out).toEqual(["c", "b", "a", "d"]);
  });

  it("sorts by device with deviceless alerts last in both directions", () => {
    const tab = load();
    expect(tab.sortRows(ROWS, "device", "asc").map((r: any) => r.id)).toEqual(["c", "b", "a", "d"]);
    expect(tab.sortRows(ROWS, "device", "desc").map((r: any) => r.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("alerts tab filtering", () => {
  it("narrows on every typed term across device and message", () => {
    const tab = load();
    expect(tab.filterRows(ROWS, "loss", "all", []).map((r: any) => r.id)).toEqual(["c"]);
    expect(tab.filterRows(ROWS, "fw down", "all", []).map((r: any) => r.id)).toEqual(["b"]);
    expect(tab.filterRows(ROWS, "fw cpu", "all", [])).toEqual([]);
  });

  it("filters by acknowledgement state", () => {
    const tab = load();
    expect(tab.filterRows(ROWS, "", "unack", []).map((r: any) => r.id)).toEqual(["a", "c", "d"]);
    expect(tab.filterRows(ROWS, "", "ack", []).map((r: any) => r.id)).toEqual(["b"]);
  });

  it("filters severity by rank, so Critical catches 'error' too", () => {
    const tab = load();
    expect(tab.filterRows(ROWS, "", "all", ["5"]).map((r: any) => r.id)).toEqual(["b", "c"]);
    expect(tab.filterRows(ROWS, "", "all", ["5", "3"]).map((r: any) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("the Unacknowledged chip narrows the list and is remembered", async () => {
    await render();
    (document.querySelector('#alerts-chips [data-key="unack"]') as HTMLElement).click();
    expect(shownIds()).not.toContain("CRITICAL · fw-1");
    expect(document.querySelector(".list-count")!.textContent).toBe("3 of 4 alerts");
    expect(JSON.parse(localStorage.getItem("polaris-mobile-alerts-list")!).state).toBe("unack");
  });

  it("the sort sheet picks severity order and a severity filter, and marks the chip", async () => {
    await render();
    (document.getElementById("alerts-sort") as HTMLElement).click();
    (document.querySelector('#list-sort-sheet [data-sort="severity"]') as HTMLElement).click();
    expect(shownIds()[0]).toBe("ERROR · core-1");
    (document.querySelector('#list-sort-sheet [data-filter="severity"][data-value="5"]') as HTMLElement).click();
    expect(shownIds()).toEqual(["ERROR · core-1", "CRITICAL · fw-1"]);
    const chip = document.getElementById("alerts-sort")!;
    expect(chip.classList.contains("selected")).toBe(true);
    // A filter hidden in the sheet is named on the chip.
    expect(chip.textContent).toBe("Severity · Critical");
  });

  it("says when more alerts are active than were loaded", async () => {
    await render(ROWS, 812);
    expect(document.querySelector(".list-count")!.textContent).toBe("4 alerts · newest 4 of 812 active");
  });
});

const REGIONAL = [
  { id: "r1", severity: "critical", message: "down", assetHostname: "east-fw", triggeredAt: "2026-10-05T10:00:00Z", acknowledged: false, regionTags: ["East"] },
  { id: "r2", severity: "critical", message: "down", assetHostname: "west-fw", triggeredAt: "2026-10-05T09:00:00Z", acknowledged: false, regionTags: ["West"] },
  { id: "r3", severity: "warning",  message: "cpu",  assetHostname: "lab-sw",  triggeredAt: "2026-10-05T08:00:00Z", acknowledged: false, regionTags: [] },
];
const EAST_USER = { regions: ["East"], permissions: { alerts: "write" } };

describe("alerts tab region scope", () => {
  it("'mine' keeps my regions AND untagged alerts — the server's own viewer scope", () => {
    const tab = load();
    expect(tab.filterRows(REGIONAL, "", "all", [], ["east"]).map((r: any) => r.id)).toEqual(["r1", "r3"]);
    expect(tab.filterRows(REGIONAL, "", "all", [], null).map((r: any) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("defaults a regional viewer to My regions, named on the chip", async () => {
    await render(REGIONAL, undefined, EAST_USER);
    expect(shownIds()).toEqual(["CRITICAL · east-fw", "WARNING · lab-sw"]);
    const chip = document.getElementById("alerts-sort")!;
    expect(chip.textContent!.trim()).toBe("Time · My regions");
    expect(chip.classList.contains("selected")).toBe(true);
  });

  it("toggles to All regions in the sheet, and remembers it", async () => {
    await render(REGIONAL, undefined, EAST_USER);
    (document.getElementById("alerts-sort") as HTMLElement).click();
    (document.querySelector('#list-sort-sheet [data-filter="region"][data-value="all"]') as HTMLElement).click();
    expect(shownIds()).toEqual(["CRITICAL · east-fw", "CRITICAL · west-fw", "WARNING · lab-sw"]);
    expect(document.getElementById("alerts-sort")!.textContent!.trim()).toBe("Time");
    expect(JSON.parse(localStorage.getItem("polaris-mobile-alerts-list")!).region).toBe("all");
  });

  it("offers no region choice to a viewer with no regions", async () => {
    await render(REGIONAL);
    expect(shownIds()).toHaveLength(3);
    (document.getElementById("alerts-sort") as HTMLElement).click();
    expect(document.querySelector('#list-sort-sheet [data-filter="region"]')).toBeNull();
    expect(document.getElementById("alerts-sort")!.textContent!.trim()).toBe("Time");
  });
});

describe("alerts tab clear", () => {
  const clearButtons = () => Array.from(document.querySelectorAll("[data-clear]")) as HTMLElement[];

  it("draws Clear only at alerts:fullwrite, outside the row button", async () => {
    await render(ROWS);
    expect(clearButtons()).toHaveLength(0);
    await render(ROWS, undefined, { permissions: { alerts: "fullwrite" } });
    // Every active alert can be cleared, acknowledged or not.
    expect(clearButtons().map((b) => b.dataset.clear)).toEqual(["c", "a", "b", "d"]);
    expect(document.querySelector(".list-item [data-clear]")).toBeNull();
  });

  it("asks first, then clears and drops the row", async () => {
    await render(ROWS, undefined, { permissions: { alerts: "fullwrite" } });
    clearButtons()[0]!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(g.api.alerts.clear).not.toHaveBeenCalled();
    (document.getElementById("alert-clear-ok") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(g.api.alerts.clear).toHaveBeenCalledWith(["c"]);
    expect(g.PolarisTabs.showSnackbar).toHaveBeenCalledWith("Alert cleared", undefined);
    expect(shownIds()).not.toContain("ERROR · core-1");
    expect(g.PolarisRouter.go).not.toHaveBeenCalled();
  });

  it("sends nothing when the confirm is cancelled", async () => {
    await render(ROWS, undefined, { permissions: { alerts: "fullwrite" } });
    clearButtons()[0]!.click();
    await new Promise((r) => setTimeout(r, 0));
    (document.getElementById("alert-clear-cancel") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(g.api.alerts.clear).not.toHaveBeenCalled();
    expect(clearButtons()).toHaveLength(4);
  });
});

describe("mobile navbar", () => {
  it("is Search · Alerts · Assets · Networks · More, and the map lives under More", () => {
    g.PolarisAlertsTab = { spec: { title: "Alerts" } };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(TABS_SRC)();
    expect(g.PolarisTabs.list.map((t: any) => t.id)).toEqual(["search", "alerts", "assets", "networks", "more"]);
    // #map still resolves, and lights More.
    expect(g.PolarisTabs.byId("map")).toBeTruthy();
    expect(g.PolarisTabs.navTabFor("map")).toBe("more");
    expect(g.PolarisTabs.navTabFor("assets")).toBe("assets");
  });
});
