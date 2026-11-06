/**
 * tests/unit/localStorageGuarded.test.ts — every browser-storage call in
 * public/js sits inside a try (CQ-F028).
 *
 * localStorage / sessionStorage THROW when storage is unavailable — Safari
 * private mode, site data blocked by policy, a full quota — so an unguarded
 * read of a remembered column width or tab can take a whole page down. All
 * 142 calls were guarded when this was written (2026-11-06); this keeps it
 * that way. Parsed with the TypeScript compiler (already a devDependency),
 * not a line heuristic: a `try` opened ten lines up still counts.
 *
 * The per-module lsGet / lsSet wrappers are deliberately NOT folded into one
 * shared helper: public/ modules are loaded standalone in their own tests, so
 * a helper on a page global breaks them (tier-1 lesson, polaris-ui-canon →
 * canon-shared-kit). Each module guards its own calls; this test checks it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const JS = resolve(__dirname, "../../public/js");

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== "vendor") out.push(...jsFiles(join(dir, e.name))); continue; }
    if (e.name.endsWith(".js")) out.push(join(dir, e.name));
  }
  return out;
}

const STORAGE = /^(window\.)?(localStorage|sessionStorage)$/;
const METHODS = new Set(["getItem", "setItem", "removeItem", "clear", "key"]);

/** `x.getItem(…)` where x is localStorage / sessionStorage (optionally via window.). */
function isStorageCall(node: ts.Node, sf: ts.SourceFile): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !METHODS.has(callee.name.text)) return false;
  return STORAGE.test(callee.expression.getText(sf));
}

/** Is `node` inside the TRY block of a try statement (not its catch / finally)? */
function insideTryBlock(node: ts.Node): boolean {
  let child: ts.Node = node;
  for (let p = node.parent; p; child = p, p = p.parent) {
    if (ts.isTryStatement(p) && p.tryBlock === child) return true;
    // A function boundary ends the search: a try around the DEFINITION of a
    // callback does not guard the callback's later call.
    if (ts.isFunctionLike(p)) return false;
  }
  return false;
}

function unguardedCalls(file: string): number[] {
  return unguardedInSource(readFileSync(file, "utf8"), file);
}

function unguardedInSource(src: string, name = "snippet.js"): number[] {
  if (!/(localStorage|sessionStorage)\./.test(src)) return [];
  const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const lines: number[] = [];
  const visit = (n: ts.Node) => {
    if (isStorageCall(n, sf) && !insideTryBlock(n)) lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

describe("the guard itself", () => {
  it("flags an unguarded call, a call in a catch, and a callback defined inside a try but run later", () => {
    expect(unguardedInSource("var w = localStorage.getItem('k');")).toEqual([1]);
    expect(unguardedInSource("try { a(); } catch (e) {\n  window.localStorage.removeItem('k');\n}")).toEqual([2]);
    expect(unguardedInSource("try {\n  el.onclick = function () { sessionStorage.setItem('k', 1); };\n} catch (e) {}")).toEqual([2]);
  });

  it("passes a call in the try block, however far above the try opens", () => {
    expect(unguardedInSource("try {\n" + "a();\n".repeat(15) + "localStorage.setItem('k', '1');\n} catch (e) {}")).toEqual([]);
    expect(unguardedInSource("function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }")).toEqual([]);
  });
});

describe("browser storage calls are guarded (CQ-F028)", () => {
  const files = jsFiles(JS);

  it("finds the files that use storage", () => {
    expect(files.filter((f) => /localStorage\./.test(readFileSync(f, "utf8"))).length).toBeGreaterThan(20);
  });

  for (const f of files) {
    const name = f.slice(JS.length + 1).replace(/\\/g, "/");
    it(`${name}: every storage call is inside a try`, () => {
      expect(unguardedCalls(f), `${name} lines`).toEqual([]);
    });
  }
});
