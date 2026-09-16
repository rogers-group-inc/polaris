/**
 * tests/unit/startupDiskCheck.test.ts — probeDiskFree (the shared statfs math).
 */

import { join } from "node:path";

import { describe, it, expect } from "vitest";
import { probeDiskFree, statfsWithAncestorFallback } from "../../src/utils/startupDiskCheck.js";

describe("probeDiskFree", () => {
  it("probes a real path and returns coherent numbers", async () => {
    const p = await probeDiskFree(process.cwd());
    expect(p).not.toBeNull();
    expect(p!.totalBytes).toBeGreaterThan(0);
    expect(p!.freeBytes).toBeGreaterThanOrEqual(0);
    expect(p!.freeBytes).toBeLessThanOrEqual(p!.totalBytes);
    expect(p!.freePct).toBeGreaterThanOrEqual(0);
    expect(p!.freePct).toBeLessThanOrEqual(1);
  });

  it("returns null for a nonexistent path", async () => {
    expect(await probeDiskFree("/definitely/not/a/real/path/xyz")).toBeNull();
  });
});

describe("statfsWithAncestorFallback against the real filesystem", () => {
  it("walks up from an unreachable descendant and reports the same filesystem", async () => {
    const deep = join(process.cwd(), "no-such-dir-8f3a1c", "deeper", "still-nothing");

    const walked = await statfsWithAncestorFallback(deep);
    const direct = await probeDiskFree(process.cwd());

    expect(walked).not.toBeNull();
    expect(direct).not.toBeNull();
    expect(walked!.degraded).toBe(true);
    expect(walked!.measuredPath).toBe(process.cwd());
    // The point of the fallback: an ancestor on the same mount answers with
    // exactly the same filesystem-level numbers, so degrading costs accuracy
    // only when PGDATA is its own mount.
    expect(walked!.totalBytes).toBe(direct!.totalBytes);
  });

  it("measures a reachable path directly, with no degradation flag", async () => {
    const r = await statfsWithAncestorFallback(process.cwd());
    expect(r).not.toBeNull();
    expect(r!.degraded).toBe(false);
    expect(r!.measuredPath).toBe(process.cwd());
  });
});
