/**
 * tests/unit/probePatchChunking.test.ts
 *
 * Efficiency audit 2026-11-13: the probe-state flush binds 16 parameters per
 * asset, and Postgres refuses a statement over 65,535. One statement for the
 * whole buffer failed for good above ~4,095 assets and, re-queued, failed
 * again every tick. It is now one statement per 3,000 rows, and a failure
 * re-queues only what was not written.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as number[], failOn: 0 }));
vi.mock("../../src/db.js", () => ({
  prisma: {
    $executeRawUnsafe: vi.fn(async (_sql: string, ...params: unknown[]) => {
      h.calls.push(params.length / 16);
      if (h.failOn && h.calls.length === h.failOn) throw new Error("connection refused");
      return 0;
    }),
  },
}));

import { enqueueProbePatch, flushProbePatchBuffer, __test__ } from "../../src/services/probePatchBuffer.js";

const patch = () => ({ monitorStatus: "up", lastMonitorAt: new Date(), lastResponseTimeMs: 2, consecutiveFailures: 0, consecutiveSuccesses: 1 }) as never;

beforeEach(() => {
  __test__.reset();
  h.calls = [];
  h.failOn = 0;
});

describe("probe-state flush is chunked under the bind-parameter limit", () => {
  it("writes 4,999 assets (past the old ~4,095 ceiling, under the 5,000 auto-flush) as statements of at most 3,000 rows", async () => {
    for (let i = 0; i < 4999; i++) enqueueProbePatch(`a${i}`, patch());
    await flushProbePatchBuffer();
    expect(h.calls).toEqual([3000, 1999]);
    expect(h.calls.every((n) => n * 16 <= 65535)).toBe(true);
  });

  it("re-queues only the rows of the chunks that were not written", async () => {
    h.failOn = 2;
    for (let i = 0; i < 4999; i++) enqueueProbePatch(`a${i}`, patch());
    await flushProbePatchBuffer();
    expect(__test__.getBufferDepth()).toBe(1999);
  });
});
