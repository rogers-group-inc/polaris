/**
 * tests/unit/probeLossQuery.test.ts — own unit suite (CQ-T010) for
 * src/services/probeLossQuery.ts. The query is raw SQL, so with no database
 * it is checked by its text and positional parameters: the engine / widget
 * split, the packet-vs-row counting, the rule-29h outage-run exclusion, and the
 * absence of the retired anchor. Real-SQL behaviour is
 * tests/integration/probeLossQuery.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { queryProbeLossRatios } from "../../src/services/probeLossQuery.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const raw = () => stubbed(prisma.$queryRawUnsafe);
const call = () => raw().mock.calls[0]! as unknown as [string, ...unknown[]];

beforeEach(() => {
  resetDbStub();
  raw().mockResolvedValue([]);
});

describe("queryProbeLossRatios — parameters", () => {
  it("binds only the window (as a string) in engine mode", async () => {
    await queryProbeLossRatios({ sinceMinutes: 15 });
    const [sql, ...params] = call();
    expect(params).toEqual(["15"]);
    expect(sql).toContain(`"timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval`);
    expect(sql).not.toContain("$2");
  });

  it("narrows to asset ids as $2", async () => {
    await queryProbeLossRatios({ sinceMinutes: 30, assetIds: ["a", "b"] });
    const [sql, ...params] = call();
    expect(params).toEqual(["30", ["a", "b"]]);
    expect(sql).toContain(`AND "assetId" = ANY($2::text[])`);
  });

  it("treats assetIds: null like no filter, and still binds an empty list", async () => {
    await queryProbeLossRatios({ sinceMinutes: 5, assetIds: null });
    expect(call().slice(1)).toEqual(["5"]);
    raw().mockClear();
    await queryProbeLossRatios({ sinceMinutes: 5, assetIds: [] });
    expect(call().slice(1)).toEqual(["5", []]);
  });

  it("binds the widget limit after the ids, and null (LIMIT ALL) when uncapped", async () => {
    await queryProbeLossRatios({ sinceMinutes: 15, assetIds: ["a"], onlyLossy: true, limit: 10 });
    expect(call().slice(1)).toEqual(["15", ["a"], 10]);
    expect(call()[0]).toContain("LIMIT $3");
    raw().mockClear();
    await queryProbeLossRatios({ sinceMinutes: 15, onlyLossy: true });
    expect(call().slice(1)).toEqual(["15", null]);
    expect(call()[0]).toContain("LIMIT $2");
  });

  it("ignores limit outside widget mode", async () => {
    await queryProbeLossRatios({ sinceMinutes: 15, onlyLossy: false, limit: 5 });
    expect(call().slice(1)).toEqual(["15"]);
    expect(call()[0]).not.toContain("LIMIT");
  });

  it("returns the driver's rows unchanged", async () => {
    const rows = [{ assetId: "a", total: 10n, failed: 2n }];
    raw().mockResolvedValueOnce(rows);
    expect(await queryProbeLossRatios({ sinceMinutes: 15 })).toBe(rows);
  });

  it("propagates a failed query", async () => {
    raw().mockRejectedValueOnce(new Error("db down"));
    await expect(queryProbeLossRatios({ sinceMinutes: 15 })).rejects.toThrow("db down");
  });
});

describe("queryProbeLossRatios — engine vs widget", () => {
  it("engine mode keeps 0%-loss rows: no HAVING, no ORDER BY, no LIMIT", async () => {
    await queryProbeLossRatios({ sinceMinutes: 15 });
    const sql = call()[0];
    expect(sql).not.toContain("HAVING");
    expect(sql).not.toContain("ORDER BY 1 -");
    expect(sql).not.toContain("LIMIT");
  });

  it("widget mode asks for loss of the EFFECTIVE counts and orders lossiest first", async () => {
    await queryProbeLossRatios({ sinceMinutes: 15, onlyLossy: true, limit: 5 });
    const sql = call()[0];
    expect(sql).toMatch(/HAVING \(CASE WHEN .* THEN sum\("packetsSent"\) ELSE count\(\*\) END\) > \(CASE WHEN/);
    expect(sql).toMatch(/ORDER BY 1 - \(CASE WHEN [\s\S]*\)::float \/ NULLIF\(\(CASE WHEN [\s\S]*\), 0\) DESC/);
  });

  it("does not ask for >= 1 failed ROW (a burst-lossy device has none)", async () => {
    await queryProbeLossRatios({ sinceMinutes: 15, onlyLossy: true });
    expect(call()[0]).not.toMatch(/FILTER \(WHERE NOT "success"\) >= 1/);
  });
});

describe("queryProbeLossRatios — what is counted", () => {
  beforeEach(async () => {
    await queryProbeLossRatios({ sinceMinutes: 15 });
  });

  it("counts packets when the asset has burst rows, else rows", () => {
    const sql = call()[0];
    expect(sql).toContain(`count(*) FILTER (WHERE "packetsSent" IS NOT NULL) > 0`);
    expect(sql).toContain(`THEN sum("packetsSent") ELSE count(*) END`);
    expect(sql).toContain(`THEN coalesce(sum("packetsReceived"), 0) ELSE count(*) FILTER (WHERE "success") END`);
  });

  it("returns total = effective sent and failed = sent - received, grouped per asset", () => {
    const sql = call()[0];
    expect(sql).toMatch(/SELECT "assetId", \(CASE WHEN [\s\S]*?\) AS total, \(CASE WHEN [\s\S]*?\) - \(CASE WHEN [\s\S]*?\) AS failed/);
    expect(sql).toContain(`GROUP BY "assetId"`);
  });

  it("counts every probeKind (no probeKind filter)", () => {
    expect(call()[0]).not.toContain("probeKind");
  });

  it("reads only asset_monitor_samples", () => {
    const sql = call()[0];
    expect(sql).toContain(`FROM "asset_monitor_samples"`);
    expect(sql).not.toMatch(/FROM "assets"|JOIN/);
  });

  it("reconstructs failure runs with ROWS framing ordered by timestamp then id", () => {
    expect(call()[0]).toContain(
      `sum(CASE WHEN "success" THEN 1 ELSE 0 END) OVER (
             PARTITION BY "assetId" ORDER BY "timestamp", "id"
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "runId"`,
    );
  });

  it("marks a run as an outage if ANY row in it is stamped, coalescing NULL to false", () => {
    expect(call()[0]).toContain(`coalesce(bool_or("assetDown") OVER (PARTITION BY "assetId", "runId"), false) AS "runOutage"`);
  });

  it("drops only the FAILURES of an outage run (the answered probe that opens it stays)", () => {
    expect(call()[0]).toContain(`WHERE NOT ("runOutage" AND NOT "success")`);
  });

  it("has no anchor or trim (firstOk / GREATEST / recoveryStartedAt are gone)", () => {
    const sql = call()[0];
    expect(sql).not.toContain("firstOk");
    expect(sql).not.toContain("GREATEST");
    expect(sql).not.toContain("recoveryStartedAt");
    expect(sql).not.toContain("LEFT JOIN");
  });

  it("anchors the window to UTC wall clock, never a bare now()", () => {
    expect(call()[0]).not.toMatch(/now\(\)(?! AT TIME ZONE 'UTC')/);
  });

  // Suspicious, not pinned: the file header (and the change-impact "Used by"
  // line) still say engine mode keeps only assets with ≥ 1 successful probe and
  // drops fully-down ones, but the SQL has no such HAVING — the newer
  // invariant ("includeFullyDown is RETIRED … a dark asset reads 100%") is
  // what the code does. An unstamped all-failure asset therefore IS returned.
  it("does not require a successful probe in engine mode", () => {
    expect(call()[0]).not.toMatch(/FILTER \(WHERE "success"\) (>=|>) /);
  });
});
