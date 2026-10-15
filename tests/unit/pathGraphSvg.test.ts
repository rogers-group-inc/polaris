/**
 * tests/unit/pathGraphSvg.test.ts
 *
 * The server-side port of the Paths tab's traceroute graph (utils/pathGraphSvg)
 * and the email's choice of which paths to draw (alertPathGraphService's
 * pathGraphSubjects). The fold must agree with the browser's `_trPathGraph`:
 * a node per (TTL, address), a branch on a route change, a separate broken
 * link to the destination for a trace that stopped short.
 */

import { describe, it, expect } from "vitest";
import {
  buildPathGraph,
  hopRtt,
  pathEdgeColor,
  pathGraphSvg,
  pathGraphText,
  PATH_GRAPH_COLORS,
  type PathTrace,
} from "../../src/utils/pathGraphSvg.js";
import { pathGraphSubjects, MAX_PATH_GRAPHS } from "../../src/services/alertPathGraphService.js";
import type { AlertMember } from "../../src/services/notificationTypes.js";

const ok: PathTrace = {
  destinationIp: "10.9.9.9", complete: true,
  hops: [
    { ttl: 1, ip: "10.0.0.1", rttMs: [1, 1, 1] },
    { ttl: 2, ip: "10.1.0.1", rttMs: [5, 5, 5] },
    { ttl: 3, ip: "10.9.9.9", rttMs: [80, 80, 80] },
  ],
};
// An older trace that took another second hop.
const branch: PathTrace = {
  destinationIp: "10.9.9.9", complete: true,
  hops: [
    { ttl: 1, ip: "10.0.0.1", rttMs: [1] },
    { ttl: 2, ip: "10.2.0.1", rttMs: [6] },
    { ttl: 3, ip: "10.9.9.9", rttMs: [20] },
  ],
};
const broken: PathTrace = {
  destinationIp: "10.9.9.9", complete: false,
  hops: [{ ttl: 1, ip: "10.0.0.1", rttMs: [1] }, { ttl: 2, ip: null, rttMs: [-1, -1] }],
};

describe("buildPathGraph", () => {
  it("folds one complete trace into source → hops → destination", () => {
    const g = buildPathGraph([ok]);
    expect(Object.keys(g.nodes).sort()).toEqual(["1:10.0.0.1", "2:10.1.0.1", "dst", "src"]);
    expect(g.cols).toBe(4);
    expect(g.nodes["dst"]!.col).toBe(3);
    // The last link ADDS 75 ms (80 − 5): that is the slow segment.
    const last = g.edges.find((e) => e.to === "dst")!;
    expect(last.delta).toBe(75);
    expect(pathEdgeColor(last)).toBe(PATH_GRAPH_COLORS.danger);
  });

  it("draws a route change as a branch, the newest trace highlighted", () => {
    const g = buildPathGraph([ok, branch]);
    expect(g.nodes["2:10.1.0.1"]!.onSel).toBe(true);
    expect(g.nodes["2:10.2.0.1"]!.onSel).toBe(false);
    expect(g.nodes["1:10.0.0.1"]!.traces).toBe(2);
    // Rows: one per node in the TTL-2 column.
    expect(new Set([g.nodes["2:10.1.0.1"]!.row, g.nodes["2:10.2.0.1"]!.row])).toEqual(new Set([0, 1]));
  });

  it("gives a trace that stopped short its own broken link to the destination", () => {
    const g = buildPathGraph([broken]);
    const e = g.edges.find((x) => x.to === "dst")!;
    expect(e.broken).toBe(true);
    expect(pathEdgeColor(e)).toBe(PATH_GRAPH_COLORS.danger);
    expect(g.nodes["2:*"]).toBeTruthy();
  });

  it("averages only answered probes", () => {
    expect(hopRtt([2, -1, 4])).toEqual({ avg: 3, min: 2, max: 4 });
    expect(hopRtt([-1, -1])).toBeNull();
  });
});

