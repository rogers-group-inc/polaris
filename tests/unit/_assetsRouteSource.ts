/**
 * tests/unit/_assetsRouteSource.ts — the /api/v1/assets routes as ONE source,
 * for tests that assert on their text (a gate, a schema limit, a query param).
 *
 * routes/assets.ts was split into the sub-routers under src/api/routes/assets/
 * (CQ-B062), each block moved verbatim and mounted in order, so a request never
 * notices — but a text assertion pinned to routes/assets.ts would break. Such a
 * test reads `assetsRouteSource()` instead: the mount file, then the sub-routers
 * in MOUNT order (so "declared above GET /:id" still means "registered before
 * it"), then any other assets/*.ts module (shared.ts) in name order.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const ROUTES = resolve(__dirname, "../../src/api/routes");

/** routes/assets.ts plus every src/api/routes/assets/*.ts, joined by a newline. */
export function assetsRouteSource(): string {
  const mount = readFileSync(join(ROUTES, "assets.ts"), "utf8");
  const vars = new Map<string, string>();
  for (const m of mount.matchAll(/^import (\w+) from "\.\/assets\/(\w+)\.js";$/gm)) vars.set(m[1], `${m[2]}.ts`);
  const mounted = [...mount.matchAll(/^router\.use\((\w+)\);$/gm)].map((m) => vars.get(m[1]) as string);
  const rest = readdirSync(join(ROUTES, "assets")).filter((f) => f.endsWith(".ts") && !mounted.includes(f)).sort();
  return [mount, ...[...mounted, ...rest].map((f) => readFileSync(join(ROUTES, "assets", f), "utf8"))].join("\n");
}
