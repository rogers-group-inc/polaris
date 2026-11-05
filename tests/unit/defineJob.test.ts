/**
 * tests/unit/defineJob.test.ts — src/jobs/_defineJob.ts (CQ-B041).
 *
 * Pins the schedule (first-run delay / at import / after one interval), that a
 * tick in flight is never run twice concurrently, that a failed tick is logged
 * once at error as { err, job } and the next tick still runs, that onError replaces the
 * default log, that metrics record success and failure, and that stop()
 * cancels both timers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { error, recordJobOutcome, startJobTimer } = vi.hoisted(() => ({
  error: vi.fn(),
  recordJobOutcome: vi.fn(),
  startJobTimer: vi.fn(() => () => {}),
}));
vi.mock("../../src/utils/logger.js", () => ({ logger: { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("../../src/metrics.js", () => ({ recordJobOutcome, startJobTimer }));

import { defineJob } from "../../src/jobs/_defineJob.js";

beforeEach(() => {
  vi.useFakeTimers();
  error.mockReset();
  recordJobOutcome.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("defineJob — schedule", () => {
  it("runs first after firstRunDelayMs, then every intervalMs", async () => {
    const run = vi.fn(async () => {});
    const job = defineJob({ name: "j", intervalMs: 60_000, firstRunDelayMs: 5_000, run });
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); // t = 65 s: the interval has fired once, at 60 s
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000); // t = 125 s: and again at 120 s
    expect(run).toHaveBeenCalledTimes(3);
    job.stop();
  });

  it("firstRunDelayMs: 0 runs at definition time", async () => {
    const run = vi.fn(async () => {});
    const job = defineJob({ name: "j", intervalMs: 60_000, firstRunDelayMs: 0, run });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    job.stop();
  });

  it("no firstRunDelayMs waits one interval", async () => {
    const run = vi.fn(async () => {});
    const job = defineJob({ name: "j", intervalMs: 30_000, run });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    job.stop();
  });

  it("stop() cancels the first run and the interval", async () => {
    const run = vi.fn(async () => {});
    const job = defineJob({ name: "j", intervalMs: 10_000, firstRunDelayMs: 1_000, run });
    job.stop();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("defineJob — overlap", () => {
  it("skips a tick while the previous one is still running", async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const job = defineJob({ name: "j", intervalMs: 10_000, run });
    await vi.advanceTimersByTimeAsync(10_000); // tick 1 starts, hangs
    await vi.advanceTimersByTimeAsync(30_000); // three more fire while it hangs
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
    job.stop();
  });
});

describe("defineJob — errors and metrics", () => {
  it("logs a failed tick once as { err, job } at error, and keeps ticking", async () => {
    const boom = new Error("boom");
    const run = vi.fn().mockRejectedValueOnce(boom).mockResolvedValue(undefined);
    const job = defineJob({ name: "myJob", intervalMs: 10_000, run });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith({ err: boom, job: "myJob" }, "myJob tick failed");
    expect(recordJobOutcome).toHaveBeenLastCalledWith("myJob", "failure");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(recordJobOutcome).toHaveBeenLastCalledWith("myJob", "success");
    job.stop();
  });

  it("onError replaces the default log", async () => {
    const onError = vi.fn();
    const boom = new Error("x");
    const job = defineJob({ name: "j", intervalMs: 10_000, run: async () => { throw boom; }, onError });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onError).toHaveBeenCalledWith(boom);
    expect(error).not.toHaveBeenCalled();
    job.stop();
  });

  it("tick() runs one pass on demand", async () => {
    const run = vi.fn(async () => {});
    const job = defineJob({ name: "j", intervalMs: 1_000_000, run });
    await job.tick();
    expect(run).toHaveBeenCalledTimes(1);
    job.stop();
  });
});
