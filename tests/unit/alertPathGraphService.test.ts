/**
 * tests/unit/alertPathGraphService.test.ts — own suite for
 * src/services/alertPathGraphService.ts (CQ-T010).
 *
 * pathGraphSvg.test.ts pins the fold and the basic subject choice. This file
 * covers the delivery-time step end to end on a stubbed Prisma and a stubbed
 * resvg: which reads it makes, the server-run subject, every render-away case
 * (not a path metric, traceroute off, unknown check, no traces), the PNG and
 * the text fallback, the heading, the attachments, a failed load, and the
 * rule-75 subject ordering on a grouped alert.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const rs = vi.hoisted(() => ({ fail: false, svgs: [] as string[] }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("@resvg/resvg-js", () => ({
  Resvg: class {
    constructor(svg: string) {
      if (rs.fail) throw new Error("no native binding");
      rs.svgs.push(svg);
    }
    render() {
      return { asPng: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]) };
    }
  },
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  MAX_PATH_GRAPHS,
  PATH_GRAPH_METRICS,
  buildPathGraphBlocks,
  pathGraphCid,
  pathGraphSubjects,
  pathGraphTokensIn,
  substitutePathGraphTokens,
  type PathGraphNotification,
} from "../../src/services/alertPathGraphService.js";
import type { AlertMember } from "../../src/services/notificationTypes.js";

const HOPS = [
  { ttl: 1, ip: "10.0.0.1", rttMs: [1, 1, 1] },
  { ttl: 2, ip: "2001:db8::1", rttMs: [5, 5, 5] },
  { ttl: 3, ip: "10.9.9.9", rttMs: [80, 80, 80] },
];
const trace = (hops: unknown = HOPS) => ({ destinationIp: "10.9.9.9", complete: true, hops });

const base: PathGraphNotification = { assetId: "a1", dimension: "c1", metric: "pathOk", ruleId: "r1", members: null, testRun: false };
const member = (key: string, over: Partial<AlertMember> = {}): AlertMember => ({
  key, label: key, ruleId: "r1", ruleName: "Path", severity: "warning", joinedAt: "2026-11-14T00:00:00Z", ...over,
});

function seed(opts: {
  checks?: Array<{ id: string; name: string; traceroute: unknown }>;
  hosts?: Array<{ id: string; hostname: string | null }>;
  traces?: Record<string, unknown[]>;
}) {
  stubbed(prisma.pathCheck.findMany).mockResolvedValue(opts.checks ?? [{ id: "c1", name: "HTTPS erp", traceroute: { enabled: true } }]);
  stubbed(prisma.asset.findMany).mockResolvedValue(opts.hosts ?? [{ id: "a1", hostname: "PLANT-PC-04" }]);
  stubbed(prisma.assetPathCheckTraceroute.findMany).mockImplementation(async (args: { where: { assetId: string; checkId: string } }) =>
    (opts.traces ?? { "a1|c1": [trace()] })[`${args.where.assetId}|${args.where.checkId}`] ?? []);
}

beforeEach(() => {
  resetDbStub();
  rs.fail = false;
  rs.svgs = [];
});

describe("constants and helpers", () => {
  it("names one cid per graph", () => {
    expect(pathGraphCid(0)).toBe("polaris-path-graph-0@polaris");
    expect(pathGraphCid(3)).toBe("polaris-path-graph-3@polaris");
  });

  it("covers the six path metrics, and draws at most four", () => {
    expect([...PATH_GRAPH_METRICS].sort()).toEqual(["pathFailurePct", "pathHopCount", "pathHttpStatus", "pathLatencyMs", "pathOk", "pathTlsDaysLeft"]);
    expect(MAX_PATH_GRAPHS).toBe(4);
  });

  it("finds {path.graph} across templates and substitutes it literally", () => {
    expect([...pathGraphTokensIn(null, undefined, "", "x{path.graph}")]).toEqual(["path.graph"]);
    expect(pathGraphTokensIn("{path.graphs}").size).toBe(0);
    expect(substitutePathGraphTokens("a{path.graph}b{path.graph}", "$&")).toBe("a$&b$&");
    expect(substitutePathGraphTokens("a{path.graph}b", "")).toBe("ab");
    expect(substitutePathGraphTokens("", "x")).toBe("");
  });
});

describe("pathGraphSubjects", () => {
  it("draws nothing without a metric, or without a dimension on an ungrouped alert", () => {
    expect(pathGraphSubjects({ ...base, metric: null })).toEqual([]);
    expect(pathGraphSubjects({ ...base, dimension: null })).toEqual([]);
  });

  it("falls back to the ungrouped path when every member has recovered, and treats '' as no host", () => {
    const members = [member("c9", { assetId: "a9", leftAt: "2026-11-14T01:00:00Z" })];
    expect(pathGraphSubjects({ ...base, assetId: "", members })).toEqual([{ assetId: null, checkId: "c1", ruleId: "r1" }]);
  });

  it("skips whole-device members (empty key) and inherits the alert's host when a member has none", () => {
    const members = [member(""), member("c2", { ruleId: "r2" })];
    expect(pathGraphSubjects({ ...base, members })).toEqual([{ assetId: "a1", checkId: "c2", ruleId: "r2" }]);
  });

  it("never draws the same (host, check) twice and respects a smaller max", () => {
    const members = [member("c1", { ruleId: "r1" }), member("c1", { ruleId: "r2" }), member("c2", { ruleId: "r1" })];
    expect(pathGraphSubjects({ ...base, members }).map((s) => s.checkId)).toEqual(["c1", "c2"]);
    expect(pathGraphSubjects({ ...base, members }, 1)).toHaveLength(1);
  });

  // BUG: pathGraphSubjects puts only the PRIMARY (worst) member first and
  // keeps every other member in stored (join) order, so "up to four, worst
  // first" (file header + the alerting-delivery touches entry) does not hold
  // past the first slot. Input: a device-spanning alert whose members are
  // warning a1, a2, a3 then critical a4, a5. Wrong output: a4, a1, a2, a3 — the
  // second critical device a5 is not drawn at all. Right output: a4, a5 first,
  // then two of the warnings.
  it.fails("orders every slot worst first, so a second critical device is drawn before the warnings", () => {
    const members = [
      member("c1", { assetId: "a1" }), member("c1", { assetId: "a2" }), member("c1", { assetId: "a3" }),
      member("c1", { assetId: "a4", severity: "critical" }), member("c1", { assetId: "a5", severity: "critical" }),
    ];
    const s = pathGraphSubjects({ ...base, members });
    expect(s.slice(0, 2).map((x) => x.assetId)).toEqual(["a4", "a5"]);
  });
});

describe("buildPathGraphBlocks", () => {
  it("renders away, with zero reads, on an alert that is not about a path", async () => {
    expect(await buildPathGraphBlocks({ ...base, metric: "cpuPct" })).toEqual({ html: "", text: "", attachments: [] });
    expect(prisma.pathCheck.findMany).not.toHaveBeenCalled();
  });

  it("draws one invented Example route for a test send and reads nothing (rule 65)", async () => {
    const b = await buildPathGraphBlocks({ ...base, testRun: true });
    expect(prisma.pathCheck.findMany).not.toHaveBeenCalled();
    expect(prisma.assetPathCheckTraceroute.findMany).not.toHaveBeenCalled();
    expect(b.attachments).toHaveLength(1);
    expect(b.text.startsWith("Path:\nExample check — from Example host: ")).toBe(true);
  });

  it("reads the check, the host and ten newest traces, and draws one PNG", async () => {
    seed({});
    const b = await buildPathGraphBlocks(base);
    expect(stubbed(prisma.pathCheck.findMany).mock.calls[0]![0]).toMatchObject({ where: { id: { in: ["c1"] } } });
    expect(stubbed(prisma.asset.findMany).mock.calls[0]![0]).toMatchObject({ where: { id: { in: ["a1"] } } });
    expect(stubbed(prisma.assetPathCheckTraceroute.findMany).mock.calls[0]![0]).toMatchObject({
      where: { assetId: "a1", checkId: "c1" }, orderBy: { timestamp: "desc" }, take: 10,
    });
    expect(b.attachments).toEqual([
      { cid: "polaris-path-graph-0@polaris", filename: "path-1.png", contentType: "image/png", content: expect.any(Buffer) },
    ]);
    expect(b.html).toContain('src="cid:polaris-path-graph-0@polaris"');
    expect(b.html).toContain(">Path</div>");
    expect(b.html).toContain('alt="HTTPS erp — from PLANT-PC-04: ');
    expect(b.text.split("\n")[0]).toBe("Path:");
    expect(b.text.split("\n")[1]!.startsWith("HTTPS erp — from PLANT-PC-04: ")).toBe(true);
    expect(rs.svgs[0]).toContain("<svg");
  });

  it("reads a server-run check under the Polaris server subject, with no asset read", async () => {
    seed({ traces: { "polaris-server|c1": [trace()] } });
    const b = await buildPathGraphBlocks({ ...base, assetId: null });
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
    expect(stubbed(prisma.assetPathCheckTraceroute.findMany).mock.calls[0]![0].where).toEqual({ assetId: "polaris-server", checkId: "c1" });
    expect(b.text).toContain("HTTPS erp — from Polaris server");
  });

  it("labels a host it cannot name 'This host'", async () => {
    seed({ hosts: [] });
    expect((await buildPathGraphBlocks(base)).text).toContain("HTTPS erp — from This host");
    seed({ hosts: [{ id: "a1", hostname: null }] });
    expect((await buildPathGraphBlocks(base)).text).toContain("from This host");
  });

  it("renders away when traceroute is off for the check, the check is gone, or no trace exists yet", async () => {
    seed({ checks: [{ id: "c1", name: "x", traceroute: { enabled: false } }] });
    expect(await buildPathGraphBlocks(base)).toEqual({ html: "", text: "", attachments: [] });
    expect(prisma.assetPathCheckTraceroute.findMany).not.toHaveBeenCalled();

    seed({ checks: [] });
    expect((await buildPathGraphBlocks(base)).html).toBe("");

    seed({ traces: {} });
    expect((await buildPathGraphBlocks(base)).html).toBe("");
  });

  it("treats a null traceroute config as on", async () => {
    seed({ checks: [{ id: "c1", name: "x", traceroute: null }] });
    expect((await buildPathGraphBlocks(base)).attachments).toHaveLength(1);
  });

  it("survives a stored hops value that is not an array", async () => {
    seed({ traces: { "a1|c1": [trace({ broken: true })] } });
    const b = await buildPathGraphBlocks(base);
    expect(b.attachments).toHaveLength(1);
  });

  it("falls back to a text paragraph per path when resvg is unavailable, title and line escaped", async () => {
    rs.fail = true;
    seed({ checks: [{ id: "c1", name: "<ERP> & co", traceroute: {} }] });
    const b = await buildPathGraphBlocks(base);
    expect(b.attachments).toEqual([]);
    expect(b.html).toContain("<strong>&lt;ERP&gt; &amp; co — from PLANT-PC-04</strong><br>");
    expect(b.html).not.toContain("<img");
  });

  it("draws a grouped alert's paths with a counted heading, one cid each, skipping those with no traces", async () => {
    const members = [
      member("c1", { assetId: "a1", severity: "critical" }),
      member("c1", { assetId: "a2" }),
      member("c1", { assetId: "a3" }),
    ];
    seed({
      hosts: [{ id: "a1", hostname: "H1" }, { id: "a2", hostname: "H2" }, { id: "a3", hostname: "H3" }],
      traces: { "a1|c1": [trace()], "a3|c1": [trace(), trace()] },
    });
    const b = await buildPathGraphBlocks({ ...base, members });
    expect(stubbed(prisma.asset.findMany).mock.calls[0]![0].where.id.in.sort()).toEqual(["a1", "a2", "a3"]);
    expect(prisma.assetPathCheckTraceroute.findMany).toHaveBeenCalledTimes(3);
    expect(b.html).toContain(">Paths (2)</div>");
    expect(b.attachments.map((a) => [a.cid, a.filename])).toEqual([
      ["polaris-path-graph-0@polaris", "path-1.png"],
      ["polaris-path-graph-1@polaris", "path-2.png"],
    ]);
    const lines = b.text.split("\n");
    expect(lines[0]).toBe("Paths (2):");
    expect(lines[1]).toContain("from H1");
    expect(lines[2]).toContain("from H3");
  });

  it("leaves the block out, never throws, when a read fails", async () => {
    stubbed(prisma.pathCheck.findMany).mockRejectedValue(new Error("db down"));
    stubbed(prisma.asset.findMany).mockResolvedValue([]);
    await expect(buildPathGraphBlocks(base)).resolves.toEqual({ html: "", text: "", attachments: [] });
  });
});
