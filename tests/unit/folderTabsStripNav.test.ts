/**
 * tests/unit/folderTabsStripNav.test.ts — the tab strip WINDOW
 * (public/js/folder-tabs.js → _measureStrip / _layoutStrip / _stepStrip and
 * the wheel).
 *
 * A strip with more tabs than room never scrolls natively (that showed tabs
 * past the card's edges, under a scrollbar). The tab list is pinned to a
 * fixed area (the room), and the row of tabs — each at its natural width,
 * never squeezed — SLIDES inside it on `translate`; the area fades at an edge
 * (ONE mask on the list, padded out so tab shadows survive — a per-tab mask
 * cut them off square) and a tab wholly outside is `visibility: hidden`. One
 * step — a wheel notch — slides by one tab. (There are no ‹ › buttons: they
 * were removed by request, 2026-10-26.)
 *
 * folder-tabs.js is a classic self-wiring script, so it is eval'd into a
 * happy-dom Window. happy-dom lays nothing out, so each tab reports its
 * natural width by hand (translate, mask and visibility do not change a
 * width). The tabs are 60 / 140 / 80 / 100 / 50 px — a 430px row, starts
 * 0 / 60 / 200 / 280 / 380. The strip is 250px with a 30px + button, so the
 * room is 220px and the row slides at most 210px. A step lands a tab's start
 * ON the area's left edge (the left fade lies OUTSIDE the area, in the 28px
 * before it), so steps land on 60 / 200 / 210. No CSS is loaded, so padding and gaps are 0. No
 * requestAnimationFrame in Node, so every step lands at once.
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
  /** One wheel notch: +1 slides right, -1 left. Returns the event. */
  step: (dir: number) => Event;
  pos: () => number;
  shown: () => boolean[];
  shift: (i: number) => number;
  /** Which edges of the tab AREA fade (one mask on the list, not per tab). */
  fades: () => { l: boolean; r: boolean };
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
    fades: () => {
      const s = list.style as unknown as Record<string, string>;
      const m = s.maskImage || s.webkitMaskImage || "";
      return { l: m.startsWith("linear-gradient(to right, transparent"), r: m.endsWith("transparent 100%)") };
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
  });

  it("adds no ‹ › buttons to the row", async () => {
    const b = await boot(5);
    expect(b.win.document.querySelector(".table-tabs-nav")).toBeNull();
    expect(b.strip.nextElementSibling?.id).toBe("controls");
  });

  it("pins the list to a fixed area and never resizes a tab", async () => {
    const b = await boot(5);
    expect(parseFloat(b.list.style.width)).toBe(220);
    expect(b.list.style.boxSizing).toBe("content-box");   // the shadow padding sits outside the area
    expect(b.tabs().every((t) => !t.style.width)).toBe(true);
    b.step(1);
    await b.settle();
    expect(parseFloat(b.list.style.width)).toBe(220);
    expect(b.tabs().every((t) => !t.style.width)).toBe(true);
  });

  it("at the start: the tab crossing the right edge fades, the ones past it are hidden, nothing fades on the left", async () => {
    const b = await boot(5);
    expect(b.shown()).toEqual([true, true, true, false, false]);
    expect(b.fades()).toEqual({ l: false, r: true });
    expect(b.tabs().every((t) => !t.style.maskImage)).toBe(true);   // no tab masks itself (its shadow would go)
  });

  it("a step slides one tab to the right, whatever its length", async () => {
    const b = await boot(5);
    b.step(1);
    await b.settle();
    expect(b.pos()).toBe(60);                // tab 1's start on the area's left edge
    expect(b.shift(1)).toBe(-60);
    expect(b.shown()).toEqual([true, true, true, false, false]);   // tab 0 fading out past the edge
    expect(b.fades()).toEqual({ l: true, r: true });
    b.step(1);
    await b.settle();
    expect(b.pos()).toBe(200);               // tab 2's start
    b.step(1);
    await b.settle();
    expect(b.pos()).toBe(210);               // the end: the last tab flush right
    expect(b.shown()).toEqual([false, true, true, true, true]);   // tab 1's last 10px still fading out left
    expect(b.fades()).toEqual({ l: true, r: false });   // nothing past the right edge
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
    expect(b.fades()).toEqual({ l: false, r: true });
  });

  it("slides a tab switched to fully into view", async () => {
    const b = await boot(5);
    b.tabs()[0].classList.remove("active");
    b.tabs()[4].classList.add("active");
    await b.settle();
    expect(b.pos()).toBe(210);
    expect(b.shown()[4]).toBe(true);
    expect(b.fades().r).toBe(false);
  });

  it("opens on the active tab when it starts out of view", async () => {
    const b = await boot(5, 3);
    expect(b.pos()).toBe(188);               // 280 + 100 − 220 + the 28px fade: clear of it
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
    expect(b.fades()).toEqual({ l: false, r: false });
    expect(b.tabs().every((t) => !t.style.translate && !t.style.visibility)).toBe(true);
  });
});

describe("fast wheeling (glides cut short)", () => {
  afterEach(() => {
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
  });

  it("finishes a cut-short glide at the row's end: the last tab whole, its edge not fading", async () => {
    const b = await boot(5);
    // A frame clock that never ticks on its own: every step after the first
    // lands mid-glide, as a fast wheel does.
    const frames: Array<(t: number) => void> = [];
    g.requestAnimationFrame = (cb: (t: number) => void) => { frames.push(cb); return frames.length; };
    g.cancelAnimationFrame = () => {};
    b.step(1); b.step(1); b.step(1);       // each cuts the last short; the third heads for the end
    b.step(1);                             // a notch AT the end: nothing further to glide to
    expect(b.pos()).toBe(210);
    expect(b.shown()).toEqual([false, true, true, true, true]);
    expect(b.fades()).toEqual({ l: true, r: false });
    expect(b.shift(4)).toBe(-210);         // drawn at the end, not frozen part-way
  });
});

describe("the card's cast fading in over the tab fades", () => {
  // The row as a folder CARD's head, with its card after it: the band lives in
  // the card (folder-tabs.js → _writeFadeCast).
  async function bootCard(n: number) {
    const b = await boot(n);
    const doc = b.win.document;
    const row = doc.querySelector(".table-head-row")!;
    row.classList.add("folder-head-card");
    const card = doc.createElement("div");
    card.className = "folder-card folder-body";
    doc.body.appendChild(card);
    Object.defineProperty(card, "getClientRects", { value: () => [{}], configurable: true });
    b.tabs()[0].classList.add("nudge");          // any watched change: re-sync with the card present
    await b.settle();
    const band = () => card.querySelector(":scope > .folder-cast-fade") as unknown as HTMLElement | null;
    const mask = () => {
      const s = band()!.style as unknown as Record<string, string>;
      return s.maskImage || s.webkitMaskImage || "";
    };
    return { ...b, band, mask };
  }

  it("lays the cast back over only the edge that is fading", async () => {
    const b = await bootCard(5);
    expect(b.band()).not.toBeNull();
    expect(b.band()!.hidden).toBe(false);
    expect(b.mask().startsWith("linear-gradient(to right, transparent")).toBe(true);   // nothing past the left edge yet
    b.step(1); b.step(1); b.step(1);
    await b.settle();
    expect(b.mask().endsWith("transparent 100%)")).toBe(true);                         // the end: nothing past the right edge
  });

  it("has no band while the tabs fit", async () => {
    const b = await bootCard(2);
    expect(!b.band() || b.band()!.hidden).toBe(true);
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
