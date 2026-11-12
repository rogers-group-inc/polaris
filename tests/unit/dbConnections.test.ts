/**
 * tests/unit/dbConnections.test.ts
 *
 * PgBouncer awareness: the direct URL falls back to DATABASE_URL; the mode is
 * "pgbouncer" when POLARIS_DB_DIRECT_URL differs from DATABASE_URL or
 * DATABASE_URL carries pgbouncer=true, else "direct".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDirectDatabaseUrl, getDbConnectionMode, isPgbouncerMode } from "../../src/utils/dbConnections.js";

const saved = { DATABASE_URL: process.env.DATABASE_URL, POLARIS_DB_DIRECT_URL: process.env.POLARIS_DB_DIRECT_URL };
function setEnv(db?: string, direct?: string) {
  if (db === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = db;
  if (direct === undefined) delete process.env.POLARIS_DB_DIRECT_URL; else process.env.POLARIS_DB_DIRECT_URL = direct;
}

beforeEach(() => setEnv());
afterEach(() => setEnv(saved.DATABASE_URL, saved.POLARIS_DB_DIRECT_URL));

const PG = "postgresql://u:p@db:5432/polaris";
const BOUNCER = "postgresql://u:p@bouncer:6432/polaris";

describe("getDirectDatabaseUrl", () => {
  it("prefers POLARIS_DB_DIRECT_URL", () => {
    setEnv(BOUNCER, PG);
    expect(getDirectDatabaseUrl()).toBe(PG);
  });

  it("falls back to DATABASE_URL, then empty", () => {
    setEnv(PG);
    expect(getDirectDatabaseUrl()).toBe(PG);
    setEnv(PG, "");
    expect(getDirectDatabaseUrl()).toBe(PG);
    setEnv();
    expect(getDirectDatabaseUrl()).toBe("");
  });
});

describe("getDbConnectionMode / isPgbouncerMode", () => {
  it("is direct for a single-URL install", () => {
    setEnv(PG);
    expect(getDbConnectionMode()).toBe("direct");
    expect(isPgbouncerMode()).toBe(false);
  });

  it("is direct when the direct URL equals DATABASE_URL", () => {
    setEnv(PG, PG);
    expect(getDbConnectionMode()).toBe("direct");
  });

  it("is pgbouncer when the direct URL differs", () => {
    setEnv(BOUNCER, PG);
    expect(getDbConnectionMode()).toBe("pgbouncer");
    expect(isPgbouncerMode()).toBe(true);
  });

  it("is pgbouncer when DATABASE_URL carries pgbouncer=true", () => {
    setEnv(`${BOUNCER}?pgbouncer=true`);
    expect(getDbConnectionMode()).toBe("pgbouncer");
  });

  it("is direct with nothing configured", () => {
    expect(getDbConnectionMode()).toBe("direct");
  });
});
