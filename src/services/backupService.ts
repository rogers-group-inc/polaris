/**
 * src/services/backupService.ts — database backup + restore.
 *
 * Extracted from src/api/routes/serverSettings.ts (2026-08). The route layer is
 * now thin: validate, call, respond. Three defects drove the extraction, all of
 * which only showed up at production database size:
 *
 *  1. NOT TIMESCALE-AWARE. Every documented production install enables
 *     TimescaleDB, and restore piped a plain dump straight into
 *     `psql --single-transaction` with no `timescaledb_pre_restore()` /
 *     `timescaledb_post_restore()` around it. Without that pair, hypertable
 *     catalog rows and chunk metadata restore in the wrong order, and the
 *     restore either aborts or leaves hypertables whose chunks are invisible.
 *     The backup you could take was not one you could rely on restoring.
 *  2. SYNCHRONOUS AND FULLY IN MEMORY. Backup ran `execSync(pg_dump ...)` —
 *     blocking the web role's single event loop for the whole dump — then
 *     `readFileSync` + `gzipSync` + an in-memory cipher + `res.end(payload)`,
 *     putting three copies of a multi-gigabyte dump in the heap, under a hard
 *     120 s pg_dump timeout that a 50 GB database blows straight through.
 *  3. CREDENTIAL IN ARGV. The connection URL (password and all) was
 *     interpolated into a shell command, so it was visible in `ps` and, when
 *     stderr came back empty, Node's `Command failed: <command>` message was
 *     returned to the HTTP caller verbatim.
 *
 * Now: `spawn` with an argv array and libpq PG* env vars (see utils/pgEnv.ts),
 * streamed pg_dump → gzip → optional AES-256-GCM cipher → file, a no-output
 * watchdog instead of a fixed wall-clock cap, and a restore wrapped in the
 * documented Timescale sequence with `post_restore` in a finally block so a
 * failed restore can never leave the database stuck in restoring mode.
 *
 * File format (unchanged, so pre-existing backups still restore):
 *   unencrypted: gzip(sql)
 *   encrypted:   "POLARIS\0" | salt(32) | iv(16) | authTag(16) | gzip(sql) ciphertext
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGzip, createGunzip } from "node:zlib";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { resolve, sep } from "node:path";
import { join } from "node:path";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { BACKUP_DIR } from "../utils/paths.js";
import { getAppVersion } from "../utils/version.js";
import { getDirectDatabaseUrl } from "../utils/dbConnections.js";
import { pgChildEnv } from "../utils/pgEnv.js";
import {
  type PgTool,
  parsePgToolMajor,
  pgMajorFromServerVersion,
  resolvePgToolPath,
  pgClientCompatible,
  describePgClientMismatch,
} from "../utils/pgClientTools.js";

const execFileAsync = promisify(execFile);

// ─── Format constants ──────────────────────────────────────────────────────

/** Magic header identifying an encrypted Polaris backup. */
export const BACKUP_MAGIC = Buffer.from("POLARIS\0");
const SALT_LEN = 32;
const IV_LEN = 16;
const TAG_LEN = 16;
/** Byte offset where the gzip ciphertext starts in an encrypted backup. */
export const ENCRYPTED_HEADER_LEN = BACKUP_MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN; // 72

/**
 * Kill a pg_dump / psql child that has produced no output for this long.
 *
 * Replaces the old fixed 120 s cap, which failed a healthy dump the moment the
 * database outgrew two minutes. A dump that is still streaming bytes is making
 * progress no matter how long it takes; one that has gone silent is wedged.
 */
const NO_OUTPUT_TIMEOUT_MS = 10 * 60 * 1000;

/** How many history entries the Setting row retains. */
const HISTORY_LIMIT = 50;

export type BackupKind = "manual" | "pre-update" | "scheduled";

export interface BackupRecord {
  id: string;
  filename: string;
  size: number;
  encrypted: boolean;
  createdAt: string;
  /** Legacy flag kept for the Maintenance tab's "pre-update" badge. */
  preUpdate?: boolean;
  kind?: BackupKind;
}

// ─── Path safety ───────────────────────────────────────────────────────────

/**
 * Resolve a backup id to its on-disk path, refusing anything that escapes
 * BACKUP_DIR. Ids are server-generated (`bk-<ts>`) but the delete/download
 * routes accept them from the URL, so containment is checked before any
 * filesystem access. Returns null for a traversal attempt.
 */
