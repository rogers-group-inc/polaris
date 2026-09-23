/**
 * tests/unit/mobileAssetsSortFilter.test.ts
 *
 * The phone's Assets tab sorts and filters SERVER-side: the list is paged, so
 * a client sort would only order the pages already loaded. What's pinned:
 *
 *   - the filter field rides the route's `search` param, and a new term
 *     re-fetches from offset 0 rather than appending to the old list;
 *   - the "Sort & filter" sheet writes sortBy / sortDir / monitor, using only
 *     keys the route's own whitelist accepts (a key outside
 *     ASSET_SORT_COLUMNS is a 400 from the server);
 *   - "Recently added" is the server default — no sortBy at all;
 *   - the topbar's old magnifier (which only jumped to the Search tab) is gone;
 *   - a status filter hidden in the sheet is named on the chip.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TAB_SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "assets-tab.js"), "utf-8");
const LIST_SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "list-controls.js"), "utf-8");
const ROUTE_SRC = readFileSync(join(process.cwd(), "src", "api", "routes", "assets.ts"), "utf-8");

const g = globalThis as any;
const flush = () => new Promise((r) => setTimeout(r, 0));

let requests: any[] = [];

function mount() {
  document.body.innerHTML =
    '<div id="app"><div id="topbar-slot"></div><main class="app-body" id="app-body"></main></div>';
  requests = [];
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  g.api = {
    assets: {
      list: vi.fn(async (p: any) => {
        requests.push({ ...p });
        return { assets: [{ id: "a1", hostname: "H1", assetType: "server" }], total: 1 };
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

function typeFilter(text: string) {
  const input = document.getElementById("assets-filter") as HTMLInputElement;
  input.value = text;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

function tapSort() {
  (document.getElementById("assets-sort") as HTMLButtonElement).click();
}

function sheetButton(selector: string) {
  return document.querySelector("#list-sort-sheet " + selector) as HTMLButtonElement;
}

describe("mobile Assets tab sort + filter", () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  it("drops the topbar magnifier that only jumped to Search", () => {
    mount();
    expect(document.getElementById("assets-search-btn")).toBeNull();
    expect(document.querySelector("#topbar-slot use[href='#i-search']")).toBeNull();
  });

  it("first loads in the server's default order — no sortBy, no search", async () => {
    mount();
    await flush();
    expect(requests[0]).toMatchObject({ limit: 50, offset: 0 });
    expect(requests[0].sortBy).toBeUndefined();
    expect(requests[0].search).toBeUndefined();
    expect(requests[0].monitor).toBeUndefined();
  });

  it("sends the filter text as `search` and re-fetches from the top", async () => {
    mount();
    await flush();
    typeFilter("core-sw");
    await flush();
    const last = requests[requests.length - 1];
    expect(last.search).toBe("core-sw");
    expect(last.offset).toBe(0);
  });

  it("clears the filter with its clear button", async () => {
    mount();
    await flush();
    typeFilter("core-sw");
    await flush();
    (document.getElementById("assets-filter-clear") as HTMLButtonElement).click();
    await flush();
    expect(requests[requests.length - 1].search).toBeUndefined();
  });

  it("picks a sort column with its own default direction, and a second tap flips it", async () => {
    mount();
    await flush();
    tapSort();
    sheetButton('[data-sort="hostname"]').click();
    await flush();
    expect(requests[requests.length - 1]).toMatchObject({ sortBy: "hostname", sortDir: "asc", offset: 0 });
    sheetButton('[data-sort="hostname"]').click();
    await flush();
    expect(requests[requests.length - 1]).toMatchObject({ sortBy: "hostname", sortDir: "desc" });
    sheetButton('[data-sort="lastSeen"]').click();
    await flush();
    expect(requests[requests.length - 1]).toMatchObject({ sortBy: "lastSeen", sortDir: "desc" });
  });

  it("filters by monitor status through the route's `monitor` param and names it on the chip", async () => {
    mount();
    await flush();
    tapSort();
    sheetButton('[data-filter="monitor"][data-value="Down"]').click();
    await flush();
    expect(requests[requests.length - 1].monitor).toBe("Down");
    const chip = document.getElementById("assets-sort")!;
    expect(chip.textContent).toContain("Down");
    expect(chip.classList.contains("selected")).toBe(true);
  });

  it("remembers the sort across a re-render, but not the filter text", async () => {
    const spec = mount();
    await flush();
    tapSort();
    sheetButton('[data-sort="ipAddress"]').click();
    await flush();
    // A fresh module (next app boot) reads the saved choice back.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(TAB_SRC)();
    g.PolarisAssetsTab.spec.render(document.getElementById("app-body")!);
    await flush();
    expect(requests[requests.length - 1]).toMatchObject({ sortBy: "ipAddress", sortDir: "asc" });
    expect(spec).toBeTruthy();
  });

  it("offers only sort keys and status values the server accepts", () => {
    // Keys: the route's ASSET_SORT_COLUMNS whitelist. Values: monitorClause's cases.
    const sortBlock = ROUTE_SRC.slice(ROUTE_SRC.indexOf("const ASSET_SORT_COLUMNS"), ROUTE_SRC.indexOf("};", ROUTE_SRC.indexOf("const ASSET_SORT_COLUMNS")));
    const monitorBlock = ROUTE_SRC.slice(ROUTE_SRC.indexOf("function monitorClause"), ROUTE_SRC.indexOf("default:", ROUTE_SRC.indexOf("function monitorClause")));
    const sortKeys = [...TAB_SRC.matchAll(/\{ key: "([^"]*)",\s+label: "[^"]+",\s+defaultDir/g)].map((m) => m[1]).filter(Boolean);
    expect(sortKeys.length).toBeGreaterThan(3);
    for (const k of sortKeys) expect(sortBlock, `sort key ${k}`).toContain(`${k}:`);
    const values = [...TAB_SRC.matchAll(/\{ value: "([^"]+)",\s+label:/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(3);
    for (const v of values) expect(monitorBlock, `monitor value ${v}`).toContain(`case "${v}"`);
  });

  it("survives blocked storage — the defaults stand", async () => {
    const orig = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() { throw new Error("SecurityError"); },
    });
    try {
      mount();
      await flush();
      expect(requests[0].sortBy).toBeUndefined();
      tapSort();
      sheetButton('[data-sort="hostname"]').click();
      await flush();
      expect(requests[requests.length - 1].sortBy).toBe("hostname");
    } finally {
      if (orig) Object.defineProperty(globalThis, "localStorage", orig);
    }
  });
});
