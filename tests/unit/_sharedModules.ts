/**
 * tests/unit/_sharedModules.ts — evaluate public/js/chart-shared.js and
 * public/js/asset-shared.js for a test that loads a consumer standalone.
 *
 * assets.js (whole or sliced), mobile/asset-detail.js, mobile/charts.js and
 * mobile/telemetry-charts.js read `PolarisChartShared` / `PolarisAssetShared`
 * — on the page, from <script> tags loaded before them. A test that evals a
 * consumer by itself must call this first, AFTER it has installed the window
 * it evaluates against (the modules are attached to the current
 * `globalThis.window`, to `globalThis`, and to `win` when one is passed).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CHART_SRC = readFileSync(resolve(__dirname, "../../public/js/chart-shared.js"), "utf8");
const ASSET_SRC = readFileSync(resolve(__dirname, "../../public/js/asset-shared.js"), "utf8");

export function loadSharedModules(win?: Record<string, unknown>): void {
  const scratch: Record<string, unknown> = {};
  new Function("window", CHART_SRC)(scratch);
  new Function("window", ASSET_SRC)(scratch);
  const g = globalThis as Record<string, unknown>;
  const targets = new Set<Record<string, unknown>>([g]);
  if (g.window && typeof g.window === "object") targets.add(g.window as Record<string, unknown>);
  if (win) targets.add(win);
  for (const t of targets) {
    t.PolarisChartShared = scratch.PolarisChartShared;
    t.PolarisAssetShared = scratch.PolarisAssetShared;
  }
}
