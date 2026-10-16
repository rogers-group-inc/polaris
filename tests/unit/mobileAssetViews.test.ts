/**
 * tests/unit/mobileAssetViews.test.ts
 *
 * The phone's Assets tab shows the desktop Assets page's VIEW TABS — the same
 * server-persisted layout (GET /me/table-tabs?scope=assets) — and each tab's
 * favorites. What's pinned:
 *
 *   - applyViewState is a mirror of the filter half of the desktop's
 *     _buildAssetsQuery + _pushAssetText (assets.js, which the phone does not
 *     load): both run over the same tab states and must agree param for param;
 *   - the tabs render as a strip, the desktop's activeId is the first pick,
 *     the phone's own pick is remembered locally and never PUT back;
 *   - the showing tab's filters, sort and favoriteIds ride the list request,
 *     and the phone's type chip / sheet sort override the field they speak to;
 *   - a star toggles that tab's favoriteIds through a fresh read + whole-layout
 *     PUT, and puts itself back when the save fails;
 *   - no tabs (or no tableTabs client) leaves the plain list unchanged.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TAB_SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "assets-tab.js"), "utf-8");
const LIST_SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "list-controls.js"), "utf-8");
const DESKTOP_SRC = readFileSync(join(process.cwd(), "public", "js", "assets.js"), "utf-8");

const g = globalThis as any;
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A top-level `function name(...) {...}` declaration lifted out of assets.js. */
function desktopFn(name: string): string {
  const start = DESKTOP_SRC.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found in assets.js");
  const end = DESKTOP_SRC.slice(start).search(/\r?\n\}\r?\n/);
  return DESKTOP_SRC.slice(start, start + end) + "\n}\n";
}

/** The desktop's params for one tab state, with paging + favorites stripped. */
function desktopParams(state: any): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const build = new Function(
    "_assetsSF", "_assetsPageSize", "_assetsPage",
    desktopFn("_pushAssetText") + desktopFn("_buildAssetsQuery") + "return _buildAssetsQuery();",
  );
  const sf = { _filters: state.sfFilters || {}, _sortKey: null, _sortDir: null };
  const p = build(sf, 50, 1);
  delete p.limit; delete p.offset;
  return p;
}

const TAB_STATES: any[] = [
  { sfFilters: {} },
  { sfFilters: { assetType: ["firewall", "switch"], status: ["active"], _monitor: ["Down", "Missed"] } },
  { sfFilters: { hostname: "core", ipAddress: { op: "in-networks", terms: ["10.1.", " 10.2.0.0/16 ", ""] } } },
  { sfFilters: { model: "!FG-60", serialNumber: { op: "empty" }, os: { op: "notempty" }, tags: { op: "not-contains", q: " lab " } } },
  { sfFilters: { _server: "vc01", description: "  ", macAddress: "!", dnsName: { op: "not-contains", q: "" } } },
  { sfFilters: { lastSeen: { type: "date", from: "2026-10-01", to: "2026-10-12" }, manufacturer: "Fortinet" } },
  // The Tags column's pick menu: any / all, the "(No tags)" row, and that row alone.
  { sfFilters: { tags: { op: "pick", mode: "any", values: ["prod", "dc,1"], none: true } } },
  { sfFilters: { tags: { op: "pick", mode: "all", values: ["prod", "edge"], none: true } } },
  { sfFilters: { tags: { op: "pick", mode: "any", values: [], none: true } } },
];

let requests: any[] = [];
let saves: any[] = [];
let layout: any = null;

function makeLayout() {
  return {
    version: 1,
    activeId: "t2",
    tabs: [
      { id: "t1", name: "All assets", state: { sfFilters: {}, sortKey: null, sortDir: null }, favoriteIds: [] },
      {
        id: "t2", name: "Firewalls",
        state: { sfFilters: { assetType: ["firewall"], hostname: "fg" }, sortKey: "hostname", sortDir: "asc" },
        favoriteIds: ["a2"],
      },
    ],
  };
}

