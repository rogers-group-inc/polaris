/**
 * tests/unit/linearRegex.test.ts
 *
 * Business rule 115: no regex Polaris runs can be made to take more than
 * linear time. The RE2 wrapper (utils/safeRegex), the regex-free trailing trim
 * (utils/trimTrailing), the stored-pattern walker (storedRegexAuditService) and
 * the MIB parser on the inputs the scan used to hang it.
 */

import { describe, it, expect } from "vitest";
import { compileSafeRegex, safeRegexProblem, tryCompileSafeRegex } from "../../src/utils/safeRegex.js";
import { trimTrailing, isWhitespaceChar } from "../../src/utils/trimTrailing.js";
import { regexPatternsIn } from "../../src/services/storedRegexAuditService.js";
import { parseMib } from "../../src/services/mibService.js";
import { parseObjectAssignments } from "../../src/services/oidRegistry.js";
import { parseImportMap } from "../../src/services/mibParserUtils.js";
import { compileRule } from "../../src/services/logFlagRuleService.js";

const fast = (fn: () => void, ms = 2000) => {
  const t = Date.now();
  fn();
  expect(Date.now() - t).toBeLessThan(ms);
};

describe("compileSafeRegex", () => {
  it("matches like RegExp for ordinary patterns, with groups", () => {
    const re = compileSafeRegex(String.raw`^(\w+)-(v\d+)?`, { ignoreCase: true });
    expect(re.test("S548-v7")).toBe(true);
    expect(re.exec("S548-x")).toEqual(["S548-", "S548", undefined]);
    expect(compileSafeRegex("abc", { ignoreCase: true }).test("xABCx")).toBe(true);
    expect(compileSafeRegex("abc").test("xABCx")).toBe(false);
  });

  it("iterates every match with execAll", () => {
    const all = compileSafeRegex(String.raw`(\d+)`).execAll("a1 b22 c333");
    expect(all.map((m) => m[1])).toEqual(["1", "22", "333"]);
    expect(all.map((m) => m.index)).toEqual([1, 4, 8]);
  });

  it("is linear on the classic catastrophic shapes", () => {
    fast(() => {
      expect(compileSafeRegex("(a+)+b").test("a".repeat(100_000))).toBe(false);
      expect(compileSafeRegex(String.raw`(.|\s)*x`).test(" ".repeat(100_000))).toBe(false);
      expect(compileSafeRegex(".*.*.*.*.*.*x").test("y".repeat(100_000))).toBe(false);
      expect(compileSafeRegex("(a|aa)+b").test("a".repeat(100_000))).toBe(false);
    });
  });

  it("names lookaround and backreferences, and other syntax errors, in operator words", () => {
    expect(safeRegexProblem("(?=x)")).toMatch(/lookahead or lookbehind/);
    expect(safeRegexProblem("(?<!x)y")).toMatch(/lookahead or lookbehind/);
    expect(safeRegexProblem(String.raw`(a)\1`)).toMatch(/backreference/);
    expect(safeRegexProblem("(unclosed")).toMatch(/^Invalid regex/);
    expect(safeRegexProblem("ok")).toBeNull();
    expect(tryCompileSafeRegex("(?=x)")).toBeNull();
  });
});

describe("trimTrailing", () => {
  it("trims like the regex it replaced", () => {
    expect(trimTrailing("https://x///", "/")).toBe("https://x");
    expect(trimTrailing("host...", ".")).toBe("host");
    expect(trimTrailing("ok\r\n\r\n", "\r\n")).toBe("ok");
    expect(trimTrailing("Report?!.", "?.!")).toBe("Report");
    expect(trimTrailing("Subject — :", (c) => isWhitespaceChar(c) || "—:".includes(c))).toBe("Subject");
    expect(trimTrailing("same", "/")).toBe("same");
    expect(trimTrailing("////", "/")).toBe("");
  });

  it("is linear on the input that made /\\/+$/ quadratic", () => {
    fast(() => expect(trimTrailing("/".repeat(500_000) + "x", "/")).toHaveLength(500_001));
  });
});

