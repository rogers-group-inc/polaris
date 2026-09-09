/**
 * tests/unit/backupToolResolution.test.ts
 *
 * backupService.resolvePgTool() / getBackupToolingStatus() — the service-level
 * half of rule 47. The pure candidate logic is covered in pgClientTools.test.ts;
 * this pins what the service does with it: read the server's major, run
 * `--version` on whatever was chosen, and turn a mismatch into the SPECIFIC
 * operator sentence rather than a generic failure. The prod case is the one to
 * keep green: pg_dump 13.23 in front of a 15.18 server must come back
 * `compatible: false` with both versions in `problem`.
 *
 * No database and no client tools: prisma's GUC read and child_process.execFile
 * are both mocked.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const queryRawUnsafe = vi.fn();
vi.mock("../../src/db.js", () => ({
  prisma: { $queryRawUnsafe: queryRawUnsafe, $queryRaw: vi.fn(), $disconnect: vi.fn() },
}));

// execFile is promisified at module load. Node's real execFile carries a
// `[promisify.custom]` that resolves `{ stdout, stderr }`; a plain mock would be
// promisified by the callback convention and resolve just the first argument,
// so the service would destructure a string. Give the mock the same custom.
const execFileMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile: any = (...a: any[]) => execFileMock(...a);
  execFile[promisify.custom] = (file: string, args: string[], opts: unknown) =>
    new Promise((resolve, reject) =>
      execFileMock(file, args, opts, (err: any, stdout: string, stderr: string) =>
        err ? reject(err) : resolve({ stdout, stderr }),
      ),
    );
  return { ...real, execFile };
});

const { resolvePgTool, getBackupToolingStatus } = await import("../../src/services/backupService.js");

/** Make `--version` answer with this text for every tool. */
function versionAnswers(byTool: Record<string, string | Error>) {
  execFileMock.mockImplementation((file: string, _args: string[], _opts: unknown, cb: Function) => {
    const key = Object.keys(byTool).find((k) => String(file).includes(k)) ?? "";
    const v = byTool[key];
    if (v instanceof Error) cb(v);
    else cb(null, v ?? "", "");
  });
}

beforeEach(() => {
  queryRawUnsafe.mockReset();
  execFileMock.mockReset();
  queryRawUnsafe.mockResolvedValue([{ server_version_num: "150018" }]);
});

describe("resolvePgTool", () => {
  it("prod 2026-09-09: a PostgreSQL 13 pg_dump in front of a 15 server is refused, with both versions named", async () => {
    versionAnswers({ pg_dump: "pg_dump (PostgreSQL) 13.23\n" });
    const r = await resolvePgTool("pg_dump");
    expect(r.serverMajor).toBe(15);
    expect(r.clientMajor).toBe(13);
    expect(r.compatible).toBe(false);
    expect(r.problem).toContain("pg_dump is PostgreSQL 13");
    expect(r.problem).toContain("server is PostgreSQL 15");
    expect(r.problem).toContain("dnf install postgresql15");
  });

  it("a matching client is compatible with no problem text", async () => {
    versionAnswers({ pg_dump: "pg_dump (PostgreSQL) 15.18\n" });
    const r = await resolvePgTool("pg_dump");
    expect(r).toMatchObject({ clientMajor: 15, serverMajor: 15, compatible: true, problem: null });
  });

  it("a NEWER client is compatible (pg_dump is backward compatible)", async () => {
    versionAnswers({ pg_dump: "pg_dump (PostgreSQL) 16.4\n" });
    expect((await resolvePgTool("pg_dump")).compatible).toBe(true);
  });

  it("psql behind the server is still usable — it only warns, it does not refuse", async () => {
    versionAnswers({ psql: "psql (PostgreSQL) 13.23\n" });
    const r = await resolvePgTool("psql");
    expect(r.clientMajor).toBe(13);
    expect(r.compatible).toBe(true);
  });

  it("a missing binary is reported as not found, not as a version problem", async () => {
    versionAnswers({ pg_dump: Object.assign(new Error("spawn pg_dump ENOENT"), { code: "ENOENT" }) });
    const r = await resolvePgTool("pg_dump");
    expect(r.compatible).toBe(false);
    expect(r.clientMajor).toBeNull();
    expect(r.problem).toMatch(/not found/);
  });

  it("an unreadable server version falls back to PATH and still verifies the client", async () => {
    queryRawUnsafe.mockRejectedValue(new Error("connection refused"));
    versionAnswers({ pg_dump: "pg_dump (PostgreSQL) 15.18\n" });
    const r = await resolvePgTool("pg_dump");
    expect(r.serverMajor).toBeNull();
    expect(r.source).toBe("path");
    expect(r.clientMajor).toBe(15);
    // Nothing to compare against, so nothing to refuse — the dump itself will
    // say so if the server turns out newer.
    expect(r.compatible).toBe(true);
  });
});

describe("getBackupToolingStatus", () => {
  it("is ok only when both tools can work", async () => {
    versionAnswers({ pg_dump: "pg_dump (PostgreSQL) 13.23\n", psql: "psql (PostgreSQL) 15.18\n" });
    const s = await getBackupToolingStatus();
    expect(s.ok).toBe(false);
    expect(s.pgDump.compatible).toBe(false);
    expect(s.psql.compatible).toBe(true);
  });

  it("reports ok on a healthy host", async () => {
    versionAnswers({ pg_dump: "pg_dump (PostgreSQL) 15.18\n", psql: "psql (PostgreSQL) 15.18\n" });
    expect((await getBackupToolingStatus()).ok).toBe(true);
  });
});
