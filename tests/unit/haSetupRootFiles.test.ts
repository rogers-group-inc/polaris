/**
 * tests/unit/haSetupRootFiles.test.ts — business rule 117(n). Root runs
 * deploy/update-linux.sh and deploy/ha/setup-rhel-ha.sh, and the copies in
 * /opt/polaris live in the polaris account's tree — so a check written inside
 * them could have been edited out with the rest. The fix is which COPY runs:
 * a root-owned, reviewed one under /usr/local/sbin, installed through
 * polaris-update-sync like every root helper, to which a copy found anywhere
 * else hands over. setup-rhel-ha.sh additionally installs its HA root files
 * only from a source the polaris account cannot write, and otherwise routes
 * them through the installed `polaris-update-sync --install --ha`.
 *
 * The scripts need root, systemd and Patroni, so their contract is pinned
 * structurally; the update helper's option parsing runs for real.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const haveBash = spawnSync("bash", ["-c", "true"]).status === 0;

describe.each([
  ["deploy/update-linux.sh", "/usr/local/sbin/polaris-update-linux", "POLARIS_UPDATE_FROM_TREE"],
  ["deploy/ha/setup-rhel-ha.sh", "/usr/local/sbin/polaris-ha-setup", "POLARIS_HA_SETUP_FROM_TREE"],
])("%s hands over to its reviewed copy", (file, installed, override) => {
  const src = read(file);
  it("execs the installed copy, when root owns it and nobody else may write it, before doing anything", () => {
    const handoff = src.indexOf(`_INSTALLED_SELF=${installed}`);
    expect(handoff).toBeGreaterThan(0);
    expect(src.indexOf('exec "$_INSTALLED_SELF" "$@"')).toBeGreaterThan(handoff);
    expect(src).toMatch(/"\$\(stat -c '%u' "\$_INSTALLED_SELF" 2>\/dev\/null\)" == 0/);
    expect(src).toMatch(/\(\( \(8#\$\(stat -c '%a' "\$_INSTALLED_SELF"\) & 8#022\) == 0 \)\)/);
    // Before argument parsing and before any other work.
    const firstWork = Math.min(...["for arg in", "while [[ $# -gt 0 ]]", "APP_DIR=", "ROLE=\"\""].map((m) => src.indexOf(m)).filter((i) => i >= 0));
    expect(handoff).toBeLessThan(firstWork);
    expect(src).toContain(`"\${${override}:-0}" != 1`);
  });
});

describe("setup-rhel-ha.sh — HA root files", () => {
  const src = read("deploy/ha/setup-rhel-ha.sh");

  it("installs no root file from its source directory except through ha_root_file", () => {
    for (const line of src.split("\n")) {
      if (/^\s*#/.test(line) || !/\$SRC_DIR|\$d\/10-ha\.conf/.test(line)) continue;
      if (/install -o root/.test(line)) expect(line, line).toMatch(/^\s*install -o root -g root -m "\$1" "\$2" "\$3"$/);
    }
    expect(src).toMatch(/ha_root_file\(\) \{\n {2}\[\[ \$SRC_TRUSTED -eq 1 \]\] \|\| return 0\n/);
    expect(src).toMatch(/ha_root_file 0755 "\$SRC_DIR\/setup-rhel-ha\.sh" \/usr\/local\/sbin\/polaris-ha-setup/);
  });

  it("treats a source the polaris account owns (or an install dir it owns) as untrusted, and a fresh root clone as trusted", () => {
    expect(src).toMatch(/\[\[ -n "\$polaris_uid" \]\] \|\| return 1/);
    expect(src).toMatch(/for d in "\$real" "\$\(dirname "\$real"\)"; do\n {4}\[\[ "\$\(stat -c '%u' "\$d" 2>\/dev\/null\)" == "\$polaris_uid" \]\] && return 0/);
    expect(src).toMatch(/if \[\[ "\$real" == "\$app"\/\* && "\$\(stat -c '%u' "\$app" 2>\/dev\/null\)" == "\$polaris_uid" \]\]; then/);
  });

  it("reviews the HA files through the installed helper before Patroni is configured", () => {
    expect(src).toMatch(/install_patroni\(\) \{\n {2}ha_review_root_files\n/);
    expect(src).toMatch(/"\$SYNC_HELPER" --install --ha \$\{POLARIS_YES:\+--yes\}/);
  });

  it("reads templates as the polaris account when the source is untrusted", () => {
    expect(src).toMatch(/else sudo -u "\$APP_USER" cat -- "\$src"; fi \| \\\n {2}sed /);
  });

  it("runs the installed copy against the tree's templates", () => {
    expect(src).toMatch(/\[\[ "\$SRC_DIR" == \/usr\/local\/sbin \]\] && SRC_DIR="\$APP_DIR\/deploy\/ha"/);
  });
});

describe("polaris-update-sync — the new root helpers", () => {
  const src = read("deploy/scripts/polaris-update-sync.sh");
  it("offers the reviewed copies of update-linux.sh and setup-rhel-ha.sh, and every HA root file", () => {
    expect(src).toMatch(/root_helper "\$SRC\/update-linux\.sh" \/usr\/local\/sbin\/polaris-update-linux 0755/);
    for (const pair of [
      "ha/setup-rhel-ha.sh|/usr/local/sbin/polaris-ha-setup|0755|",
      "ha/patroni-callback.sh|/usr/local/sbin/polaris-patroni-callback|0755|",
      "ha/sudoers.d/polaris-ha|/etc/sudoers.d/polaris-ha|0440|visudo_ok",
      "ha/ha-rsync-exclude|/etc/polaris/ha-rsync-exclude|0644|",
    ]) expect(src).toContain(`"${pair}"`);
  });

  const script = join(process.cwd(), "deploy", "scripts", "polaris-update-sync.sh").replace(/\\/g, "/");
  it.skipIf(!haveBash)("refuses --ha without --install", () => {
    const r = spawnSync("bash", [script, "--ha"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--ha goes with --install/);
  });
  it.skipIf(!haveBash)("lists --ha in its usage line", () => {
    const r = spawnSync("bash", [script, "--nope"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--install \[--ha\] \[--yes\]/);
  });
});
