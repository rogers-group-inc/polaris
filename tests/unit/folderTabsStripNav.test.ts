/**
 * tests/unit/folderTabsStripNav.test.ts — the tab strip WINDOW
 * (public/js/folder-tabs.js → _measureStrip / _layoutStrip / _stepStrip and
 * the wheel).
 *
 * A strip with more tabs than room never scrolls natively (that showed tabs
 * past the card's edges, under a scrollbar). The tab list is pinned to a
 * fixed area (the room), and the row of tabs — each at its natural width,
 * never squeezed — SLIDES inside it on `translate`. A tab an edge cuts is
 * clipped there (one SOLID mask block on the list, padded out so tab shadows
 * survive; never a gradient) and fades AS A WHOLE, its opacity the share of
 * it still inside; one wholly outside is `visibility: hidden`. One step — a
 * wheel notch — slides by one tab. (No ‹ › buttons: removed by request.)
 *
 * folder-tabs.js is a classic self-wiring script, so it is eval'd into a
 * happy-dom Window. happy-dom lays nothing out, so each tab reports its
 * natural width by hand (translate, mask, opacity and visibility do not
 * change a width). The tabs are 60 / 140 / 80 / 100 / 50 px — a 430px row,
 * starts 0 / 60 / 200 / 280 / 380. The strip is 250px with a 30px + button,
 * so the room is 220px and the row slides at most 210px. A step lands a tab's
 * start on the area's left edge: 60 / 200 / 210. No CSS is loaded, so padding
 * and gaps are 0. No requestAnimationFrame in Node, so every step lands at
 * once (except where a test supplies a frame clock).
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const SRC = readFileSync(resolve(__dirname, "../../public/js/folder-tabs.js"), "utf8");
const g = globalThis as Record<string, unknown>;

const WIDTHS = [60, 140, 80, 100, 50];
const ROOM = 220;
const PAD = 32;   // STRIP_SHADOW_PX: the list's mask padding

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
  /** One wheel notch: +1 slides right, -1 left. Returns the event. */
  step: (dir: number) => Event;
  pos: () => number;
  shown: () => boolean[];
  shift: (i: number) => number;
  /** A tab's opacity: 1 when it carries none of its own. */
  op: (i: number) => number;
  /** Which edges the list's mask CUTS at (none: no mask at all). */
  cuts: () => { l: boolean; r: boolean; gradient: boolean };
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
  const settle = async () => {
    stubTabs();
    await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 5));
  };
  await settle();
  const list = doc.getElementById("list") as unknown as HTMLElement;
  return {
    win,
    strip,
    list,
    tabs: tabEls,
    step: (dir) => {
      const e = new win.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 * dir });
      strip.dispatchEvent(e as never);
      return e as unknown as Event;
    },
    pos: () => (strip as unknown as { __tabWin: { pos: number } }).__tabWin.pos,
    shown: () => tabEls().map((t) => t.style.visibility !== "hidden"),
    shift: (i) => parseFloat(tabEls()[i].style.translate || "0") || 0,
    op: (i) => (tabEls()[i].style.opacity ? parseFloat(tabEls()[i].style.opacity) : 1),
    cuts: () => {
      const s = list.style as unknown as Record<string, string>;
      const img = s.maskImage || s.webkitMaskImage || "";
      if (!img) return { l: false, r: false, gradient: false };
      const x0 = parseFloat(s.maskPosition || s.webkitMaskPosition || "0");
      const w = parseFloat(s.maskSize || s.webkitMaskSize || "0");
      return { l: x0 === PAD, r: Math.abs(x0 + w - (PAD + ROOM)) < 0.5, gradient: /transparent/.test(img) };
    },
    settle,
  };
}

afterEach(() => {
  delete g.window;
  delete g.document;
});

