/**
 * tests/unit/privilegedSysadmin.test.ts — the glue around the root nginx
 * wrapper (business rule 117(o)).
 *
 * Preferred path: START polaris-nginx-apply@<op>.service and read the output
 * the unit wrote to /run/polaris-nginx-stage/<op>.out (a stale one removed
 * first). Fallback while that unit file is absent: `sudo -n` the wrapper.
 * Output is bounded to 64 KB with a truncation flag; a polkit refusal or a
 * read-only failure comes back with the --apply-helpers hint.
 *
 * node:child_process.spawn and the node:fs calls are replaced — no process is
 * started and nothing is written outside the test.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { EventEmitter } from "node:events";

/** One spawned process: what it prints, how it exits, and (the root unit) the .out file it writes. */
type Script = { stdout?: string[]; stderr?: string[]; code?: number | null; error?: Error; hang?: boolean; unitOut?: [string, string] };

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  existing: new Set<string>(),
  scripts: [] as Script[],
  spawned: [] as Array<{ cmd: string; args: string[]; kill: ReturnType<typeof vi.fn> }>,
  rmSync: null as unknown as Mock,
  writeFileSync: null as unknown as Mock,
  mkdirSync: null as unknown as Mock,
  chmodSync: null as unknown as Mock,
}));

vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  h.rmSync = vi.fn((p: string) => { h.files.delete(p); });
  h.writeFileSync = vi.fn();
  h.mkdirSync = vi.fn();
  h.chmodSync = vi.fn();
  return {
    ...real,
    existsSync: vi.fn((p: string) => h.existing.has(p)),
    readFileSync: vi.fn((p: string) => {
      if (!h.files.has(p)) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
      return h.files.get(p);
    }),
    rmSync: h.rmSync,
    writeFileSync: h.writeFileSync,
    mkdirSync: h.mkdirSync,
    chmodSync: h.chmodSync,
  };
});

vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  const { EventEmitter: EE } = await import("node:events");
  return {
    ...real,
    spawn: vi.fn((cmd: string, args: string[]) => {
      const script = h.scripts.shift() ?? { code: 0 };
      const child = new EE() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
      child.stdout = new EE();
      child.stderr = new EE();
      child.kill = vi.fn(() => { setTimeout(() => child.emit("close", null), 0); return true; });
      h.spawned.push({ cmd, args, kill: child.kill });
      setTimeout(() => {
        if (script.error) { child.emit("error", script.error); return; }
        if (script.unitOut) h.files.set(script.unitOut[0], script.unitOut[1]);
        for (const s of script.stdout ?? []) child.stdout.emit("data", Buffer.from(s));
        for (const s of script.stderr ?? []) child.stderr.emit("data", Buffer.from(s));
        if (!script.hang) child.emit("close", script.code ?? 0);
      }, 0);
      return child;
    }),
  };
});

vi.mock("../../src/utils/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  runNginxApply,
  stageNginxConfig,
  stageCertAndKey,
  isWrapperAvailable,
} from "../../src/services/privilegedSysadmin.js";
import { logger } from "../../src/utils/logger.js";

const UNIT = "/etc/systemd/system/polaris-nginx-apply@.service";
const WRAPPER = "/usr/local/sbin/polaris-nginx-apply";
const STAGE = "/run/polaris-nginx-stage";
const MAX = 64 * 1024;

