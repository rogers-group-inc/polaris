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
  new Function(ALERTS_SRC)();
  new Function(LIST_CONTROLS_SRC)();
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

const PREFS_KEY = "polaris-mobile-alerts-list-v2";

// Most cases read the WHOLE list, so they start with no severity filter; the
// shipped default (Critical + Serious + Warning) has its own describe below.
beforeEach(() => {
  document.body.innerHTML = "";
  try { localStorage.clear(); } catch { /* happy-dom always has it */ }
  localStorage.setItem(PREFS_KEY, JSON.stringify({ severity: [] }));
});

describe("alerts tab default severities", () => {
  beforeEach(() => { localStorage.clear(); });

  it("opens on Critical, Serious and Warning, hiding Info and Notice", async () => {
    await render();
    expect(shownIds()).toEqual(["ERROR · core-1", "WARNING · sw-2", "CRITICAL · fw-1"]);
    // Named on the chip, and the tiles say which are on.
    expect(document.getElementById("alerts-sort")!.textContent!.trim()).toBe("Time · 3 severities");
    const on = Array.from(document.querySelectorAll("#alerts-summary .sev-tile.selected")).map((t) => (t as HTMLElement).dataset.sev);
    // Serious is picked with nothing in it, so it is drawn at 0 — a picked
    // tile stays reachable to un-pick.
    expect(on).toEqual(["5", "4", "3"]);
    expect((document.querySelector('#alerts-summary [data-sev="4"] .sev-count') as HTMLElement).textContent).toBe("0");
    // Info is still counted, so the hidden alert is a tap away.
    expect(document.querySelector('#alerts-summary [data-sev="2"]')).not.toBeNull();
  });

  it("ignores a pick saved under the old key", async () => {
    localStorage.setItem("polaris-mobile-alerts-list", JSON.stringify({ severity: [] }));
    await render();
    expect(shownIds()).toHaveLength(3);
  });

  it("'Any' in the sheet clears the default, and that choice sticks", async () => {
    await render();
    (document.getElementById("alerts-sort") as HTMLElement).click();
    (document.querySelector('#list-sort-sheet [data-filter="severity"][data-value=""]') as HTMLElement).click();
    expect(shownIds()).toHaveLength(4);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).severity).toEqual([]);
  });
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
    expect(JSON.parse(localStorage.getItem("polaris-mobile-alerts-list-v2")!).state).toBe("unack");
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

