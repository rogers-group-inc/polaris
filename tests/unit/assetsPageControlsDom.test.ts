/**
 * tests/unit/assetsPageControlsDom.test.ts — the Assets list controls row
 * (`_renderAssetsPageControls` / the zero-row branch of `renderAssetsPage` in
 * public/js/assets.js).
 *
 * This exists because of one bug: a filter that matched nothing called
 * clearPageControls() and took the WHOLE row with it — the page buttons, the
 * "Show N" page-size selector, and the Refresh / Clear Filters buttons. Clear
 * Filters vanishing in exactly the state that needs it left the operator with
 * an empty table and no way back but a browser reload, so the row now renders
 * on every pass and the empty case is what these tests pin.
 *
 * It also pins the row's one context-dependent button: Clear Filters becomes
 * Reset Filter while the active view tab has a base filter pinned.
 *
 * assets.js is an ~18k-line browser script with no module boundary, so the two
 * functions are sliced out by name and eval'd — the idiom in assetRowMenu.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

interface ActionButton { label: string; onClick: () => void }
interface ControlsCall {
  containerId: string;
  total: number;
  pageSize: number;
  page: number;
  onPageChange: (p: number) => void;
  onSizeChange: (n: number) => void;
  opts: { actionButtons?: ActionButton[]; topNav?: boolean } | undefined;
}

const g = globalThis as Record<string, any>;
const src = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8");
const lines = src.split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return lines.slice(start, end + 1).join("\n");
}

let calls: ControlsCall[];
let cleared: string[];
let fetches: number;
let prefsSaved: number;
let clearedFilters: number;
let tbodyHtml: string;
let resets: number;
/** The active tab's base filter, as assets-tabs.js would report it. */
let activeBase: { id: string; name: string; state: unknown } | null;

beforeEach(() => {
  calls = [];
  cleared = [];
  fetches = 0;
  prefsSaved = 0;
  clearedFilters = 0;
  tbodyHtml = "";
  resets = 0;
  activeBase = null;

  const tbody = {
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => [] as unknown[],
    set innerHTML(v: string) { tbodyHtml = v; },
    get innerHTML() { return tbodyHtml; },
  };
  g.document = { getElementById: (id: string) => (id === "assets-tbody" ? tbody : null) };

  g.renderPageControls = (
    containerId: string, total: number, pageSize: number, page: number,
    onPageChange: (p: number) => void, onSizeChange: (n: number) => void, opts: ControlsCall["opts"],
  ) => { calls.push({ containerId, total, pageSize, page, onPageChange, onSizeChange, opts }); };
  g.clearPageControls = (id: string) => { cleared.push(id); };

  g.fetchAssetsPage = () => { fetches++; };
  // The one "state changed" entry point: page 1 → re-fetch → persist prefs →
  // mirror into the active tab (assets.js). Stubbed to the same composition so
  // the button assertions below still mean what they say.
  g.assetsApplyFilterState = () => { g._assetsPage = 1; fetches++; prefsSaved++; };
  g.loadAssets = () => {};
  g._saveAssetsPrefs = () => { prefsSaved++; };
  g._assetsUpdateSelectAll = () => {};
  g._handleCopyClick = () => {};
  g._handleMonitorPillClick = () => {};
  g._handleTypePillClick = () => {};

  g._assetsData = [];
  g._assetsTotal = 0;
  g._assetsPage = 1;
  g._assetsPageSize = 25;
  g._assetsSF = { _filters: {}, clearFilters: () => { clearedFilters++; } };
  // The page reads window.PolarisAssetTabs for the active tab's base filter;
  // a page with no tab strip (or a cached older one) simply has none.
  g.window = {
    get PolarisAssetTabs() {
      return activeBase === null ? undefined : {
        activeDefault: () => activeBase,
        resetToDefault: () => { resets++; g._assetsPage = 1; fetches++; prefsSaved++; return true; },
      };
    },
  };

  (0, eval)(fnSrc("_renderAssetsPageControls"));
  (0, eval)(fnSrc("renderAssetsPage"));
  expect(typeof g._renderAssetsPageControls, "assets.js no longer declares _renderAssetsPageControls").toBe("function");
});

