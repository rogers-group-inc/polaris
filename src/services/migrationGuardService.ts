/**
 * src/services/migrationGuardService.ts
 *
 * The in-app updater's `prisma migrate deploy`, run so that a schema change
 * can never stall live writes (business rule 197).
 *
 * Why it exists — the 2026-11-23 prod update. Its one pending migration added
 * a foreign key to `assets`. `ADD CONSTRAINT … FOREIGN KEY` takes SHARE ROW
 * EXCLUSIVE on the REFERENCED table, which conflicts with every INSERT/UPDATE.
 * A transaction that had written to `assets` stayed open, so the ALTER queued
 * behind it, and Postgres queues every later writer behind the ALTER
 * (head-of-line blocking): agent check-ins and the probe patch buffer stopped
 * landing, and agent-polled devices went Down for the length of the wait. The
 * updater's 5-minute exec timeout then killed the Prisma CLI, but the native
 * schema-engine it had spawned kept running, and its Postgres backend kept
 * waiting — a backend blocked on a lock does not notice its client has gone.
 * It finished minutes later, after the update had reported failure.
 *
 * Three things here, each answering one part of that:
 *
 *  1. **Fail fast.** The migrate child connects with `lock_timeout` (10 s), so
 *     a statement that cannot get its lock gives up instead of holding the
 *     queue. Writers stall for at most that long per attempt.
 *  2. **Retry only what is provably clean.** Prisma runs a migration's
 *     statements one at a time with no transaction around them (measured on
 *     Prisma 7: the CREATE TABLE before the blocked FK stayed committed), so
 *     a lock timeout in the middle of an ordinary migration leaves it
 *     half-applied and a retry would fail on "already exists". A migration
 *     wrapped in `BEGIN; … COMMIT;` is all-or-nothing, so after it fails the
 *     guard marks it rolled back (`migrate resolve --rolled-back`) and tries
 *     again after a back-off, until the step's deadline. Prisma loses the real
 *     error for a wrapped migration — it tries to record the failure on the
 *     aborted connection and reports "current transaction is aborted" — so
 *     lock contention is recognised by watching our own backend in
 *     pg_stat_activity while it runs, not from the output alone.
 *  3. **Clean up on timeout.** Every backend carrying our application_name is
 *     terminated, so nothing keeps running against the schema after the
 *     update has given up. The next run finds a wrapped migration's failed
 *     row and resolves it the same way.
 *
 * Only the updater uses this. The boot-time `polaris-migrate` oneshot, the
 * container entrypoint and the setup scripts run migrations with the app
 * stopped; nothing is waiting on them, and failing there would only stop the
 * app from starting.
 */

import pg from "pg";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { getDirectDatabaseUrl } from "../utils/dbConnections.js";
import { sleep as realSleep } from "../utils/sleep.js";

/** The application_name the updater's migrate child connects with. It is how
 *  the lock-wait sampler and the timeout clean-up find our backend and no
 *  other. */
export const MIGRATE_APPLICATION_NAME = "polaris-migrate-update";
/** Longest any one statement may wait for a lock. Writers queued behind a
 *  waiting ALTER stall for at most this long. */
const MIGRATE_LOCK_TIMEOUT_MS = 10_000;
/** How often the sampler looks for our backend waiting on a lock. */
const LOCK_SAMPLE_INTERVAL_MS = 1_000;
/** Waits between attempts after a lock timeout; the last value repeats. */
const RETRY_BACKOFF_MS = [15_000, 30_000, 45_000, 60_000];

export interface LockBlocker {
  pid: number;
  applicationName: string;
  state: string;
  /** Seconds since the blocking transaction began; null when unknown. */
  transactionSeconds: number | null;
  /** The blocker's current or last statement, cut short. */
  query: string;
}

/** The database side of the guard: an injectable seam so tests need no
 *  Postgres. Every method must swallow its own errors. */
export interface MigrateDbProbe {
  /** Sessions blocking our migrate backend right now; empty when it is not waiting on a lock. */
  blockers(): Promise<LockBlocker[]>;
  /** Terminate every backend carrying MIGRATE_APPLICATION_NAME; returns how many. */
  terminate(): Promise<number>;
  close(): Promise<void>;
}

type ExecResult = { stdout: string; stderr: string };
type Exec = (cmd: string, opts?: Record<string, unknown>) => Promise<ExecResult>;

