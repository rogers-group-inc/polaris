import { describe, it, expect } from "vitest";
import { coreVector, hottestCorePct, aggregateCores, coresOver, formatCoreList } from "../../src/utils/cpuCores.js";
import { evaluationOrder } from "../../src/services/notificationEngine.js";
import { dimensionNounOf, METRIC_META, ASSET_METRICS } from "../../src/services/notificationTypes.js";
import { processRankingForMetric } from "../../src/services/alertProcessService.js";
import { isResourceScopedAlert, chartTokenForMetric } from "../../src/services/alertChartService.js";

describe("coreVector", () => {
  it("keeps a finite-number array and refuses anything else", () => {
    expect(coreVector([1, 2.5])).toEqual([1, 2.5]);
    expect(coreVector([])).toBeNull();
    expect(coreVector([1, "2"])).toBeNull();
    expect(coreVector([1, NaN])).toBeNull();
    expect(coreVector(null)).toBeNull();
    expect(coreVector({ 0: 1 })).toBeNull();
  });
});

describe("hottestCorePct", () => {
  it("is the max core, or null without a vector", () => {
    expect(hottestCorePct([10, 97, 40])).toBe(97);
    expect(hottestCorePct(null)).toBeNull();
  });
});

describe("aggregateCores", () => {
  const newestFirst = [[90, 10], [70, 30], [80]];
  it("latest is the newest vector", () => {
    expect(aggregateCores(newestFirst, "latest")).toEqual([90, 10]);
  });
  it("averages each core over the samples that carry it", () => {
    expect(aggregateCores(newestFirst, "avg")).toEqual([80, 20]);
  });
  it("min / max / median per core", () => {
    expect(aggregateCores(newestFirst, "max")).toEqual([90, 30]);
    expect(aggregateCores(newestFirst, "min")).toEqual([70, 10]);
    expect(aggregateCores(newestFirst, "median")).toEqual([80, 20]);
  });
  it("is empty with no samples", () => {
    expect(aggregateCores([], "avg")).toEqual([]);
  });
});

describe("coresOver", () => {
  it("names every core meeting the condition, hottest first", () => {
    expect(coresOver([10, 97, 12, 93], (v) => v >= 90)).toEqual([{ index: 1, pct: 97 }, { index: 3, pct: 93 }]);
  });
  it("falls back to the hottest core when none meets it on its own", () => {
    expect(coresOver([60, 85, 70], (v) => v >= 90)).toEqual([{ index: 1, pct: 85 }]);
  });
  it("skips a core with no value", () => {
    expect(coresOver([NaN, 95], (v) => v >= 90)).toEqual([{ index: 1, pct: 95 }]);
    expect(coresOver([], () => true)).toEqual([]);
  });
});

describe("formatCoreList", () => {
  it("rounds and caps with a remainder", () => {
    expect(formatCoreList([{ index: 3, pct: 96.6 }, { index: 7, pct: 93.2 }])).toBe("Core 3 (97%), Core 7 (93%)");
    const many = Array.from({ length: 10 }, (_, i) => ({ index: i, pct: 99 }));
    expect(formatCoreList(many, 8)).toBe(`${many.slice(0, 8).map((c) => `Core ${c.index} (99%)`).join(", ")} and 2 more`);
    expect(formatCoreList([])).toBe("");
  });
});

describe("cpuCorePct wiring", () => {
  it("is an asset metric with its own label and a component noun", () => {
    expect(ASSET_METRICS).toContain("cpuCorePct");
    expect(METRIC_META.cpuCorePct).toEqual({ label: "Highest CPU core utilization", unit: "%" });
    expect(dimensionNounOf({ type: "asset_metric", metric: "cpuCorePct" })).toBe("CPU cores");
    expect(dimensionNounOf({ type: "asset_metric", metric: "cpuPct" })).toBe("");
  });
  it("gets the CPU-ranked top processes and the resource charts", () => {
    expect(processRankingForMetric("cpuCorePct")).toBe("cpu");
    expect(isResourceScopedAlert("cpuCorePct")).toBe(true);
    expect(chartTokenForMetric("cpuCorePct")).toBe("chart.cpu");
  });
});

describe("evaluationOrder (business rule 89)", () => {
  it("moves per-core CPU rules after every other rule, keeping order otherwise", () => {
    const r = (id: string, metric?: string) => ({ id, trigger: metric ? { type: "asset_metric", metric } : { type: "event" } });
    const out = evaluationOrder([r("core1", "cpuCorePct"), r("a", "cpuPct"), r("ev"), r("core2", "cpuCorePct"), r("b", "memPct")]);
    expect(out.map((x) => x.id)).toEqual(["a", "ev", "b", "core1", "core2"]);
  });
});
