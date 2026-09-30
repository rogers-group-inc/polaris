/**
 * tests/unit/panelsAnywhereDom.test.ts — the slide-overs from any page
 * (PolarisPanels + friends in public/js/app.js).
 *
 * The asset, network and block slide-overs used to be reachable only on the
 * pages that load their scripts; everywhere else a click-through navigated to
 * the panel's home page and the operator lost their place. PolarisPanels loads
 * a panel's scripts on demand and opens it in place. What's pinned here:
 *
 *  - a page that already carries the opener never fetches a script, and a
 *    page that doesn't gets the bundle in ORDER (the files declare globals the
 *    next one reads at evaluation time);
 *  - a script that fails to load falls back to the deep link every caller used
 *    before — the operator still gets there;
 *  - the Dash wallboard never opens a panel (no session);
 *  - a global-search hit off its home page opens in place rather than
 *    navigating, and on its home page still runs the page's own handler;
 *  - the #view=asset: deep links widgets and the Events page emit open in place
 *    on a plain left click and stay links for ctrl/middle/target=_blank;
 *  - two slide-overs stacked: the later one in the DOM is the topmost (Escape
 *    goes to it), and a closed overlay re-opened from under another is raised
 *    above it first.
 *
 * app.js is a browser script with no module boundary, so the pieces under test
 * are sliced out by name and eval'd into a happy-dom Window — the approach of
 * tests/unit/assetPanelHistoryDom.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, any>;
const appLines = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8").split(/\r?\n/);

/** Slice a top-level block that starts with `prefix` and ends at the first bare `}` / `};`. */
function blockSrc(prefix: string): string {
  const start = appLines.findIndex((l) => l.startsWith(prefix));
  if (start < 0) throw new Error(`app.js: ${prefix} not found`);
  const end = appLines.findIndex((l, i) => i > start && (l === "}" || l === "};"));
  if (end < 0) throw new Error(`app.js: no end of ${prefix}`);
  return appLines.slice(start, end + 1).join("\n");
}

const BLOCKS = [
  "var _PANEL_SCRIPT_BUNDLES = {",
  "function _loadPanelScript(",
  "function ensurePanelScripts(",
  "function _panelFallbackNavigate(",
  "function networkPanelHash(",
  "var PolarisPanels = {",
  "function isTopmostSlideover(",
  "function wireSlideoverEscape(",
  "function raiseSlideover(",
  "function _wirePanelDeepLinks(",
  "function openSearchResult(",
  "function _searchTargetFor(",
];
const ONE_LINERS = [
  "var _PANEL_OPENERS = ",
  "var _panelScriptLoads = ",
];
const SRC =
  ONE_LINERS.map((p) => appLines.find((l) => l.startsWith(p))!).join("\n") + "\n" +
  BLOCKS.map(blockSrc).join("\n") + "\n" +
  // The sliced functions call each other by bare name, so they have to land on
  // globalThis rather than in a Function body's scope.
  ["_loadPanelScript", "ensurePanelScripts", "_panelFallbackNavigate", "networkPanelHash", "PolarisPanels",
    "isTopmostSlideover", "wireSlideoverEscape", "raiseSlideover", "_wirePanelDeepLinks", "openSearchResult", "_searchTargetFor",
    "_PANEL_SCRIPT_BUNDLES", "_PANEL_OPENERS", "_panelScriptLoads"]
    .map((n) => `globalThis.${n} = ${n};`).join("\n");

let win: Window;
let doc: Window["document"];
let navigatedTo: string[];
/** The <script> elements _loadPanelScript handed to body.appendChild, in order. */
let appended: any[];

function setup(url = "https://polaris.test/events.html"): void {
  // Anchor clicks the delegate leaves alone must not navigate the window.
  win = new Window({
    url,
    settings: {
      disableJavaScriptFileLoading: true,
      navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true },
    },
  });
  doc = win.document;
  navigatedTo = [];
  appended = [];
  g.window = win;
  g.document = doc;
  g._hideSearchDropdown = () => {};
  g.api = { subnets: { get: vi.fn(async () => ({ cidr: "10.4.12.0/24" })) } };
  // happy-dom fetches (or, with file loading disabled, fails) every <script src>
  // the moment it is appended and fires load / error on its own schedule. The
  // loader is the thing under test, so appendChild is stubbed to RECORD the
  // element and the tests fire onload / onerror by hand.
  (doc.body as any).appendChild = (el: any) => { appended.push(el); return el; };
  // Indirect eval runs at GLOBAL scope, so the declarations land on globalThis
  // and a bare-name call inside one resolves through it — which is what lets
  // the navigation stub below replace the real fallback.
  (0, eval)(SRC);
  g._wirePanelDeepLinks();
  // The navigation fallback is the one thing this harness must not let run for
  // real; the methods reach it by bare name, so a global override is honoured.
  g._panelFallbackNavigate = (href: string) => { navigatedTo.push(href); return false; };
  delete (win as any).openViewModal;
  delete (win as any).openIpPanel;
  delete (win as any).openBlockPanel;
  delete (win as any).POLARIS_DASH_LOCAL;
}

