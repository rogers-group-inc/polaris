/**
 * tests/unit/storedRegexAuditService.test.ts — business rule 116(e): find the
 * operator regexes already stored that RE2 cannot compile.
 *
 * Every source (manufacturer profile, per-model override model/parse pattern,
 * custom widget, asset-type match rules, integration auto-monitor blocks,
 * HTTP-check credentials, path checks, regex log-flag rules, the Application
 * Map Setting) is read in one parallel batch; `regexPatternsIn` finds the
 * stored shapes inside JSON; `countUnusableStoredPatterns` is a 10-minute
 * cached count that never throws.
 *
 * Real RE2 (re2js — pure JS) judges the patterns; only the DB is stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/appMapDiscoveryService.js", () => ({ SETTING_KEY: "appMapAutoMap" }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  regexPatternsIn,
  findUnusableStoredPatterns,
  countUnusableStoredPatterns,
} from "../../src/services/storedRegexAuditService.js";

const LOOKAHEAD = "^Forti(?=Gate)";
const BACKREF = "(ab)\\1";
const GOOD = "^FortiGate-\\d+";

const MODELS = [
  "manufacturerProfile", "manufacturerProfileMetricOverride", "manufacturerCustomWidget", "assetTypeDef",
  "integration", "credential", "pathCheck", "logFlagRule",
] as const;

function rows(model: (typeof MODELS)[number], value: unknown[]): void {
  stubbed((prisma as unknown as Record<string, { findMany: unknown }>)[model].findMany).mockResolvedValue(value);
}

beforeEach(() => {
  resetDbStub();
  for (const m of MODELS) rows(m, []);
  stubbed(prisma.setting.findUnique).mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("regexPatternsIn", () => {
  it("finds auto-monitor / Application Map blocks only when regex is true", () => {
    expect(regexPatternsIn({ regex: true, patterns: ["a", "", 3, "b"] })).toEqual(["a", "b"]);
    expect(regexPatternsIn({ regex: false, patterns: ["a"] })).toEqual([]);
    expect(regexPatternsIn({ regex: "true", patterns: ["a"] })).toEqual([]);
  });

  it("finds asset-type match clauses under op or operator, regex or notRegex", () => {
    expect(regexPatternsIn([
      { field: "model", op: "regex", value: "x1" },
      { field: "model", operator: "notRegex", value: "x2" },
      { field: "model", op: "equals", value: "x3" },
      { field: "model", op: "regex", value: "" },
    ])).toEqual(["x1", "x2"]);
  });

  it("finds an HTTP-check body regex only in regex match mode", () => {
    expect(regexPatternsIn({ matchMode: "regex", expectBody: "ok.*" })).toEqual(["ok.*"]);
    expect(regexPatternsIn({ matchMode: "contains", expectBody: "ok.*" })).toEqual([]);
  });

  it("finds a path-check body match, preferring pattern over value", () => {
    expect(regexPatternsIn({ bodyMatch: { mode: "regex", pattern: "p", value: "v" } })).toEqual(["p"]);
    expect(regexPatternsIn({ bodyMatch: { mode: "regex", value: "v" } })).toEqual(["v"]);
    expect(regexPatternsIn({ bodyMatch: { mode: "contains", pattern: "p" } })).toEqual([]);
  });

  it("walks nested objects and arrays", () => {
    expect(regexPatternsIn({
      monitoring: { interfaces: { regex: true, patterns: ["port\\d+"] }, storage: [{ regex: true, patterns: ["/data"] }] },
    })).toEqual(["port\\d+", "/data"]);
  });

  it("answers [] for non-objects", () => {
    for (const v of [null, undefined, "regex", 7, true]) expect(regexPatternsIn(v)).toEqual([]);
  });

  it("stops descending past 12 levels", () => {
    let deep: unknown = { regex: true, patterns: ["deep"] };
    for (let i = 0; i < 12; i++) deep = { child: deep };
    expect(regexPatternsIn(deep)).toEqual(["deep"]);
    expect(regexPatternsIn({ child: deep })).toEqual([]);
  });
});

describe("findUnusableStoredPatterns", () => {
  it("answers [] when every stored pattern compiles", async () => {
    rows("manufacturerProfile", [{ id: "p1", manufacturer: "Fortinet", matchPattern: GOOD }]);
    rows("logFlagRule", [{ id: "l1", name: "errors", pattern: "error|fail" }]);
    expect(await findUnusableStoredPatterns()).toEqual([]);
  });

  it("reports a manufacturer profile's lookahead with its source, row, name and a stable key", async () => {
    rows("manufacturerProfile", [{ id: "p1", manufacturer: "Fortinet", matchPattern: LOOKAHEAD }]);
    const [f, ...rest] = await findUnusableStoredPatterns();
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ source: "Manufacturer profile", id: "p1", name: "Fortinet", pattern: LOOKAHEAD });
    expect(f.problem).toMatch(/lookahead or lookbehind/);
    expect(f.key).toMatch(/^Manufacturer profile:p1:[0-9a-f]{12}$/);
    // Same (source, row, pattern) → same key; a different pattern → a different key.
    const again = await findUnusableStoredPatterns();
    expect(again[0].key).toBe(f.key);
    rows("manufacturerProfile", [{ id: "p1", manufacturer: "Fortinet", matchPattern: BACKREF }]);
    expect((await findUnusableStoredPatterns())[0].key).not.toBe(f.key);
  });

  it("reports an override's model and parse patterns separately, skipping the good one", async () => {
    rows("manufacturerProfileMetricOverride", [
      { id: "o1", modelPattern: LOOKAHEAD, parsePattern: BACKREF },
      { id: "o2", modelPattern: GOOD, parsePattern: null },
    ]);
    const out = await findUnusableStoredPatterns();
    expect(out.map((f) => [f.source, f.id, f.name])).toEqual([
      ["Manufacturer profile per-model exception", "o1", null],
      ["Manufacturer profile model parse", "o1", null],
    ]);
    expect(out[1].problem).toMatch(/backreference/);
  });

  it("reads every other source in its stored shape", async () => {
    rows("manufacturerCustomWidget", [{ id: "w1", name: "PSU", modelPattern: BACKREF }]);
    rows("assetTypeDef", [{ id: "t1", label: "Switch", matchRules: [{ op: "regex", value: LOOKAHEAD }] }]);
    rows("integration", [{ id: "i1", name: "FMG", config: { autoMonitorInterfaces: { regex: true, patterns: [BACKREF, GOOD] } } }]);
    rows("credential", [{ id: "c1", name: "web", config: { matchMode: "regex", expectBody: LOOKAHEAD } }]);
    rows("pathCheck", [{ id: "pc1", name: "portal", http: { bodyMatch: { mode: "regex", pattern: BACKREF } } }]);
    rows("logFlagRule", [{ id: "l1", name: "auth", pattern: "(?<!x)fail" }]);
    stubbed(prisma.setting.findUnique).mockResolvedValue({ value: { rules: [{ regex: true, patterns: [LOOKAHEAD] }] } });

    const out = await findUnusableStoredPatterns();
    expect(out.map((f) => [f.source, f.id, f.name])).toEqual([
      ["Custom widget", "w1", "PSU"],
      ["Asset type match rule", "t1", "Switch"],
      ["Integration auto-monitor pattern", "i1", "FMG"],
      ["HTTP check credential", "c1", "web"],
      ["Path check", "pc1", "portal"],
      ["Log-flag rule", "l1", "auth"],
      ["Application Map discovery rule", "appMapAutoMap", null],
    ]);
  });

  it("asks each source only for the rows that can hold a regex", async () => {
    await findUnusableStoredPatterns();
    expect(stubbed(prisma.credential.findMany).mock.calls[0][0].where).toEqual({ type: "http" });
    expect(stubbed(prisma.logFlagRule.findMany).mock.calls[0][0].where).toEqual({ matchType: "regex" });
    expect(stubbed(prisma.manufacturerProfile.findMany).mock.calls[0][0].where).toEqual({ matchPattern: { not: null } });
    expect(stubbed(prisma.setting.findUnique).mock.calls[0][0].where).toEqual({ key: "appMapAutoMap" });
  });

  it("carries on without the Application Map when its Setting read fails", async () => {
    rows("manufacturerProfile", [{ id: "p1", manufacturer: "Acme", matchPattern: LOOKAHEAD }]);
    stubbed(prisma.setting.findUnique).mockRejectedValue(new Error("db down"));
    expect((await findUnusableStoredPatterns()).map((f) => f.id)).toEqual(["p1"]);
  });

  it("rejects when any other source fails (the count wraps it)", async () => {
    stubbed(prisma.pathCheck.findMany).mockRejectedValue(new Error("db down"));
    await expect(findUnusableStoredPatterns()).rejects.toThrow("db down");
  });
});

describe("countUnusableStoredPatterns", () => {
  // The module-level cache has no reset hook: each test starts a day later.
  let day = 0;
  beforeEach(() => {
    day += 1;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T00:00:00Z").getTime() + day * 86_400_000);
  });

  it("counts the findings and caches the count for 10 minutes", async () => {
    rows("manufacturerProfile", [{ id: "p1", manufacturer: "A", matchPattern: LOOKAHEAD }]);
    expect(await countUnusableStoredPatterns()).toBe(1);
    rows("manufacturerProfile", []);
    vi.setSystemTime(Date.now() + 9 * 60_000);
    expect(await countUnusableStoredPatterns()).toBe(1);
    vi.setSystemTime(Date.now() + 60_000);
    expect(await countUnusableStoredPatterns()).toBe(0);
  });

  it("never throws: a failed read answers null (unknown) and is not cached", async () => {
    // Was a bug until 2026-11-16: a failed read answered 0, indistinguishable from "none".
    stubbed(prisma.integration.findMany).mockRejectedValueOnce(new Error("db down"));
    expect(await countUnusableStoredPatterns()).toBeNull();
    rows("manufacturerProfile", [{ id: "p1", manufacturer: "A", matchPattern: BACKREF }]);
    expect(await countUnusableStoredPatterns()).toBe(1);
  });
});
