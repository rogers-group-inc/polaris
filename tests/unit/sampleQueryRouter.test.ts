/**
 * tests/unit/sampleQueryRouter.test.ts — which storage tier a chart history
 * query reads (CQ-T010).
 *
 * Contract: oldest-point-wins (only `since` matters), defaults 7 / 30 days,
 * a 5-minute grace on every boundary so a 7d / 30d preset never flips tier on
 * a clock race, FOREVER (-1) covers all history, 0 = tier off (the grace never
 * re-enables it), and bucketSeconds 0 / 3600 / 86400.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getSampleRetention } = vi.hoisted(() => ({ getSampleRetention: vi.fn() }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/sampleRetentionService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSampleRetention,
}));

import { pickSampleTier, pickSampleTierForAsset } from "../../src/services/sampleQueryRouter.js";
import { FOREVER } from "../../src/services/sampleRetentionService.js";

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const DAY = 86_400_000;
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms);

const DETAIL = { tier: "detail", bucketSeconds: 0 };
const HOURLY = { tier: "hourly", bucketSeconds: 3600 };
const DAILY = { tier: "daily", bucketSeconds: 86400 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  getSampleRetention.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("pickSampleTier — defaults (7 / 30 days)", () => {
  it("recent ranges read detail", () => {
    expect(pickSampleTier(ago(1 * 3600_000))).toEqual(DETAIL);
    expect(pickSampleTier(ago(6 * DAY))).toEqual(DETAIL);
  });

  it("the 7-day preset reads detail even when `since` was computed a little earlier", () => {
    expect(pickSampleTier(ago(7 * DAY))).toEqual(DETAIL);
    expect(pickSampleTier(ago(7 * DAY + 4 * MIN))).toEqual(DETAIL);
    expect(pickSampleTier(ago(7 * DAY + 5 * MIN))).toEqual(DETAIL); // exactly on the grace edge
  });

  it("past the grace drops to hourly", () => {
    expect(pickSampleTier(ago(7 * DAY + 5 * MIN + 1))).toEqual(HOURLY);
    expect(pickSampleTier(ago(20 * DAY))).toEqual(HOURLY);
  });

  it("the 30-day preset reads hourly within the grace, daily past it", () => {
    expect(pickSampleTier(ago(30 * DAY))).toEqual(HOURLY);
    expect(pickSampleTier(ago(30 * DAY + 5 * MIN))).toEqual(HOURLY);
    expect(pickSampleTier(ago(30 * DAY + 5 * MIN + 1))).toEqual(DAILY);
    expect(pickSampleTier(ago(365 * DAY))).toEqual(DAILY);
  });

  it("a `since` in the future reads detail", () => {
    expect(pickSampleTier(new Date(NOW + DAY))).toEqual(DETAIL);
  });
});

describe("pickSampleTier — configured retention", () => {
  it("honours custom windows", () => {
    const r = { detailDays: 2, hourlyDays: 90 };
    expect(pickSampleTier(ago(1 * DAY), r)).toEqual(DETAIL);
    expect(pickSampleTier(ago(3 * DAY), r)).toEqual(HOURLY);
    expect(pickSampleTier(ago(60 * DAY), r)).toEqual(HOURLY);
    expect(pickSampleTier(ago(91 * DAY), r)).toEqual(DAILY);
  });

  it("FOREVER detail covers every range", () => {
    expect(pickSampleTier(ago(10_000 * DAY), { detailDays: FOREVER, hourlyDays: 30 })).toEqual(DETAIL);
  });

  it("FOREVER hourly covers everything detail does not", () => {
    expect(pickSampleTier(ago(10_000 * DAY), { detailDays: 7, hourlyDays: FOREVER })).toEqual(HOURLY);
  });

  it("detail off (0) never reads detail — not even for the last minute (the grace never re-enables it)", () => {
    expect(pickSampleTier(ago(MIN), { detailDays: 0, hourlyDays: 30 })).toEqual(HOURLY);
    expect(pickSampleTier(new Date(NOW), { detailDays: 0, hourlyDays: 30 })).toEqual(HOURLY);
  });

  it("detail and hourly both off → daily", () => {
    expect(pickSampleTier(ago(MIN), { detailDays: 0, hourlyDays: 0 })).toEqual(DAILY);
  });

  it("hourly off falls straight from detail to daily", () => {
    expect(pickSampleTier(ago(8 * DAY), { detailDays: 7, hourlyDays: 0 })).toEqual(DAILY);
  });

  it("uses the clock at call time, not module load", () => {
    const since = ago(6 * DAY);
    expect(pickSampleTier(since)).toEqual(DETAIL);
    vi.setSystemTime(NOW + 2 * DAY);
    expect(pickSampleTier(since)).toEqual(HOURLY);
  });
});

describe("pickSampleTierForAsset", () => {
  it("reads the entity's configured windows and applies them", async () => {
    getSampleRetention.mockResolvedValue({
      interfaces: { detail: 1, hourly: 14 },
      cpuMem: { detail: 30, hourly: 365 },
    });
    expect(await pickSampleTierForAsset("a1", "interfaces" as never, ago(3 * DAY))).toEqual(HOURLY);
    expect(await pickSampleTierForAsset("a1", "cpuMem" as never, ago(3 * DAY))).toEqual(DETAIL);
    expect(await pickSampleTierForAsset("a1", "interfaces" as never, ago(20 * DAY))).toEqual(DAILY);
  });

  it("passes FOREVER and 0 through unchanged", async () => {
    getSampleRetention.mockResolvedValue({ storage: { detail: 0, hourly: FOREVER } });
    expect(await pickSampleTierForAsset("a1", "storage" as never, ago(MIN))).toEqual(HOURLY);
    expect(await pickSampleTierForAsset("a1", "storage" as never, ago(5000 * DAY))).toEqual(HOURLY);
  });

  it("the asset id does not affect the pick", async () => {
    getSampleRetention.mockResolvedValue({ assets: { detail: 7, hourly: 30 } });
    const a = await pickSampleTierForAsset("a1", "assets" as never, ago(10 * DAY));
    const b = await pickSampleTierForAsset("zzz", "assets" as never, ago(10 * DAY));
    expect(a).toEqual(b);
  });
});
