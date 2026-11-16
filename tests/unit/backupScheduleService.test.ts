/**
 * tests/unit/backupScheduleService.test.ts — the backupSchedule Setting row:
 * parse-with-defaults, the masked read, the operator merge, the job-owned
 * outcome bookkeeping, and the off-host copy (business rules 20(c), 117).
 *
 * The pure cadence (`isScheduledBackupDue`) has its own suite in
 * backupSchedule.test.ts; only the edges it does not reach are added here.
 *
 * The service's settings store is module-level with a 30 s TTL and no reset
 * hook, so every test runs at a fresh fake "now" a minute past the last —
 * whatever an earlier test cached has always expired.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const priv = vi.hoisted(() => ({ makeFilePrivate: vi.fn() }));
vi.mock("../../src/utils/privateFiles.js", () => ({ makeFilePrivate: priv.makeFilePrivate }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  getBackupSchedule,
  getBackupScheduleMasked,
  saveBackupSchedule,
  recordScheduledBackupOutcome,
  isScheduledBackupDue,
  copyBackupOffHost,
  defaultBackupSchedule,
  MAX_INTERVAL_HOURS,
  MIN_INTERVAL_HOURS,
  MAX_RETAIN,
  MIN_RETAIN,
  type BackupSchedule,
} from "../../src/services/backupScheduleService.js";
import { SECRET_MASK } from "../../src/utils/secretMask.js";

let tick = 0;
const BASE = new Date("2026-11-16T00:00:00Z").getTime();
const STRONG = "correct horse battery staple";

function stored(value: unknown): void {
  stubbed(prisma.setting.findUnique).mockResolvedValue(value === null ? null : { key: "backupSchedule", value });
}
function lastSaved(): BackupSchedule {
  const calls = stubbed(prisma.setting.upsert).mock.calls;
  return calls[calls.length - 1][0].update.value as BackupSchedule;
}

beforeEach(() => {
  resetDbStub();
  priv.makeFilePrivate.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  tick += 1;
  vi.setSystemTime(BASE + tick * 3_600_000);
  stored(null);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("getBackupSchedule (parse)", () => {
  it("answers the defaults — disabled — with no row", async () => {
    expect(await getBackupSchedule()).toEqual(defaultBackupSchedule());
    expect((await getBackupSchedule()).enabled).toBe(false);
    expect(prisma.setting.findUnique).toHaveBeenCalledWith({ where: { key: "backupSchedule" } });
  });

  it("answers the defaults for a non-object row", async () => {
    stored("garbage");
    expect(await getBackupSchedule()).toEqual(defaultBackupSchedule());
  });

  it("clamps out-of-range numbers and floors fractions", async () => {
    stored({ enabled: true, intervalHours: 9999, retainCount: 0, hourUtc: 5.7 });
    const s = await getBackupSchedule();
    expect(s.intervalHours).toBe(MAX_INTERVAL_HOURS);
    expect(s.retainCount).toBe(MIN_RETAIN);
    expect(s.hourUtc).toBe(5);
  });

  it("falls back on non-numeric / non-finite numbers and drops an hour outside 0-23", async () => {
    stored({ intervalHours: "12", retainCount: Number.NaN, hourUtc: 24 });
    const s = await getBackupSchedule();
    expect(s.intervalHours).toBe(24);
    expect(s.retainCount).toBe(7);
    expect(s.hourUtc).toBeNull();
  });

  it("drops an empty passphrase and trims copyToDir (blank → null)", async () => {
    stored({ passphrase: "", copyToDir: "   " });
    let s = await getBackupSchedule();
    expect(s.passphrase).toBeNull();
    expect(s.copyToDir).toBeNull();
    vi.setSystemTime(Date.now() + 60_000);
    stored({ passphrase: STRONG, copyToDir: "  /mnt/share  ", lastRunAt: "2026-01-01T00:00:00Z", lastError: "boom" });
    s = await getBackupSchedule();
    expect(s.passphrase).toBe(STRONG);
    expect(s.copyToDir).toBe("/mnt/share");
    expect(s.lastRunAt).toBe("2026-01-01T00:00:00Z");
    expect(s.lastError).toBe("boom");
  });
});

describe("getBackupScheduleMasked", () => {
  it("replaces a stored passphrase with the shared mask", async () => {
    stored({ passphrase: STRONG });
    expect((await getBackupScheduleMasked()).passphrase).toBe(SECRET_MASK);
    // The internal read still carries the real value.
    expect((await getBackupSchedule()).passphrase).toBe(STRONG);
  });

  it("answers null with no passphrase", async () => {
    expect((await getBackupScheduleMasked()).passphrase).toBeNull();
  });
});

describe("saveBackupSchedule", () => {
  it("merges partial input over the current row and persists it", async () => {
    stored({ enabled: false, intervalHours: 12, retainCount: 3 });
    const out = await saveBackupSchedule({ enabled: true });
    expect(out).toMatchObject({ enabled: true, intervalHours: 12, retainCount: 3 });
    expect(lastSaved()).toEqual(out);
    expect(stubbed(prisma.setting.upsert).mock.calls[0][0].where).toEqual({ key: "backupSchedule" });
  });

  it("clamps interval and retention to their bounds", async () => {
    const out = await saveBackupSchedule({ intervalHours: 0, retainCount: 500 });
    expect(out.intervalHours).toBe(MIN_INTERVAL_HOURS);
    expect(out.retainCount).toBe(MAX_RETAIN);
  });

  it("pins, clamps and clears the UTC hour", async () => {
    expect((await saveBackupSchedule({ hourUtc: 3 })).hourUtc).toBe(3);
    expect((await saveBackupSchedule({ hourUtc: 40 })).hourUtc).toBe(23);
    expect((await saveBackupSchedule({ hourUtc: null })).hourUtc).toBeNull();
  });

  it("never lets operator input write lastRunAt / lastError (job-owned)", async () => {
    stored({ lastRunAt: "2026-11-01T00:00:00Z", lastError: "disk full" });
    const out = await saveBackupSchedule({ lastRunAt: "2030-01-01T00:00:00Z", lastError: null } as Partial<BackupSchedule>);
    expect(out.lastRunAt).toBe("2026-11-01T00:00:00Z");
    expect(out.lastError).toBe("disk full");
  });

  it("stores a strong new passphrase", async () => {
    expect((await saveBackupSchedule({ passphrase: STRONG })).passphrase).toBe(STRONG);
  });

  it("keeps the stored passphrase on a masked round-trip (any bullet length)", async () => {
    stored({ passphrase: STRONG });
    expect((await saveBackupSchedule({ passphrase: SECRET_MASK })).passphrase).toBe(STRONG);
    expect(lastSaved().passphrase).toBe(STRONG);
    vi.setSystemTime(Date.now() + 60_000);
    expect((await saveBackupSchedule({ passphrase: "•••" })).passphrase).toBe(STRONG);
  });

  it("clears the passphrase on an empty string or null", async () => {
    stored({ passphrase: STRONG });
    expect((await saveBackupSchedule({ passphrase: "" })).passphrase).toBeNull();
    vi.setSystemTime(Date.now() + 60_000);
    expect((await saveBackupSchedule({ passphrase: null })).passphrase).toBeNull();
  });

  it("keeps the passphrase when the field is omitted", async () => {
    stored({ passphrase: STRONG });
    expect((await saveBackupSchedule({ enabled: true })).passphrase).toBe(STRONG);
  });

  it("refuses a weak passphrase with a 400 and writes nothing", async () => {
    await expect(saveBackupSchedule({ passphrase: "short" })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(saveBackupSchedule({ passphrase: "aaaaaaaaaaaaaaaa" })).rejects.toMatchObject({
      httpStatus: 400,
      message: expect.stringMatching(/too weak/),
    });
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });

  it("accepts an absolute copyToDir (trimmed) and clears it on blank", async () => {
    const abs = join(tmpdir(), "polaris-share");
    expect((await saveBackupSchedule({ copyToDir: `  ${abs}  ` })).copyToDir).toBe(abs);
    stored({ copyToDir: abs });
    vi.setSystemTime(Date.now() + 60_000);
    expect((await saveBackupSchedule({ copyToDir: "  " })).copyToDir).toBeNull();
    vi.setSystemTime(Date.now() + 60_000);
    expect((await saveBackupSchedule({ copyToDir: null })).copyToDir).toBeNull();
  });

  it("refuses a relative copyToDir with a 400", async () => {
    await expect(saveBackupSchedule({ copyToDir: "backups/offsite" })).rejects.toMatchObject({
      httpStatus: 400,
      message: expect.stringMatching(/absolute/),
    });
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });

  it("primes the cache with the saved value", async () => {
    await saveBackupSchedule({ enabled: true, intervalHours: 6 });
    stubbed(prisma.setting.findUnique).mockClear();
    expect((await getBackupSchedule()).intervalHours).toBe(6);
    expect(prisma.setting.findUnique).not.toHaveBeenCalled();
  });
});

describe("recordScheduledBackupOutcome", () => {
  it("on success stamps lastRunAt now and clears lastError, keeping operator fields", async () => {
    stored({ enabled: true, intervalHours: 6, passphrase: STRONG, lastRunAt: null, lastError: "old" });
    await recordScheduledBackupOutcome({ ok: true });
    const s = lastSaved();
    expect(s.lastRunAt).toBe(new Date(Date.now()).toISOString());
    expect(s.lastError).toBeNull();
    expect(s).toMatchObject({ enabled: true, intervalHours: 6, passphrase: STRONG });
  });

  it("on failure keeps lastRunAt (so it retries) and records the error", async () => {
    stored({ enabled: true, lastRunAt: "2026-11-01T00:00:00Z" });
    await recordScheduledBackupOutcome({ ok: false, error: "pg_dump exited 1" });
    expect(lastSaved()).toMatchObject({ lastRunAt: "2026-11-01T00:00:00Z", lastError: "pg_dump exited 1" });
  });

  it("caps a long error at 500 characters and names a missing one", async () => {
    await recordScheduledBackupOutcome({ ok: false, error: "x".repeat(2000) });
    expect(lastSaved().lastError).toHaveLength(500);
    vi.setSystemTime(Date.now() + 60_000);
    await recordScheduledBackupOutcome({ ok: false });
    expect(lastSaved().lastError).toBe("unknown error");
  });
});

describe("isScheduledBackupDue — edges", () => {
  const s = (over: Partial<BackupSchedule>): BackupSchedule => ({ ...defaultBackupSchedule(), enabled: true, ...over });

  it("is not due when lastRunAt is in the future (clock moved back)", () => {
    expect(isScheduledBackupDue(s({ lastRunAt: "2026-11-17T00:00:00Z" }), new Date("2026-11-16T00:00:00Z"))).toBe(false);
  });

  it("runs off-hour at exactly twice the interval, not a moment before", () => {
    const now = new Date("2026-11-16T10:00:00Z");
    const pinned = s({ intervalHours: 24, hourUtc: 3 });
    expect(isScheduledBackupDue({ ...pinned, lastRunAt: "2026-11-14T10:00:00Z" }, now)).toBe(true);
    expect(isScheduledBackupDue({ ...pinned, lastRunAt: "2026-11-14T10:00:01Z" }, now)).toBe(false);
  });

  it("pins hour 0 (falsy) like any other hour", () => {
    const pinned = s({ intervalHours: 24, hourUtc: 0, lastRunAt: "2026-11-15T00:00:00Z" });
    expect(isScheduledBackupDue(pinned, new Date("2026-11-16T01:00:00Z"))).toBe(false);
    expect(isScheduledBackupDue(pinned, new Date("2026-11-16T00:30:00Z"))).toBe(true);
  });
});

describe("copyBackupOffHost", () => {
  const root = mkdtempSync(join(tmpdir(), "polaris-bkcopy-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("creates the target directory, copies the file and makes it private", async () => {
    const src = join(root, "src.dump");
    writeFileSync(src, "BACKUP-BYTES");
    const dir = join(root, "share", "nested");
    const dest = await copyBackupOffHost(src, "polaris-2026.dump", dir);
    expect(dest).toBe(join(dir, "polaris-2026.dump"));
    expect(readFileSync(dest, "utf8")).toBe("BACKUP-BYTES");
    expect(priv.makeFilePrivate).toHaveBeenCalledWith(dest);
  });

  it("throws a 500 when the source vanished, creating nothing", async () => {
    const dir = join(root, "never");
    await expect(copyBackupOffHost(join(root, "gone.dump"), "x.dump", dir)).rejects.toMatchObject({ httpStatus: 500 });
    expect(existsSync(dir)).toBe(false);
    expect(priv.makeFilePrivate).not.toHaveBeenCalled();
  });
});
