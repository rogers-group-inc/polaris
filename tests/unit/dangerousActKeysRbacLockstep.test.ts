/**
 * tests/unit/dangerousActKeysRbacLockstep.test.ts
 *
 * The four function keys of 2026-11-03 — `assetMerge`, `agentDeploy`,
 * `alertClear`, `tags` — and the migration that seeds them onto every existing
 * Role, which must move together (networkScanRbacLockstep.test.ts has the
 * reasoning: either half alone fails silently).
 *
 * The seeding SOURCES encode the decisions:
 *   - merge / deploy copy `assets=fullwrite` and clear copies
 *     `alerts=fullwrite`, so the roles that could do the act yesterday can do
 *     it today and nobody else can — release 2 lifts stored write to fullwrite
 *     on those keys, and this split is what keeps that lift from handing out
 *     the acts;
 *   - `tags` copies `serverSettingsSystem`'s write and floors everyone else at
 *     read — the registry is where the pickers' colours come from.
 * No act key has a read rung (there is nothing on it to look at). Live
 * sessions see the keys after the restart the updater performs: a migration
 * cannot call bumpRoleVersion, so `updatedAt` is bumped for the refetch.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FUNCTION_KEYS, levelsFor } from "../../src/api/middleware/permissions.js";

const MIGRATION = resolve(__dirname, "../../prisma/migrations/20261103170000_dangerous_act_keys/migration.sql");
const sql = readFileSync(MIGRATION, "utf8");

function blockFor(key: string): string {
  const start = sql.indexOf(`'{${key}}'`);
  expect(start, `migration never seeds ${key}`).toBeGreaterThan(-1);
  const from = sql.lastIndexOf('UPDATE "roles"', start);
  const end = sql.indexOf(";", start);
  return sql.slice(from, end + 1);
}

describe("dangerous-act keys — lockstep", () => {
  it("are catalogued: three write-only act keys under Assets, tags up to write under Server Settings", () => {
    for (const key of ["assetMerge", "agentDeploy", "alertClear"]) {
      const def = FUNCTION_KEYS.find((f) => f.key === key);
      expect(def, key).toBeTruthy();
      expect(def!.section).toBe("assets");
      expect(levelsFor(key)).toEqual(["none", "write"]);
    }
    const tags = FUNCTION_KEYS.find((f) => f.key === "tags");
    expect(tags?.section).toBe("serverSettings");
    expect(levelsFor("tags")).toEqual(["none", "read", "write"]);
  });

  it("the source keys no longer claim the acts in their descriptions", () => {
    const assets = FUNCTION_KEYS.find((f) => f.key === "assets")!.description;
    const alerts = FUNCTION_KEYS.find((f) => f.key === "alerts")!.description;
    const sss = FUNCTION_KEYS.find((f) => f.key === "serverSettingsSystem")!.description;
    expect(assets).not.toMatch(/deploys the agent/i);
    expect(alerts).not.toMatch(/Full Read-Write clears/i);
    expect(sss).not.toMatch(/\btags\b/i);
  });

  it("assetMerge and agentDeploy copy assets=fullwrite and nothing lower", () => {
    const block = blockFor("assetMerge");
    expect(block).toContain("'{agentDeploy}'");
    const cases = block.match(/CASE "permissions" ->> 'assets'/g) ?? [];
    expect(cases.length).toBe(2);
    expect(block).toMatch(/WHEN 'fullwrite' THEN '"write"'/);
    expect(block).not.toMatch(/WHEN 'write'\s+THEN '"write"'/);
    expect(block).toMatch(/ELSE '"none"'/);
    expect(block).toMatch(/WHERE NOT \("permissions" \? 'assetMerge'\) OR NOT \("permissions" \? 'agentDeploy'\)/);
    expect(block).toMatch(/"updatedAt" = CURRENT_TIMESTAMP/);
  });

  it("alertClear copies alerts=fullwrite and nothing lower", () => {
    const block = blockFor("alertClear");
    expect(block).toMatch(/CASE "permissions" ->> 'alerts'/);
    expect(block).toMatch(/WHEN 'fullwrite' THEN '"write"'/);
    expect(block).not.toMatch(/WHEN 'write'\s+THEN '"write"'/);
    expect(block).toMatch(/ELSE '"none"'/);
    expect(block).toMatch(/WHERE NOT \("permissions" \? 'alertClear'\)/);
    expect(block).toMatch(/"updatedAt" = CURRENT_TIMESTAMP/);
  });

  it("tags copies serverSettingsSystem's write and floors everyone else at read", () => {
    const block = blockFor("tags");
    expect(block).toMatch(/CASE "permissions" ->> 'serverSettingsSystem'/);
    expect(block).toMatch(/WHEN 'fullwrite' THEN '"write"'/);
    expect(block).toMatch(/WHEN 'write'\s+THEN '"write"'/);
    expect(block).toMatch(/ELSE '"read"'/);
    expect(block).not.toMatch(/'"none"'/);
    expect(block).toMatch(/WHERE NOT \("permissions" \? 'tags'\)/);
    expect(block).toMatch(/"updatedAt" = CURRENT_TIMESTAMP/);
  });

  it("never uses the UPDATE … FROM (VALUES …) shape that folds one key per row", () => {
    expect(sql).not.toMatch(/FROM\s*\(\s*VALUES/i);
  });
});
