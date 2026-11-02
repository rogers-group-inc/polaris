/**
 * tests/unit/topologyLinkHover.test.ts
 *
 * Hovering a link on a topology (the Device Map page and the Device Map
 * widget) lights the link and the devices on its two ends — or, for a link on
 * a physical loop, the whole loop: every loop link reachable through the
 * devices they share, and those devices (topology-render.js → linkHoverSet /
 * highlightLinkHover / clearLinkHover). Real Cytoscape, headless, in a vm
 * context — inputs are built inside the context (see the headless-cytoscape
 * notes in topologyEdgeEditor.test.ts).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sb: Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let R: Record<string, any>;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const health = { up: "#1", degraded: "#2", down: "#3", maintenance: "#4", passive: "#5", unknown: "#6", unmonitored: "#7" };
  sb = {
    window: { addEventListener() {}, removeEventListener() {}, POLARIS_HEALTH_COLORS: health },
    setTimeout,
    clearTimeout,
    console,
  };
  sb.self = sb.window;
  vm.createContext(sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/vendor/cytoscape.min.js"), "utf8"), sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/topology-render.js"), "utf8"), sb);
  vm.runInContext("function make(j) { return cytoscape(JSON.parse(j)); }", sb);
  R = sb.window.PolarisTopologyRender;
});

/**
 * A switch ring A–B–C–A (every link inLoop), a tail C–D off it, and a second
 * ring D–E–F–D hanging off the tail — reachable from the first ring only
 * through the tail, which is not a loop link.
 */
function graph() {
  const n = (id: string) => ({ data: { id } });
  const e = (id: string, s: string, t: string, inLoop = false) => ({ data: { id, source: s, target: t, ...(inLoop ? { inLoop: 1 } : {}) } });
  return sb.make(JSON.stringify({
    headless: true,
    styleEnabled: true,
    layout: { name: "preset" },
    elements: [
      n("A"), n("B"), n("C"), n("D"), n("E"), n("F"),
      e("ab", "A", "B", true), e("bc", "B", "C", true), e("ca", "C", "A", true),
      e("cd", "C", "D"),
      e("de", "D", "E", true), e("ef", "E", "F", true), e("fd", "F", "D", true),
    ],
  }));
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids = (coll: any) => coll.map((x: { id: () => string }) => x.id()).sort();

describe("link hover highlight", () => {
  it("an ordinary link lights itself and the devices on its two ends", () => {
    const cy = graph();
    expect(ids(R.linkHoverSet(cy, cy.$id("cd")))).toEqual(["C", "D", "cd"]);
  });

  it("a loop link lights the whole loop — its links and devices, not the tail or the next ring", () => {
    const cy = graph();
    expect(ids(R.linkHoverSet(cy, cy.$id("ab")))).toEqual(["A", "B", "C", "ab", "bc", "ca"]);
    expect(ids(R.linkHoverSet(cy, cy.$id("ef")))).toEqual(["D", "E", "F", "de", "ef", "fd"]);
  });

  it("highlight stamps the class, a second hover replaces it, and clear removes it", () => {
    const cy = graph();
    R.highlightLinkHover(cy, cy.$id("ab"));
    expect(ids(cy.elements(".link-hover"))).toEqual(["A", "B", "C", "ab", "bc", "ca"]);
    R.highlightLinkHover(cy, cy.$id("cd"));
    expect(ids(cy.elements(".link-hover"))).toEqual(["C", "D", "cd"]);
    R.clearLinkHover(cy);
    expect(cy.elements(".link-hover").length).toBe(0);
    cy.destroy();
    expect(() => R.clearLinkHover(cy)).not.toThrow(); // a graph torn down under the cursor
  });

  it("the stylesheet draws the highlight as an underlay in both theme families", () => {
    for (const fam of ["light", "dark"]) {
      const sheet = R.topologyStylesheet(fam) as { selector: string; style: Record<string, unknown> }[];
      for (const sel of ["node.link-hover", "edge.link-hover"]) {
        const rule = sheet.find((r) => r.selector === sel);
        expect(rule, `${fam} ${sel}`).toBeTruthy();
        expect(rule!.style["underlay-color"]).toMatch(/^#/);
      }
    }
  });
});
