/**
 * tests/unit/nginxApplyUnit.test.ts — the nginx GUI runs its root half in
 * polaris-nginx-apply@.service, not a sudo from inside polaris-web
 * (business rule 117(o)).
 *
 * polaris-web is ProtectSystem=strict with only /opt/polaris writable. The
 * stage directory was not listed, so every in-app update logged its nginx
 * render as a "no-op" and installed nothing, and a sudo of the wrapper from
 * inside the unit inherited the read-only /etc, /run and /var — so Save &
 * Apply failed even as root. A hardening directive and a feature that writes
 * outside the app directory landed months apart and nothing checked one
 * against the other; these tests are that check.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const directives = (unit: string, key: string) =>
  unit.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1));

// ─── The files ───────────────────────────────────────────────────────────────

describe("polaris-web can write the nginx stage", () => {
  const web = read("deploy/polaris-web.service");

  it("is sandboxed (so this test is about something real)", () => {
    expect(directives(web, "ProtectSystem")).toEqual(["strict"]);
  });

  it("lists /run/polaris-nginx-stage beside /opt/polaris", () => {
    const paths = directives(web, "ReadWritePaths").join(" ").split(/\s+/).map((p) => p.replace(/^-/, ""));
    expect(paths).toContain("/opt/polaris");
    expect(paths).toContain("/run/polaris-nginx-stage");
  });

  it("covers every stage path the app writes", () => {
    const writers = [read("src/services/privilegedSysadmin.ts"), read("src/services/updateService.ts")].join("\n");
    const runPaths = new Set([...writers.matchAll(/"(\/run\/[a-z0-9-]+)/g)].map((m) => m[1]));
    const paths = directives(web, "ReadWritePaths").join(" ").split(/\s+/).map((p) => p.replace(/^-/, ""));
    expect([...runPaths].length).toBeGreaterThan(0);
    for (const p of runPaths) expect(paths, p).toContain(p);
  });
});

describe("polaris-nginx-apply@.service", () => {
  const unit = read("deploy/polaris-nginx-apply@.service");

  it("is a root oneshot that runs only the wrapper, with the instance as its argument", () => {
    expect(directives(unit, "Type")).toEqual(["oneshot"]);
    expect(directives(unit, "ExecStart")).toEqual(["/usr/local/sbin/polaris-nginx-apply %i"]);
    expect(directives(unit, "User")).toEqual([]);
    // Its job is writing nginx's files: a sandbox here is the original bug.
    expect(directives(unit, "ProtectSystem")).toEqual([]);
    expect(unit).not.toMatch(/^\[Install\]/m);
  });

  it("writes its output where privilegedSysadmin reads it", () => {
    expect(directives(unit, "StandardOutput")).toEqual(["truncate:/run/polaris-nginx-stage/%i.out"]);
    expect(directives(unit, "StandardError")).toEqual(["inherit"]);
    expect(read("src/services/privilegedSysadmin.ts")).toMatch(/`\$\{STAGE_DIR\}\/\$\{instance\}\.out`/);
  });

  it("is held for review as a root helper and laid down by every installer", () => {
    const sync = read("deploy/scripts/polaris-update-sync.sh").split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(sync).toMatch(/root_helper "\$SRC\/polaris-nginx-apply@\.service" "\$UNIT_DIR\/polaris-nginx-apply@\.service" 0644/);
    expect(sync).not.toMatch(/install_if_changed[^\n]*polaris-nginx-apply@/);
    for (const f of ["deploy/setup-rhel.sh", "deploy/setup-ubuntu.sh", "deploy/setup-rhel-nodb.sh", "deploy/setup-ubuntu-nodb.sh"]) {
      expect(read(f), f).toMatch(/root_copy 0644 "\$APP_DIR\/deploy\/polaris-nginx-apply@\.service" \/etc\/systemd\/system\/polaris-nginx-apply@\.service/);
    }
  });

  it("the wrapper takes the instance form of verify-listening", () => {
    expect(read("deploy/scripts/polaris-nginx-apply.sh")).toMatch(/verify-listening-\*\)\s+do_verify_listening "\$\{subcommand#verify-listening-\}"/);
  });
});

// ─── The polkit rule, evaluated ──────────────────────────────────────────────

describe("polkit — the polaris user may start the four nginx instances and nothing else", () => {
  type Decide = (action: { id: string; lookup: (k: string) => string }, subject: { user: string }) => string;
  let decide: Decide;
  beforeEach(() => {
    const polkit = {
      Result: { YES: "yes", NO: "no", NOT_HANDLED: "not_handled" },
      addRule(fn: Decide) { decide = fn; },
    };
    runInNewContext(read("deploy/polkit/49-polaris.rules"), { polkit });
  });
  const ask = (unit: string, verb = "start", user = "polaris") =>
    decide({ id: "org.freedesktop.systemd1.manage-units", lookup: (k) => (k === "unit" ? unit : verb) }, { user });

  it("allows the fixed instances", () => {
    for (const i of ["apply-config", "rotate-cert", "reload", "verify-listening-443", "verify-listening-8443"]) {
      expect(ask(`polaris-nginx-apply@${i}.service`), i).toBe("yes");
    }
  });

  it("refuses any other instance, any other verb and any other user", () => {
    for (const i of ["foo", "apply-config-x", "verify-listening-", "verify-listening-123456", "verify-listening-1;id", "reload.service"]) {
      expect(ask(`polaris-nginx-apply@${i}.service`), i).toBe("not_handled");
    }
    expect(ask("polaris-nginx-apply@reload.service", "stop")).toBe("not_handled");
    expect(ask("polaris-nginx-apply@reload.service", "start", "nobody")).toBe("not_handled");
    expect(ask("polaris-nginx-apply@.service")).toBe("not_handled");
  });

  it("keeps the existing grants", () => {
    expect(ask("polaris-update-sync.service")).toBe("yes");
    expect(ask("polaris-update-sync.service", "stop")).toBe("not_handled");
    expect(ask("polaris-web.service", "restart")).toBe("yes");
    expect(ask("sshd.service", "restart")).toBe("not_handled");
  });
});

// ─── runNginxApply ───────────────────────────────────────────────────────────

const { spawnMock, fsState } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  fsState: { unitInstalled: true, files: new Map<string, string>(), removed: [] as string[] },
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    existsSync: (p: string) => (p === "/etc/systemd/system/polaris-nginx-apply@.service" ? fsState.unitInstalled : real.existsSync(p)),
    rmSync: (p: string) => { fsState.removed.push(p); fsState.files.delete(p); },
    readFileSync: (p: string, enc?: BufferEncoding) => {
      if (typeof p === "string" && p.startsWith("/run/polaris-nginx-stage/")) {
        const v = fsState.files.get(p);
        if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return v;
      }
      return real.readFileSync(p, enc);
    },
  };
});

/** A child that prints `out` and exits `code`; `writes` lands in the stage first (the unit's output). */
function child(code: number, out = "", writes?: [string, string]) {
  return () => {
    const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = () => {};
    setImmediate(() => {
      if (writes) fsState.files.set(writes[0], writes[1]);
      if (out) c.stdout.emit("data", Buffer.from(out));
      c.emit("close", code);
    });
    return c;
  };
}