export function backupFilePath(id: unknown): string | null {
  const p = resolve(BACKUP_DIR, String(id));
  return p.startsWith(BACKUP_DIR + sep) ? p : null;
}

/** Same, but throws the operator-facing 400 instead of returning null. */
function requireBackupPath(id: unknown): string {
  const p = backupFilePath(id);
  if (!p) throw new AppError(400, "Invalid backup id");
  return p;
}

// ─── History (Setting row) ─────────────────────────────────────────────────

async function readHistory(): Promise<BackupRecord[]> {
  const row = await prisma.setting.findUnique({ where: { key: "backup_history" } });
  return row?.value && Array.isArray(row.value) ? (row.value as unknown as BackupRecord[]) : [];
}

async function writeHistory(history: BackupRecord[]): Promise<void> {
  await prisma.setting.upsert({
    where: { key: "backup_history" },
    update: { value: history as never },
    create: { key: "backup_history", value: history as never },
  });
}

/** Newest-first history, each entry carrying its resolved on-disk path. */
export async function listBackups(): Promise<Array<BackupRecord & { path: string | null }>> {
  const history = await readHistory();
  return history.map((r) => ({ ...r, path: backupFilePath(r.id) })).reverse();
}

export async function getBackupRecord(id: string): Promise<BackupRecord | null> {
  const history = await readHistory();
  return history.find((r) => r.id === id) ?? null;
}

async function appendHistory(record: BackupRecord): Promise<void> {
  const history = await readHistory();
  history.push(record);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  await writeHistory(history);
}

/** Delete a backup's file and its history entry. Throws 404 when unknown. */
export async function deleteBackup(id: string, actor?: string): Promise<BackupRecord> {
  const safePath = requireBackupPath(id);
  const history = await readHistory();
  const idx = history.findIndex((r) => r.id === id);
  if (idx === -1) throw new AppError(404, "Backup not found");

  const [removed] = history.splice(idx, 1);
  await writeHistory(history);
  if (existsSync(safePath)) unlinkSync(safePath);

  await logEvent({
    level: "warning",
    action: "server.backup.deleted",
    resourceType: "backup",
    resourceId: id,
    resourceName: removed?.filename || id,
    actor,
    message: `Database backup deleted: ${removed?.filename || id}`,
  });
  return removed!;
}

// ─── Child-process plumbing ────────────────────────────────────────────────

interface ChildResult {
  stderr: string;
}

/**
 * Spawn a Postgres client tool with the connection supplied through PG* env
 * vars (never argv) and a no-output watchdog.
 *
 * `onStdout` receives the child's stdout stream for the caller to pipe. The
 * returned promise settles when the process exits: resolved on code 0, rejected
 * with the tail of stderr otherwise. stderr is captured but NEVER surfaced to an
 * HTTP caller verbatim by the callers in this file — see the AppError messages
 * below, which log the detail and return a fixed string.
 */
function runPgTool(
  bin: PgTool,
  args: string[],
  opts: { connUrl: string; binPath?: string; onStdout?: (stdout: NodeJS.ReadableStream) => void; stdinFrom?: NodeJS.ReadableStream },
): { child: ReturnType<typeof spawn>; done: Promise<ChildResult> } {
  // binPath is resolvePgTool()'s answer — a per-major install dir, or the bare
  // name when nothing versioned exists. Spawning the bare name unverified is
  // the trust-PATH behaviour that failed prod on 2026-09-09 (a PostgreSQL 13
  // pg_dump in front of a 15 server), so callers go through the resolver first.
  const child = spawn(opts.binPath ?? bin, args, {
    env: pgChildEnv(opts.connUrl),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  let lastOutputAt = Date.now();
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    lastOutputAt = Date.now();
  });
  child.stdout?.on("data", () => { lastOutputAt = Date.now(); });

  // Progress-based watchdog rather than a total-duration cap: a dump that is
  // still emitting bytes is healthy however long it runs.
  let timedOut = false;
  const watchdog = setInterval(() => {
    if (Date.now() - lastOutputAt > NO_OUTPUT_TIMEOUT_MS) {
      timedOut = true;
      child.kill("SIGKILL");
    }
  }, 30_000);
  watchdog.unref();

  const done = new Promise<ChildResult>((resolvePromise, reject) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearInterval(watchdog);
      if (err.code === "ENOENT") {
        reject(new AppError(500, `${bin} was not found on this host — install the PostgreSQL client tools`));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      clearInterval(watchdog);
      if (code === 0) {
        resolvePromise({ stderr });
        return;
      }
      if (timedOut) {
        reject(new Error(`${bin} produced no output for ${Math.round(NO_OUTPUT_TIMEOUT_MS / 60000)} minutes and was killed`));
        return;
      }
      reject(new Error(`${bin} exited with code ${code}: ${stderr.trim().slice(-2000) || "no stderr"}`));
    });
  });

  if (opts.onStdout && child.stdout) opts.onStdout(child.stdout);
  if (opts.stdinFrom && child.stdin) opts.stdinFrom.pipe(child.stdin);
  return { child, done };
}

