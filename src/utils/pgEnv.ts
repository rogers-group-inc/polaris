/**
 * src/utils/pgEnv.ts — turn a PostgreSQL connection URL into libpq PG* env vars.
 *
 * Why this exists: `pg_dump` and `psql` used to receive the connection string as
 * a command-line argument. Two problems with that, both real:
 *
 *   1. The full URL — password included — is visible in the process table to
 *      every local user (`ps aux`), and lands in any process listing, audit
 *      trail, or core dump for the duration of the dump.
 *   2. The backup route built the command as an interpolated shell string, so
 *      the same URL also reached a shell, and Node's child_process error message
 *      is literally `Command failed: <the whole command>`. That message was
 *      being concatenated into an AppError and returned in the HTTP response.
 *
 * libpq reads PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE / PGSSLMODE
 * from the environment, so passing them that way keeps the credential out of
 * argv entirely while changing nothing about how the tools connect.
 *
 * The one thing that does NOT carry over unchanged is the value of `sslmode`.
 * DATABASE_URL is a *driver* URL — node-postgres reads it, and node-postgres
 * accepts `no-verify`, which libpq does not. The first-run wizard writes exactly
 * that whenever the operator ticks "Allow self-signed certificate"
 * (`setup/setupRoutes.ts → buildConnectionString`), so on 2026-09-11 a Docker
 * install created that way had every backup fail on
 * `pg_dump: error: invalid sslmode value: "no-verify"` — manual, scheduled and
 * pre-update alike, plus restore, since psql gets the same overlay. The
 * parameter NAME is shared between the two connection vocabularies; the value
 * space is not, so it is translated rather than copied.
 *
 * Pure and dependency-free so it can be unit-tested without a database.
 */

import { AppError } from "./errors.js";

export interface PgEnv {
  PGHOST: string;
  PGPORT: string;
  PGUSER: string;
  PGPASSWORD: string;
  PGDATABASE: string;
  PGSSLMODE?: string;
  /** Set only when the URL pins a non-default schema (Prisma's `?schema=`). */
  PGOPTIONS?: string;
}

/** The complete `sslmode` value space libpq accepts. Anything else kills the child. */
const LIBPQ_SSLMODES = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]);

/**
 * Driver-only `sslmode` values → their libpq equivalent.
 *
 * `no-verify` is node-postgres for "encrypt, but do not validate the chain",
 * which is precisely libpq's `require` — only `verify-ca` and `verify-full`
 * check the certificate, so the translation preserves the security posture
 * exactly rather than trading it for a working dump.
 */
const DRIVER_SSLMODE_ALIASES: Record<string, string> = {
  "no-verify": "require",
};

/**
 * One `sslmode` value from a driver URL → the value libpq understands.
 *
 * Throws rather than dropping an unrecognized value: omitting PGSSLMODE lets
 * libpq fall back to `prefer`, which would silently downgrade an operator who
 * asked for TLS to opportunistic TLS. A named refusal is recoverable; a backup
 * that quietly connected in the clear is not.
 */
export function libpqSslMode(value: string): string {
  const v = value.trim().toLowerCase();
  const translated = DRIVER_SSLMODE_ALIASES[v] ?? v;
  if (!LIBPQ_SSLMODES.has(translated)) {
    throw new AppError(
      500,
      `The database URL sets sslmode="${value}", which PostgreSQL's client tools do not accept. ` +
        `Use one of: ${[...LIBPQ_SSLMODES].join(", ")}.`,
    );
  }
  return translated;
}

/**
 * Parse a `postgresql://user:pass@host:port/db?params` URL into the PG* overlay.
 *
 * Handles the shapes Polaris actually produces and accepts:
 *   - percent-encoded credentials (a password with `@`, `/` or `:` in it)
 *   - the `postgres://` scheme alias
 *   - Prisma's extra query params (`schema`, `connection_limit`, `pgbouncer`,
 *     `sslmode`) — only `schema` and `sslmode` mean anything to libpq, and
 *     `sslmode`'s value is translated, not copied (see the file header)
 *   - a missing port (defaults to 5432)
 *
 * Throws AppError 500 on an unusable URL rather than returning a half-built
 * environment that would make pg_dump fail with something inscrutable.
 */
export function pgEnvFromDatabaseUrl(rawUrl: string): PgEnv {
  if (!rawUrl) {
    throw new AppError(500, "No database URL is configured (DATABASE_URL / POLARIS_DB_DIRECT_URL)");
  }

  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new AppError(500, "The configured database URL could not be parsed");
  }

  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") {
    throw new AppError(500, `Unsupported database URL scheme "${u.protocol.replace(":", "")}"`);
  }

  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!database) {
    throw new AppError(500, "The configured database URL does not name a database");
  }

  const env: PgEnv = {
    PGHOST: decodeURIComponent(u.hostname),
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: database,
  };

  const sslmode = u.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = libpqSslMode(sslmode);

  // Prisma's `?schema=` sets the search_path for application queries. libpq has
  // no equivalent variable, but PGOPTIONS is forwarded as backend options, and
  // `-c search_path=` is how psql/pg_dump are pointed at a non-public schema.
  const schema = u.searchParams.get("schema");
  if (schema && schema !== "public") env.PGOPTIONS = `-c search_path=${schema}`;

  return env;
}

/**
 * Build the full child-process environment for a pg_dump / psql / pg_restore
 * invocation: the current environment with the PG* overlay applied.
 *
 * Any PG* variable already present in process.env is deliberately overwritten —
 * the URL is the source of truth, and a stray inherited PGDATABASE silently
 * dumping the wrong database is exactly the failure this prevents.
 */
export function pgChildEnv(rawUrl: string): NodeJS.ProcessEnv {
  return { ...process.env, ...pgEnvFromDatabaseUrl(rawUrl) };
}

/**
 * Redact the password from a connection URL so it can appear in a log line.
 * Never use the raw URL in an operator-facing message.
 */
export function redactDatabaseUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable database URL>";
  }
}
