/**
 * tests/unit/safeRegex.test.ts
 *
 * Business rule 116: operator regexes run on RE2. linearRegex.test.ts covers
 * the linear-time promise and the basic exec/execAll shapes; this pins the
 * operator-facing error messages, the memo cache and the stored-pattern path.
 */

import { describe, it, expect } from "vitest";
import { compileSafeRegex, safeRegexProblem, tryCompileSafeRegex } from "../../src/utils/safeRegex.js";
import { AppError } from "../../src/utils/errors.js";

describe("compileSafeRegex", () => {
  it("memoizes per (pattern, flags)", () => {
    const a = compileSafeRegex("ab+c");
    expect(compileSafeRegex("ab+c")).toBe(a);
    const ci = compileSafeRegex("ab+c", { ignoreCase: true });
    expect(ci).not.toBe(a);
    expect(a.test("ABBC")).toBe(false);
    expect(ci.test("ABBC")).toBe(true);
  });

  it("keeps the operator's source", () => {
    expect(compileSafeRegex("^x$").source).toBe("^x$");
  });

  it("is unanchored like RegExp.test and coerces the subject to a string", () => {
    const re = compileSafeRegex("\\d+");
    expect(re.test("abc 12 def")).toBe(true);
    expect(re.test(123 as unknown as string)).toBe(true);
    expect(re.exec("none")).toBeNull();
  });

  it("execAll returns non-overlapping matches with their start index and [] when none", () => {
    const all = compileSafeRegex("a(b)?").execAll("ab a xab");
    expect(all.map((m) => [m[0], m[1], m.index])).toEqual([["ab", "b", 0], ["a", undefined, 3], ["ab", "b", 6]]);
    expect(compileSafeRegex("z").execAll("abc")).toEqual([]);
  });

  it("throws AppError 400 for a non-string pattern", () => {
    expect(() => compileSafeRegex(5 as unknown as string)).toThrow(AppError);
    try { compileSafeRegex(null as unknown as string); } catch (e) {
      expect((e as AppError).httpStatus).toBe(400);
      expect((e as Error).message).toBe("Regex must be a string");
    }
  });
});

describe("safeRegexProblem", () => {
  it("is null for a pattern RE2 accepts", () => {
    expect(safeRegexProblem("^(\\w+)-(v\\d+)?$")).toBeNull();
  });

  it.each(["foo(?=bar)", "foo(?!bar)", "(?<=a)b", "(?<!a)b"])("names lookaround for %s", (p) => {
    expect(safeRegexProblem(p)).toMatch(/lookahead or lookbehind/);
  });

  it("names a backreference", () => {
    expect(safeRegexProblem("(a)\\1")).toMatch(/backreference/);
  });

  it("strips RE2's 'error parsing regexp:' prefix from other errors", () => {
    const msg = safeRegexProblem("(unclosed");
    expect(msg).toMatch(/^Invalid regex "\(unclosed": /);
    expect(msg).not.toMatch(/error parsing regexp/i);
  });
});

describe("tryCompileSafeRegex", () => {
  it("returns null for a stored pattern RE2 cannot run instead of throwing", () => {
    expect(tryCompileSafeRegex("a(?=b)")).toBeNull();
    expect(tryCompileSafeRegex("ok")?.test("ok")).toBe(true);
  });
});
