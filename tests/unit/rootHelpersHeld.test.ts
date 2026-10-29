/**
 * tests/unit/rootHelpersHeld.test.ts — business rule 117(g). The root update
 * unit never installs a root helper (a file root executes, or the polkit rule)
 * out of /opt/polaris: the polaris account writes that tree AND may start the
 * unit at will, so installing them there was root on demand (2026-10-13
 * re-scan, F2). A changed helper is HELD in a pending list and installed only
 * by `polaris-update-sync --apply-helpers`, run by an administrator as root.
 *
 * The shell cases run real bash when the host has it (CI does; Git Bash does).
 */

import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../src/db.js", () => ({
  prisma: { $queryRawUnsafe: vi.fn(), $queryRaw: vi.fn() },
  getDirectStatsPool: () => null,
}));

import { parsePendingRootHelpers, ROOT_HELPERS_PENDING_FILE } from "../../src/services/capacityService.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
const SUM = "a".repeat(64);

describe("parsePendingRootHelpers", () => {
  it("reads one path + sha256 per line and skips comments, blanks and junk", () => {
    const text = [
      "# Root helpers changed in /opt/polaris and NOT installed",
      "",
      `/usr/local/sbin/polaris-nginx-apply ${SUM}`,
      `/etc/polkit-1/rules.d/49-polaris.rules ${"B".repeat(64)}`,
      "relative/path " + SUM,
      "/usr/local/sbin/x notahash",
      "garbage",
    ].join("\n");
    expect(parsePendingRootHelpers(text)).toEqual([
      { path: "/usr/local/sbin/polaris-nginx-apply", sha256: SUM },
      { path: "/etc/polkit-1/rules.d/49-polaris.rules", sha256: "b".repeat(64) },
    ]);
  });
  it("the app reads the same file the helper writes", () => {
    expect(read("deploy/scripts/polaris-update-sync.sh")).toContain(`PENDING_DIR=${dirname(ROOT_HELPERS_PENDING_FILE)}`);
  });
});

describe("polaris-update-sync.sh — the in-app sync installs no root helper", () => {
  const src = read("deploy/scripts/polaris-update-sync.sh");
  const code = src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
  it("never passes a root helper to install_if_changed", () => {
    for (const helper of ["polaris-nginx-apply", "polaris-update-sync.sh", "49-polaris.rules", "polaris-ha-role.sh", "polaris-ha-ssh-wrapper", "polaris-ha-role.service", "polaris-ha-role.timer", "patroni.service.d"]) {
      const bad = code.split("\n").filter((l) => /install_if_changed/.test(l) && l.includes(helper));
      expect(bad, helper).toEqual([]);
    }
  });
  it("routes every one of them through root_helper", () => {
    for (const helper of ["polaris-nginx-apply.sh", "polaris-update-sync.sh", "49-polaris.rules", "polaris-ha-role.sh", "polaris-ha-ssh-wrapper.sh", "polaris-ha-role.service", "polaris-ha-role.timer", "patroni.service.d/10-polaris.conf"]) {
      expect(code, helper).toContain(helper);
    }
    expect(code).toMatch(/root_helpers\s*\n\s*write_pending/);
  });
  it("update-linux.sh routes root files through the installed helper's --install, asking unless the admin passed --yes (rule 117(k))", () => {
    const src = read("deploy/update-linux.sh");
    expect(src).toMatch(/"\$SYNC_HELPER" --install "\$\{yes\[@\]\}"/);
    expect(src).toMatch(/\[\[ \$ASSUME_YES -eq 1 \]\] && yes=\(--yes\)/);
    expect(src).not.toMatch(/--apply-helpers --yes/);
  });
});

describe("update-linux.sh — the pre-update dump is private (F57)", () => {
  const src = read("deploy/update-linux.sh");
  it("keeps the backup directory 0700 and writes the dump under umask 077", () => {
    expect(src).toMatch(/install -d -m 0700 -o "\$APP_USER" -g "\$APP_USER" "\$BACKUP_DIR"/);
    expect(src).toMatch(/\( umask 077; sudo -u postgres "\$PG_DUMP"/);
  });
});

// Spawns bash per case; the 5 s default is crossed under full-suite load.
describe.skipIf(!hasBash)("root_helper / write_pending", { timeout: 30_000 }, () => {
  const script = join(ROOT, "deploy/scripts/polaris-update-sync.sh").replace(/\\/g, "/");
  // A fake tree and install root; `install -o/-g` and logger are stubbed so it
  // runs unprivileged. Prints one line per check.
  const harness = `
set -u
logger() { :; }
install() { local a=(); while [[ $# -gt 0 ]]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; command install "\${a[@]}"; }
POLARIS_UPDATE_SYNC_LIB=1 source "$1"
T=$(mktemp -d); WORK="$T/w"; mkdir -p "$WORK" "$T/src" "$T/inst"
PENDING_DIR="$T/state"; PENDING_FILE="$PENDING_DIR/pending"
echo v1 > "$T/src/h"; echo v1 > "$T/inst/h"
MODE=sync; PENDING=(); root_helper "$T/src/h" "$T/inst/h" 0755 >/dev/null; write_pending
[[ -f "$PENDING_FILE" ]] && echo unchanged=held || echo unchanged=clear
echo evil > "$T/src/h"
PENDING=(); root_helper "$T/src/h" "$T/inst/h" 0755 >/dev/null; write_pending
echo "sync_installed=$([[ $(cat "$T/inst/h") == evil ]] && echo yes || echo no)"
echo "listed=$(grep -c "$T/inst/h " "$PENDING_FILE")"
MODE=apply; ASSUME_YES=1; PENDING=(); root_helper "$T/src/h" "$T/inst/h" 0755 >/dev/null; write_pending
echo "apply_installed=$([[ $(cat "$T/inst/h") == evil ]] && echo yes || echo no)"
echo "pending_after_apply=$([[ -f "$PENDING_FILE" ]] && echo yes || echo no)"
rm -rf "$T"
`;
  it("holds a changed helper in sync mode and installs it only on --apply-helpers", () => {
    const r = spawnSync("bash", ["-c", harness, "_", script], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim().split(/\r?\n/)).toEqual([
      "unchanged=clear",
      "sync_installed=no",
      "listed=1",
      "apply_installed=yes",
      "pending_after_apply=no",
    ]);
  });
});
