/**
 * tests/unit/remoteStaging.test.ts — business rule 119 (re-scan F63 / F64 /
 * F67). Files Polaris runs elevated on a monitored host are staged in a
 * directory created for the run, never at fixed names in a world-writable
 * temp directory a local user could have pre-created. The staged root script
 * checks the binary's SHA-256 before installing it; the prelude is executed
 * under a real bash here, not just string-matched.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("../../src/utils/remoteExec.js", () => ({ sshExec: h.exec }));

import {
  makeUnixStageDir,
  unixStagedCommand,
  makeWindowsStageDir,
  windowsStagedSftpPath,
  STAGED_SCRIPT_PRELUDE,
} from "../../src/utils/remoteStaging.js";

const client = {} as never;
beforeEach(() => h.exec.mockReset());

describe("Linux / macOS staging", () => {
  it("creates the directory with mktemp -d under umask 077 and accepts only what mktemp returns", async () => {
    h.exec.mockResolvedValueOnce({ exitCode: 0, stdout: "/tmp/polaris-agent.Ab3dE5gH9k\n", stderr: "" });
    await expect(makeUnixStageDir(client)).resolves.toBe("/tmp/polaris-agent.Ab3dE5gH9k");
    expect(h.exec.mock.calls[0][1]).toBe("umask 077 && mktemp -d /tmp/polaris-agent.XXXXXXXXXX");
  });

  it("refuses any other answer — a fixed name, an injection, a failure", async () => {
    for (const stdout of ["/tmp/polaris-agent-install.sh", "/tmp/polaris-agent.Ab3dE5gH9k; rm -rf /", "/var/tmp/polaris-agent.Ab3dE5gH9k", ""]) {
      h.exec.mockResolvedValueOnce({ exitCode: 0, stdout, stderr: "" });
      await expect(makeUnixStageDir(client)).rejects.toMatchObject({ httpStatus: 502 });
    }
    h.exec.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "mktemp: failed" });
    await expect(makeUnixStageDir(client)).rejects.toThrow(/private staging directory/);
  });

  it("runs the script from the directory as root, passes the digest, and removes the directory keeping the exit code", () => {
    const sha = "a".repeat(64);
    expect(unixStagedCommand("/tmp/polaris-agent.Ab3dE5gH9k", "install.sh", sha)).toBe(
      `sudo -n bash /tmp/polaris-agent.Ab3dE5gH9k/install.sh /tmp/polaris-agent.Ab3dE5gH9k ${sha}; rc=$?; rm -rf /tmp/polaris-agent.Ab3dE5gH9k; exit $rc`,
    );
    expect(() => unixStagedCommand("/tmp/polaris-agent-install.sh", "install.sh")).toThrow();
    expect(() => unixStagedCommand("/tmp/polaris-agent.Ab3dE5gH9k", "x;id")).toThrow();
    expect(() => unixStagedCommand("/tmp/polaris-agent.Ab3dE5gH9k", "install.sh", "nothex")).toThrow();
  });
});

describe("Windows staging", () => {
  it("uses a random directory under the SSH user's own temp folder", async () => {
    const dir = "C:\\Users\\svc-polaris\\AppData\\Local\\Temp\\polaris-agent-0123456789abcdef0123456789abcdef";
    h.exec.mockResolvedValueOnce({ exitCode: 0, stdout: `${dir}\r\n`, stderr: "" });
    await expect(makeWindowsStageDir(client)).resolves.toBe(dir);
    expect(h.exec.mock.calls[0][1]).toContain("[IO.Path]::GetTempPath()");
    expect(h.exec.mock.calls[0][1]).not.toMatch(/Windows\\\\?Temp/i);
    expect(windowsStagedSftpPath(dir, "polaris-agent-install.ps1")).toBe(
      "C:/Users/svc-polaris/AppData/Local/Temp/polaris-agent-0123456789abcdef0123456789abcdef/polaris-agent-install.ps1",
    );
  });

  it("refuses C:\\Windows\\Temp (every user can write it) and removes what it made", async () => {
    const dir = "C:\\Windows\\Temp\\polaris-agent-0123456789abcdef0123456789abcdef";
    h.exec.mockResolvedValueOnce({ exitCode: 0, stdout: dir, stderr: "" });
    h.exec.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    await expect(makeWindowsStageDir(client)).rejects.toThrow(/C:\\Windows\\Temp/);
    expect(h.exec.mock.calls[1][1]).toContain("Remove-Item -LiteralPath");
  });

  it("refuses a path carrying quotes or shell metacharacters", async () => {
    for (const stdout of ["C:\\Users\\o'brien\\Temp\\polaris-agent-0123456789abcdef0123456789abcdef", "C:\\x\\polaris-agent-123", "garbage"]) {
      h.exec.mockResolvedValueOnce({ exitCode: 0, stdout, stderr: "" });
      await expect(makeWindowsStageDir(client)).rejects.toMatchObject({ httpStatus: 502 });
    }
  });
});

const bash = spawnSync("bash", ["-c", "command -v sha256sum || command -v shasum"], { encoding: "utf8" });
const haveBash = bash.status === 0;

describe.skipIf(!haveBash)("STAGED_SCRIPT_PRELUDE under bash", () => {
  const run = (dir: string, sha: string) =>
    spawnSync("bash", ["-c", `set -euo pipefail\n${STAGED_SCRIPT_PRELUDE}\nverify_sha256 "\${STAGE_DIR}/agent.bin" "$2"\necho VERIFIED`, "install.sh", dir, sha], { encoding: "utf8" });

  it("accepts the binary whose digest matches and refuses one that does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "polaris-stage-"));
    try {
      const body = Buffer.from("agent-binary-bytes");
      writeFileSync(join(dir, "agent.bin"), body);
      const sha = createHash("sha256").update(body).digest("hex");
      const bashDir = dir.replace(/\\/g, "/");
      const ok = run(bashDir, sha);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain("VERIFIED");
      const bad = run(bashDir, "0".repeat(64));
      expect(bad.status).toBe(1);
      expect(bad.stderr).toMatch(/SHA-256 mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a missing staging directory", () => {
    const r = run("/nonexistent/polaris-agent.zzzzzzzzzz", "0".repeat(64));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing or is a link/);
  });

  it("refuses a staging directory that is a symlink (when the OS lets us make one)", (ctx) => {
    const base = mkdtempSync(join(tmpdir(), "polaris-stage-"));
    try {
      const link = join(base, "link");
      try { symlinkSync(base, link, "dir"); } catch { ctx.skip(); }
      const r = run(link.replace(/\\/g, "/"), "0".repeat(64));
      expect(r.status).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
