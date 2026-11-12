/**
 * tests/unit/zodArrayCaps.test.ts — every Zod array schema in src/ carries a
 * length cap (`.max()` / `.length()`).
 *
 * Why (GHSA-mrhx-c7xc-m3w5, Dependabot #81): a failing array yields one issue
 * object per failing element. Zod 4.6.6+ stops at the length check when the
 * array is over its `.max()` — one issue — but an UNCAPPED array still
 * accumulates one per element, and a 1 MB JSON body carries ~500k of them
 * (~175 MB of heap, measured on 3.25.76). The cap is what makes the upgrade a
 * fix. Pick a ceiling well above any real size; it bounds the issue count.
 *
 * Exempt, and why:
 *   - `z.array(z.unknown())` — no element can fail, so no per-element issues;
 *   - src/utils/platformLifecycleGrade.ts — parses the committed EOL dataset
 *     (src/data/platformEol.json), never request input.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(__dirname, "../..");
const EXEMPT_FILES = new Set(["src/utils/platformLifecycleGrade.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "generated") walk(p, out); }
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Index of the bracket closing the one at `i`, skipping string literals. */
function closeAt(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) return i; }
    else if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) { if (s[i] === "\\") i++; i++; }
    }
  }
  return -1;
}

/** "file:line  snippet" for every uncapped array schema in one source. */
function uncappedArrays(file: string, s: string): string[] {
  const out: string[] = [];
  const re = /z\.array\(|\.array\(\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    // `.array()` closes where it matched; `z.array(` closes at its bracket's pair.
    const end = m[0] === ".array()" ? m.index + m[0].length - 1 : closeAt(s, m.index + m[0].length - 1);
    if (end < 0) continue;
    if (/^z\.array\(\s*z\.unknown\(\)\s*\)$/.test(s.slice(m.index, end + 1))) continue;
    const methods: string[] = [];
    let j = end + 1;
    for (;;) {
      const r = /^\s*\.([A-Za-z]+)\(/.exec(s.slice(j));
      if (!r) break;
      methods.push(r[1]);
      const close = closeAt(s, j + r[0].length - 1);
      if (close < 0) break;
      j = close + 1;
    }
    if (!methods.includes("max") && !methods.includes("length")) {
      const line = s.slice(0, m.index).split("\n").length;
      out.push(`${file}:${line}  ${s.slice(m.index, Math.min(end + 1, m.index + 80)).replace(/\s+/g, " ")}`);
    }
  }
  return out;
}

describe("Zod array caps", () => {
  it("the scanner sees a chained cap and flags a missing one", () => {
    expect(uncappedArrays("x.ts", "a: z.array(z.string()).max(10).optional(),")).toEqual([]);
    expect(uncappedArrays("x.ts", "a: z.array(z.object({ b: z.string() })).optional().max(5),")).toEqual([]);
    expect(uncappedArrays("x.ts", "a: z.array(z.unknown()).optional(),")).toEqual([]);
    expect(uncappedArrays("x.ts", "a: z.array(z.string()).optional(),")).toHaveLength(1);
    expect(uncappedArrays("x.ts", "a: z.string().array(),")).toHaveLength(1);
  });

  it("every array schema in src/ has a .max()", () => {
    const found: string[] = [];
    for (const abs of walk(join(ROOT, "src"))) {
      const rel = relative(ROOT, abs).split(sep).join("/");
      if (EXEMPT_FILES.has(rel)) continue;
      const s = readFileSync(abs, "utf8");
      if (!s.includes('from "zod"')) continue;
      found.push(...uncappedArrays(rel, s));
    }
    expect(found, "uncapped Zod arrays — add a .max() (see this file's header)").toEqual([]);
  });
});
