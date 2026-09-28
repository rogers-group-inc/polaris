/**
 * tests/unit/inventoryDelta.test.ts — the pure half of the service / process
 * inventory delta write (src/utils/inventoryDelta.ts): the split into create /
 * update / remove, the field equality it compares with, and the rounding that
 * keeps a jittering CPU or memory figure from marking every row changed.
 */

import { describe, it, expect } from "vitest";
import {
  bytesWithinBand, cpuWithinBand, diffInventory, normalizeBytes, normalizeCpuPct, sameFields, sameInventoryRow, sameValue,
} from "../../src/utils/inventoryDelta.js";

describe("normalizeCpuPct", () => {
  it("rounds to the one decimal every surface prints", () => {
    expect(normalizeCpuPct(0.0333)).toBe(0);
    expect(normalizeCpuPct(0.05)).toBe(0.1);
    expect(normalizeCpuPct(184.249)).toBe(184.2);
    expect(normalizeCpuPct(null)).toBeNull();
    expect(normalizeCpuPct(Number.NaN)).toBeNull();
  });
});

describe("normalizeBytes", () => {
  it("keeps three significant figures, relative to the value", () => {
    expect(normalizeBytes(402_653_184n)).toBe(403_000_000n);
    expect(normalizeBytes(402_655_232n)).toBe(403_000_000n); // +2 KiB: same stored value
    expect(normalizeBytes(925_368_320n)).toBe(925_000_000n);
    expect(normalizeBytes(12_884_901_888n)).toBe(12_900_000_000n);
  });
  it("never flattens a small value to zero", () => {
    expect(normalizeBytes(184_320n)).toBe(184_000n);
    expect(normalizeBytes(999n)).toBe(999n);
    expect(normalizeBytes(0n)).toBe(0n);
    expect(normalizeBytes(null)).toBeNull();
  });
  it("rounds half up on the fourth digit", () => {
    expect(normalizeBytes(1_235_000n)).toBe(1_240_000n);
    expect(normalizeBytes(1_234_999n)).toBe(1_230_000n);
  });
});

describe("sameValue", () => {
  it("compares the way the columns store", () => {
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue(null, 0)).toBe(false);
    expect(sameValue(5n, 5n)).toBe(true);
    expect(sameValue(5n, 6n)).toBe(false);
    expect(sameValue(new Date(1000), new Date(1000))).toBe(true);
    expect(sameValue(new Date(1000), new Date(2000))).toBe(false);
    expect(sameValue("a", "a")).toBe(true);
    expect(sameValue(0.1, 0.1)).toBe(true);
    expect(sameValue(true, false)).toBe(false);
  });
});

describe("dead band", () => {
  it("CPU inside one point is the same reading; outside it, or null↔value, is not", () => {
    expect(cpuWithinBand(0, 0.4)).toBe(true);
    expect(cpuWithinBand(0.2, 1.1)).toBe(true);
    expect(cpuWithinBand(0.2, 1.2)).toBe(false);
    expect(cpuWithinBand(157.5, 15.7)).toBe(false);
    expect(cpuWithinBand(null, null)).toBe(true);
    expect(cpuWithinBand(null, 0)).toBe(false);
  });
  it("memory inside 2% is the same reading, relative to the stored value", () => {
    expect(bytesWithinBand(2_880_000_000n, 2_899_000_000n)).toBe(true); // +0.7%
    expect(bytesWithinBand(669_000_000n, 649_000_000n)).toBe(false); // −3%
    expect(bytesWithinBand(10n, 11n)).toBe(false);
    expect(bytesWithinBand(null, 1n)).toBe(false);
  });
  it("a row is the same only when the exact fields match AND both figures sit in their bands", () => {
    type R = { state: string; cpu: number | null; mem: bigint | null };
    const a: R = { state: "running", cpu: 0.2, mem: 100_000_000n };
    expect(sameInventoryRow<R>(a, { ...a, cpu: 0.9, mem: 101_000_000n }, ["state"], "cpu", "mem")).toBe(true);
    expect(sameInventoryRow<R>(a, { ...a, cpu: 1.5 }, ["state"], "cpu", "mem")).toBe(false);
    expect(sameInventoryRow<R>(a, { ...a, state: "stopped" }, ["state"], "cpu", "mem")).toBe(false);
  });
});

describe("diffInventory", () => {
  type Row = { k: string; v: number };
  const existing = [{ id: "1", k: "keep", v: 1 }, { id: "2", k: "change", v: 1 }, { id: "3", k: "gone", v: 1 }];
  const incoming: Row[] = [{ k: "keep", v: 1 }, { k: "change", v: 2 }, { k: "new", v: 1 }, { k: "new", v: 9 }];

  it("splits into create / update / remove / unchanged by key", () => {
    const d = diffInventory(existing, incoming, (r) => r.k, (e) => e.k, (e, n) => sameFields<Row>(e, n, ["v"]));
    expect(d.create).toEqual([{ k: "new", v: 1 }]); // the FIRST duplicate wins
    expect(d.update).toEqual([{ existing: existing[1], next: { k: "change", v: 2 } }]);
    expect(d.remove).toEqual([existing[2]]);
    expect(d.unchanged).toBe(1);
  });

  it("an empty incoming list removes everything; an empty table creates everything", () => {
    expect(diffInventory(existing, [] as Row[], (r) => r.k, (e) => e.k, () => true).remove).toHaveLength(3);
    expect(diffInventory([] as typeof existing, incoming, (r) => r.k, (e) => e.k, () => true).create).toHaveLength(3);
  });
});
