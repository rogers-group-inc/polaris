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

let sb: Record<string, any>;
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

  it("an icon device's glow clears its ring — the firewall's 10px border hid a 5px glow", () => {
    const sheet = R.topologyStylesheet("dark") as { selector: string; style: Record<string, unknown> }[];
    const base = sheet.find((r) => r.selector === "node.link-hover")!.style["underlay-padding"] as number;
    const iconRings = sheet.filter((r) => /^node\[hasIcon = 1\]\[role="[^"]+"\]$/.test(r.selector) && "border-width" in r.style);
    expect(iconRings.length).toBeGreaterThanOrEqual(4);
    for (const ring of iconRings) {
      const role = ring.selector.match(/role="([^"]+)"/)![1];
      const glow = sheet.find((r) => r.selector === `node.link-hover[hasIcon = 1][role="${role}"]`);
      expect(glow, role).toBeTruthy();
      // A border draws centred on the node edge: half of it is outside.
      expect(glow!.style["underlay-padding"], role).toBe(base + (ring.style["border-width"] as number) / 2);
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
        e("up", "fg", "s1", { isVerifiedUplink: 1, isIface: 0, isApLink: 0, inLoop: 0, linkSpeed: "10g" }),
        e("sw", "s1", "s2", { isIface: 1, isApLink: 0, inLoop: 1, linkSpeed: "1g" }),
        e("ll", "s2", "s1", { isLldp: 1, inLoop: 1, linkSpeed: "1g" }),
        e("ap", "s2", "a1", { isApLink: 1, linkSpeed: "unknown" }),
        e("me", "a1", "a2", { isMesh: 1, isApLink: 0, meshSignal: "unknown" }),
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
    expect(m("speed:10g")).toEqual(["up"]);
    expect(m("speed:1g")).toEqual(["ll", "sw"]);
    expect(m("speed:unknown")).toEqual(["ap"]);
    // A mesh link with no reading is "Signal not reported", not "Good" —
    // good is green now and lights only a measured good link.
    expect(m("signal:good")).toEqual([]);
    expect(m("signal:unknown")).toEqual(["me"]);
    expect(m("signal:poor")).toEqual([]);
    expect(m("loc:building")).toEqual(["box"]);
    expect(m("loc:floor")).toEqual([]);
  });

  it("highlights a row's elements, each link in its own colour, and clear drops it", () => {
    const cy = legendGraph();
    cy.style([
      { selector: "edge", style: { "line-color": "#6a7388" } },
      { selector: "#ap", style: { "line-color": "#3b82f6" } },
    ]);
    R.highlightLegendHover(cy, "speed:unknown");
    expect(ids(cy.elements(".link-hover"))).toEqual(["ap"]);
    expect(cy.$id("ap").data("hoverGlow")).toBe(cy.$id("ap").style("line-color"));
    R.highlightLegendHover(cy, "role:fortigate");
    expect(ids(cy.elements(".link-hover"))).toEqual(["fg"]);
    R.clearLinkHover(cy);
    expect(cy.elements(".link-hover").length).toBe(0);
    expect(cy.$id("ap").data("hoverGlow")).toBeUndefined();
  });

  it("every legend row carries a key legendMatch understands", () => {
    const spec = R.topologyLegendSpec("dark");
    const html: string = R.topologyLegendHtml(spec);
    const rows = (html.match(/class="topology-legend-row"/g) || []).length;
    const keyed = [...html.matchAll(/data-legend-key="([^"]+)"/g)].map((x) => x[1]);
    expect(keyed.length).toBe(rows);
    for (const k of ["speed:10g", "speed:10m", "speed:unknown", "signal:good", "signal:poor", "edge:mclag", "edge:loop"]) {
      expect(keyed).toContain(k);
    }
    const cy = legendGraph();
    for (const k of keyed) expect(() => R.legendMatch(cy, k)).not.toThrow();
  });
});

/**
 * The link tooltip writes out what the link's colour means: a wired link's
 * speed (or that none is known), a mesh link's signal in dBm and words, its
 * channel / band / width, and — with no signal reading — why there is none.
 */
