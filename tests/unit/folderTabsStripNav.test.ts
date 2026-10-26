/**
 * tests/unit/folderTabsStripNav.test.ts — the tab strip WINDOW
 * (public/js/folder-tabs.js → _measureStrip / _layoutStrip / _stripStepTarget,
 * the ‹ › pair and the wheel).
 *
 * A strip with more tabs than room never scrolls natively (that showed tabs
 * past the card's edges, under a scrollbar). It is a window onto the row of
 * tabs: a tab the window's edge cuts is squeezed to the part inside, one wholly
 * outside is not drawn, so the drawn tabs always sum to the room. ‹ › move one
 * tab per click; a wheel moves the window by its delta.
 *
 * folder-tabs.js is a classic self-wiring script, so it is eval'd into a
 * happy-dom Window. happy-dom lays nothing out, so each tab reports its width
 * by hand: its squeezed inline width, 0 when hidden, else its natural 100px.
 * Five tabs = a 500px row; the strip is 250px wide with a 30px + button, so
 * the room is 220px. No CSS is loaded, so padding and gaps are 0.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const SRC = readFileSync(resolve(__dirname, "../../public/js/folder-tabs.js"), "utf8");
const g = globalThis as Record<string, unknown>;

const TAB_W = 100;
const ROOM = 220;

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

type El = HTMLElement & { __w?: number };

interface Boot {
  win: InstanceType<typeof Window>;
  strip: HTMLElement;
  tabs: () => HTMLElement[];
  nav: () => HTMLElement;
  prev: () => HTMLButtonElement;
  next: () => HTMLButtonElement;
  drawn: () => number[];
  pos: () => number;
  settle: () => Promise<void>;
}

function stubBox(el: El, width: () => number) {
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

  const strip = doc.getElementById("strip") as unknown as El;
  Object.defineProperty(strip, "clientWidth", { get: () => stripWidth, configurable: true });
  stubBox(strip, () => stripWidth);
  stubBox(doc.getElementById("add") as unknown as El, () => 30);
  const tabEls = () => Array.from(doc.querySelectorAll(".table-tab")) as unknown as El[];
  const stubTabs = () => tabEls().forEach((t) => stubBox(t, () =>
    t.style.display === "none" ? 0 : t.style.width ? parseFloat(t.style.width) : TAB_W));
  stubTabs();

  (0, eval)(SRC);
  const row = doc.querySelector(".table-head-row") as unknown as HTMLElement;
  const nav = () => row.querySelector(":scope > .table-tabs-nav") as unknown as HTMLElement;
  const st = () => (strip as unknown as { __tabWin: { pos: number } }).__tabWin;
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
    pos: () => st().pos,
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
    expect(b.drawn()).toEqual([100, 100]);
    expect(b.tabs().every((t) => !t.getAttribute("style"))).toBe(true);
    expect(b.nav().classList.contains("is-idle")).toBe(true);
  });

  it("places the pair right after the strip, before the controls", async () => {
    const b = await boot(5);
    expect(b.nav().previousElementSibling).toBe(b.strip);
    expect(b.nav().nextElementSibling?.id).toBe("controls");
  });

  it("draws exactly the room when the tabs overflow: whole tabs, then a squeezed one, then none", async () => {
    const b = await boot(5);
    expect(b.nav().classList.contains("is-idle")).toBe(false);
    expect(b.drawn()).toEqual([100, 100, 20, 0, 0]);
    expect(b.drawn().reduce((a, c) => a + c, 0)).toBe(ROOM);
    expect(b.tabs()[2].style.overflow).toBe("hidden");
    expect(b.prev().disabled).toBe(true);
    expect(b.next().disabled).toBe(false);
  });

  it("› moves one tab: the next tab on the right comes fully in, the left-most narrows", async () => {
    const b = await boot(5);
    b.next().click();
    await b.settle();
    expect(b.pos()).toBe(80);                 // tab 2's right edge (300) − room
    expect(b.drawn()).toEqual([20, 100, 100, 0, 0]);
    b.next().click();
    await b.settle();
    expect(b.pos()).toBe(180);
    expect(b.drawn()).toEqual([0, 20, 100, 100, 0]);
    expect(b.prev().disabled).toBe(false);
  });

  it("‹ moves one tab back: the next tab on the left comes fully in", async () => {
    const b = await boot(5);
    b.next().click(); b.next().click(); b.next().click();
    await b.settle();
    expect(b.pos()).toBe(280);                // the end: 500 − 220
    expect(b.next().disabled).toBe(true);
    expect(b.drawn()).toEqual([0, 0, 20, 100, 100]);
    b.prev().click();
    await b.settle();
    expect(b.pos()).toBe(200);                // tab 2's left edge
    expect(b.drawn()).toEqual([0, 0, 100, 100, 20]);
  });

  it("brings a tab switched to fully in", async () => {
    const b = await boot(5);
    b.tabs()[0].classList.remove("active");
    b.tabs()[4].classList.add("active");
    await b.settle();
    expect(b.pos()).toBe(280);
    expect(b.drawn()[4]).toBe(100);
  });

  it("opens on the active tab when it starts out of the window", async () => {
    const b = await boot(5, 3);
    expect(b.drawn()[3]).toBe(100);
  });

  it("lifts every squeeze when the tabs come to fit again", async () => {
    const b = await boot(5);
    b.tabs().slice(2).forEach((t) => t.remove());
    await b.settle();
    expect(b.drawn()).toEqual([100, 100]);
    expect(b.nav().classList.contains("is-idle")).toBe(true);
  });
});

describe("tab strip wheel", () => {
  function wheel(b: Boot, init: Record<string, number>) {
    const e = new b.win.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    b.strip.dispatchEvent(e as never);
    return e;
  }

  it("moves the window by a vertical wheel's delta and keeps the page still", async () => {
    const b = await boot(5);
    const e = wheel(b, { deltaY: 50 });
    expect(b.pos()).toBe(50);
    expect(e.defaultPrevented).toBe(true);
    expect(b.drawn()).toEqual([50, 100, 70, 0, 0]);
    wheel(b, { deltaY: -500 });
    expect(b.pos()).toBe(0);
  });

  it("follows a trackpad's sideways swipe too", async () => {
    const b = await boot(5);
    wheel(b, { deltaX: 40, deltaY: 3 });
    expect(b.pos()).toBe(40);
  });

  it("scales a line-mode wheel (Firefox) to pixels", async () => {
    const b = await boot(5);
    wheel(b, { deltaY: 3, deltaMode: 1 });
    expect(b.pos()).toBe(48);
  });

  it("does nothing while the tabs fit", async () => {
    const b = await boot(2);
    const e = wheel(b, { deltaY: 100 });
    expect(e.defaultPrevented).toBe(false);
  });
});
