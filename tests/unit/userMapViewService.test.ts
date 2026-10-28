/**
 * The hidden-map-regions list normalizer (User.hiddenMapRegionIds).
 *
 * Lenient by design: it runs on READ too, so a stored value that is not what
 * this build expects must degrade to "nothing hidden" rather than break the
 * map on the desktop and the phone.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_HIDDEN_MAP_REGIONS,
  normalizeHiddenMapRegionIds,
} from "../../src/services/userMapViewService.js";

describe("normalizeHiddenMapRegionIds", () => {
  it("passes ids through in order", () => {
    expect(normalizeHiddenMapRegionIds(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("trims, de-duplicates and drops empties and non-strings", () => {
    expect(normalizeHiddenMapRegionIds([" a ", "a", "", "  ", 3, null, { id: "x" }, "b"])).toEqual(["a", "b"]);
  });

  it("drops over-long ids rather than storing them", () => {
    expect(normalizeHiddenMapRegionIds(["x".repeat(129), "ok"])).toEqual(["ok"]);
    expect(normalizeHiddenMapRegionIds(["x".repeat(128)])).toHaveLength(1);
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_HIDDEN_MAP_REGIONS + 25 }, (_, i) => "r" + i);
    const out = normalizeHiddenMapRegionIds(many);
    expect(out).toHaveLength(MAX_HIDDEN_MAP_REGIONS);
    expect(out[0]).toBe("r0");
  });

  it("degrades anything that is not an array to nothing hidden", () => {
    for (const junk of [null, undefined, "a", 3, {}, true]) {
      expect(normalizeHiddenMapRegionIds(junk)).toEqual([]);
    }
  });
});