describe("tab strip window", () => {
  it("leaves the tabs alone while they fit", async () => {
    const b = await boot(2);
    expect(b.tabs().every((t) => !t.getAttribute("style"))).toBe(true);
    expect(b.list.style.width).toBe("");
    expect(b.cuts()).toEqual({ l: false, r: false, gradient: false });
  });

  it("adds no ‹ › buttons to the row", async () => {
    const b = await boot(5);
    expect(b.win.document.querySelector(".table-tabs-nav")).toBeNull();
    expect(b.strip.nextElementSibling?.id).toBe("controls");
  });

  it("pins the list to a fixed area and never resizes a tab", async () => {
    const b = await boot(5);
    expect(parseFloat(b.list.style.width)).toBe(ROOM);
    expect(b.list.style.boxSizing).toBe("content-box");   // the shadow padding sits outside the area
    expect(b.tabs().every((t) => !t.style.width)).toBe(true);
    b.step(1);
    await b.settle();
    expect(parseFloat(b.list.style.width)).toBe(ROOM);
    expect(b.tabs().every((t) => !t.style.width)).toBe(true);
  });

  it("at the start: the tab the right edge cuts fades as a whole, the ones past it are hidden", async () => {
    const b = await boot(5);
    expect(b.shown()).toEqual([true, true, true, false, false]);
    expect(b.op(0)).toBe(1);
    expect(b.op(1)).toBe(1);
    expect(b.op(2)).toBe(0.25);              // 200..280: 20 of its 80px inside
    expect(b.cuts()).toEqual({ l: false, r: true, gradient: false });   // cut on the right only, no gradient
    expect(b.tabs().every((t) => !t.style.maskImage)).toBe(true);       // no tab masks itself
  });

  it("a step slides one tab to the right, whatever its length", async () => {
    const b = await boot(5);
    b.step(1);
    await b.settle();
    expect(b.pos()).toBe(60);                // tab 1's start on the area's left edge
    expect(b.shift(1)).toBe(-60);
    expect(b.shown()).toEqual([false, true, true, false, false]);   // tab 0 wholly out: hidden
    expect(b.op(2)).toBe(1);                 // 140..220: wholly inside now
    expect(b.cuts()).toEqual({ l: true, r: true, gradient: false });
    b.step(1);
    await b.settle();
    expect(b.pos()).toBe(200);               // tab 2's start
    expect(b.op(4)).toBe(0.8);               // 180..230: 40 of its 50px inside
    b.step(1);
    await b.settle();
    expect(b.pos()).toBe(210);               // the end: the last tab flush right
    expect(b.shown()).toEqual([false, false, true, true, true]);
    expect(b.op(2)).toBe(0.875);             // −10..70: 70 of its 80px inside
    expect(b.op(4)).toBe(1);
    expect(b.cuts()).toEqual({ l: true, r: false, gradient: false });   // nothing past the right edge
    b.step(1);
    await b.settle();
    expect(b.pos()).toBe(210);               // no further
  });

  it("a step back slides one tab to the left", async () => {
    const b = await boot(5);
    b.step(1); b.step(1); b.step(1);
    await b.settle();
    b.step(-1);
    await b.settle();
    expect(b.pos()).toBe(200);
    b.step(-1);
    await b.settle();
    expect(b.pos()).toBe(60);
    b.step(-1);
    await b.settle();
    expect(b.pos()).toBe(0);
    expect(b.cuts()).toEqual({ l: false, r: true, gradient: false });
  });

  it("slides a tab switched to fully into view", async () => {
    const b = await boot(5);
    b.tabs()[0].classList.remove("active");
    b.tabs()[4].classList.add("active");
    await b.settle();
    expect(b.pos()).toBe(210);
    expect(b.shown()[4]).toBe(true);
    expect(b.op(4)).toBe(1);
  });

  it("opens on the active tab when it starts out of view", async () => {
    const b = await boot(5, 3);
    expect(b.pos()).toBe(160);               // 280 + 100 − 220: its right end on the edge
    expect(b.op(3)).toBe(1);
  });

  it("keeps the active tab in view when the room shrinks after it was brought in", async () => {
    let width = 400;
    const b = await boot(5, 3, 400);
    Object.defineProperty(b.strip, "clientWidth", { get: () => width, configurable: true });
    width = 250;
    b.strip.classList.add("resized");
    await b.settle();
    expect(b.pos()).toBe(160);
  });

  it("leaves the window where the operator moved it when nothing about the tabs changed", async () => {
    const b = await boot(5);
    b.step(1); b.step(1);
    await b.settle();
    b.tabs()[2].classList.add("hover-ish");
    await b.settle();
    expect(b.pos()).toBe(200);
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
    b.step(1);
    await b.settle();
    b.tabs().slice(2).forEach((t) => t.remove());
    await b.settle();
    expect(b.list.style.width).toBe("");
    expect(b.list.style.padding).toBe("");
    expect(b.cuts()).toEqual({ l: false, r: false, gradient: false });
    expect(b.tabs().every((t) => !t.style.translate && !t.style.visibility && !t.style.opacity)).toBe(true);
  });

  it("adds no fade band to the card", async () => {
    const b = await boot(5);
    expect(b.win.document.querySelector(".folder-cast-fade")).toBeNull();
  });
});

describe("fast wheeling (glides cut short)", () => {
  afterEach(() => {
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
  });

  it("finishes a cut-short glide at the row's end: the last tab whole", async () => {
    const b = await boot(5);
    // A frame clock that never ticks on its own: every step after the first
    // lands mid-glide, as a fast wheel does.
    const frames: Array<(t: number) => void> = [];
    g.requestAnimationFrame = (cb: (t: number) => void) => { frames.push(cb); return frames.length; };
    g.cancelAnimationFrame = () => {};
    b.step(1); b.step(1); b.step(1);       // each cuts the last short; the third heads for the end
    b.step(1);                             // a notch AT the end: nothing further to glide to
    expect(b.pos()).toBe(210);
    expect(b.shown()).toEqual([false, false, true, true, true]);
    expect(b.op(4)).toBe(1);
    expect(b.cuts().r).toBe(false);
    expect(b.shift(4)).toBe(-210);         // drawn at the end, not frozen part-way
  });
});

describe("tab strip wheel", () => {
  function wheel(b: Boot, init: Record<string, number>) {
    const e = new b.win.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    b.strip.dispatchEvent(e as never);
    return e;
  }

  it("keeps the page still while it slides the tabs", async () => {
    const b = await boot(5);
    expect(b.step(1).defaultPrevented).toBe(true);
  });

  it("gathers a trackpad's small deltas into one step", async () => {
    const b = await boot(5);
    wheel(b, { deltaX: 20 });
    wheel(b, { deltaX: 20 });
    expect(b.pos()).toBe(0);
    wheel(b, { deltaX: 20 });
    expect(b.pos()).toBe(60);
  });

  it("treats a line-mode event (Firefox) as one notch", async () => {
    const b = await boot(5);
    wheel(b, { deltaY: 3, deltaMode: 1 });
    expect(b.pos()).toBe(60);
  });

  it("does nothing while the tabs fit", async () => {
    const b = await boot(2);
    const e = wheel(b, { deltaY: 100 });
    expect(e.defaultPrevented).toBe(false);
  });
});
