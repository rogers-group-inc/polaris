/**
 * tests/unit/memoryForecastCountdown.test.ts — a memory forecast counts down
 * to the NEXT severity level the host has not reached ("Days until Serious",
 * then past serious "Days until Critical"), its levels can be a
 * memory-utilization automation's, and its email draws the forecast instead of
 * the CPU chart. Pins the reading's placement on the tier ladder, the link, the
 * countdown tokens and headline, and the forecast chart.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { forecastLevelReading, nextForecastLevel } from "../../src/services/memoryForecastService.js";
import {
  forecastLevelsOf,
  linkForecastLevels,
  isForecastLevelSource,
  forecastLevelsSourceId,
  severityForValue,
  triggerSchema,
} from "../../src/services/notificationTypes.js";
import { buildTemplateContext, forecastCountdown } from "../../src/utils/notificationTemplate.js";
import {
  memoryForecastChartSpec,
  memoryForecastTargetFromRule,
  chartTokensForAlert,
  isMemoryForecastAlert,
  buildAlertCharts,
} from "../../src/services/alertChartService.js";

const SERIOUS_85_CRITICAL_90 = forecastLevelsOf(
  { type: "asset_metric", metric: "memForecastPct", operator: ">=", threshold: 85 },
  "serious",
  [{ threshold: 90, severity: "critical", actions: [] }],
);
const BANDS = [{ threshold: 90, severity: "critical" as const }];

describe("forecastLevelsOf", () => {
  it("lists the base tier and every band, lowest first, with each comparison", () => {
    expect(SERIOUS_85_CRITICAL_90).toEqual([
      { threshold: 85, severity: "serious", strict: false },
      { threshold: 90, severity: "critical", strict: false },
    ]);
  });

  it("drops a downward comparison — a forecast projects growth", () => {
    expect(forecastLevelsOf({ operator: "<=", threshold: 85 }, "warning", null)).toEqual([]);
  });
});

describe("the countdown reading", () => {
  it("counts down to the lowest level not reached yet", () => {
    expect(nextForecastLevel(80, SERIOUS_85_CRITICAL_90)?.severity).toBe("serious");
    expect(nextForecastLevel(87, SERIOUS_85_CRITICAL_90)?.severity).toBe("critical");
    expect(nextForecastLevel(92, SERIOUS_85_CRITICAL_90)).toBeNull();
  });

  it("lands on serious even when critical is also inside the window", () => {
    // 80% growing 1/day reaches 94% in 14 days, past BOTH levels, but the next
    // level is serious, so the reading is capped short of critical.
    const v = forecastLevelReading(80, 1, 14, SERIOUS_85_CRITICAL_90)!;
    expect(v).toBeGreaterThanOrEqual(85);
    expect(v).toBeLessThan(90);
    expect(severityForValue(">=", 85, "serious", BANDS, v)).toBe("serious");
  });

  it("past serious, counts down to critical", () => {
    const v = forecastLevelReading(87, 1, 14, SERIOUS_85_CRITICAL_90)!;
    expect(severityForValue(">=", 85, "serious", BANDS, v)).toBe("critical");
  });

  it("is quiet when the next level is out of reach, every level is passed, or memory is not growing", () => {
    // 87% + 0.1 x 14 = 88.4: serious is already passed and critical is not
    // reached in the window, so there is nothing to forecast.
    expect(forecastLevelReading(87, 0.1, 14, SERIOUS_85_CRITICAL_90)).toBeNull();
    expect(forecastLevelReading(92, 1, 14, SERIOUS_85_CRITICAL_90)).toBeNull();
    expect(forecastLevelReading(80, 0, 14, SERIOUS_85_CRITICAL_90)).toBeNull();
  });

  it("respects a strict comparison on the level after the next", () => {
    const strict = [
      { threshold: 85, severity: "serious", strict: false },
      { threshold: 90, severity: "critical", strict: true },
    ];
    // `> 90` is not met AT 90, so 90 itself is the cap.
    expect(forecastLevelReading(80, 1, 14, strict)).toBe(90);
  });
});

describe("linked levels", () => {
  const forecast = {
    trigger: { type: "asset_metric", metric: "memForecastPct", operator: ">=", threshold: 80, forecastDays: 14, levelsFromRuleId: "r-mem" },
    severity: "warning",
    severityBands: [{ threshold: 95, severity: "critical" as const, actions: [{ type: "notify" }] as never[] }],
  };
  const source = {
    trigger: { type: "asset_metric", metric: "memPct", operator: ">=", threshold: 85 },
    severity: "serious",
    severityBands: [{ threshold: 90, severity: "critical" as const, actions: [] }],
  };

  it("stores the link on the trigger", () => {
    expect(triggerSchema.safeParse(forecast.trigger).success).toBe(true);
  });

  it("names its source only on a forecast metric", () => {
    expect(forecastLevelsSourceId(forecast.trigger)).toBe("r-mem");
    expect(forecastLevelsSourceId({ ...forecast.trigger, metric: "memPct" })).toBeNull();
  });

  it("accepts only a single upward memory-utilization condition as a source", () => {
    expect(isForecastLevelSource(source.trigger, "memForecastPct")).toBe(true);
    expect(isForecastLevelSource({ ...source.trigger, metric: "cpuPct" }, "memForecastPct")).toBe(false);
    expect(isForecastLevelSource({ ...source.trigger, operator: "<" }, "memForecastPct")).toBe(false);
  });

  it("takes the source's thresholds and severities, keeping the forecast's own actions per severity", () => {
    const out = linkForecastLevels(forecast, source);
    expect(out.severity).toBe("serious");
    expect((out.trigger as { threshold: number }).threshold).toBe(85);
    expect((out.trigger as { forecastDays: number }).forecastDays).toBe(14);
    expect(out.severityBands).toEqual([{ threshold: 90, severity: "critical", actions: [{ type: "notify" }] }]);
  });

  it("keeps its own levels when the source cannot lend them", () => {
    expect(linkForecastLevels(forecast, null)).toBe(forecast);
    expect(linkForecastLevels(forecast, { ...source, trigger: { ...source.trigger, metric: "cpuPct" } })).toBe(forecast);
  });
});

describe("the countdown message", () => {
  const forecast = { usedPct: 79, slopePerDay: 0.5, levels: SERIOUS_85_CRITICAL_90 };

  it("names the level at the alert's severity, and the days to it", () => {
    expect(forecastCountdown(forecast, "serious")).toMatchObject({ level: "Serious", days: "12", target: "85 %" });
    expect(forecastCountdown(forecast, "critical")).toMatchObject({ level: "Critical", days: "22", target: "90 %" });
  });

  it("says <1 for under a day", () => {
    expect(forecastCountdown({ usedPct: 84.9, slopePerDay: 1, levels: SERIOUS_85_CRITICAL_90 }, "serious")?.days).toBe("<1");
  });

  it("headlines the email with the countdown and the change per day", () => {
    const ctx = buildTemplateContext({ severity: "serious", triggerSummary: "generic", forecast });
    expect(ctx["forecast.level"]).toBe("Serious");
    expect(ctx["forecast.days"]).toBe("12");
    expect(ctx["trigger.summary"]).toBe("Days until Serious: 12 — memory is 79 % and growing 0.5 %/day toward Serious at 85 %");
  });

  it("leaves every other alert's tokens blank and its summary alone", () => {
    const ctx = buildTemplateContext({ severity: "warning", triggerSummary: "CPU is 97 %" });
    expect(ctx["forecast.days"]).toBe("");
    expect(ctx["trigger.summary"]).toBe("CPU is 97 %");
  });
});

describe("the forecast email chart", () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 9, 26);

  it("draws memory alone on a memory forecast — no CPU", () => {
    expect(isMemoryForecastAlert("memForecastPct")).toBe(true);
    expect(isMemoryForecastAlert("memDaysUntilFull")).toBe(true);
    const none = { port: false, sensor: false, mount: false };
    expect([...chartTokensForAlert(["chart.cpu", "chart.memory", "chart.responseTime"], "memForecastPct", none)]).toEqual(["chart.memory"]);
    // A plain memory alert keeps both load charts.
    expect([...chartTokensForAlert(["chart.cpu", "chart.memory"], "memPct", none)]).toEqual(["chart.cpu", "chart.memory"]);
  });

  it("projects the trend toward the level, with the change per day in the caption", () => {
    const points = Array.from({ length: 10 }, (_, i) => ({ t: now - (9 - i) * DAY, v: 70 + i * 0.5 }));
    const spec = memoryForecastChartSpec(
      { points, slopePerDay: 0.5, daysUntilFull: 50, minPoints: 7, lookbackDays: 30 },
      { targetPct: 85, levelName: "Serious", horizonDays: 14 },
      now,
    );
    expect(spec.threshold).toBe(85);
    expect(spec.thresholdLegend).toBe("Serious level");
    expect(spec.projection).toHaveLength(2);
    expect(spec.to).toBe(now + 14 * DAY);
    expect(spec.caption).toContain("/day");
    expect(spec.caption).toContain("Serious (85");
    expect(spec.summary).toContain("growing 0.5");
  });

  it("says so when memory is no longer growing", () => {
    const spec = memoryForecastChartSpec(
      { points: [{ t: now, v: 70 }], slopePerDay: -0.2, daysUntilFull: null, minPoints: 7, lookbackDays: 30 },
      { targetPct: 85, levelName: "Serious", horizonDays: 14 },
      now,
    );
    expect(spec.projection).toEqual([]);
    expect(spec.caption).toContain("no longer growing");
  });

  it("builds a test alert's charts as the forecast alone", async () => {
    const charts = await buildAlertCharts(null, ["chart.cpu", "chart.memory"], {
      sampleData: true,
      metric: "memForecastPct",
      memoryForecast: { targetPct: 85, levelName: "Serious", horizonDays: 14 },
    });
    expect([...charts.keys()]).toEqual(["chart.memory"]);
    const mem = charts.get("chart.memory")!;
    expect(mem.summary).toMatch(/^Memory forecast .*growing .*\/day, reaches Serious \(85/);
  });

  it("resolves the level the alert's severity counts down to", () => {
    const rule = {
      trigger: { type: "asset_metric", metric: "memForecastPct", operator: ">=", threshold: 85, forecastDays: 21 },
      severity: "serious",
      severityBands: [{ threshold: 90, severity: "critical" as const, actions: [] }],
    };
    expect(memoryForecastTargetFromRule(rule, "critical")).toEqual({ targetPct: 90, levelName: "Critical", horizonDays: 21 });
    expect(memoryForecastTargetFromRule(rule, "serious")).toEqual({ targetPct: 85, levelName: "Serious", horizonDays: 21 });
    expect(memoryForecastTargetFromRule(
      { trigger: { type: "asset_metric", metric: "memDaysUntilFull", threshold: 10 }, severity: "warning", severityBands: null },
      "warning",
    )).toEqual({ targetPct: 100, levelName: null, horizonDays: 10 });
  });
});