export interface GuardedMigrateOptions {
  exec: Exec;
  appDir: string;
  /** The command that runs the Prisma CLI, e.g. `node node_modules/prisma/build/index.js`. */
  prismaCli: string;
  /** Total time across every attempt. */
  deadlineMs: number;
  lockTimeoutMs?: number;
  /** Defaults to the direct (non-PgBouncer) URL. */
  databaseUrl?: string;
  db?: MigrateDbProbe;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  readMigrationSql?: (name: string) => string | null;
  /** Progress line for the step card. */
  onProgress?: (message: string) => void;
}

export type GuardedMigrateResult =
  | { ok: true; attempts: number; blockers: LockBlocker[]; summary: string }
  | {
      ok: false;
      attempts: number;
      blockers: LockBlocker[];
      timedOut: boolean;
      /** The last exec rejection, for the updater's own failure formatter. */
      error: unknown;
      /** What the guard knows that the command output does not say. */
      note: string;
    };

/**
 * The migrate child's connection string: `lock_timeout` added to the server
 * `options` (keeping any the operator set) and our application_name. Pure.
 * Values are percent-encoded — Prisma's URL parser reads `+` as a space, and
 * so does URLSearchParams, so either encoding means the same thing.
 */
export function guardedMigrateUrl(url: string, lockTimeoutMs: number = MIGRATE_LOCK_TIMEOUT_MS): string {
  const q = url.indexOf("?");
  const base = q === -1 ? url : url.slice(0, q);
  const params = new URLSearchParams(q === -1 ? "" : url.slice(q + 1));
  const kept = (params.get("options") ?? "").replace(/-c\s*lock_timeout\s*=\s*\S+/g, "").replace(/\s+/g, " ").trim();
  const lockOpt = `-c lock_timeout=${Math.max(1, Math.round(lockTimeoutMs))}`;
  params.set("options", kept ? `${kept} ${lockOpt}` : lockOpt);
  params.set("application_name", MIGRATE_APPLICATION_NAME);
  const query = [...params].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `${base}?${query}`;
}

/** The migration a failed `migrate deploy` names, from P3018, P3009 or the
 *  "Applying migration" line before an unlabelled error. Pure. */
export function failedMigrationName(output: string): string | null {
  const named = /Migration name:\s*([0-9A-Za-z_.-]+)/.exec(output);
  if (named) return named[1];
  const p3009 = /The `([0-9A-Za-z_.-]+)` migration started at .* failed/.exec(output);
  if (p3009) return p3009[1];
  const applying = [...output.matchAll(/Applying migration `([0-9A-Za-z_.-]+)`/g)];
  return applying.length ? applying[applying.length - 1][1] : null;
}

/** Postgres's lock_timeout cancellation, as Prisma prints it. Pure. */
export function isLockTimeoutOutput(output: string): boolean {
  return /\b55P03\b|canceling statement due to lock timeout/i.test(output);
}

/** P3009: an earlier run left a failed migration recorded. Pure. */
export function isFailedMigrationRecorded(output: string): boolean {
  return /\bP3009\b/.test(output);
}

/**
 * True when a migration file runs as one transaction: its first statement is
 * BEGIN (or START TRANSACTION) and its last is COMMIT, comments and blank
 * lines aside. Only such a migration is safe to mark rolled back after a
 * failure — anything else may have committed the statements before the one
 * that failed. Pure.
 */
export function isTransactionWrapped(sql: string): boolean {
  const body = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  return /^(BEGIN|START\s+TRANSACTION)\s*;/i.test(body) && /;\s*COMMIT\s*;?$/i.test(body);
}

/** One line naming who held the lock, for the step card and the Event. Pure. */
export function describeBlockers(blockers: LockBlocker[]): string {
  if (!blockers.length) return "";
  const parts = blockers.slice(0, 3).map((b) => {
    const who = b.applicationName || "an unnamed session";
    const age = b.transactionSeconds != null ? `, transaction open ${Math.round(b.transactionSeconds)}s` : "";
    const q = b.query ? `, last statement: ${b.query}` : "";
    return `${who} (pid ${b.pid}, ${b.state || "unknown state"}${age}${q})`;
  });
  const more = blockers.length > 3 ? ` and ${blockers.length - 3} more` : "";
  return `waited on a lock held by ${parts.join("; ")}${more}`;
}

function outputOf(err: any): string {
  return `${err?.stdout ?? ""}\n${err?.stderr ?? ""}\n${err?.message ?? ""}`;
}

function isTimeoutKill(err: any): boolean {
  return err?.killed === true || err?.signal === "SIGTERM" || err?.code === "ETIMEDOUT";
}

