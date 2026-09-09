/**
 * src/utils/pgClientTools.ts — pick the PostgreSQL client binary that can talk
 * to the server, by MAJOR, never by bare name.
 *
 * Why this exists: `pg_dump` refuses to dump a server newer than itself. On
 * 2026-09-09 prod's `/usr/bin/pg_dump` was RHEL's AppStream PostgreSQL 13
 * client — a leftover of an earlier installer — sitting in front of a PGDG 15
 * server. `alternatives --display` said the link pointed at 15; the file on
 * disk was a regular binary owned by the 13 package. `command -v pg_dump` found
 * it, the Platform Lifecycle card graded the SERVER (correctly, 15.18), and
 * every backup — manual, scheduled, pre-update — failed with
 * "server version mismatch", surfaced to the operator only as "see the server
 * log". The stated PG15 floor was asserted in fourteen places and checked in
 * none of the places that spawn a client.
 *
 * So: resolve `/usr/pgsql-<major>/bin/<tool>` (PGDG, RHEL) or
 * `/usr/lib/postgresql/<major>/bin/<tool>` (Debian/Ubuntu) or the Windows
 * install dir for the server's major first, accept a NEWER major (pg_dump is
 * backward compatible), and fall back to PATH only when nothing versioned
 * exists. Then verify with `--version` before trusting it.
 *
 * Pure and dependency-free (filesystem access is injected) so it is unit-
 * testable without a database or the client tools. backupService owns the
 * probe and the server query; deploy/update-linux.sh carries the same logic
 * in shell (`resolve_pg_tool`).
 */

export type PgTool = "pg_dump" | "psql";

/** How many majors above the server's to accept before falling back to PATH. */
const NEWER_MAJORS_ACCEPTED = 5;

/**
 * `pg_dump (PostgreSQL) 13.23`                          → 13
 * `psql (PostgreSQL) 15.18 (Debian 15.18-1.pgdg120+1)`  → 15
 * `pg_dump (PostgreSQL) 9.6.24`                         → 9
 */
export function parsePgToolMajor(versionOutput: string): number | null {
  const m = String(versionOutput).match(/\(PostgreSQL\)\s+(\d+)(?:\.\d+)*/i)
    ?? String(versionOutput).match(/\b(\d+)\.\d+(?:\.\d+)?\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * `SHOW server_version_num` → major. 150018 → 15, 90624 → 9, "16.3" → 16.
 * Accepts the number, its string, or a dotted version, because callers get it
 * from different places (a GUC read, a parsed banner, a config file).
 */
export function pgMajorFromServerVersion(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (/^\d{5,6}$/.test(s)) {
    // 6 digits since PostgreSQL 10 (MMmmpp); 5 for 9.x (Mmmpp).
    const major = s.length === 6 ? Number(s.slice(0, 2)) : Number(s.slice(0, 1));
    return major > 0 ? major : null;
  }
  const dotted = s.match(/^(\d+)(?:\.\d+)*/);
  if (dotted) {
    const n = Number(dotted[1]);
    return n > 0 ? n : null;
  }
  return null;
}

export interface PgToolCandidateOptions {
  platform?: NodeJS.Platform;
}

/**
 * Ordered candidate paths for `tool`: the server's own major first, then each
 * newer major up to NEWER_MAJORS_ACCEPTED above it, across the layouts the
 * supported platforms use. The bare name is deliberately NOT in this list — the
 * resolver appends it as the last resort so callers can tell the two apart.
 */
export function pgToolCandidates(tool: PgTool, serverMajor: number, opts: PgToolCandidateOptions = {}): string[] {
  const platform = opts.platform ?? process.platform;
  if (!Number.isFinite(serverMajor) || serverMajor <= 0) return [];
  const out: string[] = [];
  for (let m = serverMajor; m <= serverMajor + NEWER_MAJORS_ACCEPTED; m++) {
    if (platform === "win32") {
      out.push(`C:\\Program Files\\PostgreSQL\\${m}\\bin\\${tool}.exe`);
    } else {
      out.push(`/usr/pgsql-${m}/bin/${tool}`);          // PGDG on RHEL / Rocky / Alma
      out.push(`/usr/lib/postgresql/${m}/bin/${tool}`); // Debian / Ubuntu
      if (platform === "darwin") {
        out.push(`/opt/homebrew/opt/postgresql@${m}/bin/${tool}`);
        out.push(`/usr/local/opt/postgresql@${m}/bin/${tool}`);
      }
    }
  }
  return out;
}

export interface ResolvedPgToolPath {
  path: string;
  /** "versioned-dir" when a per-major install dir was found; "path" when falling back to the bare name. */
  source: "versioned-dir" | "path";
}

/**
 * First candidate that exists, else the bare name (whatever PATH resolves —
 * which is exactly the thing this module exists to stop trusting blindly, so a
 * "path" result should always be followed by a `--version` probe).
 */
export function resolvePgToolPath(
  tool: PgTool,
  serverMajor: number | null,
  exists: (p: string) => boolean,
  opts: PgToolCandidateOptions = {},
): ResolvedPgToolPath {
  if (serverMajor != null) {
    for (const candidate of pgToolCandidates(tool, serverMajor, opts)) {
      if (exists(candidate)) return { path: candidate, source: "versioned-dir" };
    }
  }
  return { path: tool, source: "path" };
}

/**
 * pg_dump refuses a server newer than itself, so it needs client >= server.
 * psql only warns ("Some psql features might not work") and restores fine, so
 * any major is usable — callers may still prefer the matched one.
 */
export function pgClientCompatible(tool: PgTool, clientMajor: number, serverMajor: number): boolean {
  if (tool === "pg_dump") return clientMajor >= serverMajor;
  return true;
}

/**
 * The line the operator needs — both versions, the path, why it matters, and
 * the fix. Every word of it was missing from "Database backup failed — see the
 * server log for details".
 */
export function describePgClientMismatch(tool: PgTool, clientMajor: number, serverMajor: number, path: string): string {
  return (
    `${tool} is PostgreSQL ${clientMajor} (${path}) but the server is PostgreSQL ${serverMajor}. ` +
    `pg_dump refuses to dump a server newer than itself, so backups cannot run until a matching client is installed — ` +
    `on RHEL: dnf install postgresql${serverMajor} (PGDG), then check that /usr/bin/${tool} is not owned by the AppStream ` +
    `"postgresql" package (rpm -qf /usr/bin/${tool}); on Debian/Ubuntu: apt-get install postgresql-client-${serverMajor}. ` +
    `See docs/INSTALL.md → "pg_dump: server version mismatch".`
  );
}
