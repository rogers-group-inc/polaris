/**
 * tests/unit/pathChecksUi.test.ts — the browser half of agent-run
 * path checks:
 *   - the check modal's status-spec parser agrees with the server's (the
 *     three-way mirror: src/utils/httpCheck.ts, public/js/path-checks.js,
 *     agent/internal/collectors/path_check_http.go — the Go copy has the same
 *     table in path_check_test.go),
 *   - client validation, the row menu (Results first, Delete danger, no
 *     fullwrite on an UP_TO_WRITE key),
 *   - the slide-over tab's pure helpers in assets.js (eligibility, hop diff,
 *     RTT summary, availability buckets),
 *   - every payload the modal can post parses against the route's Zod schema.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseStatusSpec as serverParse } from "../../src/utils/httpCheck.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const ROOT = resolve(__dirname, "../..");
const pageSrc = readFileSync(resolve(ROOT, "public/js/path-checks.js"), "utf8");
const assetsSrc = readFileSync(resolve(ROOT, "public/js/assets.js"), "utf8");

let CC: any;

beforeAll(() => {
  const g = globalThis as any;
  g.window = g;
  g.escapeHtml = (s: string) => String(s);
  (0, eval)(pageSrc);
  CC = g.PolarisPathChecks;
});

/** Slice one top-level `function name(…) { … }` out of a browser file. */
function sliceFn(src: string, name: string): string {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("no function " + name);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error("unbalanced " + name);
}

function load<T = any>(src: string, names: string[]): Record<string, T> {
  const body = names.map((n) => sliceFn(src, n)).join("\n") + "\nreturn {" + names.join(",") + "};";
  return new Function(body)();
}

const SPECS = ["", "200", "200, 204,300-399", "20", "200-", "599-200", "abc", "200,,204", "700", "100-599"];

describe("status spec — client mirrors server", () => {
  it.each(SPECS)("%j", (spec) => {
    const c = CC.parseStatusSpec(spec);
    const s = serverParse(spec);
    expect(c.error === null).toBe(s.error === null);
    expect(c.ranges).toEqual(s.ranges);
  });
});

describe("client validation", () => {
  const good = {
    name: "Intranet", kind: "https", target: "https://intranet.example/health", intervalSec: 60, timeoutMs: 5000,
    http: { expectStatus: "", bodyMatch: null, verifyTls: true }, traceroute: { enabled: true, everyNRuns: 5, maxHops: 30, probesPerHop: 3 },
    keepBodyExcerpt: false, scope: { allAssets: true }, assetIds: [], enabled: true, description: null,
  };
  it("accepts a well-formed check", () => expect(CC.validateCheck(good)).toBeNull());
  it("names the tab of each refusal", () => {
    expect(CC.validateCheck({ ...good, name: "" }).tab).toBe("general");
    expect(CC.validateCheck({ ...good, target: "http://x/" }).tab).toBe("general");
    expect(CC.validateCheck({ ...good, timeoutMs: 40000 }).tab).toBe("general");
    expect(CC.validateCheck({ ...good, http: { ...good.http, expectStatus: "2000" } }).tab).toBe("expect");
    expect(CC.validateCheck({ ...good, http: { ...good.http, bodyMatch: { mode: "regex", pattern: "a(?=b)" } } }).tab).toBe("expect");
    expect(CC.validateCheck({ ...good, scope: {}, assetIds: [] }).tab).toBe("sources");
    expect(CC.validateCheck({ ...good, kind: "tcp", target: "db01", http: null }).tab).toBe("general");
  });
  it("every payload it accepts parses against the route schema", async () => {
    const { pathCheckInputSchema } = await import("../../src/api/routes/pathChecks.js");
    for (const p of [
      good,
      { ...good, kind: "tcp", target: "db01.example:5432", http: null },
      { ...good, kind: "icmp", target: "10.0.0.1", http: null, scope: {}, assetIds: ["a1"] },
      { ...good, scope: { condition: { op: "and", children: [{ field: "agentInstalled", operator: "equals", value: "yes" }] } } },
    ]) {
      expect(CC.validateCheck(p)).toBeNull();
      expect(pathCheckInputSchema.safeParse(p).success).toBe(true);
    }
  }, 60_000);
});

