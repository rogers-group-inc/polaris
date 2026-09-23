/**
 * tests/unit/connectivityChecksUi.test.ts — the browser half of agent-run
 * connectivity checks:
 *   - the check modal's status-spec parser agrees with the server's (the
 *     three-way mirror: src/utils/httpCheck.ts, public/js/connectivity-checks.js,
 *     agent/internal/collectors/connectivity_http.go — the Go copy has the same
 *     table in connectivity_test.go),
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
const pageSrc = readFileSync(resolve(ROOT, "public/js/connectivity-checks.js"), "utf8");
const assetsSrc = readFileSync(resolve(ROOT, "public/js/assets.js"), "utf8");

let CC: any;

beforeAll(() => {
  const g = globalThis as any;
  g.window = g;
  g.escapeHtml = (s: string) => String(s);
  (0, eval)(pageSrc);
  CC = g.PolarisConnectivityChecks;
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
    const { connectivityCheckInputSchema } = await import("../../src/api/routes/connectivityChecks.js");
    for (const p of [
      good,
      { ...good, kind: "tcp", target: "db01.example:5432", http: null },
      { ...good, kind: "icmp", target: "10.0.0.1", http: null, scope: {}, assetIds: ["a1"] },
      { ...good, scope: { condition: { op: "and", children: [{ field: "agentInstalled", operator: "equals", value: "yes" }] } } },
    ]) {
      expect(CC.validateCheck(p)).toBeNull();
      expect(connectivityCheckInputSchema.safeParse(p).success).toBe(true);
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
    expect(pageSrc).not.toMatch(/connectivityChecks",\s*"fullwrite"/);
  });
});

describe("slide-over Connectivity tab helpers", () => {
  const fns = load(assetsSrc, ["_connTabEligible", "_trDiffHops", "_trHopRtt", "_connAvailabilityBuckets"]);
  it("shows the tab only when the host runs a check", () => {
    expect(fns._connTabEligible(null)).toBe(false);
    expect(fns._connTabEligible({ checks: [] })).toBe(false);
    expect(fns._connTabEligible({ checks: [{ id: "c" }] })).toBe(true);
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
    const b = (fns._connAvailabilityBuckets as any)([
      { timestamp: new Date(100).toISOString(), ok: true },
      { timestamp: new Date(200).toISOString(), ok: false },
      { timestamp: new Date(3500).toISOString(), okCount: 9, sampleCount: 10 },
    ], t0, t1, 4);
    expect(b[0]).toMatchObject({ ok: 1, total: 2 });
    expect(b[1].total).toBe(0); // a gap, not a failure
    expect(b[3]).toMatchObject({ ok: 9, total: 10 });
  });
  it("draws no data series in the failure red or dependency grey", () => {
    const tab = assetsSrc.slice(assetsSrc.indexOf("// ─── Asset slide-over → Connectivity tab"));
    const phases = /var _CONN_PHASES = \[([\s\S]*?)\];/.exec(tab)![1];
    expect(phases.toLowerCase()).not.toMatch(/#d32f2f|#9e9e9e|grey|gray/);
  });
});
