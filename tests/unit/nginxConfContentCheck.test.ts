/**
 * tests/unit/nginxConfContentCheck.test.ts — business rule 117(m) (re-scan
 * F4). polaris-nginx-apply installs a config the polaris account staged, and
 * `nginx -t` checks syntax only, while nginx configuration names files the
 * ROOT master opens. `nginx_conf_ok` (sourced from the real script, run under
 * a real bash + awk) admits only the directives Polaris's renderer and the
 * shipped config write, with path-bearing ones pinned to Polaris's paths.
 *
 * The positive half renders every combination of the renderer's switches, so
 * a directive added to the template without being added to the allowlist
 * fails here rather than on a customer's Save & Apply.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderNginxConfig } from "../../src/services/nginxRenderer.js";
import { defaultProxyConfig, type ProxyConfig } from "../../src/types/proxyConfig.js";

const haveBash = spawnSync("bash", ["-c", "command -v awk"]).status === 0;
const SCRIPT = join(process.cwd(), "deploy", "scripts", "polaris-nginx-apply.sh").replace(/\\/g, "/");

function check(conf: string): { ok: boolean; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "polaris-ngx-"));
  try {
    const f = join(dir, "polaris.conf");
    writeFileSync(f, conf.replace(/\r\n/g, "\n"));
    const r = spawnSync("bash", ["-c", `POLARIS_NGINX_APPLY_LIB=1 . "${SCRIPT}"; nginx_conf_ok "$1"`, "x", f.replace(/\\/g, "/")], { encoding: "utf8" });
    return { ok: r.status === 0, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ENV = { serverName: "polaris.example.com", polarisPort: 3000, dashPort: 3001 };

function* configs(): Generator<[string, string]> {
  for (const http3Enabled of [true, false]) {
    for (const hstsEnabled of [true, false]) {
      for (const metrics of [[], ["10.0.0.5", "10.1.0.0/16"]]) {
        for (const docs of [{ enabled: false, allow: [] as string[] }, { enabled: true, allow: ["10.0.0.0/8", "192.168.1.7"] }]) {
          const config: ProxyConfig = {
            ...defaultProxyConfig(),
            httpsPort: http3Enabled ? 443 : 8443,
            http3Enabled,
            hsts: { enabled: hstsEnabled, maxAgeSeconds: 600, includeSubDomains: hstsEnabled, preload: false },
            tlsProtocols: ["TLSv1.3"],
            prometheusAllowIps: metrics,
          };
          const { contents } = renderNginxConfig({ config, ...ENV, apiDocsAllow: docs });
          yield [`http3=${http3Enabled} hsts=${hstsEnabled} metrics=${metrics.length} docs=${docs.enabled}`, contents];
        }
      }
    }
  }
}

describe.skipIf(!haveBash)("nginx_conf_ok", () => {
  it.each([...configs()])("accepts the renderer's output (%s)", (_name, conf) => {
    const r = check(conf);
    expect(r.stderr).toBe("");
    expect(r.ok).toBe(true);
  });

  it("accepts the shipped deploy/nginx/polaris.conf as the installers render it", () => {
    const shipped = readFileSync(join(process.cwd(), "deploy", "nginx", "polaris.conf"), "utf8")
      .replace(/polaris\.example\.com/g, "polaris.corp.example").replace(/<PROMETHEUS_IP>/g, "10.0.0.5");
    expect(check(shipped)).toMatchObject({ ok: true });
  });

  const base = renderNginxConfig({ config: defaultProxyConfig(), ...ENV, apiDocsAllow: { enabled: false, allow: [] } }).contents;
  const inServer = (line: string) => base.replace(/server_tokens off;/, `server_tokens off;\n  ${line}`);

  it.each([
    ["include", "include /etc/shadow;"],
    ["root", "location /x { root /; }"],
    ["alias", "location /x { alias /etc/; }"],
    ["access_log", "access_log /etc/cron.d/polaris;"],
    ["error_log", "error_log /root/.ssh/authorized_keys;"],
    ["a foreign certificate path", "ssl_certificate /etc/shadow;"],
    ["a foreign key path", "ssl_certificate_key /root/key.pem;"],
    ["an external proxy_pass", "location /x { proxy_pass http://203.0.113.9; }"],
    ["a unix-socket proxy_pass", "location /x { proxy_pass http://unix:/run/x.sock; }"],
    ["a quoted directive name", "\"include\" /etc/shadow;"],
    ["a statement after a quoted ;", "add_header X \"a; b\"; include /etc/passwd;"],
    ["an if block", "if ($host) { return 403; }"],
  ])("refuses %s", (_what, line) => {
    const r = check(inServer(line));
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/refused config line/);
  });

  // The RHEL VM run printed `directive  name  is not one…`: the quotes around
  // the name had closed the awk string, so the refusal never said which one.
  it("names the refused directive", () => {
    expect(check(inServer("include /etc/shadow;")).stderr).toMatch(/directive "include" is not one Polaris writes/);
    expect(check(inServer("ssl_protocols { }")).stderr).toMatch(/"ssl_protocols" cannot open a block/);
  });

  it("refuses load_module at the top level and an unbalanced file", () => {
    expect(check(`load_module /tmp/evil.so;\n${base}`).ok).toBe(false);
    expect(check(base.replace(/}\s*$/, "")).ok).toBe(false);
  });

  it("refuses a path that is not a regular file", () => {
    const r = spawnSync("bash", ["-c", `POLARIS_NGINX_APPLY_LIB=1 . "${SCRIPT}"; nginx_conf_ok /nonexistent/x`], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
  });
});
