/**
 * tests/unit/_integrationsSource.ts — the Integrations page's scripts as ONE
 * source, for tests that slice or evaluate its functions.
 *
 * integrations.js was split (CQ-F051): the core plus five plain browser
 * scripts, loaded in this order by every page that carries it and by app.js's
 * asset panel bundle. A test that pulled `function foo(...)` or
 * `var _INTEGRATION_PRODUCTS` out of integrations.js by name should not care
 * which of those files holds it, so it reads `integrationsSource()` — every
 * file concatenated in page order, which is also exactly what the page
 * evaluates. A function moving between the split files then breaks no test.
 *
 * `INTEGRATIONS_FILES` is the load order tests/unit/integrationsSplit.test.ts
 * holds the pages to.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const INTEGRATIONS_FILES = [
  "integrations.js",
  "integrations-feature-tabs.js",
  "integrations-monitoring.js",
  "integrations-forms.js",
  "integrations-generic-api.js",
  "integrations-query.js",
] as const;

const JS_DIR = resolve(__dirname, "../../public/js");

export function integrationsFileSource(file: string): string {
  return readFileSync(resolve(JS_DIR, file), "utf8");
}

let cached: string | null = null;

/** Every split file in page load order, joined by a newline. */
export function integrationsSource(): string {
  if (cached === null) cached = INTEGRATIONS_FILES.map(integrationsFileSource).join("\n");
  return cached;
}
