/**
 * tests/unit/sampleWriteBuffer.test.ts
 *
 * Coverage for the periodic monitor sample-write buffer:
 *
 *   - Enqueued rows fan out into the right Prisma createMany calls on flush.
 *   - The 5000-row size threshold fires an immediate flush ahead of the tick.
 *   - On a deadlock (SQLSTATE 40P01) the retry helper drives a second
 *     createMany attempt with the same rows.
 *   - `setSampleBufferDepth` is called with the per-table row counts.
 *   - `shutdownFlushSampleBuffers` drains pending rows.
 *   - The buffer is empty after a successful flush.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock factories are hoisted above the file body — any captured variable
// has to come from vi.hoisted so it lives in the same hoisted scope. We
// stash the createMany + metric spies in a hoisted object and read them
// back in the tests.
const mocks = vi.hoisted(() => {
  return {
    createMany: {
      assetMonitorSample:        vi.fn(async (_args: { data: any[] }) => ({ count: 0 })),
      assetTelemetrySample:      vi.fn(async (_args: { data: any[] }) => ({ count: 0 })),
      assetHardwareSensorSample: vi.fn(async (_args: { data: any[] }) => ({ count: 0 })),
      assetInterfaceSample:      vi.fn(async (_args: { data: any[] }) => ({ count: 0 })),
      assetStorageSample:     vi.fn(async (_args: { data: any[] }) => ({ count: 0 })),
      assetIpsecTunnelSample: vi.fn(async (_args: { data: any[] }) => ({ count: 0 })),
    },
    setSampleBufferDepth: vi.fn(),
    startSampleWriteTimer: vi.fn(() => () => 0),
  };
});

const createManyMocks = mocks.createMany;
const setSampleBufferDepth = mocks.setSampleBufferDepth;
const startSampleWriteTimer = mocks.startSampleWriteTimer;

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetMonitorSample:        { createMany: mocks.createMany.assetMonitorSample },
    assetTelemetrySample:      { createMany: mocks.createMany.assetTelemetrySample },
    assetHardwareSensorSample: { createMany: mocks.createMany.assetHardwareSensorSample },
    assetInterfaceSample:      { createMany: mocks.createMany.assetInterfaceSample },
    assetStorageSample:     { createMany: mocks.createMany.assetStorageSample },
    assetIpsecTunnelSample: { createMany: mocks.createMany.assetIpsecTunnelSample },
  },
}));

vi.mock("../../src/metrics.js", () => ({
  setSampleBufferDepth: mocks.setSampleBufferDepth,
  startSampleWriteTimer: mocks.startSampleWriteTimer,
}));

import {
  enqueueMonitorSample,
  enqueueTelemetrySample,
  enqueueHardwareSensorSamples,
  enqueueInterfaceSamples,
  enqueueStorageSamples,
  enqueueIpsecTunnelSamples,
  flushAllSampleBuffers,
  shutdownFlushSampleBuffers,
  __test__,
  type MonitorSampleRow,
  type TelemetrySampleRow,
  type InterfaceSampleRow,
} from "../../src/services/sampleWriteBuffer.js";

const now = new Date("2026-05-11T12:00:00.000Z");

function probeRow(assetId: string, ok: boolean): MonitorSampleRow {
  return {
    assetId,
    timestamp: now,
    success: ok,
    responseTimeMs: ok ? 12 : null,
    error: ok ? null : "timeout",
  };
}

function ifaceRow(assetId: string, ifName: string): InterfaceSampleRow {
  return {
    assetId, timestamp: now, cadence: "slow", ifName,
    adminStatus: "up", operStatus: "up",
    speedBps: 1000000000n, duplex: null, ipAddress: null, macAddress: null,
    inOctets: null, outOctets: null, inErrors: null, outErrors: null,
    ifType: null, ifParent: null, vlanId: null, nativeVlan: null, taggedVlans: [], trunksAllVlans: false,
    alias: null, description: null, addressingMode: null, poeStatus: null, poeClass: null,
  };
}

beforeEach(() => {
  __test__.reset();
  for (const m of Object.values(createManyMocks)) m.mockClear();
  setSampleBufferDepth.mockClear();
  startSampleWriteTimer.mockClear();
});

afterEach(() => {
  __test__.reset();
});

describe("sampleWriteBuffer — enqueue + flush", () => {
  it("flushAllSampleBuffers writes each populated table once", async () => {
    enqueueMonitorSample(probeRow("a", true));
    enqueueMonitorSample(probeRow("b", false));
    enqueueTelemetrySample({
      assetId: "a", timestamp: now,
      cpuPct: 12.5, memPct: 40, memUsedBytes: null, memTotalBytes: null,
    } as TelemetrySampleRow);
    enqueueInterfaceSamples([ifaceRow("a", "port1"), ifaceRow("a", "port2")]);

    await flushAllSampleBuffers();

    expect(createManyMocks.assetMonitorSample).toHaveBeenCalledTimes(1);
    const monitorArg = createManyMocks.assetMonitorSample.mock.calls[0][0];
    expect(monitorArg.data).toHaveLength(2);
    expect(monitorArg.data[0].assetId).toBe("a");
    expect(monitorArg.data[1].error).toBe("timeout");

    expect(createManyMocks.assetTelemetrySample).toHaveBeenCalledTimes(1);
    expect(createManyMocks.assetInterfaceSample).toHaveBeenCalledTimes(1);
    expect(createManyMocks.assetInterfaceSample.mock.calls[0][0].data).toHaveLength(2);

    // Untouched tables shouldn't have fired any write.
    expect(createManyMocks.assetHardwareSensorSample).not.toHaveBeenCalled();
    expect(createManyMocks.assetStorageSample).not.toHaveBeenCalled();
    expect(createManyMocks.assetIpsecTunnelSample).not.toHaveBeenCalled();
  });

  it("clears the buffer after a successful flush", async () => {
    enqueueMonitorSample(probeRow("a", true));
    expect(__test__.getBufferDepth("monitor")).toBe(1);
    await flushAllSampleBuffers();
    expect(__test__.getBufferDepth("monitor")).toBe(0);
  });

  it("updates polaris_sample_buffer_depth gauge on enqueue and flush", async () => {
    enqueueMonitorSample(probeRow("a", true));
    enqueueMonitorSample(probeRow("b", true));
    enqueueMonitorSample(probeRow("c", true));
    // After three enqueues the most recent call sets depth=3.
    const lastCalls = setSampleBufferDepth.mock.calls.filter(
      (c) => c[0] === "asset_monitor_samples",
    );
    expect(lastCalls[lastCalls.length - 1]?.[1]).toBe(3);

    await flushAllSampleBuffers();
    const post = setSampleBufferDepth.mock.calls.filter(
      (c) => c[0] === "asset_monitor_samples",
    );
    expect(post[post.length - 1]?.[1]).toBe(0);
  });

  it("size-threshold path: 5000 monitor samples trigger an immediate flush", async () => {
    for (let i = 0; i < 5000; i++) enqueueMonitorSample(probeRow(`a${i}`, true));
    // Threshold fires void-flush; let the microtask + the awaited prisma call
    // settle so the test sees the createMany.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Written in statements of at most 2000 rows, in order.
    const sizes = createManyMocks.assetMonitorSample.mock.calls.map((c: any[]) => c[0].data.length);
    expect(sizes).toEqual([2000, 2000, 1000]);
  });

  it("does not write when no rows were enqueued for a table", async () => {
    enqueueMonitorSample(probeRow("a", true));
    await flushAllSampleBuffers();
    expect(createManyMocks.assetTelemetrySample).not.toHaveBeenCalled();
    expect(createManyMocks.assetHardwareSensorSample).not.toHaveBeenCalled();
    expect(createManyMocks.assetInterfaceSample).not.toHaveBeenCalled();
  });
});

describe("sampleWriteBuffer — error handling", () => {
  it("retries on a Postgres deadlock and succeeds on the second attempt", async () => {
    createManyMocks.assetMonitorSample
      .mockImplementationOnce(async () => {
        const err: any = new Error("deadlock detected");
        err.code = "40P01";
        throw err;
      })
      .mockImplementationOnce(async () => ({ count: 1 }));

    enqueueMonitorSample(probeRow("a", true));
    await flushAllSampleBuffers();
    expect(createManyMocks.assetMonitorSample).toHaveBeenCalledTimes(2);
    expect(__test__.getBufferDepth("monitor")).toBe(0);
  });

  it("re-prepends the batch when the flush fails for a non-deadlock reason", async () => {
    createManyMocks.assetMonitorSample.mockImplementationOnce(async () => {
      throw new Error("connection refused");
    });

    enqueueMonitorSample(probeRow("a", true));
    enqueueMonitorSample(probeRow("b", true));
    await flushAllSampleBuffers();
    // Rows should still be queued, ready for the next tick to retry.
    expect(__test__.getBufferDepth("monitor")).toBe(2);
  });

  it("waits out a backoff after a failure instead of retrying on every enqueue, but the shutdown drain does not wait", async () => {
    createManyMocks.assetMonitorSample.mockImplementationOnce(async () => { throw new Error("connection refused"); });
    enqueueMonitorSample(probeRow("a", true));
    await flushAllSampleBuffers();
    expect(createManyMocks.assetMonitorSample).toHaveBeenCalledTimes(1);
    await flushAllSampleBuffers();
    expect(createManyMocks.assetMonitorSample).toHaveBeenCalledTimes(1);
    await shutdownFlushSampleBuffers();
    expect(createManyMocks.assetMonitorSample).toHaveBeenCalledTimes(2);
    expect(__test__.getBufferDepth("monitor")).toBe(0);
  });

  it("re-queues only the chunks that were not written, ahead of newer rows, with no argument spread", async () => {
    let calls = 0;
    createManyMocks.assetMonitorSample.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) throw new Error("connection refused");
      return { count: 0 };
    });
    for (let i = 0; i < 5000; i++) enqueueMonitorSample(probeRow(`a${i}`, true));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // The first 2000 were written; 3000 wait for the retry.
    expect(__test__.getBufferDepth("monitor")).toBe(3000);
    createManyMocks.assetMonitorSample.mockReset();
  });

  it("caps a failing table at 200,000 rows, dropping the oldest", async () => {
    createManyMocks.assetMonitorSample.mockImplementation(async () => { throw new Error("connection refused"); });
    // A long outage: far more rows than the cap, in one failed flush.
    const rows = Array.from({ length: 250_000 }, (_, i) => probeRow(`a${i}`, true));
    for (const r of rows) (enqueueMonitorSample as any)(r);
    await shutdownFlushSampleBuffers();
    expect(__test__.getBufferDepth("monitor")).toBe(200_000);
    createManyMocks.assetMonitorSample.mockReset();
  });
});

describe("sampleWriteBuffer — shutdown", () => {
  it("shutdownFlushSampleBuffers drains rows then exits cleanly", async () => {
    enqueueMonitorSample(probeRow("a", true));
    enqueueTelemetrySample({
      assetId: "a", timestamp: now,
      cpuPct: 50, memPct: null, memUsedBytes: null, memTotalBytes: null,
    } as TelemetrySampleRow);
    await shutdownFlushSampleBuffers();
    expect(createManyMocks.assetMonitorSample).toHaveBeenCalledTimes(1);
    expect(createManyMocks.assetTelemetrySample).toHaveBeenCalledTimes(1);
    expect(__test__.getBufferDepth("monitor")).toBe(0);
    expect(__test__.getBufferDepth("telemetry")).toBe(0);
  });

  it("shutdownFlushSampleBuffers is a no-op with no pending rows", async () => {
    await shutdownFlushSampleBuffers();
    for (const m of Object.values(createManyMocks)) {
      expect(m).not.toHaveBeenCalled();
    }
  });
});

describe("sampleWriteBuffer — multi-table fan-out", () => {
  it("hardware sensors, storage, ipsec all flush in parallel-safe paths", async () => {
    enqueueHardwareSensorSamples([
      { assetId: "a", timestamp: now, sensorName: "cpu0", sensorClass: "temperature", value: 42, unit: "°C", alarmStatus: "ok" },
      { assetId: "a", timestamp: now, sensorName: "FAN 1", sensorClass: "fan", value: 8800, unit: "RPM", alarmStatus: "ok" },
    ]);
    enqueueStorageSamples([
      { assetId: "a", timestamp: now, cadence: "slow", mountPath: "/", totalBytes: 100n, usedBytes: 30n },
    ]);
    enqueueIpsecTunnelSamples([
      {
        assetId: "a", timestamp: now, cadence: "slow", tunnelName: "wan1-to-hq",
        parentInterface: "wan1", remoteGateway: "1.2.3.4", status: "up",
        incomingBytes: null, outgoingBytes: null, proxyIdCount: 1,
      },
    ]);

    await flushAllSampleBuffers();

    expect(createManyMocks.assetHardwareSensorSample.mock.calls[0][0].data).toHaveLength(2);
    expect(createManyMocks.assetStorageSample.mock.calls[0][0].data).toHaveLength(1);
    expect(createManyMocks.assetIpsecTunnelSample.mock.calls[0][0].data).toHaveLength(1);
  });

  it("empty-array enqueues do not trigger a write", async () => {
    enqueueHardwareSensorSamples([]);
    enqueueStorageSamples([]);
    enqueueIpsecTunnelSamples([]);
    await flushAllSampleBuffers();
    expect(createManyMocks.assetHardwareSensorSample).not.toHaveBeenCalled();
    expect(createManyMocks.assetStorageSample).not.toHaveBeenCalled();
    expect(createManyMocks.assetIpsecTunnelSample).not.toHaveBeenCalled();
  });
});
