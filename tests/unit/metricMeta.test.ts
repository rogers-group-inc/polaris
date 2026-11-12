/**
 * tests/unit/metricMeta.test.ts — per-metric metadata and dimension matchers
 * (src/services/notificationTypes/metricMeta.ts).
 *
 * Complements (does not repeat):
 *  - memoryForecastLevels.test.ts / memoryForecastCountdown.test.ts — the
 *    forecast horizon and level linking through the engine;
 *  - probeLossWindow.test.ts — the probe-loss window and saturation ceiling
 *    (business rule 29) through the engine and the email chart;
 *  - interfacePatternMatch.test.ts, interfaceTagFilter.test.ts,
 *    sdwanMemberIpFilter.test.ts, pathCheckAutomation.test.ts — the matchers.
 * New here: hwSensorFilterMatches (no test before), the catalogue's internal
 * consistency (every metric / state field has builder metadata, every
 * integral dimension is a real dimension of its field, the ceiling list is a
 * subset of the windowed-ratio list — rule 85's carve-out), and the edge
 * values of every helper: horizon clamping + rounding, downward operators
 * excluded from forecast levels, a linked forecast keeping its own actions,
 * the ceiling inert on other metrics, nested-group window lookup, member-IP
 * unknown-vs-unaddressed, and device dimensions refused on host metrics.
 * Pure module — no database, no network.
 */

import { describe, it, expect } from "vitest";
import {
  WINDOWED_RATIO_METRICS,
  SATURATION_CEILING_METRICS,
  FORECAST_HORIZON_METRICS,
  FORECAST_DAYS_DEFAULT,
  forecastDaysOf,
  forecastLevelsOf,
  forecastLevelsSourceId,
  isForecastLevelSource,
  linkForecastLevels,
  PROBE_LOSS_DEFAULT_WINDOW_SEC,
  PROBE_LOSS_MIN_WINDOW_SEC,
  readingAtOrAboveCeiling,
  probeLossWindowSec,
  probeLossWindowSecFromTrigger,
  METRIC_META,
  FIELD_META,
  CHANGE_TYPE_META,
  interfacePatternMatch,
  hwSensorFilterMatches,
  pathCheckFilterMatches,
  interfaceTagMatch,
  memberIpPasses,
  triggerDimensionApplicable,
} from "../../src/services/notificationTypes/metricMeta.js";
import { ASSET_METRICS, ASSET_STATE_FIELDS, HOST_METRICS, CHANGE_TYPES } from "../../src/services/notificationTypes/triggers.js";
import { FIELD_DIMENSIONS } from "../../src/services/notificationTypes/dimensions.js";
import type { SeverityBand } from "../../src/services/notificationTypes/actions.js";

describe("catalogue consistency", () => {
  it("every asset and host metric has a label + unit", () => {
    for (const m of [...ASSET_METRICS, ...HOST_METRICS]) {
      expect(METRIC_META[m], m).toBeDefined();
      expect(METRIC_META[m]!.label.length).toBeGreaterThan(0);
    }
  });

  it("every asset-state field has builder metadata, and enum / bool fields list their values", () => {
    for (const f of ASSET_STATE_FIELDS) {
      const meta = FIELD_META[f];
      expect(meta, f).toBeDefined();
      if (meta!.kind === "enum" || meta!.kind === "bool") expect(meta!.values?.length, f).toBeGreaterThan(0);
    }
  });

  it("an integral dimension is always one of that field's own dimensions", () => {
    for (const [field, meta] of Object.entries(FIELD_META)) {
      if (meta.integralDimension) expect(FIELD_DIMENSIONS[field], field).toContain(meta.integralDimension);
    }
  });

  it("every change type has a label", () => {
    for (const c of CHANGE_TYPES) expect(CHANGE_TYPE_META[c], c).toBeDefined();
  });

  it("rule 85: the ceiling applies to probe loss, never to the path failure rate", () => {
    for (const m of SATURATION_CEILING_METRICS) expect(WINDOWED_RATIO_METRICS).toContain(m);
    expect(SATURATION_CEILING_METRICS).not.toContain("pathFailurePct");
    for (const m of [...WINDOWED_RATIO_METRICS, ...FORECAST_HORIZON_METRICS]) expect(ASSET_METRICS).toContain(m);
  });
});

