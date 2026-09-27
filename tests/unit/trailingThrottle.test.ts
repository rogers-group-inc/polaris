/**
 * tests/unit/trailingThrottle.test.ts
 *
 * The discovery progress flush's throttle: the last call of a burst must
 * always be written, writes must not overlap, and stop() must fence off late
 * writes before a run's terminal update.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTrailingThrottle } from "../../src/utils/trailingThrottle.js";

describe("createTrailingThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the first call immediately", async () => {
    const fn = vi.fn(async () => {});
    const t = createTrailingThrottle(fn, 1_500);
    t.call();
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("writes the last call of a burst at the end of the window", async () => {
    // The discovery bug: the last gates complete inside the window, then the
    // run goes quiet. A leading-only throttle never wrote their completion.
    let state = "3 active";
    const written: string[] = [];
    const t = createTrailingThrottle(async () => { written.push(state); }, 1_500);
    t.call();
    await vi.advanceTimersByTimeAsync(0);
    state = "0 active";
    t.call();
    await vi.advanceTimersByTimeAsync(0);
    expect(written).toEqual(["3 active"]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(written).toEqual(["3 active", "0 active"]);
  });

  it("coalesces many calls in one window into one trailing run", async () => {
    const fn = vi.fn(async () => {});
    const t = createTrailingThrottle(fn, 1_500);
    t.call();
    for (let i = 0; i < 10; i++) t.call();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("force runs now and absorbs the pending trailing run", async () => {
    const fn = vi.fn(async () => {});
    const t = createTrailingThrottle(fn, 1_500);
    t.call();
    t.call(); // schedules a trailing run
    t.call(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("serializes writes so a slow one cannot land after a newer one", async () => {
    const order: string[] = [];
    let n = 0;
    const t = createTrailingThrottle(async () => {
      const id = ++n;
      order.push(`start${id}`);
      await new Promise((r) => setTimeout(r, id === 1 ? 1_000 : 10));
      order.push(`end${id}`);
    }, 1_500);
    t.call();
    t.call(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(order).toEqual(["start1", "end1", "start2", "end2"]);
  });

  it("a failing write does not block later writes", async () => {
    let calls = 0;
    const t = createTrailingThrottle(async () => {
      calls++;
      if (calls === 1) throw new Error("db hiccup");
    }, 1_500);
    t.call();
    t.call(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
  });

  it("stop cancels the pending run, waits for the in-flight one and refuses later calls", async () => {
    const written: number[] = [];
    let n = 0;
    const t = createTrailingThrottle(async () => {
      const id = ++n;
      await new Promise((r) => setTimeout(r, 100));
      written.push(id);
    }, 1_500);
    t.call();
    t.call(); // pending trailing run — must never fire
    const stopped = t.stop();
    await vi.advanceTimersByTimeAsync(100);
    await stopped;
    expect(written).toEqual([1]);
    t.call(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(written).toEqual([1]);
  });
});
