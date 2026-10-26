/**
 * tests/unit/tableColumnFit.test.ts — the column-fit pass in
 * `setupColumnLayout` (public/js/table-sf.js).
 *
 * What's pinned here is the arithmetic that decides how a table with room to
 * spare spends it. The rule: leftover width is spread across EVERY resizable
 * column in proportion to its base width, columns pinned to a declared width
 * (utility cb/fav + `data-col-no-resize`) never stretch, and the visible
 * columns always sum to exactly the container width — a narrow table used to
 * dump the whole remainder on the rightmost column, leaving cramped columns
 * and one enormous blank one.
 *
 * Two constants drive the numbers below: FIXED_COL_W (34) is the utility-column
 * track, and AUTOFILL_MIN_W (36) is the floor under the auto-fill column — it
 * absorbs every deficit, and below its label's min-content the header wraps a
 * letter per line and stretches the whole thead to ~124px.
 *
 * table-sf.js is a plain browser script (no module exports), so it's eval'd
 * into a happy-dom Window with the app-shell globals stubbed — same approach as
 * tests/unit/tableColumnOrder.test.ts. Node has no requestAnimationFrame, so
 * the fit pass runs synchronously here (its own documented fallback), which is
 * what makes these assertions deterministic. happy-dom reports all-zero rects,
 * so the container width is stubbed explicitly.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, any>;

const AVAIL = 1000;

// cb (utility, pinned to FIXED_COL_W = 34px) | fixed (static-width, declared
// 100px) | three resizable columns, the last of which is the auto-fill one.
const TABLE_HTML = `
  <div class="table-wrapper">
    <table>
      <thead><tr>
        <th class="cb-col"></th>
        <th style="width:100px" data-col-no-resize="true" data-col-id="badge">Badge</th>
        <th data-col-id="hostname">Hostname</th>
        <th data-col-id="ip">IP Address</th>
        <th data-col-id="created">Created</th>
      </tr></thead>
      <tbody id="tb">
        <tr><td class="cb-col">cb</td><td>b</td><td>host-1</td><td>10.0.0.1</td><td>Apr 17</td></tr>
      </tbody>
    </table>
  </div>`;

let win: Window;
let doc: Window["document"];
let layout: any;

/** Rendered <col> width in px, by display position. */
function colWidths(): number[] {
  return Array.from(doc.querySelectorAll("colgroup col")).map(
    (c) => parseFloat((c as any).style.width) || 0,
  );
}

function widthOf(colId: string): number {
  const ids = Array.from(doc.querySelectorAll("thead th")).map((t) => t.getAttribute("data-col-id"));
  return colWidths()[ids.indexOf(colId)];
}

function setup() {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.MutationObserver = (win as any).MutationObserver;
  g.getComputedStyle = (el: Element) => (win as any).getComputedStyle(el);
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  doc.body.innerHTML = TABLE_HTML;

  // The two measurements the fit pass takes: the table must be measurable at
  // all, and the parent's content box is what `table { width: 100% }` resolves
  // against.
  const table = doc.querySelector("table")! as any;
  const wrapper = doc.querySelector(".table-wrapper")! as any;
  table.getBoundingClientRect = () => ({ width: AVAIL, height: 100, top: 0, left: 0, right: AVAIL, bottom: 100 });
  Object.defineProperty(wrapper, "clientWidth", { value: AVAIL, configurable: true });

  const src = readFileSync(resolve(__dirname, "../../public/js/table-sf.js"), "utf8");
  (0, eval)(src);

  layout = (g as any).setupColumnLayout(table, { onChange: () => {} });
  return layout;
}

/** A resize drag on `colId`'s handle, `dx` px (negative = narrower). */
function dragHandle(colId: string, dx: number): void {
  const th = doc.querySelector(`thead th[data-col-id="${colId}"]`)!;
  const handle = th.querySelector(".sf-resize-handle")!;
  const fire = (target: any, type: string, clientX: number) => {
    const ev: any = new (win as any).Event(type, { bubbles: true, cancelable: true });
    ev.clientX = clientX;
    target.dispatchEvent(ev);
  };
  fire(handle, "mousedown", 500);
  fire(doc, "mousemove", 500 + dx);
  fire(doc, "mouseup", 500 + dx);
}

beforeEach(() => { setup(); });

