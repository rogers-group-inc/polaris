/**
 * tests/unit/rootHelperHintsFullPath.test.ts — every "run this" hint for a
 * root helper names its full /usr/local/sbin path. RHEL's sudo resets PATH to
 * secure_path (/sbin:/bin:/usr/sbin:/usr/bin), which leaves /usr/local/sbin
 * out, so a bare `sudo polaris-update-sync --apply-helpers` is "command not
 * found" on every RHEL install (found on prod 2026-10-14).
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCAN = ["deploy", "docs", "src", "public", "README.md"];
const SKIP = new Set(["node_modules", "generated", "vendor"]);
const TEXT = /\.(sh|ts|js|mjs|md|html|service|conf|rules)$/;

function* files(p: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(p, { withFileTypes: true });
  } catch {
    if (TEXT.test(p)) yield p;
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = join(p, e.name);
    if (e.isDirectory()) yield* files(full);
    else if (TEXT.test(e.name)) yield full;
  }
}

// Walks deploy/ docs/ src/ public/ synchronously; the 5 s default is crossed under full-suite load.
describe("root helper hints", { timeout: 30_000 }, () => {
  it("never tell the operator to run a bare `sudo polaris-…` command", () => {
    const bare: string[] = [];
    for (const top of SCAN) {
      for (const f of files(join(ROOT, top))) {
        readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
          if (/sudo\s+polaris-[a-z]/.test(line)) bare.push(`${relative(ROOT, f)}:${i + 1}`);
        });
      }
    }
    expect(bare).toEqual([]);
  });
});
