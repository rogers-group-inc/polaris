/**
 * tests/unit/metricSeverityTiers.test.ts — the tier ladder the asset-detail
 * charts shade with (`getMetricSeverityTiers` in notificationRuleService).
 *
 * This is the seam where a CHART claims to show what an automation would do, so
 * the risks are all about lying: shading a fan's chart with a temperature
 * automation's thresholds (dimension filter ignored), missing the severity bands
 * (so a critical tier never appears), or picking the less sensitive of two
 * automations at the same severity. Prisma is mocked — the rule→tier derivation
 * is what's under test, not the query.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: { findUnique: (...a: unknown[]) => findUnique(...a) },
    notificationRule: { findMany: (...a: unknown[]) => findMany(...a) },
  },
}));

const { getMetricSeverityTiers, getMetricSeverityTierResolver } = await import("../../src/services/notificationRuleService.js");

const ASSET = {
  id: "a1",
  assetType: "firewall",
  tags: [],
  discoveredByIntegrationId: null,
  manufacturer: "Fortinet",
  model: "FortiGate-91G",
  ipAddress: "10.0.0.1",
  hostname: "FARMINGTON-91G-1",
  os: null,
  status: "active",
};

/** A stored rule row as Prisma returns it (legacy mirror columns included). */
function rule(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    name: "FortiGate 91G Temperature",
    severity: "serious",
    enabled: true,
    scope: { allAssets: true },
    trigger: { type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 35, forDurationSec: 600, aggregation: "latest", windowSec: 0 },
    severityBands: null,
    actions: [],
    reset: { mode: "auto" },
    escalation: null,
    bandNotify: null,
    clearBehavior: "auto",
    targets: [],
    ...over,
  };
}

beforeEach(() => {
  findUnique.mockReset();
  findMany.mockReset();
  findUnique.mockResolvedValue(ASSET);
});