function defaultReadMigrationSql(appDir: string) {
  return (name: string): string | null => {
    if (!/^[0-9A-Za-z_.-]+$/.test(name)) return null;
    const file = join(appDir, "prisma", "migrations", name, "migration.sql");
    try {
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    } catch {
      return null;
    }
  };
}

/**
 * A probe on its own pg.Client against the direct URL: pg_stat_activity seen
 * through PgBouncer is the pooler's view, not the server's. Connected lazily
 * and once; every failure is logged at debug and reads as "nothing seen".
 */
function createPgMigrateProbe(url: string = getDirectDatabaseUrl()): MigrateDbProbe {
  let client: pg.Client | null = null;
  let connecting: Promise<pg.Client | null> | null = null;
  const connect = (): Promise<pg.Client | null> => {
    if (client) return Promise.resolve(client);
    if (!connecting) {
      connecting = (async () => {
        if (!url) return null;
        const c = new pg.Client({ connectionString: url, application_name: "polaris-migrate-guard" });
        try {
          await c.connect();
          client = c;
          return c;
        } catch (err) {
          logger.debug({ err }, "migration guard: probe connection failed");
          connecting = null;
          return null;
        }
      })();
    }
    return connecting;
  };
  return {
    async blockers() {
      const c = await connect();
      if (!c) return [];
      try {
        const { rows } = await c.query(
          `SELECT b.pid, coalesce(b.application_name, '') AS app, coalesce(b.state, '') AS state,
                  extract(epoch FROM now() - b.xact_start)::float8 AS secs,
                  left(regexp_replace(coalesce(b.query, ''), '\\s+', ' ', 'g'), 160) AS query
             FROM pg_stat_activity w
             CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS bp(pid)
             JOIN pg_stat_activity b ON b.pid = bp.pid
            WHERE w.application_name = $1 AND w.wait_event_type = 'Lock'`,
          [MIGRATE_APPLICATION_NAME],
        );
        return rows.map((r: any) => ({
          pid: Number(r.pid),
          applicationName: String(r.app),
          state: String(r.state),
          transactionSeconds: r.secs == null ? null : Number(r.secs),
          query: String(r.query),
        }));
      } catch (err) {
        logger.debug({ err }, "migration guard: lock sample failed");
        return [];
      }
    },
    async terminate() {
      const c = await connect();
      if (!c) return 0;
      try {
        const { rows } = await c.query(
          `SELECT count(*) FILTER (WHERE pg_terminate_backend(pid))::int AS n
             FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()`,
          [MIGRATE_APPLICATION_NAME],
        );
        return Number(rows[0]?.n ?? 0);
      } catch (err) {
        logger.warn({ err }, "migration guard: could not terminate the migrate backend");
        return 0;
      }
    },
    async close() {
      const c = client;
      client = null;
      connecting = null;
      if (c) await c.end().catch(() => {});
    },
  };
}

