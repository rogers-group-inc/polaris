/**
 * tests/unit/folderTabsStripNav.test.ts — the tab strip's ‹ › pair and wheel
 * scrolling (public/js/folder-tabs.js → _ensureStripNav / _syncStripNav /
 * _wireStripWheel).
 *
 * A strip longer than the room the head row's controls leave it scrolls
 * sideways instead of pushing them. The pair is shown only while it overflows,
 * each end disabled when there is nothing further that way, and a vertical
 * wheel over the strip scrolls it sideways.
 *
 * folder-tabs.js is a classic self-wiring script, so it is eval'd into a
 * happy-dom Window. happy-dom lays nothing out, so the strip's scrollWidth /
 * clientWidth / getClientRects are given by hand — the only things the pair
 * measures.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const SRC = readFileSync(resolve(__dirname, "../../public/js/folder-tabs.js"), "utf8");
const g = globalThis as Record<string, unknown>;

const ROW_HTML =
  '<div class="table-head-row">' +
    '<div class="table-tabs" id="strip">' +
      '<button class="table-tab active" data-tab="a">All</button>' +
      '<button class="table-tab" data-tab="b">Switches</button>' +
    "</div>" +
    '<div class="table-head-controls" id="controls"><button class="btn">Clear</button></div>' +
  "</div>";

interface Boot {
  win: InstanceType<typeof Window>;
  strip: HTMLElement;
  nav: () => HTMLElement | null;
  prev: () => HTMLButtonElement;
  next: () => HTMLButtonElement;
  setWidths: (scroll: number, client: number) => void;
  resync: () => Promise<void>;
}

async function boot(scroll: number, client: number): Promise<Boot> {
  const win = new Window();
  const doc = win.document;
  g.window = win;
  g.document = doc;
  g.getComputedStyle = win.getComputedStyle.bind(win);
  g.Node = win.Node;
  g.MutationObserver = win.MutationObserver;
  g.ResizeObserver = undefined;
  doc.body.innerHTML = ROW_HTML;

  const strip = doc.getElementById("strip") as unknown as HTMLElement;
  let sw = scroll, cw = client;
  Object.defineProperty(strip, "scrollWidth", { get: () => sw, configurable: true });
  Object.defineProperty(strip, "clientWidth", { get: () => cw, configurable: true });
  Object.defineProperty(strip, "getClientRects", { value: () => [{}], configurable: true });
  // Clamp scrollLeft the way a browser does, and make scrollBy instant.
  let sl = 0;
  Object.defineProperty(strip, "scrollLeft", {
    get: () => sl,
    set: (v: number) => { sl = Math.max(0, Math.min(v, sw - cw)); },
    configurable: true,
  });
  (strip as unknown as { scrollBy: (o: { left: number }) => void }).scrollBy =
    (o) => { strip.scrollLeft = sl + o.left; };

  (0, eval)(SRC);
  const row = doc.querySelector(".table-head-row") as unknown as HTMLElement;
  const nav = () => row.querySelector(":scope > .table-tabs-nav") as unknown as HTMLElement | null;
  const resync = async () => {
    strip.dispatchEvent(new win.Event("scroll") as never);
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    win,
    strip,
    nav,
    prev: () => nav()!.querySelector('[data-dir="-1"]') as unknown as HTMLButtonElement,
    next: () => nav()!.querySelector('[data-dir="1"]') as unknown as HTMLButtonElement,
    setWidths: (s, c) => { sw = s; cw = c; },
    resync,
  };
}

afterEach(() => {
  delete g.window;
  delete g.document;
});

describe("tab strip ‹ › pair", () => {
  it("is placed right after the strip, before the controls", async () => {
    const b = await boot(300, 300);
    const nav = b.nav();
    expect(nav).toBeTruthy();
    expect(nav!.previousElementSibling).toBe(b.strip);
    expect(nav!.nextElementSibling?.id).toBe("controls");
  });

  it("stays hidden while the tabs fit", async () => {
    const b = await boot(300, 300);
    expect(b.nav()!.classList.contains("is-idle")).toBe(true);
  });

  it("shows once the tabs overflow, with only the right end enabled at the start", async () => {
    const b = await boot(900, 300);
    expect(b.nav()!.classList.contains("is-idle")).toBe(false);
    expect(b.prev().disabled).toBe(true);
    expect(b.next().disabled).toBe(false);
  });

  it("scrolls by a share of the visible strip per click, and disables the far end on arrival", async () => {
    const b = await boot(900, 300);
    b.next().click();
    await b.resync();
    expect(b.strip.scrollLeft).toBe(180);   // 0.6 × 300
    expect(b.prev().disabled).toBe(false);
    b.next().click(); b.next().click(); b.next().click();
    await b.resync();
    expect(b.strip.scrollLeft).toBe(600);   // clamped at the end
    expect(b.next().disabled).toBe(true);
    b.prev().click();
    await b.resync();
    expect(b.strip.scrollLeft).toBe(420);
  });

  it("hides again when the tabs come to fit (a tab closed, the window widened)", async () => {
    const b = await boot(900, 300);
    expect(b.nav()!.classList.contains("is-idle")).toBe(false);
    b.setWidths(300, 300);
    await b.resync();
    expect(b.nav()!.classList.contains("is-idle")).toBe(true);
  });
});

describe("tab strip wheel", () => {
  function wheel(b: Boot, init: Record<string, number>) {
    const e = new b.win.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    b.strip.dispatchEvent(e as never);
    return e;
  }

  it("turns a vertical wheel into a sideways scroll and keeps the page still", async () => {
    const b = await boot(900, 300);
    const e = wheel(b, { deltaY: 100 });
    expect(b.strip.scrollLeft).toBe(100);
    expect(e.defaultPrevented).toBe(true);
    wheel(b, { deltaY: -40 });
    expect(b.strip.scrollLeft).toBe(60);
  });

  it("scales a line-mode wheel (Firefox) to pixels", async () => {
    const b = await boot(900, 300);
    wheel(b, { deltaY: 3, deltaMode: 1 });
    expect(b.strip.scrollLeft).toBe(48);
  });

  it("leaves a horizontal gesture to the browser", async () => {
    const b = await boot(900, 300);
    const e = wheel(b, { deltaX: 50, deltaY: 5 });
    expect(b.strip.scrollLeft).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it("does nothing while the tabs fit", async () => {
    const b = await boot(300, 300);
    const e = wheel(b, { deltaY: 100 });
    expect(e.defaultPrevented).toBe(false);
  });
});
