/**
 * tests/unit/sampleRetentionService.test.ts — own unit suite (CQ-T010) for
 * src/services/sampleRetentionService.ts: the two pure prune-window helpers,
 * the stored-blob parse / partial-PUT merge, the 5-second cache, and the flat
 * window getters. Prisma is the shared stub.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import {
  defaultSampleRetention,
  getAppMapConnectionRetentionDays,
  getArpEntryRetentionDays,
  getSampleRetention,
  invalidateSampleRetentionCache,
  tieredPruneWindow,
  unselectedSlowPruneWindow,
  updateSampleRetention,
  FLAT_RETENTION_ENTITIES,
  FOREVER,
  RETENTION_ENTITIES,
  SELECTION_AWARE_ENTITIES,
  UNSELECTED_DETAIL_HOURS,
} from "../../src/services/sampleRetentionService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const findUnique = () => stubbed(prisma.setting.findUnique);
const upsert = () => stubbed(prisma.setting.upsert);

beforeEach(() => {
  resetDbStub();
  invalidateSampleRetentionCache();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("constants and entity lists", () => {
  it("encodes keep-forever as -1 and unselected detail as a fixed 24 h", () => {
    expect(FOREVER).toBe(-1);
    expect(UNSELECTED_DETAIL_HOURS).toBe(24);
  });

  it("lists nine tiered entities, three flat ones, and three selection-aware ones (a subset)", () => {
    expect(RETENTION_ENTITIES).toHaveLength(9);
    expect(new Set(RETENTION_ENTITIES).size).toBe(9);
    expect(FLAT_RETENTION_ENTITIES).toEqual(["appMapConnections", "arpEntries", "pathCheckTraceroutes"]);
    expect(SELECTION_AWARE_ENTITIES).toEqual(["interfaces", "storage", "ipsec"]);
    for (const e of SELECTION_AWARE_ENTITIES) expect(RETENTION_ENTITIES).toContain(e);
  });
});

describe("unselectedSlowPruneWindow", () => {
  it("deletes slow rows older than 24 h, bounded below at the compression frontier", () => {
    const w = unselectedSlowPruneWindow(NOW, 2);
    expect(w.lt.getTime()).toBe(NOW - 24 * HOUR);
    expect(w.gte?.getTime()).toBe(NOW - 2 * DAY);
  });

  it("is unbounded when compression is off", () => {
    expect(unselectedSlowPruneWindow(NOW, 0).gte).toBeNull();
    expect(unselectedSlowPruneWindow(NOW, -3).gte).toBeNull();
  });

  it("is unbounded when the frontier is not strictly older than the 24 h cutoff (would empty the window)", () => {
    expect(unselectedSlowPruneWindow(NOW, 1).gte).toBeNull();
    expect(unselectedSlowPruneWindow(NOW, 0.5).gte).toBeNull();
  });

  it("bounds just past one day", () => {
    const w = unselectedSlowPruneWindow(NOW, 1.5);
    expect(w.gte?.getTime()).toBe(NOW - 1.5 * DAY);
    expect(w.gte!.getTime()).toBeLessThan(w.lt.getTime());
  });
});

describe("tieredPruneWindow", () => {
  it("skips the row-DELETE when the whole delete set is past the frontier (the rollup case)", () => {
    const w = tieredPruneWindow(NOW, 30, 7);
    expect(w).toEqual({ cutoff: new Date(NOW - 30 * DAY), gte: null, skipRowDelete: true });
  });

  it("skips when cutoff and frontier coincide", () => {
    expect(tieredPruneWindow(NOW, 7, 7).skipRowDelete).toBe(true);
  });

  it("bounds the DELETE to [frontier, cutoff) when retention is shorter than compress-after", () => {
    const w = tieredPruneWindow(NOW, 3, 7);
    expect(w.cutoff.getTime()).toBe(NOW - 3 * DAY);
    expect(w.gte?.getTime()).toBe(NOW - 7 * DAY);
    expect(w.skipRowDelete).toBe(false);
  });

  it("deletes all residue unbounded when compression is off", () => {
    expect(tieredPruneWindow(NOW, 30, 0)).toEqual({ cutoff: new Date(NOW - 30 * DAY), gte: null, skipRowDelete: false });
  });

  it("treats retention 0 (tier off) as a cutoff of now", () => {
    expect(tieredPruneWindow(NOW, 0, 0).cutoff.getTime()).toBe(NOW);
    const w = tieredPruneWindow(NOW, 0, 7);
    expect(w.cutoff.getTime()).toBe(NOW);
    expect(w.gte?.getTime()).toBe(NOW - 7 * DAY);
  });
});

describe("defaultSampleRetention", () => {
  it("is 7 / 30 / 365 for every tiered entity and 30 days for every flat one", () => {
    const d = defaultSampleRetention();
    for (const e of RETENTION_ENTITIES) expect(d[e]).toEqual({ detail: 7, hourly: 30, daily: 365 });
    for (const e of FLAT_RETENTION_ENTITIES) expect(d[e]).toEqual({ days: 30 });
  });

  it("returns fresh objects each call", () => {
    const a = defaultSampleRetention();
    a.assets.detail = 99;
    expect(defaultSampleRetention().assets.detail).toBe(7);
  });

  it("seeds the Application Map window from POLARIS_PROCESS_CONN_RETENTION_DAYS (truncated)", () => {
    vi.stubEnv("POLARIS_PROCESS_CONN_RETENTION_DAYS", "12.9");
    expect(defaultSampleRetention().appMapConnections.days).toBe(12);
  });

  it("ignores a non-positive or non-numeric env seed", () => {
    vi.stubEnv("POLARIS_PROCESS_CONN_RETENTION_DAYS", "0");
    expect(defaultSampleRetention().appMapConnections.days).toBe(30);
    vi.stubEnv("POLARIS_PROCESS_CONN_RETENTION_DAYS", "abc");
    expect(defaultSampleRetention().appMapConnections.days).toBe(30);
    vi.stubEnv("POLARIS_PROCESS_CONN_RETENTION_DAYS", "-4");
    expect(defaultSampleRetention().appMapConnections.days).toBe(30);
  });
});

describe("getSampleRetention (parse)", () => {
  it("reads the sampleRetention Setting row", async () => {
    findUnique().mockResolvedValueOnce(null);
    await getSampleRetention();
    expect(findUnique().mock.calls[0]![0]).toEqual({ where: { key: "sampleRetention" } });
  });

  it("returns the defaults when there is no row, or the value is not an object", async () => {
    findUnique().mockResolvedValueOnce(null);
    expect(await getSampleRetention()).toEqual(defaultSampleRetention());
    invalidateSampleRetentionCache();
    findUnique().mockResolvedValueOnce({ key: "sampleRetention", value: "garbage" });
    expect(await getSampleRetention()).toEqual(defaultSampleRetention());
  });

  it("keeps 0 (off), FOREVER, and positive values; truncates fractions; coerces numeric strings", async () => {
    findUnique().mockResolvedValueOnce({
      value: { assets: { detail: 0, hourly: FOREVER, daily: 400.9 }, cpuMem: { detail: "14", hourly: 30, daily: 365 } },
    });
    const r = await getSampleRetention();
    expect(r.assets).toEqual({ detail: 0, hourly: -1, daily: 400 });
    expect(r.cpuMem.detail).toBe(14);
  });

  it("falls back per field for NaN, Infinity, below -1, or missing; per entity for a non-object", async () => {
    findUnique().mockResolvedValueOnce({
      value: {
        assets: { detail: "x", hourly: -2, daily: Number.POSITIVE_INFINITY },
        storage: { detail: 3 },
        ipsec: 5,
        arpEntries: { days: -9 },
        appMapConnections: "nope",
        pathCheckTraceroutes: { days: FOREVER },
      },
    });
    const r = await getSampleRetention();
    expect(r.assets).toEqual({ detail: 7, hourly: 30, daily: 365 });
    expect(r.storage).toEqual({ detail: 3, hourly: 30, daily: 365 });
    expect(r.ipsec).toEqual({ detail: 7, hourly: 30, daily: 365 });
    expect(r.arpEntries).toEqual({ days: 30 });
    expect(r.appMapConnections).toEqual({ days: 30 });
    expect(r.pathCheckTraceroutes).toEqual({ days: -1 });
  });

  it("drops unknown keys from the stored blob", async () => {
    findUnique().mockResolvedValueOnce({ value: { bogus: { detail: 1 }, assets: { detail: 2 } } });
    const r = await getSampleRetention() as unknown as Record<string, unknown>;
    expect(r.bogus).toBeUndefined();
    expect(Object.keys(r).sort()).toEqual([...RETENTION_ENTITIES, ...FLAT_RETENTION_ENTITIES].sort());
  });
});

describe("getSampleRetention (cache)", () => {
  it("serves repeat reads within 5 s from memory, then re-reads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    findUnique().mockResolvedValue({ value: { assets: { detail: 2 } } });
    await getSampleRetention();
    vi.setSystemTime(NOW + 4999);
    await getSampleRetention();
    expect(findUnique()).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 5000);
    await getSampleRetention();
    expect(findUnique()).toHaveBeenCalledTimes(2);
  });

  // Was a bug until 2026-11-16: the cached object was returned by reference, so a caller's mutation leaked to every reader.
  it("returns a copy, so mutating a result does not change the cached value", async () => {
    findUnique().mockResolvedValue({ value: { assets: { detail: 2 } } });
    const first = await getSampleRetention();
    first.assets.detail = 99;
    const second = await getSampleRetention();
    expect(findUnique()).toHaveBeenCalledTimes(1);
    expect(second.assets.detail).toBe(2);
    expect(second).not.toBe(first);
  });

  it("re-reads after invalidateSampleRetentionCache", async () => {
    findUnique().mockResolvedValue(null);
    await getSampleRetention();
    invalidateSampleRetentionCache();
    await getSampleRetention();
    expect(findUnique()).toHaveBeenCalledTimes(2);
  });

  it("propagates a failed read and caches nothing", async () => {
    findUnique().mockRejectedValueOnce(new Error("db down"));
    await expect(getSampleRetention()).rejects.toThrow("db down");
    findUnique().mockResolvedValueOnce(null);
    expect(await getSampleRetention()).toEqual(defaultSampleRetention());
  });
});

describe("updateSampleRetention", () => {
  it("merges a partial PUT over the stored value and upserts the whole policy", async () => {
    findUnique().mockResolvedValueOnce({ value: { assets: { detail: 3, hourly: 10, daily: 100 } } });
    upsert().mockResolvedValueOnce({});
    const out = await updateSampleRetention({ assets: { hourly: 20 } as never, arpEntries: { days: 7 } });
    expect(out.assets).toEqual({ detail: 3, hourly: 20, daily: 100 });
    expect(out.arpEntries).toEqual({ days: 7 });
    expect(out.cpuMem).toEqual({ detail: 7, hourly: 30, daily: 365 });
    const arg = upsert().mock.calls[0]![0];
    expect(arg.where).toEqual({ key: "sampleRetention" });
    expect(arg.update).toEqual({ value: out });
    expect(arg.create).toEqual({ key: "sampleRetention", value: out });
  });

  it("keeps the stored value for garbage, below -1, or non-object entity input", async () => {
    findUnique().mockResolvedValueOnce({ value: { storage: { detail: 4, hourly: 40, daily: 400 } } });
    upsert().mockResolvedValueOnce({});
    const out = await updateSampleRetention({ storage: { detail: "x", hourly: -5, daily: 0 }, ipsec: 9, appMapConnections: "y" });
    expect(out.storage).toEqual({ detail: 4, hourly: 40, daily: 0 });
    expect(out.ipsec).toEqual({ detail: 7, hourly: 30, daily: 365 });
    expect(out.appMapConnections).toEqual({ days: 30 });
  });

  it("accepts FOREVER and 0, and an explicit null field keeps the current value", async () => {
    findUnique().mockResolvedValueOnce(null);
    upsert().mockResolvedValueOnce({});
    const out = await updateSampleRetention({ hardware: { detail: FOREVER, hourly: 0, daily: null }, pathCheckTraceroutes: { days: null } });
    expect(out.hardware).toEqual({ detail: -1, hourly: 0, daily: 365 });
    expect(out.pathCheckTraceroutes).toEqual({ days: 30 });
  });

  it("invalidates the cache so the next read sees the write", async () => {
    findUnique().mockResolvedValue(null);
    upsert().mockResolvedValueOnce({});
    await getSampleRetention();
    await updateSampleRetention({});
    await getSampleRetention();
    // initial read (cached) + update's read (cache hit, no query) + post-write read.
    expect(findUnique()).toHaveBeenCalledTimes(2);
  });

  it("propagates an upsert failure", async () => {
    findUnique().mockResolvedValueOnce(null);
    upsert().mockRejectedValueOnce(new Error("write failed"));
    await expect(updateSampleRetention({})).rejects.toThrow("write failed");
  });
});

describe("flat window getters", () => {
  it("returns the stored Application Map and ARP windows", async () => {
    findUnique().mockResolvedValue({ value: { appMapConnections: { days: 14 }, arpEntries: { days: FOREVER } } });
    expect(await getAppMapConnectionRetentionDays()).toBe(14);
    expect(await getArpEntryRetentionDays()).toBe(-1);
  });

  it("returns 0 (prune everything) as stored", async () => {
    findUnique().mockResolvedValue({ value: { arpEntries: { days: 0 } } });
    expect(await getArpEntryRetentionDays()).toBe(0);
  });
});
