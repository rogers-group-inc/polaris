/**
 * tests/unit/tableShotCaptureDom.test.ts — the per-table camera button
 * (_screenshotTableEl in public/js/assets.js) captures the table as RENDERED.
 *
 * It used to be a synthetic canvas that re-drew each cell's flattened text in
 * one resolved color, so every table screenshot lost whatever its cells said
 * with shape or color: the SD-WAN Members Health Check Status column arrived as
 * the words "▼ 36/37 up" where the screen shows 37 green/red segments, and the
 * per-member status dots as bare ▲/▼ glyphs. The primary path is now an
 * html-to-image rasterization of the live <table>; the text composer survives
 * only as the fallback for a browser where the library didn't load, or where
 * the rasterization itself failed.
 *
 * What's pinned here:
 *  - the capture target is the live table element (never the scroll wrapper,
 *    which is bounded-height and would clip every row below the fold);
 *  - the backdrop is the card the table actually sits on, not the page color —
 *    a table paints no background of its own;
 *  - scrollbar chrome is suppressed for the capture and restored afterwards,
 *    on the failure path too;
 *  - both fallbacks reach the text composer;
 *  - rows hidden under a collapsed parent are counted for the note, while
 *    control rows (a toggle row, a full-width grouping header) are not.
 *
 * assets.js has no module boundary, so the functions under test are sliced out
 * by name and eval'd into a happy-dom Window — the harness of
 * tests/unit/sdwanMembersShotDom.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, any>;
const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

const FN_NAMES = [
  "_shotVisible",
  "_shotHiddenRowCount",
  "_shotTransparentBg",
  "_shotBackdropColor",
  "_screenshotTableEl",
];

const CARD_BG = "rgb(20, 24, 40)";

/** A card > scroll wrapper > table shape, the asset-detail table layout. */
const MARKUP = `
  <div class="card" style="background-color: ${CARD_BG}">
    <div class="table-wrapper-sticky">
      <table id="t">
        <thead><tr><th>Member</th><th>IP</th></tr></thead>
        <tbody>
          <tr id="t-toggle-row" style="display:none"><td colspan="2">Show inactive</td></tr>
          <tr class="zone-header" style="display:none"><td colspan="2">Underlay</td></tr>
          <tr><td>wan1</td><td>10.0.0.1</td></tr>
          <tr><td>wan2</td><td>10.0.0.2</td></tr>
          <tr style="display:none"><td>wan3</td><td>10.0.0.3</td></tr>
          <tr style="display:none"><td>wan4</td><td>10.0.0.4</td></tr>
        </tbody>
      </table>
    </div>
  </div>`;

let win: Window;
let doc: Window["document"];
let toCanvas: ReturnType<typeof vi.fn>;
let textComposer: ReturnType<typeof vi.fn>;
let toasts: Array<[string, string]>;

/** The live table, and the wrapper whose scrollbars the capture suppresses. */
const table = () => doc.getElementById("t")!;
const wrapper = () => doc.querySelector(".table-wrapper-sticky")!;

beforeEach(() => {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.getComputedStyle = (el: Element) => (win as any).getComputedStyle(el);
  // Immediate rAF: the capture's double-rAF settle becomes synchronous, so a
  // test can assert on the call without a timer dance.
  g.requestAnimationFrame = (cb: () => void) => { cb(); return 1; };
  toasts = [];
  g.showToast = (msg: string, kind: string) => { toasts.push([msg, kind]); };
  g.copyPngToClipboard = vi.fn().mockResolvedValue(true);
  g._currentAssetForRefresh = { hostname: "GREENBACK-101F-1" };
  textComposer = vi.fn();
  g._screenshotTableElText = textComposer;
  toCanvas = vi.fn().mockReturnValue(new Promise(() => { /* never settles */ }));
  g.htmlToImage = { toCanvas };

  for (const name of FN_NAMES) (0, eval)(fnSrc(name));
  doc.body.innerHTML = MARKUP;
});