describe("column fit — spending the leftover width", () => {
  it("spreads slack across every resizable column, proportionally", () => {
    // 1000 available − 34 (cb) − 100 (static) = 866 for the three resizable
    // columns, whose base widths sum to 400 → ×2.165 each, and the auto-fill
    // column takes the rounding remainder so the row still sums to 1000.
    layout.setPrefs({ widths: { hostname: 100, ip: 200, created: 100 } });

    expect(widthOf("hostname")).toBe(216);
    expect(widthOf("ip")).toBe(433);
    expect(widthOf("created")).toBe(217);
  });

  it("honors the declared width of utility + static-width columns", () => {
    layout.setPrefs({ widths: { hostname: 100, ip: 200, created: 100, badge: 999 } });

    expect(widthOf("badge")).toBe(100);      // declared width is the source of truth
    expect(colWidths()[0]).toBe(34);         // cb-col pin (FIXED_COL_W)
  });

  it("leaves no trailing gap — the visible columns sum to the container width", () => {
    layout.setPrefs({ widths: { hostname: 137, ip: 211, created: 89 } });

    const total = colWidths().reduce((a, b) => a + b, 0);
    expect(total).toBe(AVAIL);
  });

  it("re-fits after a column is hidden, rather than parking the space in the last one", () => {
    layout.setPrefs({ widths: { hostname: 100, ip: 200, created: 100 } });
    layout.setPrefs({ hidden: ["ip"], shown: ["hostname", "created"] });

    // 866 now shared by hostname + created (base 200) → ×4.33.
    expect(widthOf("hostname")).toBe(433);
    expect(widthOf("created")).toBe(433);
  });

  it("does not shrink an over-committed table — the last column stays visible", () => {
    layout.setPrefs({ widths: { hostname: 500, ip: 500, created: 500 } });

    expect(widthOf("hostname")).toBe(500);
    expect(widthOf("ip")).toBe(500);
    // No leftover to fill: the auto-fill column keeps its saved width instead
    // of collapsing to ~0px behind the wrapper's scrollbar.
    expect(widthOf("created")).toBe(500);
    expect(widthOf("badge")).toBe(100);
  });

  it("tracks a resize drag 1:1 against what's on screen", () => {
    // Stretched render is hostname 216 / ip 433. Dragging the divider 50px left
    // has to move it 50 SCREEN px — the stored base (100/200) sums narrower
    // than the container, so applying the delta to the base would move the
    // divider by 50 × 2.165.
    layout.setPrefs({ widths: { hostname: 100, ip: 200, created: 100 } });
    dragHandle("hostname", -50);

    expect(widthOf("hostname")).toBe(166);
    expect(widthOf("ip")).toBe(483);
    expect(widthOf("created")).toBe(217);
    expect(colWidths().reduce((a, b) => a + b, 0)).toBe(AVAIL);
  });
});

/**
 * The 5px floor (MIN_COL_W). Every column stays draggable down to a sliver —
 * wide enough to see it's there and to grab its own resize handle — and no
 * column this helper writes a width for can reach 0px, which would read as the
 * column having disappeared with nothing left to pull back out.
 */
describe("column fit — the 5px minimum width", () => {
  it("lets a drag squeeze a column to the sliver, and clamps there", () => {
    // Stretched render is hostname 216 / ip 433. Dragging 300px left would take
    // hostname to -84; it stops at 5 and the neighbor absorbs the rest.
    layout.setPrefs({ widths: { hostname: 100, ip: 200, created: 100 } });
    dragHandle("hostname", -300);

    expect(widthOf("hostname")).toBe(5);
    expect(widthOf("ip")).toBe(644);
    expect(colWidths().reduce((a, b) => a + b, 0)).toBe(AVAIL);
  });

  it("clamps the right-hand neighbor at the sliver too", () => {
    layout.setPrefs({ widths: { hostname: 100, ip: 200, created: 100 } });
    dragHandle("hostname", 1000);

    expect(widthOf("ip")).toBe(5);
    expect(widthOf("hostname")).toBe(644);
  });

  it("raises a saved sub-floor width to the floor rather than honoring it", () => {
    // A hand-edited or pre-floor saved pref must not seed a 1px base for the
    // fit pass to scale from.
    layout.setPrefs({ widths: { hostname: 1, ip: 200, created: 100 } });

    expect(layout.getPrefs().widths.hostname).toBe(5);
  });

  it("keeps the crushed auto-fill column at the floor, never at 0px", () => {
    layout.setPrefs({ widths: { hostname: 500, ip: 500, created: 1 } });

    // Over-committed: no leftover for the last column, so it falls back to its
    // own saved width (itself floored to MIN_COL_W) — and then to
    // AUTOFILL_MIN_W, because a 5px auto-fill column can't hold its label and
    // the wrapping header is worse than the horizontal scroll.
    expect(widthOf("created")).toBe(36);
  });

  it("keeps the auto-fill column's saved width when over-committed, so the row scrolls", () => {
    // 34 (cb) + 100 (static) + 500 + 350 leaves 16 for `created`. Squeezing it
    // into that 16 (or the 36 floor) made the table exactly fill the wrapper:
    // the column's cells cut off with no horizontal scrollbar to reach them.
    // It keeps its 100 and the row overflows into the wrapper's scroll.
    layout.setPrefs({ widths: { hostname: 500, ip: 350, created: 100 } });

    expect(widthOf("created")).toBe(100);
    expect(colWidths().reduce((a, b) => a + b, 0)).toBeGreaterThan(AVAIL);
  });

  it("floors the auto-fill column at AUTOFILL_MIN_W, not at a saved sliver", () => {
    layout.setPrefs({ widths: { hostname: 500, ip: 350, created: 20 } });

    expect(widthOf("created")).toBe(36);
  });

  it("lets a th's own declared width raise that floor", () => {
    // A width on the <th> is an explicit statement of how much the column
    // needs, so it wins over AUTOFILL_MIN_W and a narrower saved width.
    doc.querySelector('thead th[data-col-id="created"]')!.setAttribute("style", "width:90px");
    layout.setPrefs({ widths: { hostname: 500, ip: 350, created: 20 } });

    expect(widthOf("created")).toBe(90);
  });
});

