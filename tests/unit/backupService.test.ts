/**
 * tests/unit/backupService.test.ts — the own suite for
 * src/services/backupService.ts (CQ-T010; business rules 20(c), 47, 51, 117,
 * 158(a)).
 *
 * Complements backupEnvelope (the byte layout), backupToolResolution (the prod
 * 13-vs-15 refusal), backupUntracked (rule 158(a) listing) and the integration
 * round trip through real pg_dump / psql. This one drives createBackup and
 * restoreBackup end to end against a FAKE child process — never a real
 * pg_dump / psql — with real files in a temp dir standing in for BACKUP_DIR:
 *
 *   - createBackup: refuses an incompatible pg_dump with its sentence; argv
 *     carries no credential (PG* env instead, sslmode translated — rule 51);
 *     plain = gzip(dump), encrypted = "POLARIS\0"|salt|iv|tag|ciphertext that
 *     decrypts; ids / filenames per kind; history append + cap; a failed
 *     history write does not fail the backup; the Event; a failing / missing
 *     pg_dump leaves no file and returns a fixed message (no stderr leak);
 *     the no-output watchdog kills a wedged dump and spares a chatty one;
 *   - restoreBackup: the Timescale pre/post sequence in separate sessions,
 *     post_restore + pool recycle even on failure, pre_restore failure benign,
 *     encrypted restore needs the password, a wrong one is a 400 with no temp
 *     file left, the legacy SHELOB1 magic is not recognised;
 *   - isEncryptedBackupFile, backupFilePath, deleteBackup, list / get,
 *     timescaleInstalled, resolvePgTool's remaining branches.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { gzipSync, gunzipSync } from "node:zlib";
import { createDecipheriv, scryptSync } from "node:crypto";
import { writeFileSync, readFileSync, readdirSync, rmSync, existsSync, mkdtempSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dirs = await vi.hoisted(async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), "polaris-bksvc-")) };
});

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  toolPath: vi.fn(),
  url: "postgresql://polaris:s3cret@db.example.test:5432/polaris",
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../src/utils/paths.js", () => ({ BACKUP_DIR: dirs.root, STATE_DIR: dirs.root }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/utils/logger.js", () => ({ logger: h.logger }));
vi.mock("../../src/utils/version.js", () => ({ getAppVersion: () => "0.10.77" }));
vi.mock("../../src/utils/dbConnections.js", () => ({ getDirectDatabaseUrl: () => h.url }));
vi.mock("../../src/utils/pgClientTools.js", async (orig) => {
  const real = await orig<typeof import("../../src/utils/pgClientTools.js")>();
  return { ...real, resolvePgToolPath: h.toolPath };
});
// execFile is promisified at module load; give the mock the same
// promisify.custom the real one has so `{ stdout, stderr }` survives.
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile: any = (...a: any[]) => h.execFile(...a);
  execFile[promisify.custom] = (file: string, args: string[], opts: unknown) =>
    new Promise((res, rej) => h.execFile(file, args, opts, (err: any, stdout: string, stderr: string) => (err ? rej(err) : res({ stdout, stderr }))));
  return { ...real, spawn: (...a: any[]) => h.spawn(...a), execFile };
});

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import {
  BACKUP_MAGIC,
  ENCRYPTED_HEADER_LEN,
  backupFilePath,
  listBackups,
  getBackupRecord,
  deleteBackup,
  resolvePgTool,
  getBackupToolingStatus,
  timescaleInstalled,
  createBackup,
  isEncryptedBackupFile,
  restoreBackup,
} from "../../src/services/backupService.js";

// ─── the fake child process ─────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  input = "";
  kill = vi.fn((_sig?: string) => {
    setImmediate(() => this.emit("close", null));
    return true;
  });
  constructor(public bin: string, public args: string[], public env: NodeJS.ProcessEnv) {
    super();
  }
}

type Behaviour = (c: FakeChild) => void;
const DUMP = "-- polaris dump\nCREATE TABLE t (id text);\nINSERT INTO t VALUES ('x');\n";
let spawned: FakeChild[] = [];
/** One behaviour per spawn, in order; falls back to `defaultBehaviour`. */
let queue: Behaviour[] = [];

