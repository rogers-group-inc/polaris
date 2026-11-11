/**
 * tests/unit/assetsSplit.test.ts — the CQ-F050 split of public/js/assets.js
 * into the core (the Assets list page) plus thirteen plain browser scripts
 * (ASSETS_FILES in ./_assetsSource).
 *
 * The files share page globals and have no module system, so a page is only
 * correct when every page that loads one of them loads all of them, core
 * first, in order, as one run — and so does app-panels.js's asset bundle,
 * which lazy-loads the asset slide-over onto any page; when each original
 * top-level function / var is declared exactly once across them; and when
 * evaluating them in page order throws nothing at load. Nothing in a split
 * file may run at load beyond listener wiring, so a load-time call into a
 * later file (a ReferenceError on every page) fails the evaluation case.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import vm from "node:vm";
import { ASSETS_FILES, assetsFileSource } from "./_assetsSource.js";
import { appSource } from "./_appSource.js";

const PUBLIC = resolve(__dirname, "../../public");
const INVENTORY = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/assetsInventory.json"), "utf8"),
) as { functions: string[]; vars: string[] };

const shellName = (s: string) => {
  const m = /^\/js\/([^/?]+\.js)(?:\?.*)?$/.exec(s);
  return m ? m[1] : "";
};
const scriptSrcs = (html: string) => [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => shellName(m[1]));
const topLevel = (src: string, re: RegExp) => [...src.matchAll(re)].map((m) => m[1]);
const FN_RE = /^(?:async )?function ([A-Za-z_$][\w$]*)\(/gm;
const VAR_RE = /^(?:var|const|let) ([A-Za-z_$][\w$]*)/gm;

describe("assets split — pages and the panel bundle", () => {
  const split = new Set<string>(ASSETS_FILES);
  const pages = readdirSync(PUBLIC)
    .filter((f) => f.endsWith(".html"))
    .map((f) => ({ page: f, srcs: scriptSrcs(readFileSync(join(PUBLIC, f), "utf8")) }))
    .filter((p) => p.srcs.some((s) => split.has(s)));

  it("every page that loads assets.js statically carries the whole split", () => {
    expect(pages.map((p) => p.page).sort()).toEqual(
      // Every other page prefetches the asset bundle instead (CQ-F041, tests/unit/panelPrefetch.test.ts).
      ["assets.html"],
    );
  });

  it("every page loads all of them, core first, in order, as one consecutive run", () => {
    for (const { page, srcs } of pages) {
      const at = srcs.indexOf("assets.js");
      expect(srcs.slice(at, at + ASSETS_FILES.length), page).toEqual([...ASSETS_FILES]);
      expect(srcs.filter((s) => split.has(s)), page).toEqual([...ASSETS_FILES]);
    }
  });

  it("app-panels.js's asset bundle carries the split, in order, as one run", () => {
    const app = appSource();
    const start = app.indexOf("var _PANEL_SCRIPT_BUNDLES = {");
    const body = app.slice(start, app.indexOf("\n};", start));
    const asset = /^\s{2}asset:\s*\[([\s\S]*?)\]/m.exec(body)![1];
    const srcs = [...asset.matchAll(/"([^"]+)"/g)].map((m) => shellName(m[1]));
    const at = srcs.indexOf("assets.js");
    expect(srcs.slice(at, at + ASSETS_FILES.length)).toEqual([...ASSETS_FILES]);
    expect(srcs.filter((s) => split.has(s))).toEqual([...ASSETS_FILES]);
  });
});

describe("assets split — declarations", () => {
  const perFile = ASSETS_FILES.map((f) => {
    const src = assetsFileSource(f);
    return { file: f, fns: topLevel(src, FN_RE), vars: topLevel(src, VAR_RE) };
  });

  it("each original top-level function and var is declared exactly once across the files", () => {
    const fns = perFile.flatMap((p) => p.fns);
    const vars = perFile.flatMap((p) => p.vars);
    expect(INVENTORY.functions.length).toBe(826);
    expect(INVENTORY.vars.length).toBe(175);
    for (const n of INVENTORY.functions) expect(fns.filter((x) => x === n).length, n).toBe(1);
    for (const n of INVENTORY.vars) expect(vars.filter((x) => x === n).length, n).toBe(1);
    expect(fns.length).toBe(INVENTORY.functions.length);
    expect(vars.length).toBe(INVENTORY.vars.length);
  });

  it("_ackPromptOpts is published from the file that declares it", () => {
    const home = perFile.find((p) => p.fns.includes("_ackPromptOpts"))!;
    expect(assetsFileSource(home.file)).toContain("window._ackPromptOpts = _ackPromptOpts");
  });
});

describe("assets split — evaluation in page order", () => {
  function evaluate() {
    const noop = () => {};
    const el = null;
    const ctx: Record<string, unknown> = {
      document: { addEventListener: noop, getElementById: () => el, querySelector: () => el, querySelectorAll: () => [] },
      addEventListener: noop,
      PolarisChartShared: {},
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const f of ASSETS_FILES) vm.runInContext(assetsFileSource(f), ctx, { filename: f });
    return ctx as Record<string, any>;
  }

  it("evaluates without a load-time ReferenceError", () => {
    expect(() => evaluate()).not.toThrow();
  });

  it("declares every original function and publishes the window exports", () => {
    const w = evaluate();
    for (const n of INVENTORY.functions) expect(typeof w[n], n).toBe("function");
    expect(typeof w.openAssetBySerial).toBe("function");
    expect(typeof w._ackPromptOpts).toBe("function");
  });
});
