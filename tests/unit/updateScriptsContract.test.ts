/**
 * tests/unit/updateScriptsContract.test.ts
 *
 * Structural guards over the two operator-facing fallback updaters,
 * deploy/update-linux.sh and deploy/update-windows.ps1. They are shell, so
 * nothing in `npm test` exercises them — and on 2026-09-09 the Linux one turned
 * out to have been a silent no-op on every standard install since it was
 * written: its two `git rev-parse` calls ran as root against a checkout owned
 * by the app user, git refused ("dubious ownership"), `2>/dev/null || echo
 * unknown` hid that, and "unknown" == "unknown" made the "already up to date"
 * branch fire unconditionally with exit 0.
 *
 * These tests read the scripts as text and pin the shape of the fix, the same
 * way scripts/check-versions.mjs pins version declarations: cheap, no shell
 * required, and loud the moment someone reintroduces a bare `git` call.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const linux = readFileSync(join(ROOT, "deploy", "update-linux.sh"), "utf8");
const windows = readFileSync(join(ROOT, "deploy", "update-windows.ps1"), "utf8");

/** Code lines only — a comment quoting the bad pattern must not trip the guard. */
function codeLines(src: string): string[] {
  return src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
}

describe("update-linux.sh — git runs as the app user", () => {
  it("never captures a commit from a bare `git` call (root cannot read the app user's checkout)", () => {
    const offenders = codeLines(linux).filter((l) => /=\$\(\s*git\s/.test(l));
    expect(offenders).toEqual([]);
  });

  it("reads both the before and after commit as the app user", () => {
    const revParse = codeLines(linux).filter((l) => /git rev-parse --short HEAD/.test(l));
    expect(revParse.length).toBeGreaterThanOrEqual(2);
    for (const l of revParse) expect(l).toMatch(/sudo -u "\$APP_USER" git rev-parse/);
  });
});

describe("the 'already up to date' exit is guarded in both scripts", () => {
  it("linux: an unknown commit on either side keeps going instead of declaring success", () => {
    expect(linux).toMatch(/"\$OLD_COMMIT" == "unknown" \|\| "\$NEW_COMMIT" == "unknown"/);
  });

  it("linux: --force finishes an update whose pull already happened", () => {
    expect(linux).toMatch(/--force\)\s+FORCE=1/);
    expect(linux).toMatch(/"\$OLD_COMMIT" == "\$NEW_COMMIT" && "\$FORCE" -eq 0/);
  });

  it("windows: a failed rev-parse is normalised to the sentinel, not compared as $null", () => {
    expect(windows).toMatch(/if \(-not \$OldCommit\) \{ \$OldCommit = "unknown" \}/);
    expect(windows).toMatch(/if \(-not \$NewCommit\) \{ \$NewCommit = "unknown" \}/);
    expect(windows).toMatch(/\$OldCommit -eq "unknown" -or \$NewCommit -eq "unknown"/);
  });

  it("windows: -Force mirrors --force", () => {
    expect(windows).toMatch(/\[switch\]\$Force/);
    expect(windows).toMatch(/\$OldCommit -eq \$NewCommit -and -not \$Force/);
  });
});
