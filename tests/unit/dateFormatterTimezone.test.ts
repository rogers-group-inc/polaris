/**
 * tests/unit/dateFormatterTimezone.test.ts — every public/js date is rendered
 * in the operator's display timezone (CQ-F017).
 *
 * A `toLocale*` call with no `timeZone` renders in the BROWSER's zone and so
 * ignores the operator's display-timezone preference (api.js
 * `setDisplayTimeZone` / `timeZoneOpts`). Parsed with the TypeScript compiler,
 * like localStorageGuarded.test.ts. Two shapes are checked:
 *
 * 1. A bare `.toLocaleString()` on a date. The canonical is api.js
 *    `formatDateTime`. Allowed when its receiver is a NUMBER (`Number(…)`, or
 *    one of the counts listed below), when it sits in the false branch of a
 *    `typeof formatDateTime` conditional, or in a function whose body tests
 *    `typeof formatDateTime` / applies `timeZoneOpts` (the fallbacks of
 *    modules their tests load without api.js).
 *
 * 2. A call that picks its own shape: `.toLocaleString(locale, opts)`, and any
 *    `.toLocaleDateString(…)` / `.toLocaleTimeString(…)` — bare ones included.
 *    Each must carry the zone in its options: the options argument mentions
 *    `timeZone` (`Object.assign({...}, timeZoneOpts())`), or names a variable
 *    initialised from `timeZoneOpts` (`var tz = typeof timeZoneOpts === … ;
 *    d.toLocaleDateString(undefined, tz)`). A call inside a `catch` block is a
 *    fallback for a zone the browser rejected and is allowed. The deliberate
 *    browser- or server-zone renders are listed in ZONE_EXEMPT with a reason;
 *    an entry that no longer matches anything fails too, so the list cannot
 *    rot.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import vm from "node:vm";
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

/**
 * Deliberately NOT in the display zone. Key: `<file>#<enclosing function>#<method>`.
 */
const ZONE_EXEMPT: Record<string, string> = {
  // (The desktop SVG charts' axis, tooltips and screenshot caption used to be
  // here, on the browser's zone so a tooltip could not disagree with the axis
  // under it. The whole chart moved to the display zone together —
  // chart-shared.js zone helpers, tests/unit/chartTimeTicks.test.ts.)
  // A calendar date, not an instant: the filter value is "YYYY-MM-DD" parsed
  // as LOCAL midnight; a zone shift would show the previous or next day.
  "table-sf.js#fmt#toLocaleDateString": "date-filter button label — a typed calendar date, zone-less (CQ-F014)",
  // The SERVER's clock: the NTP card renders in the server's configured zone
  // (its timezone override), which is the point of the card.
  "server-settings.js#updateCurrentTime#toLocaleString": "'Current server time' — server zone from the NTP override",
  "server-settings.js#formatLocalTime#toLocaleString": "NTP card timestamps — server zone from the NTP override",
};

const OWN_SHAPE = new Set(["toLocaleDateString", "toLocaleTimeString"]);

function isNumericReceiver(expr: ts.Expression, sf: ts.SourceFile): boolean {
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Number") return true;
  return NUMERIC_RECEIVERS.has(expr.getText(sf));
}

function isFn(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
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

/** Name of the nearest enclosing named function (`function f`, `var f = function`, `X.prototype.f = function`). */
function enclosingName(node: ts.Node): string {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (!isFn(p)) continue;
    if (p.name && ts.isIdentifier(p.name)) return p.name.text;
    const par = p.parent;
    if (par && ts.isVariableDeclaration(par) && ts.isIdentifier(par.name)) return par.name.text;
    if (par && ts.isBinaryExpression(par) && ts.isPropertyAccessExpression(par.left)) return par.left.name.text;
    if (par && ts.isPropertyAssignment(par) && ts.isIdentifier(par.name)) return par.name.text;
  }
  return "<top>";
}

/** Is `name` declared, in a scope enclosing `node`, from an initialiser that applies timeZoneOpts? */
function isZoneVariable(name: string, node: ts.Node, sf: ts.SourceFile): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (!isFn(p) && !ts.isSourceFile(p)) continue;
    let found = false;
    const scan = (n: ts.Node) => {
      if (found) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name &&
          n.initializer && /timeZoneOpts/.test(n.initializer.getText(sf))) { found = true; return; }
      ts.forEachChild(n, scan);
    };
    scan(p);
    if (found) return true;
  }
  return false;
}

function carriesZone(opts: ts.Expression | undefined, call: ts.Node, sf: ts.SourceFile): boolean {
  if (!opts) return false;
  if (/timeZone/.test(opts.getText(sf))) return true;
  let ok = false;
  const visit = (n: ts.Node) => {
    if (ok) return;
    if (ts.isIdentifier(n) && isZoneVariable(n.text, call, sf)) { ok = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(opts);
  return ok;
}

function inCatch(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isCatchClause(p)) return true;
    if (isFn(p)) return false;
  }
  return false;
}

interface Scan { bare: string[]; zoneless: string[]; exemptHits: Set<string>; }

