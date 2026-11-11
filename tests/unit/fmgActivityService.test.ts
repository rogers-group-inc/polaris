/**
 * tests/unit/fmgActivityService.test.ts — the FMG worker heartbeat the web role
 * reads (CQ-T010): no snapshot reads as a zeroed, not-fresh readout; a
 * snapshot older than 10 s is stale; a missing integration slice is zeroed but
 * keeps the snapshot's age; the heartbeat writes every worker's lane state into
 * one Setting row and is idempotent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ workers: [] as Array<Record<string, unknown>> }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/fmgWorker.js", () => ({ getAllFmgWorkers: () => h.workers }));
vi.mock("../../src/utils/role.js", () => ({ getRole: () => "discovery" }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { getFmgActivityForIntegration, startFmgActivityHeartbeat } from "../../src/services/fmgActivityService.js";

const findUnique = stubbed(prisma.setting.findUnique);
const upsert = stubbed(prisma.setting.upsert);
const NOW = new Date("2026-11-11T12:00:00Z");

beforeEach(() => {
  resetDbStub();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.workers = [];
});
afterEach(() => vi.useRealTimers());

const snapshot = (ageMs: number, integrations: Record<string, unknown>) => ({
  value: { updatedAt: new Date(NOW.getTime() - ageMs).toISOString(), role: "discovery", integrations },
});

describe("getFmgActivityForIntegration", () => {
  it("no snapshot row is a zeroed readout that is not fresh", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getFmgActivityForIntegration("i1")).toEqual({
      proxyInFlightLabel: null, proxyQueueDepth: 0, nativeInFlightCount: 0, updatedAt: null, role: null, ageMs: null, fresh: false,
    });
  });

  it("a recent snapshot returns the integration's lane state as fresh", async () => {
    findUnique.mockResolvedValue(snapshot(2_000, { i1: { proxyInFlightLabel: "dvmdb", proxyQueueDepth: 3, nativeInFlightCount: 1 } }));
    expect(await getFmgActivityForIntegration("i1")).toMatchObject({
      proxyInFlightLabel: "dvmdb", proxyQueueDepth: 3, nativeInFlightCount: 1, role: "discovery", ageMs: 2_000, fresh: true,
    });
  });

  it("a snapshot older than 10 s is stale; one at exactly 10 s is not", async () => {
    findUnique.mockResolvedValueOnce(snapshot(10_001, {}));
    expect((await getFmgActivityForIntegration("i1")).fresh).toBe(false);
    findUnique.mockResolvedValueOnce(snapshot(10_000, {}));
    expect((await getFmgActivityForIntegration("i1")).fresh).toBe(true);
  });

  it("an integration missing from the snapshot is zeroed but keeps its age", async () => {
    findUnique.mockResolvedValue(snapshot(1_000, { other: { proxyInFlightLabel: "x", proxyQueueDepth: 9, nativeInFlightCount: 9 } }));
    expect(await getFmgActivityForIntegration("i1")).toMatchObject({ proxyInFlightLabel: null, proxyQueueDepth: 0, nativeInFlightCount: 0, ageMs: 1_000 });
  });
});

describe("startFmgActivityHeartbeat", () => {
  it("writes every worker's lane state into the fmgActivitySnapshot row, once per tick, idempotently", async () => {
    upsert.mockResolvedValue({});
    h.workers = [{ integrationId: "i1", proxyInFlightLabel: "q", proxyQueueDepth: 2, nativeInFlightCount: 0 }];
    startFmgActivityHeartbeat();
    startFmgActivityHeartbeat();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ key: "fmgActivitySnapshot" });
    expect(arg.create.value).toMatchObject({ role: "discovery", integrations: { i1: { proxyInFlightLabel: "q", proxyQueueDepth: 2, nativeInFlightCount: 0 } } });
  });
});