const appendedScripts = () => appended.map((s) => s.getAttribute("src"));
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Fire onload on every appended script, defining the opener when the named file lands. */
async function loadAll(openerFile: string, opener: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const pending = appended.filter((s: any) => !s.__fired);
    if (!pending.length) { await settle(); continue; }
    for (const s of pending) {
      s.__fired = true;
      if (s.getAttribute("src") === openerFile) (win as any)[opener] = vi.fn();
      s.onload();
      await settle();
    }
  }
}

beforeEach(() => setup());

describe("ensurePanelScripts", () => {
  it("fetches nothing on a page that already carries the opener", async () => {
    (win as any).openViewModal = vi.fn();
    await g.ensurePanelScripts("asset");
    expect(appendedScripts()).toEqual([]);
  });

  it("loads the network bundle in order and skips a file the page loaded statically", async () => {
    doc.body.innerHTML = '<script src="/js/table-sf.js"></script>';
    const p = g.ensurePanelScripts("network");
    await loadAll("/js/ip-panel.js", "openIpPanel");
    await p;
    // table-sf.js was already there — it must not be appended a second time.
    expect(appendedScripts()).toEqual([
      "/js/placeholder-mac.js", "/js/reservation-notes.js", "/js/ip-panel.js",
    ]);
    // Sequential: the second file is appended only after the first fired onload,
    // which is what loadAll's one-at-a-time firing relies on to have seen them all.
    const order = appendedScripts();
    expect(order.indexOf("/js/placeholder-mac.js")).toBeLessThan(order.indexOf("/js/ip-panel.js"));
  });

  it("requests a file once even when two panels want it at the same time", async () => {
    const p1 = g.ensurePanelScripts("network");
    const p2 = g.ensurePanelScripts("network");
    await loadAll("/js/ip-panel.js", "openIpPanel");
    await Promise.all([p1, p2]);
    expect(appendedScripts().filter((s) => s === "/js/table-sf.js")).toHaveLength(1);
  });

  it("rejects when a file fails to load, and lets a later open retry it", async () => {
    const p = g.ensurePanelScripts("block");
    await settle();
    appended[0].onerror();
    await expect(p).rejects.toThrow(/block-panel/);
    // The failed entry was dropped, so the next attempt appends a fresh tag
    // (left pending: nothing fires its onload here).
    g.ensurePanelScripts("block").catch(() => {});
    await settle();
    expect(appendedScripts().filter((x) => x === "/js/block-panel.js")).toHaveLength(2);
  });

  it("refuses an unknown panel kind", async () => {
    await expect(g.ensurePanelScripts("sensor")).rejects.toThrow(/Unknown panel/);
  });
});

