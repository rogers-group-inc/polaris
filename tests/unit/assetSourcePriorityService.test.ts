/**
 * tests/unit/assetSourcePriorityService.test.ts
 *
 * The fixed source order behind Asset.learnedLocation, served read-only to the
 * asset merge modal (business rule 22). It is the catalogue's declaration order;
 * there is no stored setting and nothing to save.
 */

import { describe, it, expect } from "vitest";

const svc = await import("../../src/services/assetSourcePriorityService.js");
const { DEFAULT_LOCATION_ORDER, LOCATION_CONTRIBUTORS } = await import("../../src/utils/assetSourceLocation.js");

describe("getSourcePrioritySettings", () => {
  it("returns the catalogue order and one labelled entry per kind, in that order", () => {
    const s = svc.getSourcePrioritySettings();
    expect(s.order).toEqual(DEFAULT_LOCATION_ORDER);
    expect(s.contributors.map((c) => c.kind)).toEqual(DEFAULT_LOCATION_ORDER);
    expect(s.contributors.length).toBe(LOCATION_CONTRIBUTORS.length);
    for (const c of s.contributors) {
      expect(typeof c.label).toBe("string");
      expect(c.label.length).toBeGreaterThan(0);
      expect(typeof c.fortinetDevice).toBe("boolean");
    }
  });

  it("hands out a copy, so a caller cannot reorder the shared catalogue", () => {
    const s = svc.getSourcePrioritySettings();
    s.order.reverse();
    expect(svc.getSourcePrioritySettings().order).toEqual(DEFAULT_LOCATION_ORDER);
  });

  it("no longer exposes a save or a projection refresh", () => {
    expect((svc as Record<string, unknown>).saveSourceLocationPriority).toBeUndefined();
    expect((svc as Record<string, unknown>).refreshProjectionPriority).toBeUndefined();
  });
});
