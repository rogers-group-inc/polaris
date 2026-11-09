/**
 * tests/unit/integrationsSplit.test.ts — the CQ-F051 split of
 * public/js/integrations.js into a core plus five plain browser scripts
 * (INTEGRATIONS_FILES in ./_integrationsSource).
 *
 * The files share page globals and have no module system, so a page is only
 * correct when:
 *  - every page that loads one of them loads all of them, core first, in order
 *    — and so does app.js's asset panel bundle, which lazy-loads them onto any
 *    page (a page that misses one breaks a dialog silently: the missing form
 *    helper is undefined only when that integration's modal opens);
 *  - each original top-level function / var is declared exactly once across
 *    them (twice = the later file's silently wins; none = a dropped function);
 *  - evaluating them in page order runs without a ReferenceError — a top-level
 *    statement that RUNS at load may only reference what an earlier script
 *    defined (function hoisting stops at the file boundary);
 *  - the core's boot handler registers, and the registry's per-type form
 *    dispatch finds every helper it names.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import vm from "node:vm";
import { INTEGRATIONS_FILES, integrationsFileSource } from "./_integrationsSource";

const PUBLIC = resolve(__dirname, "../../public");
const INVENTORY = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/integrationsInventory.json"), "utf8"),
) as { functions: string[]; vars: string[] };

function htmlPages(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== "vendor") out.push(...htmlPages(join(dir, e.name))); continue; }
    if (e.name.endsWith(".html")) out.push(join(dir, e.name));
  }
  return out;
}

const baseName = (s: string) => s.replace(/^.*\//, "").replace(/\?.*$/, "");

function scriptSrcs(html: string): string[] {
  return [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => baseName(m[1]));
}

const topLevel = (src: string, re: RegExp) => [...src.matchAll(re)].map((m) => m[1]);
const FN_RE = /^(?:async )?function ([A-Za-z_$][\w$]*)\(/gm;
const VAR_RE = /^var ([A-Za-z_$][\w$]*)/gm;

describe("integrations split — pages", () => {
  const split = new Set<string>(INTEGRATIONS_FILES);
  const pages = htmlPages(PUBLIC)
    .map((p) => ({ page: p.slice(PUBLIC.length + 1).replace(/\\/g, "/"), srcs: scriptSrcs(readFileSync(p, "utf8")) }))
    .filter((p) => p.srcs.some((s) => split.has(s)));

  it("every page that carried integrations.js before the split carries the split", () => {
    expect(pages.map((p) => p.page).sort()).toEqual(
      ["appmap.html", "assets.html", "automations.html", "index.html", "integrations.html", "map.html", "path-monitor.html"],
    );
  });

  it("every page that loads one split file loads all of them, once each, core first, in order", () => {
    for (const { page, srcs } of pages) {
      const loaded = srcs.filter((s) => split.has(s));
      expect(loaded, page).toEqual([...INTEGRATIONS_FILES]);
    }
  });

  it("polling-methods.js loads before the split (the Monitoring tab reads its vocabulary)", () => {
    for (const { page, srcs } of pages) {
      expect(srcs.indexOf("polling-methods.js"), page).toBeGreaterThanOrEqual(0);
      expect(srcs.indexOf("polling-methods.js"), page).toBeLessThan(srcs.indexOf("integrations.js"));
    }
  });

  it("app.js's asset panel bundle carries the split, in order, after polling-methods.js", () => {
    const app = readFileSync(join(PUBLIC, "js/app.js"), "utf8");
    const start = app.indexOf("var _PANEL_SCRIPT_BUNDLES = {");
    const body = app.slice(start, app.indexOf("\n};", start));
    const asset = /^\s{2}asset:\s*\[([\s\S]*?)\]/m.exec(body)![1];
    const srcs = [...asset.matchAll(/"([^"]+)"/g)].map((m) => baseName(m[1]));
    expect(srcs.filter((s) => split.has(s))).toEqual([...INTEGRATIONS_FILES]);
    expect(srcs.indexOf("polling-methods.js")).toBeLessThan(srcs.indexOf("integrations.js"));
  });

  it("every public/js/integrations*.js is in the split", () => {
    const onDisk = readdirSync(join(PUBLIC, "js")).filter((f) => /^integrations.*\.js$/.test(f)).sort();
    expect(onDisk).toEqual([...INTEGRATIONS_FILES].sort());
  });
});

describe("integrations split — declarations", () => {
  const perFile = INTEGRATIONS_FILES.map((f) => {
    const src = integrationsFileSource(f);
    return { file: f, fns: topLevel(src, FN_RE), vars: topLevel(src, VAR_RE) };
  });

  it("no top-level function or var is declared twice across the split files", () => {
    for (const kind of ["fns", "vars"] as const) {
      const seen = new Map<string, string>();
      for (const { file, [kind]: names } of perFile) {
        for (const n of names) {
          expect(seen.get(n), `${n} in ${file}`).toBeUndefined();
          seen.set(n, file);
        }
      }
    }
  });

  it("every function the original integrations.js declared is declared exactly once", () => {
    const all = perFile.flatMap((p) => p.fns);
    expect(INVENTORY.functions.length).toBe(203);
    for (const n of INVENTORY.functions) expect(all.filter((x) => x === n).length, n).toBe(1);
  });

  it("every top-level var the original declared is declared exactly once", () => {
    const all = perFile.flatMap((p) => p.vars);
    expect(INVENTORY.vars.length).toBe(50);
    for (const n of INVENTORY.vars) expect(all.filter((x) => x === n).length, n).toBe(1);
  });

  it("each split file holds something (a split that emptied a file is a slicing bug)", () => {
    for (const { file, fns } of perFile) expect(fns.length, file).toBeGreaterThan(0);
  });
});

describe("integrations split — load-time evaluation in page order", () => {
  /**
   * Run every split file in ONE context, in page order, the way the browser
   * does. Only what a top-level statement touches at load is stubbed:
   * `document.addEventListener` for the core's boot handler, `window` for the
   * Geographic Location recompute hook. Anything else a load-time statement
   * reaches for that no earlier file defined throws a ReferenceError here.
   */
  function evaluate(files: readonly string[]) {
    const listeners: string[] = [];
    const ctx: Record<string, unknown> = {
      document: { addEventListener: (type: string) => { listeners.push(type); } },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const f of files) vm.runInContext(integrationsFileSource(f), ctx, { filename: f });
    return { ctx, listeners };
  }

  it("evaluates without a load-time ReferenceError", () => {
    expect(() => evaluate(INTEGRATIONS_FILES)).not.toThrow();
  });

  it("registers the core's DOMContentLoaded boot handler and the window hook", () => {
    const { ctx, listeners } = evaluate(INTEGRATIONS_FILES);
    expect(listeners).toEqual(["DOMContentLoaded"]);
    expect(typeof ctx._geoRecomputePush).toBe("function");
  });

  it("every form helper the core's type dispatch names is a function once the page has loaded", () => {
    const { ctx } = evaluate(INTEGRATIONS_FILES);
    const core = integrationsFileSource("integrations.js");
    const named = [...new Set(topLevel(core, /\b((?:get\w*FormConfig|\w+(?:GeneralHTML|FormHTML|FiltersHTML)))\(/g))];
    expect(named.length).toBeGreaterThanOrEqual(15);
    for (const n of named) expect(typeof ctx[n], n).toBe("function");
  });

  it("every original top-level function is a global after evaluation", () => {
    const { ctx } = evaluate(INTEGRATIONS_FILES);
    for (const n of INVENTORY.functions) expect(typeof ctx[n], n).toBe("function");
  });
});
