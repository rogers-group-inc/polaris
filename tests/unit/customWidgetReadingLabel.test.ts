/**
 * tests/unit/customWidgetReadingLabel.test.ts — a `customWidgetValue` alert
 * names the widget, not its id.
 *
 * An "APC UPS - Output load high" email read "Custom widget value on
 * 9db96a44-2a6f-484d-8087-cd6682ba29b4 is 80" (2026-11-13): the reading's
 * label was the widget id. The KEY stays the id — an alert's identity must
 * survive a widget rename — and the LABEL is the widget's name.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/notificationDimensionService.js", () => ({
  listCustomWidgetCatalog: vi.fn(async () => [{ id: "w-load", name: "Output Load", source: "APC" }]),
}));

import { resolveAssetMetricReadings } from "../../src/services/notifications/readings.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const findMany = stubbed(prisma.assetCustomWidgetSample.findMany);
const asset = { id: "ups", hostname: "Datacenter UPS", tags: [] } as never;
const trigger = { type: "asset_metric", metric: "customWidgetValue", operator: ">=", value: 80, dimensionFilter: {} } as never;
const sample = (widgetId: string, value: number) => ({ assetId: "ups", timestamp: new Date(), widgetId, value });

beforeEach(() => resetDbStub());

describe("customWidgetValue readings", () => {
  it("label the reading with the widget's name and key it by the widget's id", async () => {
    findMany.mockResolvedValue([sample("w-load", 81)]);
    const [r] = await resolveAssetMetricReadings(trigger, [asset]);
    expect(r).toMatchObject({ assetId: "ups", dimKey: "w-load", dimLabel: "Output Load", value: 81 });
  });

  it("fall back to the id for a widget the catalogue no longer has", async () => {
    findMany.mockResolvedValue([sample("w-gone", 5)]);
    const [r] = await resolveAssetMetricReadings(trigger, [asset]);
    expect(r).toMatchObject({ dimKey: "w-gone", dimLabel: "w-gone" });
  });
});
