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

// pg_dump refuses a server newer than itself. On 2026-09-09 prod's /usr/bin/pg_dump
// was a PostgreSQL 13 client in front of a 15 server, and `command -v` was
// satisfied. The script must resolve both tools by the server's major (mirroring
// src/utils/pgClientTools.ts) and never call them by bare name for the dump or
// the restore.
describe("update-linux.sh resolves pg_dump / psql by the server's major", () => {
  it("defines the resolver and uses its answers for the dump and every restore call", () => {
    expect(linux).toMatch(/^resolve_pg_tool\(\) \{/m);
    expect(linux).toMatch(/^PG_DUMP=\$\(resolve_pg_tool pg_dump/m);
    expect(linux).toMatch(/^PSQL=\$\(resolve_pg_tool psql/m);
    expect(linux).toMatch(/sudo -u postgres "\$PG_DUMP" --clean --if-exists/);
    // Command lines only. The server-major probe may use any psql (it is asking,
    // not dumping), and an operator-facing `error "Run it by hand: … psql …"`
    // message is text a human will type, not a spawn.
    const bare = codeLines(linux).filter(
      (l) =>
        /sudo -u postgres (pg_dump|psql) /.test(l) &&
        !/SHOW server_version_num/.test(l) &&
        !/^\s*(error|warn|info) "/.test(l),
    );
    expect(bare).toEqual([]);
  });

  it("refuses the dump with the versions and the fix when the client is older than the server", () => {
    expect(linux).toMatch(/"\$PG_DUMP_MAJOR" -lt "\$PG_SERVER_MAJOR"/);
    expect(linux).toMatch(/pg_dump is PostgreSQL \$\{PG_DUMP_MAJOR\}.*server is PostgreSQL \$\{PG_SERVER_MAJOR\}/);
  });
});

// One backup directory — the app's (<state>/data/backups). Two directories with
// two retention rules cost real time on 2026-09-09.
describe("both scripts write pre-update backups beside the app's own", () => {
  it("linux: data/backups, created owned by the app user", () => {
    expect(linux).toMatch(/^BACKUP_DIR="\/opt\/polaris\/data\/backups"/m);
    expect(linux).toMatch(/install -d -o "\$APP_USER" -g "\$APP_USER" "\$BACKUP_DIR"/);
  });

  it("windows: data\\backups", () => {
    expect(windows).toMatch(/\$backupDir = Join-Path \$AppDir "data\\backups"/);
  });
});

// `npx prisma` falls through to the registry when the local binary is missing,
// and in a non-TTY it installs without asking. On 2026-09-09 an operator in the
// wrong directory was offered prisma@8.0.0-rc.13 against a Prisma 7 database;
// only the prompt stood in the way. The updaters call the project's own CLI by
// path so a half-populated node_modules fails with ENOENT instead.
describe("both scripts run the project's own Prisma CLI, never npx", () => {
  it("linux", () => {
    expect(codeLines(linux).filter((l) => /npx prisma/.test(l))).toEqual([]);
    expect(linux).toMatch(/node node_modules\/prisma\/build\/index\.js generate/);
    expect(linux).toMatch(/node node_modules\/prisma\/build\/index\.js migrate deploy/);
  });

  it("windows", () => {
    expect(codeLines(windows).filter((l) => /npx prisma/.test(l))).toEqual([]);
    expect(windows).toMatch(/node node_modules\/prisma\/build\/index\.js generate/);
    expect(windows).toMatch(/node node_modules\/prisma\/build\/index\.js migrate deploy/);
  });
});

// A Polaris database with TimescaleDB must be restored between
// timescaledb_pre_restore() and timescaledb_post_restore(), each in its own
// psql session. The in-app restore learned this in 2026-08; both scripts kept a
// bare `psql --single-transaction 2>/dev/null` (then reported success
// unconditionally) until 2026-09-09.
describe("the rollback restore is TimescaleDB-aware and reports honestly", () => {
  it("linux: restores through restore_database(), with both gates, and never discards psql's stderr", () => {
    expect(linux).toMatch(/^restore_database\(\) \{/m);
    expect(linux).toMatch(/restore_database "\$BACKUP_FILE"/);
    expect(linux).toMatch(/SELECT timescaledb_pre_restore\(\);/);
    expect(linux).toMatch(/SELECT timescaledb_post_restore\(\);/);
    const silenced = codeLines(linux).filter((l) => /psql/.test(l) && /2>\/dev\/null/.test(l) && /single-transaction/.test(l));
    expect(silenced).toEqual([]);
  });

  it("windows: restores through Restore-Database, with both gates, and the dead pg_restore probe is gone", () => {
    expect(windows).toMatch(/^function Restore-Database \{/m);
    expect(windows).toMatch(/Restore-Database -DumpFile \$BackupFile/);
    expect(windows).toMatch(/SELECT timescaledb_pre_restore\(\);/);
    expect(windows).toMatch(/SELECT timescaledb_post_restore\(\);/);
    expect(windows).not.toMatch(/pg_restore\.exe/);
    const silenced = codeLines(windows).filter((l) => /psql/.test(l) && /2>\$null/.test(l) && /single-transaction/.test(l));
    expect(silenced).toEqual([]);
  });
});
