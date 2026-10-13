/**
 * tests/unit/mobilePinnedChrome.test.ts
 *
 * Phone chrome that must stay reachable while content scrolls, and the
 * search entry point that replaced the always-visible search bar:
 *
 *   - every sheet with a header row pins its handle + header in one band
 *     (PolarisTabs.pinSheetHead → `.sheet-pinned-head`), see-through at rest
 *     and filled once the body scrolls under it (`.scrolled`) — the asset
 *     sheet, the network sheet, the table / interface / SD-WAN / alerts
 *     sheets, the edit sheets, the site sheet, Sort & filter, chat history;
 *   - the Assets, Alerts and Networks lists pin their controls in one sticky
 *     block (`.list-sticky-head`; the Assets DOM case is in
 *     mobileAssetViews.test.ts);
 *   - the search bar is hidden until opened (`.app.searching`), and the shell
 *     puts a magnifier FIRST in every top bar's trailing group, so it sits
 *     between the title and the page's own buttons;
 *   - the Device Map has a top bar of its own to carry that magnifier.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf-8").replace(/\r\n/g, "\n");
const mobile = (f: string) => read("public", "js", "mobile", f);
const CSS = read("public", "css", "mobile.css");
const APP = mobile("app.js");
const SHEET = mobile("asset-detail.js");
const MAP = mobile("map-tab.js");

const g = globalThis as any;

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

describe("pinned sheet header (PolarisTabs.pinSheetHead)", () => {
  beforeAll(() => {
    g.escapeHtml = (s: any) => String(s ?? "");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(mobile("tabs.js"))();
  });

  function makeSheet() {
    const sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.innerHTML = '<div class="sheet-handle"></div>'
      + '<div class="hdr"><h3 class="sheet-title">T</h3><button id="x-close"></button></div>'
      + '<div id="x-controls"></div><div id="x-body">body</div>';
    document.body.appendChild(sheet);
    return sheet;
  }
  const kids = (el: Element) => Array.from(el.children).map((c) => c.className || c.id);

  it("wraps the handle and the header row in one band, leaving the body below it", () => {
    const sheet = makeSheet();
    g.PolarisTabs.pinSheetHead(sheet);
    const band = sheet.firstElementChild as HTMLElement;
    expect(band.className).toBe("sheet-pinned-head");
    expect(kids(band)).toEqual(["sheet-handle", "hdr"]);
    expect(sheet.querySelector("#x-body")!.parentElement).toBe(sheet);
  });

  it("pins further rows named in opts.also, in order", () => {
    const sheet = makeSheet();
    g.PolarisTabs.pinSheetHead(sheet, { also: ["#x-controls"] });
    expect(kids(sheet.querySelector(".sheet-pinned-head")!)).toEqual(["sheet-handle", "hdr", "x-controls"]);
  });

  it("is idempotent, and re-pins after a repaint", () => {
    const sheet = makeSheet();
    g.PolarisTabs.pinSheetHead(sheet);
    g.PolarisTabs.pinSheetHead(sheet);
    expect(sheet.querySelectorAll(".sheet-pinned-head").length).toBe(1);
    sheet.innerHTML = '<div class="sheet-handle"></div><div class="hdr2"></div><div>body</div>';
    g.PolarisTabs.pinSheetHead(sheet);
    expect(sheet.querySelectorAll(".sheet-pinned-head").length).toBe(1);
    expect(sheet.querySelector(".sheet-pinned-head .hdr2")).toBeTruthy();
  });

  it("marks the sheet .scrolled while its body is scrolled under the band", () => {
    const sheet = makeSheet();
    g.PolarisTabs.pinSheetHead(sheet);
    expect(sheet.classList.contains("scrolled")).toBe(false);
    Object.defineProperty(sheet, "scrollTop", { value: 40, configurable: true });
    sheet.dispatchEvent(new Event("scroll"));
    expect(sheet.classList.contains("scrolled")).toBe(true);
    Object.defineProperty(sheet, "scrollTop", { value: 0, configurable: true });
    sheet.dispatchEvent(new Event("scroll"));
    expect(sheet.classList.contains("scrolled")).toBe(false);
  });

  it("is sticky at the top, see-through at rest and filled once scrolled", () => {
    const r = rule(".sheet-pinned-head");
    expect(r).toMatch(/position:\s*sticky/);
    expect(r).toMatch(/top:\s*0/);
    expect(r).toMatch(/background:\s*transparent/);
    expect(rule(".sheet.scrolled > .sheet-pinned-head")).toMatch(/background:\s*var\(--md-surface\)/);
  });

  it("is applied by every sheet that has a header row", () => {
    const sites: [string, number][] = [
      ["asset-detail.js", 4],   // asset sheet, interface, SD-WAN, table (+ its filter row)
      ["subnet-detail.js", 1],  // network address sheet
      ["alerts.js", 1],         // per-asset alerts sheet
      ["asset-edit.js", 2],     // edit menu + each edit sheet
      ["map-tab.js", 1],        // site sheet
      ["list-controls.js", 1],  // Sort & filter (re-pinned on every paint)
      ["chat-tab.js", 1],       // conversation history
    ];
    for (const [file, n] of sites) {
      expect(mobile(file).match(/PolarisTabs\.pinSheetHead\(sheet/g)?.length, file).toBe(n);
    }
    expect(SHEET).toMatch(/pinSheetHead\(sheet, \{ also: \["#table-sheet-controls"\] \}\)/);
  });

  it("keeps the asset sheet's controls in the header row the band pins", () => {
    const at = SHEET.indexOf("'<div class=\"sheet-handle\"></div>'\n      + '<div class=\"asset-sheet-header\">'");
    const host = SHEET.indexOf("'<div id=\"asset-host\"></div>'");
    expect(at).toBeGreaterThan(0);
    const header = SHEET.slice(at, host);
    for (const id of ["asset-sheet-name-btn", "asset-sheet-screenshot", "asset-sheet-refresh", "asset-sheet-close"]) {
      expect(header).toContain(id);
    }
  });
});

describe("list controls", () => {
  it("are a sticky block", () => {
    expect(rule(".list-sticky-head")).toMatch(/position:\s*sticky/);
  });

  it("hold the controls, not the rows, on Alerts and Networks", () => {
    const cases: [string, string, string][] = [
      ["alerts-tab.js", "alerts", "alerts-summary"],
      ["networks-tab.js", "networks", ""],
    ];
    for (const [file, id, extra] of cases) {
      const src = mobile(file);
      const open = src.indexOf("'<div class=\"list-sticky-head\">'");
      const host = src.indexOf("'<div id=\"" + id + "-list-host\"></div>'");
      expect(open, file).toBeGreaterThan(0);
      expect(host, file).toBeGreaterThan(open);
      const block = src.slice(open, host);
      expect(block).toContain("toolbarHTML(");
      expect(block).toContain(id + "-chips");
      if (extra) expect(block).toContain(extra);
      // The block is closed right before the list host.
      expect(block.replace(/\s+/g, " ").endsWith("+ '</div>' + ")).toBe(true);
    }
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