/** Run one short `psql -c "<sql>"` statement. Used for the Timescale gates. */
async function psqlCommand(connUrl: string, sql: string, binPath?: string): Promise<void> {
  const { done } = runPgTool("psql", ["--no-psqlrc", "--quiet", "-v", "ON_ERROR_STOP=1", "-c", sql], { connUrl, binPath });
  await done;
}

// ─── Client tool resolution ────────────────────────────────────────────────

export interface PgToolResolution {
  tool: PgTool;
  /** What will be spawned. */
  path: string;
  /** "versioned-dir" = found under a per-major install dir; "path" = the bare name, whatever PATH gives. */
  source: "versioned-dir" | "path";
  clientMajor: number | null;
  serverMajor: number | null;
  /** False when the client cannot work against this server, or could not be run at all. */
  compatible: boolean;
  /** The operator-facing explanation when !compatible. */
  problem: string | null;
}

async function readServerMajor(): Promise<number | null> {
  try {
    // A GUC read, like platformLifecycleService's SHOW server_version.
    const rows = await prisma.$queryRawUnsafe<{ server_version_num: string }[]>("SHOW server_version_num");
    return pgMajorFromServerVersion(rows[0]?.server_version_num);
  } catch (err) {
    logger.warn({ err }, "backup: could not read server_version_num; taking the newest versioned client install, then PATH");
    return null;
  }
}

/**
 * Which `pg_dump` / `psql` to run, and whether it can talk to this server.
 *
 * Resolution is by the server's MAJOR through src/utils/pgClientTools.ts —
 * /usr/pgsql-<N>/bin, /usr/lib/postgresql/<N>/bin, the Windows install dir,
 * newer majors accepted — with PATH as the last resort. Then `--version` is run
 * on whatever was chosen, because the choice is only as good as the file behind
 * it: on 2026-09-09 prod's /usr/bin/pg_dump was a PostgreSQL 13 binary that
 * `alternatives` swore was 15, and every backup on the host failed with a
 * message the operator only ever saw as "see the server log". pg_dump refuses a
 * server newer than itself; psql only warns, so for psql `compatible` is false
 * only when it cannot be run at all.
 */
export async function resolvePgTool(tool: PgTool): Promise<PgToolResolution> {
  const serverMajor = await readServerMajor();
  const { path, source } = resolvePgToolPath(tool, serverMajor, existsSync);

  let clientMajor: number | null = null;
  let problem: string | null = null;
  try {
    const { stdout } = await execFileAsync(path, ["--version"], { timeout: 10_000, windowsHide: true });
    clientMajor = parsePgToolMajor(stdout);
    if (clientMajor == null) {
      problem = `${tool} --version returned something unrecognisable: ${String(stdout).trim().slice(0, 120) || "no output"}`;
    }
  } catch (err: any) {
    problem = err?.code === "ENOENT"
      ? `${tool} was not found on this host (looked for a PostgreSQL ${serverMajor ?? "?"} install and on PATH) — install the PostgreSQL client tools`
      : `${tool} --version failed: ${err?.message ?? String(err)}`;
  }
  if (problem == null && clientMajor != null && serverMajor != null && !pgClientCompatible(tool, clientMajor, serverMajor)) {
    problem = describePgClientMismatch(tool, clientMajor, serverMajor, path);
  }
  return { tool, path, source, clientMajor, serverMajor, compatible: problem == null, problem };
}

/**
 * For the Maintenance tab: can this host back itself up right now? Cheap — two
 * `--version` spawns and one GUC read — so it is safe to render on every load.
 * This is the check that would have said "your pg_dump is 13, your server is
 * 15" on the day it started being true, instead of on the day someone needed a
 * backup.
 */
