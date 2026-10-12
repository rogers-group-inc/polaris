/**
 * tests/unit/chartSeverity.test.ts — severity shading math for asset-detail
 * charts (public/js/chart-severity.js, off window.PolarisChartSeverity).
 *
 * The load-bearing behavior is CLAMPING, not the happy path: a chart whose whole
 * visible range sits above the critical threshold must come out entirely
 * critical, and a threshold far outside the range must add nothing rather than
 * emitting stops off the ends of the gradient. Also pinned: "most severe MET
 * tier wins" (mirroring the engine, where per-tier thresholds need not be
 * monotonic), both comparison directions on one ladder (too hot AND too cold),
 * and the un-watched case returning no stops so callers keep their flat stroke.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

interface Tier { severity: string; operator: string; threshold: number; ruleId?: string; ruleName?: string }
interface Stop { offset: number; color: string }

let CS: {
  BASE_COLOR: string;
  colorOf: (s: string | null) => string;
  severityAt: (tiers: Tier[], v: number) => string | null;
  gradientStops: (tiers: Tier[], minV: number, maxV: number, opts?: { fade?: number }) => Stop[];
  visibleTiers: (tiers: Tier[], minV: number, maxV: number) => Tier[];
  tierLabel: (t: Tier, unit?: string) => string;
};

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(resolve(here, "../../public/js/chart-severity.js"), "utf8");
  const sandbox: Record<string, any> = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  CS = sandbox.window.PolarisChartSeverity;
});

const SERIOUS = "var(--color-sev-serious)";
const CRITICAL = "var(--color-sev-critical)";
const WARNING = "var(--color-sev-warning)";

/** The operator's automation from the screenshots: serious ≥35, critical ≥40. */
const HOT: Tier[] = [
  { severity: "serious", operator: ">=", threshold: 35 },
  { severity: "critical", operator: ">=", threshold: 40 },
];

const colorsOf = (stops: Stop[]) => Array.from(new Set(stops.map((s) => s.color)));

describe("severityAt", () => {
  it("returns the most severe tier the value satisfies", () => {
    expect(CS.severityAt(HOT, 20)).toBeNull();
    expect(CS.severityAt(HOT, 35)).toBe("serious");
    expect(CS.severityAt(HOT, 39.9)).toBe("serious");
    expect(CS.severityAt(HOT, 40)).toBe("critical");
    expect(CS.severityAt(HOT, 77)).toBe("critical");
  });

  it("respects the comparison direction (too cold)", () => {
    const cold: Tier[] = [
      { severity: "serious", operator: "<=", threshold: 5 },
      { severity: "critical", operator: "<=", threshold: 0 },
    ];
    expect(CS.severityAt(cold, 10)).toBeNull();
    expect(CS.severityAt(cold, 5)).toBe("serious");
    expect(CS.severityAt(cold, -2)).toBe("critical");
  });

  it("takes the most severe MET tier even when thresholds aren't monotonic", () => {
    // The engine allows this (validateSeverityBands only enforces increasing
    // severities), so the chart must not assume ordered thresholds.
    const odd: Tier[] = [
      { severity: "warning", operator: ">=", threshold: 50 },
      { severity: "critical", operator: ">=", threshold: 40 },
    ];
    expect(CS.severityAt(odd, 45)).toBe("critical");
    expect(CS.severityAt(odd, 55)).toBe("critical");
  });

  it("ignores unusable tiers (equality operators, non-finite thresholds)", () => {
    expect(CS.severityAt([{ severity: "critical", operator: "==", threshold: 40 }], 40)).toBeNull();
    expect(CS.severityAt([{ severity: "critical", operator: ">=", threshold: NaN }], 99)).toBeNull();
    expect(CS.severityAt([{ severity: "not-a-severity", operator: ">=", threshold: 1 }], 9)).toBeNull();
  });
});

