/**
 * tests/unit/routerBoots.test.ts
 *
 * Regression guard for the 2026-07-23 prod incident: a route path using the
 * retired Express-4 `:param(regex)` syntax (`/:id/services/:unit(*)/control`)
 * threw a path-to-regexp PathError AT ROUTE-REGISTRATION TIME, crash-looping
 * polaris-web on boot. Nothing in CI validated route path syntax, so
 * typecheck/lint/unit tests all passed.
 *
 * Rather than importing the app (route modules carry import-time side
 * effects), this scans every file in src/api/routes/ for string literals
 * passed to router verb calls and compiles each through the INSTALLED
 * path-to-regexp (the exact version Express 5 registers routes with). Any
 * path that would throw at registration fails here instead of at prod boot.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToRegexp } from "path-to-regexp";

const ROUTES_DIR = join(__dirname, "..", "..", "src", "api", "routes");

// router.get("/x", ...) / assetsRouter.post('/y', ...) / app.use(`/z`, ...)
const VERB_CALL_RE = /\.\s*(get|post|put|delete|patch|all|use)\s*\(\s*(["'`])((?:\\.|(?!\2).)*)\2/g;

function extractRoutePaths(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(VERB_CALL_RE)) {
    const path = m[3];
    // Only route-ish literals (skip .use("trust proxy")-style settings and
    // event names) — route paths start with "/".
    if (path.startsWith("/")) out.push(path);
  }
  return out;
}

describe("route path syntax", () => {
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));

  it("finds route files to scan", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    it(`${file}: every route path compiles under the installed path-to-regexp`, () => {
      const source = readFileSync(join(ROUTES_DIR, file), "utf8");
      for (const path of extractRoutePaths(source)) {
        try {
          pathToRegexp(path);
        } catch (err) {
          throw new Error(
            `${file}: route path ${JSON.stringify(path)} would throw at Express route registration ` +
            `(this crash-loops polaris-web at boot): ${(err as Error).message}`,
            { cause: err },
          );
        }
      }
    });
  }
});
