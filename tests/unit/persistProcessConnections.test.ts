/**
 * tests/unit/persistProcessConnections.test.ts
 *
 * Coverage for the Application Map accumulate+age upsert
 * (monitoringService.persistProcessConnections):
 *   - business-key dedup (duplicate tuples in one INSERT would raise
 *     "cannot affect row a second time" in Postgres)
 *   - sentinel normalization ("" / 0 for the fields a kind doesn't use)
 *   - per-(processName, kind) caps (200 listen / 500 outbound / 200 inbound)
 *   - invalid kind / proto / port rows dropped
 *   - churn-gate SQL shape (ON CONFLICT ... DO UPDATE ... WHERE lastSeen <)
 *   - unit backfill-on-conflict (empty adopts, non-empty is preserved)
 *   - empty / all-invalid input issues no DB call
 *
 * Prisma is mocked; assertions run against the raw SQL + params.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { persistProcessConnections } from "../../src/services/monitoringService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

type Mock = ReturnType<typeof vi.fn>;
const execRaw = prisma.$executeRawUnsafe as unknown as Mock;

const ASSET = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function lastCall(): { sql: string; params: unknown[] } {
  const call = execRaw.mock.calls.at(-1)!;
  return { sql: call[0] as string, params: call.slice(1) };
}

/** Rows-per-statement: params are 12 per tuple (id, assetId, processName, kind,
 *  proto, localAddr, localPort, remoteIp, remotePort, unit, firstSeen, lastSeen). */
function tupleCount(params: unknown[]): number {
  return params.length / 12;
}

beforeEach(() => {
  resetDbStub();
  stubbed(prisma.$executeRawUnsafe).mockImplementation(async () => 0);
});

beforeEach(() => {
  execRaw.mockClear();
});