beforeEach(() => {
  h.files.clear();
  h.existing.clear();
  h.scripts = [];
  h.spawned = [];
  h.rmSync.mockClear();
  h.writeFileSync.mockReset();
  h.mkdirSync.mockReset();
  h.chmodSync.mockReset();
  vi.mocked(logger.warn).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("runNginxApply — started unit (preferred)", () => {
  beforeEach(() => { h.existing.add(UNIT); });

  it("starts the per-op instance and returns what the unit wrote", async () => {
    h.scripts.push({ code: 0, stdout: ["(systemctl chatter)"], unitOut: [`${STAGE}/apply-config.out`, "nginx: configuration file test is successful\n"] });
    const r = await runNginxApply({ kind: "apply-config" });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].cmd).toBe("systemctl");
    expect(h.spawned[0].args).toEqual(["start", "polaris-nginx-apply@apply-config.service"]);
    expect(r).toMatchObject({ exitCode: 0, output: "nginx: configuration file test is successful\n", truncated: false });
  });

  it("removes a stale .out before starting, so an earlier run is never read as this one", async () => {
    h.files.set(`${STAGE}/reload.out`, "STALE OUTPUT");
    h.scripts.push({ code: 0 });
    const r = await runNginxApply({ kind: "reload" });
    expect(h.rmSync).toHaveBeenCalledWith(`${STAGE}/reload.out`, { force: true });
    expect(r.output).toBe("");
  });

  it("names the verify-listening instance after its port", async () => {
    h.scripts.push({ code: 0 });
    await runNginxApply({ kind: "verify-listening", port: 8443 });
    expect(h.spawned[0].args).toEqual(["start", "polaris-nginx-apply@verify-listening-8443.service"]);
  });

  it("on failure appends systemctl's own output after the unit's", async () => {
    h.scripts.push({ code: 3, stderr: ["Job failed. See journalctl"], unitOut: [`${STAGE}/rotate-cert.out`, "cert mismatch"] });
    const r = await runNginxApply({ kind: "rotate-cert" });
    expect(r.exitCode).toBe(3);
    expect(r.output).toBe("cert mismatch\nJob failed. See journalctl");
    expect(r.output).not.toMatch(/apply-helpers/);
  });

  it("a polkit refusal (no output file) carries the --apply-helpers hint", async () => {
    h.scripts.push({ code: 4, stderr: ["Failed to start polaris-nginx-apply@reload.service: Access denied"] });
    const r = await runNginxApply({ kind: "reload" });
    expect(r.exitCode).toBe(4);
    expect(r.output).toMatch(/Access denied\n.*polaris-update-sync --apply-helpers/s);
  });

  it("does not add the hint when the unit ran and wrote output", async () => {
    h.scripts.push({ code: 1, stderr: ["Interactive authentication required."], unitOut: [`${STAGE}/reload.out`, "nginx: [emerg] bind() failed"] });
    const r = await runNginxApply({ kind: "reload" });
    expect(r.output).not.toMatch(/apply-helpers/);
  });

  it("bounds a huge unit output to 64 KB and flags it truncated", async () => {
    h.scripts.push({ code: 0, unitOut: [`${STAGE}/apply-config.out`, "x".repeat(MAX + 100)] });
    const r = await runNginxApply({ kind: "apply-config" });
    expect(r.output).toHaveLength(MAX);
    expect(r.truncated).toBe(true);
  });

  it("rejects when systemctl cannot be spawned", async () => {
    h.scripts.push({ error: new Error("spawn systemctl ENOENT") });
    await expect(runNginxApply({ kind: "reload" })).rejects.toThrow("ENOENT");
  });
});

