/**
 * tests/unit/triggerSummary.test.ts
 *
 * "What fired, and what the reading was" — the sentence that now leads the
 * alert email.
 *
 * The email used to state the metric only through the default message
 * ("Slow response time: sw-1 — responseTimeMs = 760"), which reads like a log
 * line. This says it the way the operator wrote it in the builder:
 *
 *     Response time (median over 5 minutes) is 760 ms
 *
 * These assertions pin the wording against the wizard's, because the whole
 * point is that the two match.
 */

import { describe, it, expect, vi } from "vitest";
import { triggerSummary, triggerSubject, humanDuration } from "../../src/utils/triggerSummary.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

describe("humanDuration", () => {
  it("matches the wizard's wording", () => {
    expect(humanDuration(300)).toBe("5 minutes");
    expect(humanDuration(60)).toBe("1 minute");
    expect(humanDuration(3600)).toBe("1 hour");
    expect(humanDuration(7200)).toBe("2 hours");
    expect(humanDuration(45)).toBe("45 seconds");
    expect(humanDuration(0)).toBe("");
  });
});

describe("triggerSubject", () => {
  it("names the metric and its aggregation window, as the builder does", () => {
    expect(triggerSubject({ type: "asset_metric", metric: "responseTimeMs", aggregation: "median", windowSec: 300 }))
      .toBe("Response time (median over 5 minutes)");
  });

  it("names a COUNT window as readings, never as the seconds mirror beside it", () => {
    // business rule 66. `windowSec` rides along to size the engine's fetch, so
    // printing it would put a clock in the alert's subject that the rule does
    // not keep — and a different clock on every device's cadence.
    expect(triggerSubject({
      type: "asset_metric", metric: "responseTimeMs", aggregation: "avg",
      windowSec: 1200, windowPolls: 10,
    })).toBe("Response time (avg over the last 10 readings)");
    // A count on `latest` is not a window, so the parenthetical still drops.
    expect(triggerSubject({
      type: "asset_metric", metric: "responseTimeMs", aggregation: "latest",
      windowSec: 1200, windowPolls: 10,
    })).toBe("Response time");
    // A ratio's window is its own denominator and keeps saying minutes.
    expect(triggerSubject({
      type: "asset_metric", metric: "probeLossPct", aggregation: "latest",
      windowSec: 900, windowPolls: 10,
    })).toContain("15 minutes");
  });

  it("omits the parenthetical for a latest-value trigger — there's no window to state", () => {
    expect(triggerSubject({ type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 300 }))
      .toBe("CPU utilization");
  });

  it("says whose host it is for a Polaris-host metric", () => {
    expect(triggerSubject({ type: "host_metric", metric: "cpuPct", aggregation: "latest" }))
      .toBe("The Polaris host's cpu utilization");
  });

  it("names the sub-asset the reading belongs to", () => {
    expect(triggerSubject(
      { type: "asset_metric", metric: "hwSensorValue", aggregation: "latest" },
      "CPU ON-DIE Temperature (temperature)",
    )).toBe("Hardware sensor value on CPU ON-DIE Temperature (temperature)");
  });

  it("states a windowed ratio's History window — its aggregation is latest, so the ordinary clause would drop it", () => {
    expect(triggerSubject({ type: "asset_metric", metric: "probeLossPct", aggregation: "latest", windowSec: 3600 }))
      .toBe("Packet loss (probe) (over the last 1 hour of probe history)");
    // A pre-History rule (no window) states what the engine actually measures
    // over: its default, not nothing.
    expect(triggerSubject({ type: "asset_metric", metric: "probeLossPct", aggregation: "latest", windowSec: 0 }))
      .toBe("Packet loss (probe) (over the last 15 minutes of probe history)");
  });
});

