import { describe, it, expect } from "vitest";
import {
  MAX_REGEX_SUBJECT,
  clampRegexSubject,
  countCaptureGroups,
} from "../../src/utils/regexSafety.js";
import { FORTISWITCH_MODEL_PARSE } from "../../src/utils/fortiswitchModel.js";

// The guards that stand in for escaping on the three regexes an OPERATOR
// supplies (ManufacturerProfile.matchPattern / modelPattern, and the model
// row's parsePattern). Escaping is not available here — the whole point of
// those fields is that the operator's text IS the pattern — so these two are
// what keep a typo from parking a monitor worker forever.

describe("countCaptureGroups", () => {
  it("counts plain and named groups", () => {
    expect(countCaptureGroups("(a)")).toBe(1);
    expect(countCaptureGroups("(a)(b)(c)")).toBe(3);
    expect(countCaptureGroups("(?<model>a)")).toBe(1);
  });

  it("does not count non-capturing groups, lookahead or lookbehind", () => {
    expect(countCaptureGroups("(?:a)")).toBe(0);
    expect(countCaptureGroups("(?=a)")).toBe(0);
    expect(countCaptureGroups("(?!a)")).toBe(0);
    expect(countCaptureGroups("(?<=a)")).toBe(0);
    expect(countCaptureGroups("(?<!a)")).toBe(0);
  });

  it("ignores a paren that is escaped or inside a character class", () => {
    expect(countCaptureGroups(String.raw`\(a\)`)).toBe(0);
    expect(countCaptureGroups(String.raw`[(]a`)).toBe(0);
    expect(countCaptureGroups(String.raw`[(](b)`)).toBe(1);
  });

  it("agrees with the RegExp trick it replaced, on the patterns that matter", () => {
    // `new RegExp(src + "|").exec("")!.length - 1` was the old count. Kept as a
    // test rather than as the implementation: it compiles operator input a
    // second time, in a form the operator never wrote.
    const patterns = [
      FORTISWITCH_MODEL_PARSE.pattern,
      String.raw`^(\w+)-v[\d.]+`,
      String.raw`(?:x)(y)(?<z>w)`,
      String.raw`(?!v\d)(.+?)`,
      String.raw`[(]\((a)`,
    ];
    for (const p of patterns) {
      const viaRegExp = new RegExp(new RegExp(p).source + "|").exec("")!.length - 1;
      expect(countCaptureGroups(p)).toBe(viaRegExp);
    }
  });
});

describe("clampRegexSubject", () => {
  it("leaves a real subject untouched", () => {
    // Three joined sysDescr-class fields still fit — the cap must never be the
    // reason a device stops matching its profile.
    const realistic = "Fortinet FortiSwitch S548DF v7.2.5 build0453 230511 (GA)";
    expect(clampRegexSubject(realistic)).toBe(realistic);
    expect(clampRegexSubject("x".repeat(MAX_REGEX_SUBJECT))).toHaveLength(MAX_REGEX_SUBJECT);
  });

  it("cuts anything longer down to the cap", () => {
    expect(clampRegexSubject("x".repeat(MAX_REGEX_SUBJECT * 4))).toHaveLength(MAX_REGEX_SUBJECT);
  });

  it("bounds what a quadratic pattern can cost", () => {
    // `(a+)(a+)b` is polynomial on a backtracking engine; the cap keeps even
    // that cheap (operator patterns themselves run on RE2 — utils/safeRegex.ts).
    const pattern = /(a+)(a+)b/;
    const started = Date.now();
    expect(pattern.test(clampRegexSubject("a".repeat(100_000)))).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