describe("runNginxApply — sudo fallback (unit not installed)", () => {
  it("sudo -n's the wrapper with the subcommand", async () => {
    h.scripts.push({ code: 0, stdout: ["ok\n"] });
    const r = await runNginxApply({ kind: "apply-config" });
    expect(h.spawned[0].cmd).toBe("sudo");
    expect(h.spawned[0].args).toEqual(["-n", "--", WRAPPER, "apply-config"]);
    expect(r).toMatchObject({ exitCode: 0, output: "ok\n", truncated: false });
    expect(h.rmSync).not.toHaveBeenCalled();
  });

  it("passes verify-listening's port as a separate argument", async () => {
    h.scripts.push({ code: 0 });
    await runNginxApply({ kind: "verify-listening", port: 443 });
    expect(h.spawned[0].args).toEqual(["-n", "--", WRAPPER, "verify-listening", "443"]);
  });

  it("interleaves stdout and stderr", async () => {
    h.scripts.push({ code: 2, stdout: ["out1 "], stderr: ["err1"] });
    const r = await runNginxApply({ kind: "reload" });
    expect(r.exitCode).toBe(2);
    expect(r.output).toBe("out1 err1");
  });

  it("a read-only file system failure carries the --apply-helpers hint", async () => {
    h.scripts.push({ code: 1, stderr: ["cp: cannot create '/etc/nginx/conf.d/polaris.conf': Read-only file system"] });
    const r = await runNginxApply({ kind: "apply-config" });
    expect(r.output).toMatch(/Read-only file system\n.*--apply-helpers/s);
  });

  it("a plain failure carries no hint", async () => {
    h.scripts.push({ code: 1, stderr: ["sudo: a password is required"] });
    const r = await runNginxApply({ kind: "apply-config" });
    expect(r.output).toBe("sudo: a password is required");
  });

  it("caps captured output at 64 KB and stops appending", async () => {
    h.scripts.push({ code: 0, stdout: ["a".repeat(MAX - 10), "b".repeat(50), "c".repeat(50)] });
    const r = await runNginxApply({ kind: "reload" });
    expect(r.output).toHaveLength(MAX);
    expect(r.output.endsWith("b".repeat(10))).toBe(true);
    expect(r.truncated).toBe(true);
  });

  it("kills a wrapper that outlives the timeout and reports exit -1", async () => {
    h.scripts.push({ hang: true, stdout: ["partial"] });
    const r = await runNginxApply({ kind: "reload" }, { timeoutMs: 5 });
    expect(h.spawned[0].kill).toHaveBeenCalledWith("SIGKILL");
    expect(r).toMatchObject({ exitCode: -1, output: "partial" });
  });

  it("rejects when sudo cannot be spawned", async () => {
    h.scripts.push({ error: new Error("spawn sudo ENOENT") });
    await expect(runNginxApply({ kind: "reload" })).rejects.toThrow("spawn sudo ENOENT");
  });
});

describe("runNginxApply — instance validation", () => {
  it.each([0, 65536, 443.5, Number.NaN, -1])("refuses verify-listening port %s with a 500 before spawning", async (port) => {
    await expect(runNginxApply({ kind: "verify-listening", port })).rejects.toMatchObject({ httpStatus: 500 });
    expect(h.spawned).toHaveLength(0);
  });

  it("refuses a subcommand whose instance carries a path character", async () => {
    h.existing.add(UNIT);
    await expect(runNginxApply({ kind: "../../etc/x" } as never)).rejects.toMatchObject({
      httpStatus: 500,
      message: expect.stringMatching(/invalid instance/),
    });
    expect(h.spawned).toHaveLength(0);
    expect(h.rmSync).not.toHaveBeenCalled();
  });
});

describe("stageNginxConfig / stageCertAndKey", () => {
  it("writes the config into the stage dir with mode 0640", () => {
    h.existing.add(STAGE);
    stageNginxConfig("server {}");
    expect(h.writeFileSync).toHaveBeenCalledWith(`${STAGE}/polaris.conf`, "server {}", { mode: 0o640 });
    expect(h.mkdirSync).not.toHaveBeenCalled();
  });

  it("writes cert and key with mode 0640", () => {
    h.existing.add(STAGE);
    stageCertAndKey("CERT", "KEY");
    expect(h.writeFileSync).toHaveBeenCalledWith(`${STAGE}/cert.pem`, "CERT", { mode: 0o640 });
    expect(h.writeFileSync).toHaveBeenCalledWith(`${STAGE}/key.pem`, "KEY", { mode: 0o640 });
  });

  it("creates a missing stage dir 0750 as a fallback", () => {
    stageNginxConfig("x");
    expect(h.mkdirSync).toHaveBeenCalledWith(STAGE, { recursive: true, mode: 0o750 });
    expect(h.chmodSync).toHaveBeenCalledWith(STAGE, 0o750);
  });

  it("logs and carries on when the stage dir cannot be created (the write then fails loudly)", () => {
    h.mkdirSync.mockImplementation(() => { throw new Error("EACCES"); });
    h.writeFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(() => stageNginxConfig("x")).toThrow("ENOENT");
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: "EACCES", dir: STAGE }), expect.any(String));
  });
});

describe("isWrapperAvailable", () => {
  it("reflects whether the wrapper is installed", () => {
    expect(isWrapperAvailable()).toBe(false);
    h.existing.add(WRAPPER);
    expect(isWrapperAvailable()).toBe(true);
  });
});
