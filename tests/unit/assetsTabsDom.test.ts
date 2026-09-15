/**
 * tests/unit/assetsTabsDom.test.ts — DOM smoke for the Assets page view tabs
 * (public/js/assets-tabs.js).
 *
 * Same eval-into-happy-dom idiom as assetsFiltersDom.test.ts. This is the net
 * for the wiring no server test can see: seeding the first tab from the live
 * table, switching tabs applying that tab's state, rename, close, the
 * open-a-preset-in-a-new-tab entry point, the base ("default") filter a tab
 * resets to, the per-tab COLUMN ORDER (which follows the view, unlike widths
 * and hidden columns, which stay per-browser), and — the subtle one — the
 * re-entrancy guard that stops applying a tab from writing the table state
 * back into the tab the operator just left.
 *
 * The real public/js/favorites.js is eval'd alongside it, because per-tab
 * favorites work by REGISTERING a provider for its "assets" entity: the thing
 * worth testing is that the page's own entry points (isFavorite / toggleFavorite
 * / starCellHTML / getFavorites, which is what builds `?favoriteIds=`) resolve
 * to the active tab, so stubbing that seam would test nothing.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
const SRC = readFileSync(resolve(__dirname, "../../public/js/assets-tabs.js"), "utf8");
const FAV_SRC = readFileSync(resolve(__dirname, "../../public/js/favorites.js"), "utf8");

const STRIP_HTML =
  '<div class="table-tabs" id="assets-tabs">' +
    '<div class="table-tabs-list" id="assets-tabs-list"></div>' +
    '<button id="assets-tab-add">+</button>' +
  "</div>";

let doc: Window["document"];
let win: InstanceType<typeof Window>;
let saved: Record<string, unknown>[];
let getResponse: Record<string, unknown> | null;
let liveFilters: Record<string, unknown>;
let liveSort: { key: string | null; dir: string | null };
/** The table's movable-column order, as setupColumnLayout would report it. */
let liveColumnOrder: string[];
/** Every prefs blob the module handed the column layout. */
let layoutSetPrefs: Record<string, unknown>[];
let appliedStates: unknown[];
let refreshes: number;
let repaints: number;
let confirmAnswer: boolean;
/** Pre-provider per-user stars in THIS browser's localStorage, if any. */
let legacyFavorites: string[];
let toasts: string[];

/** Boot a fresh module instance against a fresh DOM. */
async function boot(opts?: { hashSeeded?: boolean }) {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  doc.body.innerHTML = STRIP_HTML;

  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  g.showToast = (msg: string) => { toasts.push(String(msg)); };
  g.showConfirm = async () => confirmAnswer;
  g.api = {
    tableTabs: {
      get:  async () => getResponse,
      save: async (_scope: string, layout: Record<string, unknown>) => { saved.push(layout); return layout; },
    },
  };
  // Stand-ins for assets.js. getPrefs reads the mutable "live" state so a test
  // can simulate the operator typing in a filter box.
  g._assetsSF = {
    getPrefs: () => ({ sfFilters: liveFilters, sortKey: liveSort.key, sortDir: liveSort.dir }),
    applyState: (s: any) => {
      appliedStates.push(s);
      liveFilters = JSON.parse(JSON.stringify(s.sfFilters || {}));
      liveSort = { key: s.sortKey || null, dir: s.sortDir || null };
    },
  };
  // Stand-in for the setupColumnLayout handle assets.js holds. Only `order`
  // matters here — widths/hidden are per-browser and the module must never
  // write them, which is what the setPrefs recorder below proves.
  g._assetsLayout = {
    getPrefs: () => ({ widths: {}, hidden: [], shown: [], order: liveColumnOrder.slice() }),
    setPrefs: (p: any) => {
      layoutSetPrefs.push(p);
      if (Array.isArray(p.order)) liveColumnOrder = p.order.slice();
    },
  };
  g.assetsApplyFilterState = () => {
    refreshes += 1;
    tabsApi().syncFromTable();
  };
  // assets.js's page-controls painter — the module asks for a repaint when a
  // base filter changes without the query changing, since that row carries the
  // Clear Filters / Reset Filter label.
  (win as unknown as Record<string, unknown>)._renderAssetsPageControls = () => { repaints += 1; };

  // favorites.js first (assets-tabs.js registers into it during init), with the
  // browser-side globals it reads.
  g.currentUsername = "tester";
  g.localStorage = win.localStorage;
  if (legacyFavorites.length) {
    win.localStorage.setItem("polaris-favs-assets-tester", JSON.stringify(legacyFavorites));
  }
  (0, eval)(FAV_SRC);

  (0, eval)(SRC);
  await tabsApi().init(opts || {});
}

