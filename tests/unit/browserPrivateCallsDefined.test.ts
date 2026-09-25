/**
 * tests/unit/browserPrivateCallsDefined.test.ts
 *
 * Every `_name(` call in public/js resolves to a definition somewhere in
 * public/js.
 *
 * The browser scripts share one global scope and have no build step, so a
 * helper that one branch removes while another branch still calls it merges
 * with no conflict, passes typecheck (public/ is not typechecked) and every
 * unit test that slices a different function — and throws a ReferenceError
 * the first time a page draws. The path-check charts called `_chartTickFmt`
 * after main retired it for `_chartXTicksSVG` (2026-09-25); only a browser
 * found it. This is the cheap static half of that check.
 *
 * Scope: underscore-prefixed names only (the codebase's file-private helper
 * convention), called as a bare identifier (not `obj._x(`). Comments are
 * stripped first so prose like "instead of _topnBar (whose …" is not a call.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../public/js");

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== "vendor") out.push(...jsFiles(p)); }
    else if (f.endsWith(".js")) out.push(p);
  }
  return out;
}

/**
 * Drop block and line comments, leaving string literals intact. A regex pass
 * is not enough: a string like "text/*" opens a fake block comment that eats
 * real code up to the next "*\/" (it hid a genuine definition), and "http://"
 * looks like a line comment.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i]!, n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; out += " "; continue; }
    if (c === "/" && n === "/") { const e = src.indexOf("\n", i); i = e < 0 ? src.length : e; continue; }
    out += c;
    i++;
  }
  return out;
}

describe("browser scripts: every private helper that is called is defined", () => {
  const files = jsFiles(ROOT).map((f) => ({ f, src: stripComments(readFileSync(f, "utf8")) }));
  const defined = new Set<string>();
  const DEF = /(?:function\s+|(?:var|let|const)\s+)(_[A-Za-z0-9_]+)\b|(?:window|self|globalThis)\.(_[A-Za-z0-9_]+)\s*=|\b(_[A-Za-z0-9_]+)\s*:\s*function|\b(_[A-Za-z0-9_]+)\s*=\s*function/g;
  for (const { src } of files) for (const m of src.matchAll(DEF)) defined.add((m[1] || m[2] || m[3] || m[4])!);

  it("finds the definitions it checks against", () => {
    // A sanity floor — an empty set would make the next assertion vacuous.
    expect(defined.size).toBeGreaterThan(500);
    expect(defined.has("_chartXTicksSVG")).toBe(true);
  });

  it("has no call to an undefined _helper", () => {
    const missing: string[] = [];
    for (const { f, src } of files) {
      for (const m of src.matchAll(/(?<![.\w$])(_[A-Za-z][A-Za-z0-9_]*)\s*\(/g)) {
        if (!defined.has(m[1]!)) missing.push(`${m[1]} in ${relative(ROOT, f)}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});
