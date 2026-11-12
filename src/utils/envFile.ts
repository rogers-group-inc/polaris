/**
 * src/utils/envFile.ts — Mutate the runtime .env in place.
 *
 * The setup wizard writes a fully templated .env once at install time. This
 * helper covers the post-install case where a route handler needs to set or
 * replace a single key (e.g. the [Generate token] button on the Maintenance
 * tab's `metrics_token_unset` / `health_token_unset` capacity reasons).
 *
 * Comments and other lines are preserved. If the key already appears
 * uncommented, its line is rewritten in place; otherwise the new line is
 * appended.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ENV_FILE } from "./paths.js";

export function setEnvVar(key: string, value: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(`Refusing to write malformed env key: ${key}`);
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`Refusing to write env value containing newline for ${key}`);
  }
  const newLine = `${key}=${value}`;
  const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf-8") : "";
  const lineRe = new RegExp(`^${key}=.*$`, "m");
  const next = lineRe.test(existing)
    ? existing.replace(lineRe, () => newLine) // a function: a string replacement would expand $& / $` / $' / $$ in the value
    : (existing === "" || existing.endsWith("\n") ? existing + newLine + "\n" : existing + "\n" + newLine + "\n");
  writeFileSync(ENV_FILE, next, "utf-8");
}