describe("forecast horizon + levels", () => {
  it("forecastDaysOf rounds, clamps to 365 and defaults below 1", () => {
    expect(forecastDaysOf({ forecastDays: 7.4 })).toBe(7);
    expect(forecastDaysOf({ forecastDays: 1000 })).toBe(365);
    expect(forecastDaysOf({ forecastDays: 0.5 })).toBe(FORECAST_DAYS_DEFAULT);
    expect(forecastDaysOf({ forecastDays: Number.POSITIVE_INFINITY })).toBe(FORECAST_DAYS_DEFAULT);
    expect(forecastDaysOf({ forecastDays: "14" })).toBe(FORECAST_DAYS_DEFAULT);
    expect(forecastDaysOf(null)).toBe(FORECAST_DAYS_DEFAULT);
  });

  it("forecastLevelsOf sorts lowest first, inherits the trigger's operator, and drops downward tiers", () => {
    const bands = [
      { threshold: 95, severity: "critical", operator: ">" },
      { threshold: 85, severity: "serious" },
      { threshold: 10, severity: "notice", operator: "<" },
    ] as SeverityBand[];
    expect(forecastLevelsOf({ operator: ">=", threshold: 80 }, "warning", bands)).toEqual([
      { threshold: 80, severity: "warning", strict: false },
      { threshold: 85, severity: "serious", strict: false },
      { threshold: 95, severity: "critical", strict: true },
    ]);
  });

  it("forecastLevelsOf: a downward trigger or no trigger has no levels; non-finite thresholds are skipped", () => {
    expect(forecastLevelsOf({ operator: "<", threshold: 80 }, "warning", null)).toEqual([]);
    expect(forecastLevelsOf(null, "warning", null)).toEqual([]);
    expect(forecastLevelsOf({ operator: ">", threshold: Number.NaN }, "warning", [{ threshold: 90, severity: "critical" } as SeverityBand])).toEqual([
      { threshold: 90, severity: "critical", strict: true },
    ]);
  });

  it("forecastLevelsSourceId names a source only on a forecast metric", () => {
    expect(forecastLevelsSourceId({ type: "asset_metric", metric: "memForecastPct", levelsFromRuleId: "r1" })).toBe("r1");
    expect(forecastLevelsSourceId({ type: "asset_metric", metric: "memForecastPct", levelsFromRuleId: "" })).toBeNull();
    expect(forecastLevelsSourceId({ type: "asset_metric", metric: "cpuPct", levelsFromRuleId: "r1" })).toBeNull();
    expect(forecastLevelsSourceId({ type: "host_metric", metric: "memForecastPct", levelsFromRuleId: "r1" })).toBeNull();
  });

  it("isForecastLevelSource: one upward condition on the source metric", () => {
    expect(isForecastLevelSource({ type: "asset_metric", metric: "memPct", operator: ">=", threshold: 80 }, "memForecastPct")).toBe(true);
    expect(isForecastLevelSource({ type: "asset_metric", metric: "memPct", operator: "<", threshold: 80 }, "memForecastPct")).toBe(false);
    expect(isForecastLevelSource({ type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 80 }, "memForecastPct")).toBe(false);
    expect(isForecastLevelSource({ type: "composite" }, "memForecastPct")).toBe(false);
    expect(isForecastLevelSource({ type: "asset_metric", metric: "memPct", operator: ">", threshold: 80 }, "cpuPct")).toBe(false);
  });

  it("linkForecastLevels takes the linked levels but keeps the forecast's own band actions and follow-ups", () => {
    const forecast = {
      trigger: { type: "asset_metric", metric: "memForecastPct", operator: ">", threshold: 70, forecastDays: 30 },
      severity: "notice",
      severityBands: [{ threshold: 1, severity: "critical", actions: [{ type: "notify", channelId: "mine" }], followUp: { requireAckNote: true } }] as SeverityBand[],
      actions: ["untouched"],
    };
    const linked = {
      trigger: { type: "asset_metric", metric: "memPct", operator: ">=", threshold: 80 },
      severity: "warning",
      severityBands: [
        { threshold: 90, severity: "serious", actions: [{ type: "notify", channelId: "theirs" }], forDurationSec: 600 },
        { threshold: 95, severity: "critical", operator: ">", actions: [] },
      ] as SeverityBand[],
    };
    const out = linkForecastLevels(forecast, linked);
    expect(out.trigger).toEqual({ type: "asset_metric", metric: "memForecastPct", operator: ">=", threshold: 80, forecastDays: 30 });
    expect(out.severity).toBe("warning");
    expect(out.actions).toEqual(["untouched"]);
    expect(out.severityBands).toEqual([
      { threshold: 90, severity: "serious", actions: [] },
      { threshold: 95, severity: "critical", operator: ">", actions: [{ type: "notify", channelId: "mine" }], followUp: { requireAckNote: true } },
    ]);
  });

  it("linkForecastLevels falls back to the stored levels when the source cannot lend them", () => {
    const forecast = { trigger: { metric: "memForecastPct" }, severity: "warning", severityBands: null };
    expect(linkForecastLevels(forecast, null)).toBe(forecast);
    expect(linkForecastLevels(forecast, { trigger: { type: "asset_metric", metric: "memPct", operator: "<", threshold: 1 }, severity: "x", severityBands: null })).toBe(forecast);
    const noBands = linkForecastLevels(forecast, { trigger: { type: "asset_metric", metric: "memPct", operator: ">", threshold: 50 }, severity: "serious", severityBands: [] });
    expect(noBands.severityBands).toBeNull();
  });
});