describe("getMetricSeverityTiers", () => {
  it("returns the base tier at the rule's own severity + threshold", async () => {
    findMany.mockResolvedValue([rule()]);
    const tiers = await getMetricSeverityTiers("a1", "hwSensorValue");
    expect(tiers).toEqual([
      { severity: "serious", operator: ">=", threshold: 35, ruleId: "r1", ruleName: "FortiGate 91G Temperature" },
    ]);
  });

  it("includes severity bands, ordered least → most severe", async () => {
    findMany.mockResolvedValue([rule({ severityBands: [{ severity: "critical", threshold: 40 }] })]);
    const tiers = await getMetricSeverityTiers("a1", "hwSensorValue");
    expect(tiers.map((t) => [t.severity, t.threshold])).toEqual([["serious", 35], ["critical", 40]]);
  });

  it("carries a band's own operator override", async () => {
    findMany.mockResolvedValue([rule({ severityBands: [{ severity: "critical", threshold: 0, operator: "<=" }] })]);
    const tiers = await getMetricSeverityTiers("a1", "hwSensorValue");
    expect(tiers.find((t) => t.severity === "critical")).toMatchObject({ operator: "<=", threshold: 0 });
  });

  it("skips rules whose sensor-class filter doesn't select the charted sensor", async () => {
    findMany.mockResolvedValue([
      rule({ trigger: { type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 35, dimensionFilter: { sensorClass: "temperature" } } }),
    ]);
    expect(await getMetricSeverityTiers("a1", "hwSensorValue", { sensorName: "FAN1", sensorClass: "fan" })).toEqual([]);
    expect(await getMetricSeverityTiers("a1", "hwSensorValue", { sensorName: "CPU ON-DIE Temperature", sensorClass: "temperature" })).toHaveLength(1);
  });

  it("honors a specific-sensor filter (substring, case-insensitive)", async () => {
    findMany.mockResolvedValue([
      rule({ trigger: { type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 35, dimensionFilter: { sensorNamePattern: "cpu on-die" } } }),
    ]);
    expect(await getMetricSeverityTiers("a1", "hwSensorValue", { sensorName: "CPU ON-DIE Temperature", sensorClass: "temperature" })).toHaveLength(1);
    expect(await getMetricSeverityTiers("a1", "hwSensorValue", { sensorName: "TMP1 External Temperature", sensorClass: "temperature" })).toEqual([]);
  });

  it("shades an SD-WAN pair only with rules whose any-of health-check / member filter selects it", async () => {
    const loss = (id: string, dimensionFilter?: Record<string, string>, threshold = 5) => rule({
      id, name: id, severity: "warning",
      trigger: { type: "asset_metric", metric: "sdwanPacketLoss", operator: ">=", threshold, forDurationSec: 0, aggregation: "latest", windowSec: 0, ...(dimensionFilter ? { dimensionFilter } : {}) },
    });
    findMany.mockResolvedValue([
      loss("underlays", { healthCheck: "Primary WAN|Secondary WAN", link: "wan" }, 2),
      loss("everything", undefined, 10),
    ]);
    const tierFor = await getMetricSeverityTierResolver("a1");
    // The pair both select: the more sensitive threshold wins its severity.
    expect(tierFor("sdwanPacketLoss", { healthCheck: "Secondary WAN", link: "wan2" }).map((t) => t.ruleId)).toEqual(["underlays"]);
    // An overlay on another health check: only the unfiltered rule applies.
    expect(tierFor("sdwanPacketLoss", { healthCheck: "Metrocenter", link: "Overlay-3" }).map((t) => t.ruleId)).toEqual(["everything"]);
    // One rule read for any number of questions.
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("ignores rules on other metrics and non-numeric comparators", async () => {
    findMany.mockResolvedValue([
      rule({ id: "r2", trigger: { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 } }),
      rule({ id: "r3", trigger: { type: "asset_metric", metric: "hwSensorValue", operator: "==", threshold: 40 } }),
    ]);
    expect(await getMetricSeverityTiers("a1", "hwSensorValue")).toEqual([]);
  });

  it("keeps the MORE SENSITIVE threshold when two automations share a severity", async () => {
    findMany.mockResolvedValue([
      rule({ id: "r1", name: "loose", trigger: { type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 45 } }),
      rule({ id: "r2", name: "tight", trigger: { type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 35 } }),
    ]);
    const tiers = await getMetricSeverityTiers("a1", "hwSensorValue");
    expect(tiers).toHaveLength(1);
    expect(tiers[0]).toMatchObject({ threshold: 35, ruleName: "tight" });
  });

  it("keeps hot and cold tiers of the same severity as separate bands", async () => {
    findMany.mockResolvedValue([
      rule({ id: "r1", trigger: { type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 35 } }),
      rule({ id: "r2", trigger: { type: "asset_metric", metric: "hwSensorValue", operator: "<=", threshold: 5 } }),
    ]);
    const tiers = await getMetricSeverityTiers("a1", "hwSensorValue");
    expect(tiers.map((t) => [t.operator, t.threshold]).sort()).toEqual([["<=", 5], [">=", 35]]);
  });

  it("reads thresholds out of a COMPOSITE trigger's leaves at the rule's severity", async () => {
    findMany.mockResolvedValue([
      rule({
        severity: "warning",
        trigger: {
          type: "composite", kind: "asset", op: "or", forDurationSec: 0,
          children: [
            { type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 35, dimensionFilter: { sensorClass: "temperature" } },
            { type: "asset_metric", metric: "hwSensorValue", operator: "<=", threshold: 5, dimensionFilter: { sensorClass: "temperature" } },
            { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 },
          ],
        },
      }),
    ]);
    const tiers = await getMetricSeverityTiers("a1", "hwSensorValue", { sensorName: "TMP1", sensorClass: "temperature" });
    expect(tiers.map((t) => [t.severity, t.operator, t.threshold]).sort()).toEqual([
      ["warning", "<=", 5],
      ["warning", ">=", 35],
    ]);
  });

  it("returns nothing when the scope doesn't match the asset", async () => {
    findMany.mockResolvedValue([rule({ scope: { models: ["FortiGate-40F"] } })]);
    expect(await getMetricSeverityTiers("a1", "hwSensorValue")).toEqual([]);
  });

  it("returns nothing for an asset that no longer exists", async () => {
    findUnique.mockResolvedValue(null);
    findMany.mockResolvedValue([rule()]);
    expect(await getMetricSeverityTiers("gone", "hwSensorValue")).toEqual([]);
  });
});
