/**
 * tests/unit/monitoringCommon.test.ts — src/services/monitoring/common.ts:
 * finish() (a ProbeResult from a start time), clampPct, and the verbose phase
 * spans (startPhase is a no-op unless the AsyncLocalStorage context says
 * verbose; when on it logs one `monitor.phase` line per closer call).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const info = vi.hoisted(() => vi.fn());
vi.mock("../../src/utils/logger.js", () => ({ logger: { info, warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

import { performance } from "node:perf_hooks";
import { finish, clampPct, startPhase, monitorPhaseStorage } from "../../src/services/monitoring/common.js";

beforeEach(() => info.mockReset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("finish", () => {
  it("a success carries the rounded elapsed ms and no error", () => {
    vi.spyOn(performance, "now").mockReturnValue(1250.6);
    expect(finish(1000, true, "ignored")).toEqual({ success: true, responseTimeMs: 251 });
  });

  it("a failure carries the error", () => {
    vi.spyOn(performance, "now").mockReturnValue(1100);
    expect(finish(1000, false, "timeout")).toEqual({ success: false, responseTimeMs: 100, error: "timeout" });
  });

  it("never reports a negative time", () => {
    vi.spyOn(performance, "now").mockReturnValue(10);
    expect(finish(500, true).responseTimeMs).toBe(0);
  });
});

describe("clampPct", () => {
  it("clamps to 0..100 and rounds to two decimals", () => {
    expect(clampPct(-1)).toBe(0);
    expect(clampPct(101)).toBe(100);
    expect(clampPct(12.3456)).toBe(12.35);
    expect(clampPct(0)).toBe(0);
    expect(clampPct(100)).toBe(100);
  });

  it("reads a non-finite figure as 0", () => {
    expect(clampPct(Number.NaN)).toBe(0);
    expect(clampPct(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampPct(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe("startPhase", () => {
  it("is a no-op outside a monitor context", () => {
    startPhase("x")({ a: 1 });
    expect(info).not.toHaveBeenCalled();
  });

  it("is a no-op when the context is not verbose", () => {
    monitorPhaseStorage.run({ assetId: "a1", cadence: "probe", verbose: false }, () => startPhase("x")());
    expect(info).not.toHaveBeenCalled();
  });

  it("logs one monitor.phase line with elapsed ms and extras when verbose", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    const close = monitorPhaseStorage.run({ assetId: "a1", cadence: "systemInfo", verbose: true }, () => startPhase("snmp.walk"));
    vi.setSystemTime(new Date("2026-11-16T12:00:01.500Z"));
    close({ rows: 42 });
    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      { verbose: true, phase: "snmp.walk", assetId: "a1", cadence: "systemInfo", elapsedMs: 1500, rows: 42 },
      "monitor.phase",
    );
  });

  it("keeps the context captured at open even when closed outside it", async () => {
    const close = await monitorPhaseStorage.run({ assetId: "a2", cadence: "telemetry", verbose: true }, async () => {
      await Promise.resolve();
      return startPhase("rest");
    });
    close();
    expect(info.mock.calls[0][0]).toMatchObject({ assetId: "a2", cadence: "telemetry", phase: "rest" });
  });
});
