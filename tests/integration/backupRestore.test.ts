/**
 * tests/integration/backupRestore.test.ts
 *
 * The backup/restore round trip — the one path whose failure is unrecoverable,
 * and the one that had zero coverage before 2026-08. Grepping the suite for
 * `database/backup`, `database/restore` or `pg_dump` returned nothing, which is
 * how the backup path came to be simultaneously (a) event-loop-blocking and
 * memory-bound and (b) not Timescale-aware, without anything flagging either.
 *
 * What this asserts, in order of consequence:
 *   1. A backup RESTORES. A row created before the backup, deleted after it, is
 *      present again once the restore completes. Nothing else in the suite
 *      proves the file is usable rather than merely produced.
 *   2. The Timescale gates run when the extension is installed. Skipping
 *      timescaledb_pre_restore()/post_restore() is what made the restore
 *      unreliable in the first place, so their absence must be a test failure,
 *      not a silent behaviour change.
 *   3. The database is not left in restoring mode after a FAILED restore. That
 *      failure mode is worse than the failed restore itself — normal hypertable
 *      writes start rejecting.
 *   4. The encrypted variant round-trips, and a wrong passphrase is a clean 400.
 *   5. Queries work again after a restore. `--clean --if-exists` drops and
 *      recreates every table, so a connection opened beforehand holds cached
 *      relation OIDs that no longer exist and fails with
 *      `XX000 could not open relation with OID <n>`. restoreBackup recycles the
 *      pool in a finally for exactly this reason; asserting a query straight
 *      after the restore is what proves it.
 *
 * Skips cleanly when DATABASE_URL is unreachable (see _helpers.ts) OR when the
 * PostgreSQL client tools are not on PATH — the app container ships them, a bare
 * dev host often does not.
 */

import { it, expect, beforeAll, afterAll, describe } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { prisma } from "../../src/db.js";
import { dbReachable, dbDescribe } from "./_helpers.js";
import {
  createBackup,
  restoreBackup,
  deleteBackup,
  timescaleInstalled,
  isEncryptedBackupFile,
} from "../../src/services/backupService.js";

/** Are pg_dump AND psql invocable? Without them there is nothing to test. */
const pgToolsPresent: boolean = (() => {
  for (const bin of ["pg_dump", "psql"]) {
    const r = spawnSync(bin, ["--version"], { stdio: "ignore" });
    if (r.error || r.status !== 0) return false;
  }
  return true;
})();

if (dbReachable && !pgToolsPresent) {
  console.warn("[backupRestore] pg_dump/psql not on PATH — backup round-trip suite will skip.");
}

const d = dbReachable && pgToolsPresent ? dbDescribe : describe.skip;

const PFX = "backup-rt-test";
const PASSPHRASE = "backup-round-trip-passphrase";
const createdBackupIds: string[] = [];
const strayFiles: string[] = [];

/**
 * Marker row. IpBlock is a small plain table with no hypertable involvement and
 * no FK fan-out, so restoring over it is cheap and its presence/absence is an
 * unambiguous signal.
 *
 * Each marker gets its OWN /24 out of the RFC 5737 documentation range, because
 * `IpBlock.cidr` is globally unique and a restore is not test-scoped: it brings
 * back every row the dump contained, including markers earlier tests deleted. A
 * shared CIDR therefore collides on the second test.
 */
const MARKER_CIDRS: Record<string, string> = {
  plain: "203.0.113.0/24",
  enc: "198.18.0.0/24",
  "after-failure": "198.19.0.0/24",
};

async function createMarker(key: string): Promise<{ name: string; id: string }> {
  const name = `${PFX}-${key}`;
  const cidr = MARKER_CIDRS[key];
  if (!cidr) throw new Error(`no marker CIDR reserved for "${key}"`);
  // Clear by CIDR as well as by name: a previous aborted run may have left the
  // row behind under a different name, and the unique index is on the CIDR.
  await prisma.ipBlock.deleteMany({ where: { OR: [{ name }, { cidr }] } });
  const row = await prisma.ipBlock.create({ data: { cidr, name, ipVersion: "v4" } });
  return { name, id: row.id };
}

async function markerExists(name: string): Promise<boolean> {
  const row = await prisma.ipBlock.findFirst({ where: { name } });
  return row !== null;
}

