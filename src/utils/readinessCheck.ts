/**
 * src/utils/readinessCheck.ts — "is this node the one that should be serving?"
 *
 * Liveness (`GET /health`) answers "is the event loop alive"; it deliberately
 * touches nothing, because the first-run setup wizard polls it before a
 * database exists. Readiness answers the different question a load balancer
 * actually needs in an active/standby deployment: **is my local PostgreSQL a
 * writable primary?**
 *
 * In the HA topology (docs/HA.md) both datacenters run nginx on 443 and both
 * answer /health, but only the node whose Patroni-managed Postgres holds the
 * leader lease may serve traffic. `pg_is_in_recovery()` is the authoritative
 * answer straight from the database itself — no Patroni REST call, no
 * agreement protocol, just "would a write succeed here". A hot standby
 * returns true and is therefore NOT ready.
 *
 * Design notes:
 *   - The probe runs on its OWN one-connection pool over the DIRECT database
 *     URL, never the Prisma pool. A saturated application pool must not be
 *     able to flap a healthy site out of the load balancer, and under
 *     PgBouncer the pooled view is not the server's own recovery state.
 *     (Same reasoning and shape as capacityService's direct stats pool.)
 *   - Every failure mode is a distinct `reason` so an operator reading the
 *     503 body can tell "I am a replica" (expected, on the standby) from
 *     "my database is unreachable" (an actual fault) from "my database is
 *     too slow to answer" (usually the same fault, earlier).
 *   - The probe is injectable so the timeout and failure branches are
 *     testable without a second Postgres in recovery.
 */

import pg from "pg";
import { logger } from "./logger.js";
import { getDirectDatabaseUrl } from "./dbConnections.js";

export type ReadinessReason = "in-recovery" | "db-error" | "timeout";

export interface ReadinessResult {
  ready:   boolean;
  reason?: ReadinessReason;
}

/** Resolves true when the local database is a writable primary. */
export type ReadinessProbe = () => Promise<boolean>;

export const READINESS_TIMEOUT_MS = 2000;

// Lazily created so importing this module never opens a connection (tests,
// non-HTTP roles, and the setup wizard all import the app graph).
let readinessPool: pg.Pool | null = null;

function getReadinessPool(): pg.Pool | null {
  if (readinessPool) return readinessPool;
  const url = getDirectDatabaseUrl();
  if (!url) return null;
  readinessPool = new pg.Pool({
    connectionString:       url,
    max:                    1,
    connectionTimeoutMillis: 1500,
    idleTimeoutMillis:      30_000,
    // Belt-and-braces: the outer race in checkReadiness() is what bounds the
    // caller, but a statement left running would hold the single slot.
    query_timeout:          1500,
    application_name:       "polaris-readiness",
  });
  // An idle-client error (DB restarted, failover killed the backend) must not
  // become an unhandled 'error' event and take the process down.
  readinessPool.on("error", (err) => {
    logger.warn({ err: err.message }, "readiness pool error (probe will retry on next scrape)");
  });
  return readinessPool;
}

/** The real probe: ask the local server whether it is still replaying WAL. */
async function defaultProbe(): Promise<boolean> {
  const pool = getReadinessPool();
  if (!pool) throw new Error("no database URL configured");
  const { rows } = await pool.query<{ in_recovery: boolean }>(
    "SELECT pg_is_in_recovery() AS in_recovery",
  );
  // A server that answers without a row is not something we call ready.
  if (!rows.length) throw new Error("pg_is_in_recovery() returned no rows");
  return rows[0].in_recovery === false;
}

/**
 * Run the readiness probe under a hard timeout.
 *
 * Never throws — every outcome is a ReadinessResult, so the route can map it
 * straight onto 200/503 without a try/catch of its own.
 */
export async function checkReadiness(
  probe:     ReadinessProbe = defaultProbe,
  timeoutMs: number         = READINESS_TIMEOUT_MS,
): Promise<ReadinessResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      // Do not hold the event loop open on this timer: a scrape that races
      // process shutdown must not delay the exit.
      timer.unref?.();
    });
    const outcome = await Promise.race([
      probe().then((primary): boolean => primary),
      timeout,
    ]);
    if (outcome === "timeout") return { ready: false, reason: "timeout" };
    return outcome ? { ready: true } : { ready: false, reason: "in-recovery" };
  } catch (err: any) {
    logger.warn({ err: err?.message }, "readiness probe failed");
    return { ready: false, reason: "db-error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test seam: drop the memoized pool so a suite can swap DATABASE_URL. */
export async function resetReadinessPoolForTests(): Promise<void> {
  const pool = readinessPool;
  readinessPool = null;
  if (pool) await pool.end().catch(() => {});
}
