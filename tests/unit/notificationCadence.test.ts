/**
 * tests/unit/notificationCadence.test.ts — the pure half of the poll-cadence
 * lookup the automations wizard converts its poll-counted holds through.
 *
 * `resolveScopeCadence` itself needs the DB (scope resolution + the
 * monitor-settings hierarchy) and is exercised through the route; what is
 * pinned here is the part that decides WHICH cadence a hold is counted in, and
 * the summary that decides which number the caption names.
 */

import { describe, it, expect } from "vitest";
import { streamForMetric, summarizeIntervals, METRIC_STREAM, HOST_METRIC_INTERVAL_SEC } from "../../src/services/notificationCadenceService.js";

describe("streamForMetric", () => {
  it("maps each metric to the collector that produces it", () => {
    expect(streamForMetric("memPct")).toBe("cpuMemory");
    expect(streamForMetric("cpuPct")).toBe("cpuMemory");
    expect(streamForMetric("probeLossPct")).toBe("responseTime");
    expect(streamForMetric("responseTimeMs")).toBe("responseTime");
    expect(streamForMetric("hwSensorValue")).toBe("temperature");
    expect(streamForMetric("storageUsedPct")).toBe("storage");
    expect(streamForMetric("ifInBps")).toBe("systemInfo");
    expect(streamForMetric("sdwanLatencyMs")).toBe("systemInfo");
  });

  it("maps the asset_state FIELDS too — a state trigger holds for polls like any other", () => {
    expect(streamForMetric("monitorStatus")).toBe("responseTime");
    expect(streamForMetric("consecutiveFailures")).toBe("responseTime");
    expect(streamForMetric("ifOperStatus")).toBe("systemInfo");
    expect(streamForMetric("poeStatus")).toBe("systemInfo");
  });

  it("falls back to the probe cadence for anything unmapped — every monitored asset has one", () => {
    expect(streamForMetric("somethingNewNobodyMappedYet")).toBe("responseTime");
    expect(streamForMetric(null)).toBe("responseTime");
    expect(streamForMetric("")).toBe("responseTime");
  });

  it("names only streams the settings resolver actually carries (plus the connectivity checks' own interval)", () => {
    // `connectivity` is the one stream that does not resolve through the
    // monitor-settings hierarchy — resolveScopeCadence reads each check's
    // intervalSec for it instead.
    const allowed = new Set(["responseTime", "cpuMemory", "temperature", "systemInfo", "storage", "connectivity"]);
    for (const stream of Object.values(METRIC_STREAM)) expect(allowed.has(stream)).toBe(true);
  });

  it("maps every conn* metric to the connectivity stream (else holds convert at the probe cadence)", () => {
    for (const m of ["connLatencyMs", "connHttpStatus", "connOk", "connFailurePct", "connHopCount", "connTlsDaysLeft"]) {
      expect(streamForMetric(m)).toBe("connectivity");
    }
  });

  it("states the Polaris host's own fixed sampling tick", () => {
    expect(HOST_METRIC_INTERVAL_SEC).toBe(30);
  });
});

describe("summarizeIntervals", () => {
  it("reports the most common interval plus the spread behind it", () => {
    expect(summarizeIntervals([60, 60, 60, 300])).toEqual({ mode: 60, min: 60, max: 300 });
  });

  it("breaks a tie toward the SHORTER interval, matching the resolver's own tiebreak", () => {
    expect(summarizeIntervals([30, 300])).toEqual({ mode: 30, min: 30, max: 300 });
  });

  it("ignores values that aren't a usable cadence rather than dragging the range", () => {
    expect(summarizeIntervals([0, -5, NaN, 120, 120])).toEqual({ mode: 120, min: 120, max: 120 });
  });

  it("answers null when nothing usable came back, so a caption can admit it", () => {
    expect(summarizeIntervals([])).toBeNull();
    expect(summarizeIntervals([0, NaN])).toBeNull();
  });
});
