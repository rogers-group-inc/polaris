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

  it("is sticky at the top and stays see-through once scrolled", () => {
    const r = rule(".sheet-pinned-head");
    expect(r).toMatch(/position:\s*sticky/);
    expect(r).toMatch(/top:\s*0/);
    expect(r).toMatch(/background:\s*transparent/);
    // The old opaque fill on scroll is gone: the body fades out instead.
    expect(CSS).not.toMatch(/\.sheet\.scrolled > \.sheet-pinned-head\s*\{/);
    expect(rule(".sheet > .sheet-pinned-head ~ *"))
      .toContain("linear-gradient(to bottom, transparent var(--fade-from, 0px), #000 var(--fade-to, 0px))");
  });

  it("fades the body out under the band as it scrolls, and not at rest", async () => {
    const sheet = makeSheet();
    const rect = (el: Element, top: number, bottom: number) => {
      (el as any).getBoundingClientRect = () => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top });
    };
    g.PolarisTabs.pinSheetHead(sheet);
    const band = sheet.querySelector(".sheet-pinned-head")!;
    const body = sheet.querySelector("#x-body") as HTMLElement;
    rect(band, 100, 196);
    rect(body, 196, 900);
    g.PolarisTabs.pinSheetHead(sheet); // at rest: unmasked
    expect(body.style.getPropertyValue("--fade-from")).toBe("0px");
    expect(body.style.getPropertyValue("--fade-to")).toBe("0px");

    Object.defineProperty(sheet, "scrollTop", { value: 300, configurable: true });
    rect(body, -104, 600);
    sheet.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 30));
    // Clear to 12px above the band's edge (184), opaque 24px below it (220).
    expect(body.style.getPropertyValue("--fade-from")).toBe("288px");
    expect(body.style.getPropertyValue("--fade-to")).toBe("324px");
  });

  it("keeps the fade out of the asset screenshot", () => {
    expect(SHEET).toMatch(/toCanvas\(host, \{[^}]*style: unmask/);
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

describe("list fade under the top bar + pinned block (PolarisTabs.installListFade)", () => {
  const LISTED = ".app:has(> .app-body > .list-sticky-head)";

  beforeAll(() => {
    g.escapeHtml = (s: any) => String(s ?? "");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(mobile("tabs.js"))();
  });

  const rect = (el: Element, top: number, bottom: number) => {
    (el as any).getBoundingClientRect = () => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top });
  };

  it("pulls the body under the top bar and pins the block below it, only on list pages", () => {
    expect(rule(LISTED + " > #topbar-slot")).toMatch(/margin-bottom:\s*calc\(-1 \* var\(--topbar-h\)\)/);
    expect(rule(LISTED + " > .app-body")).toMatch(/padding-top:\s*var\(--topbar-h\)/);
    // A sticky box pins inside the scroller's padding, so the block keeps
    // top: 0 — a top of the bar's height pinned it a whole bar too low (seen
    // in Chrome: 128px under a 64px bar).
    expect(rule(".list-sticky-head")).toMatch(/top:\s*0/);
    expect(CSS).not.toContain(LISTED + " .list-sticky-head {");
    // The PTR puck is absolutely placed, which padding does not move.
    expect(rule(LISTED + " .ptr-indicator")).toMatch(/top:\s*calc\(var\(--topbar-h\) \+ 8px\)/);
  });

  it("masks the list from transparent at the body top to opaque at the block's bottom", () => {
    const decl = rule(".app-body > .list-sticky-head ~ :not(.ptr-indicator)");
    expect(decl).toContain("linear-gradient(to bottom, transparent var(--fade-from, 0px), #000 var(--fade-to, 0px))");
    expect(decl).toMatch(/-webkit-mask-image/);
  });

  it("places the two stops in the list's own coordinates on scroll", async () => {
    const body = document.createElement("main");
    body.className = "app-body";
    body.innerHTML = '<div class="list-sticky-head"></div><div id="host"></div><div class="ptr-indicator"></div>';
    document.body.appendChild(body);
    const head = body.querySelector(".list-sticky-head")!;
    const host = body.querySelector("#host") as HTMLElement;
    const ptr = body.querySelector(".ptr-indicator") as HTMLElement;
    rect(body, 0, 800);
    rect(head, 64, 214);      // pinned below a 64px bar, 150px tall
    rect(host, -300, 2000);   // scrolled 514px up
    Object.defineProperty(body, "scrollTop", { value: 514, configurable: true });
    g.PolarisTabs.installListFade(body);
    g.PolarisTabs.installListFade(body); // idempotent
    body.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 30));
    expect(host.style.getPropertyValue("--fade-from")).toBe("300px");
    // Opaque 24px below the block's edge (214 + 24), in the list's coordinates.
    expect(host.style.getPropertyValue("--fade-to")).toBe("538px");
    expect(ptr.style.getPropertyValue("--fade-to")).toBe("");

    // Barely scrolled: the lead is only as deep as the scroll, so a list at
    // rest is never faded.
    Object.defineProperty(body, "scrollTop", { value: 5, configurable: true });
    rect(host, 209, 2000);
    body.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 30));
    expect(host.style.getPropertyValue("--fade-to")).toBe("10px");
  });

  it("does nothing on a page with no pinned block", async () => {
    const body = document.createElement("main");
    body.innerHTML = '<div id="plain"></div>';
    document.body.appendChild(body);
    g.PolarisTabs.installListFade(body);
    body.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 30));
    expect((body.querySelector("#plain") as HTMLElement).style.getPropertyValue("--fade-to")).toBe("");
  });

  it("is installed on the shell's body", () => {
    const shell = APP.slice(APP.indexOf("function renderShell("), APP.indexOf("function renderShell(") + 600);
    expect(shell).toContain('PolarisTabs.installListFade(document.getElementById("app-body"))');
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
