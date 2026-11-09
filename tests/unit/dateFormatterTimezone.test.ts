/**
 * tests/unit/dateFormatterTimezone.test.ts — no public/js date is rendered
 * with a bare `toLocaleString()` (CQ-F017).
 *
 * A bare `new Date(x).toLocaleString()` renders in the BROWSER's zone and so
 * ignores the operator's display-timezone preference (api.js
 * `setDisplayTimeZone` / `timeZoneOpts`). The canonical is api.js
 * `formatDateTime`. Modules whose tests load them without api.js keep the old
 * call only as the fallback of a `typeof formatDateTime === "function"` guard
 * (the standalone-load rule, polaris-ui-canon → canon-shared-kit).
 *
 * Parsed with the TypeScript compiler, like localStorageGuarded.test.ts: a
 * zero-argument `.toLocaleString()` is allowed when
 *   - its receiver is a NUMBER (`Number(…)`, or one of the counts listed
 *     below — number formatting is not a date), or
 *   - it sits in the false branch of a `typeof formatDateTime` conditional, or
 *     in a function whose body tests `typeof formatDateTime` / applies
 *     `timeZoneOpts` (the try/catch fallbacks).
 * Calls WITH options (`toLocaleString(undefined, {...})`) are not checked
 * here: they choose their own shape and are a separate follow-up.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
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

/** Receivers known to be numbers (counts, sizes) — formatted, not dated. */
const NUMERIC_RECEIVERS = new Set([
  "status.entries",
  "result.entries",
  "m.thinkingChars",
  "span",
  "preview.totalAddresses",
]);

function isNumericReceiver(expr: ts.Expression, sf: ts.SourceFile): boolean {
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Number") return true;
  return NUMERIC_RECEIVERS.has(expr.getText(sf));
}

function isGuarded(node: ts.Node, sf: ts.SourceFile): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isConditionalExpression(p) && /typeof formatDateTime/.test(p.condition.getText(sf))) return true;
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p)) {
      const body = p.body ? p.body.getText(sf) : "";
      return /typeof formatDateTime|timeZoneOpts\(\)/.test(body);
    }
  }
  return false;
}

function bareDateCalls(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 0 &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "toLocaleString" &&
      !isNumericReceiver(node.expression.expression, sf) &&
      !isGuarded(node, sf)
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push(`${relative(JS, file).replace(/\\/g, "/")}:${line + 1}  ${node.getText(sf)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("public/js absolute times go through formatDateTime (CQ-F017)", () => {
  it("has no unguarded bare toLocaleString() on a date", () => {
    const hits = jsFiles(JS).flatMap(bareDateCalls);
    expect(hits, "use formatDateTime (api.js) — or, in a module its tests load without api.js, a typeof formatDateTime guard").toEqual([]);
  });

  it("flags a bare call and accepts the guarded and numeric forms", () => {
    const probe = (code: string) => {
      const sf = ts.createSourceFile("probe.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      let n = 0;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.arguments.length === 0 && ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "toLocaleString" && !isNumericReceiver(node.expression.expression, sf) && !isGuarded(node, sf)) n++;
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return n;
    };
    expect(probe("var s = new Date(x).toLocaleString();")).toBe(1);
    expect(probe("function f(x) { return new Date(x).toLocaleString(); }")).toBe(1);
    expect(probe('var s = typeof formatDateTime === "function" ? formatDateTime(x) : new Date(x).toLocaleString();')).toBe(0);
    expect(probe('function f(x) { if (typeof formatDateTime === "function") return formatDateTime(x); return new Date(x).toLocaleString(); }')).toBe(0);
    expect(probe("var s = Number(n).toLocaleString();")).toBe(0);
  });
});