/**
 * A cell's border box can't render narrower than its own padding (1rem each
 * side ≈ 33px with borders), so the sliver is only real if the padding comes
 * off with it. Those rules ride the same generated per-table stylesheet the
 * hidden-column rules use.
 */
describe("column fit — padding on sliver-width columns", () => {
  function generatedCss(): string {
    const el = doc.querySelector('head style[id^="sf-style-"]');
    return el ? String(el.textContent) : "";
  }

  it("drops the cell padding on a column squeezed under the threshold", () => {
    layout.setPrefs({ widths: { hostname: 100, ip: 200, created: 100 } });
    expect(generatedCss()).not.toContain("padding-left");

    dragHandle("hostname", -300);   // hostname → 5px

    // hostname is display position 3 (cb, badge, hostname, ...).
    expect(generatedCss()).toContain(":nth-child(3),");
    expect(generatedCss()).toContain("padding-left: 1px; padding-right: 1px; overflow: hidden;");
    // Its 655px neighbor keeps its padding.
    expect(generatedCss()).not.toContain(":nth-child(4),");
  });

  it("restores the padding when the column is widened again", () => {
    layout.setPrefs({ widths: { hostname: 100, ip: 200, created: 100 } });
    dragHandle("hostname", -300);
    expect(generatedCss()).toContain("padding-left: 1px");

    dragHandle("hostname", 300);
    expect(generatedCss()).not.toContain("padding-left");
  });
});

/**
 * Double-clicking a resize handle sizes that column to its content: the
 * header label and every rendered body cell, untruncated. happy-dom does no
 * layout, so the probe the helper measures each cell's content in is given a
 * width of 10px per character, and no stylesheet means zero padding.
 */
describe("column fit — double-click to autofit", () => {
  beforeEach(() => {
    const proto = (win as any).HTMLElement.prototype;
    const orig = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: any) {
      if (this.classList && this.classList.contains("sf-autofit-probe")) {
        const w = (this.textContent || "").length * 10;
        return { width: w, height: 10, top: 0, left: 0, right: w, bottom: 10 };
      }
      return orig.call(this);
    };
  });

  function dblclickHandle(colId: string): void {
    const handle = doc.querySelector(`thead th[data-col-id="${colId}"] .sf-resize-handle`)!;
    handle.dispatchEvent(new (win as any).Event("dblclick", { bubbles: true, cancelable: true }));
  }

  function setCell(colId: string, text: string): void {
    const ids = Array.from(doc.querySelectorAll("thead th")).map((t) => t.getAttribute("data-col-id"));
    (doc.querySelector("#tb tr")!.children[ids.indexOf(colId)] as any).textContent = text;
  }

  it("shrinks a column to its widest content and hands the width to its neighbor", () => {
    // Stretched render: hostname 216 / ip 433. "Hostname" (80) beats "host-1" (60).
    layout.setPrefs({ widths: { hostname: 100, ip: 200, created: 100 } });
    dblclickHandle("hostname");

    expect(widthOf("hostname")).toBe(80);
    expect(widthOf("ip")).toBe(569);
    expect(colWidths().reduce((a, b) => a + b, 0)).toBe(AVAIL);
    expect(doc.querySelector(".sf-autofit-probe")).toBeNull();
  });

  it("grows a column to a body cell wider than its label, taking from the neighbor", () => {
    setCell("hostname", "a-very-long-hostname-01"); // 230
    layout.setPrefs({ widths: { hostname: 50, ip: 400, created: 400 } });
    const before = widthOf("ip");
    dblclickHandle("hostname");

    expect(widthOf("hostname")).toBe(230);
    expect(widthOf("ip")).toBe(before - (230 - 50));
  });

  it("never squeezes the neighbor below its own content width", () => {
    // ip's content is "IP Address" (100); it can give only 10 of the 180 asked.
    setCell("hostname", "a-very-long-hostname-01");
    layout.setPrefs({ widths: { hostname: 50, ip: 110, created: 706 } });
    dblclickHandle("hostname");

    expect(widthOf("hostname")).toBe(230);
    expect(widthOf("ip")).toBe(100);
  });

  it("persists through onChange like a drag does", () => {
    let calls = 0;
    // setup() already wired the handles to a no-op onChange; re-wire fresh ones.
    doc.querySelectorAll(".sf-resize-handle").forEach((h) => h.remove());
    layout = g.setupColumnLayout(doc.querySelector("table"), { onChange: () => { calls++; } });
    dblclickHandle("hostname");
    expect(calls).toBe(1);
    expect(layout.getPrefs().widths.hostname).toBe(80);
  });
});
