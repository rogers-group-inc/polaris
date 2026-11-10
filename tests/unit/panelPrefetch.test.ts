/**
 * tests/unit/panelPrefetch.test.ts — idle prefetch of the asset panel bundle
 * (CQ-F041; prefetchPanelScripts in public/js/app-panels.js).
 *
 * The dashboard, the Device Map and the Application Map offer the asset
 * slide-over on a click but need none of its ~45 scripts for their own
 * content. They used to load the whole bundle statically, so every visit
 * parsed ~3 MB before first paint; now each names the bundle on
 * <body data-prefetch-panels="asset"> and app-panels.js loads it in the
 * background once the page is idle. Pinned here:
 *
 *  - those three pages carry the attribute and load no bundle script except
 *    the few their OWN code reads (vendor libs the map exports use, temp-unit,
 *    favorites, table-sf) — a stray static tag would quietly undo the saving;
 *  - every page that still loads assets.js statically does NOT prefetch (it
 *    has nothing to fetch);
 *  - prefetchPanelScripts waits for idle, loads only known kinds, never runs
 *    on the Dash wallboard, and swallows a failed load (the next open retries);
 *  - map.js and appmap.js open an asset through PolarisPanels, never a bare
 *    openViewModal — on these pages the opener may not have landed yet.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { appSource } from "./_appSource.js";

const PUBLIC = resolve(__dirname, "../../public");
const app = appSource();
const lines = app.split(/\r?\n/);

function bundle(): string[] {
  const start = app.indexOf("var _PANEL_SCRIPT_BUNDLES = {");
  const body = app.slice(start, app.indexOf("\n};", start));
  const asset = /^\s{2}asset:\s*\[([\s\S]*?)\]/m.exec(body)![1];
  return [...asset.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}
const scriptSrcs = (html: string) => [...html.matchAll(/<script[^>]*\bsrc="([^"?]+)/g)].map((m) => m[1]);

const PREFETCHING: Record<string, string[]> = {
  "index.html": ["/js/temp-unit.js", "/js/favorites.js"],
  "map.html": ["/js/temp-unit.js", "/js/vendor/jspdf.umd.min.js", "/js/vendor/jspdf.plugin.autotable.min.js", "/js/vendor/html-to-image.min.js"],
  "appmap.html": ["/js/table-sf.js", "/js/vendor/jspdf.umd.min.js", "/js/vendor/jspdf.plugin.autotable.min.js", "/js/vendor/html-to-image.min.js"],
};

describe("pages that prefetch the asset bundle", () => {
  const b = bundle();
  for (const [page, allowed] of Object.entries(PREFETCHING)) {
    it(`${page} names the bundle on <body> and loads none of it statically beyond what it reads itself`, () => {
      const html = readFileSync(join(PUBLIC, page), "utf8");
      expect(html).toMatch(/<body data-prefetch-panels="asset">/);
      const statics = scriptSrcs(html).filter((s) => b.includes(s));
      expect(statics.sort()).toEqual([...allowed].sort());
    });
  }

  it("the bundle carries the wizard's own dependencies the static pages used to supply", () => {
    const b2 = bundle();
    expect(b2.indexOf("/js/scope-vocabulary.js")).toBeGreaterThan(b2.indexOf("/js/condition-builder.js"));
    expect(b2.indexOf("/js/scope-vocabulary.js")).toBeLessThan(b2.indexOf("/js/automations-wizard.js"));
    expect(b2.indexOf("/js/quiet-time-editor.js")).toBeGreaterThan(b2.indexOf("/js/recurrence-editor.js"));
  });

  it("a page that loads assets.js statically does not also prefetch", () => {
    for (const f of readdirSync(PUBLIC).filter((x) => x.endsWith(".html"))) {
      const html = readFileSync(join(PUBLIC, f), "utf8");
      if (scriptSrcs(html).includes("/js/assets.js")) expect(html, f).not.toMatch(/data-prefetch-panels/);
    }
  });

  it("map.js and appmap.js open an asset through PolarisPanels, not a bare openViewModal", () => {
    for (const f of ["map.js", "appmap.js"]) {
      const src = readFileSync(join(PUBLIC, "js", f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(src, f).not.toMatch(/(?<![\w.$])openViewModal\s*\(/);
      expect(src, f).toMatch(/PolarisPanels\.openAsset\(/);
    }
  });
});

describe("prefetchPanelScripts", () => {
  const start = lines.findIndex((l) => l.startsWith("function prefetchPanelScripts("));
  const end = lines.findIndex((l, i) => i > start && l === "}");
  const fnSrc = lines.slice(start, end + 1).join("\n");

  function make(attr: string | null, opts: { dash?: boolean; fail?: boolean } = {}) {
    const idleQueue: Array<() => void> = [];
    const ensure = vi.fn((k: string) => (opts.fail ? Promise.reject(new Error("blocked " + k)) : Promise.resolve()));
    const win: Record<string, unknown> = {
      requestIdleCallback: (fn: () => void) => { idleQueue.push(fn); },
      POLARIS_DASH_LOCAL: opts.dash ? true : undefined,
    };
    const doc = { body: { getAttribute: (n: string) => (n === "data-prefetch-panels" ? attr : null) } };
    const prefetch = new Function("window", "document", "ensurePanelScripts", "_PANEL_OPENERS",
      fnSrc + "\nreturn prefetchPanelScripts;")(win, doc, ensure, { asset: "openViewModal", network: "openIpPanel" }) as
      () => Promise<void>[];
    return { prefetch, ensure, idleQueue };
  }

  it("does nothing on a page without the attribute", () => {
    const { prefetch, ensure, idleQueue } = make(null);
    expect(prefetch()).toEqual([]);
    expect(idleQueue.length).toBe(0);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("waits for idle, then loads the named bundle", async () => {
    const { prefetch, ensure, idleQueue } = make("asset");
    const ps = prefetch();
    expect(ensure).not.toHaveBeenCalled();
    expect(idleQueue.length).toBe(1);
    idleQueue[0]();
    await Promise.all(ps);
    expect(ensure).toHaveBeenCalledWith("asset");
  });

  it("ignores an unknown kind and never runs on the Dash wallboard", () => {
    expect(make("asset bogus").prefetch().length).toBe(1);
    const dash = make("asset", { dash: true });
    expect(dash.prefetch()).toEqual([]);
    expect(dash.ensure).not.toHaveBeenCalled();
  });

  it("swallows a failed load", async () => {
    const { prefetch, idleQueue } = make("asset", { fail: true });
    const ps = prefetch();
    idleQueue[0]();
    await expect(Promise.all(ps)).resolves.toBeDefined();
  });

  it("is wired to window load", () => {
    expect(app).toMatch(/window\.addEventListener\("load", function \(\) \{ prefetchPanelScripts\(\); \}\);/);
  });
});
