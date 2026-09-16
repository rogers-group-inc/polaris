/**
 * tests/unit/startupDiskCheckAncestor.test.ts
 *
 * The ancestor fallback and the EACCES-is-a-hit rule — the two halves of
 * "a volume we cannot measure must degrade, not disappear".
 *
 * Regression origin (2026-09, plvcoripam1): PGDATA's parent is mode 0700
 * `postgres` on a PGDG install and Polaris runs as the unprivileged app user,
 * so `statfs()` on the data directory returned EACCES. The error was swallowed
 * and the DB volume dropped out of the scan entirely — `/var` filled to 100%,
 * `pg_upgrade` died of ENOSPC, and the Maintenance card went on reporting
 * "All capacity checks passed" because the filesystem that filled was never in
 * the list to be graded.
 *
 * The permission case cannot be produced for real here: the test process owns
 * the directories it creates, and 0700 grants the owner everything. So the
 * unreachable-path behaviour is driven through a mocked `node:fs/promises`,
 * and the walk itself is additionally exercised against the real filesystem
 * via a path that genuinely does not exist.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const fsMock = vi.hoisted(() => ({
  stat: vi.fn(),
  statfs: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  stat: fsMock.stat,
  statfs: fsMock.statfs,
}));

const { pickFirstExistingPath, statfsWithAncestorFallback } = await import(
  "../../src/utils/startupDiskCheck.js"
);

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** A plausible statfs() result: 1000 blocks of 4 KiB, 250 available. */
const STATFS_OK = { bavail: 250, bsize: 4096, blocks: 1000 };

beforeEach(() => {
  fsMock.stat.mockReset();
  fsMock.statfs.mockReset();
});

describe("pickFirstExistingPath", () => {
  it("treats EACCES as a hit — the path exists, a parent just denies search", async () => {
    fsMock.stat.mockRejectedValueOnce(errno("EACCES"));

    // The 0700-parent case. Skipping to the next candidate here is what made a
    // real PGDATA look absent and left the DB volume out of the scan.
    expect(await pickFirstExistingPath(["/var/lib/pgsql/17/data", "/var/lib/pgsql/15/data"]))
      .toBe("/var/lib/pgsql/17/data");
    expect(fsMock.stat).toHaveBeenCalledTimes(1);
  });

  it("treats EPERM as a hit for the same reason", async () => {
    fsMock.stat.mockRejectedValueOnce(errno("EPERM"));
    expect(await pickFirstExistingPath(["/var/lib/pgsql/17/data"])).toBe("/var/lib/pgsql/17/data");
  });

  it("skips ENOENT and keeps looking", async () => {
    fsMock.stat
      .mockRejectedValueOnce(errno("ENOENT"))
      .mockResolvedValueOnce({ dev: 2049 } as any);

    expect(await pickFirstExistingPath(["/var/lib/pgsql/data", "/var/lib/pgsql/17/data"]))
      .toBe("/var/lib/pgsql/17/data");
    expect(fsMock.stat).toHaveBeenCalledTimes(2);
  });

  it("returns null when every candidate is genuinely absent", async () => {
    fsMock.stat.mockRejectedValue(errno("ENOENT"));
    expect(await pickFirstExistingPath(["/nope/one", "/nope/two"])).toBeNull();
  });
});

describe("statfsWithAncestorFallback", () => {
  it("measures the path itself when reachable, and does not flag degradation", async () => {
    fsMock.statfs.mockResolvedValueOnce(STATFS_OK as any);
    fsMock.stat.mockResolvedValueOnce({ dev: 2049 } as any);

    const r = await statfsWithAncestorFallback("/var/lib/pgsql/17/data");

    expect(r).not.toBeNull();
    expect(r!.degraded).toBe(false);
    expect(r!.measuredPath).toBe("/var/lib/pgsql/17/data");
    expect(r!.dev).toBe(2049);
    expect(r!.totalBytes).toBe(1000 * 4096);
    expect(r!.freeBytes).toBe(250 * 4096);
    expect(r!.freePct).toBeCloseTo(0.25, 5);
  });

  it("walks up to the nearest reachable ancestor and flags the degradation", async () => {
    // EACCES on the data dir and on the 0700 level above it; /var/lib/pgsql
    // itself carries the traverse bit, so the walk lands there.
    fsMock.statfs
      .mockRejectedValueOnce(errno("EACCES"))
      .mockRejectedValueOnce(errno("EACCES"))
      .mockResolvedValueOnce(STATFS_OK as any);
    // Persistent, not Once: Promise.all evaluates stat() on every hop of the
    // walk, including the ones whose statfs() rejects.
    fsMock.stat.mockResolvedValue({ dev: 2049 } as any);

    const r = await statfsWithAncestorFallback("/var/lib/pgsql/17/data");

    expect(r).not.toBeNull();
    expect(r!.degraded).toBe(true);
    expect(r!.measuredPath).toBe("/var/lib/pgsql");
    // Still real numbers for the real filesystem — statfs is mount-level, so
    // an ancestor on the same mount is exact, not an approximation.
    expect(r!.totalBytes).toBe(1000 * 4096);
    expect(r!.dev).toBe(2049);
  });

  it("returns null only when nothing up the chain can be measured", async () => {
    fsMock.statfs.mockRejectedValue(errno("EACCES"));
    expect(await statfsWithAncestorFallback("/var/lib/pgsql/17/data")).toBeNull();
  });

  it("terminates at the filesystem root rather than looping", async () => {
    fsMock.statfs.mockRejectedValue(errno("ENOENT"));
    // dirname() is a fixed point at the root; without the equality check this
    // would spin forever instead of returning.
    await expect(statfsWithAncestorFallback("/")).resolves.toBeNull();
    expect(fsMock.statfs).toHaveBeenCalledTimes(1);
  });
});
