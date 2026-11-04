/**
 * tests/unit/writeScopeLiftRbacLockstep.test.ts — the write-scope lift
 * (business rule 141 (e)) and the catalogue change it depends on move together.
 *
 * Read-Write on the seven asset-side keys stops meaning "any record" and
 * starts meaning "owned or tagged". Every stored `write` is lifted to
 * `fullwrite` so nobody narrows on update day — and that only holds if the
 * five keys that used to top out at `write` widen their ladder in the SAME
 * commit: `normalizePermissions` clamps a stored level into the ladder on the
 * next role save, so a lift without the widening would fold straight back
 * down, months later, on an unrelated edit.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FUNCTION_KEYS, levelsFor } from "../../src/api/middleware/permissions.js";

const MIGRATION = resolve(__dirname, "../../prisma/migrations/20261104100000_write_scope_lift/migration.sql");
// Statements only: the migration's own comment names the VALUES trap it avoids.
const sql = readFileSync(MIGRATION, "utf8").split(/\r?\n/).filter((l) => !l.trimStart().startsWith("--")).join("\n");

const LIFTED = ["assets", "assetsQuarantine", "alerts", "maintenanceManagement", "discoveryConflicts", "staleReservations", "deviceMap"];

describe("write-scope lift — lockstep", () => {
  it("lifts exactly the seven newly tag-scoped keys, in one correlated subquery, write → fullwrite only", () => {
    for (const k of LIFTED) expect(sql).toContain(`'${k}'`);
    expect(sql).not.toMatch(/'subnets'|'reservations'/);
    expect(sql).toMatch(/jsonb_object_agg\(k, '"fullwrite"'::jsonb\)/);
    expect(sql).toMatch(/WHERE r\."permissions" ->> k = 'write'/);
    expect(sql).not.toMatch(/FROM\s*\(\s*VALUES/i);
    expect(sql).toMatch(/"updatedAt" = CURRENT_TIMESTAMP/);
  });

  it("every lifted key holds fullwrite in the catalogue (the ladder widened with the lift)", () => {
    for (const k of LIFTED) {
      expect(levelsFor(k), `${k} would clamp a lifted fullwrite back to write`).toContain("fullwrite");
      const def = FUNCTION_KEYS.find((f) => f.key === k);
      expect(def?.tagScoped, `${k} is lifted but not tag-scoped`).toBe(true);
    }
  });

  it("subnets and reservations are tag-scoped without a lift — their write already meant own rows", () => {
    for (const k of ["subnets", "reservations"]) {
      expect(FUNCTION_KEYS.find((f) => f.key === k)?.tagScoped).toBe(true);
    }
  });
});
