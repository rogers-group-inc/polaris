/**
 * tests/unit/alertSdwanChart.test.ts
 *
 * The SD-WAN charts in an alert email — what an operator gets when a
 * health-check metric breaches, a service rule goes down, or a rule fails over
 * to another member.
 *
 * The behaviour under test is a SWAP, not an addition. An SD-WAN alert used to
 * mail the last hour of the FortiGate's CPU, memory, response time and probe
 * loss: four graphs of a firewall that is answering perfectly, printed under
 * "SD-WAN packet loss on VPN-SLA / wan1 is 41%". The device charts now come out
 * and the health check's own latency / jitter / loss go in, keyed on the pair
 * the alert is about.
 *
 * The pure halves are tested directly; the swap itself is driven through
 * `buildAlertCharts` against a mocked Prisma, because "which queries did it
 * even run" is half the point — a path alert must not touch the device's
 * telemetry or probe tables at all.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { perfSlaRows, sdwanRule, calls } = vi.hoisted(() => ({
  perfSlaRows: { rows: [] as unknown[] },
  sdwanRule: { row: null as unknown },
  calls: [] as string[],
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetPerfSlaSample: {
      findMany: vi.fn(async (args: { where?: { healthCheck?: { in?: string[] } } }) => {
        calls.push(`perfSla:${(args?.where?.healthCheck?.in ?? []).join(",")}`);
        return perfSlaRows.rows;
      }),
    },
    assetSdwanRule: {
      findUnique: vi.fn(async () => { calls.push("sdwanRule"); return sdwanRule.row; }),
    },
    assetTelemetrySample: { findMany: vi.fn(async () => { calls.push("telemetry"); return []; }) },
    assetMonitorSample: { findMany: vi.fn(async () => { calls.push("monitor"); return []; }) },
    assetHardwareSensorSample: { findMany: vi.fn(async () => { calls.push("sensor"); return []; }) },
    asset: { findUnique: vi.fn(async () => null) },
  },
}));

// The rasterizer is a native binding and every chart here would spawn one for
// nothing: the assertions are about WHICH charts were built and what they say,
// and the service already treats a failed rasterize as "text summary only".
vi.mock("@resvg/resvg-js", () => ({
  Resvg: class {
    render() { return { asPng: () => new Uint8Array([1, 2, 3]) }; }
  },
}));

vi.mock("../../src/services/downDetectionService.js", () => ({
  describeDownDetectionFor: vi.fn(async () => null),
  recoveryPollsFor: vi.fn(() => 0),
}));

import {
  buildAlertCharts,
  chartTokenForMetric,
  isSdwanScopedAlert,
  parseSdwanDimension,
  sdwanSeriesFrom,
  sdwanChartLabel,
  type SdwanSampleRow,
  type ChartToken,
} from "../../src/services/alertChartService.js";

const T0 = Date.parse("2026-09-09T10:00:00Z");

/** One AssetPerfSlaSample row, with the healthy defaults spelled out. */
const row = (o: Partial<SdwanSampleRow> & { min: number }): SdwanSampleRow => ({
  timestamp: new Date(T0 + o.min * 60_000),
  healthCheck: "VPN-SLA",
  link: "wan1",
  state: "up",
  latencyMs: 20,
  jitterMs: 2,
  packetLoss: 0,
  latencyThresholdMs: 100,
  jitterThresholdMs: 30,
  packetLossThreshold: 2,
  ...o,
});

describe("which chart explains an SD-WAN alert", () => {
  it("points each SD-WAN metric at its own chart", () => {
    expect(chartTokenForMetric("sdwanLatencyMs")).toBe("chart.sdwanLatency");
    expect(chartTokenForMetric("sdwanJitterMs")).toBe("chart.sdwanJitter");
    expect(chartTokenForMetric("sdwanPacketLoss")).toBe("chart.sdwanLoss");
  });

  it("leads a rule alert with latency — the gauge FortiOS always populates", () => {
    expect(chartTokenForMetric("sdwanRuleStatus")).toBe("chart.sdwanLatency");
    expect(chartTokenForMetric("sdwanSelectedMember")).toBe("chart.sdwanLatency");
  });

  it("treats all five SD-WAN triggers as path-scoped, and nothing else", () => {
    for (const m of ["sdwanLatencyMs", "sdwanJitterMs", "sdwanPacketLoss", "sdwanRuleStatus", "sdwanSelectedMember"]) {
      expect(isSdwanScopedAlert(m)).toBe(true);
    }
    for (const m of ["cpuPct", "ifOperStatus", "hwSensorValue", "probeLossPct", null, undefined, ""]) {
      expect(isSdwanScopedAlert(m)).toBe(false);
    }
  });
});

