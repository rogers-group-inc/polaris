/**
 * tests/unit/appSplit.test.ts — the CQ-F051 split of public/js/app.js into a
 * core plus seven plain browser scripts (APP_FILES in ./_appSource).
 *
 * The files share page globals and have no module system, so a page is only
 * correct when:
 *  - every page that loads one of them loads all of them, core first, in order,
 *    app-boot.js last and still ahead of the `polaris-nav-ready` marker the
 *    page's render-blocking `<link rel="expect">` waits for;
 *  - each original top-level function / var is declared exactly once across
 *    them (twice = the later file's silently wins; none = a dropped function);
 *  - evaluating them in page order runs without a ReferenceError — app-boot.js
 *    renders the nav from the cached user AT LOAD, and that render calls into
 *    the search, sidebar and tag files, so they must all be defined by then.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { Window } from "happy-dom";
import { APP_FILES, appFileSource } from "./_appSource.js";

const PUBLIC = resolve(__dirname, "../../public");
const INVENTORY = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/appInventory.json"), "utf8"),
) as { functions: string[]; vars: string[] };

// Desktop shell scripts only: /js/<name>.js. (mobile.html loads its own
// /js/mobile/app.js, which is a different file.)
const shellName = (s: string) => {
  const m = /^\/js\/([^/?]+\.js)(?:\?.*)?$/.exec(s);
  return m ? m[1] : "";
};
const scriptSrcs = (html: string) => [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => shellName(m[1]));
const topLevel = (src: string, re: RegExp) => [...src.matchAll(re)].map((m) => m[1]);
const FN_RE = /^(?:async )?function ([A-Za-z_$][\w$]*)\(/gm;
const VAR_RE = /^(?:var|const|let) ([A-Za-z_$][\w$]*)/gm;

function htmlPages(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== "vendor") out.push(...htmlPages(join(dir, e.name))); continue; }
    if (e.name.endsWith(".html")) out.push(join(dir, e.name));
  }
  return out;
}

describe("app split — pages", () => {
  const split = new Set<string>(APP_FILES);
  const pages = htmlPages(PUBLIC)
    .map((p) => ({ page: p.slice(PUBLIC.length + 1).replace(/\\/g, "/"), html: readFileSync(p, "utf8") }))
    .map((p) => ({ ...p, srcs: scriptSrcs(p.html) }))
    .filter((p) => p.srcs.some((s) => split.has(s)));

  it("every page that carried app.js before the split carries the split", () => {
    expect(pages.map((p) => p.page).sort()).toEqual([
      "appmap.html", "assets.html", "automations.html", "blocks.html", "events.html", "index.html", "integrations.html",
      "ipam.html", "map.html", "path-monitor.html", "server-settings.html", "subnets.html", "users.html",
    ]);
  });

  it("every page loads all of them, once each, core first, in order, as one consecutive run", () => {
    for (const { page, srcs } of pages) {
      expect(srcs.filter((s) => split.has(s)), page).toEqual([...APP_FILES]);
      const at = srcs.indexOf("app.js");
      expect(srcs.slice(at, at + APP_FILES.length), page).toEqual([...APP_FILES]);
    }
  });

  it("theme-core.js loads before the core, and app-boot.js before the nav-ready marker", () => {
    for (const { page, srcs, html } of pages) {
      expect(srcs.indexOf("theme-core.js"), page).toBeGreaterThanOrEqual(0);
      expect(srcs.indexOf("theme-core.js"), page).toBeLessThan(srcs.indexOf("app.js"));
      const marker = html.indexOf('id="polaris-nav-ready"');
      if (marker >= 0) expect(html.indexOf('src="/js/app-boot.js"'), page).toBeLessThan(marker);
    }
  });

  it("every public/js/app*.js is in the split", () => {
    const onDisk = readdirSync(join(PUBLIC, "js")).filter((f) => /^app(-[a-z]+)?\.js$/.test(f)).sort();
    expect(onDisk).toEqual([...APP_FILES].sort());
  });
});

describe("app split — declarations", () => {
  const perFile = APP_FILES.map((f) => {
    const src = appFileSource(f);
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

  it("every function the original app.js declared is declared exactly once", () => {
    const all = perFile.flatMap((p) => p.fns);
    expect(INVENTORY.functions.length).toBe(207);
    for (const n of INVENTORY.functions) expect(all.filter((x) => x === n).length, n).toBe(1);
    expect(all.length).toBe(INVENTORY.functions.length);
  });

  it("every top-level var / const / let the original declared is declared exactly once", () => {
    const all = perFile.flatMap((p) => p.vars);
    expect(INVENTORY.vars.length).toBe(80);
    for (const n of INVENTORY.vars) expect(all.filter((x) => x === n).length, n).toBe(1);
    expect(all.length).toBe(INVENTORY.vars.length);
  });

  it("each split file holds something", () => {
    for (const { file, fns } of perFile) expect(fns.length, file).toBeGreaterThan(0);
  });
});

describe("app split — load-time evaluation in page order", () => {
  /**
   * Boot the shell the way a page does: api.js, theme-core.js and panel-lock.js, then
   * every split file in order, in one window, with a cached signed-in user and
   * a #sidebar — so app-boot.js's load-time `_renderNavFromCache()` really runs
   * renderNav(), which reaches into app-search.js, app-sidebar.js and the rest.
   */
  function boot() {
    const win = new Window({ url: "https://polaris.example/index.html" });
    win.document.body.innerHTML = '<aside id="sidebar"></aside><main></main>';
    win.localStorage.setItem("polaris-user", JSON.stringify({
      role: "admin", username: "ops", permissions: { users: "fullwrite", assets: "fullwrite" }, regions: [],
    }));
    const run = (file: string) => (win as unknown as { eval(src: string): unknown }).eval(
      readFileSync(join(PUBLIC, "js", file), "utf8"),
    );
    // What every page loads ahead of the shell that the shell reads at load.
    run("api.js");
    run("theme-core.js");
    run("panel-lock.js");
    for (const f of APP_FILES) run(f);
    return win as unknown as Record<string, any>;
  }

  it("evaluates without a load-time ReferenceError, and the cached nav renders", () => {
    const w = boot();
    expect(w._navFromCache).toMatchObject({ role: "admin" });
    expect(w.document.getElementById("sidebar").innerHTML.length).toBeGreaterThan(0);
  });

  it("every original top-level function is a global after evaluation", () => {
    const w = boot();
    for (const n of INVENTORY.functions) expect(typeof w[n], n).toBe("function");
  });
});
