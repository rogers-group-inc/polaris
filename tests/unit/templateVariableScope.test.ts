/**
 * tests/unit/templateVariableScope.test.ts
 *
 * The automation wizard's variable list: which tokens a trigger can ever fill
 * (applicableTemplateTokens), the chart scope swaps it shares with the email
 * (chartTokensForAlert), and the readable metric / value / threshold tokens
 * (triggerTokenParts).
 */

import { describe, it, expect } from "vitest";
import { applicableTemplateTokens } from "../../src/services/notificationEngine.js";
import { chartTokensForAlert, CHART_TOKENS } from "../../src/services/alertChartService.js";
import { triggerTokenParts } from "../../src/utils/triggerSummary.js";
import { TEMPLATE_VARIABLES } from "../../src/utils/notificationTemplate.js";
import type { Trigger } from "../../src/services/notificationTypes.js";

const ALL = { port: true, sensor: true, mount: true };
const metric = (m: string, extra: Record<string, unknown> = {}) =>
  ({ type: "asset_metric", metric: m, aggregation: "latest", windowSec: 0, operator: ">", threshold: 90, forDurationSec: 0, ...extra }) as unknown as Trigger;
const state = (field: string, value: string, extra: Record<string, unknown> = {}) =>
  ({ type: "asset_state", field, operator: "==", value, forDurationSec: 0, ...extra }) as unknown as Trigger;

describe("chartTokensForAlert", () => {
  it("keeps only the two load charts on a CPU alert, with the alias resolved", () => {
    expect([...chartTokensForAlert(CHART_TOKENS, "cpuCorePct", ALL)].sort()).toEqual(["chart.cpu", "chart.memory"]);
  });

  it("swaps the device charts for the SD-WAN trio on an SD-WAN alert", () => {
    expect([...chartTokensForAlert(CHART_TOKENS, "sdwanLatencyMs", { ...ALL, sensor: false })].sort())
      .toEqual(["chart.sdwanJitter", "chart.sdwanLatency", "chart.sdwanLoss"]);
  });

  it("draws nothing for a path check, or for a port alert with no port", () => {
    expect(chartTokensForAlert(CHART_TOKENS, "pathLatencyMs", ALL).size).toBe(0);
    expect(chartTokensForAlert(CHART_TOKENS, "ifOperStatus", { ...ALL, port: false }).size).toBe(0);
  });

  it("charts a storage alert's mount only when it has one", () => {
    expect([...chartTokensForAlert(CHART_TOKENS, "storageUsedPct", ALL)]).toEqual(["chart.storage"]);
    expect(chartTokensForAlert(CHART_TOKENS, "storageUsedPct", { ...ALL, mount: false }).size).toBe(0);
  });

  it("drops the sensor chart without a sensor and the storage chart on every other alert", () => {
    const out = chartTokensForAlert(CHART_TOKENS, "responseTimeMs", { ...ALL, sensor: false });
    expect(out.has("chart.sensor")).toBe(false);
    expect(out.has("chart.storage")).toBe(false);
    expect(out.has("chart.responseTime")).toBe(true);
  });
});

describe("applicableTemplateTokens", () => {
  it("offers the core list, CPU charts and process list on a per-core CPU trigger", () => {
    const got = new Set(applicableTemplateTokens(metric("cpuCorePct")));
    for (const t of ["{dimension}", "{chart.trigger}", "{chart.cpu}", "{chart.memory}", "{processes.top}", "{threshold}", "{asset.ip}"]) {
      expect(got.has(t), t).toBe(true);
    }
    for (const t of ["{event.action}", "{interface.lldp}", "{chart.sensor}", "{chart.sdwanLatency}", "{chart.responseTime}", "{conditions}", "{dependency.summary}"]) {
      expect(got.has(t), t).toBe(false);
    }
  });

  it("offers the interface facts on an interface trigger and nothing device-wide on a host trigger", () => {
    expect(applicableTemplateTokens(state("ifOperStatus", "down"))).toContain("{interface.lldp}");
    const host = new Set(applicableTemplateTokens({ ...metric("cpuPct"), type: "host_metric" } as unknown as Trigger));
    expect(host.has("{asset.ip}")).toBe(false);
    expect(host.has("{chart.cpu}")).toBe(false);
    expect(host.has("{processes.top}")).toBe(false);
    expect(host.has("{threshold}")).toBe(true);
  });

  it("offers the event tokens only on event and change triggers", () => {
    const ev = new Set(applicableTemplateTokens({ type: "event", actionPattern: "integration.*" } as unknown as Trigger));
    expect(ev.has("{event.message}")).toBe(true);
    expect(ev.has("{threshold}")).toBe(false);
    expect(ev.has("{metric.label}")).toBe(false);
    expect(applicableTemplateTokens({ type: "change", changeType: "sdwan_failover" } as unknown as Trigger)).toContain("{chart.sdwanLatency}");
  });

  it("offers the dependency tokens only on a down automation that alerts while dependency-down", () => {
    expect(applicableTemplateTokens(state("monitorStatus", "down"))).not.toContain("{dependency.summary}");
    expect(applicableTemplateTokens(state("monitorStatus", "down", { alertWhenDependencyDown: true }))).toContain("{dependency.summary}");
  });

  it("offers {conditions} on a composite and no per-reading tokens", () => {
    const comp = new Set(applicableTemplateTokens({
      type: "composite", kind: "asset", op: "and", forDurationSec: 0,
      children: [{ type: "asset_metric", metric: "cpuCorePct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 90 }],
    } as unknown as Trigger));
    expect(comp.has("{conditions}")).toBe(true);
    expect(comp.has("{dimension}")).toBe(false);
    expect(comp.has("{processes.top}")).toBe(false);
  });

  it("always offers the tokens that apply to every trigger", () => {
    const universal = TEMPLATE_VARIABLES.filter((v) => !v.appliesTo).map((v) => v.token);
    expect(applicableTemplateTokens(null)).toEqual(expect.arrayContaining(universal));
  });
});

describe("triggerTokenParts", () => {
  it("words a metric trigger with its unit and comparison", () => {
    expect(triggerTokenParts(metric("cpuCorePct") as never, 97.24)).toEqual({
      metricLabel: "CPU core utilization", valueDisplay: "97.2 %", thresholdDisplay: "above 90 %",
    });
  });

  it("words a state trigger as 'is down', with the operator-facing status label", () => {
    const p = triggerTokenParts(state("monitorStatus", "down") as never, "warning");
    expect(p.thresholdDisplay).toBe("is down");
    expect(p.valueDisplay).toBe("missed");
  });

  it("says ALARM rather than 1 for a sensor alarm, and is blank without a reading", () => {
    expect(triggerTokenParts(metric("hwSensorAlarm") as never, 1).valueDisplay).toBe("in ALARM");
    expect(triggerTokenParts(metric("cpuPct") as never, null).valueDisplay).toBe("");
  });

  it("names a change type and stays blank on an audit event", () => {
    expect(triggerTokenParts({ type: "change", changeType: "lldp_neighbor_added" }).metricLabel).toBe("LLDP neighbor appeared");
    expect(triggerTokenParts({ type: "event", actionPattern: "x.*" })).toEqual({ metricLabel: "", valueDisplay: "", thresholdDisplay: "" });
  });
});
