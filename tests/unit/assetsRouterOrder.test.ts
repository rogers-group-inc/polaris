/**
 * tests/unit/assetsRouterOrder.test.ts — /assets literal routes register before
 * the `/:id` routes that would swallow them.
 *
 * routes/assets.ts mounts the sub-routers under routes/assets/ in order
 * (CQ-B062). Express tries routes in registration order, so a literal such as
 * `GET /assets/ip-check` registered AFTER `GET /assets/:id` is read as an asset
 * id and never reached — silently, since the `/:id` handler just 404s. This
 * walks the mount order and every sub-router's route declarations, and fails on
 * any one-segment literal path that comes after a `/:id` route of the same
 * method.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROUTES = resolve(__dirname, "../../src/api/routes");

function routesInMountOrder(): { method: string; path: string; file: string }[] {
  const mount = readFileSync(join(ROUTES, "assets.ts"), "utf8");
  const vars = new Map<string, string>();
  for (const m of mount.matchAll(/^import (\w+) from "\.\/assets\/(\w+)\.js";$/gm)) vars.set(m[1], m[2]);
  const order = [...mount.matchAll(/^router\.use\((\w+)\);$/gm)].map((m) => vars.get(m[1]));
  expect(order.length).toBe(vars.size);
  const out: { method: string; path: string; file: string }[] = [];
  for (const f of order) {
    const src = readFileSync(join(ROUTES, "assets", `${f}.ts`), "utf8");
    for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*(\[[^\]]*\]|"[^"]*")/g)) {
      for (const p of m[2].matchAll(/"([^"]*)"/g)) out.push({ method: m[1], path: p[1], file: `${f}.ts` });
    }
  }
  return out;
}

describe("/assets route registration order", () => {
  const routes = routesInMountOrder();

  it("finds every route (115 at the CQ-B062 split)", () => {
    expect(routes.length).toBeGreaterThanOrEqual(115);
  });

  it("registers each one-segment literal before the /:id route of its method", () => {
    const late: string[] = [];
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const firstId = routes.findIndex((r) => r.method === method && r.path === "/:id");
      if (firstId < 0) continue;
      routes.forEach((r, i) => {
        if (i > firstId && r.method === method && /^\/[a-z][\w-]*$/.test(r.path)) late.push(`${method.toUpperCase()} ${r.path} (${r.file})`);
      });
    }
    expect(late).toEqual([]);
  });
});
