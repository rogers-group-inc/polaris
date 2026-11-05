/**
 * tests/unit/_appShellStubs.ts — the app.js globals a page script assumes.
 *
 * The DOM smoke tests eval a page script (integrations.js, assets.js) into a
 * bare happy-dom window. In the browser `app.js` always loads first, so those
 * scripts legitimately call its shared helpers as free variables.
 *
 * The form-part helpers are lifted VERBATIM out of app.js rather than
 * re-implemented here: several of these tests assert on the rendered copy that
 * flows through them, so a hand-written stub would pin the test to fake markup
 * and let the real thing drift underneath it. `extractAppFn` re-reads app.js on
 * every run, so a change there shows up as a test change, not a silent pass.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const APP_JS = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8");

/** One top-level `function name(...) {...}` declaration, source text and all. */
function extractAppFn(name: string): string {
  const start = APP_JS.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in public/js/app.js`);
  let depth = 0;
  let i = APP_JS.indexOf("{", start);
  for (; i < APP_JS.length; i++) {
    if (APP_JS[i] === "{") depth++;
    else if (APP_JS[i] === "}") { depth--; if (depth === 0) break; }
  }
  return APP_JS.slice(start, i + 1);
}

/** One top-level `var NAME = {...};` object literal. */
function extractAppVar(name: string): string {
  const start = APP_JS.indexOf(`var ${name} = {`);
  if (start < 0) throw new Error(`${name} not found in public/js/app.js`);
  const end = APP_JS.indexOf("};", start);
  return APP_JS.slice(start, end + 2);
}

/**
 * The shared modal-shell + form-part helpers, as a script prelude. Prepend this
 * to a page script before eval'ing it into a test window.
 *
 * `escapeHtml` is NOT included — it comes from api.js in the browser, and each
 * harness already stubs it alongside its own collaborators.
 */
export const APP_SHELL_STUBS: string = [
  extractAppFn("tabbedBodyHTML"),
  extractAppFn("wireModalTabs"),
  extractAppFn("sectionHeading"),
  extractAppFn("formDivider"),
  extractAppFn("infoBox"),
  extractAppFn("checkboxRow"),
  extractAppVar("CALLOUT_VARIANTS"),
  extractAppFn("calloutHTML"),
  extractAppFn("syncSelectedRows"),
  extractAppFn("revealOverlay"),
  // Not lifted: these reach into state a bare window doesn't have, and no DOM
  // smoke test drives them.
  "function openIntegrationModal(){}",
  "function showRowMenu(){}",
  "function isLightTheme(){ return false; }",
].join("\n");