// The module assigns itself onto `window`, which under happy-dom is a
// separate object from globalThis.
const tabsApi = () => (g.window as any).PolarisAssetTabs as {
  init: (o?: unknown) => Promise<void>;
  syncFromTable: () => void;
  syncColumnsFromTable: () => void;
  openInNewTab: (p: unknown) => boolean;
  noteFilterLoaded: (p: unknown) => void;
  setDefaultFilter: (p: unknown) => boolean;
  clearDefaultFilter: () => boolean;
  activeDefault: () => { id: string | null; name: string | null; state: any } | null;
  resetToDefault: () => boolean;
  refreshDefaultsFromPresets: (list: unknown) => void;
  activeTabName: () => string;
  _debugState: () => { tabs: any[]; activeId: string; persisted: boolean };
};

function tabEls() {
  return Array.from(doc.querySelectorAll("#assets-tabs-list .table-tab"));
}
function fire(el: unknown, type: string, init?: Record<string, unknown>) {
  (el as { dispatchEvent: (e: unknown) => void })
    .dispatchEvent(new win.Event(type, Object.assign({ bubbles: true }, init || {})));
}
/** Let the debounced save (800ms) fire. */
function flushSave() {
  return new Promise((r) => setTimeout(r, 900));
}

beforeEach(() => {
  saved = [];
  getResponse = { version: 1, tabs: [], activeId: "" };
  liveFilters = {};
  liveSort = { key: null, dir: null };
  liveColumnOrder = ["hostname", "ip", "type"];
  layoutSetPrefs = [];
  appliedStates = [];
  refreshes = 0;
  repaints = 0;
  confirmAnswer = true;
  legacyFavorites = [];
  toasts = [];
});

describe("first visit", () => {
  it("seeds one tab from what the table is already showing, and does not write yet", async () => {
    liveFilters = { hostname: "nsh" };                    // restored localStorage prefs
    await boot();
    const tabs = tabEls();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.querySelector(".table-tab-name")!.textContent).toBe("All assets");
    expect(tabsApi()._debugState().tabs[0].state.sfFilters).toEqual({ hostname: "nsh" });
    // No server row until the operator actually uses tabs.
    expect(tabsApi()._debugState().persisted).toBe(false);
    expect(saved).toEqual([]);
    // init must NOT trigger a fetch — assets.js loads the page right after.
    expect(refreshes).toBe(0);
  });

  it("the lone tab has no close button", async () => {
    await boot();
    expect(doc.querySelector("[data-tab-close]")).toBeFalsy();
  });
});