describe("PolarisPanels openers", () => {
  it("openAsset opens in place once assets.js has landed, carrying opts.tab", async () => {
    const p = g.PolarisPanels.openAsset("A1", { tab: "notifications" });
    await loadAll("/js/assets.js", "openViewModal");
    expect(await p).toBe(true);
    expect((win as any).openViewModal).toHaveBeenCalledWith("A1", { tab: "notifications" });
    expect(navigatedTo).toEqual([]);
    // The asset bundle is the same list the dashboard / map load statically;
    // assets.js must come after its dependencies and before the wizard it opens.
    const order = appendedScripts();
    expect(order.indexOf("/js/table-sf.js")).toBeLessThan(order.indexOf("/js/assets.js"));
    expect(order.indexOf("/js/assets.js")).toBeLessThan(order.indexOf("/js/automations-wizard.js"));
  });

  it("openAsset falls back to the deep link when the scripts cannot load", async () => {
    const p = g.PolarisPanels.openAsset("A1", { tab: "notifications" });
    await settle();
    appended[0].onerror();
    expect(await p).toBe(false);
    expect(navigatedTo).toEqual(["/assets.html#view=asset:A1&tab=notifications"]);
  });

  it("openAsset is a no-op on the Dash wallboard", async () => {
    (win as any).POLARIS_DASH_LOCAL = true;
    expect(await g.PolarisPanels.openAsset("A1")).toBe(false);
    expect(appendedScripts()).toEqual([]);
    expect(navigatedTo).toEqual([]);
  });

  it("openNetwork looks up the subnet CIDR for a focusIp so the panel lands on the right page", async () => {
    (win as any).openIpPanel = vi.fn();
    expect(await g.PolarisPanels.openNetwork("S1", { focusIp: "10.4.12.63" })).toBe(true);
    expect(g.api.subnets.get).toHaveBeenCalledWith("S1");
    expect((win as any).openIpPanel).toHaveBeenCalledWith("S1", { focusIp: "10.4.12.63", subnetCidr: "10.4.12.0/24" });
  });

  it("openNetwork skips the lookup when the caller already knows the CIDR, and passes a reservation focus through", async () => {
    (win as any).openIpPanel = vi.fn();
    await g.PolarisPanels.openNetwork("S1", { focusIp: "10.4.12.63", subnetCidr: "10.4.12.0/24" });
    expect(g.api.subnets.get).not.toHaveBeenCalled();
    await g.PolarisPanels.openNetwork("S1", { focusReservationId: "R9" });
    expect((win as any).openIpPanel).toHaveBeenLastCalledWith("S1", { focusReservationId: "R9" });
    await g.PolarisPanels.openNetwork("S1");
    expect((win as any).openIpPanel).toHaveBeenLastCalledWith("S1", undefined);
  });

  it("openNetwork still opens when the CIDR lookup fails", async () => {
    (win as any).openIpPanel = vi.fn();
    g.api.subnets.get = vi.fn(async () => { throw new Error("403"); });
    expect(await g.PolarisPanels.openNetwork("S1", { focusIp: "10.4.12.63" })).toBe(true);
    expect((win as any).openIpPanel).toHaveBeenCalledWith("S1", { focusIp: "10.4.12.63" });
  });

  it("openNetwork's fallback deep link is the one the IPAM page already reads", async () => {
    const p = g.PolarisPanels.openNetwork("S1", { focusIp: "10.4.12.63" });
    await settle();
    appended[0].onerror();
    await p;
    expect(navigatedTo).toEqual(["/ipam.html#tab=networks&ip=S1@10.4.12.63"]);
    expect(g.networkPanelHash("S1", { focusReservationId: "R9" })).toBe("#tab=networks&subnet=S1&focusReservation=R9");
    expect(g.networkPanelHash("S1")).toBe("#tab=networks&subnet=S1");
  });

  it("openBlock opens the drill-in in place and falls back to the blocks deep link", async () => {
    (win as any).openBlockPanel = vi.fn();
    expect(await g.PolarisPanels.openBlock("B1")).toBe(true);
    expect((win as any).openBlockPanel).toHaveBeenCalledWith("B1");
    delete (win as any).openBlockPanel;
    const p = g.PolarisPanels.openBlock("B1");
    await settle();
    appended[0].onerror();
    await p;
    expect(navigatedTo).toEqual(["/ipam.html#tab=blocks&view=block:B1"]);
  });
});

describe("global search off the record's home page", () => {
  it("opens an asset hit in place instead of navigating", () => {
    const openAsset = vi.spyOn(g.PolarisPanels, "openAsset").mockResolvedValue(true);
    g.openSearchResult({ type: "asset", id: "A1" });
    expect(openAsset).toHaveBeenCalledWith("A1");
    expect(win.location.pathname).toBe("/events.html");
  });

  it("opens a subnet, a reservation and an IP hit in the network slide-over", () => {
    const openNetwork = vi.spyOn(g.PolarisPanels, "openNetwork").mockResolvedValue(true);
    g.openSearchResult({ type: "subnet", id: "S1" });
    expect(openNetwork).toHaveBeenLastCalledWith("S1");
    g.openSearchResult({ type: "reservation", id: "R1", subnetId: "S1" });
    expect(openNetwork).toHaveBeenLastCalledWith("S1", { focusReservationId: "R1" });
    g.openSearchResult({ type: "ip", id: "10.4.12.63", context: { subnetId: "S1", ipAddress: "10.4.12.63" } });
    expect(openNetwork).toHaveBeenLastCalledWith("S1", { focusIp: "10.4.12.63" });
  });

  it("opens a block hit in the block drill-in", () => {
    const openBlock = vi.spyOn(g.PolarisPanels, "openBlock").mockResolvedValue(true);
    g.openSearchResult({ type: "block", id: "B1" });
    expect(openBlock).toHaveBeenCalledWith("B1");
  });

  it("still runs the page's own handler on the record's home page", () => {
    setup("https://polaris.test/assets.html");
    const openAsset = vi.spyOn(g.PolarisPanels, "openAsset");
    (win as any).openViewModal = vi.fn();
    g.openViewModal = (win as any).openViewModal;
    g.openSearchResult({ type: "asset", id: "A1" });
    expect(g.openViewModal).toHaveBeenCalledWith("A1");
    expect(openAsset).not.toHaveBeenCalled();
  });
});

