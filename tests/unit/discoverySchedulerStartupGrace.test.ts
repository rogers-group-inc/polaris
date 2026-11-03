/**
 * tests/unit/discoverySchedulerStartupGrace.test.ts
 *
 * After a service reload or in-app update, the discovery scheduler must not
 * start an overdue discovery while the app is still booting: its first check
 * waits STARTUP_GRACE_MS (5 min), then it ticks every 15 min from there.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { findMany, triggerDiscovery, isDiscoveryRunning } = vi.hoisted(() => ({
  findMany: vi.fn(),
  triggerDiscovery: vi.fn(),
  isDiscoveryRunning: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({ prisma: { integration: { findMany } } }));
vi.mock("../../src/services/discovery/discoveryEngine.js", () => ({ triggerDiscovery, isDiscoveryRunning }));
vi.mock("../../src/jobs/_metrics.js", () => ({
  runInstrumentedJob: (_name: string, fn: () => Promise<void>) => fn(),
}));

import { startDiscoveryScheduler, STARTUP_GRACE_MS } from "../../src/jobs/discoveryScheduler.js";

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

describe("discoveryScheduler startup grace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    findMany.mockReset().mockResolvedValue([
      // Never discovered: due the moment the process starts.
      { id: "i1", name: "overdue", pollInterval: 12, lastDiscoveryAt: null },
    ]);
    triggerDiscovery.mockReset().mockResolvedValue(undefined);
    isDiscoveryRunning.mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("is five minutes", () => {
    expect(STARTUP_GRACE_MS).toBe(5 * 60 * 1000);
  });

  it("does not check or start a discovery during the grace window", async () => {
    startDiscoveryScheduler();
    await vi.advanceTimersByTimeAsync(STARTUP_GRACE_MS - 1);
    expect(findMany).not.toHaveBeenCalled();
    expect(triggerDiscovery).not.toHaveBeenCalled();
  });

  it("runs an overdue discovery when the grace window ends", async () => {
    startDiscoveryScheduler();
    await vi.advanceTimersByTimeAsync(STARTUP_GRACE_MS);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(triggerDiscovery).toHaveBeenCalledWith("i1", "auto-discovery");
  });

  it("ticks every 15 minutes after the first check", async () => {
    startDiscoveryScheduler();
    await vi.advanceTimersByTimeAsync(STARTUP_GRACE_MS + CHECK_INTERVAL_MS - 1);
    expect(findMany).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
