/**
 * tests/unit/migrationGuardService.test.ts
 *
 * Business rule 197 — the updater's `prisma migrate deploy` fails fast on a
 * lock, retries only a migration that runs as one transaction, and cancels
 * its own database session on timeout. The Prisma output strings below are
 * the ones Prisma 7 printed against TimescaleDB pg17 on 2026-11-24, with an
 * open ROW EXCLUSIVE lock on `assets` in another session.
 */

import { describe, it, expect, vi } from "vitest";
import {
  guardedMigrateUrl,
  failedMigrationName,
  isLockTimeoutOutput,
  isFailedMigrationRecorded,
  isTransactionWrapped,
  describeBlockers,
  runGuardedMigrateDeploy,
  MIGRATE_APPLICATION_NAME,
  type MigrateDbProbe,
  type LockBlocker,
} from "../../src/services/migrationGuardService.js";

const NAME = "20261201000000_add_fk";

// An ordinary (unwrapped) migration whose FK statement hit lock_timeout.
const P3018_LOCK = `Applying migration \`${NAME}\`
Error: P3018

A migration failed to apply. New migrations cannot be applied before the error is recovered from.

Migration name: ${NAME}

Database error code: 55P03

Database error:
ERROR: canceling statement due to lock timeout`;

// A BEGIN/COMMIT-wrapped migration that hit lock_timeout: Prisma loses the cause.
const WRAPPED_ABORT = `Applying migration \`${NAME}\`
Error: ERROR: current transaction is aborted, commands ignored until end of transaction block
   0: schema_commands::commands::apply_migrations::Applying migration
           with migration_name="${NAME}"`;

const P3009 = `Error: P3009

migrate found failed migrations in the target database, new migrations will not be applied. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve
The \`${NAME}\` migration started at 2026-11-24 12:48:04.781772 UTC failed`;

const WRAPPED_SQL = `-- adds the FK\nBEGIN;\nCREATE TABLE "t" ("id" TEXT);\nALTER TABLE "t" ADD CONSTRAINT "fk" FOREIGN KEY ("id") REFERENCES "assets"("id");\nCOMMIT;\n`;
const PLAIN_SQL = `CREATE TABLE "t" ("id" TEXT);\nALTER TABLE "t" ADD CONSTRAINT "fk" FOREIGN KEY ("id") REFERENCES "assets"("id");\n`;

const BLOCKER: LockBlocker = {
  pid: 4242,
  applicationName: "polaris-monitor",
  state: "idle in transaction",
  transactionSeconds: 312.4,
  query: "UPDATE assets SET ...",
};

function execError(stderr: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error("Command failed"), { stdout: "", stderr }, extra);
}

function probe(over: Partial<MigrateDbProbe> = {}): MigrateDbProbe & { terminate: ReturnType<typeof vi.fn> } {
  return {
    blockers: vi.fn(async () => []),
    terminate: vi.fn(async () => 1),
    close: vi.fn(async () => {}),
    ...over,
  } as any;
}

/** Runs the guard with a scripted exec: each `migrate deploy` takes the next
 *  outcome (an Error rejects, anything else resolves). */
function run(outcomes: Array<Error | "ok">, opts: { sql?: string | null; db?: MigrateDbProbe; deadlineMs?: number } = {}) {
  const calls: string[] = [];
  const envs: string[] = [];
  let i = 0;
  let clock = 0;
  const exec = vi.fn(async (cmd: string, o?: Record<string, unknown>) => {
    calls.push(cmd);
    envs.push(String((o?.env as any)?.DATABASE_URL ?? ""));
    if (cmd.includes("migrate deploy")) {
      const next = outcomes[i++] ?? "ok";
      clock += 1_000;
      if (next instanceof Error) throw next;
    }
    return { stdout: "", stderr: "" };
  });
  const sleeps: number[] = [];
  const progress: string[] = [];
  const db = opts.db ?? probe();
  const result = runGuardedMigrateDeploy({
    exec,
    appDir: "/opt/polaris",
    prismaCli: "node prisma",
    deadlineMs: opts.deadlineMs ?? 300_000,
    databaseUrl: "postgresql://polaris:pw@db:5432/polaris?sslmode=require",
    db,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    readMigrationSql: () => (opts.sql === undefined ? WRAPPED_SQL : opts.sql),
    onProgress: (m) => progress.push(m),
  });
  return { result, calls, envs, sleeps, progress, db };
}

