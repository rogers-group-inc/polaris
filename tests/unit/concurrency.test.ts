/**
 * tests/unit/concurrency.test.ts — the shared bounded-concurrency mapper
 * (utils/concurrency.ts): input-order results, the in-flight cap actually
 * held, Promise.all-style rejection, and the settled variant's
 * never-rejects contract.
 */

import { describe, it, expect } from "vitest";
import { mapWithConcurrency, mapSettledWithConcurrency } from "../../src/utils/concurrency.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

describe("mapWithConcurrency", () => {
  it("returns results in input order regardless of completion order", async () => {
    const out = await mapWithConcurrency([30, 5, 15], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms * 2;
    });
    expect(out).toEqual([60, 10, 30]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // and it genuinely ran in parallel
  });

  it("handles empty input and a limit larger than the list", async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 100, async (n) => n + 1)).toEqual([2, 3]);
  });

  it("rejects when fn rejects (Promise.all semantics)", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("starts no further items after the first rejection (in-flight ones finish)", async () => {
    const started: number[] = [];
    let finishedInFlight = false;
    const p = mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 2, async (n) => {
      started.push(n);
      if (n === 0) { await tick(); throw new Error("boom"); }
      if (n === 1) { await new Promise((r) => setTimeout(r, 20)); finishedInFlight = true; }
      return n;
    });
    await expect(p).rejects.toThrow("boom");
    await new Promise((r) => setTimeout(r, 40));
    // 0 failed and 1 was in flight; nothing after them was started.
    expect(started).toEqual([0, 1]);
    expect(finishedInFlight).toBe(true);
  });

  it("settle-all variant keeps going past a rejection", async () => {
    const started: number[] = [];
    await mapSettledWithConcurrency([0, 1, 2, 3], 2, async (n) => {
      started.push(n);
      if (n === 0) throw new Error("boom");
      return n;
    });
    expect(started.sort()).toEqual([0, 1, 2, 3]);
  });
});

describe("mapSettledWithConcurrency", () => {
  it("captures rejections in place and keeps input order", async () => {
    const out = await mapSettledWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("nope");
      return n * 10;
    });
    expect(out[0]).toEqual({ status: "fulfilled", value: 10 });
    expect(out[1].status).toBe("rejected");
    expect((out[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(out[2]).toEqual({ status: "fulfilled", value: 30 });
  });
});
