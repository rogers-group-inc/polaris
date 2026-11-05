/**
 * tests/unit/regex.test.ts
 */

import { describe, it, expect } from "vitest";
import { escapeRegExp } from "../../src/utils/regex.js";

describe("escapeRegExp", () => {
  it("leaves plain text alone", () => {
    expect(escapeRegExp("GATE-1_corp")).toBe("GATE-1_corp");
  });

  it("escapes every metacharacter so the text matches only itself", () => {
    const nasty = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o";
    const re = new RegExp(`^${escapeRegExp(nasty)}$`);
    expect(re.test(nasty)).toBe(true);
    expect(re.test("aXb*c+d?e^f$g{h}i(j)k|l[m]n\\o")).toBe(false);
  });

  it("does not escape the hyphen, which is literal outside a character class", () => {
    expect(escapeRegExp("cache-nvme")).toBe("cache-nvme");
  });

  it("returns the empty string unchanged", () => {
    expect(escapeRegExp("")).toBe("");
  });
});