describe("guardedMigrateUrl", () => {
  it("adds lock_timeout and our application_name, percent-encoded", () => {
    const url = guardedMigrateUrl("postgresql://u:p@h:5432/db", 10_000);
    expect(url).toBe(
      `postgresql://u:p@h:5432/db?options=-c%20lock_timeout%3D10000&application_name=${MIGRATE_APPLICATION_NAME}`,
    );
  });

  it("keeps the operator's params and options, replacing only lock_timeout and application_name", () => {
    const url = guardedMigrateUrl(
      "postgresql://u:p@h/db?sslmode=require&options=-c%20search_path%3Dpolaris%20-c%20lock_timeout%3D0&application_name=x",
      5_000,
    );
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("sslmode")).toBe("require");
    expect(params.get("options")).toBe("-c search_path=polaris -c lock_timeout=5000");
    expect(params.get("application_name")).toBe(MIGRATE_APPLICATION_NAME);
  });

  it("leaves a socket-style URL's host parameter alone", () => {
    const url = guardedMigrateUrl("postgresql://polaris@/polaris?host=/run/postgresql");
    expect(new URLSearchParams(url.split("?")[1]).get("host")).toBe("/run/postgresql");
    expect(url.startsWith("postgresql://polaris@/polaris?")).toBe(true);
  });
});

describe("output parsing", () => {
  it("names the failed migration from P3018, P3009 and the bare Applying line", () => {
    expect(failedMigrationName(P3018_LOCK)).toBe(NAME);
    expect(failedMigrationName(P3009)).toBe(NAME);
    expect(failedMigrationName(WRAPPED_ABORT)).toBe(NAME);
    expect(failedMigrationName("Error: P1001 can't reach database")).toBeNull();
  });

  it("recognises a lock timeout and a recorded failure", () => {
    expect(isLockTimeoutOutput(P3018_LOCK)).toBe(true);
    expect(isLockTimeoutOutput(WRAPPED_ABORT)).toBe(false);
    expect(isFailedMigrationRecorded(P3009)).toBe(true);
    expect(isFailedMigrationRecorded(P3018_LOCK)).toBe(false);
  });

  it("isTransactionWrapped needs BEGIN first and COMMIT last, comments aside", () => {
    expect(isTransactionWrapped(WRAPPED_SQL)).toBe(true);
    expect(isTransactionWrapped("/* x */\nSTART TRANSACTION;\nSELECT 1;\ncommit\n-- end")).toBe(true);
    expect(isTransactionWrapped(PLAIN_SQL)).toBe(false);
    expect(isTransactionWrapped("BEGIN;\nSELECT 1;\n")).toBe(false);
    expect(isTransactionWrapped("SELECT 1;\nCOMMIT;")).toBe(false);
  });

  it("describeBlockers names the session, its state and its age", () => {
    expect(describeBlockers([])).toBe("");
    const text = describeBlockers([BLOCKER]);
    expect(text).toContain("polaris-monitor (pid 4242, idle in transaction, transaction open 312s");
  });
});

