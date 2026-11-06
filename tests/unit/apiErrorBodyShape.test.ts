/**
 * tests/unit/apiErrorBodyShape.test.ts
 *
 * An error response carries its reason as `{ error }` — what the central
 * error handler sends and the ONLY key the browser client reads
 * (public/js/api.js → _readResponseBody: `data?.error`). A route that answers
 * `res.status(409).json({ message })` loses its reason on the way to the
 * toast: Discover Now on a switch whose integration was already discovering
 * showed "Request failed (409)" instead of "A discovery is already running
 * for …" (2026-11-06).
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("API error bodies", () => {
  it("no route answers a 4xx/5xx with { message } — the client reads `error`", () => {
    const offenders: string[] = [];
    const re = /\.status\(\s*[45]\d\d\s*\)\s*\.json\(\s*\{\s*message\s*:/;
    for (const file of tsFiles(join(process.cwd(), "src", "api"))) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => { if (re.test(line)) offenders.push(`${file}:${i + 1}`); });
    }
    expect(offenders).toEqual([]);
  });
});
