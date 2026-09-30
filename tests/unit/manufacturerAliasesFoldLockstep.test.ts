/**
 * tests/unit/manufacturerAliasesFoldLockstep.test.ts
 *
 * The lockstep REMOVING an RBAC function key requires, for the fold of
 * `manufacturerAliases` into `manufacturerProfiles` (business rule 43(f)):
 * the key leaves FUNCTION_KEYS, every gate that named it moves to the key it
 * folded into, and a migration rewrites every stored matrix. Miss the gate and
 * `requirePermission` throws at module load; miss the migration and the folded
 * level is whatever `manufacturerProfiles` already held, so a role that could
 * edit aliases but only read profiles silently loses nothing it should, and one
 * set the other way round silently keeps alias editing it was never granted.
 *
 * Two keys becoming one cannot be access-neutral for a role holding them at
 * different levels, so the seed takes the LOWER of the two — the same "nobody
 * gains anything" rule as 20260923000000_authentication_function_key. Every
 * built-in holds the pair at equal levels, so none of them moves.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FUNCTION_KEYS, levelsFor } from "../../src/api/middleware/permissions.js";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const sql = () => read("prisma/migrations/20260923010000_fold_manufacturer_aliases/migration.sql");

describe("manufacturerAliases fold — catalogue and gates", () => {
  it("is gone from FUNCTION_KEYS, and manufacturerProfiles keeps none|read|write", () => {
    const keys = FUNCTION_KEYS.map((f) => f.key);
    expect(keys).not.toContain("manufacturerAliases");
    expect(keys).toContain("manufacturerProfiles");
    expect(levelsFor("manufacturerProfiles")).toEqual(["none", "read", "write"]);
  });

  it("no source file still gates on the removed key", () => {
    // requirePermission throws at module load on an unknown key, so the routes
    // would fail loudly — but a client-side permAtLeast() on it would just
    // answer false forever and hide a control from everyone.
    for (const p of [
      "src/api/router.ts",
      "src/api/routes/manufacturerAliases.ts",
      "public/js/server-settings.js",
      "public/js/app.js",
    ]) {
      expect(read(p), p).not.toMatch(/["']manufacturerAliases["']/);
    }
  });

  it("the alias mount reads on manufacturerProfiles, and every write asks for write", () => {
    expect(read("src/api/router.ts")).toMatch(
      /"\/manufacturer-aliases",\s*requirePermission\("manufacturerProfiles", "read"\)/,
    );
    const route = read("src/api/routes/manufacturerAliases.ts");
    for (const verb of ["post", "put", "delete"]) {
      expect(route, verb).toMatch(
        new RegExp(`router\\.${verb}\\([^)]*requirePermission\\("manufacturerProfiles", "write"\\)`),
      );
    }
  });
});

describe("manufacturerAliases fold — migration", () => {
  it("strips the old key from every stored matrix that has it", () => {
    const text = sql();
    expect(text).toMatch(/- 'manufacturerAliases'/);
    expect(text).toMatch(/WHERE "permissions" \? 'manufacturerAliases'/);
  });

  it("folds to the LOWER of the two levels, never the higher", () => {
    // If this comparison ever flips to `>`, a role that held alias write and
    // profile read gains profile editing nobody granted it.
    const text = sql();
    expect(text).toMatch(
      /perm_rank\("permissions" ->> 'manufacturerAliases'\)\s*<\s*pg_temp\.perm_rank\("permissions" ->> 'manufacturerProfiles'\)\s*THEN COALESCE\("permissions" ->> 'manufacturerAliases'/,
    );
  });

  it("defines its rank helper with CREATE OR REPLACE", () => {
    // `prisma migrate deploy` runs every pending migration in one session and
    // pg_temp outlives each file, so the hygiene migration's perm_rank is
    // still there when this one runs in the same update. A plain CREATE fails
    // 42723 and stops the update — found on a real database, not by reading.
    expect(sql()).toMatch(/CREATE OR REPLACE FUNCTION pg_temp\.perm_rank/);
    expect(sql()).not.toMatch(/CREATE FUNCTION pg_temp\./);
  });

  it("reads both keys and drops the old one in ONE statement", () => {
    // Split in two, a failure between them (or a reorder) either loses the
    // alias level before it is compared, or leaves both keys stored.
    const text = sql();
    const updates = text.match(/^UPDATE "roles"/gm) ?? [];
    expect(updates).toHaveLength(1);
  });
});
