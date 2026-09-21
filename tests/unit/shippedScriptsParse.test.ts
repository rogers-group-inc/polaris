/**
 * tests/unit/shippedScriptsParse.test.ts
 *
 * Every browser script under public/ has to PARSE.
 *
 * There is no build step, so nothing in the toolchain has ever looked at these
 * files as code: `tsc` does not see them, eslint's TS config does not cover
 * them, and the DOM tests that assert against `app.js` read it as TEXT or lift
 * individual functions out of it with `new Function`. A syntax error therefore
 * ships with a completely green suite and is found by opening the page.
 *
 * It happened on 2026-09-21. `renderNav` builds the whole sidebar as one
 * template literal, a backtick went into an HTML comment inside it (quoting an
 * attribute name, out of markdown habit), and that ended the string. The
 * symptom was not a broken comment — it was the sidebar failing to render on
 * every page of the app, with 9141 tests still passing.
 *
 * `vm.Script` compiles without running, so this costs a few milliseconds per
 * file and executes none of it. Vendor bundles are skipped: they are third
 * party, minified, and not ours to fix.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Script } from "node:vm";

const PUBLIC_DIR = join(process.cwd(), "public");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "vendor") continue; // third-party bundles, not ours
      walk(full, out);
    } else if (entry.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const SCRIPTS = walk(PUBLIC_DIR);

describe("shipped browser scripts", () => {
  it("finds the scripts at all, so an empty sweep can't pass as success", () => {
    // A walk that silently returns nothing would make every case below vacuous.
    expect(SCRIPTS.length).toBeGreaterThan(50);
  });

  it.each(SCRIPTS.map((f) => relative(PUBLIC_DIR, f).replace(/\\/g, "/")))(
    "public/%s parses",
    (rel) => {
      const src = readFileSync(join(PUBLIC_DIR, rel), "utf-8");
      // Compiles only — no execution, so browser globals are irrelevant.
      expect(() => new Script(src, { filename: rel })).not.toThrow();
    },
  );
});
