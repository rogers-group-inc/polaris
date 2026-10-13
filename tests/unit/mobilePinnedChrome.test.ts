/**
 * tests/unit/mobilePinnedChrome.test.ts
 *
 * Phone chrome that must stay reachable while content scrolls, and the
 * search entry point that replaced the always-visible search bar:
 *
 *   - the asset sheet's handle + header (name, screenshot, refresh, close)
 *     ride one sticky band, see-through at rest and filled once the body
 *     scrolls under it (`.scrolled`);
 *   - the Assets list's controls are a sticky block (DOM case in
 *     mobileAssetViews.test.ts; the CSS half is pinned here);
 *   - the search bar is hidden until opened (`.app.searching`), and the shell
 *     puts a magnifier FIRST in every top bar's trailing group, so it sits
 *     between the title and the page's own buttons;
 *   - the Device Map has a top bar of its own to carry that magnifier.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf-8").replace(/\r\n/g, "\n");
const CSS = read("public", "css", "mobile.css");
const APP = read("public", "js", "mobile", "app.js");
const SHEET = read("public", "js", "mobile", "asset-detail.js");
const MAP = read("public", "js", "mobile", "map-tab.js");

/** The declarations of the first rule whose selector is exactly `sel`. */
function rule(sel: string): string {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = CSS.match(new RegExp("(^|\\n)" + esc + "\\s*\\{([^}]*)\\}"));
  if (!m) throw new Error("no rule for " + sel);
  return m[2];
}

/** Evaluate app.js's addTopbarSearch on its own, against a stub topbar. */
function addTopbarSearch() {
  const start = APP.indexOf("  function addTopbarSearch(");
  const end = APP.indexOf("\n  }\n", start);
  const src = APP.slice(start, end + 4);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function("openSearchFromButton", src + "\nreturn addTopbarSearch;")(() => {});
}

describe("asset sheet header band", () => {
  it("wraps the handle and every header control in one band", () => {
    const at = SHEET.indexOf("'<div class=\"asset-sheet-top\">'");
    const host = SHEET.indexOf("'<div id=\"asset-host\"></div>'");
    expect(at).toBeGreaterThan(0);
    const band = SHEET.slice(at, host);
    for (const id of ["sheet-handle", "asset-sheet-name-btn", "asset-sheet-screenshot", "asset-sheet-refresh", "asset-sheet-close"]) {
      expect(band).toContain(id);
    }
  });

  it("is sticky at the top, see-through at rest and filled once scrolled", () => {
    const r = rule(".asset-sheet-top");
    expect(r).toMatch(/position:\s*sticky/);
    expect(r).toMatch(/top:\s*0/);
    expect(r).toMatch(/background:\s*transparent/);
    expect(rule(".asset-sheet.scrolled .asset-sheet-top")).toMatch(/background:\s*var\(--md-surface\)/);
    expect(SHEET).toMatch(/classList\.toggle\("scrolled", sheet\.scrollTop > 0\)/);
  });
});

describe("Assets list controls", () => {
  it("are a sticky block", () => {
    expect(rule(".list-sticky-head")).toMatch(/position:\s*sticky/);
  });
});

describe("search entry point", () => {
  it("hides the search bar until search is open", () => {
    expect(rule("#search-slot")).toMatch(/display:\s*none/);
    expect(rule(".app.searching #search-slot")).toMatch(/display:\s*block/);
    expect(APP).toMatch(/app\.classList\.toggle\("searching", open\)/);
  });

  it("puts the magnifier first in the top bar's trailing group, once", () => {
    const add = addTopbarSearch();
    const slot = document.createElement("div");
    slot.innerHTML = '<div class="m3-topbar"><div class="leading"></div><div class="title">Alerts</div>'
      + '<div class="trailing"><button aria-label="Refresh"></button></div></div>';
    add(slot);
    add(slot);
    const labels = Array.from(slot.querySelectorAll(".trailing > *")).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Search", "Refresh"]);
  });

  it("adds nothing to a page with no top bar", () => {
    const add = addTopbarSearch();
    const slot = document.createElement("div");
    add(slot);
    expect(slot.querySelector(".topbar-search-btn")).toBeNull();
  });

  it("focuses the input in the tap itself, before the route change", () => {
    const start = APP.indexOf("function openSearchFromButton(");
    const body = APP.slice(start, APP.indexOf("\n  }\n", start));
    expect(body.indexOf('classList.add("searching")')).toBeLessThan(body.indexOf("input.focus()"));
    expect(body.indexOf("input.focus()")).toBeLessThan(body.indexOf("openSearch()"));
  });

  it("gives the Device Map a top bar to carry the magnifier", () => {
    expect(MAP).toMatch(/<div class="title">Device Map<\/div>/);
  });
});