describe("the dimension an SD-WAN metric alert carries", () => {
  it("splits the engine's healthCheck|link key", () => {
    expect(parseSdwanDimension("VPN-SLA|wan1")).toEqual({ healthChecks: ["VPN-SLA"], link: "wan1" });
  });

  it("splits on the FIRST separator, so a link is never truncated", () => {
    // Defensive: FortiOS names admit no "|", but a dimension that somehow holds
    // one must not silently chart a different member.
    expect(parseSdwanDimension("HC|a|b")).toEqual({ healthChecks: ["HC"], link: "a|b" });
  });

  it("reads a separator-less dimension as the health check with no member preference", () => {
    expect(parseSdwanDimension("VPN-SLA")).toEqual({ healthChecks: ["VPN-SLA"], link: null });
    expect(parseSdwanDimension("VPN-SLA|")).toEqual({ healthChecks: ["VPN-SLA"], link: null });
  });

  it("has nothing to chart without a dimension", () => {
    expect(parseSdwanDimension(null)).toBeNull();
    expect(parseSdwanDimension("")).toBeNull();
    expect(parseSdwanDimension("|wan1")).toBeNull();
  });
});

describe("folding health-check samples into the three series", () => {
  it("charts the pair the alert names, whatever the siblings did", () => {
    const s = sdwanSeriesFrom(
      [
        row({ min: 0, link: "wan1", latencyMs: 30 }),
        row({ min: 1, link: "wan2", latencyMs: 11 }),
        // wan2 reported LAST — the freshest-member fallback would pick it.
        row({ min: 2, link: "wan1", latencyMs: 240 }),
        row({ min: 3, link: "wan2", latencyMs: 12 }),
      ],
      { healthChecks: ["VPN-SLA"], link: "wan1" },
    )!;
    expect(s.link).toBe("wan1");
    expect(s.latency.map((p) => p.v)).toEqual([30, 240]);
  });

  it("falls back to the freshest member when the named one reported nothing", () => {
    // FortiOS omits a member it could not probe at all, which is exactly the
    // state a failover leaves behind — the rule's selected member may have no
    // SLA rows in the window.
    const s = sdwanSeriesFrom(
      [row({ min: 0, link: "wan2" }), row({ min: 5, link: "wan3" })],
      { healthChecks: ["VPN-SLA"], link: "wan1" },
    )!;
    expect(s.link).toBe("wan3");
  });

  it("tries a rule's health checks in the order the rule lists them", () => {
    const s = sdwanSeriesFrom(
      [
        row({ min: 9, healthCheck: "Internet-SLA", link: "wan2" }),
        row({ min: 0, healthCheck: "VPN-SLA", link: "wan1" }),
      ],
      { healthChecks: ["VPN-SLA", "Internet-SLA"], link: null },
    )!;
    // VPN-SLA is listed first even though Internet-SLA is fresher.
    expect(s.healthCheck).toBe("VPN-SLA");
  });

  it("draws nothing when the rows are about some other health check entirely", () => {
    expect(sdwanSeriesFrom([row({ min: 0, healthCheck: "Other" })], { healthChecks: ["VPN-SLA"], link: null })).toBeNull();
    expect(sdwanSeriesFrom([], { healthChecks: ["VPN-SLA"], link: null })).toBeNull();
  });

  it("keeps the three gauges independent — a null is a gap, never a zero", () => {
    const s = sdwanSeriesFrom(
      [
        row({ min: 0, latencyMs: 20, jitterMs: 2, packetLoss: 0 }),
        // A member the health check could not measure reports latency only.
        row({ min: 1, latencyMs: 22, jitterMs: null, packetLoss: null }),
      ],
      { healthChecks: ["VPN-SLA"], link: "wan1" },
    )!;
    expect(s.latency).toHaveLength(2);
    expect(s.jitter).toHaveLength(1);
    expect(s.loss).toHaveLength(1);
  });

  it("merges consecutive down samples into one band and leaves an open one open", () => {
    const s = sdwanSeriesFrom(
      [
        row({ min: 0 }),
        row({ min: 1, state: "down" }),
        row({ min: 2, state: "down" }),
        row({ min: 3 }),
        row({ min: 4, state: "down" }),
      ],
      { healthChecks: ["VPN-SLA"], link: "wan1" },
    )!;
    expect(s.downSpans).toEqual([
      { from: T0 + 60_000, to: T0 + 120_000 },
      { from: T0 + 240_000, to: T0 + 240_000 },
    ]);
  });

  it("draws the SLA target the alert fired against — the last one configured", () => {
    const s = sdwanSeriesFrom(
      [
        row({ min: 0, latencyThresholdMs: 100, jitterThresholdMs: null, packetLossThreshold: 2 }),
        // Retuned mid-window: the chart's line is the one in force at the end.
        row({ min: 1, latencyThresholdMs: 80, jitterThresholdMs: null, packetLossThreshold: 2 }),
      ],
      { healthChecks: ["VPN-SLA"], link: "wan1" },
    )!;
    expect(s.latencyThresholdMs).toBe(80);
    expect(s.packetLossThreshold).toBe(2);
    // A health check with no jitter target draws no jitter line at all.
    expect(s.jitterThresholdMs).toBeNull();
  });
});

