import { describe, it, expect } from "vitest";
import { RATE_COUNTER_MAX_GAP_MS, RateCounters } from "../../src/utils/rateCounters.js";

describe("RateCounters", () => {
  it("starts at 0, then integrates the rate over the elapsed time", () => {
    const c = new RateCounters();
    expect(c.advance("eth0", 100, 0)).toBe(0);
    expect(c.advance("eth0", 100, 10_000)).toBe(1000);
    expect(c.advance("eth0", 50, 20_000)).toBe(1500);
  });

  it("keeps keys apart", () => {
    const c = new RateCounters();
    c.advance("a", 10, 0);
    c.advance("b", 99, 0);
    expect(c.advance("a", 10, 1000)).toBe(10);
    expect(c.advance("b", 99, 1000)).toBe(99);
  });

  it("restarts at 0 after a gap longer than the limit — a reset, never invented traffic", () => {
    const c = new RateCounters();
    c.advance("eth0", 100, 0);
    c.advance("eth0", 100, 1000);
    expect(c.advance("eth0", 100, 1000 + RATE_COUNTER_MAX_GAP_MS + 1)).toBe(0);
  });

  it("answers null for a missing or negative rate, without touching the counter", () => {
    const c = new RateCounters();
    c.advance("eth0", 100, 0);
    expect(c.advance("eth0", null, 1000)).toBeNull();
    expect(c.advance("eth0", -5, 1000)).toBeNull();
    expect(c.advance("eth0", 100, 2000)).toBe(200);
  });

  it("forgets keys not advanced since the cutoff", () => {
    const c = new RateCounters();
    c.advance("old", 10, 0);
    c.advance("new", 10, 5000);
    c.prune(1000);
    expect(c.advance("old", 10, 6000)).toBe(0);
    expect(c.advance("new", 10, 6000)).toBe(10);
  });
});