describe("restoring saved tabs", () => {
  beforeEach(() => {
    getResponse = {
      version: 1,
      activeId: "t2",
      tabs: [
        { id: "t1", name: "All assets", state: { sfFilters: {}, sortKey: null, sortDir: null } },
        { id: "t2", name: "Firewalls", state: { sfFilters: { assetType: ["firewall"] }, sortKey: "hostname", sortDir: "asc" }, savedFilterId: "f1", savedFilterName: "Edge firewalls" },
      ],
    };
  });

  it("renders every tab, marks the active one, and applies its state without an extra fetch", async () => {
    await boot();
    const tabs = tabEls();
    expect(tabs.map((t) => t.querySelector(".table-tab-name")!.textContent)).toEqual(["All assets", "Firewalls"]);
    expect(tabs[1]!.classList.contains("active")).toBe(true);
    expect(appliedStates).toHaveLength(1);
    expect((appliedStates[0] as any).sfFilters).toEqual({ assetType: ["firewall"] });
    expect(refreshes).toBe(0);
    // A tab carrying filters gets the marker dot; an empty one doesn't.
    expect(tabs[0]!.querySelector(".table-tab-dot")).toBeFalsy();
    expect(tabs[1]!.querySelector(".table-tab-dot")).toBeTruthy();
  });

  it("switching tabs applies that tab's state and re-fetches exactly once", async () => {
    await boot();
    fire(tabEls()[0], "click");
    expect(refreshes).toBe(1);
    expect(liveFilters).toEqual({});
    expect(tabEls()[0]!.classList.contains("active")).toBe(true);
    // The re-entrancy guard: applying tab 1 must not have written its (empty)
    // state over tab 2, which the operator just left.
    const state = tabsApi()._debugState();
    expect(state.tabs[1].state.sfFilters).toEqual({ assetType: ["firewall"] });
  });

  it("a filter change lands in the ACTIVE tab only, and persists", async () => {
    await boot();
    liveFilters = { status: ["decommissioned"] };         // operator types in a filter box
    (g.assetsApplyFilterState as () => void)();
    const state = tabsApi()._debugState();
    expect(state.tabs[1].state.sfFilters).toEqual({ status: ["decommissioned"] });
    expect(state.tabs[0].state.sfFilters).toEqual({});
    await flushSave();
    // Assert the LAST payload rather than the count: a debounced save scheduled
    // by an earlier test's module instance can still land in this window.
    const last = saved[saved.length - 1] as any;
    expect(last.activeId).toBe("t2");
    expect(last.tabs[1].state.sfFilters).toEqual({ status: ["decommissioned"] });
  });

  it("hashSeeded keeps a deep link's narrowing instead of the tab's", async () => {
    liveFilters = { assetType: ["switch"] };              // #type=switch already applied
    await boot({ hashSeeded: true });
    expect(appliedStates).toEqual([]);                    // tab state never applied over it
    expect(tabsApi()._debugState().tabs[1].state.sfFilters).toEqual({ assetType: ["switch"] });
  });
});

describe("tab management", () => {
  beforeEach(() => {
    getResponse = {
      version: 1,
      activeId: "t1",
      tabs: [{ id: "t1", name: "All assets", state: { sfFilters: { hostname: "a" }, sortKey: null, sortDir: null } }],
    };
  });

  it("+ opens an empty tab, makes it active, and clears the table", async () => {
    await boot();
    fire(doc.getElementById("assets-tab-add"), "click");
    const tabs = tabEls();
    expect(tabs).toHaveLength(2);
    expect(tabs[1]!.querySelector(".table-tab-name")!.textContent).toBe("Tab 2");
    expect(tabs[1]!.classList.contains("active")).toBe(true);
    expect(liveFilters).toEqual({});
    expect(refreshes).toBe(1);
    // Two tabs → both closable now.
    expect(doc.querySelectorAll("[data-tab-close]").length).toBe(2);
  });

  it("double-click renames; Enter commits and Escape reverts", async () => {
    await boot();
    fire(tabEls()[0], "dblclick");
    let input = doc.querySelector(".table-tab-input") as any;
    expect(input).toBeTruthy();
    input.value = "  Edge   gear ";
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(tabEls()[0]!.querySelector(".table-tab-name")!.textContent).toBe("Edge gear");

    fire(tabEls()[0], "dblclick");
    input = doc.querySelector(".table-tab-input") as any;
    input.value = "Discarded";
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(tabEls()[0]!.querySelector(".table-tab-name")!.textContent).toBe("Edge gear");
    await flushSave();
    expect((saved[saved.length - 1] as any).tabs[0].name).toBe("Edge gear");
  });

  it("closing asks first when the tab holds unsaved filters", async () => {
    await boot();
    fire(doc.getElementById("assets-tab-add"), "click");   // now 2 tabs; t1 has filters
    confirmAnswer = false;
    fire(doc.querySelector('[data-tab-close="t1"]'), "click");
    await new Promise((r) => setTimeout(r, 0));
    expect(tabEls()).toHaveLength(2);

    confirmAnswer = true;
    fire(doc.querySelector('[data-tab-close="t1"]'), "click");
    await new Promise((r) => setTimeout(r, 0));
    expect(tabEls()).toHaveLength(1);
  });
});

