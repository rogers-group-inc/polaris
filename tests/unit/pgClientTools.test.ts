/**
 * tests/unit/pgClientTools.test.ts
 *
 * Resolving a PostgreSQL client binary by the SERVER's major. The 2026-09-09
 * prod incident this guards against: `/usr/bin/pg_dump` was RHEL's AppStream 13
 * client in front of a PGDG 15 server, `command -v` found it, and every backup
 * failed with a version mismatch the operator never saw. The resolver must
 * prefer the per-major install dir, accept a newer client, and fall back to
 * PATH only when nothing versioned exists — and the compatibility rule must be
 * asymmetric: pg_dump needs client >= server, psql does not.
 */

import { describe, it, expect } from "vitest";
import {
  parsePgToolMajor,
  pgMajorFromServerVersion,
  pgToolCandidates,
  resolvePgToolPath,
  pgClientCompatible,
  describePgClientMismatch,
} from "../../src/utils/pgClientTools.js";

describe("parsePgToolMajor", () => {
  it("reads the major out of every shape --version prints", () => {
    expect(parsePgToolMajor("pg_dump (PostgreSQL) 13.23")).toBe(13);
    expect(parsePgToolMajor("psql (PostgreSQL) 15.18 (Debian 15.18-1.pgdg120+1)")).toBe(15);
    expect(parsePgToolMajor("pg_dump (PostgreSQL) 9.6.24")).toBe(9);
    expect(parsePgToolMajor("pg_dump (PostgreSQL) 17.0\n")).toBe(17);
  });

  it("returns null for output that is not a version", () => {
    expect(parsePgToolMajor("")).toBeNull();
    expect(parsePgToolMajor("pg_dump: command not found")).toBeNull();
  });
});

describe("pgMajorFromServerVersion", () => {
  it("decodes server_version_num for PostgreSQL 10+ (six digits) and 9.x (five)", () => {
    expect(pgMajorFromServerVersion(150018)).toBe(15);
    expect(pgMajorFromServerVersion("160003")).toBe(16);
    expect(pgMajorFromServerVersion(90624)).toBe(9);
  });

  it("accepts a dotted version too", () => {
    expect(pgMajorFromServerVersion("15.18")).toBe(15);
    expect(pgMajorFromServerVersion("16.3 (Debian 16.3-1.pgdg120+1)")).toBe(16);
  });

  it("returns null for nothing / garbage", () => {
    expect(pgMajorFromServerVersion(null)).toBeNull();
    expect(pgMajorFromServerVersion(undefined)).toBeNull();
    expect(pgMajorFromServerVersion("")).toBeNull();
    expect(pgMajorFromServerVersion("unknown")).toBeNull();
  });
});

describe("pgToolCandidates", () => {
  it("lists the server's major first, then newer majors, in the PGDG and Debian layouts", () => {
    const c = pgToolCandidates("pg_dump", 15, { platform: "linux" });
    expect(c[0]).toBe("/usr/pgsql-15/bin/pg_dump");
    expect(c[1]).toBe("/usr/lib/postgresql/15/bin/pg_dump");
    expect(c[2]).toBe("/usr/pgsql-16/bin/pg_dump");
    expect(c).toContain("/usr/pgsql-20/bin/pg_dump");
    expect(c).not.toContain("/usr/pgsql-14/bin/pg_dump"); // never an OLDER major
    expect(c).not.toContain("pg_dump");                   // the bare name is the resolver's job
  });

  it("uses the Windows install directory on win32", () => {
    const c = pgToolCandidates("psql", 15, { platform: "win32" });
    expect(c[0]).toBe("C:\\Program Files\\PostgreSQL\\15\\bin\\psql.exe");
    expect(c.some((p) => p.startsWith("/usr/"))).toBe(false);
  });

  it("returns nothing for an unusable major", () => {
    expect(pgToolCandidates("pg_dump", 0)).toEqual([]);
    expect(pgToolCandidates("pg_dump", Number.NaN)).toEqual([]);
  });
});

describe("resolvePgToolPath", () => {
  const onDisk = (present: string[]) => (p: string) => present.includes(p);

  it("prefers the matching major's install dir over PATH", () => {
    const r = resolvePgToolPath("pg_dump", 15, onDisk(["/usr/pgsql-15/bin/pg_dump"]), { platform: "linux" });
    expect(r).toEqual({ path: "/usr/pgsql-15/bin/pg_dump", source: "versioned-dir" });
  });

  it("accepts a newer major when the matching one is absent (pg_dump is backward compatible)", () => {
    const r = resolvePgToolPath("pg_dump", 15, onDisk(["/usr/lib/postgresql/16/bin/pg_dump"]), { platform: "linux" });
    expect(r).toEqual({ path: "/usr/lib/postgresql/16/bin/pg_dump", source: "versioned-dir" });
  });

  it("falls back to the bare name — flagged as such — when nothing versioned exists", () => {
    const r = resolvePgToolPath("pg_dump", 15, onDisk([]), { platform: "linux" });
    expect(r).toEqual({ path: "pg_dump", source: "path" });
  });

  it("scans the versioned dirs, newest first, when the server major is unknown", () => {
    // The 2026-09-10 prod layout: /usr/pgsql-15 exists but nothing can say the
    // server is 15 (the host had removed AppStream 13 without `alternatives
    // --auto`, so the shell twin found no psql on PATH to ask). The versioned
    // client is still the right answer — a newer pg_dump is accepted and an
    // older one is refused by the --version check that follows — so PATH stays
    // the LAST resort, not the first. Until this the resolver returned the bare
    // name here and the update stopped at "pg_dump not found".
    const r = resolvePgToolPath(
      "pg_dump",
      null,
      onDisk(["/usr/lib/postgresql/13/bin/pg_dump", "/usr/pgsql-15/bin/pg_dump"]),
      { platform: "linux" },
    );
    expect(r).toEqual({ path: "/usr/pgsql-15/bin/pg_dump", source: "versioned-dir" });

    const win = resolvePgToolPath(
      "pg_dump",
      null,
      onDisk(["C:\\Program Files\\PostgreSQL\\15\\bin\\pg_dump.exe", "C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe"]),
      { platform: "win32" },
    );
    expect(win).toEqual({ path: "C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe", source: "versioned-dir" });
  });

  it("falls back to the bare name when the server major is unknown AND nothing versioned exists", () => {
    const r = resolvePgToolPath("pg_dump", null, onDisk([]), { platform: "linux" });
    expect(r).toEqual({ path: "pg_dump", source: "path" });
  });
});

describe("pgClientCompatible", () => {
  it("pg_dump needs a client at least as new as the server", () => {
    expect(pgClientCompatible("pg_dump", 13, 15)).toBe(false); // the prod case
    expect(pgClientCompatible("pg_dump", 15, 15)).toBe(true);
    expect(pgClientCompatible("pg_dump", 16, 15)).toBe(true);
  });

  it("psql works across majors", () => {
    expect(pgClientCompatible("psql", 13, 15)).toBe(true);
  });
});

describe("describePgClientMismatch", () => {
  it("names both versions, the path, and the fix", () => {
    const msg = describePgClientMismatch("pg_dump", 13, 15, "/usr/bin/pg_dump");
    expect(msg).toContain("pg_dump is PostgreSQL 13 (/usr/bin/pg_dump)");
    expect(msg).toContain("server is PostgreSQL 15");
    expect(msg).toContain("dnf install postgresql15");
    expect(msg).toContain("rpm -qf /usr/bin/pg_dump");
    expect(msg).toContain("postgresql-client-15");
    expect(msg).toContain("docs/INSTALL.md");
  });
});