/** Polls the probe while a migrate attempt runs; keeps the last non-empty sample. */
function startSampler(db: MigrateDbProbe) {
  let seen: LockBlocker[] = [];
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    db.blockers()
      .then((b) => {
        if (b.length) seen = b;
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, LOCK_SAMPLE_INTERVAL_MS);
  timer.unref?.();
  return {
    stop(): LockBlocker[] {
      clearInterval(timer);
      return seen;
    },
  };
}

/**
 * Run `prisma migrate deploy` under rule 197. Never throws: the result says
 * whether it succeeded, how many attempts it took, who held the lock if any,
 * and — on failure — the state the database was left in.
 */
export async function runGuardedMigrateDeploy(opts: GuardedMigrateOptions): Promise<GuardedMigrateResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const readSql = opts.readMigrationSql ?? defaultReadMigrationSql(opts.appDir);
  const lockTimeoutMs = opts.lockTimeoutMs ?? MIGRATE_LOCK_TIMEOUT_MS;
  const db = opts.db ?? createPgMigrateProbe();
  const env = { ...process.env, DATABASE_URL: guardedMigrateUrl(opts.databaseUrl ?? getDirectDatabaseUrl(), lockTimeoutMs) };
  const started = now();
  const remaining = () => opts.deadlineMs - (now() - started);

  let attempts = 0;
  let lockRetries = 0;
  let resolvedStale = false;
  let blockers: LockBlocker[] = [];
  let lastErr: unknown = null;

  const fail = (note: string, timedOut = false): GuardedMigrateResult => ({
    ok: false,
    attempts,
    blockers,
    timedOut,
    error: lastErr,
    note: [note, describeBlockers(blockers) && `The migration ${describeBlockers(blockers)}.`].filter(Boolean).join(" "),
  });

  /** Mark a wrapped migration rolled back. True when it worked. */
  const resolveRolledBack = async (name: string): Promise<boolean> => {
    try {
      await opts.exec(`${opts.prismaCli} migrate resolve --rolled-back ${name}`, {
        cwd: opts.appDir,
        timeout: 60_000,
        env,
      });
      return true;
    } catch (err) {
      logger.warn({ err, migration: name }, "migration guard: migrate resolve --rolled-back failed");
      return false;
    }
  };

  try {
    for (;;) {
      const left = remaining();
      if (left <= 0) {
        return fail(`Gave up after ${attempts} attempt(s): the step's time limit ran out while waiting for a lock.`, true);
      }
      attempts++;
      const sampler = startSampler(db);
      let seen: LockBlocker[] = [];
      try {
        await opts.exec(`${opts.prismaCli} migrate deploy`, { cwd: opts.appDir, timeout: left, env });
        seen = sampler.stop();
        if (seen.length) blockers = seen;
        const summary =
          attempts > 1
            ? `Applied on attempt ${attempts}${blockers.length ? ` (earlier attempts ${describeBlockers(blockers)})` : ""}.`
            : "";
        return { ok: true, attempts, blockers, summary };
      } catch (err: any) {
        seen = sampler.stop();
        if (seen.length) blockers = seen;
        lastErr = err;
        const out = outputOf(err);

        if (isTimeoutKill(err)) {
          const n = await db.terminate();
          return fail(
            n > 0
              ? `Its database session was still running and has been cancelled (${n} backend${n === 1 ? "" : "s"}), so it no longer holds or waits on locks. Re-running the update retries a migration that runs as one transaction; any other may be partly applied.`
              : "No database session of its was left running.",
            true,
          );
        }

        const name = failedMigrationName(out);
        const lockHit = isLockTimeoutOutput(out) || seen.length > 0;
        const stale = isFailedMigrationRecorded(out);
        if (!name || (!lockHit && !stale && !/current transaction is aborted/i.test(out))) {
          return fail("");
        }
        const sql = readSql(name);
        const wrapped = sql != null && isTransactionWrapped(sql);
        if (!wrapped) {
          return fail(
            lockHit
              ? `Migration ${name} could not get a lock within ${Math.round(lockTimeoutMs / 1000)}s and gave up rather than stall writes. It does not run as one transaction, so statements before the one that waited may already be applied: check the schema against the migration before marking it rolled back or applied.`
              : `Migration ${name} is recorded as failed by an earlier run, and it does not run as one transaction, so it may be partly applied: check the schema against the migration, then run \`prisma migrate resolve\` with --applied or --rolled-back.`,
          );
        }
        // A wrapped migration that failed is provably unapplied: mark it so,
        // whatever the cause, so the database is never left in P3009.
        if (!(await resolveRolledBack(name))) {
          return fail(`Migration ${name} rolled back, but marking it rolled back failed; run \`prisma migrate resolve --rolled-back ${name}\` before the next update.`);
        }
        if (stale && !lockHit && !resolvedStale) {
          // An earlier run's leftover: retry straight away, once.
          resolvedStale = true;
          opts.onProgress?.(`Migration ${name} was left failed by an earlier run; it runs as one transaction, so it was marked rolled back and is being applied again.`);
          continue;
        }
        if (!lockHit) {
          return fail(
            `Migration ${name} failed and rolled back as a whole (nothing from it was applied; it is marked rolled back). Prisma reports only that the transaction was aborted — PostgreSQL's log holds the statement's own error.`,
          );
        }
        const wait = RETRY_BACKOFF_MS[Math.min(lockRetries, RETRY_BACKOFF_MS.length - 1)];
        lockRetries++;
        if (remaining() <= wait) {
          return fail(
            `Migration ${name} could not get a lock within ${Math.round(lockTimeoutMs / 1000)}s on any of ${attempts} attempt(s); it rolled back each time and is marked rolled back, so re-running the update tries again.`,
            true,
          );
        }
        opts.onProgress?.(
          `Attempt ${attempts}: migration ${name} could not get a lock within ${Math.round(lockTimeoutMs / 1000)}s and rolled back` +
            (seen.length ? ` (${describeBlockers(seen)})` : "") +
            `. Retrying in ${Math.round(wait / 1000)}s.`,
        );
        logger.warn({ migration: name, attempt: attempts, blockers: seen }, "migration guard: lock timeout, retrying");
        await sleep(wait);
      }
    }
  } finally {
    await db.close();
  }
}