describe("per-table screenshot — faithful DOM capture", () => {
  it("rasterizes the live table element rather than re-drawing its text", () => {
    g._screenshotTableEl(table(), "SD-WAN Members");
    expect(toCanvas).toHaveBeenCalledTimes(1);
    expect(toCanvas.mock.calls[0][0]).toBe(table());
    expect(textComposer).not.toHaveBeenCalled();
  });

  it("captures the table, never the bounded-height scroll wrapper", () => {
    // Capturing the wrapper would clip every row below the fold and every
    // column right of the horizontal scroll.
    g._screenshotTableEl(table(), "SD-WAN Members");
    expect(toCanvas.mock.calls[0][0]).not.toBe(wrapper());
  });

  it("captures at 2x on the card's own background, not the page color", () => {
    g._screenshotTableEl(table(), "SD-WAN Members");
    const opts = toCanvas.mock.calls[0][1];
    expect(opts.pixelRatio).toBe(2);
    expect(opts.backgroundColor).toBe(CARD_BG);
  });

  it("suppresses the wrapper's scrollbar chrome for the capture", () => {
    g._screenshotTableEl(table(), "SD-WAN Members");
    expect(wrapper().classList.contains("screenshot-hide-scrollbars")).toBe(true);
  });

  it("restores the scrollbars and composes text when the rasterization fails", async () => {
    toCanvas.mockReturnValue(Promise.reject(new Error("tainted canvas")));
    g._screenshotTableEl(table(), "SD-WAN Members");
    await new Promise((r) => setTimeout(r, 0));
    expect(wrapper().classList.contains("screenshot-hide-scrollbars")).toBe(false);
    expect(textComposer).toHaveBeenCalledTimes(1);
    expect(textComposer.mock.calls[0][1]).toBe("SD-WAN Members");
  });

  it("composes text when the capture library never loaded", () => {
    delete g.htmlToImage;
    g._screenshotTableEl(table(), "SD-WAN Members", { hiddenNoun: "interface" });
    expect(textComposer).toHaveBeenCalledTimes(1);
    expect(textComposer.mock.calls[0][2]).toEqual({ hiddenNoun: "interface" });
    expect(toCanvas).not.toHaveBeenCalled();
  });

  it("refuses a table whose every data row is hidden", () => {
    doc.querySelectorAll("#t tbody > tr").forEach((tr) => {
      (tr as HTMLElement).style.display = "none";
    });
    g._screenshotTableEl(table(), "SD-WAN Members");
    expect(toCanvas).not.toHaveBeenCalled();
    expect(toasts[0]).toEqual(["Nothing to screenshot", "error"]);
  });
});

describe("hidden-row count (the note under the image)", () => {
  it("counts data rows hidden under a collapsed parent", () => {
    expect(g._shotHiddenRowCount(table(), win)).toBe(2);
  });

  it("does not count a hidden toggle row or a full-width grouping header", () => {
    // Both are hidden in the markup; neither is a row of data the operator
    // would expect to see in the image.
    doc.querySelectorAll('#t tbody > tr:not([style*="display:none"])').forEach((tr) => {
      (tr as HTMLElement).remove();
    });
    doc.querySelectorAll("#t tbody > tr").forEach((tr) => {
      if (tr.querySelectorAll(":scope > td").length > 1) tr.remove();
    });
    expect(g._shotHiddenRowCount(table(), win)).toBe(0);
  });
});

describe("capture backdrop", () => {
  it("walks up to the first ancestor that actually paints", () => {
    expect(g._shotBackdropColor(table(), win, "#fallback")).toBe(CARD_BG);
  });

  it("falls back when nothing up the tree paints", () => {
    (doc.querySelector(".card") as HTMLElement).style.backgroundColor = "";
    expect(g._shotBackdropColor(table(), win, "#fallback")).toBe("#fallback");
  });

  it("treats a zero-alpha background as painting nothing", () => {
    expect(g._shotTransparentBg("rgba(0, 0, 0, 0)")).toBe(true);
    expect(g._shotTransparentBg("rgba(255, 255, 255, 0.0)")).toBe(true);
    expect(g._shotTransparentBg("transparent")).toBe(true);
    expect(g._shotTransparentBg("")).toBe(true);
    expect(g._shotTransparentBg("rgb(20, 24, 40)")).toBe(false);
    expect(g._shotTransparentBg("rgba(20, 24, 40, 0.6)")).toBe(false);
  });
});
