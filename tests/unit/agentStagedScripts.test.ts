/**
 * tests/unit/agentStagedScripts.test.ts — business rule 119. Every root script
 * Polaris stages on a Linux / macOS host reads its files from the staging
 * directory it is given ($1), never from a fixed /tmp name, and the install
 * and upgrade scripts check the binary's SHA-256 ($2) before `install`.
 * Each rendered script is also parsed by a real bash (`bash -n`).
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { installerScript, uninstallerScript, upgradeScript } from "../../src/services/agentInstallService.js";

const scripts: Array<[string, string]> = [
  ["linux install (unprivileged)", installerScript("linux", null, "unprivileged").toString("utf8")],
  ["linux install (ptrace)", installerScript("linux", null, "ptrace").toString("utf8")],
  ["darwin install", installerScript("darwin", null).toString("utf8")],
  ["linux uninstall", uninstallerScript("linux", null).toString("utf8")],
  ["darwin uninstall", uninstallerScript("darwin", null).toString("utf8")],
  ["linux upgrade", upgradeScript("linux").toString("utf8")],
  ["darwin upgrade", upgradeScript("darwin").toString("utf8")],
];

const haveBash = spawnSync("bash", ["-c", "true"]).status === 0;

describe("staged agent scripts", () => {
  it.each(scripts)("%s names no fixed /tmp path", (_name, body) => {
    expect(body).not.toMatch(/\/tmp\//);
  });

  it.each(scripts.filter(([n]) => /install \(|darwin install|upgrade/.test(n)))(
    "%s reads from the staging directory and verifies the binary before installing it",
    (_name, body) => {
      expect(body).toContain('STAGE_DIR="${1:?');
      const verify = body.indexOf('verify_sha256 "${BIN_');
      const install = body.search(/\ninstall -m 0755/);
      expect(verify).toBeGreaterThan(0);
      expect(install).toBeGreaterThan(verify);
    },
  );

  it.skipIf(!haveBash).each(scripts)("%s parses under bash -n", (_name, body) => {
    const r = spawnSync("bash", ["-n"], { input: body, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
