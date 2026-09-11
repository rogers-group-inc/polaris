/**
 * tests/unit/pgEnv.test.ts
 *
 * Connection URL → libpq PG* environment. This exists because pg_dump and psql
 * used to take the connection string as an ARGV element, which put the database
 * password in `ps aux` output for the duration of every backup, and — since the
 * backup route built the command as an interpolated shell string — into Node's
 * `Command failed: <command>` error message, which was being returned in the
 * HTTP response body.
 *
 * The percent-encoding case is the one most likely to regress: a generated DB
 * password containing `@`, `/` or `:` must decode back to the real password, or
 * every backup fails authentication.
 */

import { describe, it, expect } from "vitest";
import { pgEnvFromDatabaseUrl, pgChildEnv, redactDatabaseUrl, libpqSslMode } from "../../src/utils/pgEnv.js";
import { AppError } from "../../src/utils/errors.js";

describe("pgEnvFromDatabaseUrl", () => {
  it("maps the standard Polaris URL onto PG* vars", () => {
    const env = pgEnvFromDatabaseUrl("postgresql://polaris:pw@db.example.com:5433/polaris");
    expect(env).toEqual({
      PGHOST: "db.example.com",
      PGPORT: "5433",
      PGUSER: "polaris",
      PGPASSWORD: "pw",
      PGDATABASE: "polaris",
    });
  });

  it("defaults the port to 5432 when the URL omits it", () => {
    expect(pgEnvFromDatabaseUrl("postgresql://u:p@localhost/polaris").PGPORT).toBe("5432");
  });

  it("accepts the postgres:// scheme alias", () => {
    expect(pgEnvFromDatabaseUrl("postgres://u:p@localhost/polaris").PGDATABASE).toBe("polaris");
  });

  it("percent-decodes credentials containing URL-significant characters", () => {
    // A password with @ / : in it is the case that silently breaks a naive
    // string split and makes every backup fail to authenticate.
    const env = pgEnvFromDatabaseUrl(
      "postgresql://pol%40ris:p%40ss%2Fwo%3Ard@localhost:5432/polaris",
    );
    expect(env.PGUSER).toBe("pol@ris");
    expect(env.PGPASSWORD).toBe("p@ss/wo:rd");
  });

  it("forwards sslmode and ignores Prisma's own query params", () => {
    const env = pgEnvFromDatabaseUrl(
      "postgresql://u:p@h:5432/polaris?sslmode=require&connection_limit=25&pgbouncer=true",
    );
    expect(env.PGSSLMODE).toBe("require");
    expect(env).not.toHaveProperty("PGOPTIONS");
  });

  it("translates the wizard's sslmode=no-verify into a value libpq accepts", () => {
    // The self-signed toggle in the first-run wizard writes `no-verify`, which is
    // node-postgres vocabulary. Copied through verbatim it made every pg_dump
    // exit 1 with `invalid sslmode value: "no-verify"` — manual, scheduled and
    // pre-update backups, and restore, on every install that ticked the box.
    const env = pgEnvFromDatabaseUrl("postgresql://u:p@h:5432/polaris?sslmode=no-verify");
    expect(env.PGSSLMODE).toBe("require");
  });

  it("translates a non-public schema into PGOPTIONS search_path", () => {
    // libpq has no PGSCHEMA; PGOPTIONS is how psql/pg_dump reach a custom schema.
    const env = pgEnvFromDatabaseUrl("postgresql://u:p@h/polaris?schema=polaris_app");
    expect(env.PGOPTIONS).toBe("-c search_path=polaris_app");
    // schema=public is the default and needs no override.
    expect(pgEnvFromDatabaseUrl("postgresql://u:p@h/polaris?schema=public")).not.toHaveProperty("PGOPTIONS");
  });

  it("refuses an sslmode libpq cannot use rather than dropping it", () => {
    // Dropping it would let libpq fall back to `prefer` — an operator who asked
    // for TLS would get opportunistic TLS and no warning.
    expect(() => pgEnvFromDatabaseUrl("postgresql://u:p@h/polaris?sslmode=verify_full")).toThrow(AppError);
    expect(() => pgEnvFromDatabaseUrl("postgresql://u:p@h/polaris?sslmode=yes")).toThrow(/sslmode/);
  });

  it("throws a clear AppError rather than half-building an env", () => {
    // A half-built environment makes pg_dump fail with something inscrutable.
    expect(() => pgEnvFromDatabaseUrl("")).toThrow(AppError);
    expect(() => pgEnvFromDatabaseUrl("not a url")).toThrow(AppError);
    expect(() => pgEnvFromDatabaseUrl("mysql://u:p@h/db")).toThrow(AppError);
    expect(() => pgEnvFromDatabaseUrl("postgresql://u:p@h/")).toThrow(AppError);
  });
});

describe("pgChildEnv", () => {
  it("overrides any inherited PG* var rather than letting it win", () => {
    // A stray inherited PGDATABASE silently dumping the wrong database is
    // exactly the failure this overwrite prevents.
    const saved = process.env.PGDATABASE;
    process.env.PGDATABASE = "some_other_db";
    try {
      const env = pgChildEnv("postgresql://u:p@h/polaris");
      expect(env.PGDATABASE).toBe("polaris");
    } finally {
      if (saved === undefined) delete process.env.PGDATABASE;
      else process.env.PGDATABASE = saved;
    }
  });

  it("preserves the rest of the parent environment", () => {
    const env = pgChildEnv("postgresql://u:p@h/polaris");
    expect(env.PATH).toBe(process.env.PATH);
  });
});

describe("redactDatabaseUrl", () => {
  it("removes the password so a URL can appear in a log line", () => {
    const out = redactDatabaseUrl("postgresql://polaris:sup3rs3cret@h:5432/polaris");
    expect(out).not.toContain("sup3rs3cret");
    expect(out).toContain("polaris");
    expect(out).toContain("***");
  });

  it("does not throw on an unparseable URL", () => {
    expect(redactDatabaseUrl("garbage")).toBe("<unparseable database URL>");
  });
});

describe("libpqSslMode", () => {
  it("passes every value libpq actually accepts straight through", () => {
    for (const mode of ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]) {
      expect(libpqSslMode(mode)).toBe(mode);
    }
  });

  it("maps no-verify onto require, which has the same security posture", () => {
    // libpq's `require` encrypts without validating the chain — only verify-ca
    // and verify-full check the certificate. So this is a rename, not a
    // downgrade, and a self-signed server keeps working.
    expect(libpqSslMode("no-verify")).toBe("require");
    expect(libpqSslMode("  NO-VERIFY  ")).toBe("require");
  });

  it("names the offending value when it cannot be translated", () => {
    // The operator has to be able to find it in their DATABASE_URL.
    expect(() => libpqSslMode("no_verify")).toThrow(/no_verify/);
  });
});
