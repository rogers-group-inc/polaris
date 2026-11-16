/**
 * tests/unit/mibParserUtils.test.ts — shared SMI text helpers (CQ-T010).
 *
 * Contract (snmp-mibs-profiles touches entry): comments become whitespace (not
 * deleted) so offsets and line numbers survive; both `--…<newline>` and
 * `--…--` forms; `--` inside a quoted string is preserved. parseImportMap
 * reads IMPORTS as symbol → module pairs and never throws.
 */

import { describe, it, expect } from "vitest";
import { stripComments, parseImportMap, IMPORTS_BLOCK_RE } from "../../src/services/mibParserUtils.js";

describe("stripComments", () => {
  it("leaves comment-free text untouched", () => {
    const t = "ifIndex OBJECT-TYPE\n  SYNTAX Integer32\n";
    expect(stripComments(t)).toBe(t);
  });

  it("blanks a to-end-of-line comment and keeps the newline", () => {
    expect(stripComments("a -- note\nb")).toBe("a        \nb");
  });

  it("closes a comment at the next `--` and resumes code after it", () => {
    expect(stripComments("a -- c -- b")).toBe("a         b");
  });

  it("a whole line beginning with `--`", () => {
    expect(stripComments("-- header\nX")).toBe("         \nX");
  });

  it("preserves length and every line break (offsets and line numbers line up)", () => {
    const t = "A -- one\r\nB -- two -- C\n-- three\n\"q -- not\" -- four";
    const out = stripComments(t);
    expect(out.length).toBe(t.length);
    expect(out.split(/\r?\n/).length).toBe(t.split(/\r?\n/).length);
    expect([...out].filter((c) => c === "\n" || c === "\r")).toEqual([...t].filter((c) => c === "\n" || c === "\r"));
  });

  it("stops a comment at a bare CR too", () => {
    expect(stripComments("a --x\rb")).toBe("a    \rb");
  });

  it("keeps tabs inside a comment as tabs", () => {
    expect(stripComments("--\tx\ty\n")).toBe("  \t \t \n");
  });

  it("does not strip `--` inside a quoted DESCRIPTION", () => {
    const t = 'DESCRIPTION "range 1--10 -- inclusive"';
    expect(stripComments(t)).toBe(t);
  });

  it("ignores a quote inside a comment", () => {
    expect(stripComments('a -- he said "x\nb "--" c')).toBe('a              \nb "--" c');
  });

  it("handles ASN.1 doubled quotes (\"\") as adjacent strings", () => {
    const t = 'DESCRIPTION "say ""hi"" -- not a comment"';
    expect(stripComments(t)).toBe(t);
  });

  it("an unterminated string runs to EOF untouched", () => {
    const t = 'X "open -- forever';
    expect(stripComments(t)).toBe(t);
  });

  it("a comment at EOF with no newline", () => {
    expect(stripComments("END --")).toBe("END   ");
    expect(stripComments("END -- tail")).toBe("END        ");
  });

  it("a separator line of dashes is all whitespace", () => {
    expect(stripComments("------------\nX")).toBe("            \nX");
    expect(stripComments("---\nX")).toBe("   \nX");
  });

  it("a single dash is code", () => {
    expect(stripComments("a-b - c")).toBe("a-b - c");
  });

  it("empty input", () => {
    expect(stripComments("")).toBe("");
  });

  it("a keyword inside a comment is hidden from later regex scans", () => {
    expect(stripComments("-- IMPORTS foo FROM BAR;\nX")).not.toMatch(/IMPORTS/);
  });
});

describe("parseImportMap", () => {
  it("reads symbol → module pairs, macros included, in order", () => {
    const mib = `FORTINET-FORTIGATE-MIB DEFINITIONS ::= BEGIN
IMPORTS
    fortinet, FnBoolState            FROM FORTINET-CORE-MIB
    MODULE-IDENTITY, OBJECT-TYPE     FROM SNMPv2-SMI;
fgModule MODULE-IDENTITY ::= { fortinet 101 }
END`;
    expect(parseImportMap(mib)).toEqual([
      { symbol: "fortinet", module: "FORTINET-CORE-MIB" },
      { symbol: "FnBoolState", module: "FORTINET-CORE-MIB" },
      { symbol: "MODULE-IDENTITY", module: "SNMPv2-SMI" },
      { symbol: "OBJECT-TYPE", module: "SNMPv2-SMI" },
    ]);
  });

  it("a module with no IMPORTS block returns []", () => {
    expect(parseImportMap("X DEFINITIONS ::= BEGIN END")).toEqual([]);
    expect(parseImportMap("")).toEqual([]);
  });

  it("an IMPORTS block with no terminating `;` returns []", () => {
    expect(parseImportMap("IMPORTS a FROM B")).toEqual([]);
  });

  it("ignores commented-out imports", () => {
    const mib = `IMPORTS
    -- old, gone FROM LEGACY-MIB
    ifIndex FROM IF-MIB -- trailing note FROM NOPE-MIB
    ;`;
    expect(parseImportMap(mib)).toEqual([{ symbol: "ifIndex", module: "IF-MIB" }]);
  });

  it("an IMPORTS keyword inside a comment is not the block", () => {
    const mib = `-- IMPORTS fake FROM FAKE-MIB;
IMPORTS real FROM REAL-MIB;`;
    expect(parseImportMap(mib)).toEqual([{ symbol: "real", module: "REAL-MIB" }]);
  });

  it("skips tokens that are not identifiers and empty list slots", () => {
    const mib = "IMPORTS a, , 1bad, b-c, x.y FROM M1;";
    expect(parseImportMap(mib)).toEqual([
      { symbol: "a", module: "M1" },
      { symbol: "b-c", module: "M1" },
    ]);
  });

  it("keeps duplicate symbols (callers decide)", () => {
    expect(parseImportMap("IMPORTS a FROM M1 a FROM M2;")).toEqual([
      { symbol: "a", module: "M1" },
      { symbol: "a", module: "M2" },
    ]);
  });

  it("reads only the first IMPORTS block", () => {
    expect(parseImportMap("IMPORTS a FROM M1; IMPORTS b FROM M2;")).toEqual([{ symbol: "a", module: "M1" }]);
  });

  it("does not take FROMAGE for FROM", () => {
    expect(parseImportMap("IMPORTS FROMAGE FROM CHEESE-MIB;")).toEqual([{ symbol: "FROMAGE", module: "CHEESE-MIB" }]);
  });

  it("is linear on a large hostile input (RE2, rule 116)", () => {
    const big = "IMPORTS " + "a, ".repeat(200_000);
    const t0 = Date.now();
    expect(parseImportMap(big)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("IMPORTS_BLOCK_RE", () => {
  it("captures the block body up to the first `;`", () => {
    const m = IMPORTS_BLOCK_RE.exec("x IMPORTS a FROM B; y;");
    expect(m?.[1]).toBe(" a FROM B");
  });
});
