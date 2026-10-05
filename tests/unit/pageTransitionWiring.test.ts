/**
 * Page changes crossfade (a cross-document view transition, styles.css) with
 * the sidebar held still. That only works when the NEW page's first paint
 * already shows a finished, themed rail — the transition snapshots it — and
 * three pieces on every app page make that so. Any page missing one blinks
 * its rail empty, unthemed or brandless on the way in:
 *   1. theme-init.js in <head>, so the first style pass has the theme;
 *   2. <link rel="expect" href="#polaris-nav-ready" blocking="render"> in
 *      <head>, which holds the first paint until the parser reaches…
 *   3. …the #polaris-nav-ready marker right after app.js, whose last lines
 *      build the rail from the cached user (_renderNavFromCache).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PUBLIC = join(process.cwd(), "public");
const APP_SCRIPT = '<script src="/js/app.js"></script>';
const appPages = readdirSync(PUBLIC)
  .filter((f) => f.endsWith(".html"))
  .filter((f) => readFileSync(join(PUBLIC, f), "utf-8").includes(APP_SCRIPT));

describe("page-change view transition wiring", () => {
  it("finds the app pages (every page that loads app.js)", () => {
    expect(appPages.length).toBeGreaterThanOrEqual(13);
  });

  for (const page of appPages) {
    it(`${page} paints a finished, themed rail on its first frame`, () => {
      const html = readFileSync(join(PUBLIC, page), "utf-8");
      const head = html.slice(0, html.indexOf("</head>"));
      expect(head).toContain('<script src="/js/theme-init.js"></script>');
      expect(head).toContain('<link rel="expect" href="#polaris-nav-ready" blocking="render">');
      // The marker must come AFTER app.js, or the render-block releases first.
      const app = html.indexOf(APP_SCRIPT);
      const marker = html.indexOf('<span id="polaris-nav-ready" hidden></span>');
      expect(marker).toBeGreaterThan(app);
      expect(html.slice(app + APP_SCRIPT.length, marker).trim()).toBe("");
    });
  }

  it("styles the transition, holds the rail still, and stands down under reduced motion", () => {
    const css = readFileSync(join(PUBLIC, "css", "styles.css"), "utf-8");
    expect(css).toContain("@view-transition { navigation: auto; }");
    expect(css).toContain(".sidebar { view-transition-name: polaris-sidebar; }");
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*@view-transition \{ navigation: none; \}/);
  });

  it("builds the rail from cache at the END of app.js, not only at DOMContentLoaded", () => {
    const js = readFileSync(join(PUBLIC, "js", "app.js"), "utf-8");
    const tail = js.slice(js.lastIndexOf("});"));
    expect(tail).toContain('if (document.getElementById("sidebar")) _navFromCache = _renderNavFromCache();');
  });
});