describe("row menu", () => {
  it("offers Results to a reader, and the verbs to an editor", () => {
    const check = { id: "c1", name: "x", enabled: true };
    const read = CC.menuItems(check, { canEdit: false });
    expect(read.map((i: any) => i.label)).toEqual(["Results"]);
    const edit = CC.menuItems(check, { canEdit: true }).filter((i: any) => !i.separator);
    expect(edit.map((i: any) => i.label)).toEqual(["Results", "Edit", "Duplicate", "Disable", "Delete"]);
    expect(edit[edit.length - 1].danger).toBe(true);
  });
  it("never asks for fullwrite on the UP_TO_WRITE key (rule 43d)", () => {
    expect(pageSrc).not.toMatch(/pathChecks",\s*"fullwrite"/);
  });
});

describe("slide-over Paths tab helpers", () => {
  const fns = load(assetsSrc, ["_pathTabEligible", "_trDiffHops", "_trHopRtt", "_pathAvailabilityBuckets"]);
  it("shows the tab only when the host runs a check", () => {
    expect(fns._pathTabEligible(null)).toBe(false);
    expect(fns._pathTabEligible({ checks: [] })).toBe(false);
    expect(fns._pathTabEligible({ checks: [{ id: "c" }] })).toBe(true);
  });
  it("diffs hops by TTL", () => {
    const prev = { hops: [{ ttl: 1, ip: "10.0.0.1" }, { ttl: 2, ip: null }, { ttl: 3, ip: "8.8.8.8" }] };
    const cur = { hops: [{ ttl: 1, ip: "10.0.0.1" }, { ttl: 2, ip: "10.0.0.9" }, { ttl: 3, ip: "8.8.8.8" }, { ttl: 4, ip: "1.1.1.1" }] };
    expect([...(fns._trDiffHops as any)(cur, prev)].sort()).toEqual([2, 4]);
    expect((fns._trDiffHops as any)(cur, undefined).size).toBe(0);
  });
  it("summarizes RTTs ignoring timeouts", () => {
    expect((fns._trHopRtt as any)([1, -1, 3])).toEqual({ avg: 2, min: 1, max: 3 });
    expect((fns._trHopRtt as any)([-1, -1])).toBeNull();
  });
  it("buckets availability from detail rows and rollup counts", () => {
    const t0 = 0, t1 = 4000;
    const b = (fns._pathAvailabilityBuckets as any)([
      { timestamp: new Date(100).toISOString(), ok: true },
      { timestamp: new Date(200).toISOString(), ok: false },
      { timestamp: new Date(3500).toISOString(), okCount: 9, sampleCount: 10 },
    ], t0, t1, 4);
    expect(b[0]).toMatchObject({ ok: 1, total: 2 });
    expect(b[1].total).toBe(0); // a gap, not a failure
    expect(b[3]).toMatchObject({ ok: 9, total: 10 });
  });
  it("draws no data series in the failure red or dependency grey", () => {
    const tab = assetsSrc.slice(assetsSrc.indexOf("// ─── Asset slide-over → Paths tab"));
    const phases = /var _PATH_PHASES = \[([\s\S]*?)\];/.exec(tab)![1];
    expect(phases.toLowerCase()).not.toMatch(/#d32f2f|#9e9e9e|grey|gray/);
  });
});

describe("traceroute path graph (NetPath-style)", () => {
  const prelude = 'var MONITOR_STATE_COLORS = { up: "#2a9d8f", down: "#d32f2f", warning: "#f4a261" };' +
    "function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;'); }\n";
  const names = ["_trHopRtt", "_trPathGraph", "_trEdgeColor", "_trPathSVG", "_trPathTooltipHTML"];
  const fns: any = new Function(prelude + names.map((n) => sliceFn(assetsSrc, n)).join("\n") + "\nreturn {" + names.join(",") + "};")();

  const hop = (ttl: number, ip: string | null, rtt: number[] = [1, 1, 1], extra: any = {}) => ({ ttl, ip, rdns: null, rttMs: ip ? rtt : [-1, -1, -1], ...extra });
  // Newest first, as the route returns them.
  const newest = { destinationIp: "10.0.0.9", complete: true, hops: [hop(1, "10.0.0.1"), hop(2, "10.0.0.2", [2, 2, 2]), hop(3, null), hop(4, "10.0.0.9", [70, 70, 70])] };
  const older = { destinationIp: "10.0.0.9", complete: true, hops: [hop(1, "10.0.0.1"), hop(2, "10.0.0.3"), hop(3, "10.0.0.9", [3, 3, 3])] };
  const failed = { destinationIp: "10.0.0.9", complete: false, hops: [hop(1, "10.0.0.1"), hop(2, "10.0.0.2", [5, -1, 5])] };

  it("merges a hop seen at the same TTL on several traces into one node, and a route change into a branch", () => {
    const g = fns._trPathGraph([newest, older], 0);
    expect(g.nodes["1:10.0.0.1"].traces).toBe(2);
    expect(g.nodes["2:10.0.0.2"].onSel).toBe(true);
    expect(g.nodes["2:10.0.0.3"].onSel).toBe(false);
    expect(g.nodes["2:10.0.0.2"].row).not.toBe(g.nodes["2:10.0.0.3"].row);
    expect(g.nodes.src.traces).toBe(2);
  });

  it("puts the destination in its own last column even when traces reach it at different TTLs", () => {
    const g = fns._trPathGraph([newest, older], 0);
    expect(g.nodes["4:10.0.0.9"]).toBeUndefined();
    expect(g.nodes["3:10.0.0.9"]).toBeUndefined();
    expect(g.nodes.dst.col).toBe(g.cols - 1);
    expect(g.nodes.dst.traces).toBe(2);
  });

  it("colours the selected route by the latency each link adds, skipping unanswered hops", () => {
    const g = fns._trPathGraph([newest, older], 0);
    const edge = (a: string, b: string) => g.edges.find((e: any) => e.from === a && e.to === b);
    expect(fns._trEdgeColor(edge("src", "1:10.0.0.1"))).toBe("var(--color-success)");
    expect(edge("2:10.0.0.2", "3:*").unanswered).toBe(true);
    // 70 ms at the destination minus the 2 ms at the last answered hop.
    expect(edge("3:*", "dst").delta).toBe(68);
    expect(fns._trEdgeColor(edge("3:*", "dst"))).toBe("var(--color-danger)");
    expect(fns._trEdgeColor(edge("2:10.0.0.3", "dst"))).toBe("var(--color-text-tertiary)"); // not the selected route
  });

  it("marks a trace that stopped short as a broken link to the destination", () => {
    const g = fns._trPathGraph([failed, newest], 0);
    const broken = g.edges.find((e: any) => e.broken);
    expect(broken).toMatchObject({ from: "2:10.0.0.2", to: "dst", onSel: true });
    expect(g.edges.find((e: any) => e.from === "1:10.0.0.1" && e.to === "2:10.0.0.2").lossy).toBe(true);
    expect(fns._trPathSVG(g, { hostname: "h" }, 400)).toContain('stroke-dasharray="5 4"');
  });

  it("still draws a destination no trace reached", () => {
    const g = fns._trPathGraph([failed], 0);
    expect(g.nodes.dst.hop.ip).toBe("10.0.0.9");
    expect(g.nodes.dst.traces).toBe(0);
  });

  it("renders one hit target per node, colours inline, and escapes device names", () => {
    const named = { ...newest, hops: [hop(1, "10.0.0.1", [1, 1, 1], { hostname: "<core>", assetId: "a1", monitorStatus: "up" }), ...newest.hops.slice(1)] };
    const g = fns._trPathGraph([named], 0);
    const svg = fns._trPathSVG(g, { hostname: "web01" }, 300);
    expect((svg.match(/class="chart-hit"/g) || []).length).toBe(Object.keys(g.nodes).length);
    expect(svg).toContain("&lt;core&gt;");
    expect(svg).not.toContain("<core>");
    expect(svg).toContain('fill="#2a9d8f"');
    expect(svg).not.toMatch(/class="(?!chart-hit)/); // the camera sees no stylesheet
    expect(fns._trPathTooltipHTML(g, "1:10.0.0.1", null)).toContain("Click to open the asset");
    expect(fns._trPathTooltipHTML(g, "3:*", null)).toContain("No router answered");
  });
});

describe("traceroute path graph — a stopped trace beside a completed one", () => {
  const names = ["_trHopRtt", "_trPathGraph"];
  const fns: any = new Function(names.map((n) => sliceFn(assetsSrc, n)).join("\n") + "\nreturn {" + names.join(",") + "};")();
  const hop = (ttl: number, ip: string, ms = 1) => ({ ttl, ip, rdns: null, rttMs: [ms, ms, ms] });
  it("does not put the ✕ on the route that got through", () => {
    const done = { destinationIp: "10.0.0.9", complete: true, hops: [hop(1, "10.0.0.1"), hop(2, "10.0.0.9")] };
    const stopped = { destinationIp: "10.0.0.9", complete: false, hops: [hop(1, "10.0.0.1")] };
    const g = fns._trPathGraph([done, stopped], 0);
    const toDst = g.edges.filter((e: any) => e.from === "1:10.0.0.1" && e.to === "dst");
    expect(toDst).toHaveLength(2);
    expect(toDst.find((e: any) => e.onSel).broken).toBe(false);
    expect(toDst.find((e: any) => !e.onSel).broken).toBe(true);
  });
});