function scanSource(file: string, src: string): Scan {
  const rel = relative(JS, file).replace(/\\/g, "/");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: Scan = { bare: [], zoneless: [], exemptHits: new Set() };
  const where = (node: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}  ${node.getText(sf).replace(/\s+/g, " ")}`;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const recv = node.expression.expression;
      if (method === "toLocaleString" && node.arguments.length === 0) {
        if (!isNumericReceiver(recv, sf) && !isGuarded(node, sf)) out.bare.push(where(node));
      } else if (OWN_SHAPE.has(method) || (method === "toLocaleString" && !isNumericReceiver(recv, sf))) {
        if (!carriesZone(node.arguments[1], node, sf) && !inCatch(node)) {
          const key = `${rel}#${enclosingName(node)}#${method}`;
          if (key in ZONE_EXEMPT) out.exemptHits.add(key);
          else out.zoneless.push(where(node));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("public/js absolute times render in the display timezone (CQ-F017)", () => {
  const scans = jsFiles(JS).map((f) => scanSource(f, readFileSync(f, "utf8")));

  it("has no unguarded bare toLocaleString() on a date", () => {
    expect(scans.flatMap((s) => s.bare), "use formatDateTime (api.js) — or, in a module its tests load without api.js, a typeof formatDateTime guard").toEqual([]);
  });

  it("has no toLocaleString(locale, opts) / toLocaleDateString / toLocaleTimeString without the display zone", () => {
    expect(scans.flatMap((s) => s.zoneless),
      "merge timeZoneOpts() into the options (guard it with typeof timeZoneOpts in a module loaded without api.js) — or add a ZONE_EXEMPT entry with its reason").toEqual([]);
  });

  it("every ZONE_EXEMPT entry still matches a call", () => {
    const hit = new Set(scans.flatMap((s) => [...s.exemptHits]));
    expect(Object.keys(ZONE_EXEMPT).filter((k) => !hit.has(k))).toEqual([]);
  });

  it("flags a bare call and accepts the guarded and numeric forms", () => {
    const n = (code: string) => scanSource(join(JS, "probe.js"), code).bare.length;
    expect(n("var s = new Date(x).toLocaleString();")).toBe(1);
    expect(n("function f(x) { return new Date(x).toLocaleString(); }")).toBe(1);
    expect(n('var s = typeof formatDateTime === "function" ? formatDateTime(x) : new Date(x).toLocaleString();')).toBe(0);
    expect(n('function f(x) { if (typeof formatDateTime === "function") return formatDateTime(x); return new Date(x).toLocaleString(); }')).toBe(0);
    expect(n("var s = Number(n).toLocaleString();")).toBe(0);
  });

  it("flags own-shape calls without a zone and accepts the zoned forms", () => {
    const n = (code: string) => scanSource(join(JS, "probe.js"), code).zoneless.length;
    expect(n('var s = d.toLocaleString(undefined, { month: "short" });')).toBe(1);
    expect(n("var s = d.toLocaleDateString();")).toBe(1);
    expect(n("var s = d.toLocaleTimeString();")).toBe(1);
    expect(n('var s = d.toLocaleTimeString([], { hour: "2-digit" });')).toBe(1);
    expect(n('var s = d.toLocaleString(undefined, Object.assign({ month: "short" }, timeZoneOpts()));')).toBe(0);
    expect(n('var s = d.toLocaleDateString(undefined, Object.assign({}, typeof timeZoneOpts === "function" ? timeZoneOpts() : {}));')).toBe(0);
    expect(n('function f(d) { var tz = typeof timeZoneOpts === "function" ? timeZoneOpts() : {}; return d.toLocaleDateString(undefined, tz) + d.toLocaleTimeString(undefined, tz); }')).toBe(0);
    expect(n('function f(d) { var tz = timeZoneOpts(); var g = function (x) { return x.toLocaleDateString("en-CA", Object.assign({ year: "numeric" }, tz)); }; return g(d); }')).toBe(0);
    expect(n("function f(d) { var tz = {}; return d.toLocaleDateString(undefined, tz); }")).toBe(1);
    expect(n("function f(d) { try { return d.toLocaleDateString(undefined, timeZoneOpts()); } catch (_) { return d.toLocaleDateString(); } }")).toBe(0);
  });
});

describe("api.js timeZoneOpts — safe to spread straight into a toLocale* call", () => {
  function load() {
    const sandbox: Record<string, unknown> = { console, document: { cookie: "" } };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(join(JS, "api.js"), "utf8"), sandbox);
    return sandbox as unknown as { setDisplayTimeZone(tz: string): void; timeZoneOpts(): Record<string, string> };
  }

  it("is empty on auto, carries a zone the browser knows, and is empty for one it cannot apply", () => {
    const w = load();
    expect(w.timeZoneOpts()).toEqual({});
    w.setDisplayTimeZone("America/Chicago");
    expect({ ...w.timeZoneOpts() }).toEqual({ timeZone: "America/Chicago" });
    w.setDisplayTimeZone("Not/A_Zone");
    expect({ ...w.timeZoneOpts() }).toEqual({});
    expect(() => new Date(0).toLocaleString(undefined, w.timeZoneOpts())).not.toThrow();
  });
});
