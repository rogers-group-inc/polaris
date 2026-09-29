import { describe, it, expect } from "vitest";
import { coreVector, coreConditionIsBelow, aggregateCores, coreSeries, coresToName, formatCoreList } from "../../src/utils/cpuCores.js";
import { evaluationOrder } from "../../src/services/notificationEngine.js";
import { dimensionNounOf, METRIC_META, ASSET_METRICS, leadingRun, rollingAggregate } from "../../src/services/notificationTypes.js";
import { processRankingForMetric } from "../../src/services/alertProcessService.js";
import { isResourceScopedAlert, chartTokenForMetric } from "../../src/services/alertChartService.js";

const above = { aggregation: "latest", windowPolls: 0, below: false };
const run = (series: number[], t: number) => leadingRun(series, (v) => v >= t);

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

describe("coreConditionIsBelow", () => {
  it("is true only for < and <=", () => {
    expect(coreConditionIsBelow("<")).toBe(true);
    expect(coreConditionIsBelow("<=")).toBe(true);
    expect(coreConditionIsBelow(">=")).toBe(false);
    expect(coreConditionIsBelow("==")).toBe(false);
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

describe("coreSeries — the hold is counted per core", () => {
  it("counts ONE core's run: the same core over the line three polls running", () => {
    // newest first; core 1 has been pinned for three polls
    const cs = coreSeries([[10, 97, 5], [12, 95, 8], [9, 96, 11], [60, 20, 7]], above, rollingAggregate)!;
    expect(run(cs.series, 90)).toBe(3);
    expect(cs.value).toBe(97);
  });

  it("does NOT count a hot thread hopping between cores as a run", () => {
    // a different core is over 90 on each poll — ordinary load, not one thread
    const cs = coreSeries([[95, 10, 10], [10, 95, 10], [10, 10, 95]], above, rollingAggregate)!;
    expect(run(cs.series, 90)).toBe(1);
    // …while the per-poll busiest core WAS over the line every time
    expect(run(cs.clearSeries, 90)).toBe(3);
  });

  it("gives every severity tier its own per-core run off the same series", () => {
    const cs = coreSeries([[99, 91], [92, 99], [98, 93]], above, rollingAggregate)!;
    expect(run(cs.series, 90)).toBe(3); // both cores stayed over 90
    expect(run(cs.series, 95)).toBe(1); // no core stayed over 95 twice running
  });

  it("recovery counts off the busiest core of each poll", () => {
    const cs = coreSeries([[40, 50], [45, 30], [99, 20]], above, rollingAggregate)!;
    expect(leadingRun(cs.clearSeries, (v) => v < 75)).toBe(2);
  });

  it("a `<` condition runs on the coolest core", () => {
    const cs = coreSeries([[3, 50], [2, 60], [40, 1]], { ...above, below: true }, rollingAggregate)!;
    expect(leadingRun(cs.series, (v) => v <= 5)).toBe(2);
    expect(cs.value).toBe(3);
  });

  it("a count window counts each core's disjoint poll groups", () => {
    const cs = coreSeries([[96, 0], [94, 0], [92, 0], [98, 0], [20, 0], [30, 0]], { aggregation: "avg", windowPolls: 2, below: false }, rollingAggregate)!;
    expect(cs.perCore[0]).toEqual([95, 95, 25]);
    expect(run(cs.series, 90)).toBe(2);
  });

  it("a time window's value is the extreme per-core aggregate", () => {
    const cs = coreSeries([[90, 10], [70, 30]], { aggregation: "avg", windowPolls: 0, below: false }, rollingAggregate)!;
    expect(cs.value).toBe(80);
  });

  it("ignores samples from a different core count and has nothing to say with no samples", () => {
    const cs = coreSeries([[95, 95], [95, 95, 95, 95], [95, 95]], above, rollingAggregate)!;
    expect(cs.series).toHaveLength(2);
    expect(coreSeries([], above, rollingAggregate)).toBeNull();
  });
});

describe("coresToName", () => {
  const meets = (v: number) => v >= 90;
  it("with a hold, names only the cores whose own run reached it", () => {
    const cs = coreSeries([[97, 93, 10], [96, 20, 10], [95, 20, 10]], above, rollingAggregate)!;
    expect(coresToName(cs, meets, 3, false)).toEqual([{ index: 0, pct: 97 }]);
  });
  it("without a hold, names every core currently over the line, hottest first", () => {
    const cs = coreSeries([[10, 93, 97]], above, rollingAggregate)!;
    expect(coresToName(cs, meets, 0, false)).toEqual([{ index: 2, pct: 97 }, { index: 1, pct: 93 }]);
  });
  it("falls back to the most extreme core when none qualifies", () => {
    const cs = coreSeries([[60, 85]], above, rollingAggregate)!;
    expect(coresToName(cs, meets, 3, false)).toEqual([{ index: 1, pct: 85 }]);
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
    expect(METRIC_META.cpuCorePct).toEqual({ label: "CPU core utilization", unit: "%" });
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
