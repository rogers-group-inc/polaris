/**
 * tests/unit/assetTypeMatchRegexSafety.test.ts
 *
 * Asset-type match rules take an operator-typed regex, and the match-preview
 * endpoint runs it against a payload the caller supplies with only
 * `assets:read`. A JavaScript regex cannot be interrupted, so the exponential
 * shape is refused at write time and neither stored patterns nor subjects are
 * trusted at match time. See utils/regexSafety.ts.
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
    expect(validateRegex("([unclosed")).toMatch(/Invalid regular expression/);
  });

  it.each(["(a+)+$", "(a*)*b", "(.*)+x", String.raw`(\w+|\d+)*z`])(
    "refuses the catastrophic shape %s",
    (pattern) => {
      expect(validateRegex(pattern)).toMatch(/may never finish/);
    },
  );
});

describe("validateMatchRules", () => {
  it("refuses a catastrophic regex clause, in the tree shape", () => {
    const err = validateMatchRules({ op: "or", children: [{ field: "os", operator: "regex", value: "(a+)+$" }] });
    expect(err).toMatch(/may never finish/);
  });

  it("refuses it in the legacy flat shape too", () => {
    const err = validateMatchRules({ clauses: [{ field: "os", op: "regex", value: "(a+)+$" }] });
    expect(err).toMatch(/may never finish/);
  });
});

describe("clauseMatches with a catastrophic pattern that is already stored", () => {
  it("treats it as no-match instead of running it", () => {
    // 40 a's then a character the pattern cannot match: unguarded, this is
    // 2^40 steps. The assertion is that it RETURNS, and returns false.
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