describe("pathGraphSvg / pathGraphText", () => {
  it("draws a self-contained SVG on white, titled, with literal colours", () => {
    const svg = pathGraphSvg(buildPathGraph([ok]), { hostname: "plant-pc-04" }, { title: "ERP HTTPS — from plant-pc-04" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain("ERP HTTPS — from plant-pc-04");
    expect(svg).not.toContain("var(--");
    expect(svg).toContain(PATH_GRAPH_COLORS.danger);
  });

  it("escapes what a hostname can carry", () => {
    const svg = pathGraphSvg(buildPathGraph([ok]), { hostname: "<b>&" }, {});
    expect(svg).toContain("&lt;b&gt;&amp;");
  });

  it("is at least 520px wide, and grows for a long route", () => {
    const width = (s: string) => Number(/width="(\d+)"/.exec(s)![1]);
    expect(width(pathGraphSvg(buildPathGraph([ok]), {}, {}))).toBe(520);
    const long: PathTrace = { destinationIp: "10.9.9.9", complete: true, hops: Array.from({ length: 14 }, (_, i) => ({ ttl: i + 1, ip: `10.0.${i}.1`, rttMs: [i] })) };
    expect(width(pathGraphSvg(buildPathGraph([long]), {}, {}))).toBeGreaterThan(520);
  });

  it("reads the newest route as one text line", () => {
    expect(pathGraphText([ok], { hostname: "pc" })).toBe("pc → 10.0.0.1 (1 ms) → 10.1.0.1 (5 ms) → 10.9.9.9 (80 ms)");
    expect(pathGraphText([broken], { hostname: "pc" })).toMatch(/✕ not reached$/);
  });
});

describe("pathGraphSubjects", () => {
  const m = (key: string, over: Partial<AlertMember> = {}): AlertMember => ({
    key, label: key, ruleId: over.ruleId ?? "r1", ruleName: "Path", severity: over.severity ?? "warning", joinedAt: "", ...over,
  });
  const base = { assetId: "a1", dimension: "c1", metric: "pathOk", ruleId: "r1", members: null, testRun: false };

  it("draws nothing for an alert that is not about a path check", () => {
    expect(pathGraphSubjects({ ...base, metric: "cpuPct" })).toEqual([]);
  });

  it("draws the one path of an ungrouped alert, a server-run one with no host", () => {
    expect(pathGraphSubjects(base)).toEqual([{ assetId: "a1", checkId: "c1", ruleId: "r1" }]);
    expect(pathGraphSubjects({ ...base, assetId: null })).toEqual([{ assetId: null, checkId: "c1", ruleId: "r1" }]);
  });

  it("across devices: one per DEVICE first, worst first, at most four", () => {
    const members = [
      m("c1", { assetId: "a1" }), m("c2", { assetId: "a1" }),
      m("c1", { assetId: "a2", severity: "critical" }), m("c1", { assetId: "a3" }),
      m("c1", { assetId: "a4" }), m("c1", { assetId: "a5" }),
    ];
    const s = pathGraphSubjects({ ...base, members });
    expect(s).toHaveLength(MAX_PATH_GRAPHS);
    expect(s[0]).toEqual({ assetId: "a2", checkId: "c1", ruleId: "r1" });
    expect(new Set(s.map((x) => x.assetId)).size).toBe(4);
  });

  it("on one device: one per AUTOMATION first, then the other checks", () => {
    const members = [m("c1", { ruleId: "r1" }), m("c2", { ruleId: "r1" }), m("c3", { ruleId: "r2" })];
    const s = pathGraphSubjects({ ...base, members });
    expect(s.map((x) => x.checkId)).toEqual(["c1", "c3", "c2"]);
    expect(s.every((x) => x.assetId === "a1")).toBe(true);
  });

  it("leaves out recovered members", () => {
    const members = [m("c1", { assetId: "a1", leftAt: "2026-10-01T00:00:00Z" }), m("c1", { assetId: "a2" })];
    expect(pathGraphSubjects({ ...base, members }).map((x) => x.assetId)).toEqual(["a2"]);
  });
});
