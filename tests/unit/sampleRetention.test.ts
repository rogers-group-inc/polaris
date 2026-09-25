/**
 * tests/unit/sampleRetention.test.ts
 *
 * Pure-logic coverage for the per-entity retention model and the tier router's
 * FOREVER/off encoding. DB-backed reads/writes (getSampleRetention /
 * updateSampleRetention) are not exercised here — only the pure functions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// sampleRetentionService imports prisma at module load; stub it so importing
// the pure helpers doesn't open a DB connection.
vi.mock("../../src/db.js", () => ({
  prisma: { setting: { findUnique: vi.fn(), upsert: vi.fn() } },
}));

import {
  defaultSampleRetention,
  getRetentionDays,
  getSampleRetention,
  updateSampleRetention,
  invalidateSampleRetentionCache,
  FOREVER,
  UNSELECTED_DETAIL_HOURS,
  RETENTION_ENTITIES,
  FLAT_RETENTION_ENTITIES,
  SELECTION_AWARE_ENTITIES,
} from "../../src/services/sampleRetentionService.js";
import { pickSampleTier } from "../../src/services/sampleQueryRouter.js";
import { prisma } from "../../src/db.js";

const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600 * 1000);

describe("sampleRetentionService — entity model + encoding", () => {
  it("exposes the nine entities, three of them selection-aware", () => {
    expect(RETENTION_ENTITIES).toEqual(["assets", "cpuMem", "hardware", "interfaces", "storage", "ipsec", "perfSla", "pathCheck", "process"]);
    expect(SELECTION_AWARE_ENTITIES).toEqual(["interfaces", "storage", "ipsec"]);
    expect(FOREVER).toBe(-1);
    expect(UNSELECTED_DETAIL_HOURS).toBe(24);
  });

  it("defaults every entity to 7/30/365", () => {
    const def = defaultSampleRetention();
    for (const e of RETENTION_ENTITIES) {
      expect(def[e]).toEqual({ detail: 7, hourly: 30, daily: 365 });
    }
  });

  it("getRetentionDays returns the stored value, including 0 (off) and FOREVER", () => {
    const r = defaultSampleRetention();
    r.interfaces = { detail: 3, hourly: 0, daily: FOREVER };
    expect(getRetentionDays(r, "interfaces", "detail")).toBe(3);
    expect(getRetentionDays(r, "interfaces", "hourly")).toBe(0);
    expect(getRetentionDays(r, "interfaces", "daily")).toBe(FOREVER);
  });

  it("exposes the FLAT entities, each defaulting to 30 days", () => {
    // Flat = one window instead of detail/hourly/daily, for the two
    // accumulate+age tables (Application Map sockets, ARP neighbour cache)
    // and the path-check traceroute snapshots — none of them tiered
    // time-series.
    expect(FLAT_RETENTION_ENTITIES).toEqual(["appMapConnections", "arpEntries", "pathCheckTraceroutes"]);
    expect(defaultSampleRetention().appMapConnections).toEqual({ days: 30 });
    expect(defaultSampleRetention().arpEntries).toEqual({ days: 30 });
    expect(defaultSampleRetention().pathCheckTraceroutes).toEqual({ days: 30 });
  });
});

// The flat window rides the same Setting row as the tiered entities, so parse /
// merge are exercised through the public read/write pair against a stubbed
// prisma. These are the paths that decide whether a pre-feature stored blob
// silently loses the key, or a partial PUT clobbers the other entities.
describe("sampleRetentionService — flat appMapConnections window", () => {
  const findUnique = prisma.setting.findUnique as unknown as ReturnType<typeof vi.fn>;
  const upsert = prisma.setting.upsert as unknown as ReturnType<typeof vi.fn>;

  const storedValue = () => upsert.mock.calls.at(-1)![0].update.value;

  beforeEach(() => {
    findUnique.mockReset();
    upsert.mockReset();
    upsert.mockResolvedValue({});
    invalidateSampleRetentionCache();
  });

  it("fills the default when a stored blob predates the key (no migration needed)", async () => {
    const legacy: Record<string, unknown> = {};
    for (const e of RETENTION_ENTITIES) legacy[e] = { detail: 3, hourly: 10, daily: 100 };
    findUnique.mockResolvedValue({ key: "sampleRetention", value: legacy });

    const r = await getSampleRetention();
    expect(r.appMapConnections).toEqual({ days: 30 });
    // ...without disturbing what WAS stored.
    expect(r.assets).toEqual({ detail: 3, hourly: 10, daily: 100 });
  });

  it("round-trips 0 (prune everything) and FOREVER through parse", async () => {
    for (const days of [0, FOREVER]) {
      invalidateSampleRetentionCache();
      findUnique.mockResolvedValue({ value: { appMapConnections: { days } } });
      expect((await getSampleRetention()).appMapConnections.days).toBe(days);
    }
  });

  it("keeps the existing value when a write sends garbage", async () => {
    findUnique.mockResolvedValue({ value: { appMapConnections: { days: 45 } } });
    await updateSampleRetention({ appMapConnections: { days: "nonsense" } } as never);
    expect(storedValue().appMapConnections).toEqual({ days: 45 });
  });

  it("a flat-only partial PUT persists it without dropping the tiered entities", async () => {
    findUnique.mockResolvedValue(null); // unseeded → defaults
    await updateSampleRetention({ appMapConnections: { days: 90 } });
    const v = storedValue();
    expect(v.appMapConnections).toEqual({ days: 90 });
    for (const e of RETENTION_ENTITIES) {
      expect(v[e]).toEqual({ detail: 7, hourly: 30, daily: 365 });
    }
  });

  it("a tiered-only partial PUT leaves the flat window alone", async () => {
    findUnique.mockResolvedValue({ value: { appMapConnections: { days: 14 } } });
    await updateSampleRetention({ assets: { detail: 2 } } as never);
    const v = storedValue();
    expect(v.appMapConnections).toEqual({ days: 14 });
    expect(v.assets.detail).toBe(2);
  });
});

describe("pickSampleTier — FOREVER / off encoding", () => {
  it("reads detail when the window is within detailDays", () => {
    expect(pickSampleTier(daysAgo(3), { detailDays: 7, hourlyDays: 30 }).tier).toBe("detail");
  });

  it("drops to hourly when older than detail but within hourly", () => {
    expect(pickSampleTier(daysAgo(10), { detailDays: 7, hourlyDays: 30 }).tier).toBe("hourly");
  });

  it("drops to daily when older than hourly", () => {
    expect(pickSampleTier(daysAgo(100), { detailDays: 7, hourlyDays: 30 }).tier).toBe("daily");
  });

  it("FOREVER detail always reads detail, however old the query", () => {
    expect(pickSampleTier(daysAgo(9999), { detailDays: FOREVER, hourlyDays: 30 }).tier).toBe("detail");
  });

  it("detail=0 (tier off) falls through to hourly even for recent queries", () => {
    expect(pickSampleTier(daysAgo(1), { detailDays: 0, hourlyDays: 30 }).tier).toBe("hourly");
  });

  it("detail=0 and hourly=0 falls all the way to daily", () => {
    expect(pickSampleTier(daysAgo(1), { detailDays: 0, hourlyDays: 0 }).tier).toBe("daily");
  });

  it("FOREVER hourly covers an old query when detail doesn't", () => {
    expect(pickSampleTier(daysAgo(50), { detailDays: 7, hourlyDays: FOREVER }).tier).toBe("hourly");
  });
});