const later = (fn: () => void, ms = 15) => setTimeout(fn, ms);
const okDump: Behaviour = (c) => {
  c.stdout.end(DUMP);
  later(() => c.emit("close", 0));
};
const okPsqlCommand: Behaviour = (c) => later(() => c.emit("close", 0));
const okRestore: Behaviour = (c) => {
  c.stdin.on("data", (d) => { c.input += d.toString(); });
  c.stdin.on("end", () => later(() => c.emit("close", 0)));
};
function defaultBehaviour(c: FakeChild): void {
  if (c.args.includes("-c")) return okPsqlCommand(c);
  if (String(c.bin).includes("pg_dump")) return okDump(c);
  return okRestore(c);
}

let history: unknown[] | null;
const files = () => readdirSync(dirs.root);
const flushIo = () => new Promise((r) => setImmediate(r));

function versionAnswers(by: Record<string, string | Error>): void {
  h.execFile.mockImplementation((file: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
    const key = Object.keys(by).find((k) => String(file).includes(k)) ?? "";
    const v = by[key];
    if (v instanceof Error) cb(v);
    else cb(null, v ?? "", "");
  });
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of [h.spawn, h.execFile, h.toolPath, ...Object.values(h.logger)]) f.mockReset();
  h.url = "postgresql://polaris:s3cret@db.example.test:5432/polaris";
  spawned = [];
  queue = [];
  history = [];
  for (const f of files()) rmSync(join(dirs.root, f), { recursive: true, force: true });

  h.spawn.mockImplementation((bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    const c = new FakeChild(bin, args, opts.env);
    spawned.push(c);
    (queue.shift() ?? defaultBehaviour)(c);
    return c;
  });
  h.toolPath.mockImplementation((tool: string) => ({ path: `/opt/pg17/bin/${tool}`, source: "versioned-dir" }));
  versionAnswers({ pg_dump: "pg_dump (PostgreSQL) 17.2\n", psql: "psql (PostgreSQL) 17.2\n" });
  stubbed(prisma.$queryRawUnsafe).mockResolvedValue([{ server_version_num: "170002" }]);
  stubbed(prisma.$queryRaw).mockResolvedValue([{ one: 1 }]);
  stubbed(prisma.$disconnect).mockResolvedValue(undefined);
  stubbed(prisma.setting.findUnique).mockImplementation(async () => (history === null ? null : { key: "backup_history", value: history }));
  stubbed(prisma.setting.upsert).mockImplementation(async ({ update }: any) => { history = update.value; return {}; });
});

afterAll(() => {
  vi.useRealTimers();
  rmSync(dirs.root, { recursive: true, force: true });
});

// ─── path safety ────────────────────────────────────────────────────────────

describe("backupFilePath", () => {
  it("resolves a minted id inside BACKUP_DIR", () => {
    expect(backupFilePath("bk-1700000000000")).toBe(join(dirs.root, "bk-1700000000000"));
  });
  it.each(["../escape", "..", "", "sub/../../x"])("refuses %j", (id) => {
    expect(backupFilePath(id)).toBeNull();
  });
  it("stringifies a non-string id", () => {
    expect(backupFilePath(123)).toBe(join(dirs.root, "123"));
  });
});

// ─── encrypted-file detection ───────────────────────────────────────────────

