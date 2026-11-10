/**
 * tests/unit/automationsWizardSplit.test.ts — the CQ-F051 split of
 * public/js/automations-wizard.js into the core (openAutomationWizard and its
 * module catalogs) plus four pure helper scripts (WIZARD_FILES in
 * ./_automationsWizardSource).
 *
 * The files share page globals and have no module system, so a page is only
 * correct when every page that loads one of them loads all of them, core
 * first, in order — and so does app-panels.js's asset bundle, which lazy-loads
 * the wizard onto any page; when each original top-level function / var is
 * declared exactly once across them; and when evaluating them in page order
 * publishes every window.Polaris* export the list page and the tests read.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import vm from "node:vm";
import { WIZARD_FILES, wizardFileSource } from "./_automationsWizardSource.js";
import { appSource } from "./_appSource.js";

const PUBLIC = resolve(__dirname, "../../public");
const INVENTORY = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/automationsWizardInventory.json"), "utf8"),
) as { functions: string[]; vars: string[] };

const shellName = (s: string) => {
  const m = /^\/js\/([^/?]+\.js)(?:\?.*)?$/.exec(s);
  return m ? m[1] : "";
};
const scriptSrcs = (html: string) => [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => shellName(m[1]));
const topLevel = (src: string, re: RegExp) => [...src.matchAll(re)].map((m) => m[1]);
const FN_RE = /^(?:async )?function ([A-Za-z_$][\w$]*)\(/gm;
const VAR_RE = /^(?:var|const|let) ([A-Za-z_$][\w$]*)/gm;

describe("automation wizard split — pages and the panel bundle", () => {
  const split = new Set<string>(WIZARD_FILES);
  const pages = readdirSync(PUBLIC)
    .filter((f) => f.endsWith(".html"))
    .map((f) => ({ page: f, srcs: scriptSrcs(readFileSync(join(PUBLIC, f), "utf8")) }))
    .filter((p) => p.srcs.some((s) => split.has(s)));

  it("every page that loads the wizard statically carries the whole split", () => {
    expect(pages.map((p) => p.page).sort()).toEqual(
      // index / map / appmap prefetch the asset bundle instead (CQ-F041, tests/unit/panelPrefetch.test.ts).
      ["assets.html", "automations.html", "path-monitor.html"],
    );
  });

  it("every page loads all of them, core first, in order, as one consecutive run", () => {
    for (const { page, srcs } of pages) {
      const at = srcs.indexOf("automations-wizard.js");
      expect(srcs.slice(at, at + WIZARD_FILES.length), page).toEqual([...WIZARD_FILES]);
      expect(srcs.filter((s) => split.has(s)), page).toEqual([...WIZARD_FILES]);
    }
  });

  it("app-panels.js's asset bundle carries the split, in order, after recipient-picker.js", () => {
    const app = appSource();
    const start = app.indexOf("var _PANEL_SCRIPT_BUNDLES = {");
    const body = app.slice(start, app.indexOf("\n};", start));
    const asset = /^\s{2}asset:\s*\[([\s\S]*?)\]/m.exec(body)![1];
    const srcs = [...asset.matchAll(/"([^"]+)"/g)].map((m) => shellName(m[1]));
    const at = srcs.indexOf("automations-wizard.js");
    expect(srcs.slice(at, at + WIZARD_FILES.length)).toEqual([...WIZARD_FILES]);
    expect(srcs.indexOf("recipient-picker.js")).toBeLessThan(at);
  });

  it("every public/js/automations-wizard*.js is in the split", () => {
    const onDisk = readdirSync(join(PUBLIC, "js")).filter((f) => /^automations-wizard.*\.js$/.test(f)).sort();
    expect(onDisk).toEqual([...WIZARD_FILES].sort());
  });
});

describe("automation wizard split — declarations", () => {
  const perFile = WIZARD_FILES.map((f) => {
    const src = wizardFileSource(f);
    return { file: f, fns: topLevel(src, FN_RE), vars: topLevel(src, VAR_RE) };
  });

  it("each original top-level function and var is declared exactly once across the files", () => {
    const fns = perFile.flatMap((p) => p.fns);
    const vars = perFile.flatMap((p) => p.vars);
    expect(INVENTORY.functions.length).toBe(34);
    expect(INVENTORY.vars.length).toBe(10);
    for (const n of INVENTORY.functions) expect(fns.filter((x) => x === n).length, n).toBe(1);
    for (const n of INVENTORY.vars) expect(vars.filter((x) => x === n).length, n).toBe(1);
    expect(fns.length).toBe(INVENTORY.functions.length);
    expect(vars.length).toBe(INVENTORY.vars.length);
  });

  it("the four helper files are pure: none declares wizard state or calls the wizard", () => {
    for (const { file } of perFile.slice(1)) {
      const src = wizardFileSource(file);
      expect(src, file).not.toMatch(/\bopenAutomationWizard\s*\(/);
      expect(src, file).not.toMatch(/\b_awDraftStash\b|\b_awScripts\b/);
    }
  });
});

describe("automation wizard split — evaluation in page order", () => {
  function evaluate() {
    const ctx: Record<string, unknown> = { document: { addEventListener() {} } };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const f of WIZARD_FILES) vm.runInContext(wizardFileSource(f), ctx, { filename: f });
    return ctx as Record<string, any>;
  }

  it("evaluates without a load-time ReferenceError", () => {
    expect(() => evaluate()).not.toThrow();
  });

  it("publishes the window exports the list page and the tests read", () => {
    const w = evaluate();
    expect(typeof w.openAutomationWizard).toBe("function");
    expect(typeof w.PolarisAutomationSentences?.make).toBe("function");
    expect(w.PolarisAutomationRecipients).toBeTruthy();
    expect(w.PolarisAutomationDimensions).toBeTruthy();
    expect(w.PolarisTriggerFilters).toBeTruthy();
    for (const n of INVENTORY.functions) expect(typeof w[n], n).toBe("function");
  });
});
