/**
 * tests/unit/installerRootFiles.test.ts — business rule 117(k)/(l)/(m)
 * (re-scan phase 14, F1 / F3 / F5 / F4). Re-running an installer — or
 * update-linux.sh / migrate-to-nginx.sh — on an existing install reads
 * /opt/polaris, which the polaris account writes. These pin the contract:
 *
 *   - no root `cp` / `install` straight out of $APP_DIR/deploy except through
 *     root_copy (fresh clone / no review helper) or the reviewed snapshot;
 *   - a re-run hands units, sudoers, polkit and root helpers to the installed
 *     polaris-update-sync --install;
 *   - .env is never written by root, only as the polaris account under
 *     umask 077;
 *   - the shipped nginx config is read as polaris and content-checked on a
 *     re-run;
 *   - every script still parses (`bash -n`).
 *
 * The installers cannot be run here (they need root, systemd, a package
 * manager), so the behaviour that CAN run — the update helper's own option
 * parsing — is exercised for real below.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const INSTALLERS = ["deploy/setup-ubuntu.sh", "deploy/setup-ubuntu-nodb.sh", "deploy/setup-rhel.sh", "deploy/setup-rhel-nodb.sh"];
const ALL = [...INSTALLERS, "deploy/update-linux.sh", "deploy/migrate-to-nginx.sh", "deploy/scripts/polaris-update-sync.sh", "deploy/scripts/polaris-nginx-apply.sh"];
const haveBash = spawnSync("bash", ["-c", "true"]).status === 0;

describe.each(INSTALLERS)("%s", (file) => {
  const src = read(file);
  const body = src.slice(src.indexOf("# ─── Root-owned files on a re-run"));

  it("copies nothing out of $APP_DIR/deploy as root except through root_copy or the reviewed snapshot", () => {
    for (const line of src.split("\n")) {
      if (!/"\$APP_DIR\/deploy\//.test(line)) continue;
      if (/^\s*#/.test(line)) continue;
      expect(line, line).toMatch(/root_copy |cp -P -- |sudo -u "\$APP_USER" cat |\[\[ -f |\$\{?APP_DIR\}?\/deploy\/polkit\/49-polaris\.rules" \]\]/);
    }
  });

  it("marks a fresh clone and decides the path after the tree is in place", () => {
    expect(src).toMatch(/git clone "\$REPO_URL" "\$APP_DIR"\n {2}chown -R "\$APP_USER:\$APP_GROUP" "\$APP_DIR"\n {2}FRESH_TREE=1\nfi\ndecide_root_files\n/);
  });

  it("hands a re-run to the installed polaris-update-sync --install", () => {
    expect(src).toMatch(/if \[\[ "\$ROOT_FILES" == sync \]\]; then\n[^\n]*\n {2}"\$SYNC_HELPER" --install \$\{POLARIS_YES:\+--yes\}/);
    expect(body).toMatch(/\[\[ "\$\(stat -c '%u' "\$SYNC_HELPER"\)" == 0 \]\]/);
  });

  it("never writes .env as root", () => {
    expect(src).not.toMatch(/>>? *"\$APP_DIR\/\.env"/);
    expect(src).not.toMatch(/^\s*chown [^\n]*\.env/m);
    expect(src).toMatch(/env_write\(\) +\{ sudo -u "\$APP_USER" sh -c 'umask 077; cat > +"\$1"' _ "\$APP_DIR\/\.env"; \}/);
    expect(src).toMatch(/env_append\(\) \{ sudo -u "\$APP_USER" sh -c 'umask 077; cat >> "\$1"' _ "\$APP_DIR\/\.env"; \}/);
    expect(src).toMatch(/env_write <<ENVFILE/);
  });

  it("reads the shipped nginx config as polaris and checks it on a re-run", () => {
    expect(src).toMatch(/sudo -u "\$APP_USER" cat "\$APP_DIR\/deploy\/nginx\/polaris\.conf" \| sed /);
    expect(src).toMatch(/if \[\[ \$FRESH_TREE -eq 0 \]\] && ! nginx_conf_checked "\$NGINX_CONF_NEW"; then/);
  });

  // RHEL 9.5 VM run: data/ was left root:root, polaris-web exited on
  // EACCES mkdir data/backups.
  it("hands data/ itself to the app account, not only its children", () => {
    expect(src).toMatch(/mkdir -p "\$APP_DIR\/data"\nchown "\$APP_USER:\$APP_GROUP" "\$APP_DIR\/data"\n/);
  });

  // A re-run rewrites polaris.conf; starting an already-running nginx is a no-op.
  it("reloads a running nginx before starting polaris.target", () => {
    expect(src).toMatch(/if systemctl is-active -q nginx; then systemctl reload nginx [^\n]*\nsystemctl start polaris\.target/);
  });

  it("smoke-checks :3000 by address, not by a process name ss does not print", () => {
    expect(src).not.toMatch(/3000\.\*node/);
  });
});

// RHEL 9.5 VM run, SELinux enforcing: udp/443 is reserved_port_t (the QUIC
// bind fails, so nginx drops the whole Polaris server block), :3000 is
// ntop_port_t (502 without httpd_can_network_connect), and a stopped nginx's
// `nginx -t` leaves an unconfined /run/nginx.pid the real start can't write.
describe.each(["deploy/setup-rhel.sh", "deploy/setup-rhel-nodb.sh", "deploy/ha/setup-rhel-ha.sh", "deploy/migrate-to-nginx.sh"])("%s SELinux", (file) => {
  const src = read(file);
  it("labels udp/443 http_port_t and lets nginx connect out", () => {
    expect(src).toMatch(/semanage port -a -t http_port_t -p udp 443/);
    expect(src).toMatch(/setsebool -P httpd_can_network_connect 1/);
  });
  it.skipIf(file.includes("/ha/") || file.includes("migrate"))("drops the pid file a stopped nginx's nginx -t leaves", () => {
    expect(src).toMatch(/\nnginx -t\n(#[^\n]*\n)*systemctl is-active -q nginx \|\| rm -f \/run\/nginx\.pid\n/);
  });
});

// RHEL 9.5 VM run: the DVD's Node 22.4 passed the old `v22*` check and npm ci
// then died in Prisma's preinstall. node_ok is the project floor: 24+, or 22.12+.
describe.skipIf(!haveBash).each([...INSTALLERS, "deploy/ha/setup-rhel-ha.sh"])("%s node_ok", (file) => {
  const src = read(file);
  const fn = src.match(/^node_ok\(\) \{\n[\s\S]*?\n\}\n/m)?.[0];
  const ok = (v: string) =>
    spawnSync("bash", ["-c", `${fn}\nnode() { echo "$V"; }\nnode_ok`], { encoding: "utf8", env: { ...process.env, V: v } }).status === 0;

  it("is defined", () => expect(fn).toBeTruthy());
  it.each(["v24.0.0", "v25.1.0", "v22.12.0", "v22.19.1"])("accepts %s", (v) => expect(ok(v)).toBe(true));
  it.each(["v22.4.1", "v22.11.9", "v20.18.0", "v18.0.0", "garbage"])("refuses %s", (v) => expect(ok(v)).toBe(false));
});

describe("update-linux.sh and migrate-to-nginx.sh", () => {
  it("update-linux.sh copies from the tree only in the legacy (no review helper) path", () => {
    const src = read("deploy/update-linux.sh");
    expect(src).toMatch(/legacy_sync_unit_files \|\| true\n {2}legacy_sync_ha_artifacts \|\| true\n {2}legacy_sync_update_helper \|\| true/);
    expect(src).not.toMatch(/^sync_unit_files \|\|/m);
    expect(src).toMatch(/sudo -u "\$APP_USER" cat "\$src" > "\$stage"\n {2}if ! nginx_conf_checked "\$stage"; then/);
  });

  it("migrate-to-nginx.sh content-checks the config and writes .env as polaris", () => {
    const src = read("deploy/migrate-to-nginx.sh");
    expect(src).toMatch(/if ! nginx_conf_checked "\$TMP\/polaris\.conf"; then/);
    expect(src).toMatch(/\} \| env_append/);
    expect(src).not.toMatch(/>> "\$ENV_FILE"/);
  });
});

describe.skipIf(!haveBash)("every script parses", () => {
  it.each(ALL)("%s", (file) => {
    const r = spawnSync("bash", ["-n", join(process.cwd(), file).replace(/\\/g, "/")], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

describe.skipIf(!haveBash)("polaris-update-sync options", () => {
  const script = join(process.cwd(), "deploy", "scripts", "polaris-update-sync.sh").replace(/\\/g, "/");
  it("accepts --install, and refuses it without root", () => {
    const r = spawnSync("bash", [script, "--install"], { encoding: "utf8" });
    // On a dev box this is not root: refused before touching anything.
    if (process.getuid?.() === 0) return;
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--install must run as root/);
  });
  it("rejects an unknown option with the usage line", () => {
    const r = spawnSync("bash", [script, "--bogus"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--install \[--ha\] \[--yes\]/);
  });
});
