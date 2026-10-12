/**
 * tests/unit/csvFormulaSafety.test.ts
 *
 * The shared CSV helper wrote device-reported text as-is, so a cell beginning
 * with = + - @ (or a tab / CR) became a spreadsheet formula when an operator
 * opened an export (scan findings F241, F258; business rule 109).
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const src = readFileSync(resolve(__dirname, "../../public/js/api.js"), "utf8");

beforeAll(() => {
  // The helper is a few lines at the bottom of api.js: its two patterns, the cell
  // function and the row function. Evaluate exactly that span.
  const start = src.indexOf("var _CSV_FORMULA_START");
  const end = src.indexOf("if (typeof window", src.indexOf("function _csvRow"));
  // eslint-disable-next-line no-eval
  (0, eval)(src.slice(start, end));
});

const row = (cells: unknown[]): string => g._csvRow(cells);

describe("_csvRow formula neutralisation", () => {
  it.each([
    ["=cmd|' /C calc'!A0", "'=cmd|' /C calc'!A0"],
    ["=HYPERLINK(\"http://evil\",\"x\")", "\"'=HYPERLINK(\"\"http://evil\"\",\"\"x\"\")\""],
    ["+1+1", "'+1+1"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1:A2)", "'@SUM(A1:A2)"],
    ["\tcmd", "'\tcmd"],
    ["\rcmd", "\"'\rcmd\""],
  ])("prefixes %j so it is read as text", (input, expected) => {
    expect(row([input])).toBe(expected);
  });

  it("leaves ordinary text alone", () => {
    expect(row(["fw-atl-01", "Windows 11", "10.0.0.5", "a=b", "x-y", "user@example.com"])).toBe(
      "fw-atl-01,Windows 11,10.0.0.5,a=b,x-y,user@example.com",
    );
  });

  it("leaves plain numbers alone, including negatives and exponents", () => {
    expect(row([5, -12.5, "-3", "+7", "1e3", "-1.5E-2", 0])).toBe("5,-12.5,-3,+7,1e3,-1.5E-2,0");
  });

  it("treats an almost-number as text, since it may be a formula", () => {
    expect(row(["-1+1", "-12.5.3", "+cmd", "-"])).toBe("'-1+1,'-12.5.3,'+cmd,'-");
  });

  it("still quotes commas, quotes and line breaks, and still handles null", () => {
    expect(row(["a,b", 'say "hi"', "two\nlines", null, undefined])).toBe('"a,b","say ""hi""","two\nlines",,');
  });

  it("quotes after prefixing, so a hostile cell with a comma stays one cell", () => {
    expect(row(["=1,2"])).toBe('"\'=1,2"');
  });
});
