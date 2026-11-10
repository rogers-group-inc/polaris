/**
 * tests/unit/_automationsWizardSource.ts — the automation wizard's scripts as
 * ONE source, for tests that slice or evaluate its functions.
 *
 * automations-wizard.js was split (CQ-F051): the core (openAutomationWizard
 * and its module catalogs) plus four pure helper scripts loaded right after
 * it, in this order, by every page that carries it and by app-panels.js's
 * asset bundle. A test that pulled a function or a window.Polaris* export out
 * of automations-wizard.js should not care which file holds it, so it reads
 * `wizardSource()` — every file concatenated in page order, which is also
 * exactly what the page evaluates.
 *
 * `WIZARD_FILES` is the load order tests/unit/automationsWizardSplit.test.ts
 * holds the pages to.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const WIZARD_FILES = [
  "automations-wizard.js",
  "automations-wizard-recipients.js",
  "automations-wizard-sentences.js",
  "automations-wizard-dimensions.js",
  "automations-wizard-filters.js",
] as const;

const JS_DIR = resolve(__dirname, "../../public/js");

export function wizardFileSource(file: string): string {
  return readFileSync(resolve(JS_DIR, file), "utf8");
}

let cached: string | null = null;

/** Every split file in page load order, joined by a newline. */
export function wizardSource(): string {
  if (cached === null) cached = WIZARD_FILES.map(wizardFileSource).join("\n");
  return cached;
}
