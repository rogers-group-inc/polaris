import { describe, it, expect } from "vitest";
import {
  MAX_REGEX_SUBJECT,
  clampRegexSubject,
  countCaptureGroups,
  findUnsafeRegexConstruct,
} from "../../src/utils/regexSafety.js";
import { FORTISWITCH_MODEL_PARSE } from "../../src/utils/fortiswitchModel.js";

// The guards that stand in for escaping on the three regexes an OPERATOR
// supplies (ManufacturerProfile.matchPattern / modelPattern, and the model
// row's parsePattern). Escaping is not available here — the whole point of
// those fields is that the operator's text IS the pattern — so these two are
// what keep a typo from parking a monitor worker forever.

describe("findUnsafeRegexConstruct", () => {
  it("flags an unbounded quantifier on a group that already has one", () => {
    // The textbook exponential shapes. Each returns the offending text, so the
    // operator is shown the part to fix rather than told the pattern is bad.
    expect(findUnsafeRegexConstruct("(a+)+")).toBe("(a+)+");
    expect(findUnsafeRegexConstruct("(a*)*")).toBe("(a*)*");
    expect(findUnsafeRegexConstruct("(a+)*")).toBe("(a+)*");
    expect(findUnsafeRegexConstruct("(.*)+")).toBe("(.*)+");
    expect(findUnsafeRegexConstruct(String.raw`(\w+|\d+)*`)).toBe(String.raw`(\w+|\d+)*`);
  });

  it("flags it wherever it sits, and names only the offending part", () => {
    expect(findUnsafeRegexConstruct(String.raw`^Cisco-(\w+)-(v\d+)$`)).toBeNull();
    expect(findUnsafeRegexConstruct(String.raw`^Cisco-(\d+\s*)+-(\w+)$`)).toBe(String.raw`(\d+\s*)+`);
  });

  it("refuses a nested quantifier that a literal actually anchors — a known false positive", () => {
    // `(v\d+)+` cannot blow up: `\d` never matches the `v` that starts each
    // repetition, so the split points are fixed. The check flags it anyway,
    // because telling the two apart needs the kind of analysis a linear-time
    // engine does. Pinned as a test so the trade-off is deliberate and visible
    // rather than something a later reader discovers from a support ticket:
    // the cost is an operator rewriting a working pattern, and the thing it
    // buys is that nothing decides "probably fine" about a regex that would
    // park a monitor worker.
    expect(findUnsafeRegexConstruct(String.raw`(v\d+)+`)).toBe(String.raw`(v\d+)+`);
  });

  it("treats lazy and {n,} as unbounded, since laziness changes order not count", () => {
    expect(findUnsafeRegexConstruct("(a+?)+?")).toBe("(a+?)+?");
    expect(findUnsafeRegexConstruct("(a{1,})+")).toBe("(a{1,})+");
    expect(findUnsafeRegexConstruct("(a+){2,}")).toBe("(a+){2,}");
  });

  it("passes the shapes that do NOT explode", () => {
    expect(findUnsafeRegexConstruct("(ab)+")).toBeNull(); // no inner quantifier
    expect(findUnsafeRegexConstruct("(a{1,3})+")).toBeNull(); // inner is bounded
    expect(findUnsafeRegexConstruct("(a+){2}")).toBeNull(); // outer is bounded
    expect(findUnsafeRegexConstruct("(a+)(b+)")).toBeNull(); // neither is nested
    expect(findUnsafeRegexConstruct(String.raw`^(\w+)-v[\d.]+-build`)).toBeNull();
  });

  it("does not mistake a literal quantifier or paren for the real thing", () => {
    // Inside a class and behind a backslash, `+` `*` `(` `)` are just characters.
    expect(findUnsafeRegexConstruct(String.raw`([a+*]+)x`)).toBeNull();
    expect(findUnsafeRegexConstruct(String.raw`(\+\*)+`)).toBeNull();
    expect(findUnsafeRegexConstruct(String.raw`(a\)+)b`)).toBeNull();
    // `{` that is not a quantifier is a literal brace, not an unbounded repeat.
    expect(findUnsafeRegexConstruct("(a{foo})+")).toBeNull();
  });

  it("leaves the shipped FortiSwitch parse alone", () => {
    // The one seeded pattern. A guard that refused it would be a regression the
    // moment anyone re-saved the Fortinet profile's model row.
    expect(findUnsafeRegexConstruct(FORTISWITCH_MODEL_PARSE.pattern)).toBeNull();
  });

  it("is linear in the pattern, so validating a hostile pattern is itself cheap", () => {
    const started = Date.now();
    expect(findUnsafeRegexConstruct("(".repeat(500) + "a" + ")".repeat(500))).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });
});

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
    // `(a+)(a+)b` is polynomial, not exponential, so the guard that saves it is
    // the cap rather than findUnsafeRegexConstruct — which passes it, correctly.
    const pattern = /(a+)(a+)b/;
    expect(findUnsafeRegexConstruct(pattern.source)).toBeNull();
    const started = Date.now();
    expect(pattern.test(clampRegexSubject("a".repeat(100_000)))).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