describe("renderAssetsPage — zero rows", () => {
  it("still renders the controls row when a filter matches nothing", () => {
    g._assetsSF._filters = { assetType: ["firewall"] };
    g.renderAssetsPage();

    expect(tbodyHtml).toContain("No results match the current filters.");
    expect(cleared, "the empty branch must not clear the controls row").toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.containerId).toBe("pagination");
    expect(calls[0]!.total).toBe(0);
  });

  it("keeps Clear Filters reachable — the whole point of rendering on empty", () => {
    g._assetsSF._filters = { hostname: "nope" };
    g.renderAssetsPage();

    const buttons = calls[0]!.opts?.actionButtons ?? [];
    expect(buttons.map((b) => b.label)).toEqual(["Clear", "Refresh"]);

    buttons.find((b) => b.label === "Clear")!.onClick();
    expect(clearedFilters).toBe(1);
    expect(g._assetsPage).toBe(1);
    expect(fetches).toBe(1);
    expect(prefsSaved).toBe(1);
  });

  it("keeps the Show N page-size selector (onSizeChange) on an empty result", () => {
    g.renderAssetsPage();
    expect(typeof calls[0]!.onSizeChange).toBe("function");

    calls[0]!.onSizeChange(50);
    expect(g._assetsPageSize).toBe(50);
    expect(g._assetsPage).toBe(1);
  });

  it("renders the same row with no filters at all (empty inventory)", () => {
    g.renderAssetsPage();
    expect(tbodyHtml).toContain("No assets found.");
    expect(calls).toHaveLength(1);
  });
});

describe("_renderAssetsPageControls — top row shares a line with the view tabs", () => {
  it("asks for no page navigation in the top row (topNav: false)", () => {
    g.renderAssetsPage();
    expect(calls[0]!.opts?.topNav).toBe(false);
  });
});

describe("_renderAssetsPageControls — page number", () => {
  it("reports page 1 when nothing matched, whatever page the operator filtered from", () => {
    // fetchAssetsPage's clamp only fires while the total is non-zero, so a
    // stale page number would leave Prev enabled over an empty result set.
    g._assetsPage = 7;
    g._assetsTotal = 0;
    g._renderAssetsPageControls();

    expect(g._assetsPage).toBe(1);
    expect(calls[0]!.page).toBe(1);
  });

  it("leaves the current page alone once there are results", () => {
    g._assetsPage = 3;
    g._assetsTotal = 140;
    g._renderAssetsPageControls();

    expect(g._assetsPage).toBe(3);
    expect(calls[0]!.page).toBe(3);
    expect(calls[0]!.total).toBe(140);
  });
});

describe("Clear Filters vs Reset Filter", () => {
  it("resets to the tab's base filter instead of clearing, when one is pinned", () => {
    activeBase = { id: "f7", name: "Down switches", state: { sfFilters: { assetType: ["switch"] } } };
    g._assetsTotal = 12;
    g._renderAssetsPageControls();

    const buttons = calls[0]!.opts?.actionButtons ?? [];
    expect(buttons.map((b) => b.label)).toEqual(["Reset Filter", "Refresh"]);
    // The base is named where the operator can find it — the label can't be.
    expect((buttons[0] as unknown as { title: string }).title).toContain("Down switches");

    buttons[0]!.onClick();
    expect(resets).toBe(1);
    // Reset REPLACES the clear — clearing as well would drop the base's own
    // filters and land on the unfiltered table.
    expect(clearedFilters).toBe(0);
  });

  it("falls back to clearing when the base filter has gone away", () => {
    // e.g. the operator switched to a tab with no base between renders.
    activeBase = null;
    g._renderAssetsPageControls();
    const buttons = calls[0]!.opts?.actionButtons ?? [];
    expect(buttons.map((b) => b.label)).toEqual(["Clear", "Refresh"]);
    buttons[0]!.onClick();
    expect(clearedFilters).toBe(1);
    expect(resets).toBe(0);
  });
});

describe("assets.js source", () => {
  it("never clears the pagination row from the list render", () => {
    // clearPageControls("pagination") in renderAssetsPage IS the bug; the
    // asset-details Events pagination has its own container and is unaffected.
    expect(src).not.toContain('clearPageControls("pagination")');
  });
});
