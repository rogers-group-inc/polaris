/**
 * tests/unit/jsArgHandlers.test.ts
 *
 * Inline handlers built from data (scan findings F167, F176, F177, F197, F235,
 * F238; business rule 109). `escapeHtml` is wrong for a value inside a JS string
 * in an `onclick="fn('...')"`: it turns `'` into `&#39;`, which the HTML parser
 * decodes back to `'` before the handler is compiled, so `x');alert(1);('` closes
 * the string and runs script. `jsArg` encodes the value as a JSON string literal
 * and then escapes it for HTML.
 *
 * Two halves: jsArg's behaviour in a real DOM parse + compile, and a static scan
 * that no source file builds a handler argument the old way.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const apiSrc = readFileSync(resolve(__dirname, "../../public/js/api.js"), "utf8");

function sliceFunction(name: string): string {
  const lines = apiSrc.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`api.js: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

beforeEach(() => {
  // eslint-disable-next-line no-eval
  (0, eval)(sliceFunction("escapeHtml"));
  // eslint-disable-next-line no-eval
  (0, eval)(sliceFunction("jsArg"));
  delete g.__pwned;
  g.__calls = [];
  g.capture = (...args: unknown[]) => g.__calls.push(args);
});

const HOSTILE = [
  "x');window.__pwned=1;('",
  `x");window.__pwned=1;("`,
  "x');window.__pwned=1;//",
  "x\\');window.__pwned=1;//",
  "x\n');window.__pwned=1;('",
  "x ');window.__pwned=1;('",
  "x ');window.__pwned=1;('",
  "</script><script>window.__pwned=1</script>",
  "&#39;);window.__pwned=1;//",
  "x`);window.__pwned=1;(`",
  "${window.__pwned=1}",
  "plain name",
  "O'Brien's \"quoted\" name",
  "back\\slash",
  "",
];

/** Parse a button the way the app does (innerHTML), then run its onclick source. */
function click(handlerBody: string): void {
  const host = document.createElement("div");
  host.innerHTML = `<button id="b" onclick="${handlerBody}">go</button>`;
  const attr = host.querySelector("#b")!.getAttribute("onclick")!;
  // The handler source exactly as the browser would compile it.
  // eslint-disable-next-line no-new-func
  new Function(attr)();
}

describe("jsArg", () => {
  it.each(HOSTILE)("delivers %j to the handler intact and runs nothing else", (value) => {
    const arg = g.jsArg(value);
    click(`capture(${arg})`);
    expect(g.__pwned).toBeUndefined();
    expect(g.__calls).toEqual([[value]]);
  });

  it("works for several arguments in one handler, mixed with literals", () => {
    click(`capture(${g.jsArg("a'b")}, ${g.jsArg("c\"d")}, true)`);
    expect(g.__calls).toEqual([["a'b", 'c"d', true]]);
  });

  it("treats null and undefined as the empty string", () => {
    expect(g.jsArg(null)).toBe(g.jsArg(""));
    expect(g.jsArg(undefined)).toBe(g.jsArg(""));
  });

  it("is why escapeHtml is not enough: the old shape DOES break out", () => {
    const evil = "x');window.__pwned=1;('";
    const host = document.createElement("div");
    host.innerHTML = `<button id="b" onclick="capture('${g.escapeHtml(evil)}')">go</button>`;
    const attr = host.querySelector("#b")!.getAttribute("onclick")!;
    // eslint-disable-next-line no-new-func
    new Function(attr)();
    expect(g.__pwned).toBe(1);
  });
});

describe("no source builds a handler argument by hand", () => {
  const dir = resolve(__dirname, "../../public/js");
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));

  it.each(files)("%s has no \\'' + x + '\\' handler argument", (file) => {
    const src = readFileSync(resolve(dir, file), "utf8");
    // The pattern the old code used: an escaped quote, then `' +`, then an
    // expression — i.e. a value spliced between single quotes inside a handler.
    const hits = src.match(/\\'' \+\s*[A-Za-z_(]/g) ?? [];
    expect(hits).toEqual([]);
  });

  it("api.js defines jsArg and exports it to the page", () => {
    expect(apiSrc).toContain("function jsArg(");
    expect(apiSrc).toContain("window.jsArg = jsArg");
  });
});
