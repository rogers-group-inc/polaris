/**
 * tests/unit/assetTypeMatchRegexSafety.test.ts
 *
 * Asset-type match rules take an operator-typed regex, and the match-preview
 * endpoint runs it against a payload the caller supplies with only
 * `assets:read`. Since business rule 115 every such pattern runs on RE2
 * (utils/safeRegex.ts), so no shape can hang the process: the "catastrophic"
 * patterns are now accepted and still return at once, and what is refused is a
 * pattern RE2 cannot compile (lookaround, backreferences, syntax errors).
 */

import { describe, it, expect } from "vitest";
import {
  clauseMatches,
  validateMatchRules,
  validateRegex,
} from "../../src/utils/assetTypeMatch.js";
import { MAX_REGEX_SUBJECT } from "../../src/utils/regexSafety.js";

const facts = (os: string) => ({ os, hostname: null, manufacturer: null, model: null, productType: null });

describe("validateRegex", () => {
  it("still accepts an ordinary pattern", () => {
    expect(validateRegex("^windows (server|10)")).toBeNull();
  });

  it("still reports a pattern that does not compile", () => {
    expect(validateRegex("([unclosed")).toMatch(/Invalid regex/);
  });

  it.each(["(a+)+$", "(a*)*b", "(.*)+x", String.raw`(\w+|\d+)*z`, ".*.*.*.*x", "(a|aa)+b"])(
    "accepts the once-catastrophic shape %s — RE2 runs it in linear time",
    (pattern) => {
      expect(validateRegex(pattern)).toBeNull();
    },
  );

  it("refuses lookaround and backreferences, which RE2 cannot run", () => {
    expect(validateRegex("(?=windows)win")).toMatch(/lookahead or lookbehind/);
    expect(validateRegex(String.raw`(a)\1`)).toMatch(/backreference/);
  });
});

describe("validateMatchRules", () => {
  it("accepts a once-catastrophic regex clause, in the tree shape", () => {
    expect(validateMatchRules({ op: "or", children: [{ field: "os", operator: "regex", value: "(a+)+$" }] })).toBeNull();
  });

  it("refuses a lookahead clause in the legacy flat shape", () => {
    const err = validateMatchRules({ clauses: [{ field: "os", op: "regex", value: "(?!x)a" }] });
    expect(err).toMatch(/lookahead or lookbehind/);
  });
});

describe("clauseMatches with a once-catastrophic pattern", () => {
  it("runs it on RE2 and returns at once", () => {
    // 40 a's then a character the pattern cannot match: on a backtracking
    // engine this is 2^40 steps. The assertion is that it RETURNS, and false.
    const subject = "a".repeat(40) + "!";
    const started = Date.now();
    expect(clauseMatches({ field: "os", operator: "regex", value: "(a+)+$" }, facts(subject))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("is a no-match under a negative operator's inversion rule as well as a positive one", () => {
    const subject = "a".repeat(40) + "!";
    expect(clauseMatches({ field: "os", operator: "notRegex", value: "(a+)+$" } as any, facts(subject))).toBe(true);
  });
});

describe("clauseMatches subject length", () => {
  it("never runs a pattern against more than MAX_REGEX_SUBJECT characters", () => {
    const tail = "needle";
    const subject = "x".repeat(MAX_REGEX_SUBJECT + 50) + tail;
    // The match sits beyond the cap, so it is not seen — truncation can only
    // miss a match, never invent one or hang.
    expect(clauseMatches({ field: "os", operator: "regex", value: "needle" }, facts(subject))).toBe(false);
    expect(clauseMatches({ field: "os", operator: "regex", value: "^x" }, facts(subject))).toBe(true);
  });

  it("matches a normal-length subject exactly as before", () => {
    expect(clauseMatches({ field: "os", operator: "regex", value: "^ubuntu" }, facts("Ubuntu 24.04"))).toBe(true);
  });
});