function mount(opts: { tabs?: boolean; saveFails?: boolean } = {}) {
  document.body.innerHTML =
    '<div id="app"><div id="topbar-slot"></div><main class="app-body" id="app-body"></main></div>';
  requests = [];
  saves = [];
  layout = opts.tabs === false ? { version: 1, tabs: [], activeId: "" } : makeLayout();
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  g.api = {
    assets: {
      list: vi.fn(async (p: any) => {
        requests.push({ ...p });
        return { assets: [{ id: "a1", hostname: "H1", assetType: "firewall" }, { id: "a2", hostname: "H2", assetType: "firewall" }], total: 2 };
      }),
    },
    tableTabs: {
      get: vi.fn(async () => JSON.parse(JSON.stringify(layout))),
      save: vi.fn(async (_scope: string, body: any) => {
        saves.push(JSON.parse(JSON.stringify(body)));
        if (opts.saveFails) throw new Error("save refused");
        layout = { version: 1, ...JSON.parse(JSON.stringify(body)) };
        return JSON.parse(JSON.stringify(layout));
      }),
    },
  };
  g.PolarisRouter = { go: vi.fn() };
  g.PolarisTabs = { showSnackbar: vi.fn(), attachSwipeToDismiss: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(LIST_SRC)();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(TAB_SRC)();
  const spec = g.PolarisAssetsTab.spec;
  document.getElementById("topbar-slot")!.innerHTML = spec.renderTopbar();
  spec.render(document.getElementById("app-body")!);
  return spec;
}

function star(id: string) {
  return document.querySelector('.fav-star-m[data-fav="' + id + '"]') as HTMLButtonElement;
}

describe("mobile Assets view tabs — desktop parity", () => {
  it("maps every tab state onto the same params as the desktop's _buildAssetsQuery", () => {
    mount({ tabs: false });
    const mirror = g.PolarisAssetsTab._applyViewState;
    for (const state of TAB_STATES) {
      expect(mirror({}, state)).toEqual(desktopParams(state));
    }
  });
});

describe("mobile Assets view tabs", () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  it("renders the desktop tabs with the desktop's active tab showing", async () => {
    mount();
    await flush(); await flush();
    const tabs = Array.from(document.querySelectorAll("#assets-views .view-tab"));
    expect(tabs.map((t) => t.textContent!.replace(/\d+$/, ""))).toEqual(["All assets", "Firewalls"]);
    expect((document.getElementById("assets-views") as HTMLElement).hidden).toBe(false);
    expect(document.querySelector(".view-tab.on")!.getAttribute("data-view")).toBe("t2");
  });

  it("sends the showing tab's filters, sort and favorites with the list request", async () => {
    mount();
    await flush(); await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      assetType: "firewall", hostname: "fg", sortBy: "hostname", sortDir: "asc", favoriteIds: "a2", offset: 0,
    });
    expect(document.getElementById("assets-sort")!.textContent).toContain("Name");
  });

  it("lets the phone's own type chip and sheet sort override the tab", async () => {
    mount();
    await flush(); await flush();
    (document.querySelector('#assets-chips .chip[data-key="switch"]') as HTMLButtonElement).click();
    await flush();
    expect(requests[requests.length - 1]).toMatchObject({ assetType: "switch", hostname: "fg" });
    (document.getElementById("assets-sort") as HTMLButtonElement).click();
    (document.querySelector('#list-sort-sheet [data-sort="lastSeen"]') as HTMLButtonElement).click();
    await flush();
    expect(requests[requests.length - 1]).toMatchObject({ sortBy: "lastSeen", sortDir: "desc" });
  });

  it("switches tab locally, remembers it, and never writes the pick back", async () => {
    mount();
    await flush(); await flush();
    (document.querySelector('.view-tab[data-view="t1"]') as HTMLButtonElement).click();
    await flush();
    const last = requests[requests.length - 1];
    expect(last.assetType).toBeUndefined();
    expect(last.favoriteIds).toBeUndefined();
    expect(last.sortBy).toBeUndefined();
    expect(localStorage.getItem("polaris-mobile-assets-view")).toBe("t1");
    expect(saves).toHaveLength(0);

    // A fresh render keeps the phone's pick over the desktop's activeId.
    mount();
    await flush(); await flush();
    expect(document.querySelector(".view-tab.on")!.getAttribute("data-view")).toBe("t1");
  });

  it("stars the showing tab's favorites, and shows which are starred", async () => {
    mount();
    await flush(); await flush();
    expect(star("a2").classList.contains("on")).toBe(true);
    expect(star("a1").classList.contains("on")).toBe(false);
    star("a1").click();
    expect(star("a1").classList.contains("on")).toBe(true);   // optimistic
    await flush(); await flush();
    expect(saves).toHaveLength(1);
    const saved = saves[0].tabs.find((t: any) => t.id === "t2");
    expect(saved.favoriteIds).toEqual(["a2", "a1"]);
    expect(saves[0].activeId).toBe("t2");
    // The other tab's favorites are untouched.
    expect(saves[0].tabs.find((t: any) => t.id === "t1").favoriteIds).toEqual([]);
    expect(star("a1").classList.contains("on")).toBe(true);
  });

  it("re-reads the layout before saving, so a desk-side change is not overwritten", async () => {
    mount();
    await flush(); await flush();
    layout.tabs.push({ id: "t3", name: "Added at the desk", state: { sfFilters: {} }, favoriteIds: [] });
    star("a2").click();
    await flush(); await flush();
    expect(saves[0].tabs.map((t: any) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(saves[0].tabs.find((t: any) => t.id === "t2").favoriteIds).toEqual([]);
  });

  it("puts the star back when the save fails", async () => {
    mount({ saveFails: true });
    await flush(); await flush();
    star("a1").click();
    await flush(); await flush();
    expect(star("a1").classList.contains("on")).toBe(false);
    expect(g.PolarisTabs.showSnackbar).toHaveBeenCalledWith("save refused", { error: true });
  });

  it("pins the view tabs, filter/sort row and type chips in one sticky block above the cards", async () => {
    mount();
    await flush(); await flush();
    const head = document.querySelector("#app-body > .list-sticky-head")!;
    expect(head).toBeTruthy();
    expect(head.querySelector("#assets-views")).toBeTruthy();
    expect(head.querySelector("#assets-filter")).toBeTruthy();
    expect(head.querySelector("#assets-sort")).toBeTruthy();
    expect(head.querySelector("#assets-chips")).toBeTruthy();
    // The cards scroll beneath it, not inside it.
    expect(head.querySelector(".asset-card")).toBeNull();
    expect(document.querySelector("#app-body > #assets-list-host .asset-card")).toBeTruthy();
  });

  it("clears a desk-built filter from the showing tab, keeping its sort, and writes it back", async () => {
    mount();
    await flush(); await flush();
    const chip = document.getElementById("assets-reset-filter") as HTMLButtonElement;
    expect(chip).toBeTruthy();
    expect(chip.textContent).toBe("Clear filters");
    chip.click();
    await flush(); await flush();
    expect(saves).toHaveLength(1);
    expect(saves[0].tabs.find((t: any) => t.id === "t2").state).toEqual({ sfFilters: {}, sortKey: "hostname", sortDir: "asc" });
    // The other tab, the desktop's active pick and the favorites are untouched.
    expect(saves[0].tabs.find((t: any) => t.id === "t1").state.sfFilters).toEqual({});
    expect(saves[0].activeId).toBe("t2");
    expect(saves[0].tabs.find((t: any) => t.id === "t2").favoriteIds).toEqual(["a2"]);
    const last = requests[requests.length - 1];
    expect(last.assetType).toBeUndefined();
    expect(last.hostname).toBeUndefined();
    expect(last).toMatchObject({ sortBy: "hostname", favoriteIds: "a2" });
    // Nothing left to clear, so the chip goes.
    expect(document.getElementById("assets-reset-filter")).toBeNull();
  });

  it("hides the chip on a tab with no filter", async () => {
    localStorage.setItem("polaris-mobile-assets-view", "t1");
    mount();
    await flush(); await flush();
    expect(document.getElementById("assets-reset-filter")).toBeNull();
  });

  it("resets to the tab's base filter when it pins one", async () => {
    mount();
    layout.tabs[1].defaultFilterId = "p1";
    layout.tabs[1].defaultFilterName = "FortiGates";
    layout.tabs[1].defaultState = { sfFilters: { assetType: ["firewall"] }, sortKey: null, sortDir: null };
    (g.PolarisAssetsTab.spec.onPullToRefresh)();
    await flush(); await flush();
    const chip = document.getElementById("assets-reset-filter") as HTMLButtonElement;
    expect(chip.textContent).toBe("Reset filter");
    chip.click();
    await flush(); await flush();
    expect(saves[0].tabs.find((t: any) => t.id === "t2").state).toEqual({ sfFilters: { assetType: ["firewall"] }, sortKey: null, sortDir: null });
    expect(requests[requests.length - 1]).toMatchObject({ assetType: "firewall" });
    expect(requests[requests.length - 1].hostname).toBeUndefined();
    expect(document.getElementById("assets-reset-filter")).toBeNull();
  });

  it("keeps the filter and says so when the reset save fails", async () => {
    mount({ saveFails: true });
    await flush(); await flush();
    (document.getElementById("assets-reset-filter") as HTMLButtonElement).click();
    await flush(); await flush();
    expect(g.PolarisTabs.showSnackbar).toHaveBeenCalledWith("save refused", { error: true });
    const chip = document.getElementById("assets-reset-filter") as HTMLButtonElement;
    expect(chip).toBeTruthy();
    expect(chip.disabled).toBe(false);
  });

  it("with no tabs, the plain list: no strip, no stars, no favorites param", async () => {
    mount({ tabs: false });
    await flush(); await flush();
    expect((document.getElementById("assets-views") as HTMLElement).hidden).toBe(true);
    expect(document.querySelector(".fav-star-m")).toBeNull();
    expect(requests[0].favoriteIds).toBeUndefined();
    expect(requests[0].assetType).toBeUndefined();
  });
});