describe("saved-filter entry points", () => {
  beforeEach(() => {
    getResponse = {
      version: 1,
      activeId: "t1",
      tabs: [{ id: "t1", name: "All assets", state: { sfFilters: {}, sortKey: null, sortDir: null } }],
    };
  });

  const PRESET = {
    id: "f7",
    name: "Down switches",
    state: { sfFilters: { assetType: ["switch"], _monitor: ["Down"] }, sortKey: "hostname", sortDir: "asc" },
  };

  it("openInNewTab adds a tab named after the preset and applies it", async () => {
    await boot();
    expect(tabsApi().openInNewTab(PRESET)).toBe(true);
    const tabs = tabEls();
    expect(tabs).toHaveLength(2);
    expect(tabs[1]!.querySelector(".table-tab-name")!.textContent).toBe("Down switches");
    expect(liveFilters).toEqual({ assetType: ["switch"], _monitor: ["Down"] });
    expect(tabsApi()._debugState().tabs[1].savedFilterId).toBe("f7");
    // The original tab is untouched — that's the whole point of "new tab".
    expect(tabsApi()._debugState().tabs[0].state.sfFilters).toEqual({});
  });

  it("noteFilterLoaded adopts the preset name for a default-named tab only", async () => {
    await boot();
    tabsApi().noteFilterLoaded(PRESET);
    expect(tabEls()[0]!.querySelector(".table-tab-name")!.textContent).toBe("Down switches");
    expect(tabsApi().activeTabName()).toBe("Down switches");

    tabsApi().noteFilterLoaded({ id: "f8", name: "Something else", state: { sfFilters: {} } });
    expect(tabEls()[0]!.querySelector(".table-tab-name")!.textContent).toBe("Down switches");
    expect(tabsApi()._debugState().tabs[0].savedFilterId).toBe("f8");
  });
});

