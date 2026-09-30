/**
 * tests/unit/pathChecksRbacLockstep.test.ts
 *
 * The `pathChecks` function key (Path Monitor) — the catalogue half and the
 * migration that seeds it onto every existing Role, which must move together
 * (see networkScanRbacLockstep.test.ts for why either half alone fails
 * silently).
 *
 * The seeding SOURCE is asserted because it encodes a decision: Path Monitor
 * starts at each role's Application Map level — the page beside it in the
 * sidebar — so the built-ins read the same on both (admin write, every other
 * built-in read). The first cut derived it from automationManagement, which
 * handed `assetsadmin` write on Path Monitor next to read on Application Map.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";

const MIGRATION = resolve(__dirname, "../../prisma/migrations/20260923030000_path_checks/migration.sql");
const sql = readFileSync(MIGRATION, "utf8");
const block = (() => {
  const start = sql.indexOf("'{pathChecks}'");
  const from = sql.lastIndexOf('UPDATE "roles"', start);
  const end = sql.indexOf(";", start);
  return sql.slice(from, end + 1);
})();

describe("pathChecks function key — lockstep", () => {
  it("is catalogued as Path Monitor, up to write", () => {
    const def = FUNCTION_KEYS.find((f) => f.key === "pathChecks");
    expect(def?.label).toBe("Path Monitor");
    expect(def?.levels).not.toContain("fullwrite");
  });

  it("is seeded from each role's applicationMap level, not automationManagement", () => {
    expect(block).toMatch(/CASE "permissions" ->> 'applicationMap'/);
    expect(block).not.toMatch(/automationManagement'/);
  });

  it("folds fullwrite to write, keeps read, and lands everything else on none", () => {
    expect(block).toMatch(/WHEN 'fullwrite' THEN '"write"'/);
    expect(block).toMatch(/WHEN 'write'\s+THEN '"write"'/);
    expect(block).toMatch(/WHEN 'read'\s+THEN '"read"'/);
    expect(block).toMatch(/ELSE '"none"'/);
  });

  it("only touches rows that lack the key, and bumps updatedAt so live snapshots refetch", () => {
    expect(block).toMatch(/WHERE NOT \("permissions" \? 'pathChecks'\)/);
    expect(block).toMatch(/"updatedAt" = CURRENT_TIMESTAMP/);
  });
});
