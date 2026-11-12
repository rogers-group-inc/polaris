/**
 * tests/unit/downDetectionCache.test.ts — the HOT-PATH guard.
 *
 * resolveDownThreshold runs once per probe per asset (2000 assets on a 60s
 * cadence), so the one property that must never regress is that it does not
 * query: a whole fleet resolving against a cold cache performs exactly ONE
 * index build (two queries), not one per asset. The rest of this file covers
 * the staleness contract around that snapshot — TTL, explicit invalidation on
 * rule writes, the new-asset fallback, and the two degraded paths.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

let ruleRows: any[] = [];
let assetRows: any[] = [];
let ruleQueries = 0;
let assetQueries = 0;
let ruleFindFails = false;

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationRule: {
      findMany: vi.fn(async () => {
        ruleQueries++;
        if (ruleFindFails) throw new Error("db down");
        return ruleRows;
      }),
    },
    asset: {
      findMany: vi.fn(async () => {
        assetQueries++;
        return assetRows;
      }),
    },
  },
}));

vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

import {
  resolveDownThreshold,
  previewDownDetectionRemoval,
  describeDownDetectionFor,
  invalidateDownDetectionCache,
  resetDownDetectionStateForTests,
  DOWN_DETECTION_TTL_MS,
} from "../../src/services/downDetectionService.js";

const downTrigger = (missedPolls?: number, dimensionFilter?: unknown) => ({
  type: "asset_state", field: "monitorStatus", operator: "==", value: "down",
  forDurationSec: 0, ...(missedPolls != null ? { missedPolls } : {}),
  ...(dimensionFilter ? { dimensionFilter } : {}),
});

const asset = (id: string, over: Record<string, unknown> = {}) => ({
  id, hostname: `host-${id}`, assetType: "switch", tags: [], discoveredByIntegrationId: null,
  manufacturer: null, model: null, os: null, ipAddress: null, macAddress: null, status: "active",
  ...over,
});

beforeEach(() => {
  resetDownDetectionStateForTests();
  ruleQueries = 0;
  assetQueries = 0;
  ruleFindFails = false;
  ruleRows = [];
  assetRows = [];
  vi.useRealTimers();
});

describe("hot path", () => {
  it("resolves a whole fleet from ONE build — 2000 concurrent lookups, 2 queries", async () => {
    ruleRows = [{ id: "base", name: "Asset down", createdAt: new Date(), trigger: downTrigger(3), scope: { allAssets: true } }];
    assetRows = Array.from({ length: 2000 }, (_, i) => asset(`a${i}`));

    const results = await Promise.all(assetRows.map((a) => resolveDownThreshold(a.id)));

    expect(results).toHaveLength(2000);
    expect(results.every((r) => r === 3)).toBe(true);
    // The assertion this file exists for.
    expect(ruleQueries).toBe(1);
    expect(assetQueries).toBe(1);
  });

  it("serves subsequent lookups from the snapshot without re-querying", async () => {
    ruleRows = [{ id: "base", name: "b", createdAt: new Date(), trigger: downTrigger(4), scope: { allAssets: true } }];
    assetRows = [asset("a1")];

    await resolveDownThreshold("a1");
    expect(ruleQueries).toBe(1);
    for (let i = 0; i < 50; i++) await resolveDownThreshold("a1");
    expect(ruleQueries).toBe(1);
  });
});

describe("staleness contract", () => {
  it("rebuilds after the TTL expires", async () => {
    ruleRows = [{ id: "base", name: "b", createdAt: new Date(), trigger: downTrigger(3), scope: { allAssets: true } }];
    assetRows = [asset("a1")];
    await resolveDownThreshold("a1");
    expect(ruleQueries).toBe(1);

    const realNow = Date.now;
    try {
      const t = realNow();
      Date.now = () => t + DOWN_DETECTION_TTL_MS + 1;
      await resolveDownThreshold("a1");
    } finally {
      Date.now = realNow;
    }
    expect(ruleQueries).toBe(2);
  });

  it("invalidate() forces the next resolve to rebuild", async () => {
    ruleRows = [{ id: "base", name: "b", createdAt: new Date(), trigger: downTrigger(3), scope: { allAssets: true } }];
    assetRows = [asset("a1")];
    expect(await resolveDownThreshold("a1")).toBe(3);

    ruleRows = [{ id: "base", name: "b", createdAt: new Date(), trigger: downTrigger(9), scope: { allAssets: true } }];
    expect(await resolveDownThreshold("a1")).toBe(3); // still the snapshot
    invalidateDownDetectionCache();
    expect(await resolveDownThreshold("a1")).toBe(9);
  });

  it("an asset discovered since the last build resolves through the all-assets fallback", async () => {
    ruleRows = [{ id: "base", name: "b", createdAt: new Date(), trigger: downTrigger(5), scope: { allAssets: true } }];
    assetRows = [asset("a1")];
    await resolveDownThreshold("a1");

    // "brand-new" — never seen by the build, so absent from byAsset.
    expect(await resolveDownThreshold("newly-discovered")).toBe(5);
    expect(ruleQueries).toBe(1); // and it did NOT trigger a rebuild
  });

  it("an unknown asset is passive when no all-assets automation exists", async () => {
    ruleRows = [{ id: "sw", name: "switches", createdAt: new Date(), trigger: downTrigger(2), scope: { assetTypes: ["switch"] } }];
    assetRows = [asset("a1")];
    expect(await resolveDownThreshold("a1")).toBe(2);
    expect(await resolveDownThreshold("stranger")).toBeNull();
  });

  it("a filtered all-assets rule is NOT a fallback — it does not cover everything", async () => {
    ruleRows = [{
      id: "core", name: "core only", createdAt: new Date(),
      trigger: downTrigger(2, { hostnamePattern: "core-" }), scope: { allAssets: true },
    }];
    assetRows = [asset("a1", { hostname: "core-sw-1" })];
    expect(await resolveDownThreshold("a1")).toBe(2);
    expect(await resolveDownThreshold("stranger")).toBeNull();
  });
});

describe("coverage", () => {
  it("no down-detection automation ⇒ every asset passive", async () => {
    ruleRows = [{ id: "cpu", name: "cpu", createdAt: new Date(), trigger: { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90, aggregation: "avg", windowSec: 300, forDurationSec: 0 }, scope: { allAssets: true } }];
    assetRows = [asset("a1"), asset("a2")];
    expect(await resolveDownThreshold("a1")).toBeNull();
    expect(await resolveDownThreshold("a2")).toBeNull();
  });

  it("ignores DISABLED rules — the query filters them, so an empty result is passive", async () => {
    ruleRows = []; // prisma mock stands in for `where: { enabled: true }`
    assetRows = [asset("a1")];
    expect(await resolveDownThreshold("a1")).toBeNull();
  });

  it("ignores monitorStatus rules that are not `== down`", async () => {
    ruleRows = [{ id: "warn", name: "warn", createdAt: new Date(), trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "warning", forDurationSec: 0 }, scope: { allAssets: true } }];
    assetRows = [asset("a1")];
    expect(await resolveDownThreshold("a1")).toBeNull();
  });

  it("describeDownDetectionFor names the governing automation and flags the fallback", async () => {
    ruleRows = [{ id: "base", name: "Asset down", createdAt: new Date(), trigger: downTrigger(3), scope: { allAssets: true } }];
    assetRows = [asset("a1")];

    const known = await describeDownDetectionFor("a1");
    expect(known).toMatchObject({ passive: false, viaFallback: false });
    expect(known?.winner).toMatchObject({ ruleName: "Asset down", threshold: 3 });

    const unknown = await describeDownDetectionFor("stranger");
    expect(unknown).toMatchObject({ passive: false, viaFallback: true });
  });
});

describe("degraded paths", () => {
  it("serves the last good snapshot when a rebuild fails", async () => {
    ruleRows = [{ id: "base", name: "b", createdAt: new Date(), trigger: downTrigger(7), scope: { allAssets: true } }];
    assetRows = [asset("a1")];
    expect(await resolveDownThreshold("a1")).toBe(7);

    ruleFindFails = true;
    invalidateDownDetectionCache();
    expect(await resolveDownThreshold("a1")).toBe(7); // stale but valid, not a wrong verdict
  });

  it("with no snapshot at all, everything is passive rather than a guessed threshold", async () => {
    ruleFindFails = true;
    expect(await resolveDownThreshold("a1")).toBeNull();
  });

  it("recovers on the next resolve — a rejection is never cached", async () => {
    ruleFindFails = true;
    expect(await resolveDownThreshold("a1")).toBeNull();

    ruleFindFails = false;
    ruleRows = [{ id: "base", name: "b", createdAt: new Date(), trigger: downTrigger(3), scope: { allAssets: true } }];
    assetRows = [asset("a1")];
    expect(await resolveDownThreshold("a1")).toBe(3);
  });
});

describe("removal impact — the blind-fleet guard", () => {
  // Deleting the last automation covering a device makes it Passive. Nothing
  // else can warn about that: the thing that would normally alert about a fleet
  // nobody is judging IS the automation being deleted.
  it("counts the devices that would be left with NO down detection", async () => {
    ruleRows = [{ id: "base", name: "Asset down", createdAt: new Date(), trigger: downTrigger(3), scope: { allAssets: true } }];
    assetRows = [asset("a1"), asset("a2"), asset("a3")];
    const impact = await previewDownDetectionRemoval("base");
    expect(impact).toMatchObject({ isDownDetection: true, governs: 3, wouldFallBackToAnother: 0, wouldBecomePassive: 3 });
    expect(impact.sampleHostnames).toContain("host-a1");
  });

  it("devices a BROADER automation still covers are not counted as passive", async () => {
    ruleRows = [
      { id: "base", name: "Asset down", createdAt: new Date(), trigger: downTrigger(10), scope: { allAssets: true } },
      { id: "sw", name: "Switches", createdAt: new Date(), trigger: downTrigger(2), scope: { assetTypes: ["switch"] } },
    ];
    assetRows = [asset("a1"), asset("a2")];
    // The narrow rule governs both switches, but the all-assets rule catches
    // them if it goes — nobody goes dark, so no warning is warranted.
    const impact = await previewDownDetectionRemoval("sw");
    expect(impact).toMatchObject({ governs: 2, wouldFallBackToAnother: 2, wouldBecomePassive: 0 });
  });

  it("removing the BROAD rule leaves only the devices the narrow one misses", async () => {
    ruleRows = [
      { id: "base", name: "Asset down", createdAt: new Date(), trigger: downTrigger(3), scope: { allAssets: true } },
      { id: "sw", name: "Switches", createdAt: new Date(), trigger: downTrigger(2), scope: { assetTypes: ["switch"] } },
    ];
    assetRows = [asset("a1"), asset("srv", { assetType: "server" })];
    const impact = await previewDownDetectionRemoval("base");
    // The switch is governed by the narrower rule, so `base` governs only the
    // server — and that server is the one that would go dark.
    expect(impact).toMatchObject({ governs: 1, wouldFallBackToAnother: 0, wouldBecomePassive: 1 });
    expect(impact.sampleHostnames).toEqual(["host-srv"]);
  });

  it("reports isDownDetection:false for an automation that does not define down", async () => {
    ruleRows = [{ id: "cpu", name: "cpu", createdAt: new Date(), trigger: { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90, aggregation: "avg", windowSec: 300, forDurationSec: 0 }, scope: { allAssets: true } }];
    assetRows = [asset("a1")];
    expect(await previewDownDetectionRemoval("cpu")).toMatchObject({ isDownDetection: false, wouldBecomePassive: 0 });
  });
});