describe("per-tab favorites", () => {
  // The page-side entry points, resolved off globalThis after favorites.js is
  // eval'd — exactly what assets.js calls.
  const favApi = () => ({
    isFavorite: g.isFavorite as (entity: string, id: string) => boolean,
    toggleFavorite: g.toggleFavorite as (entity: string, id: string) => boolean,
    getFavorites: g.getFavorites as (entity: string) => Set<string>,
    starCellHTML: g.starCellHTML as (entity: string, id: string) => string,
    getStoredFavorites: g.getStoredFavorites as (entity: string) => Set<string>,
  });

  beforeEach(() => {
    getResponse = {
      version: 1,
      activeId: "t1",
      tabs: [
        { id: "t1", name: "Firewalls", state: { sfFilters: {}, sortKey: null, sortDir: null }, favoriteIds: ["a1"] },
        { id: "t2", name: "Switches", state: { sfFilters: {}, sortKey: null, sortDir: null }, favoriteIds: [] },
      ],
    };
  });

  it("stars land on the ACTIVE tab and are invisible from the other", async () => {
    await boot();
    expect(favApi().isFavorite("assets", "a1")).toBe(true);

    expect(favApi().toggleFavorite("assets", "a9")).toBe(true);
    expect(Array.from(favApi().getFavorites("assets"))).toEqual(["a1", "a9"]);

    fire(tabEls()[1], "click");
    expect(favApi().isFavorite("assets", "a1")).toBe(false);
    expect(favApi().isFavorite("assets", "a9")).toBe(false);
    // Starring here must not reach back into t1.
    favApi().toggleFavorite("assets", "b1");
    expect(favApi().isFavorite("assets", "b1")).toBe(true);

    const state = tabsApi()._debugState();
    expect(state.tabs[0].favoriteIds).toEqual(["a1", "a9"]);
    expect(state.tabs[1].favoriteIds).toEqual(["b1"]);
  });

  it("persists each tab's own list, and unstarring removes just that id", async () => {
    await boot();
    favApi().toggleFavorite("assets", "a9");
    expect(favApi().toggleFavorite("assets", "a1")).toBe(false);   // unstar
    expect(Array.from(favApi().getFavorites("assets"))).toEqual(["a9"]);
    await flushSave();
    const last = saved[saved.length - 1] as any;
    expect(last.tabs[0].favoriteIds).toEqual(["a9"]);
    expect(last.tabs[1].favoriteIds).toEqual([]);
  });

  it("names the tab on the star, escaped — it is where the scoping is explained", async () => {
    getResponse = {
      version: 1,
      activeId: "t1",
      tabs: [{ id: "t1", name: 'Sites "A"', state: { sfFilters: {}, sortKey: null, sortDir: null }, favoriteIds: [] }],
    };
    await boot();
    const html = favApi().starCellHTML("assets", "a1");
    expect(html).toContain("Favorite in this view");
    expect(html).toContain("Sites &quot;A&quot;");                 // would break the attribute raw
    expect(html).not.toContain('title="Favorite in this view ("');
  });

  it("counts favorites in the tab tooltip", async () => {
    await boot();
    expect(tabEls()[0]!.getAttribute("title")).toContain("1 favorite");
    favApi().toggleFavorite("assets", "a9");
    expect(tabEls()[0]!.getAttribute("title")).toContain("2 favorites");
    expect(tabEls()[1]!.getAttribute("title")).not.toContain("favorite");
  });

  it("a new tab starts with no stars — that is the whole promise", async () => {
    await boot();
    fire(doc.getElementById("assets-tab-add"), "click");
    expect(Array.from(favApi().getFavorites("assets"))).toEqual([]);
    expect(tabsApi()._debugState().tabs[2].favoriteIds).toEqual([]);
    // ...and opening a preset in a new tab likewise.
    tabsApi().openInNewTab({ id: "f1", name: "Down switches", state: { sfFilters: { _monitor: ["Down"] } } });
    expect(Array.from(favApi().getFavorites("assets"))).toEqual([]);
  });

  it("closing a tab whose only content is favorites still asks first", async () => {
    await boot();
    confirmAnswer = false;
    fire(doc.querySelector('[data-tab-close="t1"]'), "click");
    await new Promise((r) => setTimeout(r, 0));
    expect(tabEls()).toHaveLength(2);                              // t1 has "a1"

    // t2 has neither filters nor favorites — nothing to lose, no prompt.
    fire(doc.querySelector('[data-tab-close="t2"]'), "click");
    await new Promise((r) => setTimeout(r, 0));
    expect(tabEls()).toHaveLength(1);
  });

  it("refuses past the cap instead of letting the server drop the tail", async () => {
    getResponse = {
      version: 1,
      activeId: "t1",
      tabs: [{
        id: "t1",
        name: "Full",
        state: { sfFilters: {}, sortKey: null, sortDir: null },
        favoriteIds: Array.from({ length: 500 }, (_, i) => `a${i}`),
      }],
    };
    await boot();
    expect(favApi().toggleFavorite("assets", "one-too-many")).toBe(false);
    expect(favApi().isFavorite("assets", "one-too-many")).toBe(false);
    expect(toasts.some((t) => t.includes("500 favorites"))).toBe(true);
    // Unstarring still works, and makes room again.
    expect(favApi().toggleFavorite("assets", "a0")).toBe(false);
    expect(favApi().toggleFavorite("assets", "one-too-many")).toBe(true);
  });

  describe("adopting the pre-feature per-user set", () => {
    it("seeds EVERY tab that predates the feature, since that is what each showed", async () => {
      legacyFavorites = ["old1", "old2"];
      getResponse = {
        version: 1,
        activeId: "t1",
        tabs: [
          { id: "t1", name: "One", state: { sfFilters: {}, sortKey: null, sortDir: null } },
          { id: "t2", name: "Two", state: { sfFilters: {}, sortKey: null, sortDir: null } },
        ],
      };
      await boot();
      expect(Array.from(favApi().getFavorites("assets"))).toEqual(["old1", "old2"]);
      const state = tabsApi()._debugState();
      expect(state.tabs[1].favoriteIds).toEqual(["old1", "old2"]);
      // Seeded copies are independent from that point on.
      favApi().toggleFavorite("assets", "old1");
      expect(tabsApi()._debugState().tabs[1].favoriteIds).toEqual(["old1", "old2"]);
      // The adoption is written, which is what stops another browser re-seeding.
      await flushSave();
      const last = saved[saved.length - 1] as any;
      expect(last.tabs[1].favoriteIds).toEqual(["old1", "old2"]);
    });

    it("never re-seeds a tab that already carries its own list", async () => {
      // The curated case: another browser adopted (and the operator pruned)
      // first, and this browser still holds the stale localStorage set.
      legacyFavorites = ["old1", "old2"];
      getResponse = {
        version: 1,
        activeId: "t1",
        tabs: [{ id: "t1", name: "Curated", state: { sfFilters: {}, sortKey: null, sortDir: null }, favoriteIds: [] }],
      };
      await boot();
      expect(Array.from(favApi().getFavorites("assets"))).toEqual([]);
      // The legacy set itself is left alone — blocks/subnets still use that store.
      expect(Array.from(favApi().getStoredFavorites("assets"))).toEqual(["old1", "old2"]);
    });

    it("a first visit takes the legacy set but still writes nothing", async () => {
      legacyFavorites = ["old1"];
      getResponse = { version: 1, tabs: [], activeId: "" };
      await boot();
      expect(Array.from(favApi().getFavorites("assets"))).toEqual(["old1"]);
      expect(tabsApi()._debugState().persisted).toBe(false);
      expect(saved).toEqual([]);
    });
  });
});