describe("persistProcessConnections", () => {
  it("writes one tuple per distinct business key (dedup)", async () => {
    await persistProcessConnections(ASSET, [
      { processName: "nginx", kind: "outbound", proto: "tcp", remoteIp: "10.0.0.5", remotePort: 5432 },
      { processName: "nginx", kind: "outbound", proto: "tcp", remoteIp: "10.0.0.5", remotePort: 5432 },
      { processName: "nginx", kind: "outbound", proto: "tcp", remoteIp: "10.0.0.5", remotePort: 5433 },
    ]);
    expect(execRaw).toHaveBeenCalledTimes(1);
    expect(tupleCount(lastCall().params)).toBe(2);
  });

  it("normalizes missing fields to sentinels and uppercase enums to lowercase", async () => {
    await persistProcessConnections(ASSET, [
      { processName: "sqlservr", kind: "LISTEN" as never, proto: "TCP" as never, localAddr: "0.0.0.0", localPort: 1433 },
    ]);
    const { params } = lastCall();
    // tuple order: id, assetId, processName, kind, proto, localAddr, localPort, remoteIp, remotePort, unit, firstSeen, lastSeen
    expect(params[1]).toBe(ASSET);
    expect(params[2]).toBe("sqlservr");
    expect(params[3]).toBe("listen");
    expect(params[4]).toBe("tcp");
    expect(params[5]).toBe("0.0.0.0");
    expect(params[6]).toBe(1433);
    expect(params[7]).toBe("");   // remoteIp sentinel
    expect(params[8]).toBe(0);    // remotePort sentinel
    expect(params[9]).toBe("");   // unit sentinel (Phase 3) when not supplied
  });

  it("carries the owning unit (Phase 3) into the insert, defaulting to sentinel", async () => {
    await persistProcessConnections(ASSET, [
      { processName: "java", kind: "listen", proto: "tcp", localAddr: "0.0.0.0", localPort: 8080, unit: "truckscale-central.service" },
    ]);
    const { sql, params } = lastCall();
    expect(sql).toContain('"unit"');
    expect(params[9]).toBe("truckscale-central.service");
  });

  it("backfills an empty unit on conflict but never overwrites a non-empty one", async () => {
    await persistProcessConnections(ASSET, [
      { processName: "java", kind: "listen", proto: "tcp", localAddr: "0.0.0.0", localPort: 8080, unit: "myapp.service" },
    ]);
    const { sql } = lastCall();
    // A stored '' adopts EXCLUDED.unit; anything else keeps the stored value.
    expect(sql).toContain(
      `"unit" = CASE WHEN "asset_process_connections"."unit" = '' ` +
      `THEN EXCLUDED."unit" ELSE "asset_process_connections"."unit" END`,
    );
    // The backfill arm must be OR-ed onto the churn gate, otherwise a row bumped
    // inside the 5-minute window could never adopt its unit.
    expect(sql).toContain(`OR ("asset_process_connections"."unit" = '' AND EXCLUDED."unit" <> '')`);
  });

  it("drops invalid kind / proto / out-of-range ports / empty names", async () => {
    await persistProcessConnections(ASSET, [
      { processName: "x", kind: "sideways" as never, proto: "tcp" },
      { processName: "x", kind: "listen", proto: "icmp" as never },
      { processName: "x", kind: "listen", proto: "tcp", localPort: 70000 },
      { processName: "  ", kind: "listen", proto: "tcp", localPort: 80 },
    ]);
    expect(execRaw).not.toHaveBeenCalled();
  });

  it("caps outbound rows at 500 per (process, kind) deterministically", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({
      processName: "java",
      kind: "outbound" as const,
      proto: "tcp" as const,
      remoteIp: `10.1.${Math.floor(i / 250)}.${i % 250}`,
      remotePort: 8000 + i,
    }));
    await persistProcessConnections(ASSET, rows);
    expect(tupleCount(lastCall().params)).toBe(500);
  });

  it("caps listen and inbound at 200 each, per process independently", async () => {
    const rows = [
      ...Array.from({ length: 250 }, (_, i) => ({
        processName: "nginx", kind: "listen" as const, proto: "tcp" as const, localAddr: "::", localPort: 1000 + i,
      })),
      ...Array.from({ length: 250 }, (_, i) => ({
        processName: "nginx", kind: "inbound" as const, proto: "tcp" as const, remoteIp: `10.9.0.${i % 250}`, localPort: 443,
      })),
      ...Array.from({ length: 50 }, (_, i) => ({
        processName: "redis", kind: "listen" as const, proto: "tcp" as const, localAddr: "::", localPort: 2000 + i,
      })),
    ];
    // inbound rows above collide on the business key past i=249? No — remoteIp
    // varies 0..249, all distinct; 250 in, 200 kept.
    await persistProcessConnections(ASSET, rows);
    expect(tupleCount(lastCall().params)).toBe(200 + 200 + 50);
  });

  it("emits the accumulate+age upsert with the churn-gated lastSeen bump", async () => {
    await persistProcessConnections(ASSET, [
      { processName: "nginx", kind: "listen", proto: "tcp", localAddr: "0.0.0.0", localPort: 443 },
    ]);
    const { sql } = lastCall();
    expect(sql).toContain('INSERT INTO "asset_process_connections"');
    expect(sql).toContain('ON CONFLICT ("assetId", "processName", "kind", "proto", "localAddr", "localPort", "remoteIp", "remotePort")');
    // GREATEST, not a bare assignment: the unit-backfill arm can fire on a row
    // whose stored lastSeen is NEWER than this push, and must not move it back.
    expect(sql).toContain('DO UPDATE SET "lastSeen" = GREATEST("asset_process_connections"."lastSeen", EXCLUDED."lastSeen")');
    expect(sql).toMatch(/WHERE "asset_process_connections"\."lastSeen" < EXCLUDED\."lastSeen" - interval '\d+ minutes'/);
    // firstSeen must NOT be overwritten on conflict.
    expect(sql).not.toContain('"firstSeen" = EXCLUDED');
  });

  it("no-ops on empty input", async () => {
    await persistProcessConnections(ASSET, []);
    expect(execRaw).not.toHaveBeenCalled();
  });
});