describe("triggerSummary", () => {
  it("produces the sentence the operator asked for", () => {
    expect(triggerSummary({
      trigger: { type: "asset_metric", metric: "responseTimeMs", aggregation: "median", windowSec: 300 },
      value: 760,
    })).toBe("Response time (median over 5 minutes) is 760 ms");
  });

  it("rounds for reading rather than dumping a float", () => {
    expect(triggerSummary({ trigger: { type: "asset_metric", metric: "probeLossPct" }, value: 93.7529 }))
      .toBe("Packet loss (probe) (over the last 15 minutes of probe history) is 93.8 %");
  });

  it("states a hardware sensor's own unit, not the catalogue placeholder", () => {
    // METRIC_META lists "(sensor unit)" for hwSensorValue — a builder hint that
    // must never be printed as if it were a unit.
    const s = triggerSummary({
      trigger: { type: "asset_metric", metric: "hwSensorValue", aggregation: "latest" },
      value: 61.2,
      dimensionLabel: "CPU ON-DIE Temperature (temperature)",
      sensorUnit: "°C",
    });
    expect(s).toBe("Hardware sensor value on CPU ON-DIE Temperature (temperature) is 61.2 °C");
    expect(s).not.toContain("(sensor unit)");
  });

  it("reads an alarm as a STATE, not as the number 1", () => {
    const t = { type: "asset_metric", metric: "hwSensorAlarm", aggregation: "latest" };
    expect(triggerSummary({ trigger: t, value: 1, dimensionLabel: "PSU1 (power)" }))
      .toBe("Hardware sensor alarm on PSU1 (power) is in ALARM");
    expect(triggerSummary({ trigger: t, value: 0, dimensionLabel: "PSU1 (power)" }))
      .toBe("Hardware sensor alarm on PSU1 (power) is OK");
  });

  it("states the CONDITION when there's no reading to quote — never a fragment", () => {
    // Happens on a test against a device that hasn't reported inside the
    // trigger's window. "Hardware sensor value" alone reads as broken.
    expect(triggerSummary({
      trigger: { type: "asset_metric", metric: "hwSensorValue", operator: ">", threshold: 60 },
      value: null,
    })).toBe("Hardware sensor value is above 60");
    expect(triggerSummary({
      trigger: { type: "asset_metric", metric: "responseTimeMs", aggregation: "median", windowSec: 300, operator: ">", threshold: 500 },
      value: null,
    })).toBe("Response time (median over 5 minutes) is above 500 ms");
  });

  it("falls back to the bare subject only when there's no threshold either", () => {
    expect(triggerSummary({ trigger: { type: "asset_metric", metric: "cpuPct" }, value: null }))
      .toBe("CPU utilization");
  });

  it("names a device-state field the way the builder does, not by its column name", () => {
    // "Asset down" is the most-sent alert in the product and its subject line
    // used to read "monitorStatus is down".
    expect(triggerSummary({ trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" } }))
      .toBe("Monitor status is down");
    expect(triggerSummary({
      trigger: { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" },
      dimensionLabel: "port3",
    })).toBe("Interface oper status on port3 is down");
  });

  it("prefers the reading over the configured value for a state trigger", () => {
    // What the device actually reports is the news; the configured value is
    // only the fallback for a preview with no reading behind it.
    expect(triggerSummary({
      trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
      value: "unreachable",
    })).toBe("Monitor status is unreachable");
  });

  it("names the real event instead of restating the pattern", () => {
    // The pattern is what the operator configured; the action + resource is
    // what actually happened, and it's the only identity an event alert has.
    expect(triggerSummary({
      trigger: { type: "event", actionPattern: "integration.discover.*" },
      eventAction: "integration.discover.error",
      eventResource: "FMG-Ashfield",
    })).toBe("integration.discover.error on FMG-Ashfield");
    // No resource behind it — still the concrete action, not the pattern.
    expect(triggerSummary({
      trigger: { type: "event", actionPattern: "integration.discover.*" },
      eventAction: "integration.discover.error",
    })).toBe("integration.discover.error");
  });

  it("has something to say for every trigger type", () => {
    expect(triggerSummary({ trigger: { type: "event", actionPattern: "asset.updated" } }))
      .toContain("asset.updated");
    expect(triggerSummary({ trigger: { type: "change", changeType: "lldp_neighbor" } }))
      .toContain("lldp_neighbor");
    expect(triggerSummary({ trigger: { type: "composite" } })).toContain("conditions");
  });
});
