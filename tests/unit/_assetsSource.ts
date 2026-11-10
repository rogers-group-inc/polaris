/**
 * tests/unit/_assetsSource.ts — the Assets page script as ONE source, for tests
 * that slice or evaluate its functions.
 *
 * assets.js was split (CQ-F050): the core (the list page) plus thirteen plain
 * browser scripts, loaded in this order right after it by every page that
 * carries it and by app-panels.js's asset bundle. A test that pulled
 * `function foo(...)` or `var BAR` out of assets.js by name should not care
 * which of those files holds it, so it reads `assetsSource()` — every file
 * concatenated in page order, which is also exactly what the page evaluates.
 * A function moving between the split files then breaks no test.
 *
 * `ASSETS_FILES` is the load order tests/unit/assetsSplit.test.ts holds the
 * pages and the bundle to.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const ASSETS_FILES = [
  "assets.js",
  "assets-charts.js",
  "assets-form.js",
  "assets-panel.js",
  "assets-device-ops.js",
  "assets-system.js",
  "assets-monitoring.js",
  "assets-detail-panels.js",
  "assets-storage.js",
  "assets-network.js",
  "assets-snmp.js",
  "assets-sources.js",
  "assets-software.js",
  "assets-alerts-events.js",
] as const;

const JS_DIR = resolve(__dirname, "../../public/js");

export function assetsFileSource(file: string): string {
  return readFileSync(resolve(JS_DIR, file), "utf8");
}

let cached: string | null = null;

/** Every split file in page load order, joined by a newline. */
export function assetsSource(): string {
  if (cached === null) cached = ASSETS_FILES.map(assetsFileSource).join("\n");
  return cached;
}
