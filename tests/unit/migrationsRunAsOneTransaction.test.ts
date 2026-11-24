/**
 * tests/unit/migrationsRunAsOneTransaction.test.ts
 *
 * Business rule 197: every migration written from 2026-11-24 on runs as one
 * transaction — `BEGIN;` first, `COMMIT;` last.
 *
 * Prisma applies a migration's statements one at a time with no transaction
 * around them, so when the in-app updater's lock_timeout cancels a statement
 * in the middle of an ordinary migration, the statements before it stay
 * committed. That half-applied migration cannot be retried, and the operator
 * has to reconcile it by hand. A wrapped one rolls back whole, so the
 * migration guard marks it rolled back and retries it on its own.
 *
 * A migration that genuinely cannot run in a transaction block (CREATE INDEX
 * CONCURRENTLY, a TimescaleDB call that commits internally) opts out with a
 * line `-- polaris:no-transaction: <why>` — the reason is required.
 * Migrations before the cutoff are already applied on every install and are
 * never edited (that would change their checksum).
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isTransactionWrapped } from "../../src/services/migrationGuardService.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prisma", "migrations");
const CUTOFF = "20261124000000";
const OPT_OUT = /^--\s*polaris:no-transaction:\s*\S/m;

describe("migrations from rule 197 on run as one transaction", () => {
  const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name) && d.name.slice(0, 14) >= CUTOFF)
    .map((d) => d.name);

  it("the cutoff is not in the future of the newest pre-rule migration", () => {
    expect(existsSync(join(MIGRATIONS, "20261123120000_ipsec_template_totals"))).toBe(true);
  });

  it.each(dirs.length ? dirs : ["(none yet)"])("%s", (name) => {
    if (name === "(none yet)") return;
    const sql = readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8");
    const ok = isTransactionWrapped(sql) || OPT_OUT.test(sql);
    expect(
      ok,
      `${name}/migration.sql must start with BEGIN; and end with COMMIT; (business rule 197), ` +
        "or carry a `-- polaris:no-transaction: <reason>` line if it cannot run in a transaction",
    ).toBe(true);
  });
});
