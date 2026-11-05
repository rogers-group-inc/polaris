/**
 * src/utils/dbConnections.ts
 *
 * Single source of truth for "is Polaris talking to PostgreSQL directly,
 * or through PgBouncer in front of PostgreSQL?" and for the connection
 * strings each layer should use.
 *
 * Polaris is **PgBouncer-aware**: operators who deploy PgBouncer between
 * Polaris and PostgreSQL set `POLARIS_DB_DIRECT_URL` to the direct
 * Postgres URL, leave `DATABASE_URL` pointing at PgBouncer, and Polaris
 * routes traffic accordingly:
 *
 *   - Application queries (Prisma) → DATABASE_URL (PgBouncer; transaction-
 *     pool mode multiplexes Polaris's many connection slots onto a small
 *     number of real Postgres backends).
 *   - pg-boss queue ops → POLARIS_DB_DIRECT_URL. pg-boss uses LISTEN /
 *     NOTIFY for job-state propagation and relies on the pg client's
 *     prepared-statement cache; both break under PgBouncer transaction
 *     pooling. Direct connection is mandatory.
 *   - `pg_dump` backups + restores → POLARIS_DB_DIRECT_URL. PgBouncer
 *     doesn't proxy the COPY-heavy pg_dump protocol reliably.
 *   - `pg_stat_activity` reads (capacity snapshot, pool peak gauge) →
 *     POLARIS_DB_DIRECT_URL via a small dedicated pg.Pool. Going through
 *     PgBouncer would show only the multiplexed view of backend connections,
 *     which is misleading.
 *   - Prisma migrations → POLARIS_DB_DIRECT_URL (operator concern; the
 *     install docs explain how to set the URL when running migrations).
 *   - express-session storage → DATABASE_URL. Low-volume INSERT/SELECT/DELETE,
 *     no LISTEN/NOTIFY, prepared statements aren't held across requests —
 *     PgBouncer transaction pool handles it cleanly.
 *
 * Backward compat: when `POLARIS_DB_DIRECT_URL` is unset, every "direct"
 * path falls back to DATABASE_URL. Existing single-URL installs see no
 * behavior change.
 */

export type DbConnectionMode = "direct" | "pgbouncer";

/**
 * Returns the connection string to use for direct-to-PostgreSQL access
 * (backups, restores, pg-boss, pg_stat_activity reads). Falls back to
 * DATABASE_URL when POLARIS_DB_DIRECT_URL isn't configured.
 */
export function getDirectDatabaseUrl(): string {
  return process.env.POLARIS_DB_DIRECT_URL || process.env.DATABASE_URL || "";
}

/**
 * Returns the connection string for application queries (Prisma). This is
 * always DATABASE_URL — under PgBouncer mode it points at PgBouncer; under
 * direct mode it points at Postgres directly.
 */
function getApplicationDatabaseUrl(): string {
  return process.env.DATABASE_URL || "";
}

/**
 * Detects whether Polaris is running with PgBouncer in front of Postgres.
 *
 * Returns `"pgbouncer"` when:
 *   - `POLARIS_DB_DIRECT_URL` is set AND differs from DATABASE_URL, OR
 *   - DATABASE_URL contains the `?pgbouncer=true` query parameter
 *     (Prisma's documented convention for PgBouncer-aware connections).
 *
 * Returns `"direct"` otherwise.
 */
export function getDbConnectionMode(): DbConnectionMode {
  const app = getApplicationDatabaseUrl();
  const direct = process.env.POLARIS_DB_DIRECT_URL;
  if (direct && direct !== app) return "pgbouncer";
  if (app.includes("pgbouncer=true")) return "pgbouncer";
  return "direct";
}

export function isPgbouncerMode(): boolean {
  return getDbConnectionMode() === "pgbouncer";
}