describe("isEncryptedBackupFile", () => {
  const scratch = mkdtempSync(join(tmpdir(), "polaris-bksvc-in-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const put = (name: string, bytes: Buffer) => { const p = join(scratch, name); writeFileSync(p, bytes); return p; };

  it("is true for the POLARIS\\0 magic with a body", () => {
    expect(isEncryptedBackupFile(put("a", Buffer.concat([BACKUP_MAGIC, Buffer.alloc(ENCRYPTED_HEADER_LEN)])))).toBe(true);
  });
  it("is false for a file no longer than the header", () => {
    expect(isEncryptedBackupFile(put("b", Buffer.concat([BACKUP_MAGIC, Buffer.alloc(ENCRYPTED_HEADER_LEN - 8)])))).toBe(false);
  });
  it("is false for the retired SHELOB1\\0 magic", () => {
    expect(isEncryptedBackupFile(put("c", Buffer.concat([Buffer.from("SHELOB1\0"), Buffer.alloc(100)])))).toBe(false);
  });
  it("is false for a plain gzip", () => {
    expect(isEncryptedBackupFile(put("d", gzipSync(Buffer.from(DUMP.repeat(10)))))).toBe(false);
  });
});

// ─── tool resolution ────────────────────────────────────────────────────────

describe("resolvePgTool (rule 47)", () => {
  it("a matching client is compatible and names its path, source and majors", async () => {
    expect(await resolvePgTool("pg_dump")).toEqual({
      tool: "pg_dump", path: "/opt/pg17/bin/pg_dump", source: "versioned-dir", clientMajor: 17, serverMajor: 17, compatible: true, problem: null,
    });
    expect(h.toolPath).toHaveBeenCalledWith("pg_dump", 17, existsSync);
    expect(h.execFile.mock.calls[0][1]).toEqual(["--version"]);
  });

  it("an unreadable server major resolves with null and stays compatible", async () => {
    stubbed(prisma.$queryRawUnsafe).mockRejectedValue(new Error("x"));
    const r = await resolvePgTool("pg_dump");
    expect(r).toMatchObject({ serverMajor: null, clientMajor: 17, compatible: true });
    expect(h.toolPath.mock.calls[0][1]).toBeNull();
  });

  it("unrecognisable --version output is a problem", async () => {
    versionAnswers({ pg_dump: "hello" });
    expect((await resolvePgTool("pg_dump")).problem).toBe("pg_dump --version returned something unrecognisable: hello");
  });

  it("a missing binary names the major it looked for", async () => {
    versionAnswers({ psql: Object.assign(new Error("spawn"), { code: "ENOENT" }) });
    const r = await resolvePgTool("psql");
    expect(r.compatible).toBe(false);
    expect(r.problem).toContain("psql was not found on this host (looked for a PostgreSQL 17 install and on PATH)");
  });

  it("any other --version failure carries its message", async () => {
    versionAnswers({ psql: new Error("EACCES") });
    expect((await resolvePgTool("psql")).problem).toBe("psql --version failed: EACCES");
  });

  it("an older psql is compatible (it only warns); an older pg_dump is not", async () => {
    versionAnswers({ pg_dump: "pg_dump (PostgreSQL) 15.4", psql: "psql (PostgreSQL) 15.4" });
    expect((await resolvePgTool("psql")).compatible).toBe(true);
    const d = await resolvePgTool("pg_dump");
    expect(d.compatible).toBe(false);
    expect(d.problem).toContain("pg_dump is PostgreSQL 15 (/opt/pg17/bin/pg_dump) but the server is PostgreSQL 17");
  });

  it("getBackupToolingStatus is ok only when both tools are", async () => {
    expect((await getBackupToolingStatus()).ok).toBe(true);
    versionAnswers({ pg_dump: "pg_dump (PostgreSQL) 13.23", psql: "psql (PostgreSQL) 17.2" });
    const s = await getBackupToolingStatus();
    expect(s.ok).toBe(false);
    expect(s.psql.compatible).toBe(true);
  });
});

describe("timescaleInstalled", () => {
  it("true when the extension row exists, false when not", async () => {
    expect(await timescaleInstalled()).toBe(true);
    stubbed(prisma.$queryRaw).mockResolvedValue([]);
    expect(await timescaleInstalled()).toBe(false);
  });
  it("fails toward true when the read fails", async () => {
    stubbed(prisma.$queryRaw).mockRejectedValue(new Error("x"));
    expect(await timescaleInstalled()).toBe(true);
  });
});

// ─── createBackup ───────────────────────────────────────────────────────────

describe("createBackup", () => {
  it("streams pg_dump → gzip into a file named by its id and registers it", async () => {
    const { record, path } = await createBackup({ password: null, kind: "manual", actor: "alice" });
    expect(record.id).toMatch(/^bk-\d{13}$/);
    expect(path).toBe(join(dirs.root, record.id));
    expect(gunzipSync(readFileSync(path)).toString()).toBe(DUMP);
    expect(record).toMatchObject({ encrypted: false, kind: "manual", size: readFileSync(path).length });
    expect(record.filename).toMatch(/^polaris-backup-0\.10\.77-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.gz$/);
    expect("preUpdate" in record).toBe(false);
    expect(history).toEqual([record]);
    expect(files()).toEqual([record.id]);
  });

  it("spawns the resolved pg_dump with the connection in PG* env, never in argv", async () => {
    await createBackup({ password: null, kind: "manual" });
    const c = spawned[0];
    expect(c.bin).toBe("/opt/pg17/bin/pg_dump");
    expect(c.args).toEqual(["--no-owner", "--no-acl", "--clean", "--if-exists"]);
    expect(c.args.join(" ")).not.toContain("s3cret");
    expect(c.env).toMatchObject({ PGHOST: "db.example.test", PGPORT: "5432", PGUSER: "polaris", PGPASSWORD: "s3cret", PGDATABASE: "polaris" });
  });

  it("rule 51: a driver sslmode is translated for libpq, never copied", async () => {
    h.url = "postgresql://polaris:s3cret@db.example.test/polaris?sslmode=no-verify";
    await createBackup({ password: null, kind: "manual" });
    expect(spawned[0].env.PGSSLMODE).toBe("require");
  });

  it("pre-update and scheduled kinds get their id prefix, filename and badge", async () => {
    const pre = await createBackup({ password: null, kind: "pre-update" });
    const sch = await createBackup({ password: null, kind: "scheduled" });
    expect(pre.record.id).toMatch(/^bk-pre-update-\d+$/);
    expect(pre.record.filename).toMatch(/^polaris-pre-update-0\.10\.77-/);
    expect(pre.record.preUpdate).toBe(true);
    expect(sch.record.id).toMatch(/^bk-scheduled-\d+$/);
    expect(sch.record.filename).toMatch(/^polaris-backup-/);
    expect("preUpdate" in sch.record).toBe(false);
  });

  it("encrypted: POLARIS\\0 | salt | iv | tag | AES-256-GCM(gzip(dump)), .enc in the name, no temp left", async () => {
    const { record, path } = await createBackup({ password: "correct horse battery", kind: "manual" });
    expect(record.encrypted).toBe(true);
    expect(record.filename).toMatch(/\.enc\.gz$/);
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 8).equals(BACKUP_MAGIC)).toBe(true);
    expect(bytes.toString("latin1")).not.toContain("CREATE TABLE");
    const salt = bytes.subarray(8, 40);
    const iv = bytes.subarray(40, 56);
    const tag = bytes.subarray(56, 72);
    const d = createDecipheriv("aes-256-gcm", scryptSync("correct horse battery", salt, 32), iv);
    d.setAuthTag(tag);
    expect(gunzipSync(Buffer.concat([d.update(bytes.subarray(72)), d.final()])).toString()).toBe(DUMP);
    expect(isEncryptedBackupFile(path)).toBe(true);
    expect(files()).toEqual([record.id]);
  });

  it("writes server.backup.created with size, kind and the pg_dump used", async () => {
    const { record } = await createBackup({ password: "pw-pw-pw-pw", kind: "scheduled", actor: "system:backup" });
    expect(eventLog.logEvent.mock.calls[0][0]).toEqual({
      level: "info",
      action: "server.backup.created",
      resourceType: "backup",
      resourceId: record.id,
      resourceName: record.filename,
      actor: "system:backup",
      message: `Database backup created: ${record.filename} (${record.size} bytes, encrypted, scheduled)`,
      details: { kind: "scheduled", size: record.size, encrypted: true, pgDump: "/opt/pg17/bin/pg_dump", pgDumpMajor: 17 },
    });
  });

  it("appends to existing history and caps it at 500, dropping the oldest", async () => {
    history = Array.from({ length: 500 }, (_, i) => ({ id: `old-${i}` }));
    const { record } = await createBackup({ password: null, kind: "manual" });
    expect(history).toHaveLength(500);
    expect((history as any[])[0].id).toBe("old-1");
    expect((history as any[])[499]).toEqual(record);
  });

  it("a missing history row starts a new one", async () => {
    history = null;
    await createBackup({ password: null, kind: "manual" });
    expect(history).toHaveLength(1);
  });

  it("a failed history write does not fail the backup", async () => {
    stubbed(prisma.setting.upsert).mockRejectedValue(new Error("db"));
    const { path } = await createBackup({ password: null, kind: "manual" });
    expect(existsSync(path)).toBe(true);
    expect(h.logger.warn).toHaveBeenCalled();
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
  });

  it("an incompatible pg_dump refuses with its own sentence before spawning", async () => {
    versionAnswers({ pg_dump: "pg_dump (PostgreSQL) 13.23\n" });
    const err = await createBackup({ password: null, kind: "manual" }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(500);
    expect(err.message).toContain("pg_dump is PostgreSQL 13");
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("a pg_dump exit failure leaves no file, no history, no Event, and never echoes stderr", async () => {
    queue.push((c) => {
      c.stderr.write("pg_dump: error: password authentication failed for user polaris (s3cret)");
      c.stdout.end("partial");
      later(() => c.emit("close", 1), 40);
    });
    const err = await createBackup({ password: null, kind: "manual" }).catch((e) => e);
    expect(err).toMatchObject({ httpStatus: 500, message: "Database backup failed — see the server log for details" });
    expect(err.message).not.toContain("s3cret");
    await new Promise((r) => setTimeout(r, 30));
    expect(files()).toEqual([]);
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
    expect(String(h.logger.error.mock.calls[0][0].err)).toContain("pg_dump exited with code 1");
  });

  it("an encrypted failure leaves neither the file nor the ciphertext temp", async () => {
    queue.push((c) => {
      c.stdout.end("partial");
      later(() => c.emit("close", 2), 40);
    });
    await expect(createBackup({ password: "pw-pw-pw-pw", kind: "manual" })).rejects.toMatchObject({ httpStatus: 500 });
    await new Promise((r) => setTimeout(r, 30));
    expect(files()).toEqual([]);
  });

  it("a pg_dump that cannot be spawned (ENOENT) says so", async () => {
    queue.push((c) => {
      c.stdout.end();
      later(() => c.emit("error", Object.assign(new Error("spawn pg_dump ENOENT"), { code: "ENOENT" })), 40);
    });
    await expect(createBackup({ password: null, kind: "manual" })).rejects.toMatchObject({
      httpStatus: 500,
      message: "pg_dump was not found on this host — install the PostgreSQL client tools",
    });
  });

  it("the no-output watchdog kills a wedged pg_dump after 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      queue.push(() => { /* silent forever */ });
      const p = createBackup({ password: null, kind: "manual" }).catch((e) => e);
      for (let i = 0; i < 50 && spawned.length === 0; i++) await flushIo();
      expect(spawned).toHaveLength(1);
      vi.advanceTimersByTime(9 * 60 * 1000);
      expect(spawned[0].kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(spawned[0].kill).toHaveBeenCalledWith("SIGKILL");
      spawned[0].stdout.end();
      const err = await p;
      expect(err).toMatchObject({ httpStatus: 500, message: "Database backup failed — see the server log for details" });
      expect(String(h.logger.error.mock.calls[0][0].err)).toContain("produced no output for 10 minutes and was killed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the watchdog spares a long dump that keeps producing output", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      queue.push(() => { /* driven below */ });
      const p = createBackup({ password: null, kind: "manual" });
      for (let i = 0; i < 50 && spawned.length === 0; i++) await flushIo();
      const c = spawned[0];
      for (let minute = 0; minute < 30; minute += 5) {
        c.stderr.write("still dumping\n");
        vi.advanceTimersByTime(5 * 60 * 1000);
      }
      expect(c.kill).not.toHaveBeenCalled();
      c.stdout.end(DUMP);
      setImmediate(() => c.emit("close", 0));
      const { path } = await p;
      expect(gunzipSync(readFileSync(path)).toString()).toBe(DUMP);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── restoreBackup ──────────────────────────────────────────────────────────

describe("restoreBackup", () => {
  const scratch = mkdtempSync(join(tmpdir(), "polaris-bksvc-restore-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const plain = (name = "plain.gz", sql = DUMP) => { const p = join(scratch, name); writeFileSync(p, gzipSync(Buffer.from(sql))); return p; };
  const psqlArgs = () => spawned.map((c) => (c.args.includes("-c") ? c.args[c.args.indexOf("-c") + 1] : "RESTORE"));

  it("a missing file is a 400", async () => {
    await expect(restoreBackup({ filePath: join(scratch, "nope.gz") })).rejects.toMatchObject({ httpStatus: 400, message: "Backup file not found" });
  });

  it("with Timescale: pre_restore, the restore, post_restore — three separate sessions, then the pool recycles", async () => {
    await restoreBackup({ filePath: plain() });
    expect(psqlArgs()).toEqual(["SELECT timescaledb_pre_restore();", "RESTORE", "SELECT timescaledb_post_restore();"]);
    expect(spawned[1].input).toBe(DUMP);
    expect(spawned[1].args).toEqual(["--no-psqlrc", "--quiet", "--single-transaction", "-v", "ON_ERROR_STOP=1"]);
    expect(spawned.every((c) => c.bin === "/opt/pg17/bin/psql")).toBe(true);
    expect(spawned.every((c) => c.env.PGPASSWORD === "s3cret")).toBe(true);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  it("without Timescale: only the restore runs", async () => {
    stubbed(prisma.$queryRaw).mockResolvedValue([]);
    await restoreBackup({ filePath: plain() });
    expect(psqlArgs()).toEqual(["RESTORE"]);
  });

  it("a failing pre_restore is benign: the restore and post_restore still run", async () => {
    queue.push((c) => later(() => c.emit("close", 3)));
    await restoreBackup({ filePath: plain() });
    expect(psqlArgs()).toEqual(["SELECT timescaledb_pre_restore();", "RESTORE", "SELECT timescaledb_post_restore();"]);
    expect(h.logger.warn).toHaveBeenCalled();
  });

  it("a failed restore still runs post_restore and recycles the pool, then 500s without stderr", async () => {
    queue.push(okPsqlCommand, (c) => {
      c.stdin.resume();
      c.stderr.write("ERROR: relation exists (password s3cret)");
      later(() => c.emit("close", 3));
    });
    const err = await restoreBackup({ filePath: plain() }).catch((e) => e);
    expect(err).toMatchObject({ httpStatus: 500, message: "Restore failed — see the server log for details" });
    expect(psqlArgs()[2]).toBe("SELECT timescaledb_post_restore();");
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  it("a failing post_restore is logged as an error, not thrown", async () => {
    queue.push(okPsqlCommand, okRestore, (c) => later(() => c.emit("close", 1)));
    await expect(restoreBackup({ filePath: plain() })).resolves.toBeUndefined();
    expect(String(h.logger.error.mock.calls[0][1])).toContain("timescaledb_post_restore() FAILED");
  });

  it("a failing pool recycle is only a warning", async () => {
    stubbed(prisma.$disconnect).mockRejectedValue(new Error("x"));
    await expect(restoreBackup({ filePath: plain() })).resolves.toBeUndefined();
  });

  it("an unusable psql refuses before anything runs", async () => {
    versionAnswers({ psql: Object.assign(new Error("x"), { code: "ENOENT" }) });
    await expect(restoreBackup({ filePath: plain() })).rejects.toMatchObject({ httpStatus: 500, message: expect.stringContaining("psql was not found") });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("an older psql only warns and restores", async () => {
    versionAnswers({ psql: "psql (PostgreSQL) 15.1" });
    await restoreBackup({ filePath: plain() });
    expect(h.logger.warn.mock.calls.some((c) => String(c[1]).includes("psql is older than the server"))).toBe(true);
    expect(spawned).toHaveLength(3);
  });

  it("an encrypted backup without a password is refused", async () => {
    const { path } = await createBackup({ password: "pw-pw-pw-pw", kind: "manual" });
    spawned = [];
    await expect(restoreBackup({ filePath: path })).rejects.toMatchObject({
      httpStatus: 400,
      message: "This backup is encrypted — a password is required to restore it",
    });
    expect(spawned).toHaveLength(0);
  });

  it("round trip: an encrypted backup restores its dump with the password, leaving no decrypted temp", async () => {
    const { path, record } = await createBackup({ password: "pw-pw-pw-pw", kind: "manual" });
    spawned = [];
    await restoreBackup({ filePath: path, password: "pw-pw-pw-pw" });
    expect(spawned[1].input).toBe(DUMP);
    expect(files()).toEqual([record.id]);
  });

  it("a wrong password is a 400 before any psql, with no decrypted temp left", async () => {
    const { path, record } = await createBackup({ password: "pw-pw-pw-pw", kind: "manual" });
    spawned = [];
    await expect(restoreBackup({ filePath: path, password: "wrong-wrong" })).rejects.toMatchObject({
      httpStatus: 400,
      message: "Decryption failed — incorrect password or corrupted file",
    });
    expect(spawned).toHaveLength(0);
    expect(files()).toEqual([record.id]);
  });

  it("a legacy SHELOB1 file is not treated as encrypted and fails as an unreadable dump", async () => {
    const p = join(scratch, "legacy.enc.gz");
    writeFileSync(p, Buffer.concat([Buffer.from("SHELOB1\0"), Buffer.alloc(200, 7)]));
    const err = await restoreBackup({ filePath: p }).catch((e) => e);
    expect(err).toMatchObject({ httpStatus: 500, message: "Restore failed — see the server log for details" });
    expect(psqlArgs()[psqlArgs().length - 1]).toBe("SELECT timescaledb_post_restore();");
  });
});

// ─── list / get / delete ────────────────────────────────────────────────────

describe("history reads and deleteBackup", () => {
  const OLD = new Date(Date.now() - 60 * 60 * 1000);
  const putFile = (name: string) => { const p = join(dirs.root, name); writeFileSync(p, "gz"); utimesSync(p, OLD, OLD); return p; };
  const rec = (id: string, createdAt: string) => ({ id, filename: `f-${id}.gz`, size: 2, encrypted: false, createdAt, kind: "manual" });

  it("listBackups sorts newest first and attaches each path", async () => {
    history = [rec("bk-1000000000001", "2026-01-01T00:00:00.000Z"), rec("bk-1000000000002", "2026-03-01T00:00:00.000Z")];
    const list = await listBackups();
    expect(list.map((r) => r.id)).toEqual(["bk-1000000000002", "bk-1000000000001"]);
    expect(list[0].path).toBe(join(dirs.root, "bk-1000000000002"));
  });

  it("a non-array history value reads as empty", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValue({ value: { not: "an array" } });
    expect(await listBackups()).toEqual([]);
  });

  it("getBackupRecord: tracked, untracked on disk, and a non-backup name", async () => {
    history = [rec("bk-1000000000001", "2026-01-01T00:00:00.000Z")];
    putFile("bk-scheduled-1700000000000");
    putFile("notes.txt");
    expect((await getBackupRecord("bk-1000000000001"))!.filename).toBe("f-bk-1000000000001.gz");
    expect(await getBackupRecord("bk-scheduled-1700000000000")).toMatchObject({ kind: "scheduled", untracked: true });
    expect(await getBackupRecord("notes.txt")).toBeNull();
  });

  it("deleteBackup refuses a traversal id with 400 before reading anything", async () => {
    await expect(deleteBackup("../x")).rejects.toMatchObject({ httpStatus: 400, message: "Invalid backup id" });
    expect(prisma.setting.findUnique).not.toHaveBeenCalled();
  });

  it("deleteBackup 404s on an id neither tracked nor on disk", async () => {
    await expect(deleteBackup("bk-1000000000009")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("deleteBackup removes a tracked file + entry and writes a warning Event", async () => {
    history = [rec("bk-1000000000001", "2026-01-01T00:00:00.000Z"), rec("bk-1000000000002", "2026-01-02T00:00:00.000Z")];
    const p = putFile("bk-1000000000001");
    const removed = await deleteBackup("bk-1000000000001", "alice");
    expect(removed.id).toBe("bk-1000000000001");
    expect(existsSync(p)).toBe(false);
    expect((history as any[]).map((r) => r.id)).toEqual(["bk-1000000000002"]);
    expect(eventLog.logEvent.mock.calls[0][0]).toEqual({
      level: "warning",
      action: "server.backup.deleted",
      resourceType: "backup",
      resourceId: "bk-1000000000001",
      resourceName: "f-bk-1000000000001.gz",
      actor: "alice",
      message: "Database backup deleted: f-bk-1000000000001.gz",
    });
  });

  it("deleteBackup of a tracked entry whose file is already gone still drops the entry", async () => {
    history = [rec("bk-1000000000001", "2026-01-01T00:00:00.000Z")];
    await deleteBackup("bk-1000000000001");
    expect(history).toEqual([]);
  });

  it("deleteBackup removes an untracked file without rewriting the history", async () => {
    const p = putFile("bk-pre-update-1700000000000");
    const removed = await deleteBackup("bk-pre-update-1700000000000");
    expect(removed).toMatchObject({ untracked: true, kind: "pre-update", preUpdate: true });
    expect(existsSync(p)).toBe(false);
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });
});
