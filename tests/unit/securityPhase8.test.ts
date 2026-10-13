/**
 * tests/unit/securityPhase8.test.ts — business rule 117 (host-level secrets,
 * privileges and file trust). The pure helpers it added, plus structural
 * guards over the shell and polkit files it changed: these are not run by
 * anything else in `npm test`, and each one used to fail open.
 *
 * The shell cases run real bash when the host has it (CI does; a Windows dev
 * box with Git Bash does) and skip otherwise.
 */

import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../src/db.js", () => ({
  prisma: { $queryRawUnsafe: vi.fn(), $queryRaw: vi.fn() },
  getDirectStatsPool: () => null,
}));

import { graphqlOperationKinds, isQueryOnlyGraphql } from "../../src/utils/graphqlOperations.js";
import { ensurePrivateDir, makeFilePrivate } from "../../src/utils/privateFiles.js";
import { databaseUsesPublicDefaultPassword } from "../../src/services/capacityService.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;

describe("graphqlOperationKinds — the Unraid query tool reads documents as GraphQL does", () => {
  it("an anonymous selection set is a query", () => {
    expect(graphqlOperationKinds("{ info { os { platform } } }")).toEqual(["query"]);
    expect(isQueryOnlyGraphql("query Q { vms { id } }")).toBe(true);
  });

  it("finds a mutation hidden behind a leading comma, a comment or a fragment", () => {
    expect(isQueryOnlyGraphql(", mutation { docker { stop(id: \"x\") { id } } }")).toBe(false);
    expect(isQueryOnlyGraphql("# hi\nmutation { a }")).toBe(false);
    expect(isQueryOnlyGraphql("fragment F on Query { a } mutation { b }")).toBe(false);
    expect(isQueryOnlyGraphql("query A { a } subscription S { b }")).toBe(false);
  });

  it("keywords inside strings, arguments and selections do not count", () => {
    expect(isQueryOnlyGraphql('{ search(q: "mutation { x }") { id } }')).toBe(true);
    expect(isQueryOnlyGraphql('{ a(q: """\nmutation { x }\n""") }')).toBe(true);
    expect(isQueryOnlyGraphql("{ mutation subscription }")).toBe(true);
    expect(isQueryOnlyGraphql("fragment F on mutation { a } { b }")).toBe(true);
  });

  it("a document with no operation at all is not a query to run", () => {
    expect(isQueryOnlyGraphql("")).toBe(false);
    expect(isQueryOnlyGraphql("fragment F on Query { a }")).toBe(false);
  });
});

