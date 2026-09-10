/**
 * tests/unit/version.test.ts
 *
 * src/utils/version.ts — the running process's identity. `getAppVersion()` is
 * `<major>.<minor>.<commit count>`; `getRunningCommit()` is HEAD's SHA captured
 * at boot, which the in-app updater compares against the checkout so a pulled-
 * but-never-installed update still reads as available (prod, 2026-09-10).
 * Both are computed once at module load, so this runs against the real tree.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getAppVersion, getRunningCommit } from "../../src/utils/version.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function git(cmd: string): string {
  return execSync(cmd, { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

describe("getAppVersion", () => {
  it("is <major>.<minor> from package.json plus a numeric patch", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    const [major, minor] = String(pkg.version).split(".");
    const v = getAppVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(v.startsWith(`${major}.${minor}.`)).toBe(true);
  });

  it("takes the patch from the commit count of this checkout", () => {
    // Skipped where the baked count wins (the Docker build) — the fallback
    // order is documented in the module header.
    if (process.env.POLARIS_BUILD_COMMIT_COUNT) return;
    const count = git("git rev-list --count HEAD");
    expect(getAppVersion().split(".")[2]).toBe(count);
  });
});

describe("getRunningCommit", () => {
  it("is HEAD's full SHA in a git checkout", () => {
    const head = git("git rev-parse HEAD");
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(getRunningCommit()).toBe(head);
  });

  it("is a plain hex string or null — never anything a shell could act on", () => {
    const sha = getRunningCommit();
    expect(sha === null || /^[0-9a-f]{40}$/.test(sha)).toBe(true);
  });
});
