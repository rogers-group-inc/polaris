/**
 * tests/unit/discoveryDurationService.test.ts
 *
 * Covers the pure threshold math, plus recordSample's write serialization
 * against an in-memory Setting row (the lost-update race needs overlapping
 * async reads, which a mocked prisma with a delay reproduces exactly).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({ value: null as unknown, failNextWrite: false }));

vi.mock("../../src/db.js", () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  return {
    prisma: {
      setting: {
        findUnique: async () => {
          await tick();
          return store.value === null ? null : { value: JSON.parse(JSON.stringify(store.value)) };
        },
        upsert: async (args: { update: { value: unknown } }) => {
          await tick();
          if (store.failNextWrite) {
            store.failNextWrite = false;
            throw new Error("db hiccup");
          }
          store.value = args.update.value;
          return {};
        },
      },
    },
  };
});

import { computeBaseline, recordSample, getBaseline } from "../../src/services/discoveryDurationService.js";

describe("recordSample", () => {
  beforeEach(() => {
    store.value = null;
    store.failNextWrite = false;
  });

  it("keeps every sample when parallel gates complete at once", async () => {
    // Five FortiGates finishing together — the discoveryParallelism default.
    // Unserialized, every write starts from the same empty read and only the
    // last one survives.
    const gates = ["A", "B", "C", "D", "E"];
    await Promise.all(gates.map((g, i) => recordSample(`int:${g}`, 1_000 * (i + 1))));
    const units = (store.value as { units: Record<string, { samples: number[] }> }).units;
    expect(Object.keys(units).sort()).toEqual(gates.map((g) => `int:${g}`));
    expect(units["int:C"]!.samples).toEqual([3_000]);
  });

  it("keeps every sample for one unit under concurrent writes", async () => {
    await Promise.all([10_000, 20_000, 30_000].map((ms) => recordSample("int:A", ms)));
    const bl = await getBaseline("int:A");
    expect(bl?.sampleCount).toBe(3);
    expect(bl?.avgMs).toBe(20_000);
  });

  it("a failed write does not block the writes queued behind it", async () => {
    store.failNextWrite = true;
    const first = recordSample("int:A", 1_000);
    const second = recordSample("int:B", 2_000);
    await expect(first).rejects.toThrow("db hiccup");
    await second;
    const units = (store.value as { units: Record<string, { samples: number[] }> }).units;
    expect(units["int:B"]!.samples).toEqual([2_000]);
  });
});

describe("computeBaseline", () => {
  it("returns null with fewer than 3 samples", () => {
    expect(computeBaseline([])).toBeNull();
    expect(computeBaseline([5_000])).toBeNull();
    expect(computeBaseline([5_000, 6_000])).toBeNull();
  });

  it("computes avg and stddev across samples", () => {
    const bl = computeBaseline([1_000, 2_000, 3_000])!;
    expect(bl.sampleCount).toBe(3);
    expect(bl.avgMs).toBe(2_000);
    // Population stddev of 1000,2000,3000 = sqrt((1e6+0+1e6)/3) ≈ 816.5
    expect(bl.stddevMs).toBeCloseTo(816.497, 1);
  });

  it("threshold is never below avg + 60s floor", () => {
    // Tight cluster: stddev near 0, avg * 1.5 = 1500 ms, floor wins.
    const bl = computeBaseline([1_000, 1_000, 1_000])!;
    expect(bl.stddevMs).toBe(0);
    expect(bl.thresholdMs).toBe(1_000 + 60_000);
  });

  it("threshold uses multiplier when it beats floor and stddev", () => {
    // avg = 200_000, stddev small, avg*1.5 = 300_000, avg+60s = 260_000.
    const bl = computeBaseline([200_000, 200_000, 200_000])!;
    expect(bl.thresholdMs).toBe(300_000);
  });

  it("threshold uses avg + 2σ when stddev dominates", () => {
    // Highly variable: avg=100s, stddev large enough that avg+2σ > avg*1.5 and > avg+60s.
    const samples = [10_000, 100_000, 190_000];
    const bl = computeBaseline(samples)!;
    expect(bl.avgMs).toBe(100_000);
    // Population stddev = sqrt(((90_000)^2 + 0 + (90_000)^2)/3) ≈ 73_485
    expect(bl.stddevMs).toBeCloseTo(73_484.7, 1);
    const twoSigma = bl.avgMs + 2 * bl.stddevMs; // ≈ 246_970
    const mult = bl.avgMs * 1.5;                 // 150_000
    const floor = bl.avgMs + 60_000;             // 160_000
    expect(bl.thresholdMs).toBeCloseTo(Math.max(twoSigma, mult, floor), 1);
    expect(bl.thresholdMs).toBeCloseTo(twoSigma, 1);
  });

  it("threshold is always strictly greater than avg", () => {
    // Floor of 60 s guarantees this even for zero-variance samples.
    for (const s of [[1], [1_000_000, 1_000_000, 1_000_000], [5, 5, 5]]) {
      const bl = computeBaseline(s);
      if (bl) expect(bl.thresholdMs).toBeGreaterThan(bl.avgMs);
    }
  });

  it("autoAbortMs is 2× avg when that clears the slow threshold", () => {
    // avg = 200_000 → threshold = 300_000 (×1.5 multiplier), 2× avg = 400_000.
    const bl = computeBaseline([200_000, 200_000, 200_000])!;
    expect(bl.autoAbortMs).toBe(400_000);
  });

  it("autoAbortMs never sits below the slow threshold", () => {
    // Tiny avg: 2× avg = 20 s but threshold = avg + 60 s floor = 70 s.
    // Aborting before the slow warning could even fire would be wrong.
    const bl = computeBaseline([10_000, 10_000, 10_000])!;
    expect(bl.thresholdMs).toBe(70_000);
    expect(bl.autoAbortMs).toBe(70_000);
    // High variance: avg+2σ dominates 2× avg.
    const noisy = computeBaseline([10_000, 100_000, 190_000])!;
    expect(noisy.autoAbortMs).toBe(noisy.thresholdMs);
    expect(noisy.autoAbortMs).toBeGreaterThan(noisy.avgMs * 2);
  });
});
