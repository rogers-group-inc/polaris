/**
 * tests/unit/topologyEdgeTooltip.test.ts
 *
 * edgeTooltipHtml() in public/js/topology-render.js — the text of the link
 * hover tooltip, shared by the Device Map page's topology modal (map.js) and
 * the Device Map dashboard widget's read-only topology, so a link reads the
 * same on both. Runs the vendored Cytoscape headless in a vm context (inputs
 * built inside the context — see topologyRouteBendClearance.test.ts).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

let sb: Record<string, any>;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  sb = { window: { addEventListener() {}, removeEventListener() {} }, setTimeout, clearTimeout, console };
  sb.self = sb.window;
  vm.createContext(sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/vendor/cytoscape.min.js"), "utf8"), sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/topology-render.js"), "utf8"), sb);
  vm.runInContext(
    "function tip(j) {" +
    "  var spec = JSON.parse(j);" +
    "  var cy = cytoscape({ headless: true, elements: [" +
    "    { data: { id: 'a', label: spec.a } }, { data: { id: 'b', label: spec.b } }," +
    "    { data: Object.assign({ id: 'e', source: 'a', target: 'b' }, spec.edge) } ] });" +
    "  return window.PolarisTopologyRender.edgeTooltipHtml(cy, cy.getElementById('e'));" +
    "}",
    sb,
  );
});

const tip = (spec: Record<string, unknown>): string =>
  sb.tip(JSON.stringify({ a: "SW-A", b: "SW-B", edge: {}, ...spec }));

describe("edgeTooltipHtml", () => {
  it("names both ends, the port pair and the link kind", () => {
    const html = tip({ edge: { label: "port1 ↔ port48", isIface: 1 } });
    expect(html).toContain("SW-A");
    expect(html).toContain("SW-B");
    expect(html).toContain("port1 ↔ port48");
    expect(html).toContain("Interface-confirmed peer link");
  });

  it("falls back to FortiLink controller and drops an unknown port pair", () => {
    const html = tip({ edge: { label: "unknown ↔ unknown" } });
    expect(html).toContain("FortiLink controller");
    expect(html).not.toContain("unknown ↔ unknown");
  });

  it("adds each side's interface detail, prefixed by its device", () => {
    const html = tip({
      edge: {
        isLldp: 1,
        srcIf: { name: "lan1", speedBps: 1e9, operStatus: "up", inErrors: 3, outErrors: 1 },
        tgtIf: { name: "port52", speedBps: 1e8 },
      },
    });
    expect(html).toContain("LLDP neighbor");
    expect(html).toContain("lan1 · 1 Gbps · up · errors ↓3 ↑1");
    expect(html).toContain("port52 · 100 Mbps");
  });

  // Device names come from operator-editable hostnames; the widget writes
  // this HTML straight into the page, on the unauthenticated wallboard too.
  it("escapes device names and ports", () => {
    const html = tip({ a: "<img src=x onerror=alert(1)>", edge: { label: "<b>p</b>" } });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>p</b>");
    expect(html).toContain("&lt;img");
  });
});
