/**
 * tests/unit/backupUntracked.test.ts
 *
 * Business rule 158(a): the backup history is an INDEX of the files in
 * data/backups, never the list of them. A backup file the history does not
 * name — its entry was trimmed by the cap, its registration failed, or an
 * older backup was restored and replaced the history — is still listed, can
 * be downloaded, and can be deleted. Before this it was invisible and simply
 * accumulated on disk.
 *
 * The files are real, in a temp directory standing in for BACKUP_DIR; the
 * history Setting row is an in-memory value.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { writeFileSync, existsSync, rmSync, readdirSync, utimesSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dirs = await vi.hoisted(async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), "polaris-bk-")) };
});

const h = vi.hoisted(() => ({
  history: [] as Array<Record<string, unknown>>,
  logEvent: vi.fn(async (_event: unknown) => {}),
}));

vi.mock("../../src/utils/paths.js", () => ({ BACKUP_DIR: dirs.root, STATE_DIR: dirs.root }));
vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: {
      findUnique: vi.fn(async () => ({ key: "backup_history", value: h.history })),
      upsert: vi.fn(async ({ update }: { update: { value: Array<Record<string, unknown>> } }) => { h.history = update.value; return {}; }),
    },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));

import { listBackups, getBackupRecord, deleteBackup } from "../../src/services/backupService.js";

const OLD = new Date(Date.now() - 60 * 60 * 1000);
/** A settled file: old enough not to be mistaken for a dump in progress. */
function put(name: string, body: string | Buffer = "gzip-bytes", settled = true) {
  const p = join(dirs.root, name);
  writeFileSync(p, body);
  if (settled) utimesSync(p, OLD, OLD);
  return p;
}
const tracked = (id: string, createdAt: string) => ({ id, filename: `polaris-backup-${id}.gz`, size: 10, encrypted: false, createdAt, kind: "manual" });

beforeEach(() => {
  vi.clearAllMocks();
  h.history = [];
  for (const f of readdirSync(dirs.root)) rmSync(join(dirs.root, f), { recursive: true, force: true });
});
afterAll(() => rmSync(dirs.root, { recursive: true, force: true }));

describe("rule 158(a): a backup file the history does not list is still a backup", () => {
  it("lists a file with no history entry, flagged untracked, with what the name and bytes say about it", async () => {
    put("bk-scheduled-1760000000000");
    const list = await listBackups();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "bk-scheduled-1760000000000",
      kind: "scheduled",
      encrypted: false,
      untracked: true,
      size: 10,
      createdAt: new Date(1760000000000).toISOString(),
    });
    expect(list[0].filename).toMatch(/^polaris-backup-.*\.gz$/);
    expect(list[0].path).toBe(join(dirs.root, "bk-scheduled-1760000000000"));
  });

  it("reads the kind from the id and the encryption from the file's own header", async () => {
    put("bk-pre-update-1760000000001", Buffer.concat([Buffer.from("POLARIS\0", "latin1"), Buffer.alloc(200, 1)]));
    const [b] = await listBackups();
    expect(b).toMatchObject({ kind: "pre-update", preUpdate: true, encrypted: true });
    expect(b.filename).toMatch(/^polaris-pre-update-.*\.enc\.gz$/);
  });

  it("merges tracked and untracked newest first, and never lists a tracked file twice", async () => {
    h.history = [tracked("bk-1750000000000", new Date(1750000000000).toISOString()), tracked("bk-1770000000000", new Date(1770000000000).toISOString())];
    put("bk-1750000000000");
    put("bk-1770000000000");
    put("bk-1760000000000");
    const list = await listBackups();
    expect(list.map((b) => b.id)).toEqual(["bk-1770000000000", "bk-1760000000000", "bk-1750000000000"]);
    expect(list.map((b) => !!b.untracked)).toEqual([false, true, false]);
  });

  it("leaves alone anything that is not a name createBackup mints", async () => {
    put("notes.txt");
    put("bk-1760000000000.tmp");
    put("restore-upload-123");
    mkdirSync(join(dirs.root, "bk-1760000000009"));
    expect(await listBackups()).toEqual([]);
  });

  it("does not list a file still being written (a dump has a file before it has an entry)", async () => {
    put("bk-1760000000000", "partial", false);
    expect(await listBackups()).toEqual([]);
    expect(await getBackupRecord("bk-1760000000000")).toBeNull();
  });

  it("an install that has never made a backup lists nothing", async () => {
    rmSync(dirs.root, { recursive: true, force: true });
    expect(await listBackups()).toEqual([]);
    mkdirSync(dirs.root, { recursive: true });
  });

  it("getBackupRecord resolves an untracked file, so it can be downloaded and restored", async () => {
    put("bk-1760000000000");
    expect(await getBackupRecord("bk-1760000000000")).toMatchObject({ id: "bk-1760000000000", untracked: true });
    expect(await getBackupRecord("bk-1760000000777")).toBeNull();
    expect(await getBackupRecord("../../etc/passwd")).toBeNull();
  });

  it("deleteBackup removes an untracked file, writes the Event, and leaves the history alone", async () => {
    h.history = [tracked("bk-1750000000000", new Date(1750000000000).toISOString())];
    const p = put("bk-1760000000000");
    const removed = await deleteBackup("bk-1760000000000", "tester");
    expect(removed.untracked).toBe(true);
    expect(existsSync(p)).toBe(false);
    expect(h.history).toHaveLength(1);
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "server.backup.deleted", resourceId: "bk-1760000000000", actor: "tester" }));
  });

  it("deleteBackup still removes a tracked backup from the history and the disk", async () => {
    h.history = [tracked("bk-1750000000000", new Date(1750000000000).toISOString())];
    const p = put("bk-1750000000000");
    await deleteBackup("bk-1750000000000");
    expect(h.history).toEqual([]);
    expect(existsSync(p)).toBe(false);
  });

  it("deleteBackup refuses an id that names no backup — and never deletes a file it would not list", async () => {
    const p = put("notes.txt");
    await expect(deleteBackup("notes.txt")).rejects.toMatchObject({ httpStatus: 404 });
    await expect(deleteBackup("bk-1760000000123")).rejects.toMatchObject({ httpStatus: 404 });
    await expect(deleteBackup("../outside")).rejects.toMatchObject({ httpStatus: 400 });
    expect(existsSync(p)).toBe(true);
  });
});
