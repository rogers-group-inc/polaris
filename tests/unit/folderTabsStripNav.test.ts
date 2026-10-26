/**
 * tests/unit/folderTabsStripNav.test.ts — the tab strip WINDOW
 * (public/js/folder-tabs.js → _measureStrip / _layoutStrip / _stepStrip, the
 * ‹ › pair and the wheel).
 *
 * A strip with more tabs than room never scrolls natively (that showed tabs
 * past the card's edges, under a scrollbar). The tab list is pinned to a
 * fixed area (the room), and the row of tabs — each at its natural width,
 * never squeezed — SLIDES inside it on `translate`; a tab crossing an edge
 * fades into it (its own mask) and one wholly outside is `visibility:
 * hidden`. One step — a ‹ › click or a wheel notch — slides by one tab.
 *
 * folder-tabs.js is a classic self-wiring script, so it is eval'd into a
 * happy-dom Window. happy-dom lays nothing out, so each tab reports its
 * natural width by hand (translate, mask and visibility do not change a
 * width). The tabs are 60 / 140 / 80 / 100 / 50 px — a 430px row, starts
 * 0 / 60 / 200 / 280 / 380. The strip is 250px with a 30px + button, so the
 * room is 220px and the row slides at most 210px. Resting places leave the
 * 28px fade to the tab before (a step lands a tab start 28px in), so steps
 * land on 32 / 172 / 210. No CSS is loaded, so
 * padding and gaps are 0. No requestAnimationFrame in Node, so every step
 * lands at once.
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
  list: HTMLElement;
  tabs: () => HTMLElement[];
  nav: () => HTMLElement;
  prev: () => HTMLButtonElement;
  next: () => HTMLButtonElement;
  pos: () => number;
  shown: () => boolean[];
  shift: (i: number) => number;
  faded: (i: number) => boolean;
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
    stubBox(t, () => natural);
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
    list: doc.getElementById("list") as unknown as HTMLElement,
    tabs: tabEls,
    nav,
    prev: () => nav().querySelector('[data-dir="-1"]') as unknown as HTMLButtonElement,
    next: () => nav().querySelector('[data-dir="1"]') as unknown as HTMLButtonElement,
    pos: () => (strip as unknown as { __tabWin: { pos: number } }).__tabWin.pos,
    shown: () => tabEls().map((t) => t.style.visibility !== "hidden"),
    shift: (i) => parseFloat(tabEls()[i].style.translate || "0") || 0,
    faded: (i) => {
      const s = tabEls()[i].style as unknown as Record<string, string>;
      return /gradient/.test(s.maskImage || s.webkitMaskImage || "");
    },
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
    expect(b.tabs().every((t) => !t.getAttribute("style"))).toBe(true);
    expect(b.list.style.width).toBe("");
    expect(b.nav().classList.contains("is-idle")).toBe(true);
  });

  it("places the pair right after the strip, before the controls", async () => {
    const b = await boot(5);
    expect(b.nav().previousElementSibling).toBe(b.strip);
    expect(b.nav().nextElementSibling?.id).toBe("controls");
  });

  it("pins the list to a fixed area and never resizes a tab", async () => {
    const b = await boot(5);
    expect(parseFloat(b.list.style.width)).toBe(220);
    expect(b.tabs().every((t) => !t.style.width)).toBe(true);
    b.next().click();
    await b.settle();
    expect(parseFloat(b.list.style.width)).toBe(220);
    expect(b.tabs().every((t) => !t.style.width)).toBe(true);
  });

  it("at the start: the tab crossing the right edge fades, the ones past it are hidden, nothing fades on the left", async () => {
    const b = await boot(5);
    expect(b.shown()).toEqual([true, true, true, false, false]);
    expect(b.faded(0)).toBe(false);
    expect(b.faded(2)).toBe(true);           // 200..280 crosses the 220 edge
    expect(b.prev().disabled).toBe(true);
    expect(b.next().disabled).toBe(false);
  });

  it("› slides one tab each click, whatever its length", async () => {
    const b = await boot(5);
    b.next().click();
    await b.settle();
    expect(b.pos()).toBe(32);                // tab 1's start 28px in, past the fade
    expect(b.shift(1)).toBe(-32);
    expect(b.shown()).toEqual([true, true, true, false, false]);
    expect(b.faded(0)).toBe(true);           // tab 0's tail fades into the left edge
    expect(b.faded(1)).toBe(false);          // the first whole tab is fully opaque
    b.next().click();
    await b.settle();
    expect(b.pos()).toBe(172);               // tab 2's start, 28px in
    b.next().click();
    await b.settle();
    expect(b.pos()).toBe(210);               // the end: the last tab flush right
    expect(b.shown()).toEqual([false, false, true, true, true]);
    expect(b.faded(4)).toBe(false);          // nothing past the right edge
    expect(b.next().disabled).toBe(true);
    expect(b.prev().disabled).toBe(false);
  });

  it("‹ slides back one tab", async () => {
    const b = await boot(5);
    b.next().click(); b.next().click(); b.next().click();
    await b.settle();
    b.prev().click();
    await b.settle();
    expect(b.pos()).toBe(172);
    b.prev().click();
    await b.settle();
    expect(b.pos()).toBe(32);
  });

  it("slides a tab switched to fully into view", async () => {
    const b = await boot(5);
    b.tabs()[0].classList.remove("active");
    b.tabs()[4].classList.add("active");
    await b.settle();
    expect(b.pos()).toBe(210);
    expect(b.shown()[4]).toBe(true);
    expect(b.faded(4)).toBe(false);
  });

  it("opens on the active tab when it starts out of view", async () => {
    const b = await boot(5, 3);
    expect(b.pos()).toBe(188);               // 280 + 100 − 220 + the 28px fade
    expect(b.faded(3)).toBe(false);
  });

  it("keeps the active tab in view when the room shrinks after it was brought in", async () => {
    let width = 400;
    const b = await boot(5, 3, 400);
    Object.defineProperty(b.strip, "clientWidth", { get: () => width, configurable: true });
    width = 250;
    b.strip.classList.add("resized");
    await b.settle();
    expect(b.pos()).toBe(188);
  });

  it("leaves the window where the operator moved it when nothing about the tabs changed", async () => {
    const b = await boot(5);
    b.next().click(); b.next().click();
    await b.settle();
    b.tabs()[2].classList.add("hover-ish");
    await b.settle();
    expect(b.pos()).toBe(172);
  });

  it("keeps a HELD tab (one being dragged) in view on every pass", async () => {
    const b = await boot(5);
    const w = b.win as unknown as { PolarisFolderTabs: { hold: (s: unknown, e: unknown) => void } };
    w.PolarisFolderTabs.hold(b.strip, b.tabs()[4]);
    b.tabs()[4].classList.add("held");
    await b.settle();
    expect(b.shown()[4]).toBe(true);
    w.PolarisFolderTabs.hold(b.strip, null);
  });

  it("lifts everything when the tabs come to fit again", async () => {
    const b = await boot(5);
    b.next().click();
    await b.settle();
    b.tabs().slice(2).forEach((t) => t.remove());
    await b.settle();
    expect(b.list.style.width).toBe("");
    expect(b.tabs().every((t) => !t.style.translate && !t.style.visibility)).toBe(true);
    expect(b.nav().classList.contains("is-idle")).toBe(true);
  });
});

describe("tab strip wheel", () => {
  function wheel(b: Boot, init: Record<string, number>) {
    const e = new b.win.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    b.strip.dispatchEvent(e as never);
    return e;
  }

  it("slides one tab per mouse-wheel notch and keeps the page still", async () => {
    const b = await boot(5);
    const e = wheel(b, { deltaY: 100 });
    expect(b.pos()).toBe(32);
    expect(e.defaultPrevented).toBe(true);
    wheel(b, { deltaY: 100 });
    expect(b.pos()).toBe(172);
    wheel(b, { deltaY: -100 });
    expect(b.pos()).toBe(32);
  });

  it("gathers a trackpad's small deltas into one step", async () => {
    const b = await boot(5);
    wheel(b, { deltaX: 20 });
    wheel(b, { deltaX: 20 });
    expect(b.pos()).toBe(0);
    wheel(b, { deltaX: 20 });
    expect(b.pos()).toBe(32);
  });

  it("treats a line-mode event (Firefox) as one notch", async () => {
    const b = await boot(5);
    wheel(b, { deltaY: 3, deltaMode: 1 });
    expect(b.pos()).toBe(32);
  });

  it("does nothing while the tabs fit", async () => {
    const b = await boot(2);
    const e = wheel(b, { deltaY: 100 });
    expect(e.defaultPrevented).toBe(false);
  });
});
