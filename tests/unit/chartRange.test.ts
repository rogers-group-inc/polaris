/**
 * tests/unit/chartRange.test.ts — the shared history-endpoint window
 * (`?range=` presets, `?from=&to=` custom) and its one-bucket lookback,
 * lifted out of routes/assets.ts so the path-checks route reads the same.
 */

import { describe, it, expect } from "vitest";
import { resolveRange, extendSinceForLookback, RANGE_MS } from "../../src/utils/chartRange.js";

describe("resolveRange", () => {
  it("resolves a preset ending now, and falls back to 24h", () => {
    const r = resolveRange({ query: { range: "7d" } });
    expect(r.rangeLabel).toBe("7d");
    expect(+r.until - +r.since).toBe(RANGE_MS["7d"]);
    const d = resolveRange({ query: { range: "nope" } });
    expect(+d.until - +d.since).toBe(RANGE_MS["24h"]);
    expect(resolveRange({ query: {} }).rangeLabel).toBe("24h");
  });
  it("takes a custom from/to and refuses a backwards, unparseable or over-a-year one", () => {
    const r = resolveRange({ query: { from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00Z" } });
    expect(r).toMatchObject({ rangeLabel: "custom" });
    expect(r.since.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(() => resolveRange({ query: { from: "2026-09-02", to: "2026-09-01" } })).toThrow(/before/);
    expect(() => resolveRange({ query: { from: "x", to: "y" } })).toThrow(/Invalid/);
    expect(() => resolveRange({ query: { from: "2024-01-01", to: "2026-01-01" } })).toThrow(/1 year/);
  });
});

describe("extendSinceForLookback", () => {
  const since = new Date("2026-09-30T12:00:00Z");
  it("reaches back 5 minutes on the detail tier and one bucket on a rollup tier", () => {
    expect(+since - +extendSinceForLookback(since, 0)).toBe(5 * 60_000);
    expect(+since - +extendSinceForLookback(since, 3600)).toBe(3_600_000);
  });
});