describe("probe-loss window + saturation ceiling (rule 29)", () => {
  it("probeLossWindowSec floors at 5 minutes and defaults to 15", () => {
    expect(probeLossWindowSec(60)).toBe(PROBE_LOSS_MIN_WINDOW_SEC);
    expect(probeLossWindowSec(3600)).toBe(3600);
    expect(probeLossWindowSec(0)).toBe(PROBE_LOSS_DEFAULT_WINDOW_SEC);
    expect(probeLossWindowSec(null)).toBe(PROBE_LOSS_DEFAULT_WINDOW_SEC);
  });

  it("probeLossWindowSecFromTrigger walks nested groups and takes the widest window", () => {
    const tree = {
      type: "composite",
      children: [
        { type: "asset_metric", metric: "cpuPct" },
        { op: "or", children: [{ type: "asset_metric", metric: "probeLossPct", windowSec: 600 }, { op: "and", children: [{ type: "asset_metric", metric: "probeLossPct", windowSec: 1800 }] }] },
      ],
    };
    expect(probeLossWindowSecFromTrigger(tree)).toBe(1800);
    expect(probeLossWindowSecFromTrigger({ type: "asset_metric", metric: "probeLossPct" })).toBe(PROBE_LOSS_DEFAULT_WINDOW_SEC);
    expect(probeLossWindowSecFromTrigger({ type: "asset_metric", metric: "cpuPct" })).toBeNull();
    expect(probeLossWindowSecFromTrigger("garbage")).toBeNull();
    expect(probeLossWindowSecFromTrigger(null)).toBeNull();
  });

  it("readingAtOrAboveCeiling: >= the stated ceiling, 100 by default, probe loss only", () => {
    const loss = { type: "asset_metric", metric: "probeLossPct" };
    expect(readingAtOrAboveCeiling(loss, 100)).toBe(true);
    expect(readingAtOrAboveCeiling(loss, 99.9)).toBe(false);
    expect(readingAtOrAboveCeiling({ ...loss, ignoreAtOrAbove: 90 }, 90)).toBe(true);
    expect(readingAtOrAboveCeiling({ ...loss, ignoreAtOrAbove: 90 }, 89)).toBe(false);
    expect(readingAtOrAboveCeiling({ type: "asset_metric", metric: "pathFailurePct", ignoreAtOrAbove: 50 }, 100)).toBe(false);
    expect(readingAtOrAboveCeiling({ type: "host_metric", metric: "probeLossPct" }, 100)).toBe(false);
    expect(readingAtOrAboveCeiling(loss, null)).toBe(false);
    expect(readingAtOrAboveCeiling(loss, Number.NaN)).toBe(false);
  });
});

