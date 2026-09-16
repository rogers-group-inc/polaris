/**
 * tests/unit/manufacturerProfileCache.test.ts — the warm copy of the profile
 * rows every process reads, and how a monitor process learns it went stale.
 *
 * Since the Phase 4 resolver swap these rows are the ONLY source of vendor
 * CPU / memory / temperature / storage OIDs, which makes two properties of
 * this cache load-bearing in a way they were not before:
 *
 *   - An operator edits a profile on the WEB process. Its write paths refresh
 *     the cache of the process that served the write, and nothing tells the
 *     MONITOR process — which on a split-role install is the one that walks
 *     devices. `refreshProfileCacheIfStale` is what the heavy tick calls, so
 *     its TTL is what decides how long a corrected OID goes unused.
 *   - A refresh that cannot reach the database must not fail the pass. The
 *     previous copy is a better answer than an empty one: stale vendor OIDs
 *     collect, an empty cache collects nothing.
 *
 * `listCachedProfiles` is pinned here too because it sits on the per-asset
 * probe path: the resolver reaches it for every asset whose manufacturer has
 * no profile, which on most fleets is most assets.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  findManyCalls: 0,
  findManyErr: null as Error | null,
}));

function dbProfile(manufacturer: string, matchPattern: string | null = null) {
  return {
    id: `p-${manufacturer}`,
    manufacturer,
    matchPattern,
    createdBy: "system:seed",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    metrics: [],
    widgets: [],
  };
}

vi.mock("../../src/db.js", () => ({
  prisma: {
    manufacturerProfile: {
      findMany: vi.fn(async () => {
        h.findManyCalls++;
        if (h.findManyErr) throw h.findManyErr;
        return h.rows;
      }),
    },
    mibFile: { findMany: vi.fn(async () => []) },
  },
}));

const {
  refreshProfileCache,
  refreshProfileCacheIfStale,
  listCachedProfiles,
  getProfileFor,
} = await import("../../src/services/manufacturerProfileService.js");

beforeEach(() => {
  vi.clearAllMocks();
  h.findManyCalls = 0;
  h.findManyErr = null;
  h.rows = [dbProfile("Juniper"), dbProfile("Cisco", "cisco|ios-?xe"), dbProfile("Fortinet")];
});

describe("listCachedProfiles", () => {
  it("is empty before the cache warms — the same 'no opinion' the keyed getter reports", async () => {
    // A fresh process that has not warmed yet must not look like a process
    // whose operator deleted every profile; both answer nothing, and the
    // resolver treats nothing as "no vendor opinion" either way. A reset
    // gives this test the module in its boot state; the others share the
    // warmed one.
    vi.resetModules();
    const cold = await import("../../src/services/manufacturerProfileService.js");
    expect(cold.listCachedProfiles()).toEqual([]);
    expect(cold.getProfileFor("Cisco")).toBeNull();
    vi.resetModules();
  });

  it("sorts by manufacturer, so two matching patterns resolve the same way on every restart", async () => {
    // findMany returns rows in no guaranteed order; the resolver walks this
    // list in order when it falls back to matchPattern, so an unsorted list
    // would make which profile claims an asset depend on the DB's mood.
    await refreshProfileCache();
    expect(listCachedProfiles().map((p) => p.manufacturer)).toEqual(["Cisco", "Fortinet", "Juniper"]);
  });

  it("builds the sorted array once per refresh, not once per call", async () => {
    // It is on the per-asset probe path at 2000 assets. Identity is the
    // assertion that it was not rebuilt.
    await refreshProfileCache();
    const first = listCachedProfiles();
    expect(listCachedProfiles()).toBe(first);

    await refreshProfileCache();
    expect(listCachedProfiles()).not.toBe(first);
    expect(listCachedProfiles().map((p) => p.manufacturer)).toEqual(["Cisco", "Fortinet", "Juniper"]);
  });
});

describe("refreshProfileCacheIfStale — how a monitor process learns of an edit", () => {
  it("does nothing while the copy is fresh, and re-reads once it is not", async () => {
    const t0 = 1_000_000;
    await refreshProfileCache();
    const after = h.findManyCalls;

    expect(await refreshProfileCacheIfStale(t0)).toBe(false);
    expect(await refreshProfileCacheIfStale(t0 + 59_000)).toBe(false);
    expect(h.findManyCalls).toBe(after);

    // The TTL is 60s — two heavy ticks, so the DB sees one small read per
    // minute per monitor process rather than one per tick.
    expect(await refreshProfileCacheIfStale(Date.now() + 61_000)).toBe(true);
    expect(h.findManyCalls).toBe(after + 1);
  });

  it("picks up a profile added since the last read", async () => {
    await refreshProfileCache();
    expect(getProfileFor("Aruba")).toBeNull();

    h.rows = [...h.rows, dbProfile("Aruba", "aruba|hpe")];
    await refreshProfileCacheIfStale(Date.now() + 61_000);
    expect(getProfileFor("Aruba")?.matchPattern).toBe("aruba|hpe");
  });

  it("keeps the previous copy when the database is unreachable, and does not throw", async () => {
    // A monitor pass must not fail because a refresh could not reach the DB.
    await refreshProfileCache();
    const before = listCachedProfiles().map((p) => p.manufacturer);

    h.findManyErr = new Error("connection terminated");
    await expect(refreshProfileCacheIfStale(Date.now() + 61_000)).resolves.toBe(false);
    expect(listCachedProfiles().map((p) => p.manufacturer)).toEqual(before);
    expect(getProfileFor("Cisco")).not.toBeNull();
  });

  it("retries on the next tick after a failure rather than waiting out another TTL", async () => {
    // The failed attempt must not stamp the clock — otherwise one blip costs
    // a minute of collecting against whatever the cache last held.
    await refreshProfileCache();
    h.findManyErr = new Error("connection terminated");
    const late = Date.now() + 61_000;
    await refreshProfileCacheIfStale(late);

    h.findManyErr = null;
    const calls = h.findManyCalls;
    expect(await refreshProfileCacheIfStale(late + 1_000)).toBe(true);
    expect(h.findManyCalls).toBe(calls + 1);
  });
});