describe("per-tab column order", () => {
  beforeEach(() => {
    getResponse = {
      version: 1,
      activeId: "t1",
      tabs: [
        { id: "t1", name: "Firewalls", state: { sfFilters: {}, sortKey: null, sortDir: null },
          favoriteIds: [], columnOrder: ["type", "hostname", "ip"] },
        { id: "t2", name: "Switches", state: { sfFilters: {}, sortKey: null, sortDir: null },
          favoriteIds: [], columnOrder: ["ip", "type", "hostname"] },
      ],
    };
  });

  it("applies the active tab's order on load, and only the order", async () => {
    await boot();
    expect(liveColumnOrder).toEqual(["type", "hostname", "ip"]);
    // Widths and hidden columns are per-BROWSER: the module must never hand
    // the layout a key that would overwrite them from server state.
    expect(layoutSetPrefs.length).toBeGreaterThan(0);
    layoutSetPrefs.forEach((p) => expect(Object.keys(p)).toEqual(["order"]));
  });

  it("switching tabs rearranges the columns to that tab's order", async () => {
    await boot();
    fire(tabEls()[1], "click");
    expect(liveColumnOrder).toEqual(["ip", "type", "hostname"]);
    fire(tabEls()[0], "click");
    expect(liveColumnOrder).toEqual(["type", "hostname", "ip"]);
  });

  it("a drag-reorder lands in the ACTIVE tab only, and persists", async () => {
    await boot();
    liveColumnOrder = ["hostname", "type", "ip"];          // operator dragged a column
    tabsApi().syncColumnsFromTable();
    const state = tabsApi()._debugState();
    expect(state.tabs[0].columnOrder).toEqual(["hostname", "type", "ip"]);
    expect(state.tabs[1].columnOrder).toEqual(["ip", "type", "hostname"]);
    await flushSave();
    const tabs = (saved.at(-1)!.tabs as Record<string, unknown>[]);
    expect(tabs[0]!.columnOrder).toEqual(["hostname", "type", "ip"]);
    expect(tabs[1]!.columnOrder).toEqual(["ip", "type", "hostname"]);
  });

  it("a width or visibility change alone writes nothing", async () => {
    await boot();
    saved = [];
    tabsApi().syncColumnsFromTable();                      // onChange fires for those too
    await flushSave();
    expect(saved).toHaveLength(0);
  });

  it("a new tab inherits the arrangement of the view it was opened from", async () => {
    await boot();
    liveColumnOrder = ["ip", "hostname", "type"];
    tabsApi().syncColumnsFromTable();
    doc.getElementById("assets-tab-add")!.dispatchEvent(new win.Event("click", { bubbles: true }));
    const state = tabsApi()._debugState();
    expect(state.tabs.at(-1)!.columnOrder).toEqual(["ip", "hostname", "type"]);
    // …and the columns did not snap back to the authored order on the way.
    expect(liveColumnOrder).toEqual(["ip", "hostname", "type"]);
  });

  it("a tab written before the feature adopts this browser's arrangement once", async () => {
    getResponse = {
      version: 1,
      activeId: "t1",
      tabs: [
        { id: "t1", name: "Firewalls", state: { sfFilters: {}, sortKey: null, sortDir: null } },
        { id: "t2", name: "Switches", state: { sfFilters: {}, sortKey: null, sortDir: null } },
      ],
    };
    liveColumnOrder = ["ip", "type", "hostname"];           // this browser's stored layout
    await boot();
    const state = tabsApi()._debugState();
    // Every tab used to show this one arrangement, so every tab keeps it.
    expect(state.tabs[0].columnOrder).toEqual(["ip", "type", "hostname"]);
    expect(state.tabs[1].columnOrder).toEqual(["ip", "type", "hostname"]);
  });

  it("a deep link narrows the rows but does not take the tab's arrangement", async () => {
    await boot({ hashSeeded: true });
    expect(liveColumnOrder).toEqual(["type", "hostname", "ip"]);
  });

  it("the first-visit tab is seeded from the table on screen", async () => {
    getResponse = { version: 1, tabs: [], activeId: "" };
    liveColumnOrder = ["type", "ip", "hostname"];
    await boot();
    expect(tabsApi()._debugState().tabs[0].columnOrder).toEqual(["type", "ip", "hostname"]);
  });
});

