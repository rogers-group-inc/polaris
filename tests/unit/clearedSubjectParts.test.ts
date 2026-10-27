/**
 * tests/unit/clearedSubjectParts.test.ts
 *
 * The subject-naming tokens an operator Clear's "Resolved" email reuses from
 * the alert's fire-time snapshot, so it reads as the same alert.
 */

import { describe, expect, it } from "vitest";
import { clearedSubjectParts } from "../../src/services/notificationService.js";

describe("clearedSubjectParts", () => {
  it("lifts {asset}, {dimension}, {dimension.suffix} and {rule} from the snapshot", () => {
    expect(clearedSubjectParts({ asset: "RGILink Auth", dimension: "GRYCRT-S2212", "dimension.suffix": " · 1 device", rule: "Path Monitor", value: "5" }))
      .toEqual({ asset: "RGILink Auth", dimension: "GRYCRT-S2212", dimensionSuffix: " · 1 device", ruleName: "Path Monitor" });
  });

  it("keeps an empty suffix — a whole-device alert's subject has none", () => {
    expect(clearedSubjectParts({ asset: "sw1", dimension: "", "dimension.suffix": "" }))
      .toEqual({ asset: "sw1", dimension: "", dimensionSuffix: "" });
  });

  it("returns nothing for a missing, non-object or non-string snapshot", () => {
    expect(clearedSubjectParts(null)).toEqual({});
    expect(clearedSubjectParts("ctx")).toEqual({});
    expect(clearedSubjectParts({ asset: 3, dimension: null })).toEqual({});
    // A blank asset falls back to the row's host rather than naming nothing.
    expect(clearedSubjectParts({ asset: "" })).toEqual({});
  });
});
