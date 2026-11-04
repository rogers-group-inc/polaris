/**
 * tests/unit/logFlagRuleService.test.ts
 *
 * Pure-helper coverage for log-flag rules: the per-matchType
 * matcher (incl. case-sensitivity + minLevel gate + invalid-regex safety), and
 * scope filtering. The DB-bound CRUD + cache are exercised by integration tests.
 */

import { describe, it, expect } from "vitest";
import {
  compileRule,
  applicableRules,
  type LogFlagRuleRow,
  type CompiledRule,
} from "../../src/services/logFlagRuleService.js";

function rule(overrides: Partial<LogFlagRuleRow>): LogFlagRuleRow {
  return {
    id: "r1", name: "rule", enabled: true, scope: "global",
    assetId: null, processName: null, matchType: "substring",
    pattern: "error", caseSensitive: false, minLevel: null, label: null, color: null,
    ...overrides,
  };
}

describe("compileRule — matchers", () => {
  it("substring is case-insensitive by default", () => {
    const c = compileRule(rule({ matchType: "substring", pattern: "ERROR" }));
    expect(c.test("an error occurred", null)).toBe(true);
    expect(c.test("all clear", null)).toBe(false);
  });
  it("substring honors caseSensitive", () => {
    const c = compileRule(rule({ matchType: "substring", pattern: "ERROR", caseSensitive: true }));
    expect(c.test("an error occurred", null)).toBe(false);
    expect(c.test("an ERROR occurred", null)).toBe(true);
  });
  it("regex matches, invalid regex never matches (no throw)", () => {
    expect(compileRule(rule({ matchType: "regex", pattern: "fail\\d+" })).test("fail42", null)).toBe(true);
    const bad = compileRule(rule({ matchType: "regex", pattern: "fail(" }));
    expect(bad.test("fail(", null)).toBe(false); // invalid → never matches, doesn't throw
  });
  it("glob matches with wildcards", () => {
    const c = compileRule(rule({ matchType: "glob", pattern: "*timeout*" }));
    expect(c.test("connection timeout after 30s", null)).toBe(true);
    expect(c.test("ok", null)).toBe(false);
  });
  it("minLevel suppresses below-floor lines with a known level, allows unknown", () => {
    const c = compileRule(rule({ pattern: "x", minLevel: "error" }));
    expect(c.test("x", "warning")).toBe(false); // below floor
    expect(c.test("x", "error")).toBe(true);
    expect(c.test("x", "critical")).toBe(true);
    expect(c.test("x", null)).toBe(true);       // unknown level → not suppressed
  });
});

describe("applicableRules — scope filtering", () => {
  const compiled = (r: Partial<LogFlagRuleRow>): CompiledRule => compileRule(rule(r));
  const rules = [
    compiled({ id: "g", scope: "global" }),
    compiled({ id: "a", scope: "asset", assetId: "asset-1" }),
    compiled({ id: "a2", scope: "asset", assetId: "asset-2" }),
    compiled({ id: "p", scope: "process", assetId: "asset-1", processName: "nginx" }),
    compiled({ id: "p2", scope: "process", assetId: "asset-1", processName: "sshd" }),
  ];
  it("global applies everywhere; asset/process scope-match", () => {
    const ids = applicableRules(rules, "asset-1", "nginx").map((c) => c.rule.id).sort();
    expect(ids).toEqual(["a", "g", "p"]);
  });
  it("excludes other assets + other process names", () => {
    const ids = applicableRules(rules, "asset-1", "sshd").map((c) => c.rule.id).sort();
    expect(ids).toEqual(["a", "g", "p2"]);
    const ids2 = applicableRules(rules, "asset-3", "whatever").map((c) => c.rule.id);
    expect(ids2).toEqual(["g"]);
  });
});
