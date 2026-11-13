/**
 * tests/unit/alertWidgetChart.test.ts — the chart a custom-widget alert leads
 * with in its email (business rule 180, from the approved design canvas).
 *
 * Pinned:
 *  - the three custom-widget metrics lead with `{chart.widget}` through
 *    `{chart.trigger}`, keep response time, and drop CPU, memory, packet loss
 *    and the sensor chart; the token renders away on every other alert and on
 *    a widget alert that names no widget;
 *  - a value alert's line is the band the alert is AT (or the trigger's own
 *    threshold) in that severity's colour; a level alert draws the widget's own
 *    warning and critical levels, each named in the legend;
 *  - a state alert is one status lane captioned with the minutes it spent on
 *    the problem side and what it reads now, and names a table probe's row;
 *  - no reading in the hour → no chart at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/notificationDimensionService.js", () => ({
  listCustomWidgetCatalog: vi.fn(async () => [
    { id: "w-bank2", name: "Bank 2 Current", source: "APC", unit: "A", levels: { warningAt: 16, criticalAt: 18, below: false } },
    { id: "w-load", name: "Output Load", source: "APC", unit: "%", levels: null },
  ]),
}));
vi.mock("../../src/services/manufacturerProfileService.js", () => ({
  listStateProbes: () => [
    { id: "p-ups", name: "UPS Status", manufacturer: "APC", type: "scalar", modelPattern: null,
      stateMap: { mode: "notEquals", values: ["2"], trueLabel: "On battery / bypass", falseLabel: "On utility power", trueIsProblem: true } },
    { id: "p-fan", name: "Fan", manufacturer: "APC", type: "table", modelPattern: null,
      stateMap: { mode: "nonzero", values: [], trueLabel: "Failed", falseLabel: "OK", trueIsProblem: true } },
  ],
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { chartTokenForMetric, chartTokensForAlert, type ChartToken } from "../../src/services/alertChartService.js";
import {
  buildWidgetValueChart, buildStateStripChart, widgetChartThresholdFromRule, isWidgetScopedAlert,
} from "../../src/services/alertWidgetChartService.js";
import { sparklineSvg, statusStripSvg } from "../../src/utils/sparklineSvg.js";

const DEFAULT: ChartToken[] = ["chart.trigger", "chart.sensor", "chart.probeLoss", "chart.cpu", "chart.memory", "chart.responseTime", "chart.widget"];
const has = (widget: boolean) => ({ port: false, sensor: false, mount: false, widget });
const TO = Date.UTC(2026, 10, 13, 15, 0);
const FROM = TO - 3600_000;
const min = (m: number) => new Date(FROM + m * 60_000);

beforeEach(() => resetDbStub());

describe("which charts a custom-widget alert draws", () => {
  it("leads with the widget chart, keeps response time and drops the rest", () => {
    for (const m of ["customWidgetValue", "customWidgetLevel", "customStateValue"]) {
      expect(chartTokenForMetric(m)).toBe("chart.widget");
      expect(isWidgetScopedAlert(m)).toBe(true);
      expect([...chartTokensForAlert(DEFAULT, m, has(true))].sort()).toEqual(["chart.responseTime", "chart.widget"]);
    }
  });

  it("renders away on any other alert, and on a widget alert naming no widget", () => {
    expect(chartTokensForAlert(DEFAULT, "cpuPct", has(true)).has("chart.widget")).toBe(false);
    expect(chartTokensForAlert(DEFAULT, "customWidgetLevel", has(false)).has("chart.widget")).toBe(false);
  });
});

describe("widgetChartThresholdFromRule", () => {
  const rule = {
    trigger: { type: "asset_metric", metric: "customWidgetValue", operator: ">=", threshold: 16 },
    severity: "warning",
    severityBands: [{ threshold: 18, severity: "critical" }] as never,
  };
  it("is the band the alert is at, else the trigger's threshold", () => {
    expect(widgetChartThresholdFromRule(rule, "critical")).toEqual({ value: 18, severity: "critical" });
    expect(widgetChartThresholdFromRule(rule, "warning")).toEqual({ value: 16, severity: "warning" });
  });
  it("is null for any other condition", () => {
    expect(widgetChartThresholdFromRule({ ...rule, trigger: { type: "asset_metric", metric: "cpuPct", threshold: 90 } }, "warning")).toBeNull();
  });
});

describe("the widget line chart", () => {
  const samples = stubbed(prisma.assetCustomWidgetSample.findMany);
  const rows = (vals: number[]) => vals.map((v, i) => ({ timestamp: min(i * 10), value: v }));

  it("a level alert draws the widget's own warning and critical levels", async () => {
    samples.mockResolvedValue(rows([12, 14, 17, 18.4]));
    const c = await buildWidgetValueChart("pdu", { metric: "customWidgetLevel", dimension: "w-bank2", from: FROM, to: TO });
    expect(c!.svg).toContain("Bank 2 Current");
    expect(c!.svg).toContain("Warning level");
    expect(c!.svg).toContain("Critical level");
    expect(c!.svg).toContain('stroke="#d97706"');
    expect(c!.svg).toContain('stroke="#dc2626"');
    expect(c!.summary).toBe("Bank 2 Current (last hour): now 18.4 A, avg 15.4 A, peak 18.4 A");
  });

  it("a value alert draws the threshold that fired, in its severity's colour", async () => {
    samples.mockResolvedValue(rows([60, 70, 82]));
    const c = await buildWidgetValueChart("ups", { metric: "customWidgetValue", dimension: "w-load", from: FROM, to: TO, threshold: { value: 80, severity: "serious" } });
    expect(c!.svg).toContain("Serious threshold");
    expect(c!.svg).toContain('stroke="#ea580c"');
  });

  it("draws nothing when the widget reported nothing in the hour", async () => {
    samples.mockResolvedValue([]);
    expect(await buildWidgetValueChart("pdu", { metric: "customWidgetLevel", dimension: "w-bank2", from: FROM, to: TO })).toBeNull();
  });
});

describe("the state probe status strip", () => {
  const samples = stubbed(prisma.assetStateSample.findMany);

  it("captions the minutes on the problem side and what it reads now", async () => {
    samples.mockResolvedValue([
      { timestamp: min(0), value: 0, rowLabel: "" },
      { timestamp: min(48), value: 1, rowLabel: "" },
    ]);
    const c = await buildStateStripChart("ups", { dimension: "p-ups|", from: FROM, to: TO });
    expect(c!.svg).toContain("On battery / bypass 12 min of the last hour · now On battery / bypass");
    expect(c!.svg).toContain(">UPS Status<");
    expect(c!.svg).toContain(">On utility power<");
    expect(c!.summary).toBe("UPS Status (last hour): now On battery / bypass");
  });

  it("names a table probe's row", async () => {
    samples.mockResolvedValue([{ timestamp: min(5), value: 1, rowLabel: "Fan 2" }]);
    const c = await buildStateStripChart("ups", { dimension: "p-fan|2", from: FROM, to: TO });
    expect(c!.svg).toContain("Fan — Fan 2");
  });

  it("draws nothing without a reading", async () => {
    samples.mockResolvedValue([]);
    expect(await buildStateStripChart("ups", { dimension: "p-ups|", from: FROM, to: TO })).toBeNull();
  });
});

describe("the renderers", () => {
  it("sparklineSvg folds levels into the axis and names each", () => {
    const svg = sparklineSvg([{ t: FROM, v: 5 }, { t: TO, v: 6 }], {
      label: "X", from: FROM, to: TO,
      levels: [{ value: 16, color: "#d97706", legend: "Warning level" }, { value: 18, color: "#dc2626", legend: "Critical level" }],
    });
    expect(svg.match(/stroke-dasharray="4 3"/g)!.length).toBe(2);
    expect(svg).toContain("Warning level");
    expect(svg).toContain("Critical level");
  });

  it("statusStripSvg reads the OK side when that is the problem side's opposite", () => {
    const svg = statusStripSvg([{ t: FROM, v: 1 }], { label: "Door", from: FROM, to: TO, okLabel: "Closed", problemLabel: "Open", problemValue: 0 });
    expect(svg).toContain("Open 0 min of the last hour · now Closed");
  });
});
