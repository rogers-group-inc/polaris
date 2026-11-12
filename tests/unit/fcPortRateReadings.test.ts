/**
 * tests/unit/fcPortRateReadings.test.ts
 *
 * Business rule 159(a) — the FC counter rate an automation compares: the
 * newest two samples that CARRY an FC reading, per pinned port, as a rate per
 * minute. A counter that went backwards (the switch cleared it) is no reading,
 * never a negative rate; an unpinned port reads nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { resolveAssetMetricReadings } from "../../src/services/notifications/readings.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const findMany = stubbed(prisma.assetInterfaceSample.findMany);

const T0 = Date.now() - 60_000;
const at = (s: number) => new Date(T0 + s * 1000);
const row = (ifName: string, s: number, invalidCrcs: number) => ({
  assetId: "mds", timestamp: at(s), ifName, alias: null,
  fcErrors: { invalidCrcs, linkFailures: 0, syncLosses: 0, sigLosses: 0, invalidTxWords: 0, linkResetIns: 0, linkResetOuts: 0 },
});
const asset = { id: "mds", hostname: "mds-a", tags: [], monitoredInterfaces: ["fc1/1", "fc1/2"] } as never;
const trigger = (metric: string) => ({ type: "asset_metric", metric, operator: ">", value: 0 }) as never;

beforeEach(() => resetDbStub());

describe("fcCrcErrorRate", () => {
  it("is the CRC count's growth per minute between the two newest FC samples", async () => {
    // Newest first, as the query orders them.
    findMany.mockResolvedValue([row("fc1/1", 60, 25), row("fc1/1", 30, 10), row("fc1/1", 0, 0)]);
    const readings = await resolveAssetMetricReadings(trigger("fcCrcErrorRate"), [asset]);
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ assetId: "mds", dimKey: "fc1/1" });
    expect(readings[0]!.value).toBeCloseTo(30); // 15 errors in 30 s
  });

  it("asks only for rows that carry an FC reading", async () => {
    findMany.mockResolvedValue([]);
    await resolveAssetMetricReadings(trigger("fcCrcErrorRate"), [asset]);
    const where = findMany.mock.calls[0]![0].where;
    expect(where.fcErrors).toBeDefined();
    expect(where.assetId).toEqual({ in: ["mds"] });
  });

  it("reads a cleared counter as no reading, not a negative rate", async () => {
    findMany.mockResolvedValue([row("fc1/2", 60, 2), row("fc1/2", 30, 900)]);
    const [r] = await resolveAssetMetricReadings(trigger("fcCrcErrorRate"), [asset]);
    expect(r!.value).toBeNull();
  });

  it("skips a port that is not monitored", async () => {
    findMany.mockResolvedValue([row("fc1/9", 60, 5), row("fc1/9", 30, 1)]);
    expect(await resolveAssetMetricReadings(trigger("fcCrcErrorRate"), [asset])).toEqual([]);
  });
});

describe("the other FC counters", () => {
  it("each metric reads its own counter", async () => {
    const r = (s: number, linkFailures: number) => ({ ...row("fc1/1", s, 0), fcErrors: { ...row("fc1/1", s, 0).fcErrors, linkFailures } });
    findMany.mockResolvedValue([r(60, 3), r(0, 1)]);
    const [link] = await resolveAssetMetricReadings(trigger("fcLinkFailureRate"), [asset]);
    expect(link!.value).toBeCloseTo(2);
    findMany.mockResolvedValue([r(60, 3), r(0, 1)]);
    const [crc] = await resolveAssetMetricReadings(trigger("fcCrcErrorRate"), [asset]);
    expect(crc!.value).toBe(0);
  });
});