describe("alerts tab loads more as it scrolls", () => {
  // `count` active alerts, newest first; the mock honours limit + offset the
  // way the endpoint does.
  function many(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: "n" + i,
      severity: "warning",
      message: "m" + i,
      assetHostname: "h" + i,
      triggeredAt: new Date(Date.UTC(2026, 9, 5) - i * 60000).toISOString(),
      acknowledged: false,
    }));
  }
  async function renderPaged(all: any[], observer?: boolean, failPaged?: boolean) {
    document.body.innerHTML = '<div id="app"><main class="app-body" id="app-body"></main></div>';
    const list = vi.fn(async (p: any) => {
      const off = p.offset || 0;
      if (failPaged && off) throw new Error("boom");
      return { notifications: all.slice(off, off + p.limit).map((r) => ({ ...r })), total: all.length };
    });
    g.api = { alerts: { list, acknowledge: vi.fn(), clear: vi.fn() } };
    const watched: any[] = [];
    if (observer) {
      g.IntersectionObserver = class {
        cb: any;
        constructor(cb: any) { this.cb = cb; watched.push(this); }
        observe(el: any) { this.cb([{ isIntersecting: true, target: el }]); }
        disconnect() { /* nothing to release */ }
      };
    }
    const tab = load();
    tab._reset();
    await tab.spec.render(document.getElementById("app-body")!, { route: { name: "alerts", parts: [] }, user: { permissions: { alerts: "read" } } });
    await new Promise((r) => setTimeout(r, 0));
    return { tab, list, watched };
  }
  const rowCount = () => document.querySelectorAll(".alert-row").length;
  const more = () => document.getElementById("alerts-load-more") as HTMLButtonElement | null;
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => { delete g.IntersectionObserver; });

  it("draws 50 rows at first, and Load more draws the next 50 without a fetch", async () => {
    const { list } = await renderPaged(many(120));
    expect(rowCount()).toBe(50);
    expect(more()!.textContent).toContain("70 remaining");
    more()!.click();
    expect(rowCount()).toBe(100);
    more()!.click();
    expect(rowCount()).toBe(120);
    expect(more()).toBeNull();
    expect(document.querySelector(".list-count")!.textContent).toBe("120 alerts");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("fetches the next page of 500 once every fetched row is drawn", async () => {
    const { list } = await renderPaged(many(620));
    for (let i = 0; i < 9; i++) more()!.click();
    expect(rowCount()).toBe(500);
    expect(list).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".list-count")!.textContent).toBe("500 alerts · newest 500 of 620 active");
    more()!.click();
    await flush();
    expect(list).toHaveBeenLastCalledWith({ limit: 500, offset: 500 });
    expect(rowCount()).toBe(550);
    expect(document.querySelector(".list-count")!.textContent).toBe("620 alerts");
  });

  it("a refresh re-fetches every loaded page, so the list does not shrink", async () => {
    const { tab, list } = await renderPaged(many(620));
    for (let i = 0; i < 10; i++) { more()!.click(); await flush(); }
    list.mockClear();
    await tab.spec.onPullToRefresh();
    expect(list.mock.calls.map((c: any[]) => c[0])).toEqual([{ limit: 500 }, { limit: 500, offset: 500 }]);
    expect(document.querySelector(".list-count")!.textContent).toBe("620 alerts");
  });

  it("drops a row that two pages both returned", async () => {
    const all = many(520);
    const { list } = await renderPaged(all);
    // An alert fired between the fetches: the second page starts one early.
    list.mockImplementationOnce(async () => ({ notifications: all.slice(499, 520), total: 520 }));
    for (let i = 0; i < 10; i++) { more()!.click(); await flush(); }
    expect(document.querySelector(".list-count")!.textContent).toBe("520 alerts");
  });

  it("a filter change starts the drawn window over", async () => {
    await renderPaged(many(120));
    more()!.click();
    expect(rowCount()).toBe(100);
    (document.querySelector('#alerts-chips [data-key="unack"]') as HTMLElement).click();
    expect(rowCount()).toBe(50);
  });

  it("scrolling the button into view loads more on its own", async () => {
    // The fake observer reports the button visible on every observe(), as a
    // short list would — so it keeps going until nothing is left.
    await renderPaged(many(120), true);
    expect(rowCount()).toBe(120);
    expect(more()).toBeNull();
  });

  it("stops loading on its own after a failed page, until a tap", async () => {
    // The observer draws all 500 by itself, then asks for page two, which fails.
    const { list } = await renderPaged(many(520), true, true);
    for (let i = 0; i < 5; i++) await flush();
    expect(rowCount()).toBe(500);
    const paged = () => list.mock.calls.filter((c: any[]) => c[0].offset).length;
    expect(paged()).toBe(1);
    expect(g.PolarisTabs.showSnackbar).toHaveBeenCalledWith("boom", { error: true });
    expect(more()!.disabled).toBe(false);
    // A tap tries again.
    more()!.click();
    await flush();
    expect(paged()).toBe(2);
  });
});

const REGIONAL = [
  { id: "r1", severity: "critical", message: "down", assetId: "a1", assetHostname: "east-fw", triggeredAt: "2026-10-05T10:00:00Z", acknowledged: false, regionTags: ["East"] },
  { id: "r2", severity: "critical", message: "down", assetId: "a2", assetHostname: "west-fw", triggeredAt: "2026-10-05T09:00:00Z", acknowledged: false, regionTags: ["West"] },
  { id: "r3", severity: "warning",  message: "cpu",  assetId: "a3", assetHostname: "lab-sw",  triggeredAt: "2026-10-05T08:00:00Z", acknowledged: false, regionTags: [] },
  { id: "r4", severity: "warning",  message: "backup failed", assetId: null, assetHostname: null, triggeredAt: "2026-10-05T07:00:00Z", acknowledged: false, regionTags: [] },
];
const EAST_USER = { regions: ["East"], permissions: { alerts: "write" } };

