/**
 * tests/unit/pathCheckIngest.test.ts — the server half of the agent's
 * path-check streams: what is trusted from the wire (nothing about WHICH
 * host; not the excerpt policy), rejection of checks the host is not a source
 * of, latest-result bookkeeping, hop resolution decoration, and path-change
 * Events with their 10-minute floor.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  sources: [] as any[],
  traceroutes: [] as any[],
  hopRows: [] as any[],
};

const { enqueue, logEvent } = vi.hoisted(() => ({
  enqueue: vi.fn(),
  logEvent: vi.fn(async () => {}),
}));

vi.mock("../../src/services/sampleWriteBuffer.js", () => ({ enqueuePathCheckSamples: enqueue }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent }));
vi.mock("../../src/metrics.js", () => ({ recordPathCheckSamples: vi.fn(), recordPathCheckPathChange: vi.fn() }));

vi.mock("../../src/db.js", () => ({
  prisma: {
    pathCheckSource: {
      findMany: vi.fn(async ({ where }: any) =>
        db.sources.filter((s) => s.assetId === where.assetId && where.checkId.in.includes(s.checkId))),
      update: vi.fn(async ({ where, data }: any) => {
        const s = db.sources.find((x) => x.id === where.id);
        Object.assign(s, data);
        return s;
      }),
    },
    assetPathCheckTraceroute: {
      createMany: vi.fn(async ({ data }: any) => { db.traceroutes.push(...data); return { count: data.length }; }),
    },
    asset: { findUnique: vi.fn(async () => ({ hostname: "branch-pc-01", ipAddress: "10.1.1.50" })) },
    $queryRaw: vi.fn(async () => db.hopRows),
    $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
  },
}));

import {
  ingestPathCheckSamples,
  ingestPathCheckTraceroutes,
  excerptToKeep,
  hopIp,
  pathHashOf,
  sampleTime,
  PATH_CHANGE_EVENT_FLOOR_MS,
} from "../../src/services/pathCheckIngestService.js";
import { MAX_EXCERPT_CHARS } from "../../src/utils/httpCheck.js";

const now = new Date("2026-09-23T12:00:00Z");

function source(checkId: string, extra: any = {}) {
  return {
    id: `src-${checkId}`, checkId, assetId: "host",
    lastOk: null, lastPathHash: null, lastPathChangeEventAt: null, lastSampleAt: null,
    check: { name: `Check ${checkId}`, keepBodyExcerpt: false },
    ...extra,
  };
}

beforeEach(() => {
  db.sources = [];
  db.traceroutes = [];
  db.hopRows = [];
  enqueue.mockClear();
  logEvent.mockClear();
});

describe("pure helpers", () => {
  it("keeps the excerpt only on a failure or when the check keeps it", () => {
    expect(excerptToKeep({ ok: true, bodyExcerpt: "hello" }, false)).toBeNull();
    expect(excerptToKeep({ ok: true, bodyExcerpt: "hello" }, true)).toBe("hello");
    expect(excerptToKeep({ ok: false, bodyExcerpt: "oops" }, false)).toBe("oops");
    expect(excerptToKeep({ ok: false, bodyExcerpt: "x".repeat(MAX_EXCERPT_CHARS + 50) }, false)).toHaveLength(MAX_EXCERPT_CHARS);
  });
  it("treats blank / star / junk hop addresses as a silent hop", () => {
    expect(hopIp("")).toBeNull();
    expect(hopIp("*")).toBeNull();
    expect(hopIp("not-an-ip")).toBeNull();
    expect(hopIp(" 10.0.0.1 ")).toBe("10.0.0.1");
  });
  it("hashes the IP sequence, ignoring RTTs and trailing silent hops", () => {
    const a = pathHashOf([{ ip: "10.0.0.1" }, { ip: null }, { ip: "8.8.8.8" }]);
    expect(pathHashOf([{ ip: "10.0.0.1" }, { ip: null }, { ip: "8.8.8.8" }, { ip: null }, { ip: null }])).toBe(a);
    expect(pathHashOf([{ ip: "10.0.0.2" }, { ip: null }, { ip: "8.8.8.8" }])).not.toBe(a);
  });
  it("clamps a future agent timestamp to now", () => {
    expect(sampleTime("2030-01-01T00:00:00Z", now)).toEqual(now);
    expect(sampleTime(undefined, now)).toEqual(now);
    expect(sampleTime("2026-09-23T11:59:00Z", now).toISOString()).toBe("2026-09-23T11:59:00.000Z");
  });
});

describe("ingestPathCheckSamples", () => {
  it("rejects checks the host is not a source of, and never trusts the excerpt policy", async () => {
    db.sources = [source("c1")];
    const r = await ingestPathCheckSamples("host", [
      { checkId: "c1", ok: true, latencyMs: 42, bodyExcerpt: "secret token page", bodySha256: "A".repeat(64) },
      { checkId: "foreign", ok: false },
    ], now);
    expect(r).toEqual({ accepted: 1, rejected: 1 });
    const rows = enqueue.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assetId: "host", checkId: "c1", cadence: "fast", bodyExcerpt: null, bodySha256: "a".repeat(64) });
    expect(db.sources[0]).toMatchObject({ lastOk: true, lastLatencyMs: 42 });
  });
  it("stamps lastFailAt on a failure and ignores an older push arriving late", async () => {
    db.sources = [source("c1", { lastSampleAt: new Date("2026-09-23T11:59:30Z"), lastOk: true })];
    await ingestPathCheckSamples("host", [{ checkId: "c1", ok: false, timestamp: "2026-09-23T11:58:00Z", error: "timeout" }], now);
    expect(db.sources[0].lastOk).toBe(true); // older than what we hold
    await ingestPathCheckSamples("host", [{ checkId: "c1", ok: false, timestamp: "2026-09-23T11:59:50Z", error: "timeout" }], now);
    expect(db.sources[0]).toMatchObject({ lastOk: false, lastError: "timeout" });
    expect(db.sources[0].lastFailAt).toEqual(new Date("2026-09-23T11:59:50Z"));
  });
});

describe("ingestPathCheckTraceroutes", () => {
  const hops = (third: string) => [
    { ttl: 1, ip: "10.1.1.1", rttMs: [1, 1, 1] },
    { ttl: 2, ip: "", rttMs: [-1, -1, -1] },
    { ttl: 3, ip: third, rttMs: [9, 10, 11] },
  ];

  it("decorates hops with the monitored asset and subnet, writes a baseline without an Event", async () => {
    db.sources = [source("c1")];
    db.hopRows = [
      { ip: "10.1.1.1", primary_id: null, primary_hostname: null, primary_status: null, assoc_id: "fgt", assoc_hostname: "branch-fw", assoc_status: "up", assoc_iface: "internal1", subnet_cidr: "10.1.1.0/24" },
    ];
    const r = await ingestPathCheckTraceroutes("host", [{ checkId: "c1", complete: true, destinationIp: "8.8.8.8", hops: hops("8.8.8.8") }], now);
    expect(r).toEqual({ accepted: 1, rejected: 0 });
    const tr = db.traceroutes[0];
    expect(tr.hops[0]).toMatchObject({ ip: "10.1.1.1", assetId: "fgt", hostname: "branch-fw", interfaceName: "internal1", subnetCidr: "10.1.1.0/24" });
    expect(tr.hops[1].ip).toBeNull();
    expect(logEvent).not.toHaveBeenCalled();
    expect(db.sources[0].lastPathHash).toBe(tr.pathHash);
  });

  it("writes path_check.path_changed on a changed path, naming the host — once per floor", async () => {
    db.sources = [source("c1")];
    await ingestPathCheckTraceroutes("host", [{ checkId: "c1", complete: true, timestamp: "2026-09-23T11:00:00Z", hops: hops("8.8.8.8") }], now);
    await ingestPathCheckTraceroutes("host", [{ checkId: "c1", complete: true, timestamp: "2026-09-23T11:20:00Z", hops: hops("8.8.4.4") }], now);
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect((logEvent.mock.calls[0] as any)[0]).toMatchObject({
      action: "path_check.path_changed",
      resourceType: "asset",
      resourceId: "host",
      resourceName: "branch-pc-01",
      details: { checkId: "c1", hops: ["10.1.1.1", null, "8.8.4.4"] },
    });
    // Flap back within the floor: recorded, no second Event.
    const within = new Date(Date.parse("2026-09-23T11:20:00Z") + PATH_CHANGE_EVENT_FLOOR_MS - 1000).toISOString();
    await ingestPathCheckTraceroutes("host", [{ checkId: "c1", complete: true, timestamp: within, hops: hops("8.8.8.8") }], now);
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(db.traceroutes).toHaveLength(3);
  });

  it("rejects a traceroute for a check the host does not run", async () => {
    const r = await ingestPathCheckTraceroutes("host", [{ checkId: "nope", complete: false, hops: [] }], now);
    expect(r).toEqual({ accepted: 0, rejected: 1 });
    expect(db.traceroutes).toHaveLength(0);
  });
});
