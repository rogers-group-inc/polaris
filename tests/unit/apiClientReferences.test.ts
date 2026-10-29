/**
 * tests/unit/apiClientReferences.test.ts — every `api.<group>.<method>(…)` call
 * in the frontend must resolve against the `api` object in public/js/api.js.
 *
 * This exists because the asset-details **MAC Table** tab shipped calling
 * `api.request("GET", …)` and threw `api.request is not a function` on every
 * open — `request` is module-scope in api.js and was never a member of `api`.
 * Nothing caught it: the frontend has no build step or type checker, and the
 * call only runs when an operator clicks that one tab on a switch. A whole tab
 * was dead in production.
 *
 * The check is deliberately static and conservative:
 *  - comments and string literals are stripped first, so a `// see api.js`
 *    reference or a `https://api.example.com` placeholder isn't a hit;
 *  - only CALLS count (`api.x.y(`), which is what a missing member breaks;
 *  - `api[group][method]` dynamic access is out of scope and unchecked.
 * A planted-bad-reference case guards the scanner itself, so a regex that
 * silently matches nothing can't make this test vacuously green.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const JS_DIR = resolve(__dirname, "../../public/js");

/** Drop block comments, line comments, and string/template literals. */
function stripNonCode(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, '""');
}

/** group name → member names, parsed out of the `const api = { … }` literal. */
function buildApiShape(): Map<string, Set<string>> {
  const src = readFileSync(resolve(JS_DIR, "api.js"), "utf8");
  const start = src.indexOf("const api = {");
  expect(start, "api.js no longer declares `const api = {` — update this test").toBeGreaterThan(-1);

  const groups = new Map<string, Set<string>>();
  let depth = 0;
  let current: string | null = null;
  for (let i = start + "const api = {".length - 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") { depth++; continue; }
    if (ch === "}") { depth--; if (depth === 0) break; continue; }
    const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(src.slice(i));
    if (!m) continue;
    if (depth === 1) { current = m[1]; groups.set(current, new Set()); }
    else if (depth === 2 && current) { groups.get(current)!.add(m[1]); }
    i += m[0].length - 1;
  }
  return groups;
}

/** Frontend .js files that consume the api client (vendor bundles excluded). */
function frontendFiles(dir = JS_DIR, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (entry.name !== "vendor") frontendFiles(resolve(dir, entry.name), out); }
    else if (entry.name.endsWith(".js") && entry.name !== "api.js") out.push(resolve(dir, entry.name));
  }
  return out;
}

/** Unresolved `api.*(…)` call sites in one file's source. */
function unresolvedIn(shape: Map<string, Set<string>>, label: string, source: string): string[] {
  const bad: string[] = [];
  const re = /\bapi\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?\s*\(/g;
  let m: RegExpExecArray | null;
  const code = stripNonCode(source);
  while ((m = re.exec(code))) {
    const [, group, member] = m;
    const members = shape.get(group);
    if (!members) bad.push(`${label}: api.${group}${member ? "." + member : ""} — no such group on the api client`);
    else if (member && !members.has(member)) bad.push(`${label}: api.${group}.${member} — not a member of api.${group}`);
  }
  return [...new Set(bad)];
}

// Scans every file in public/js; the 5 s default is crossed under full-suite load.
describe("frontend api client references", { timeout: 30_000 }, () => {
  const shape = buildApiShape();

  it("parses a sane api shape out of api.js", () => {
    // Sanity floor: if the parse silently produced nothing, every other
    // assertion here would pass for the wrong reason.
    expect(shape.size).toBeGreaterThan(20);
    expect(shape.get("assets")!.size).toBeGreaterThan(20);
    expect(shape.has("request")).toBe(false);   // the bug this test was written for
    expect(shape.get("assets")!.has("macTable")).toBe(true);
  });

  it("resolves every api.*() call site in public/js", () => {
    const files = frontendFiles();
    expect(files.length).toBeGreaterThan(40);
    const bad = files.flatMap((f) =>
      unresolvedIn(shape, f.slice(f.indexOf("public")), readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });

  it("catches an unresolved reference, so a dead scan can't pass vacuously", () => {
    expect(unresolvedIn(shape, "planted.js", 'api.request("GET", "/x");'))
      .toEqual(['planted.js: api.request — no such group on the api client']);
    expect(unresolvedIn(shape, "planted.js", "api.assets.noSuchMethod(1);"))
      .toEqual(["planted.js: api.assets.noSuchMethod — not a member of api.assets"]);
    // …and does NOT flag the noise that made a naive scan unusable.
    expect(unresolvedIn(shape, "planted.js", '// see api.js\nvar u = "https://api.example.com/h";'))
      .toEqual([]);
  });
});
