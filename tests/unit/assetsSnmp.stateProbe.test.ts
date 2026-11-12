/**
 * tests/unit/assetsSnmp.stateProbe.test.ts
 *
 * Which side of a state probe is the problem — `_stateProbeIsProblem` in
 * public/js/assets-snmp.js, which colours each row's pill and counts the
 * "N of M rows in …" head on the asset's state widget. Polarity is whatever
 * the operator declared (`trueIsProblem`), so a probe whose FALSE side is the
 * problem ("link present") works.
 */

import { describe, it, expect } from "vitest";
import { assetsFileSource } from "./_assetsSource.js";
import { DEFAULT_STATE_MAP, type StateMap } from "../../src/utils/stateProbes.js";

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

const isProblem = new Function(
  `${extractFn(assetsFileSource("assets-snmp.js"), "_stateProbeIsProblem")}; return _stateProbeIsProblem;`,
)() as (value: 0 | 1 | null, map: unknown) => boolean;

const map = (over: Partial<StateMap> = {}): StateMap => ({ ...DEFAULT_STATE_MAP, ...over });

describe("_stateProbeIsProblem", () => {
  it("follows the declared polarity, so a probe whose FALSE side is the problem works", () => {
    const inverted = map({ trueIsProblem: false, trueLabel: "Present", falseLabel: "Missing" });
    expect(isProblem(0, inverted)).toBe(true);
    expect(isProblem(1, inverted)).toBe(false);
    expect(isProblem(1, map())).toBe(true);
    expect(isProblem(0, map())).toBe(false);
    expect(isProblem(null, map())).toBe(false);
  });

  it("treats an unset trueIsProblem (or no map) as true-is-the-problem", () => {
    expect(isProblem(1, {})).toBe(true);
    expect(isProblem(1, null)).toBe(true);
    expect(isProblem(0, undefined)).toBe(false);
  });
});