describe("base (default) filter", () => {
  beforeEach(() => {
    getResponse = {
      version: 1,
      activeId: "t1",
      tabs: [
        { id: "t1", name: "All assets", state: { sfFilters: {}, sortKey: null, sortDir: null } },
        { id: "t2", name: "Scratch", state: { sfFilters: {}, sortKey: null, sortDir: null } },
      ],
    };
  });

  const PRESET = {
    id: "f7",
    name: "Down switches",
    state: { sfFilters: { assetType: ["switch"], _monitor: ["Down"] }, sortKey: "hostname", sortDir: "asc" },
  };

  it("marking a base applies it, marks the tab, and persists the triple", async () => {
    await boot();
    expect(tabsApi().activeDefault()).toBeNull();

    expect(tabsApi().setDefaultFilter(PRESET)).toBe(true);
    expect(liveFilters).toEqual({ assetType: ["switch"], _monitor: ["Down"] });
    expect(refreshes).toBe(1);
    expect(repaints).toBe(1);                             // the Clear→Reset relabel
    expect(tabEls()[0]!.querySelector(".table-tab-base")).toBeTruthy();
    expect(tabEls()[1]!.querySelector(".table-tab-base")).toBeFalsy();

    const base = tabsApi().activeDefault()!;
    expect(base.id).toBe("f7");
    expect(base.name).toBe("Down switches");
    expect(base.state.sfFilters).toEqual({ assetType: ["switch"], _monitor: ["Down"] });

    await flushSave();
    const last = saved[saved.length - 1] as any;
    expect(last.tabs[0].defaultFilterId).toBe("f7");
    expect(last.tabs[0].defaultFilterName).toBe("Down switches");
    expect(last.tabs[0].defaultState.sfFilters).toEqual({ assetType: ["switch"], _monitor: ["Down"] });
    expect(last.tabs[1].defaultState).toBeNull();
  });

  it("narrowing inside the base and resetting returns to the base, not to nothing", async () => {
    await boot();
    tabsApi().setDefaultFilter(PRESET);
    // The operator filters further on top of the base — the whole point.
    liveFilters = { assetType: ["switch"], _monitor: ["Down"], hostname: "nsh" };
    (g.assetsApplyFilterState as () => void)();
    expect(tabsApi()._debugState().tabs[0].state.sfFilters.hostname).toBe("nsh");

    expect(tabsApi().resetToDefault()).toBe(true);
    expect(liveFilters).toEqual({ assetType: ["switch"], _monitor: ["Down"] });
    // Reset drives the table through assetsApplyFilterState, so the tab is
    // mirrored back too — a reload must not bring the narrowing back.
    expect(tabsApi()._debugState().tabs[0].state.sfFilters.hostname).toBeUndefined();
  });

  it("the base snapshot is detached from the preset object it came from", async () => {
    await boot();
    const preset = JSON.parse(JSON.stringify(PRESET));
    tabsApi().setDefaultFilter(preset);
    preset.state.sfFilters.hostname = "mutated";          // menu cache churn / next open
    expect(tabsApi().activeDefault()!.state.sfFilters.hostname).toBeUndefined();
    expect(tabsApi().resetToDefault()).toBe(true);
    expect(liveFilters).toEqual({ assetType: ["switch"], _monitor: ["Down"] });
  });

  it("a base belongs to ONE tab — switching tabs changes the answer", async () => {
    await boot();
    tabsApi().setDefaultFilter(PRESET);
    fire(tabEls()[1], "click");
    expect(tabsApi().activeDefault()).toBeNull();
    expect(tabsApi().resetToDefault()).toBe(false);
    fire(tabEls()[0], "click");
    expect(tabsApi().activeDefault()!.id).toBe("f7");
  });

  it("clearing the base leaves the view on screen alone", async () => {
    await boot();
    tabsApi().setDefaultFilter(PRESET);
    repaints = 0;
    expect(tabsApi().clearDefaultFilter()).toBe(true);
    expect(tabsApi().activeDefault()).toBeNull();
    expect(tabEls()[0]!.querySelector(".table-tab-base")).toBeFalsy();
    expect(repaints).toBe(1);
    // The filters the operator is looking at are still there — they asked to
    // stop having a way back, not to lose the view.
    expect(liveFilters).toEqual({ assetType: ["switch"], _monitor: ["Down"] });
    expect(tabsApi().clearDefaultFilter()).toBe(false);   // nothing left to clear
  });

  it("a restored tab carries its base, and an edited preset re-syncs into it", async () => {
    getResponse = {
      version: 1,
      activeId: "t1",
      tabs: [{
        id: "t1",
        name: "Down switches",
        state: { sfFilters: { assetType: ["switch"], hostname: "nsh" }, sortKey: null, sortDir: null },
        defaultFilterId: "f7",
        defaultFilterName: "Down switches",
        defaultState: { sfFilters: { assetType: ["switch"] }, sortKey: null, sortDir: null },
      }],
    };
    await boot();
    expect(tabEls()[0]!.querySelector(".table-tab-base")).toBeTruthy();
    expect(tabsApi().activeDefault()!.state.sfFilters).toEqual({ assetType: ["switch"] });

    // Its owner edited + renamed the preset.
    tabsApi().refreshDefaultsFromPresets([
      { id: "f7", name: "Down switches (edge)", state: { sfFilters: { assetType: ["switch"], _monitor: ["Down"] } } },
    ]);
    const base = tabsApi().activeDefault()!;
    expect(base.name).toBe("Down switches (edge)");
    expect(base.state.sfFilters).toEqual({ assetType: ["switch"], _monitor: ["Down"] });
    // The narrowing on top of it is untouched by a re-sync.
    expect(tabsApi()._debugState().tabs[0].state.sfFilters.hostname).toBe("nsh");
  });

  it("a preset that has gone leaves the snapshot alone rather than orphaning the tab", async () => {
    await boot();
    tabsApi().setDefaultFilter(PRESET);
    tabsApi().refreshDefaultsFromPresets([{ id: "someone-elses", name: "Other", state: { sfFilters: {} } }]);
    expect(tabsApi().activeDefault()!.state.sfFilters).toEqual({ assetType: ["switch"], _monitor: ["Down"] });
    expect(tabsApi().resetToDefault()).toBe(true);
  });

  it("closing a tab sitting exactly on its base does not ask", async () => {
    await boot();
    tabsApi().setDefaultFilter(PRESET);
    confirmAnswer = false;                                 // any prompt = the close is refused
    fire(doc.querySelector('[data-tab-close="t1"]'), "click");
    await new Promise((r) => setTimeout(r, 0));
    expect(tabEls()).toHaveLength(1);
  });
});
