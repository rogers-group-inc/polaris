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

  it("every lit link glows in the hovered link's own colour, and clear drops it", () => {
    const cy = graph();
    cy.style([
      { selector: "edge", style: { "line-color": "#22c55e" } },
      { selector: "#bc", style: { "line-color": "#eab308" } },
    ]);
    R.highlightLinkHover(cy, cy.$id("bc"));
    const glows = ["ab", "bc", "ca"].map((id) => cy.$id(id).data("hoverGlow"));
    expect(new Set(glows).size).toBe(1);
    expect(glows[0]).toBe(cy.$id("bc").style("line-color"));
    expect(glows[0]).not.toBe(cy.$id("ab").style("line-color"));
    R.clearLinkHover(cy);
    expect(cy.$id("bc").data("hoverGlow")).toBeUndefined();
  });

  it("a link drawn with an outline (the loop halo) glows in the outline's colour", () => {
    const cy = graph();
    cy.style([{ selector: "edge", style: { "line-color": "#6a7388", "line-outline-width": 2, "line-outline-color": "#eab308" } }]);
    R.highlightLinkHover(cy, cy.$id("ab"));
    expect(cy.$id("ab").data("hoverGlow")).toBe(cy.$id("ab").style("line-outline-color"));
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

/**
 * Legend hover: each legend row carries the key of what it stands for, and
 * legendMatch finds those elements — by device role, by the health colour a
 * device is painted, by link kind (the tooltip's precedence), loop links,
 * and location boxes by level.
 */
describe("legend hover highlight", () => {
  function legendGraph() {
    const H = sb.window.POLARIS_HEALTH_COLORS;
    const n = (id: string, extra: Record<string, unknown>) => ({ data: { id, ...extra } });
    const e = (id: string, s: string, t: string, extra: Record<string, unknown> = {}) => ({ data: { id, source: s, target: t, ...extra } });
    return sb.make(JSON.stringify({
      headless: true,
      styleEnabled: true,
      layout: { name: "preset" },
      elements: [
        n("fg", { role: "fortigate", nodeColor: H.up }),
        n("s1", { role: "fortiswitch", nodeColor: H.down }),
        n("s2", { role: "fortiswitch", nodeColor: H.up }),
        n("a1", { role: "fortiap", nodeColor: H.up }),
        n("a2", { role: "fortiap", nodeColor: H.maintenance }),
        n("box", { isLocGroup: 1, locKind: "building", nodeColor: H.up }),
        e("up", "fg", "s1", { isVerifiedUplink: 1, isIface: 0, isApLink: 0, inLoop: 0 }),
        e("sw", "s1", "s2", { isIface: 1, isApLink: 0, inLoop: 1 }),
        e("ll", "s2", "s1", { isLldp: 1, inLoop: 1 }),
        e("ap", "s2", "a1", { isApLink: 1 }),
        e("me", "a1", "a2", { isMesh: 1, isApLink: 0 }),
      ],
    }));
  }

  it("matches rows to devices, links and boxes", () => {
    const cy = legendGraph();
    const m = (k: string) => ids(R.legendMatch(cy, k));
    expect(m("role:fortiswitch")).toEqual(["s1", "s2"]);
    expect(m("role:fortiap")).toEqual(["a1", "a2"]);
    expect(m("health:up")).toEqual(["a1", "fg", "s2"]); // never the location box
    expect(m("health:maintenance")).toEqual(["a2"]);
    expect(m("edge:controller")).toEqual(["up"]); // isIface: 0 is not a switch link
    expect(m("edge:switch")).toEqual(["ll", "sw"]);
    expect(m("edge:apLink")).toEqual(["ap"]);
    expect(m("edge:mesh")).toEqual(["me"]);
    expect(m("edge:loop")).toEqual(["ll", "sw"]);
    expect(m("loc:building")).toEqual(["box"]);
    expect(m("loc:floor")).toEqual([]);
  });

  it("highlights a row's elements, each link in its own colour, and clear drops it", () => {
    const cy = legendGraph();
    cy.style([
      { selector: "edge", style: { "line-color": "#6a7388" } },
      { selector: "#ap", style: { "line-color": "#3b82f6" } },
    ]);
    R.highlightLegendHover(cy, "edge:apLink");
    expect(ids(cy.elements(".link-hover"))).toEqual(["ap"]);
    expect(cy.$id("ap").data("hoverGlow")).toBe(cy.$id("ap").style("line-color"));
    R.highlightLegendHover(cy, "role:fortigate");
    expect(ids(cy.elements(".link-hover"))).toEqual(["fg"]);
    R.clearLinkHover(cy);
    expect(cy.elements(".link-hover").length).toBe(0);
    expect(cy.$id("ap").data("hoverGlow")).toBeUndefined();
  });

  it("every legend row carries a key legendMatch understands, and Mesh reads AP to AP", () => {
    const spec = R.topologyLegendSpec("dark");
    const html: string = R.topologyLegendHtml(spec);
    const rows = (html.match(/class="topology-legend-row"/g) || []).length;
    const keyed = [...html.matchAll(/data-legend-key="([^"]+)"/g)].map((x) => x[1]);
    expect(keyed.length).toBe(rows);
    expect(keyed).toContain("edge:mesh");
    expect(spec.edges.find((r: { key: string }) => r.key === "edge:mesh").label).toBe("AP to AP");
    const cy = legendGraph();
    for (const k of keyed) expect(() => R.legendMatch(cy, k)).not.toThrow();
  });
});
