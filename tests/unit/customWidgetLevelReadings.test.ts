/**
 * tests/unit/customWidgetLevelReadings.test.ts — business rule 181: the
 * `customWidgetLevel` condition reads each widget against ITS OWN warning /
 * critical levels, so one automation covers every widget that defines them —
 * an AP8830's 13 A and an AP8870's 19 A alike. A widget with no levels is not
 * read at all, and the alert says "Bank 2 Current is in critical state".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/notificationDimensionService.js", () => ({
  listCustomWidgetCatalog: vi.fn(async () => [
    { id: "w-bank2", name: "Bank 2 Current", source: "APC", unit: "A", levels: { warningAt: 16, criticalAt: 18, below: false } },
    { id: "w-batt", name: "Battery Capacity", source: "APC", unit: "%", levels: { warningAt: 50, criticalAt: 25, below: true } },
    { id: "w-energy", name: "Energy", source: "APC", unit: "kWh", levels: null },
  ]),
}));

import { resolveAssetMetricReadings } from "../../src/services/notifications/readings.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { triggerSummary, triggerTokenParts } from "../../src/utils/triggerSummary.js";

const findMany = stubbed(prisma.assetCustomWidgetSample.findMany);
const asset = { id: "pdu", hostname: "PDU-A3", tags: [] } as never;
const trigger = (df: Record<string, string> = {}) =>
  ({ type: "asset_metric", metric: "customWidgetLevel", operator: ">=", threshold: 1, dimensionFilter: df }) as never;
const s = (widgetId: string, value: number) => ({ assetId: "pdu", timestamp: new Date(), widgetId, value });

beforeEach(() => resetDbStub());

describe("customWidgetLevel readings", () => {
  it("reads every widget with levels at its own thresholds, labelled by name", async () => {
    findMany.mockResolvedValue([s("w-bank2", 18.3), s("w-batt", 40)]);
    const readings = await resolveAssetMetricReadings(trigger(), [asset]);
    const byKey = Object.fromEntries(readings.map((r) => [r.dimKey, r]));
    expect(byKey["w-bank2"]).toMatchObject({ dimLabel: "Bank 2 Current", value: 2 });
    expect(byKey["w-batt"]).toMatchObject({ dimLabel: "Battery Capacity", value: 1 });
  });

  it("never asks for a widget that defines no level", async () => {
    findMany.mockResolvedValue([]);
    await resolveAssetMetricReadings(trigger(), [asset]);
    expect(findMany.mock.calls[0]![0].where.widgetId).toEqual({ in: ["w-bank2", "w-batt"] });
  });

  it("narrows to one widget when the condition names it, and to none when that widget has no levels", async () => {
    findMany.mockResolvedValue([]);
    await resolveAssetMetricReadings(trigger({ widgetId: "w-bank2" }), [asset]);
    expect(findMany.mock.calls[0]![0].where.widgetId).toEqual({ in: ["w-bank2"] });
    findMany.mockClear();
    expect(await resolveAssetMetricReadings(trigger({ widgetId: "w-energy" }), [asset])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("the sentence", () => {
  it("names the widget and the level, never the number", () => {
    expect(triggerSummary({ trigger: trigger(), value: 2, dimensionLabel: "Bank 2 Current" })).toBe("Bank 2 Current is in critical state");
    expect(triggerSummary({ trigger: trigger(), value: 1, dimensionLabel: "Battery Capacity" })).toBe("Battery Capacity is in warning state");
    expect(triggerSummary({ trigger: trigger(), value: 0, dimensionLabel: "Output Load" })).toBe("Output Load is back to normal");
  });

  it("the {value} / {threshold} tokens read as words", () => {
    expect(triggerTokenParts(trigger(), 2)).toEqual({ metricLabel: "Custom widget level", valueDisplay: "critical", thresholdDisplay: "warning or worse" });
  });
});
