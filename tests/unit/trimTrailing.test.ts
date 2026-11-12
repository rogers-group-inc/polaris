/**
 * tests/unit/trimTrailing.test.ts
 *
 * Business rule 116: the regex-free trailing trim. linearRegex.test.ts covers
 * the linear-time promise on hostile input; this pins the semantics.
 */

import { describe, it, expect } from "vitest";
import { trimTrailing, isWhitespaceChar } from "../../src/utils/trimTrailing.js";

describe("trimTrailing", () => {
  it("strips a run of any of the given characters from the end only", () => {
    expect(trimTrailing("https://h/x///", "/")).toBe("https://h/x");
    expect(trimTrailing("//lead", "/")).toBe("//lead");
    expect(trimTrailing("body\r\n\n\r", "\r\n")).toBe("body");
  });

  it("returns the same string when nothing trails", () => {
    const s = "abc";
    expect(trimTrailing(s, "/")).toBe(s);
  });

  it("can trim to empty", () => {
    expect(trimTrailing("////", "/")).toBe("");
    expect(trimTrailing("", "/")).toBe("");
  });

  it("an empty char set trims nothing", () => {
    expect(trimTrailing("a//", "")).toBe("a//");
  });

  it("accepts a predicate", () => {
    expect(trimTrailing("value \t\n", isWhitespaceChar)).toBe("value");
    expect(trimTrailing("a123", (c) => c >= "0" && c <= "9")).toBe("a");
  });

  it("matches the regex it replaced", () => {
    for (const s of ["", "/", "a/", "a/b//", "x/y", "///a///"]) {
      expect(trimTrailing(s, "/")).toBe(s.replace(/\/+$/, ""));
    }
  });
});

describe("isWhitespaceChar", () => {
  it("follows \\s", () => {
    for (const c of [" ", "\t", "\n", "\r", "\v", "\f", " ", " "]) expect(isWhitespaceChar(c)).toBe(true);
    for (const c of ["a", "0", "_", ""]) expect(isWhitespaceChar(c)).toBe(false);
  });
});
