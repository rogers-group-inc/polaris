/**
 * tests/unit/customWidgetCatalog.test.ts — `listCustomWidgetCatalog`, the list
 * the automation builder names a `customWidgetValue` condition's widget from.
 *
 * The condition stores an opaque id (a profile widget's UUID, or a Generic API
 * widget's `ga:<integration>:<slug>` key), so without this list the builder
 * could only show — and ask the operator to type — that id. Pinned: both
 * sources contribute, the ids are exactly the ones the sample rows carry, and
 * state / table widgets are left out because neither writes the scalar sample
 * `customWidgetValue` reads.
 */

import { describe, it, expect, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("../../src/db.js", () => ({ prisma: { integration: { findMany } } }));
vi.mock("../../src/services/manufacturerProfileService.js", () => ({
  listStateProbes: () => [],
  listCachedProfiles: () => [
    {
      manufacturer: "APC",
      widgets: [
        { id: "w-load", name: "Output Load", widgetType: "gauge" },
        { id: "w-run", name: "Run Time Remaining", widgetType: "line" },
        { id: "w-web", name: "Web UI", widgetType: "http" },
        { id: "w-status", name: "UPS Status", widgetType: "state" },
        { id: "w-cause", name: "Fail cause", widgetType: "table" },
      ],
    },
  ],
}));

import { listCustomWidgetCatalog } from "../../src/services/notificationDimensionService.js";
import { genericApiWidgetId } from "../../src/services/genericApiService.js";

describe("listCustomWidgetCatalog", () => {
  it("lists the numeric widgets from both sources, keyed by the id their samples carry", async () => {
    findMany.mockResolvedValueOnce([
      {
        id: "intg-1",
        name: "Printers",
        config: {
          monitorQueries: [
            { stream: "widgets", widgets: [{ name: "Toner", type: "gauge", path: "t" }, { name: "Door", type: "state", path: "d" }] },
            { stream: "cpuMemory", widgets: [{ name: "Ignored", type: "gauge", path: "x" }] },
          ],
        },
      },
      { id: "intg-2", name: "Empty", config: null },
    ]);

    const out = await listCustomWidgetCatalog();
    expect(out).toEqual([
      { id: "w-load", name: "Output Load", source: "APC" },
      { id: "w-run", name: "Run Time Remaining", source: "APC" },
      { id: genericApiWidgetId("intg-1", "Toner"), name: "Toner", source: "Printers" },
      { id: "w-web", name: "Web UI", source: "APC" },
    ]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { type: "genericapi" } }));
  });
});
