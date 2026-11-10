/**
 * tests/unit/_appSource.ts — the app shell's scripts as ONE source, for tests
 * that slice or evaluate its functions.
 *
 * app.js was split (CQ-F051): the core plus seven plain browser scripts,
 * loaded in this order by every app page, app-boot.js last. A test that pulled
 * `function foo(...)` or `var NAV_ITEMS` out of app.js by name should not care
 * which of those files holds it, so it reads `appSource()` — every file
 * concatenated in page order, which is also exactly what the page evaluates.
 * A function moving between the split files then breaks no test.
 *
 * `APP_FILES` is the load order tests/unit/appSplit.test.ts holds the pages to.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const APP_FILES = [
  "app.js",
  "app-search.js",
  "app-sidebar.js",
  "app-modals.js",
  "app-rows.js",
  "app-panels.js",
  "app-tags.js",
  "app-boot.js",
] as const;

const JS_DIR = resolve(__dirname, "../../public/js");

export function appFileSource(file: string): string {
  return readFileSync(resolve(JS_DIR, file), "utf8");
}

let cached: string | null = null;

/** Every split file in page load order, joined by a newline. */
export function appSource(): string {
  if (cached === null) cached = APP_FILES.map(appFileSource).join("\n");
  return cached;
}