describe("runNginxApply", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    fsState.unitInstalled = true;
    fsState.files.clear();
    fsState.removed = [];
  });

  it("starts the unit instance and returns the wrapper's output from the stage", async () => {
    const { runNginxApply } = await import("../../src/services/privilegedSysadmin.js");
    fsState.files.set("/run/polaris-nginx-stage/apply-config.out", "STALE from last time");
    spawnMock.mockImplementation(child(0, "", ["/run/polaris-nginx-stage/apply-config.out", "ok: config applied\n"]));
    const r = await runNginxApply({ kind: "apply-config" });
    expect(spawnMock).toHaveBeenCalledWith("systemctl", ["start", "polaris-nginx-apply@apply-config.service"], expect.anything());
    expect(fsState.removed).toContain("/run/polaris-nginx-stage/apply-config.out");
    expect(r).toMatchObject({ exitCode: 0, output: "ok: config applied\n" });
  });

  it("names the listener check's port in the instance", async () => {
    const { runNginxApply } = await import("../../src/services/privilegedSysadmin.js");
    spawnMock.mockImplementation(child(0, "", ["/run/polaris-nginx-stage/verify-listening-8443.out", "# TCP listeners on :8443\n"]));
    const r = await runNginxApply({ kind: "verify-listening", port: 8443 });
    expect(spawnMock.mock.calls[0][1]).toEqual(["start", "polaris-nginx-apply@verify-listening-8443.service"]);
    expect(r.output).toContain(":8443");
    await expect(runNginxApply({ kind: "verify-listening", port: 70000 })).rejects.toThrow(/invalid port/);
  });

  it("a failed run keeps the wrapper's output and adds systemctl's", async () => {
    const { runNginxApply } = await import("../../src/services/privilegedSysadmin.js");
    spawnMock.mockImplementation(child(1, "Job for polaris-nginx-apply@apply-config.service failed.", [
      "/run/polaris-nginx-stage/apply-config.out", "nginx: [emerg] unknown directive\n",
    ]));
    const r = await runNginxApply({ kind: "apply-config" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/unknown directive[\s\S]*Job for/);
    expect(r.output).not.toMatch(/apply-helpers/);
  });

  it("polkit refusing the start says how to approve the helpers", async () => {
    const { runNginxApply } = await import("../../src/services/privilegedSysadmin.js");
    spawnMock.mockImplementation(child(4, "Failed to start polaris-nginx-apply@reload.service: Access denied"));
    const r = await runNginxApply({ kind: "reload" });
    expect(r.exitCode).toBe(4);
    expect(r.output).toMatch(/polaris-update-sync --apply-helpers/);
  });

  it("falls back to sudo while the unit is not installed, with the hint on a read-only failure", async () => {
    const { runNginxApply } = await import("../../src/services/privilegedSysadmin.js");
    fsState.unitInstalled = false;
    spawnMock.mockImplementation(child(0, "ok: nginx reloaded\n"));
    expect(await runNginxApply({ kind: "reload" })).toMatchObject({ exitCode: 0, output: "ok: nginx reloaded\n" });
    expect(spawnMock).toHaveBeenLastCalledWith("sudo", ["-n", "--", "/usr/local/sbin/polaris-nginx-apply", "reload"], expect.anything());

    spawnMock.mockImplementation(child(1, "cp: cannot create '/etc/nginx/conf.d/polaris.conf.new': Read-only file system\n"));
    const r = await runNginxApply({ kind: "verify-listening", port: 443 });
    expect(spawnMock).toHaveBeenLastCalledWith("sudo", ["-n", "--", "/usr/local/sbin/polaris-nginx-apply", "verify-listening", "443"], expect.anything());
    expect(r.output).toMatch(/Read-only file system[\s\S]*--apply-helpers/);
  });
});
