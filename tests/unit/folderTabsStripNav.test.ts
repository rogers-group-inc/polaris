/**
 * tests/unit/folderTabsStripNav.test.ts — the tab strip WINDOW
 * (public/js/folder-tabs.js → _measureStrip / _runWidths / _stepStrip, the
 * ‹ › pair and the wheel).
 *
 * A strip with more tabs than room never scrolls natively (that showed tabs
 * past the card's edges, under a scrollbar). It shows a run of WHOLE tabs that
 * fits its room, starting at `first`, and draws none of the rest, so no tab is
 * ever a sliver. One step — a ‹ › click or a wheel notch — moves `first` by
 * one tab, whatever that tab's length.
 *
 * folder-tabs.js is a classic self-wiring script, so it is eval'd into a
 * happy-dom Window. happy-dom lays nothing out, so each tab reports its width
 * by hand: its squeezed inline width, 0 when hidden, else its natural width.
 * The tabs are 60 / 140 / 80 / 100 / 50 px — different lengths, so a step is
 * seen to be one TAB, not a fixed distance. The strip is 250px with a 30px +
 * button, so the room is 220px. No CSS is loaded, so padding and gaps are 0.
 * No requestAnimationFrame in Node, so every step lands at once.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const SRC = readFileSync(resolve(__dirname, "../../public/js/folder-tabs.js"), "utf8");
const g = globalThis as Record<string, unknown>;

const WIDTHS = [60, 140, 80, 100, 50];

function rowHtml(n: number, active: number) {
  let tabs = "";
  for (let i = 0; i < n; i++) {
    tabs += '<button class="table-tab' + (i === active ? " active" : "") + '" data-tab="t' + i + '">Tab ' + i + "</button>";
  }
  return '<div class="table-head-row">' +
    '<div class="table-tabs" id="strip"><div class="table-tabs-list" id="list">' + tabs + "</div>" +
      '<button class="table-tab-add" id="add">+</button></div>' +
    '<div class="table-head-controls" id="controls"><button class="btn">Clear</button></div>' +
  "</div>";
}

interface Boot {
  win: InstanceType<typeof Window>;
  strip: HTMLElement;
  tabs: () => HTMLElement[];
  nav: () => HTMLElement;
  prev: () => HTMLButtonElement;
  next: () => HTMLButtonElement;
  drawn: () => number[];
  first: () => number;
  settle: () => Promise<void>;
}

function stubBox(el: HTMLElement, width: () => number) {
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ width: width(), height: 20, left: 0, right: width(), top: 0, bottom: 20 }),
    configurable: true,
  });
  Object.defineProperty(el, "getClientRects", { value: () => (width() ? [{}] : []), configurable: true });
}

async function boot(n: number, active = 0, stripWidth = 250): Promise<Boot> {
  const win = new Window();
  const doc = win.document;
  g.window = win;
  g.document = doc;
  g.getComputedStyle = win.getComputedStyle.bind(win);
  g.Node = win.Node;
  g.MutationObserver = win.MutationObserver;
  g.ResizeObserver = undefined;
  doc.body.innerHTML = rowHtml(n, active);

  const strip = doc.getElementById("strip") as unknown as HTMLElement;
  Object.defineProperty(strip, "clientWidth", { get: () => stripWidth, configurable: true });
  stubBox(strip, () => stripWidth);
  stubBox(doc.getElementById("add") as unknown as HTMLElement, () => 30);
  const tabEls = () => Array.from(doc.querySelectorAll(".table-tab")) as unknown as HTMLElement[];
  const stubTabs = () => tabEls().forEach((t) => {
    const natural = WIDTHS[Number(t.getAttribute("data-tab")!.slice(1))];
    stubBox(t, () => (t.style.display === "none" ? 0 : t.style.width ? parseFloat(t.style.width) : natural));
  });
  stubTabs();

  (0, eval)(SRC);
  const row = doc.querySelector(".table-head-row") as unknown as HTMLElement;
  const nav = () => row.querySelector(":scope > .table-tabs-nav") as unknown as HTMLElement;
  const settle = async () => {
    stubTabs();
    await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 5));
  };
  await settle();
  return {
    win,
    strip,
    tabs: tabEls,
    nav,
    prev: () => nav().querySelector('[data-dir="-1"]') as unknown as HTMLButtonElement,
    next: () => nav().querySelector('[data-dir="1"]') as unknown as HTMLButtonElement,
    drawn: () => tabEls().map((t) => Math.round(t.getBoundingClientRect().width)),
    first: () => (strip as unknown as { __tabWin: { first: number } }).__tabWin.first,
    settle,
  };
}

afterEach(() => {
  delete g.window;
  delete g.document;
});

describe("tab strip window", () => {
  it("leaves the tabs alone and the pair hidden while they fit", async () => {
    const b = await boot(2);
    expect(b.drawn()).toEqual([60, 140]);
    expect(b.tabs().every((t) => !t.getAttribute("style"))).toBe(true);
    expect(b.nav().classList.contains("is-idle")).toBe(true);
  });

  it("places the pair right after the strip, before the controls", async () => {
    const b = await boot(5);
    expect(b.nav().previousElementSibling).toBe(b.strip);
    expect(b.nav().nextElementSibling?.id).toBe("controls");
  });

  it("shows only whole tabs when they overflow — no sliver at the end", async () => {
    const b = await boot(5);
    expect(b.nav().classList.contains("is-idle")).toBe(false);
    expect(b.drawn()).toEqual([60, 140, 0, 0, 0]);   // 80 more would be 280 > 220
    expect(b.prev().disabled).toBe(true);
    expect(b.next().disabled).toBe(false);
  });

  it("› moves one tab each click, whatever its length", async () => {
    const b = await boot(5);
    b.next().click();
    await b.settle();
    expect(b.first()).toBe(1);
    expect(b.drawn()).toEqual([0, 140, 80, 0, 0]);
    b.next().click();
    await b.settle();
    expect(b.drawn()).toEqual([0, 0, 80, 100, 0]);
    b.next().click();
    await b.settle();
    expect(b.drawn()).toEqual([0, 0, 0, 100, 50]);   // the end: every remaining tab fits
    expect(b.next().disabled).toBe(true);
    expect(b.prev().disabled).toBe(false);
  });

  it("‹ moves one tab back", async () => {
    const b = await boot(5);
    b.next().click(); b.next().click(); b.next().click();
    await b.settle();
    b.prev().click();
    await b.settle();
    expect(b.first()).toBe(2);
    expect(b.drawn()).toEqual([0, 0, 80, 100, 0]);
  });

  it("brings a tab switched to into the run", async () => {
    const b = await boot(5);
    b.tabs()[0].classList.remove("active");
    b.tabs()[4].classList.add("active");
    await b.settle();
    expect(b.drawn()[4]).toBe(50);
    expect(b.first()).toBe(3);
  });

  it("opens on the active tab when it starts outside the run", async () => {
    const b = await boot(5, 3);
    expect(b.drawn()[3]).toBe(100);
  });

  it("squeezes a single tab wider than the whole room rather than drawing nothing", async () => {
    const b = await boot(5, 0, 150);   // room 120 < tab 1's 140
    b.next().click();
    await b.settle();
    expect(b.drawn()).toEqual([0, 120, 0, 0, 0]);
  });

  it("lifts every squeeze when the tabs come to fit again", async () => {
    const b = await boot(5);
    b.tabs().slice(2).forEach((t) => t.remove());
    await b.settle();
    expect(b.drawn()).toEqual([60, 140]);
    expect(b.nav().classList.contains("is-idle")).toBe(true);
  });
});

describe("tab strip wheel", () => {
  function wheel(b: Boot, init: Record<string, number>) {
    const e = new b.win.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    b.strip.dispatchEvent(e as never);
    return e;
  }

  it("steps one tab per mouse-wheel notch and keeps the page still", async () => {
    const b = await boot(5);
    const e = wheel(b, { deltaY: 100 });
    expect(b.first()).toBe(1);
    expect(e.defaultPrevented).toBe(true);
    wheel(b, { deltaY: 100 });
    expect(b.first()).toBe(2);
    wheel(b, { deltaY: -100 });
    expect(b.first()).toBe(1);
  });

  it("gathers a trackpad's small deltas into one step", async () => {
    const b = await boot(5);
    wheel(b, { deltaX: 20 });
    wheel(b, { deltaX: 20 });
    expect(b.first()).toBe(0);
    wheel(b, { deltaX: 20 });
    expect(b.first()).toBe(1);
  });

  it("treats a line-mode event (Firefox) as one notch", async () => {
    const b = await boot(5);
    wheel(b, { deltaY: 3, deltaMode: 1 });
    expect(b.first()).toBe(1);
  });

  it("does nothing while the tabs fit", async () => {
    const b = await boot(2);
    const e = wheel(b, { deltaY: 100 });
    expect(e.defaultPrevented).toBe(false);
  });
});