describe("link tooltip speed and signal rows", () => {
  function tipGraph() {
    const n = (id: string) => ({ data: { id, label: id.toUpperCase() } });
    const e = (id: string, s: string, t: string, extra: Record<string, unknown>) => ({ data: { id, source: s, target: t, ...extra } });
    return sb.make(JSON.stringify({
      headless: true,
      styleEnabled: true,
      layout: { name: "preset" },
      elements: [
        n("s1"), n("s2"), n("a1"), n("a2"), n("a3"),
        e("fast", "s1", "s2", { label: "port49 ↔ port50", isIface: 1, linkSpeed: "10g", speedBps: 1e10,
          srcIf: { name: "port49", speedBps: 1e10, operStatus: "up", optics: { rxDbm: -3.2, txDbm: -2.1, temperatureC: 41, voltage: 3.3, biasA: 0.00898 } },
          tgtIf: { name: "port50", speedBps: 1e10, operStatus: "up", optics: { rxDbm: -24.5, txDbm: -2.4, temperatureC: null, voltage: null, biasA: null } } }),
        e("copper", "s2", "a2", { label: "port51 ↔ lan1", isApLink: 1, linkSpeed: "1g", speedBps: 1e9,
          srcIf: { name: "port51", speedBps: 1e9, operStatus: "up", optics: { rxDbm: null, txDbm: null, temperatureC: null, voltage: null, biasA: null } } }),
        e("slow", "s2", "a1", { label: "port7 ↔ lan1", isApLink: 1, linkSpeed: "100m", speedBps: 1e8 }),
        e("unk", "s1", "a1", { label: "unknown ↔ lan1", isApLink: 1, linkSpeed: "unknown", speedBps: null }),
        e("poor", "a1", "a2", { label: "mesh-x", isMesh: 1, meshSignal: "poor", signalDbm: -84, noiseDbm: -95,
          channel: 149, band: "5GHz", channelWidthMhz: 80, ssid: "mesh-x" }),
        e("none", "a1", "a3", { label: "mesh-y", isMesh: 1, meshSignal: "unknown", signalDbm: null, channel: 36, band: "5GHz" }),
      ],
    }));
  }
  const tip = (id: string) => {
    const cy = tipGraph();
    return R.edgeTooltipHtml(cy, cy.$id(id)) as string;
  };

  it("names a wired link's speed, flags a slow one, and says when none is known", () => {
    expect(tip("fast")).toContain("<b>10 Gbps</b>");
    expect(tip("fast")).not.toContain("Slower than 1 Gb");
    expect(tip("slow")).toContain("<b>100 Mbps</b>");
    expect(tip("slow")).toContain("Slower than 1 Gb");
    expect(tip("unk")).toContain("Speed not known");
  });

  it("adds each end's SFP readings under its port line, and names a port receiving too little light", () => {
    const fast = tip("fast");
    expect(fast).toContain("Rx −3.20 dBm · Tx −2.10 dBm · 41.0 °C · 3.30 V · 8.98 mA");
    // The far end's Rx is past -20 dBm: red, and named once below.
    expect(fast).toContain("color:var(--color-danger,#dc2626);font-weight:600\">Rx −24.50 dBm");
    expect(fast).toContain("S2 receives below −20 dBm");
    expect(fast.indexOf("S1:")).toBeLessThan(fast.indexOf("Rx −3.20"));
    // A copper SFP or an empty cage reads nothing: no SFP line, no warning.
    expect(tip("copper")).not.toContain(">SFP<");
    expect(tip("slow")).not.toContain(">SFP<");
  });

  it("writes a mesh link's signal, radio and SSID, and why a reading is missing", () => {
    const poor = tip("poor");
    expect(poor).toContain("−84 dBm");
    expect(poor).toContain("Poor signal");
    expect(poor).toContain("Channel 149 · 5 GHz · 80 MHz wide");
    expect(poor).toContain("SNR 11 dB");
    expect(poor).toContain(">mesh-x<");
    expect(poor).not.toContain("font-family:var(--font-mono,monospace);font-size:0.82em;margin-top:2px");
    const none = tip("none");
    expect(none).toContain("Signal not reported");
    expect(none).toContain("REST API");
    expect(none).toContain("Channel 36");
  });
});

describe("link tooltip on a physical loop", () => {
  // A ring A–B–C–D–A with port pairs + speeds, a tail D–E, and a 10-switch
  // ring for the row cap.
  function ringGraph() {
    const n = (id: string) => ({ data: { id, label: "SW-" + id } });
    const e = (id: string, s: string, t: string, extra: Record<string, unknown> = {}) => ({ data: { id, source: s, target: t, ...extra } });
    const big = Array.from({ length: 10 }, (_, i) => `R${i}`);
    return sb.make(JSON.stringify({
      headless: true,
      styleEnabled: true,
      layout: { name: "preset" },
      elements: [
        n("A"), n("B"), n("C"), n("D"), n("E"), ...big.map(n),
        e("ab", "A", "B", { inLoop: 1, label: "port1 ↔ port2", linkSpeed: "10g", speedBps: 1e10 }),
        e("bc", "B", "C", { inLoop: 1, label: "port3 ↔ port4", linkSpeed: "1g", speedBps: 1e9 }),
        e("cd", "C", "D", { inLoop: 1, label: "port5 ↔ port6", linkSpeed: "unknown", isLastKnown: 1 }),
        e("da", "D", "A", { inLoop: 1, label: "port7 ↔ port8", linkSpeed: "1g", speedBps: 1e9 }),
        e("de", "D", "E", { label: "port9 ↔ port10", linkSpeed: "1g", speedBps: 1e9 }),
        ...big.map((id, i) => e(`r${i}`, id, big[(i + 1) % big.length], { inLoop: 1, label: `p${i}a ↔ p${i}b` })),
      ],
    }));
  }
  const tip = (id: string) => {
    const cy = ringGraph();
    return R.edgeTooltipHtml(cy, cy.$id(id)) as string;
  };

  it("lists the loop's other links, read around the ring from the hovered link", () => {
    const html = tip("ab");
    expect(html).toContain("Part of a ring");
    expect(html).toContain("· 4 links");
    const bc = html.indexOf("port3 ↔ port4");
    const cd = html.indexOf("port5 ↔ port6");
    const da = html.indexOf("port7 ↔ port8");
    expect(bc).toBeGreaterThan(-1);
    expect(bc).toBeLessThan(cd);
    expect(cd).toBeLessThan(da);
    // The hovered link is the header, not a ring row; the tail is not in the ring.
    expect(html.split("port1 ↔ port2").length).toBe(2);
    expect(html).not.toContain("port9 ↔ port10");
    expect(html).toContain("SW-B <span style=\"opacity:0.7\">⇄</span> SW-C");
    expect(html).toContain(">1 Gbps<");
    expect(html).toContain(">last known<");
  });

  it("a link off the loop gets no ring section", () => {
    expect(tip("de")).not.toContain("Part of a ring");
  });

  it("caps a large ring's rows and counts the rest", () => {
    const html = tip("r0");
    expect(html).toContain("· 10 links");
    expect(html).toContain("+1 more");
    expect(html).toContain("p1a ↔ p1b");
    expect(html).not.toContain("p9a ↔ p9b"); // the last row of the walk is the one cut
  });
});