describe("alerts tab region scope", () => {
  it("'mine' keeps my regions and device-less system alerts, not untagged devices", () => {
    const tab = load();
    expect(tab.filterRows(REGIONAL, "", "all", [], ["east"]).map((r: any) => r.id)).toEqual(["r1", "r4"]);
    expect(tab.filterRows(REGIONAL, "", "all", [], null).map((r: any) => r.id)).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("defaults a regional viewer to My regions, named on the chip", async () => {
    await render(REGIONAL, undefined, EAST_USER);
    expect(shownIds()).toEqual(["CRITICAL · east-fw", "WARNING"]);
    const chip = document.getElementById("alerts-sort")!;
    expect(chip.textContent!.trim()).toBe("Time · My regions");
    expect(chip.classList.contains("selected")).toBe(true);
  });

  it("toggles to All regions in the sheet, and remembers it", async () => {
    await render(REGIONAL, undefined, EAST_USER);
    (document.getElementById("alerts-sort") as HTMLElement).click();
    (document.querySelector('#list-sort-sheet [data-filter="region"][data-value="all"]') as HTMLElement).click();
    expect(shownIds()).toEqual(["CRITICAL · east-fw", "CRITICAL · west-fw", "WARNING · lab-sw", "WARNING"]);
    expect(document.getElementById("alerts-sort")!.textContent!.trim()).toBe("Time");
    expect(JSON.parse(localStorage.getItem("polaris-mobile-alerts-list-v2")!).region).toBe("all");
  });

  it("offers no region choice to a viewer with no regions", async () => {
    await render(REGIONAL);
    expect(shownIds()).toHaveLength(4);
    (document.getElementById("alerts-sort") as HTMLElement).click();
    expect(document.querySelector('#list-sort-sheet [data-filter="region"]')).toBeNull();
    expect(document.getElementById("alerts-sort")!.textContent!.trim()).toBe("Time");
  });
});

describe("alerts tab clear", () => {
  const clearButtons = () => Array.from(document.querySelectorAll("[data-clear]")) as HTMLElement[];

  it("draws Clear only at alertClear:write, outside the row button", async () => {
    await render(ROWS);
    expect(clearButtons()).toHaveLength(0);
    await render(ROWS, undefined, { permissions: { alerts: "write", alertClear: "write" } });
    // Every active alert can be cleared, acknowledged or not.
    expect(clearButtons().map((b) => b.dataset.clear)).toEqual(["c", "a", "b", "d"]);
    expect(document.querySelector(".list-item [data-clear]")).toBeNull();
  });

  it("asks first, then clears and drops the row", async () => {
    await render(ROWS, undefined, { permissions: { alerts: "write", alertClear: "write" } });
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
    await render(ROWS, undefined, { permissions: { alerts: "write", alertClear: "write" } });
    clearButtons()[0]!.click();
    await new Promise((r) => setTimeout(r, 0));
    (document.getElementById("alert-clear-cancel") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(g.api.alerts.clear).not.toHaveBeenCalled();
    expect(clearButtons()).toHaveLength(4);
  });
});

describe("alerts tab severity breakdown", () => {
  const tiles = () =>
    Array.from(document.querySelectorAll("#alerts-summary .sev-tile")).map((t) =>
      `${(t.querySelector(".sev-label") as HTMLElement).textContent} ${(t.querySelector(".sev-count") as HTMLElement).textContent}`);

  it("counts each severity by rank, above the list, skipping empty ones", async () => {
    await render();
    // error + critical are one rank; info is Info; nothing Serious or Notice.
    expect(tiles()).toEqual(["Critical 2", "Warning 1", "Info 1"]);
    const summary = document.getElementById("alerts-summary")!;
    expect(summary.compareDocumentPosition(document.querySelector(".list-toolbar")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a tile toggles the severity filter, and the counts hold still", async () => {
    await render();
    (document.querySelector('#alerts-summary [data-sev="5"]') as HTMLElement).click();
    expect(shownIds()).toEqual(["ERROR · core-1", "CRITICAL · fw-1"]);
    expect(tiles()).toEqual(["Critical 2", "Warning 1", "Info 1"]);
    expect(document.querySelector('#alerts-summary [data-sev="5"]')!.classList.contains("selected")).toBe(true);
    expect(document.getElementById("alerts-sort")!.textContent!.trim()).toBe("Time · Critical");
    (document.querySelector('#alerts-summary [data-sev="5"]') as HTMLElement).click();
    expect(shownIds()).toHaveLength(4);
  });

  it("follows the other filters — ack state and region", async () => {
    await render();
    (document.querySelector('#alerts-chips [data-key="unack"]') as HTMLElement).click();
    expect(tiles()).toEqual(["Critical 1", "Warning 1", "Info 1"]);
    await render(REGIONAL, undefined, EAST_USER);
    expect(tiles()).toEqual(["Critical 1", "Warning 1"]);
  });

  it("is hidden when nothing is active", async () => {
    await render([]);
    expect(document.getElementById("alerts-summary")!.classList.contains("hidden")).toBe(true);
  });
});

describe("mobile navbar", () => {
  it("is Alerts · Assets · Networks · More, and the map lives under More", () => {
    g.PolarisAlertsTab = { spec: { title: "Alerts" } };
    new Function(TABS_SRC)();
    expect(g.PolarisTabs.list.map((t: any) => t.id)).toEqual(["alerts", "assets", "networks", "more"]);
    // #map still resolves, and lights More.
    expect(g.PolarisTabs.byId("map")).toBeTruthy();
    expect(g.PolarisTabs.navTabFor("map")).toBe("more");
    expect(g.PolarisTabs.navTabFor("assets")).toBe("assets");
  });

  it("has no Search slot — #search is a route tab, reached from the search box, that lights nothing", () => {
    new Function(TABS_SRC)();
    expect(g.PolarisTabs.byId("search")).toBeTruthy();
    expect(g.PolarisTabs.navTabFor("search")).toBe("");
  });

  it("opens to Alerts, and bounces an unknown route there", () => {
    const APP_SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "app.js"), "utf-8");
    expect(APP_SRC).toMatch(/if \(!window\.location\.hash\) PolarisRouter\.go\("alerts"/);
    expect(APP_SRC).not.toMatch(/PolarisRouter\.go\("search", \{ replace: true \}\)/);
  });

  it("Chat gets its own slot before More only when switched on — Networks keeps its slot", () => {
    g.PolarisAlertsTab = { spec: { title: "Alerts" } };
    g.PolarisChatTab = { spec: { title: "Chat" } };
    new Function(TABS_SRC)();
    const T = g.PolarisTabs;
    // Off by default: the bar is unchanged, and #chat still resolves (to explain itself) without a slot.
    expect(T.chatInBar()).toBe(false);
    expect(T.byId("chat")).toBeTruthy();
    expect(T.navTabFor("chat")).toBe("");
    expect(T.setChatInBar(true)).toBe(true);
    expect(T.list.map((t: any) => t.id)).toEqual(["alerts", "assets", "networks", "chat", "more"]);
    expect(T.navTabFor("networks")).toBe("networks");
    expect(T.navTabFor("chat")).toBe("chat");
    expect(T.setChatInBar(true)).toBe(false);
    expect(T.setChatInBar(false)).toBe(true);
    expect(T.list.map((t: any) => t.id)).toEqual(["alerts", "assets", "networks", "more"]);
    expect(T.navTabFor("networks")).toBe("networks");
    expect(T.navTabFor("chat")).toBe("");
  });
});
