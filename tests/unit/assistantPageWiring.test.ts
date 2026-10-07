/**
 * tests/unit/assistantPageWiring.test.ts
 *
 * The AI assistant is drawn BEFORE first paint on every app page, from cache
 * (PolarisAssistant.earlyMount, called at the end of app.js beside
 * _renderNavFromCache), so a page change does not blink it — business rule 94
 * and polaris-ui-canon → canon-modals-wizards.md § Floating tool window. That
 * needs, on every page that loads app.js:
 *   - assistant.css in <head> (styled on the first frame);
 *   - assistant-markdown.js then assistant.js BEFORE app.js (parser-inserted,
 *     so they have run when app.js's pre-paint pass calls earlyMount — and
 *     nothing may sit between app.js and #polaris-nav-ready, which
 *     pageTransitionWiring.test.ts pins).
 * A page missing them still works — app.js's _bootAssistant loads the files
 * late — it just blinks the panel on every navigation, which is the bug this
 * wiring fixed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PUBLIC = join(process.cwd(), "public");
const APP = '<script src="/js/app.js"></script>';
const pages = readdirSync(PUBLIC)
  .filter((f) => f.endsWith(".html"))
  .filter((f) => readFileSync(join(PUBLIC, f), "utf-8").includes(APP));

describe("assistant pre-paint wiring", () => {
  it("covers every app page", () => {
    expect(pages.length).toBeGreaterThanOrEqual(13);
  });

  for (const page of pages) {
    it(`${page} links the assistant before app.js`, () => {
      const html = readFileSync(join(PUBLIC, page), "utf-8");
      const head = html.slice(0, html.indexOf("</head>"));
      expect(head).toContain('<link rel="stylesheet" href="/css/assistant.css">');
      const md = html.indexOf('<script src="/js/assistant-markdown.js"></script>');
      const asst = html.indexOf('<script src="/js/assistant.js"></script>');
      const app = html.indexOf(APP);
      expect(md).toBeGreaterThan(-1);
      expect(asst).toBeGreaterThan(md);
      expect(app).toBeGreaterThan(asst);
    });
  }

  it("app.js draws it in the pre-paint pass, beside the cached nav", () => {
    const app = readFileSync(join(PUBLIC, "js", "app.js"), "utf-8");
    const nav = app.lastIndexOf("_navFromCache = _renderNavFromCache();");
    const early = app.indexOf("window.PolarisAssistant.earlyMount()");
    expect(early).toBeGreaterThan(nav);
  });
});
