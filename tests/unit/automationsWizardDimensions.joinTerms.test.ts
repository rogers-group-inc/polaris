/**
 * tests/unit/automationsWizardDimensions.joinTerms.test.ts
 *
 * The canonical stored form of a multi-value dimension filter (SD-WAN health
 * checks / members, interface patterns / tags) — `awDimJoinTerms` in
 * public/js/automations-wizard-dimensions.js. The server reads the result back
 * with sdwanDimensionTerms (src/utils/sdwanDimensions.ts), so the last case
 * pins the round trip.
 */

import { describe, it, expect } from "vitest";
import { wizardFileSource } from "./_automationsWizardSource.js";
import { sdwanDimensionTerms } from "../../src/utils/sdwanDimensions.js";

/** Source text of `function <name>(...) { ... }`, braces balanced. */
function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name}: unbalanced braces`);
}

const join = new Function(
  `${extractFn(wizardFileSource("automations-wizard-dimensions.js"), "awDimJoinTerms")}; return awDimJoinTerms;`,
)() as (terms: unknown) => string;

describe("awDimJoinTerms", () => {
  it("joins canonically, de-duplicating case-insensitively and keeping the first spelling", () => {
    expect(join(["wan1", " WAN1 ", "", "wan2"])).toBe("wan1|wan2");
    expect(join([])).toBe("");
  });

  it("tolerates a missing list and null entries", () => {
    expect(join(null)).toBe("");
    expect(join(["wan1", null, undefined, "wan2"])).toBe("wan1|wan2");
  });

  it("round-trips through the server's term split", () => {
    expect(sdwanDimensionTerms(join(["Microsoft", " Primary WAN ", "microsoft"])))
      .toEqual(["Microsoft", "Primary WAN"]);
  });
});
