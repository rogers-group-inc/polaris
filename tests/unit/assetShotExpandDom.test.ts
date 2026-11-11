/**
 * tests/unit/assetShotExpandDom.test.ts — the asset tab Screenshot / PDF
 * capture lets fixed-height scroll regions grow to their content
 * (`_expandShotRegions` in public/js/assets-storage.js).
 *
 * A Custom MIB card is its layout's height with its own scrollbar, and the
 * capture froze it at that height, so a table widget longer than the card was
 * cut off at whatever was visible (reported 2026-11-11). Pinned:
 *
 *  - every `[data-shot-expand]` region loses its fixed height, max-height and
 *    clipping for the capture;
 *  - the restore puts each inline style back exactly, including an empty one;
 *  - regions that did not opt in are not touched;
 *  - a Custom MIB card with a layout height opts in, one without does not.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect } from "vitest";
import { assetsSource } from "./_assetsSource.js";

const lines = assetsSource().split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

const expand = new Function(`${fnSrc("_expandShotRegions")}; return _expandShotRegions;`)() as (root: Element) => () => void;

describe("_expandShotRegions", () => {
  it("releases opted-in regions for the capture and restores them exactly", () => {
    document.body.innerHTML =
      '<div id="panel">' +
        '<div id="a" data-shot-expand style="height:170px;overflow:auto"></div>' +
        '<div id="b" data-shot-expand style="max-height:300px"></div>' +
        '<div id="c" style="height:50px;overflow:auto"></div>' +
      '</div>';
    const a = document.getElementById("a") as HTMLElement;
    const b = document.getElementById("b") as HTMLElement;
    const c = document.getElementById("c") as HTMLElement;

    const restore = expand(document.getElementById("panel")!);
    expect([a.style.height, a.style.overflow]).toEqual(["auto", "visible"]);
    expect([b.style.maxHeight, b.style.height]).toEqual(["none", "auto"]);
    expect([c.style.height, c.style.overflow]).toEqual(["50px", "auto"]);

    restore();
    expect([a.style.height, a.style.overflow, a.style.maxHeight]).toEqual(["170px", "auto", ""]);
    expect([b.style.maxHeight, b.style.height, b.style.overflow]).toEqual(["300px", "", ""]);
  });

  it("is a no-op without a root", () => {
    expect(() => expand(null as unknown as Element)()).not.toThrow();
  });
});

describe("Custom MIB card", () => {
  it("opts in to expansion only when it has a layout height", () => {
    const src = fnSrc("_cmibCardHTML");
    expect(src).toContain("(height ? ' data-shot-expand' : '')");
  });
});