beforeAll(async () => {
  if (!dbReachable || !pgToolsPresent) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable || !pgToolsPresent) return;
  for (const id of createdBackupIds) {
    try { await deleteBackup(id, "system:test"); } catch { /* already gone */ }
  }
  for (const p of strayFiles) {
    if (existsSync(p)) { try { unlinkSync(p); } catch { /* best effort */ } }
  }
  await prisma.ipBlock.deleteMany({
    where: { OR: [{ name: { startsWith: PFX } }, { cidr: { in: Object.values(MARKER_CIDRS) } }] },
  });
  // Safe to row-delete despite the compressed-chunk rule in polaris-domain-model -> samples-rollups.md: this row
  // was written seconds ago, so it is in the newest uncompressed chunk.
  await prisma.assetMonitorSample.deleteMany({ where: { assetId: `${PFX}-asset` } });
  await prisma.$disconnect();
});

d("backup + restore round trip", () => {
  it("restores a row that was deleted after the backup was taken", async () => {
    const { name: marker } = await createMarker("plain");

    const { record, path } = await createBackup({ password: null, kind: "manual", actor: "system:test" });
    createdBackupIds.push(record.id);
    expect(record.size).toBeGreaterThan(0);
    expect(isEncryptedBackupFile(path)).toBe(false);

    // Delete the marker, then restore. If the dump were unusable, or the
    // Timescale gates were missing on a Timescale install, this is where it
    // shows up.
    await prisma.ipBlock.deleteMany({ where: { name: marker } });
    expect(await markerExists(marker)).toBe(false);

    await restoreBackup({ filePath: path });

    // No manual reconnect: this query going through is the assertion that
    // restoreBackup recycled the pool. Before that fix it failed with
    // `could not open relation with OID <n>` on a stale connection.
    expect(await markerExists(marker)).toBe(true);
  }, 300_000);

  it("round-trips an encrypted backup", async () => {
    const { name: marker } = await createMarker("enc");

    const { record, path } = await createBackup({
      password: PASSPHRASE,
      kind: "manual",
      actor: "system:test",
    });
    createdBackupIds.push(record.id);
    expect(record.encrypted).toBe(true);
    expect(isEncryptedBackupFile(path)).toBe(true);
    expect(record.filename).toContain(".enc");

    await prisma.ipBlock.deleteMany({ where: { name: marker } });
    await restoreBackup({ filePath: path, password: PASSPHRASE });
    expect(await markerExists(marker)).toBe(true);
  }, 300_000);

  it("rejects an encrypted backup with no passphrase, and with the wrong one", async () => {
    const { record, path } = await createBackup({
      password: PASSPHRASE,
      kind: "manual",
      actor: "system:test",
    });
    createdBackupIds.push(record.id);

    await expect(restoreBackup({ filePath: path })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(
      restoreBackup({ filePath: path, password: "definitely-not-the-passphrase" }),
    ).rejects.toMatchObject({ httpStatus: 400 });
  }, 300_000);

  it("leaves the database usable after a failed restore (post_restore always runs)", async () => {
    // Feed psql a valid gzip stream of INVALID SQL: the restore must fail, and
    // the Timescale restoring flag must be cleared regardless. A database left
    // with timescaledb.restoring on rejects normal hypertable writes, which is a
    // far worse outcome than the failed restore.
    const { gzipSync } = await import("node:zlib");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const bad = join(tmpdir(), `polaris-bad-restore-${Date.now()}.gz`);
    strayFiles.push(bad);
    writeFileSync(bad, gzipSync(Buffer.from("this is not valid sql at all;\n", "utf8")));

    await expect(restoreBackup({ filePath: bad })).rejects.toBeTruthy();

    // The proof the flag is clear: a write to a hypertable-backed sample table
    // succeeds. (On a non-Timescale database this is simply a normal insert.)
    const { id } = await createMarker("after-failure");
    expect(id).toBeTruthy();
    // A write to a hypertable-backed sample table is the real proof: a database
    // still in restoring mode rejects these, which is precisely what
    // post_restore-in-a-finally exists to prevent.
    await prisma.assetMonitorSample.create({
      data: { assetId: `${PFX}-asset`, timestamp: new Date(), success: true, responseTimeMs: 1 },
    });
  }, 300_000);

  it("errors clearly on a missing file rather than shelling out", async () => {
    await expect(
      restoreBackup({ filePath: "/nonexistent/polaris-backup.gz" }),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("reports whether Timescale is installed (documents which path the tests took)", async () => {
    // Not an assertion about the environment — the round trip above must pass
    // either way. This makes the log say which branch ran, so a green run on a
    // non-Timescale dev database is not mistaken for coverage of the gates.
    const installed = await timescaleInstalled();
    expect(typeof installed).toBe("boolean");
    console.info(`[backupRestore] timescaledb installed: ${installed}`);
  });
});