describe("runGuardedMigrateDeploy", () => {
  it("runs once on the guarded URL when nothing blocks", async () => {
    const { result, calls, envs } = run(["ok"]);
    const r = await result;
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
    expect(calls).toEqual(["node prisma migrate deploy"]);
    expect(envs[0]).toContain("lock_timeout%3D10000");
    expect(envs[0]).toContain("sslmode=require");
  });

  it("a wrapped migration's lock wait is seen by the sampler (Prisma's output does not say 55P03), then retried", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const blockers = vi.fn(async () => (n === 1 ? [BLOCKER] : []));
      const db = probe({ blockers });
      const calls: string[] = [];
      const sleeps: number[] = [];
      const exec = vi.fn(async (cmd: string) => {
        calls.push(cmd);
        if (!cmd.includes("migrate deploy")) return { stdout: "", stderr: "" };
        n++;
        // The attempt runs for 3 s of (fake) time, long enough to be sampled.
        await new Promise((r) => setTimeout(r, 3_000));
        if (n === 1) throw execError(WRAPPED_ABORT);
        return { stdout: "", stderr: "" };
      });
      const promise = runGuardedMigrateDeploy({
        exec,
        appDir: "/opt/polaris",
        prismaCli: "node prisma",
        deadlineMs: 300_000,
        databaseUrl: "postgresql://u:p@h/db",
        db,
        sleep: async (ms) => { sleeps.push(ms); },
        readMigrationSql: () => WRAPPED_SQL,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const r = await promise;
      expect(r.ok).toBe(true);
      expect(calls).toEqual([
        "node prisma migrate deploy",
        `node prisma migrate resolve --rolled-back ${NAME}`,
        "node prisma migrate deploy",
      ]);
      expect(sleeps).toEqual([15_000]);
      expect(r.blockers).toEqual([BLOCKER]);
      if (r.ok) expect(r.summary).toContain("polaris-monitor (pid 4242");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries on an explicit 55P03 and records who held the lock", async () => {
    // A wrapped file whose failure output still carries 55P03 (e.g. a single-statement migration).
    const { result, calls, sleeps, progress } = run([execError(P3018_LOCK), execError(P3018_LOCK), "ok"]);
    const r = await result;
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
    expect(calls).toEqual([
      "node prisma migrate deploy",
      `node prisma migrate resolve --rolled-back ${NAME}`,
      "node prisma migrate deploy",
      `node prisma migrate resolve --rolled-back ${NAME}`,
      "node prisma migrate deploy",
    ]);
    expect(sleeps).toEqual([15_000, 30_000]);
    expect(progress[0]).toMatch(/Attempt 1: migration .* could not get a lock within 10s and rolled back\. Retrying in 15s/);
    if (r.ok) expect(r.summary).toContain("Applied on attempt 3");
  });

  it("never retries an ordinary migration: it may be half-applied", async () => {
    const { result, calls } = run([execError(P3018_LOCK)], { sql: PLAIN_SQL });
    const r = await result;
    expect(r.ok).toBe(false);
    expect(calls).toEqual(["node prisma migrate deploy"]);
    if (!r.ok) {
      expect(r.timedOut).toBe(false);
      expect(r.note).toContain("does not run as one transaction");
      expect(r.note).toContain("may already be applied");
    }
  });

  it("gives up when the deadline cannot fit another back-off, leaving the migration marked rolled back", async () => {
    const outcomes = Array.from({ length: 20 }, () => execError(P3018_LOCK));
    const { result, calls } = run(outcomes, { deadlineMs: 60_000 });
    const r = await result;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.timedOut).toBe(true);
      expect(r.note).toContain("re-running the update tries again");
    }
    // Every failed attempt was followed by its resolve.
    const deploys = calls.filter((c) => c.endsWith("migrate deploy")).length;
    const resolves = calls.filter((c) => c.includes("--rolled-back")).length;
    expect(resolves).toBe(deploys);
  });

  it("clears an earlier run's failed wrapped migration (P3009) and applies it straight away", async () => {
    const { result, calls, sleeps } = run([execError(P3009), "ok"]);
    const r = await result;
    expect(r.ok).toBe(true);
    expect(calls).toEqual([
      "node prisma migrate deploy",
      `node prisma migrate resolve --rolled-back ${NAME}`,
      "node prisma migrate deploy",
    ]);
    expect(sleeps).toEqual([]);
  });

  it("leaves an earlier run's failed ordinary migration for the operator", async () => {
    const { result, calls } = run([execError(P3009)], { sql: PLAIN_SQL });
    const r = await result;
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(1);
    if (!r.ok) expect(r.note).toContain("may be partly applied");
  });

  it("a wrapped migration's real SQL error is not retried, but it is marked rolled back", async () => {
    const { result, calls } = run([execError(WRAPPED_ABORT)]);
    const r = await result;
    expect(r.ok).toBe(false);
    expect(calls).toEqual(["node prisma migrate deploy", `node prisma migrate resolve --rolled-back ${NAME}`]);
    if (!r.ok) expect(r.note).toContain("PostgreSQL's log");
  });

  it("an unrelated failure passes straight through", async () => {
    const { result, calls } = run([execError("Error: P1001: Can't reach database server")]);
    const r = await result;
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(1);
    if (!r.ok) expect(r.note).toBe("");
  });

  it("on the exec timeout, terminates the backend the killed CLI left behind", async () => {
    const db = probe();
    const { result } = run([execError("", { killed: true, signal: "SIGTERM" })], { db });
    const r = await result;
    expect(r.ok).toBe(false);
    expect(db.terminate).toHaveBeenCalledTimes(1);
    if (!r.ok) {
      expect(r.timedOut).toBe(true);
      expect(r.note).toContain("has been cancelled (1 backend)");
    }
  });

  it("closes the probe whatever happens", async () => {
    const db = probe();
    await run(["ok"], { db }).result;
    expect(db.close).toHaveBeenCalledTimes(1);
  });
});