describe("#view=asset: deep links", () => {
  function link(href: string, attrs = ""): HTMLElement {
    doc.body.innerHTML = `<a id="l" href="${href}" ${attrs}><span id="inner">gate</span></a>`;
    return doc.getElementById("inner") as HTMLElement;
  }
  function click(el: HTMLElement, init: Record<string, unknown> = {}): boolean {
    const ev = new (win as any).MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  it("a plain left click opens the panel in place, tab included, and is consumed", () => {
    const openAsset = vi.spyOn(g.PolarisPanels, "openAsset").mockResolvedValue(true);
    expect(click(link("/assets.html#view=asset:A%201&tab=notifications"))).toBe(true);
    expect(openAsset).toHaveBeenCalledWith("A 1", { tab: "notifications" });
  });

  it("modifier clicks, a target=_blank and an already-handled click keep the link", () => {
    const openAsset = vi.spyOn(g.PolarisPanels, "openAsset").mockResolvedValue(true);
    expect(click(link("/assets.html#view=asset:A1"), { ctrlKey: true })).toBe(false);
    expect(click(link("/assets.html#view=asset:A1"), { metaKey: true })).toBe(false);
    expect(click(link("/assets.html#view=asset:A1"), { button: 1 })).toBe(false);
    expect(click(link("/assets.html#view=asset:A1", 'target="_blank"'))).toBe(false);
    const inner = link("/assets.html#view=asset:A1");
    // The Down Assets widget's own listener runs first and calls preventDefault.
    inner.addEventListener("click", (e) => e.preventDefault());
    click(inner);
    expect(openAsset).not.toHaveBeenCalled();
  });

  it("ignores links to anything else", () => {
    const openAsset = vi.spyOn(g.PolarisPanels, "openAsset").mockResolvedValue(true);
    expect(click(link("/ipam.html#tab=networks&subnet=S1"))).toBe(false);
    expect(openAsset).not.toHaveBeenCalled();
  });
});

describe("two slide-overs stacked", () => {
  // raiseSlideover really moves elements, so these need the real appendChild back.
  beforeEach(() => { delete (doc.body as any).appendChild; });

  function overlays(): { a: HTMLElement; b: HTMLElement } {
    doc.body.innerHTML =
      '<div id="a" class="slideover-overlay"></div>' +
      '<div id="b" class="slideover-overlay"></div>' +
      '<div id="modal-overlay" class="modal-overlay"></div>';
    return { a: doc.getElementById("a") as HTMLElement, b: doc.getElementById("b") as HTMLElement };
  }

  it("the later overlay in the DOM is the topmost, and a modal over it takes precedence", () => {
    const { a, b } = overlays();
    expect(g.isTopmostSlideover(a)).toBe(false);          // closed
    a.classList.add("open");
    expect(g.isTopmostSlideover(a)).toBe(true);
    b.classList.add("open");
    expect(g.isTopmostSlideover(a)).toBe(false);          // b paints over it
    expect(g.isTopmostSlideover(b)).toBe(true);
    doc.getElementById("modal-overlay")!.classList.add("open");
    expect(g.isTopmostSlideover(b)).toBe(false);          // Reserve IP over the network panel
  });

  it("one Escape closes exactly the topmost panel, whichever order the handlers were wired in", () => {
    const { a, b } = overlays();
    const closed: string[] = [];
    const closer = (el: HTMLElement) => () => { closed.push(el.id); el.classList.remove("open"); };
    // b (the panel on top) wired FIRST: once it closes, a is topmost, and a
    // handler registered after b's would close it on the same keypress unless
    // the event stops.
    g.wireSlideoverEscape(b, closer(b));
    g.wireSlideoverEscape(a, closer(a));
    a.classList.add("open"); b.classList.add("open");
    const esc = () => doc.dispatchEvent(new (win as any).KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    esc();
    expect(closed).toEqual(["b"]);
    esc();
    expect(closed).toEqual(["b", "a"]);
    // A modal on top owns the key; a closed panel never answers.
    a.classList.add("open");
    doc.getElementById("modal-overlay")!.classList.add("open");
    esc();
    expect(closed).toEqual(["b", "a"]);
  });

  it("raiseSlideover moves a closed overlay past the slide-overs after it, and leaves an open one alone", () => {
    const { a, b } = overlays();
    b.classList.add("open");
    g.raiseSlideover(a);                                   // a re-opened from inside b
    const order = () => Array.from(doc.body.children).map((el) => el.id);
    expect(order()).toEqual(["b", "modal-overlay", "a"]);
    expect(g.isTopmostSlideover(a)).toBe(false);           // still closed until revealed
    a.classList.add("open");
    expect(g.isTopmostSlideover(a)).toBe(true);
    // An open overlay (a panel pivoting in place) is not re-inserted.
    g.raiseSlideover(b);
    expect(order()).toEqual(["b", "modal-overlay", "a"]);
    // Nothing after it → nothing to do.
    a.classList.remove("open");
    g.raiseSlideover(a);
    expect(order()).toEqual(["b", "modal-overlay", "a"]);
  });
});