describe("regexPatternsIn (the stored-pattern walker)", () => {
  it("finds every stored regex shape, nested", () => {
    const blob = {
      fortigateMonitor: { autoMonitorInterfaces: { byPatterns: { regex: true, patterns: ["^wan", "(?=x)"] } } },
      storage: { byPatterns: { regex: false, patterns: ["/var*"] } },
      matchRules: { op: "or", children: [{ field: "os", operator: "regex", value: "win" }, { field: "os", op: "contains", value: "x" }] },
      check: { matchMode: "regex", expectBody: "OK$" },
      http: { bodyMatch: { mode: "regex", pattern: "up" } },
      agentDef: { expectBody: { mode: "regex", value: "ready" } },
    };
    expect(regexPatternsIn(blob).sort()).toEqual(["(?=x)", "OK$", "^wan", "ready", "up", "win"].sort());
  });
});

describe("MIB parsing on hostile uploads", () => {
  it("parses a 1 MB run of uppercase letters without stalling (F252)", () => {
    fast(() => expect(() => parseMib("A".repeat(1_000_000))).toThrow(/DEFINITIONS/), 5000);
  });

  it("parses many OBJECT-TYPE headers with no `::= {` in linear time (F243)", () => {
    const text = "a OBJECT-TYPE ".repeat(60_000);
    fast(() => expect(parseObjectAssignments(text)).toEqual([]), 5000);
  });

  it("still parses a real assignment and IMPORTS block", () => {
    const mib = [
      "TEST-MIB DEFINITIONS ::= BEGIN",
      "IMPORTS enterprises, OBJECT-TYPE FROM SNMPv2-SMI DisplayString FROM SNMPv2-TC;",
      "testRoot OBJECT IDENTIFIER ::= { enterprises 99999 }",
      "testName OBJECT-TYPE SYNTAX DisplayString MAX-ACCESS read-only STATUS current DESCRIPTION \"x\" ::= { testRoot 1 }",
      "END",
    ].join("\n");
    expect(parseObjectAssignments(mib)).toEqual([
      { name: "testRoot", parts: ["enterprises", "99999"] },
      { name: "testName", parts: ["testRoot", "1"] },
    ]);
    expect(parseImportMap(mib)).toEqual([
      { symbol: "enterprises", module: "SNMPv2-SMI" },
      { symbol: "OBJECT-TYPE", module: "SNMPv2-SMI" },
      { symbol: "DisplayString", module: "SNMPv2-TC" },
    ]);
    expect(parseMib(mib)).toMatchObject({ moduleName: "TEST-MIB", imports: ["SNMPv2-SMI", "SNMPv2-TC"] });
  });
});

describe("log-flag rules (F171)", () => {
  const rule = (over: Record<string, unknown>) => compileRule({
    id: "r", name: "r", enabled: true, scope: "global", assetId: null, processName: null,
    matchType: "regex", pattern: "", caseSensitive: false, minLevel: null, label: null, color: null,
    ...over,
  } as never);

  it("runs a regex on RE2 and a glob on the linear matcher, case-insensitively by default", () => {
    expect(rule({ pattern: "ERR(or)?" }).test("an error here", null)).toBe(true);
    expect(rule({ matchType: "glob", pattern: "*time?out*" }).test("Connection TIMEDOUT", null)).toBe(true);
    expect(rule({ matchType: "glob", pattern: "*a*", caseSensitive: true }).test("BAB", null)).toBe(false);
  });

  it("never stalls on a catastrophic pattern, and a pattern RE2 cannot compile matches nothing", () => {
    fast(() => expect(rule({ pattern: "(a+)+b" }).test("a".repeat(50_000), null)).toBe(false));
    expect(rule({ pattern: "(?=x)x" }).test("x", null)).toBe(false);
    fast(() => expect(rule({ matchType: "glob", pattern: "*".repeat(300) + "z" }).test("a".repeat(50_000), null)).toBe(false));
  });
});