describe("gradientStops", () => {
  it("returns no stops when nothing watches the metric, so the flat stroke stands", () => {
    expect(CS.gradientStops([], 20, 50)).toEqual([]);
  });

  it("returns no stops when every threshold is above the visible range", () => {
    // Data 10–20 °C, thresholds 35/40: nothing to shade.
    expect(CS.gradientStops(HOT, 10, 20)).toEqual([]);
  });

  it("shades the WHOLE line when the range sits entirely above critical", () => {
    // The FARMINGTON case: 67–77 °C against a 40 °C critical tier.
    const stops = CS.gradientStops(HOT, 67, 77);
    expect(colorsOf(stops)).toEqual([CRITICAL]);
    expect(stops[0].offset).toBe(0);
    expect(stops[stops.length - 1].offset).toBe(1);
  });

  it("stacks base → serious → critical from the bottom up", () => {
    const stops = CS.gradientStops(HOT, 20, 50);
    // Top of the chart is the hottest, so critical comes first.
    expect(stops[0].color).toBe(CRITICAL);
    expect(stops[stops.length - 1].color).toBe(CS.BASE_COLOR);
    expect(colorsOf(stops)).toEqual([CRITICAL, SERIOUS, CS.BASE_COLOR]);
  });

  it("emits monotonically increasing offsets within 0..1", () => {
    const stops = CS.gradientStops(HOT, 20, 50);
    const offsets = stops.map((s) => s.offset);
    expect(offsets[0]).toBeGreaterThanOrEqual(0);
    expect(offsets[offsets.length - 1]).toBeLessThanOrEqual(1);
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1]);
  });

  it("puts the transition AT the threshold, fading around it", () => {
    // 35 °C in a 20–50 domain sits at offset (50-35)/30 = 0.5; the serious band
    // starts there, so a fade of 0.05 straddles it.
    const stops = CS.gradientStops(HOT, 20, 50, { fade: 0.05 });
    const firstSerious = stops.find((s) => s.color === SERIOUS)!;
    const lastSerious = stops.filter((s) => s.color === SERIOUS).pop()!;
    expect(lastSerious.offset).toBeGreaterThan(0.4);
    expect(lastSerious.offset).toBeLessThan(0.6);
    expect(firstSerious.offset).toBeLessThan(lastSerious.offset);
  });

  it("colors BOTH ends when a ladder watches too-hot and too-cold", () => {
    const both: Tier[] = [
      { severity: "warning", operator: ">=", threshold: 35 },
      { severity: "warning", operator: "<=", threshold: 5 },
    ];
    const stops = CS.gradientStops(both, -10, 50);
    expect(stops[0].color).toBe(WARNING);                      // top (hot)
    expect(stops[stops.length - 1].color).toBe(WARNING);       // bottom (cold)
    expect(colorsOf(stops)).toContain(CS.BASE_COLOR);          // comfortable middle
  });

  it("survives a degenerate domain without emitting garbage", () => {
    expect(CS.gradientStops(HOT, 40, 40)).toEqual([]);
    expect(CS.gradientStops(HOT, 50, 20)).toEqual([]);
  });

  it("does not invert stops when two tiers are 1 degree apart", () => {
    const tight: Tier[] = [
      { severity: "serious", operator: ">=", threshold: 39 },
      { severity: "critical", operator: ">=", threshold: 40 },
    ];
    const stops = CS.gradientStops(tight, 20, 50);
    const offsets = stops.map((s) => s.offset);
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1]);
    expect(colorsOf(stops)).toEqual([CRITICAL, SERIOUS, CS.BASE_COLOR]);
  });
});

describe("threshold reference lines", () => {
  it("only lists thresholds inside the visible range", () => {
    expect(CS.visibleTiers(HOT, 20, 50).map((t) => t.threshold)).toEqual([35, 40]);
    expect(CS.visibleTiers(HOT, 67, 77)).toEqual([]);
    expect(CS.visibleTiers(HOT, 20, 38).map((t) => t.threshold)).toEqual([35]);
  });

  it("labels a tier the way the comparator reads", () => {
    expect(CS.tierLabel({ severity: "critical", operator: ">=", threshold: 40 }, "°C")).toBe("critical ≥ 40 °C");
    expect(CS.tierLabel({ severity: "serious", operator: "<", threshold: 0 })).toBe("serious < 0");
  });
});
