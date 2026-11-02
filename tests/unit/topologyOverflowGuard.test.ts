/**
 * tests/unit/topologyOverflowGuard.test.ts
 *
 * Two topology bugs that only showed on a scaled display (a 4K screen at 150%,
 * where layout sizes land on fractional CSS pixels), and that no happy-dom or
 * headless render can show — headless Chrome draws no scrollbars. Pinned at
 * the source instead:
 *
 *   - Cytoscape sizes its inner div in whole pixels from clientWidth/Height,
 *     which can round UP past a fractional container. Unclipped, that put
 *     scrollbars on the scrolling parent, which shrank the graph, which
 *     dropped them: a resize loop that flickered (Device Map page) and left
 *     the canvas blank (Device Map widget). Both containers clip.
 *   - The Device Map page's modal asked for an 80vh layout inside an 85vh
 *     modal, header included, so a short viewport overflowed the body by a
 *     few pixels and pinned a scrollbar on. The layout now shrinks into it.
 *
 * Plus: cy.destroy() empties its container, and the page's legend is static
 * markup INSIDE that container — every destroy must go through the helper
 * that lifts the legend out first.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8").replace(/\r\n/g, "\n");
const rule = (css: string, selector: string) => {
  const at = css.indexOf("\n" + selector + " {");
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

describe("topology containers clip Cytoscape's whole-pixel canvas", () => {
  it("the Device Map page's graph", () => {
    expect(rule(read("public/css/map.css"), ".topology-graph")).toMatch(/overflow:\s*hidden/);
  });

  it("the Device Map widget's topology pane and graph", () => {
    const css = read("public/css/styles.css");
    expect(css).toMatch(/\.devmap-topo \{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.devmap-topo-graph \{[^}]*overflow:\s*hidden/);
  });

  it("the page's side-by-side modal lets its layout shrink into the body", () => {
    const css = read("public/css/map.css");
    const block = css.slice(css.indexOf("@media (min-width: 961px) {"));
    expect(block).toMatch(/#topology-overlay \.modal-body \{ display: flex; flex-direction: column; \}/);
    expect(block).toMatch(/#topology-overlay \.topology-layout \{ flex: 0 1 auto; \}/);
  });
});

describe("the Device Map page keeps its legend across a graph rebuild", () => {
  it("destroys the graph only through _destroyGraphKeepingLegend", () => {
    const js = read("public/js/map.js");
    const destroys = js.match(/cyInstance\.destroy\(\)/g) || [];
    expect(destroys).toHaveLength(1);
    const helper = js.slice(js.indexOf("function _destroyGraphKeepingLegend()"));
    expect(helper.slice(0, helper.indexOf("\n  }\n"))).toContain("cyInstance.destroy()");
  });
});
