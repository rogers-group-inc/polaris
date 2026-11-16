/**
 * tests/unit/alertWidgetChartService.test.ts — own suite for
 * src/services/alertWidgetChartService.ts (CQ-T010, business rule 181).
 *
 * alertWidgetChart.test.ts pins the headline behaviour (token set, both charts,
 * the threshold choice, the empty case) against the real renderers. This file
 * goes edge by edge through the service's own branches, with the renderers
 * wrapped in spies so the options each chart is drawn with can be asserted:
 * the threshold rule's every exit, the value chart's read / name / unit /
 * levels / thinning / sample series, and the state strip's dimension parsing,
 * problem side, value filter, row label and sample lane.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  catalog: vi.fn(),
  probes: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/notificationDimensionService.js", () => ({ listCustomWidgetCatalog: h.catalog }));
vi.mock("../../src/services/manufacturerProfileService.js", () => ({ listStateProbes: h.probes }));
vi.mock("../../src/utils/sparklineSvg.js", async (orig) => {
  const real = await orig<typeof import("../../src/utils/sparklineSvg.js")>();
  return { ...real, sparklineSvg: vi.fn(real.sparklineSvg), statusStripSvg: vi.fn(real.statusStripSvg) };
});

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { sparklineSvg, statusStripSvg } from "../../src/utils/sparklineSvg.js";
import { severityCss } from "../../src/utils/severityStyle.js";
import { normalizeStateMap } from "../../src/utils/stateProbes.js";
import {
  buildStateStripChart,
  buildWidgetValueChart,
  isWidgetScopedAlert,
  widgetChartThresholdFromRule,
} from "../../src/services/alertWidgetChartService.js";
import type { SeverityBand } from "../../src/services/notificationTypes.js";

const TO = Date.UTC(2026, 10, 14, 12, 0);
const FROM = TO - 3600_000;
const at = (min: number) => new Date(FROM + min * 60_000);

const sparkOpts = () => vi.mocked(sparklineSvg).mock.calls.at(-1)![1] as { label: string; unit: string; levels: Array<{ value: number; color: string; legend: string }>; color: string };
const sparkPoints = () => vi.mocked(sparklineSvg).mock.calls.at(-1)![0];
const stripOpts = () => vi.mocked(statusStripSvg).mock.calls.at(-1)![1] as { label: string; okLabel: string; problemLabel: string; problemValue: 0 | 1 };
const stripPoints = () => vi.mocked(statusStripSvg).mock.calls.at(-1)![0];

beforeEach(() => {
  resetDbStub();
  vi.mocked(sparklineSvg).mockClear();
  vi.mocked(statusStripSvg).mockClear();
  h.catalog.mockReset().mockResolvedValue([
    { id: "w-amps", name: "Bank 2 Current", source: "APC", unit: "A", levels: { warningAt: 16, criticalAt: 18, below: false } },
    { id: "w-crit-only", name: "Inlet", source: "APC", unit: "", levels: { warningAt: null, criticalAt: 40, below: false } },
    { id: "w-plain", name: "Output Load", source: "APC", unit: "%", levels: null },
  ]);
  h.probes.mockReset().mockReturnValue([
    { id: "p-ups", name: "UPS Status", stateMap: { mode: "nonzero", values: [], trueLabel: "On battery", falseLabel: "On utility", trueIsProblem: true } },
    { id: "p-door", name: "Door", stateMap: { mode: "nonzero", values: [], trueLabel: "Closed", falseLabel: "Open", trueIsProblem: false } },
  ]);
});

describe("isWidgetScopedAlert", () => {
  it("is true for the three custom-widget metrics only", () => {
    expect(["customWidgetValue", "customWidgetLevel", "customStateValue"].every(isWidgetScopedAlert)).toBe(true);
    for (const m of ["cpuPct", "customWidget", "", null, undefined]) expect(isWidgetScopedAlert(m)).toBe(false);
  });
});

describe("widgetChartThresholdFromRule", () => {
  const trigger = { type: "asset_metric", metric: "customWidgetValue", threshold: 80 };
  const bands: SeverityBand[] = [
    { severity: "critical", threshold: 95 } as SeverityBand,
    { severity: "serious", threshold: Number.NaN } as SeverityBand,
  ];

  it("is the band the alert is at, in that band's severity", () => {
    expect(widgetChartThresholdFromRule({ trigger, severity: "warning", severityBands: bands }, "critical")).toEqual({ value: 95, severity: "critical" });
  });

  it("is the trigger's threshold at the rule's base severity, even when a band shares that severity", () => {
    const sameSev = [{ severity: "warning", threshold: 99 } as SeverityBand];
    expect(widgetChartThresholdFromRule({ trigger, severity: "warning", severityBands: sameSev }, "warning")).toEqual({ value: 80, severity: "warning" });
  });

  it("falls back to the trigger's threshold when no finite band matches", () => {
    expect(widgetChartThresholdFromRule({ trigger, severity: "warning", severityBands: bands }, "serious")).toEqual({ value: 80, severity: "warning" });
    expect(widgetChartThresholdFromRule({ trigger, severity: "warning", severityBands: null }, "critical")).toEqual({ value: 80, severity: "warning" });
    expect(widgetChartThresholdFromRule({ trigger, severity: "warning", severityBands: undefined }, "warning")).toEqual({ value: 80, severity: "warning" });
  });

  it("is null when the trigger carries no finite number threshold", () => {
    for (const threshold of [undefined, "80", Number.POSITIVE_INFINITY, null]) {
      expect(widgetChartThresholdFromRule({ trigger: { ...trigger, threshold }, severity: "warning", severityBands: [] }, "warning")).toBeNull();
    }
  });

  it("is null for any other condition shape", () => {
    for (const t of [null, "x", { type: "asset_metric", metric: "customWidgetLevel", threshold: 1 }, { type: "composite", metric: "customWidgetValue", threshold: 1 }]) {
      expect(widgetChartThresholdFromRule({ trigger: t, severity: "warning", severityBands: [] }, "warning")).toBeNull();
    }
  });
});

describe("buildWidgetValueChart", () => {
  it("is null without a dimension, before any read", async () => {
    expect(await buildWidgetValueChart("a1", { metric: "customWidgetValue", dimension: null, from: FROM, to: TO })).toBeNull();
    expect(h.catalog).not.toHaveBeenCalled();
  });

  it("is null for a real alert with no asset", async () => {
    expect(await buildWidgetValueChart(null, { metric: "customWidgetValue", dimension: "w-amps", from: FROM, to: TO })).toBeNull();
    expect(prisma.assetCustomWidgetSample.findMany).not.toHaveBeenCalled();
  });

  it("reads the widget's scalar samples in the window, oldest first", async () => {
    stubbed(prisma.assetCustomWidgetSample.findMany).mockResolvedValue([{ timestamp: at(5), value: 12 }]);
    await buildWidgetValueChart("a1", { metric: "customWidgetValue", dimension: "w-amps", from: FROM, to: TO });
    expect(stubbed(prisma.assetCustomWidgetSample.findMany).mock.calls[0]![0]).toMatchObject({
      where: { assetId: "a1", widgetId: "w-amps", kind: "scalar", timestamp: { gte: new Date(FROM), lte: new Date(TO) } },
      orderBy: { timestamp: "asc" },
    });
  });

  it("is null when the window held no finite reading", async () => {
    stubbed(prisma.assetCustomWidgetSample.findMany).mockResolvedValue([{ timestamp: at(1), value: "n/a" }, { timestamp: at(2), value: null as never }]);
    // Number(null) is 0 — a null value is read as a zero reading, so only the string is dropped.
    const c = await buildWidgetValueChart("a1", { metric: "customWidgetValue", dimension: "w-amps", from: FROM, to: TO });
    expect(sparkPoints()).toEqual([{ t: at(2).getTime(), v: 0 }]);
    expect(c).not.toBeNull();
    stubbed(prisma.assetCustomWidgetSample.findMany).mockResolvedValue([{ timestamp: at(1), value: "n/a" }]);
    expect(await buildWidgetValueChart("a1", { metric: "customWidgetValue", dimension: "w-amps", from: FROM, to: TO })).toBeNull();
  });

  it("parses numeric strings, names the widget and its unit, and summarises now / avg / peak", async () => {
    stubbed(prisma.assetCustomWidgetSample.findMany).mockResolvedValue([
      { timestamp: at(1), value: 10 }, { timestamp: at(2), value: "20" }, { timestamp: at(3), value: 15.04 },
    ]);
    const c = await buildWidgetValueChart("a1", { metric: "customWidgetValue", dimension: "w-amps", from: FROM, to: TO });
    expect(c!.summary).toBe("Bank 2 Current (last hour): now 15 A, avg 15 A, peak 20 A");
    expect(sparkOpts()).toMatchObject({ label: "Bank 2 Current", unit: " A", color: "#ea580c", levels: [] });
    expect(c!.svg).toContain("<svg");
  });

  it("names an unknown widget 'Custom widget' with no unit", async () => {
    stubbed(prisma.assetCustomWidgetSample.findMany).mockResolvedValue([{ timestamp: at(1), value: 3 }]);
    const c = await buildWidgetValueChart("a1", { metric: "customWidgetValue", dimension: "w-gone", from: FROM, to: TO });
    expect(c!.summary).toBe("Custom widget (last hour): now 3, avg 3, peak 3");
  });

  it("a level alert draws the widget's own levels, skipping one that is unset", async () => {
    stubbed(prisma.assetCustomWidgetSample.findMany).mockResolvedValue([{ timestamp: at(1), value: 3 }]);
    await buildWidgetValueChart("a1", { metric: "customWidgetLevel", dimension: "w-amps", from: FROM, to: TO });
    expect(sparkOpts().levels).toEqual([
      { value: 16, color: severityCss("warning"), legend: "Warning level" },
      { value: 18, color: severityCss("critical"), legend: "Critical level" },
    ]);
    await buildWidgetValueChart("a1", { metric: "customWidgetLevel", dimension: "w-crit-only", from: FROM, to: TO });
    expect(sparkOpts().levels).toEqual([{ value: 40, color: severityCss("critical"), legend: "Critical level" }]);
    await buildWidgetValueChart("a1", { metric: "customWidgetLevel", dimension: "w-plain", from: FROM, to: TO });
    expect(sparkOpts().levels).toEqual([]);
  });

  it("a value alert draws only the threshold that fired, never the widget's levels", async () => {
    stubbed(prisma.assetCustomWidgetSample.findMany).mockResolvedValue([{ timestamp: at(1), value: 3 }]);
    await buildWidgetValueChart("a1", { metric: "customWidgetValue", dimension: "w-amps", from: FROM, to: TO, threshold: { value: 17, severity: "serious" } });
    expect(sparkOpts().levels).toEqual([{ value: 17, color: severityCss("serious"), legend: "Serious threshold" }]);
    await buildWidgetValueChart("a1", { metric: "customWidgetValue", dimension: "w-amps", from: FROM, to: TO, threshold: null });
    expect(sparkOpts().levels).toEqual([]);
  });

  it("thins a dense hour to 240 points, keeping the first and the newest", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ timestamp: new Date(FROM + i * 3600), value: i }));
    stubbed(prisma.assetCustomWidgetSample.findMany).mockResolvedValue(rows);
    const c = await buildWidgetValueChart("a1", { metric: "customWidgetValue", dimension: "w-plain", from: FROM, to: TO });
    const pts = sparkPoints();
    expect(pts).toHaveLength(240);
    expect(pts[0]!.v).toBe(0);
    expect(pts.at(-1)!.v).toBe(999);
    expect(c!.summary).toContain("now 999 %");
  });

  it("draws a sample series for a test send, climbing past the line, with no read", async () => {
    const c = await buildWidgetValueChart(null, { metric: "customWidgetLevel", dimension: "w-amps", from: FROM, to: TO, sampleData: true });
    expect(prisma.assetCustomWidgetSample.findMany).not.toHaveBeenCalled();
    const pts = sparkPoints();
    expect(pts).toHaveLength(61);
    expect(pts[0]!.t).toBe(FROM);
    expect(pts.at(-1)!.t).toBe(TO);
    expect(pts.at(-1)!.v).toBeCloseTo(18 * 1.08); // the highest line, 8 % over
    expect(pts[0]!.v).toBeCloseTo(18 * 0.75);
    expect(c!.summary).toMatch(/^Bank 2 Current \(last hour\): now 19\.4 A/);
  });

  it("a sample series with no line climbs from 10 to 14", async () => {
    await buildWidgetValueChart(null, { metric: "customWidgetValue", dimension: "w-plain", from: FROM, to: TO, sampleData: true });
    expect(sparkPoints()[0]!.v).toBeCloseTo(10);
    expect(sparkPoints().at(-1)!.v).toBeCloseTo(14);
  });
});

describe("buildStateStripChart", () => {
  it("is null without a dimension, and for a real alert with no asset", async () => {
    expect(await buildStateStripChart("a1", { dimension: null, from: FROM, to: TO })).toBeNull();
    expect(await buildStateStripChart(null, { dimension: "p-ups|", from: FROM, to: TO })).toBeNull();
    expect(prisma.assetStateSample.findMany).not.toHaveBeenCalled();
  });

  it("splits the dimension at the FIRST bar, so a row key may itself contain one", async () => {
    stubbed(prisma.assetStateSample.findMany).mockResolvedValue([{ timestamp: at(1), value: 0, rowLabel: "Fan A|B" }]);
    await buildStateStripChart("a1", { dimension: "p-ups|fan|2", from: FROM, to: TO });
    expect(stubbed(prisma.assetStateSample.findMany).mock.calls[0]![0]).toMatchObject({
      where: { assetId: "a1", probeId: "p-ups", rowKey: "fan|2", timestamp: { gte: new Date(FROM), lte: new Date(TO) } },
      orderBy: { timestamp: "asc" },
    });
  });

  it("reads a dimension with no bar as a scalar probe, not row-labelled", async () => {
    stubbed(prisma.assetStateSample.findMany).mockResolvedValue([{ timestamp: at(1), value: 1, rowLabel: "ignored" }]);
    const c = await buildStateStripChart("a1", { dimension: "p-ups", from: FROM, to: TO });
    expect(stubbed(prisma.assetStateSample.findMany).mock.calls[0]![0].where).toMatchObject({ probeId: "p-ups", rowKey: "" });
    expect(c!.summary).toBe("UPS Status (last hour): now On battery");
    expect(stripOpts()).toMatchObject({ label: "UPS Status", problemLabel: "On battery", okLabel: "On utility", problemValue: 1 });
  });

  it("labels a table probe's row from the newest sample, falling back to the row key", async () => {
    stubbed(prisma.assetStateSample.findMany).mockResolvedValue([
      { timestamp: at(1), value: 0, rowLabel: "Old name" }, { timestamp: at(9), value: 1, rowLabel: "Fan 2" },
    ]);
    expect((await buildStateStripChart("a1", { dimension: "p-ups|2", from: FROM, to: TO }))!.summary).toBe("UPS Status — Fan 2 (last hour): now On battery");
    stubbed(prisma.assetStateSample.findMany).mockResolvedValue([{ timestamp: at(1), value: 0, rowLabel: "" }]);
    expect((await buildStateStripChart("a1", { dimension: "p-ups|2", from: FROM, to: TO }))!.summary).toBe("UPS Status — 2 (last hour): now On utility");
  });

  it("makes 0 the problem side when trueIsProblem is false", async () => {
    stubbed(prisma.assetStateSample.findMany).mockResolvedValue([{ timestamp: at(1), value: 0, rowLabel: null }]);
    const c = await buildStateStripChart("a1", { dimension: "p-door|", from: FROM, to: TO });
    expect(stripOpts()).toMatchObject({ problemValue: 0, problemLabel: "Open", okLabel: "Closed" });
    expect(c!.summary).toBe("Door (last hour): now Open");
  });

  it("drops any reading that is not 0 or 1, and is null when none is left", async () => {
    stubbed(prisma.assetStateSample.findMany).mockResolvedValue([
      { timestamp: at(1), value: 2, rowLabel: "" }, { timestamp: at(2), value: 1, rowLabel: "" }, { timestamp: at(3), value: -1, rowLabel: "" },
    ]);
    await buildStateStripChart("a1", { dimension: "p-ups|", from: FROM, to: TO });
    expect(stripPoints()).toEqual([{ t: at(2).getTime(), v: 1 }]);
    stubbed(prisma.assetStateSample.findMany).mockResolvedValue([{ timestamp: at(1), value: 7, rowLabel: "" }]);
    expect(await buildStateStripChart("a1", { dimension: "p-ups|", from: FROM, to: TO })).toBeNull();
  });

  it("names an unknown probe 'State' with the default state map", async () => {
    stubbed(prisma.assetStateSample.findMany).mockResolvedValue([{ timestamp: at(1), value: 1, rowLabel: "" }]);
    const c = await buildStateStripChart("a1", { dimension: "p-gone|", from: FROM, to: TO });
    const def = normalizeStateMap(null);
    expect(c!.summary).toBe(`State (last hour): now ${def.trueIsProblem ? def.trueLabel : def.falseLabel}`);
  });

  it("draws a sample lane for a test send: OK, then the problem side for the last fifth", async () => {
    const c = await buildStateStripChart(null, { dimension: "p-door|front", from: FROM, to: TO, sampleData: true });
    expect(prisma.assetStateSample.findMany).not.toHaveBeenCalled();
    expect(stripPoints()).toEqual([{ t: FROM, v: 1 }, { t: FROM + 0.8 * 3600_000, v: 0 }]);
    expect(c!.summary).toBe("Door — front (last hour): now Open");
  });
});