describe("privateFiles — backups are readable by the Polaris account only", () => {
  it.skipIf(process.platform === "win32")("ensurePrivateDir makes the dir 0700 and tightens files already in it", () => {
    const base = mkdtempSync(join(tmpdir(), "pf-"));
    try {
      const dir = join(base, "backups");
      ensurePrivateDir(dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      const legacy = join(base, "old");
      ensurePrivateDir(legacy);
      writeFileSync(join(legacy, "x.gz"), "dump", { mode: 0o644 });
      // A fresh process tightens on first sight; simulate with a new path key.
      const again = `${legacy}/`;
      ensurePrivateDir(again);
      expect(statSync(join(legacy, "x.gz")).mode & 0o777).toBe(0o600);
      const f = join(base, "copy.gz");
      writeFileSync(f, "dump", { mode: 0o644 });
      makeFilePrivate(f);
      expect(statSync(f).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("never throws for a path whose mode cannot be changed", () => {
    expect(() => makeFilePrivate(join(tmpdir(), "does-not-exist-" + Date.now()))).not.toThrow();
  });
});

describe("databaseUsesPublicDefaultPassword", () => {
  it("flags the old installer default and nothing else", () => {
    expect(databaseUsesPublicDefaultPassword("postgresql://polaris:polaris@localhost:5432/polaris")).toBe(true);
    expect(databaseUsesPublicDefaultPassword("postgresql://polaris:3f9a…@localhost/polaris")).toBe(false);
    expect(databaseUsesPublicDefaultPassword("postgresql://app:polaris@localhost/polaris")).toBe(false);
    expect(databaseUsesPublicDefaultPassword(undefined)).toBe(false);
    expect(databaseUsesPublicDefaultPassword("not a url")).toBe(false);
  });
});

describe("installers — no fixed database password, nothing on argv", () => {
  for (const f of ["deploy/setup-rhel.sh", "deploy/setup-ubuntu.sh"]) {
    it(`${f} generates the password and never passes it on a psql command line`, () => {
      const src = read(f);
      expect(src).toMatch(/DB_PASS="\$\{POLARIS_DB_PASSWORD:-\$\(openssl rand -hex 24\)\}"/);
      const onArgv = src.split(/\r?\n/).filter((l) => /\bpsql\b/.test(l) && /\$DB_PASS\b/.test(l));
      expect(onArgv).toEqual([]);
    });
  }
  for (const f of ["deploy/setup-rhel-nodb.sh", "deploy/setup-ubuntu-nodb.sh"]) {
    it(`${f} reads the URL from the environment and keeps the password off psql's argv`, () => {
      const src = read(f);
      expect(src).toMatch(/DATABASE_URL="\$\{POLARIS_DATABASE_URL:-\}"/);
      expect(src).not.toMatch(/psql "\$DATABASE_URL"/);
      expect(src).toMatch(/read -rsp/);
    });
  }
});

describe("polkit — the polaris user may start the update helper, not any unit", () => {
  const rule = read("deploy/polkit/49-polaris.rules");
  const code = rule.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n");
  it("looks at the unit and the verb before saying yes", () => {
    expect(code).toMatch(/action\.lookup\("unit"\)/);
    expect(code).toMatch(/action\.lookup\("verb"\)/);
    expect(code).toMatch(/unit == "polaris-update-sync\.service" && verb == "start"/);
  });
  it("has no unconditional manage-units grant (that is root: systemd-run runs anything)", () => {
    expect(code).not.toMatch(/manage-units"\s*&&\s*\n?\s*subject\.user == "polaris"\)\s*\{\s*\n?\s*return polkit\.Result\.YES/);
  });
});

describe("updateService — the restart starts the fixed root unit", () => {
  const src = read("src/services/updateService.ts");
  it("starts polaris-update-sync.service when it is installed", () => {
    expect(src).toMatch(/\["start", "--no-block", "polaris-update-sync\.service"\]/);
  });
  it("no longer hands systemd-run an inline script that installs units or sudoers", () => {
    expect(src).not.toMatch(/install -o root -g root -m 0440 \$\{APP_DIR\}\/deploy\/sudoers\.d/);
    expect(src).not.toMatch(/cp -f "\$f" "\$target"/);
  });
});

describe.skipIf(!hasBash)("polaris-update-sync.sh validators", () => {
  const script = join(ROOT, "deploy/scripts/polaris-update-sync.sh");
  function check(kind: string, body: string, fn = "unit_ok"): boolean {
    const dir = mkdtempSync(join(tmpdir(), "us-"));
    try {
      const f = join(dir, "u");
      writeFileSync(f, body);
      const r = spawnSync("bash", ["-c", `logger() { :; }; visudo() { return 0; }; POLARIS_UPDATE_SYNC_LIB=1 source "$1"; ${fn} "$2" "$3"`, "_", script.replace(/\\/g, "/"), f.replace(/\\/g, "/"), kind]);
      return r.status === 0;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("accepts every shipped polaris unit, the target and the HA drop-ins", () => {
    for (const u of ["polaris-web", "polaris-monitor@", "polaris-discovery", "polaris-dash", "polaris-migrate"]) {
      expect(check("unit", read(`deploy/${u}.service`)), u).toBe(true);
      expect(check("dropin", read(`deploy/ha/dropins/${u}.service.d/10-ha.conf`)), `${u} drop-in`).toBe(true);
    }
    expect(check("target", read("deploy/polaris.target"))).toBe(true);
    expect(check("", read("deploy/polaris-update-sync.service"), "self_unit_ok")).toBe(true);
    expect(check("", read("deploy/sudoers.d/polaris-nginx"), "sudoers_ok")).toBe(true);
    expect(check("", read("deploy/tmpfiles.d/polaris-nginx.conf"), "tmpfiles_ok")).toBe(true);
  });

  it.each([
    ["User=root", "[Service]\nUser=root\nExecStart=/bin/true\n"],
    ["a + Exec prefix", "[Service]\nUser=polaris\nExecStartPre=+/bin/sh -c id\n"],
    ["a ! Exec prefix", "[Service]\nUser=polaris\nExecStart=-!/bin/sh\n"],
    ["a second User line", "[Service]\nUser=polaris\nUser=root\n"],
    ["no User line", "[Service]\nExecStart=/bin/true\n"],
    ["CAP_SYS_ADMIN", "[Service]\nUser=polaris\nAmbientCapabilities=CAP_SYS_ADMIN\n"],
    ["an inverted capability list", "[Service]\nUser=polaris\nAmbientCapabilities=~CAP_NET_RAW\n"],
    ["SupplementaryGroups", "[Service]\nUser=polaris\nSupplementaryGroups=wheel\n"],
    ["a dependency on a non-Polaris unit", "[Unit]\nWants=debug-shell.service\n[Service]\nUser=polaris\n"],
    ["a line continuation", "[Service]\nUser=polaris\nExecStart=/bin/true \\\n +x\n"],
  ])("refuses a unit with %s", (_label, body) => {
    expect(check("unit", body)).toBe(false);
  });

  it("refuses a drop-in that sets User=, and a root update unit with extra directives", () => {
    expect(check("dropin", "[Service]\nUser=root\n")).toBe(false);
    expect(check("", "[Service]\nType=oneshot\nExecStart=/usr/local/sbin/polaris-update-sync\nEnvironment=LD_PRELOAD=/tmp/x.so\n", "self_unit_ok")).toBe(false);
    expect(check("", "[Service]\nExecStart=/bin/sh\n", "self_unit_ok")).toBe(false);
  });

  it("refuses a sudoers or tmpfiles file that grants more than the one helper", () => {
    expect(check("", "polaris ALL=(root) NOPASSWD: /usr/local/sbin/polaris-nginx-apply, /bin/sh\n", "sudoers_ok")).toBe(false);
    expect(check("", "polaris ALL=(ALL) NOPASSWD: ALL\n", "sudoers_ok")).toBe(false);
    expect(check("", "z /etc/shadow 0666 root root -\n", "tmpfiles_ok")).toBe(false);
  });
});

describe.skipIf(!hasBash)("polaris-ha-ssh-wrapper.sh — read-direction rsync with the sync's own flags only", () => {
  const wrapper = read("deploy/ha/polaris-ha-ssh-wrapper.sh")
    .replace('exec "${ARGS[@]}"', 'echo ALLOW; exit 0')
    .replace(/^ {2}logger .*$/m, "  :");
  function allowed(cmd: string): boolean {
    const dir = mkdtempSync(join(tmpdir(), "hw-"));
    try {
      const f = join(dir, "w.sh");
      writeFileSync(f, wrapper);
      const r = spawnSync("bash", [f.replace(/\\/g, "/")], { env: { ...process.env, SSH_ORIGINAL_COMMAND: cmd } });
      return r.status === 0 && String(r.stdout).includes("ALLOW");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("allows the pulls polaris-ha-role.sh makes", () => {
    expect(allowed("rsync --server --sender -logDtprHe.iLsfxCIvu --delete-delay --delay-updates --partial-dir=.rsync-partial --bwlimit=5000 . /etc/polaris/")).toBe(true);
    expect(allowed("rsync --server --sender -logDtprHe.iLsfxCIvu . /opt/polaris/data/")).toBe(true);
  });

  it.each([
    "rsync --server --sender -logDtpr --remove-source-files . /etc/polaris/",
    "rsync --server --sender -logDtpr --log-file=/root/.bashrc . /etc/",
    "rsync --server --sender -logDtpr --write-batch=/tmp/x . /etc/",
    "rsync --server -logDtpr . /etc/",
    "rsync --server --sender -logDtpr . relative/path",
    "rsync --server --sender -logDtpr . /etc/; touch /tmp/pwn",
    "rsync --server --sender -T/tmp . /etc/",
  ])("refuses %s", (cmd) => {
    expect(allowed(cmd)).toBe(false);
  });
});
