/**
 * tests/unit/topologyPhysicalLinkTip.test.ts
 *
 * The Topology-mode canvas's link hover card (public/js/topology-physical.js
 * → tipGraph / linkTipHtml). It is Layer 2's card (topology-render.js →
 * edgeTooltipHtml), read off a headless Cytoscape graph of the canvas's own
 * elements. The two-method stand-in it replaced threw "cy.collection is not a
 * function" on every wired link on a ring (_loopTipRows walks the graph), so
 * a ringed wired link showed no card while wireless links did (operator
 * report 2026-11-17). The same card serves the links between floors.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

let sb: Record<string, any>;

beforeAll(() => {
  sb = { window: { addEventListener() {}, removeEventListener() {} }, setTimeout, clearTimeout, console };
  sb.self = sb.window;
  vm.createContext(sb);
  const js = (f: string) => readFileSync(resolve(__dirname, "../../public/js", f), "utf8");
  vm.runInContext(js("vendor/cytoscape.min.js"), sb);
  vm.runInContext(js("topology-render.js"), sb);
  vm.runInContext(js("topology-physical.js"), sb);
  // Inputs built inside the context (headless Cytoscape in a vm realm).
  vm.runInContext(
    "function tipFor(edgeId, withCy) {" +
    "  var els = [" +
    "    { data: { id: 'a', label: 'SW-A' } }, { data: { id: 'b', label: 'SW-B' } }," +
    "    { data: { id: 'c', label: 'SW-C' } }, { data: { id: 'd', label: 'SW-D' } }," +
    "    { data: { id: 'ap', label: 'AP-1' } }," +
    "    { data: { id: 'ab', source: 'a', target: 'b', isIface: 1, inLoop: 1, label: 'port1 ↔ port2', linkSpeed: '10g', speedBps: 1e10 } }," +
    "    { data: { id: 'bc', source: 'b', target: 'c', isIface: 1, inLoop: 1, label: 'port3 ↔ port4', linkSpeed: '10g', speedBps: 1e10 } }," +
    "    { data: { id: 'ca', source: 'c', target: 'a', isIface: 1, inLoop: 1, label: 'port5 ↔ port6', linkSpeed: '1g', speedBps: 1e9 } }," +
    "    { data: { id: 'cd', source: 'c', target: 'd', isLldp: 1, label: 'port7 ↔ port8', linkSpeed: '1g', speedBps: 1e9 } }," +
    "    { data: { id: 'mesh', source: 'd', target: 'ap', isMesh: 1, signalDbm: -60, label: 'backhaul' } } ];" +
    "  var nodeById = {}; var edge = null;" +
    "  els.forEach(function (el) { if (el.data.source) { if (el.data.id === edgeId) edge = el.data; } else nodeById[el.data.id] = el.data; });" +
    "  var P = window.PolarisTopologyPhysical;" +
    "  var g = P._tipGraph(els, nodeById, withCy ? cytoscape : undefined);" +
    "  return P._linkTipHtml(window.PolarisTopologyRender, g, edge);" +
    "}",
    sb,
  );
});

describe("Topology map link hover card", () => {
  it("shows a wired link on a ring, with the ring's other links", () => {
    const html = sb.tipFor("ab", true);
    expect(html).toContain("SW-A");
    expect(html).toContain("port1 ↔ port2");
    expect(html).toContain("Part of a ring");
    expect(html).toContain("port3 ↔ port4");
    expect(html).toContain("port5 ↔ port6");
  });

  it("shows a wired link off the ring, and a wireless one", () => {
    const wired = sb.tipFor("cd", true);
    expect(wired).toContain("Switch ↔ switch — found by LLDP");
    expect(wired).not.toContain("Part of a ring");
    expect(sb.tipFor("mesh", true)).toContain("AP to AP — wireless mesh backhaul");
  });

  it("without Cytoscape a ringed link still gets its card, minus the ring rows", () => {
    const html = sb.tipFor("ab", false);
    expect(html).toContain("port1 ↔ port2");
    expect(html).not.toContain("Part of a ring");
  });
});