export async function getBackupToolingStatus(): Promise<{ ok: boolean; pgDump: PgToolResolution; psql: PgToolResolution }> {
  const [pgDump, psql] = await Promise.all([resolvePgTool("pg_dump"), resolvePgTool("psql")]);
  return { ok: pgDump.compatible && psql.compatible, pgDump, psql };
}

// ─── Timescale awareness ───────────────────────────────────────────────────

/**
 * Is the timescaledb extension installed in the target database?
 *
 * Asked over Prisma rather than reusing timescaleService's boot-time cache, so
 * a restore is never gated on cache warm-up and so the answer describes the
 * database this restore is about to touch.
 */
export async function timescaleInstalled(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM pg_extension WHERE extname = 'timescaledb'
    `;
    return rows.length > 0;
  } catch (err) {
    logger.warn({ err }, "backup: could not determine whether timescaledb is installed; assuming it is");
    // Fail toward doing the pre/post dance: running it on a database WITHOUT
    // the extension is a clean error we can detect and ignore, whereas skipping
    // it on a database WITH the extension corrupts the restore.
    return true;
  }
}

// ─── Create ────────────────────────────────────────────────────────────────

export interface CreateBackupInput {
  /** Validated passphrase, or null for an unencrypted backup. */
  password: string | null;
  kind: BackupKind;
  actor?: string;
}

export interface CreateBackupResult {
  record: BackupRecord;
  path: string;
}

/**
 * Stream a full logical backup to data/backups/ and register it in history.
 *
 * Nothing is buffered: pg_dump's stdout goes through gzip (and the cipher, when
 * encrypting) straight to disk. Peak memory is a few stream watermarks
 * regardless of database size, and the event loop is never blocked.
 */
export async function createBackup(input: CreateBackupInput): Promise<CreateBackupResult> {
  const connUrl = getDirectDatabaseUrl();
  mkdirSync(BACKUP_DIR, { recursive: true });

  // Resolve and verify the client FIRST. When it cannot work, that specific
  // sentence is the error — not "see the server log", which is what hid a
  // 13-vs-15 mismatch on prod for months.
  const pgDump = await resolvePgTool("pg_dump");
  if (!pgDump.compatible) {
    logger.error({ pgDump }, "Database backup refused: pg_dump cannot work against this server");
    throw new AppError(500, pgDump.problem!);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const prefix = input.kind === "pre-update" ? "polaris-pre-update" : "polaris-backup";
  const idPrefix = input.kind === "pre-update" ? "bk-pre-update" : input.kind === "scheduled" ? "bk-scheduled" : "bk";
  const backupId = `${idPrefix}-${Date.now()}`;
  const encrypted = !!input.password;
  const filename = `${prefix}-${getAppVersion()}-${ts}${encrypted ? ".enc" : ""}.gz`;
  const backupFile = join(BACKUP_DIR, backupId);

  const { child, done } = runPgTool(
    "pg_dump",
    ["--no-owner", "--no-acl", "--clean", "--if-exists"],
    { connUrl, binPath: pgDump.path },
  );

  try {
    if (encrypted) {
      // Stream pg_dump → gzip → AES-256-GCM → temp ciphertext file, then write
      // the final file as [magic][salt][iv][authTag][ciphertext]. The auth tag
      // is only available once the cipher has finished, so the ciphertext is
      // staged separately rather than reserving and back-patching bytes.
      const salt = randomBytes(SALT_LEN);
      const iv = randomBytes(IV_LEN);
      const key = scryptSync(input.password!, salt, 32);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertextFile = `${backupFile}.tmp-ct`;

      try {
        await Promise.all([
          pipeline(child.stdout!, createGzip(), cipher, createWriteStream(ciphertextFile)),
          done,
        ]);
        const header = Buffer.concat([BACKUP_MAGIC, salt, iv, cipher.getAuthTag()]);
        const out = createWriteStream(backupFile);
        await new Promise<void>((res, rej) => out.write(header, (err) => (err ? rej(err) : res())));
        await pipeline(createReadStream(ciphertextFile), out);
      } finally {
        if (existsSync(ciphertextFile)) { try { unlinkSync(ciphertextFile); } catch { /* best effort */ } }
      }
    } else {
      await Promise.all([
        pipeline(child.stdout!, createGzip(), createWriteStream(backupFile)),
        done,
      ]);
    }
  } catch (err: any) {
    // Never leave a truncated file behind masquerading as a usable backup.
    if (existsSync(backupFile)) { try { unlinkSync(backupFile); } catch { /* best effort */ } }
    logger.error({ err: err?.message, backupId }, "Database backup failed");
    if (err instanceof AppError) throw err;
    throw new AppError(500, "Database backup failed — see the server log for details");
  }

  // statSync, not readFileSync().length: sizing must not pull the whole file
  // back into the heap.
  const size = existsSync(backupFile) ? statSync(backupFile).size : 0;
  const record: BackupRecord = {
    id: backupId,
    filename,
    size,
    encrypted,
    createdAt: new Date().toISOString(),
    kind: input.kind,
    ...(input.kind === "pre-update" ? { preUpdate: true } : {}),
  };

  try {
    await appendHistory(record);
  } catch (dbErr) {
    // The file is on disk and valid; only the index entry failed. Surface it,
    // but do not fail the backup.
    logger.warn({ err: dbErr, backupId }, "Backup created but failed to register in backup_history");
  }

  await logEvent({
    level: "info",
    action: "server.backup.created",
    resourceType: "backup",
    resourceId: backupId,
    resourceName: filename,
    actor: input.actor,
    message: `Database backup created: ${filename} (${size} bytes${encrypted ? ", encrypted" : ""}, ${input.kind})`,
    details: { kind: input.kind, size, encrypted, pgDump: pgDump.path, pgDumpMajor: pgDump.clientMajor },
  });

  return { record, path: backupFile };
}

// ─── Restore ───────────────────────────────────────────────────────────────

/** Does this file start with the encrypted-backup magic header? */
export function isEncryptedBackupFile(filePath: string): boolean {
  const size = statSync(filePath).size;
  if (size <= ENCRYPTED_HEADER_LEN) return false;
  const header = Buffer.alloc(BACKUP_MAGIC.length);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, header, 0, BACKUP_MAGIC.length, 0);
  } finally {
    closeSync(fd);
  }
  return header.equals(BACKUP_MAGIC);
}

export interface RestoreBackupInput {
  /** Path to the uploaded backup file. Caller owns cleanup. */
  filePath: string;
  /** Passphrase, required when the file is encrypted. */
  password?: string | null;
}

/**
 * Restore a backup into the current database.
 *
 * Timescale sequence (the OPS-01 fix). On a database with the timescaledb
 * extension the documented procedure is three SEPARATE sessions:
 *
 *   psql -c 'SELECT timescaledb_pre_restore();'   -- sets timescaledb.restoring
 *   psql -f dump.sql                              -- the actual restore
 *   psql -c 'SELECT timescaledb_post_restore();'  -- clears it, rebuilds catalog
 *
 * They must be separate connections: pre_restore sets the flag at database
 * level and it only takes effect for sessions started afterwards. post_restore
 * runs in a `finally` — leaving a database in restoring mode after a failed
 * restore would break normal operation far worse than the failed restore itself.
 */
export async function restoreBackup(input: RestoreBackupInput): Promise<void> {
  const connUrl = getDirectDatabaseUrl();
  if (!existsSync(input.filePath)) throw new AppError(400, "Backup file not found");

  const encrypted = isEncryptedBackupFile(input.filePath);
  if (encrypted && !input.password) {
    throw new AppError(400, "This backup is encrypted — a password is required to restore it");
  }

  const useTimescaleGates = await timescaleInstalled();

  // psql restores across majors (it only warns), so only "cannot run it" is
  // fatal; a major behind the server is logged and the restore proceeds.
  const psql = await resolvePgTool("psql");
  if (!psql.compatible) throw new AppError(500, psql.problem!);
  if (psql.clientMajor != null && psql.serverMajor != null && psql.clientMajor < psql.serverMajor) {
    logger.warn({ psql: psql.path, clientMajor: psql.clientMajor, serverMajor: psql.serverMajor }, "restore: psql is older than the server; continuing");
  }

  // Decrypt to a temp gzip file when needed. The cipher is a stream transform,
  // so this stays O(1) in memory even for a multi-gigabyte backup — the old
  // implementation readFileSync'd the whole ciphertext.
  let gzipSourcePath = input.filePath;
  let decryptedTempPath: string | null = null;

  if (encrypted) {
    const fd = openSync(input.filePath, "r");
    const header = Buffer.alloc(ENCRYPTED_HEADER_LEN);
    try {
      readSync(fd, header, 0, ENCRYPTED_HEADER_LEN, 0);
    } finally {
      closeSync(fd);
    }
    const salt = header.subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + SALT_LEN);
    const iv = header.subarray(BACKUP_MAGIC.length + SALT_LEN, BACKUP_MAGIC.length + SALT_LEN + IV_LEN);
    const authTag = header.subarray(BACKUP_MAGIC.length + SALT_LEN + IV_LEN, ENCRYPTED_HEADER_LEN);

    const key = scryptSync(input.password!, salt, 32);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);

    decryptedTempPath = join(BACKUP_DIR, `.restore-dec-${Date.now()}.gz`);
    try {
      await pipeline(
        createReadStream(input.filePath, { start: ENCRYPTED_HEADER_LEN }),
        decipher,
        createWriteStream(decryptedTempPath),
      );
    } catch {
      if (existsSync(decryptedTempPath)) { try { unlinkSync(decryptedTempPath); } catch { /* best effort */ } }
      // GCM verification fails at final() with an opaque error; both causes look
      // the same to us and to the operator.
      throw new AppError(400, "Decryption failed — incorrect password or corrupted file");
    }
    gzipSourcePath = decryptedTempPath;
  }

  try {
    if (useTimescaleGates) {
      try {
        await psqlCommand(connUrl, "SELECT timescaledb_pre_restore();", psql.path);
      } catch (err: any) {
        // timescaleInstalled() fails toward true, so a database without the
        // extension lands here. That is benign: proceed with a plain restore.
        logger.warn({ err: err?.message }, "timescaledb_pre_restore() failed; continuing with a plain restore");
      }
    }

    try {
      const { child, done } = runPgTool(
        "psql",
        ["--no-psqlrc", "--quiet", "--single-transaction", "-v", "ON_ERROR_STOP=1"],
        { connUrl, binPath: psql.path },
      );
      // gzip file → gunzip → psql stdin. No decompressed-size cap: a restore is
      // an explicit operator action on a file they supplied, and capping it
      // would cap the size of database Polaris can recover.
      await Promise.all([
        pipeline(createReadStream(gzipSourcePath), createGunzip(), child.stdin!),
        done,
      ]);
    } catch (err: any) {
      logger.error({ err: err?.message }, "Database restore failed");
      if (err instanceof AppError) throw err;
      throw new AppError(500, "Restore failed — see the server log for details");
    }
  } finally {
    if (useTimescaleGates) {
      // MUST run even on failure: a database left with timescaledb.restoring on
      // rejects normal hypertable writes.
      try {
        await psqlCommand(connUrl, "SELECT timescaledb_post_restore();", psql.path);
      } catch (err: any) {
        logger.error(
          { err: err?.message },
          "timescaledb_post_restore() FAILED — the database may be stuck in restoring mode. Run `SELECT timescaledb_post_restore();` manually before using Polaris.",
        );
      }
    }

    // Recycle the connection pool. `--clean --if-exists` DROPs and recreates
    // every table, so every connection opened before the restore is holding
    // cached relation OIDs that no longer exist; its next query fails with
    // `XX000 could not open relation with OID <n>`. Without this the restore
    // route returns `{ ok: true }` and the app then throws that error on
    // arbitrary queries until the pool happens to churn.
    //
    // In the finally block, not the success path: a restore that failed partway
    // through `--single-transaction` rolls back, but a psql failure AFTER the
    // commit (or the Timescale gate above) leaves the same stale-OID situation.
    // Disconnect is cheap and Prisma reconnects lazily on the next query.
    //
    // This is a mitigation, not a cure: a dump from a different schema version
    // also leaves the running process with a stale generated client, which no
    // amount of reconnecting fixes. The route tells the operator to restart.
    try {
      await prisma.$disconnect();
    } catch (err: any) {
      logger.warn(
        { err: err?.message },
        "Could not recycle the Prisma connection pool after the restore — restart Polaris before using it.",
      );
    }

    if (decryptedTempPath && existsSync(decryptedTempPath)) {
      try { unlinkSync(decryptedTempPath); } catch { /* best effort */ }
    }
  }
}
