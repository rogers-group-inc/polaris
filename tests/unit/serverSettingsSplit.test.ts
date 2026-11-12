/**
 * tests/unit/serverSettingsSplit.test.ts — the CQ-F051 split of
 * public/js/server-settings.js into a core plus one plain browser script per
 * tab (SERVER_SETTINGS_FILES in ./_serverSettingsSource).
 *
 * The files share page globals and have no module system, so the page is only
 * correct when:
 *  - every page that loads one of them loads all of them, core first, in order
 *    (a page that misses one breaks a tab silently: its loader is undefined
 *    only when the tab is clicked);
 *  - each original top-level function / var is declared exactly once across
 *    them (twice = the later file's silently wins; none = a dropped function);
 *  - evaluating them in page order runs without a ReferenceError — a top-level
 *    statement that RUNS at load may only reference what an earlier script
 *    defined (function hoisting stops at the file boundary);
 *  - the core's tab dispatch finds every loader it names.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import vm from "node:vm";
import { SERVER_SETTINGS_FILES, serverSettingsFileSource } from "./_serverSettingsSource.js";

const PUBLIC = resolve(__dirname, "../../public");
const INVENTORY = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/serverSettingsInventory.json"), "utf8"),
) as { functions: string[]; vars: string[] };

/** Self-contained Server Settings modules that are NOT part of the split. */
const STANDALONE_MODULES = ["server-settings-ha.js", "server-settings-firmware.js"];

function htmlPages(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== "vendor") out.push(...htmlPages(join(dir, e.name))); continue; }
    if (e.name.endsWith(".html")) out.push(join(dir, e.name));
  }
  return out;
}

function scriptSrcs(html: string): string[] {
  return [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1].replace(/^.*\//, "").replace(/\?.*$/, ""));
}

const topLevel = (src: string, re: RegExp) => [...src.matchAll(re)].map((m) => m[1]);
const FN_RE = /^(?:async )?function ([A-Za-z_$][\w$]*)\(/gm;
const VAR_RE = /^var ([A-Za-z_$][\w$]*)/gm;

describe("server-settings split — pages", () => {
  const split = new Set<string>(SERVER_SETTINGS_FILES);
  const pages = htmlPages(PUBLIC)
    .map((p) => ({ page: p.slice(PUBLIC.length + 1), srcs: scriptSrcs(readFileSync(p, "utf8")) }))
    .filter((p) => p.srcs.some((s) => split.has(s)));

  it("server-settings.html is among the pages that load the split", () => {
    expect(pages.map((p) => p.page.replace(/\\/g, "/"))).toContain("server-settings.html");
  });

  it("every page that loads one split file loads all of them, once each, core first, in order", () => {
    for (const { page, srcs } of pages) {
      const loaded = srcs.filter((s) => split.has(s));
      expect(loaded, page).toEqual([...SERVER_SETTINGS_FILES]);
    }
  });

  it("the shared condition builder loads before the split (the tag editor reads it)", () => {
    for (const { page, srcs } of pages) {
      expect(srcs.indexOf("condition-builder.js"), page).toBeGreaterThanOrEqual(0);
      expect(srcs.indexOf("condition-builder.js"), page).toBeLessThan(srcs.indexOf("server-settings.js"));
    }
  });

  it("every public/js/server-settings*.js is either in the split or a known standalone module", () => {
    const onDisk = readdirSync(join(PUBLIC, "js")).filter((f) => /^server-settings.*\.js$/.test(f)).sort();
    expect(onDisk).toEqual([...SERVER_SETTINGS_FILES, ...STANDALONE_MODULES].sort());
  });
});

describe("server-settings split — declarations", () => {
  const perFile = SERVER_SETTINGS_FILES.map((f) => {
    const src = serverSettingsFileSource(f);
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

  it("every function the original server-settings.js declared is declared exactly once", () => {
    const all = perFile.flatMap((p) => p.fns);
    expect(INVENTORY.functions.length).toBe(340);
    for (const n of INVENTORY.functions) expect(all.filter((x) => x === n).length, n).toBe(1);
  });

  it("every top-level var the original declared is declared exactly once", () => {
    const all = perFile.flatMap((p) => p.vars);
    for (const n of INVENTORY.vars) expect(all.filter((x) => x === n).length, n).toBe(1);
  });

  it("each split file holds something (a split that emptied a file is a slicing bug)", () => {
    for (const { file, fns } of perFile) expect(fns.length, file).toBeGreaterThan(0);
  });
});

describe("server-settings split — load-time evaluation in page order", () => {
  /**
   * Run every split file in ONE context, in page order, the way the browser
   * does. Only the app-shell globals a top-level statement touches at load are
   * stubbed (`formatBytes` for `var formatBytesShort = formatBytes`, and
   * `document.addEventListener` for the boot handler + the Symbol combobox's
   * delegated listeners). Anything else a load-time statement reaches for that
   * no earlier file defined throws a ReferenceError here.
   */
  function evaluate(files: readonly string[]) {
    const listeners: string[] = [];
    const ctx: Record<string, unknown> = {
      formatBytes: (b: unknown) => String(b),
      document: { addEventListener: (type: string) => { listeners.push(type); } },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const f of files) vm.runInContext(serverSettingsFileSource(f), ctx, { filename: f });
    return { ctx, listeners };
  }

  it("evaluates without a load-time ReferenceError", () => {
    expect(() => evaluate(SERVER_SETTINGS_FILES)).not.toThrow();
  });

  it("registers the boot handler from the core and the combobox listeners from the profiles file", () => {
    const { listeners } = evaluate(SERVER_SETTINGS_FILES);
    expect(listeners).toContain("DOMContentLoaded");
    for (const t of ["focusin", "click", "input", "focusout", "mousedown", "keydown"]) expect(listeners).toContain(t);
  });

  it("every tab loader the core's dispatch names is a function once the page has loaded", () => {
    const { ctx } = evaluate(SERVER_SETTINGS_FILES);
    const core = serverSettingsFileSource("server-settings.js");
    const loaders = [...new Set(topLevel(core, /\b(load[A-Z]\w*)\(\)/g))];
    // 7 since the Time tab folded into Web Server (2026-11-12).
    expect(loaders.length).toBeGreaterThanOrEqual(7);
    for (const n of loaders) expect(typeof ctx[n], n).toBe("function");
  });

  it("every original top-level function is a global after evaluation", () => {
    const { ctx } = evaluate(SERVER_SETTINGS_FILES);
    for (const n of INVENTORY.functions) expect(typeof ctx[n], n).toBe("function");
  });
});