describe("dimension matchers", () => {
  it("hwSensorFilterMatches: class must match exactly, name is a substring, no filter = any", () => {
    const fan = { sensorName: "FAN 2 Speed", sensorClass: "fan" };
    expect(hwSensorFilterMatches(null, fan)).toBe(true);
    expect(hwSensorFilterMatches({}, fan)).toBe(true);
    expect(hwSensorFilterMatches({ sensorClass: "fan" }, fan)).toBe(true);
    expect(hwSensorFilterMatches({ sensorClass: "temperature" }, fan)).toBe(false);
    expect(hwSensorFilterMatches({ sensorClass: "fan", sensorNamePattern: "fan 2" }, fan)).toBe(true);
    expect(hwSensorFilterMatches({ sensorClass: "fan", sensorNamePattern: "fan 3" }, fan)).toBe(false);
    expect(hwSensorFilterMatches({ sensorClass: "fan" }, { sensorName: "x", sensorClass: null })).toBe(false);
  });

  it("interfacePatternMatch reads name OR description over any-of terms", () => {
    expect(interfacePatternMatch("port25", "ATT EPLS", "att epls|wan1")).toBe(true);
    expect(interfacePatternMatch("wan1", null, "att epls | wan1")).toBe(true);
    expect(interfacePatternMatch("port3", "LAN", "wan")).toBe(false);
    expect(interfacePatternMatch(null, null, "")).toBe(true);
    expect(interfacePatternMatch(null, null, " | ")).toBe(true);
  });

  it("pathCheckFilterMatches compares the check id exactly", () => {
    expect(pathCheckFilterMatches(undefined, { checkId: "c1" })).toBe(true);
    expect(pathCheckFilterMatches({ checkId: "c1" }, { checkId: "c1" })).toBe(true);
    expect(pathCheckFilterMatches({ checkId: "c1" }, { checkId: "C1" })).toBe(false);
    expect(pathCheckFilterMatches({ checkId: "c1" }, { checkId: null })).toBe(false);
  });

  it("interfaceTagMatch matches whole tags case-insensitively", () => {
    expect(interfaceTagMatch(["Critical"], "critical")).toBe(true);
    expect(interfaceTagMatch(["priority-critical"], "critical")).toBe(false);
    expect(interfaceTagMatch(["uplink"], "core | uplink")).toBe(true);
    expect(interfaceTagMatch(null, "x")).toBe(false);
    expect(interfaceTagMatch(null, null)).toBe(true);
  });

  it("memberIpPasses: unknown is null; 0.0.0.0 matches every unaddressed shape", () => {
    expect(memberIpPasses({ operator: "!=", ip: "0.0.0.0" }, null)).toBeNull();
    expect(memberIpPasses({ operator: "!=", ip: "0.0.0.0" }, undefined)).toBeNull();
    expect(memberIpPasses({ operator: "!=", ip: "0.0.0.0" }, "")).toBe(false);
    expect(memberIpPasses({ operator: "!=", ip: "0.0.0.0" }, "0.0.0.0 0.0.0.0")).toBe(false);
    expect(memberIpPasses({ operator: "!=", ip: "0.0.0.0" }, "203.0.113.5 255.255.255.0")).toBe(true);
    expect(memberIpPasses({ operator: "==", ip: "203.0.113.5" }, "203.0.113.5/24")).toBe(true);
    expect(memberIpPasses({ operator: "==", ip: "FE80::1" }, "fe80::1")).toBe(true);
    expect(memberIpPasses({ operator: "==", ip: "203.0.113.5" }, "203.0.113.6")).toBe(false);
  });

  it("triggerDimensionApplicable: own dims, ifTag on interface targets, device dims on asset metrics/fields only", () => {
    expect(triggerDimensionApplicable("hwSensorValue", "sensorClass")).toBe(true);
    expect(triggerDimensionApplicable("hwSensorValue", "mountPathPattern")).toBe(false);
    expect(triggerDimensionApplicable("sdwanMemberState", "link")).toBe(true);
    expect(triggerDimensionApplicable("ifInBps", "ifTag")).toBe(true);
    expect(triggerDimensionApplicable("cpuPct", "ifTag")).toBe(false);
    expect(triggerDimensionApplicable("cpuPct", "hostnamePattern")).toBe(true);
    expect(triggerDimensionApplicable("monitorStatus", "macPattern")).toBe(true);
    // A host metric's name that is not also an asset metric has no device to filter.
    expect(triggerDimensionApplicable("loadAvg1", "hostnamePattern")).toBe(false);
    expect(triggerDimensionApplicable("cpuPct", "bogus")).toBe(false);
  });
});
