/**
 * tests/unit/_serverSettingsSource.ts — the Server Settings page's scripts as
 * ONE source, for tests that slice or evaluate its functions.
 *
 * server-settings.js was split by tab (CQ-F051): the core plus one plain
 * browser script per tab, loaded in this order by server-settings.html. A test
 * that pulled `function foo(...)` out of server-settings.js by name should not
 * care which of those files `foo` lives in, so it reads `serverSettingsSource()`
 * — every file concatenated in page order, which is also exactly what the page
 * evaluates. A function moving between the split files then breaks no test.
 *
 * `SERVER_SETTINGS_FILES` is the load order tests/unit/serverSettingsSplit.test.ts
 * holds the page to. server-settings-ha.js and server-settings-firmware.js are
 * self-contained modules (`window.PolarisHaTab` / `PolarisFirmwareTab`), not
 * part of this split, and are read by their own tests directly.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const SERVER_SETTINGS_FILES = [
  "server-settings.js",
  "server-settings-ntp-web.js",
  "server-settings-maintenance.js",
  "server-settings-customization.js",
  "server-settings-identification.js",
  "server-settings-mibs.js",
  "server-settings-credentials.js",
  "server-settings-api-tokens.js",
  "server-settings-profiles.js",
] as const;

const JS_DIR = resolve(__dirname, "../../public/js");

export function serverSettingsFileSource(file: string): string {
  return readFileSync(resolve(JS_DIR, file), "utf8");
}

let cached: string | null = null;

/** Every split file in page load order, joined by a newline. */
export function serverSettingsSource(): string {
  if (cached === null) cached = SERVER_SETTINGS_FILES.map(serverSettingsFileSource).join("\n");
  return cached;
}
