/**
 * tests/unit/memoryForecastLevels.test.ts — the memForecastPct automation
 * metric: memory in use projected `forecastDays` out, so the base threshold
 * and every severity band are TARGET LEVELS sharing one horizon ("reaches 80%
 * within 14 days" warning, "reaches 95%" critical). Pins the pure projection,
 * the SQL-row mapping (mocked $queryRawUnsafe), the trigger schema, the tier
 * ladder it rides, the alert wording and the wizard's sentence for it.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

vi.mock("../../src/db.js", () => ({
  prisma: { $queryRawUnsafe: vi.fn() },
}));

import { computeMemoryProjection, projectMemoryPct } from "../../src/services/memoryForecastService.js";
import {
  ASSET_METRICS,
  METRIC_META,
  FORECAST_DAYS_DEFAULT,
  FORECAST_HORIZON_METRICS,
  forecastDaysOf,
  severityForValue,
  triggerSchema,
} from "../../src/services/notificationTypes.js";
import { chartTokenForMetric, isResourceScopedAlert } from "../../src/services/alertChartService.js";
import { processRankingForMetric } from "../../src/services/alertProcessService.js";
import { METRIC_STREAM } from "../../src/services/notificationCadenceService.js";
import { triggerSummary, triggerSubject } from "../../src/utils/triggerSummary.js";
import { prisma } from "../../src/db.js";

const rawUnsafe = prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("projectMemoryPct", () => {
  it("projects the newest day's level forward along the slope", () => {
    // 70% growing 1 point a day → 84% in 14 days.
    expect(projectMemoryPct(70, 1, 14)).toBe(84);
    expect(projectMemoryPct(70, 0.25, 30)).toBe(77.5);
  });

  it("caps at 100%", () => {
    expect(projectMemoryPct(90, 2, 14)).toBe(100);
  });

  it("has no projection for a flat or shrinking host", () => {
    expect(projectMemoryPct(85, 0, 14)).toBeNull();
    expect(projectMemoryPct(85, -0.5, 14)).toBeNull();
  });
});

describe("computeMemoryProjection", () => {
  it("reads every fitted host, growing or not, and projects the growing ones", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "grow", slope_per_day: 1, points: 30, last_pct: 70 },
      { assetId: "flat", slope_per_day: 0, points: 30, last_pct: 85 },
      { assetId: "shrink", slope_per_day: -1, points: 30, last_pct: 60 },
      { assetId: "nofit", slope_per_day: null, points: 30, last_pct: 50 },
    ]);
    const r = await computeMemoryProjection(["grow", "flat", "shrink", "nofit"], 14);
    expect(Object.fromEntries(r.map((x) => [x.assetId, x.projectedPct]))).toEqual({
      grow: 84, flat: null, shrink: null, nofit: null,
    });
    // No growing-only gate in SQL: a host whose growth stopped must still
    // produce a (null) reading, or its live alert would never end.
    const [sql, , minPoints] = rawUnsafe.mock.calls[0];
    expect(sql).not.toMatch(/regr_slope\([^)]*\)[^,]*>\s*0/);
    expect(minPoints).toBe(7);
  });

  it("does not query at all for an empty asset list", async () => {
    expect(await computeMemoryProjection([], 14)).toEqual([]);
    expect(rawUnsafe).not.toHaveBeenCalled();
  });
});

describe("memForecastPct registration", () => {
  it("is a % asset metric read over a horizon", () => {
    expect(ASSET_METRICS).toContain("memForecastPct");
    expect(METRIC_META.memForecastPct).toEqual({ label: "Memory forecast", unit: "%" });
    expect(FORECAST_HORIZON_METRICS).toContain("memForecastPct");
    expect(METRIC_STREAM.memForecastPct).toBe("cpuMemory");
  });

  it("charts and ranks like the other memory alerts", () => {
    expect(chartTokenForMetric("memForecastPct")).toBe("chart.memory");
    expect(isResourceScopedAlert("memForecastPct")).toBe(true);
    expect(processRankingForMetric("memForecastPct")).toBe("memory");
  });

  it("stores forecastDays on the trigger, 1–365 whole days", () => {
    const base = { type: "asset_metric", metric: "memForecastPct", operator: ">=", threshold: 80 };
    const ok = triggerSchema.safeParse({ ...base, forecastDays: 14 });
    expect(ok.success).toBe(true);
    expect(ok.success && (ok.data as { forecastDays?: number }).forecastDays).toBe(14);
    expect(triggerSchema.safeParse({ ...base, forecastDays: 0 }).success).toBe(false);
    expect(triggerSchema.safeParse({ ...base, forecastDays: 366 }).success).toBe(false);
    expect(triggerSchema.safeParse({ ...base, forecastDays: 2.5 }).success).toBe(false);
  });

  it("defaults the horizon when the trigger states none", () => {
    expect(forecastDaysOf({})).toBe(FORECAST_DAYS_DEFAULT);
    expect(forecastDaysOf({ forecastDays: 30 })).toBe(30);
  });

  it("lets each severity level be the target it warns about", () => {
    // Warning at 80%, critical at 95%, one horizon: the reading is the
    // projected level, so the ordinary tier ladder answers "which level is
    // reached within N days".
    const bands = [{ threshold: 95, severity: "critical" as const }];
    expect(severityForValue(">=", 80, "warning", bands, 84)).toBe("warning");
    expect(severityForValue(">=", 80, "warning", bands, 100)).toBe("critical");
    expect(severityForValue(">=", 80, "warning", bands, 72)).toBeNull();
    expect(severityForValue(">=", 80, "warning", bands, null)).toBeNull();
  });
});

describe("memForecastPct alert wording", () => {
  const trigger = { type: "asset_metric", metric: "memForecastPct", operator: ">=", threshold: 80, forecastDays: 14 };

  it("names the horizon where an aggregation would go", () => {
    expect(triggerSubject(trigger)).toBe("Memory forecast (14 days out)");
  });

  it("says what level memory reaches, and within how long", () => {
    expect(triggerSummary({ trigger, value: 86 })).toBe("Memory is projected to reach 86 % within 14 days");
    expect(triggerSummary({ trigger: { ...trigger, forecastDays: 1 }, value: 81 })).toBe("Memory is projected to reach 81 % within 1 day");
  });

  it("states the condition when there is no reading", () => {
    expect(triggerSummary({ trigger, value: null })).toBe("Memory forecast (14 days out) is at or above 80 %");
  });
});

describe("memForecastPct in the wizard sentence", () => {
  let make: (s: Record<string, unknown>) => { triggerSentence: (tr: Record<string, unknown>, opts?: Record<string, unknown>) => string };

  beforeAll(() => {
    const here = dirname(fileURLToPath(import.meta.url));
    const code = readFileSync(resolve(here, "../../public/js/automations-wizard.js"), "utf8");
    const sandbox: Record<string, any> = {
      window: {},
      document: { addEventListener() {}, getElementById: () => null },
      escapeHtml: (x: unknown) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      api: {},
      permAtLeast: () => true,
      showToast: () => {},
    };
    sandbox.window.document = sandbox.document;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    make = sandbox.window.PolarisAutomationSentences.make;
  });

  const SCHEMA = {
    triggerTypes: [{ type: "asset_metric", label: "Device metric", scoped: true }],
    metricMeta: { memForecastPct: { label: "Memory forecast", unit: "%" } },
    forecastHorizonMetrics: ["memForecastPct"],
    forecastDaysDefault: 14,
  };

  it("reads the horizon and every level the automation escalates through", () => {
    const out = make(SCHEMA).triggerSentence(
      { type: "asset_metric", metric: "memForecastPct", operator: ">=", threshold: 80, aggregation: "latest", forecastDays: 21 },
      { severity: "warning", severityBands: [{ threshold: 95, severity: "critical" }] },
    );
    expect(out).toContain("Memory forecast (21 days out) is at or above 80 %");
    expect(out).toContain("critical</strong> at or above 95 %");
  });

  it("falls back to the default horizon on a trigger that states none", () => {
    const out = make(SCHEMA).triggerSentence({ type: "asset_metric", metric: "memForecastPct", operator: ">=", threshold: 80, aggregation: "latest" });
    expect(out).toContain("Memory forecast (14 days out)");
  });
});
