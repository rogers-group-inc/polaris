/**
 * tests/unit/timeout.test.ts — the shared promise deadline (utils/timeout.ts):
 * passes a value or rejection through, rejects with a TimeoutError on the
 * deadline, and never leaves its timer pending once the race is decided.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { withTimeout, TimeoutError } from "../../src/utils/timeout.js";

afterEach(() => { vi.useRealTimers(); });

describe("withTimeout", () => {
  it("resolves with the promise's value and clears its timer", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve(42), 1000, "x")).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the promise's own rejection through and clears its timer", async () => {
    vi.useFakeTimers();
    const boom = new Error("boom");
    await expect(withTimeout(Promise.reject(boom), 1000, "x")).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with a TimeoutError naming the operation when the deadline passes", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<never>(() => {}), 250, "dns lookup");
    const assertion = expect(pending).rejects.toSatisfy((err: unknown) =>
      err instanceof TimeoutError
      && err.name === "TimeoutError"
      && err.message === "dns lookup timed out after 250 ms");
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not fire before the deadline", async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = withTimeout(new Promise<never>(() => {}), 250).catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it("a late settle after the timeout changes nothing", async () => {
    vi.useFakeTimers();
    let resolveLate!: (v: number) => void;
    const late = new Promise<number>((r) => { resolveLate = r; });
    const pending = withTimeout(late, 100, "slow");
    const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    resolveLate(1);
    await assertion;
  });

  it("defaults the label to 'operation'", async () => {
    vi.useFakeTimers();
    const assertion = expect(withTimeout(new Promise<never>(() => {}), 5)).rejects.toThrow("operation timed out after 5 ms");
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
  });
});