describe("what an SD-WAN chart calls itself", () => {
  it("states the path, so a four-WAN gate's email says which link degraded", () => {
    expect(sdwanChartLabel("SD-WAN latency", "VPN-SLA", "wan1")).toBe("SD-WAN latency — VPN-SLA / wan1");
  });

  it("truncates a long path rather than running under the caption", () => {
    // No text measurement is available to resvg here: the label is drawn at a
    // fixed x and the now/avg/peak caption is right-aligned on the same line.
    const label = sdwanChartLabel("SD-WAN packet loss", "a-very-long-performance-sla-object-name", "wan1");
    expect(label.length).toBeLessThanOrEqual(48);
    expect(label).toContain("…");
  });

  it("drops the separator when no member was resolved", () => {
    expect(sdwanChartLabel("SD-WAN jitter", "VPN-SLA", "")).toBe("SD-WAN jitter — VPN-SLA");
  });
});

const ALL_TOKENS: ChartToken[] = [
  "chart.trigger", "chart.sensor", "chart.probeLoss",
  "chart.sdwanLatency", "chart.sdwanJitter", "chart.sdwanLoss",
  "chart.cpu", "chart.memory", "chart.responseTime",
];

describe("the swap, end to end", () => {
  beforeEach(() => {
    calls.length = 0;
    perfSlaRows.rows = [row({ min: 0, latencyMs: 30 }), row({ min: 1, latencyMs: 250, state: "down" })];
    sdwanRule.row = null;
  });

  it("charts the health check and NOT the firewall on a metric alert", async () => {
    const charts = await buildAlertCharts("a1", ALL_TOKENS, {
      now: new Date(T0 + 10 * 60_000),
      metric: "sdwanPacketLoss",
      dimension: "VPN-SLA|wan1",
    });
    expect([...charts.keys()].sort()).toEqual([
      "chart.sdwanJitter", "chart.sdwanLatency", "chart.sdwanLoss", "chart.trigger",
    ]);
    // The whole point: no CPU, memory, response-time or probe-loss query ran.
    expect(calls).not.toContain("telemetry");
    expect(calls).not.toContain("monitor");
    expect(calls).toContain("perfSla:VPN-SLA");
  });

  it("leads with the chart of the metric that fired", async () => {
    const charts = await buildAlertCharts("a1", ALL_TOKENS, {
      now: new Date(T0 + 10 * 60_000),
      metric: "sdwanJitterMs",
      dimension: "VPN-SLA|wan1",
    });
    expect(charts.get("chart.trigger")!.cid).toBe(charts.get("chart.sdwanJitter")!.cid);
  });

  it("names the path and the down stretch in the text summary", async () => {
    const charts = await buildAlertCharts("a1", ALL_TOKENS, {
      now: new Date(T0 + 10 * 60_000),
      metric: "sdwanLatencyMs",
      dimension: "VPN-SLA|wan1",
    });
    const summary = charts.get("chart.sdwanLatency")!.summary;
    expect(summary).toContain("VPN-SLA / wan1");
    expect(summary).toContain("peak 250 ms");
    // The band is invisible with images blocked, and it is usually the finding.
    expect(summary).toContain("reported this member down");
  });

  it("resolves a failover alert's path through the service rule", async () => {
    sdwanRule.row = { healthChecks: ["VPN-SLA"], selectedMember: "wan1" };
    const charts = await buildAlertCharts("a1", ALL_TOKENS, {
      now: new Date(T0 + 10 * 60_000),
      metric: "sdwanSelectedMember",
      dimension: "Branch-to-DC",
    });
    expect(calls).toContain("sdwanRule");
    expect(calls).toContain("perfSla:VPN-SLA");
    expect(charts.get("chart.trigger")!.hasData).toBe(true);
  });

  it("draws nothing for a rule with no performance SLA behind it", async () => {
    // mode "priority" / "manual": there is no health check, so no chart —
    // rather than a graph of some unrelated check that exists on the gate.
    sdwanRule.row = { healthChecks: [], selectedMember: "wan1" };
    const charts = await buildAlertCharts("a1", ALL_TOKENS, {
      now: new Date(T0 + 10 * 60_000),
      metric: "sdwanRuleStatus",
      dimension: "Branch-to-DC",
    });
    expect(calls).not.toContain("perfSla:");
    for (const c of charts.values()) expect(c.hasData).toBe(false);
  });

  it("keeps the SD-WAN tokens out of every other alert", async () => {
    const charts = await buildAlertCharts("a1", ALL_TOKENS, {
      now: new Date(T0 + 10 * 60_000),
      metric: "cpuPct",
      dimension: null,
    });
    for (const t of ["chart.sdwanLatency", "chart.sdwanJitter", "chart.sdwanLoss"] as ChartToken[]) {
      expect(charts.has(t)).toBe(false);
    }
    expect(calls).not.toContain("perfSla:VPN-SLA");
    expect(calls).toContain("telemetry");
  });
});
