/**
 * tests/unit/nginxConfigParser.test.ts
 *
 * Covers the bootstrap-only parser that reads /etc/nginx/conf.d/polaris.conf
 * and extracts the 6 user-settable directives. Round-trips through the
 * renderer to assert parse-render-parse stability.
 */

import { describe, expect, it } from "vitest";
import { parseNginxConfigText } from "../../src/services/nginxConfigParser.js";
import { renderNginxConfig } from "../../src/services/nginxRenderer.js";
import { defaultProxyConfig, type ProxyConfig } from "../../src/types/proxyConfig.js";

// Baseline apiDocsAllow mirrors the shipped default (enabled, rfc1918 +
// loopback) so every round-trip below ALSO proves the /api block's allow
// lines never leak into prometheusAllowIps — the cross-contamination the
// parser's block-scoped collection exists to prevent.
const ENV = {
  serverName: "polaris.example.com",
  polarisPort: 3000,
  dashPort: 3001,
  apiDocsAllow: {
    enabled: true,
    allow: ["127.0.0.0/8", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
  },
};

function cfg(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return { ...defaultProxyConfig(), ...overrides };
}

describe("parseNginxConfigText — round-trip from renderer", () => {
  it("parses defaults out of a freshly-rendered config", () => {
    const { contents } = renderNginxConfig({ config: cfg(), ...ENV });
    const { config: parsed, drift } = parseNginxConfigText(contents);

    expect(drift).toEqual([]);
    expect(parsed.httpsPort).toBe(443);
    expect(parsed.http3Enabled).toBe(true);
    expect(parsed.tlsProtocols).toEqual(["TLSv1.2", "TLSv1.3"]);
    expect(parsed.hsts).toEqual({
      enabled: true,
      maxAgeSeconds: 31536000,
      includeSubDomains: true,
      preload: true,
    });
    // The /api docs block carries five allow lines in this render — none may
    // reach the Prometheus list (block-scoped collection).
    expect(parsed.prometheusAllowIps).toEqual([]);
  });

  it("recovers a port change", () => {
    const { contents } = renderNginxConfig({ config: cfg({ httpsPort: 8443 }), ...ENV });
    const { config: parsed } = parseNginxConfigText(contents);
    expect(parsed.httpsPort).toBe(8443);
  });

  it("recovers http3=false", () => {
    const { contents } = renderNginxConfig({ config: cfg({ http3Enabled: false }), ...ENV });
    const { config: parsed } = parseNginxConfigText(contents);
    expect(parsed.http3Enabled).toBe(false);
  });

  it("recovers hsts=off", () => {
    const { contents } = renderNginxConfig({
      config: cfg({ hsts: { ...cfg().hsts, enabled: false } }),
      ...ENV,
    });
    const { config: parsed } = parseNginxConfigText(contents);
    expect(parsed.hsts.enabled).toBe(false);
  });

  it("recovers custom HSTS max-age + missing preload", () => {
    const { contents } = renderNginxConfig({
      config: cfg({
        hsts: { enabled: true, maxAgeSeconds: 7200, includeSubDomains: true, preload: false },
      }),
      ...ENV,
    });
    const { config: parsed } = parseNginxConfigText(contents);
    expect(parsed.hsts).toEqual({
      enabled: true,
      maxAgeSeconds: 7200,
      includeSubDomains: true,
      preload: false,
    });
  });

  it("recovers TLSv1.3-only", () => {
    const { contents } = renderNginxConfig({ config: cfg({ tlsProtocols: ["TLSv1.3"] }), ...ENV });
    const { config: parsed } = parseNginxConfigText(contents);
    expect(parsed.tlsProtocols).toEqual(["TLSv1.3"]);
  });

  it("recovers a multi-IP Prometheus allow-list", () => {
    const { contents } = renderNginxConfig({
      config: cfg({ prometheusAllowIps: ["10.0.0.42", "10.0.0.43"] }),
      ...ENV,
    });
    const { config: parsed } = parseNginxConfigText(contents);
    // Order may not match — the parser dedupes via Set. The /api block's five
    // RFC1918/loopback allows are in the same file and must NOT appear here.
    expect(parsed.prometheusAllowIps.sort()).toEqual(["10.0.0.42", "10.0.0.43"]);
  });
});

describe("parseNginxConfigText — drift detection", () => {
  it("flags an unknown proxy_pass target", () => {
    const { contents } = renderNginxConfig({ config: cfg(), ...ENV });
    const tampered = contents.replace(
      "proxy_pass http://127.0.0.1:9110/metrics;",
      "proxy_pass http://192.168.1.1:9999/api;"
    );
    const { drift } = parseNginxConfigText(tampered);
    expect(drift.some((d) => d.includes("unknown proxy_pass"))).toBe(true);
  });

  it("flags an unknown add_header line", () => {
    const { contents } = renderNginxConfig({ config: cfg(), ...ENV });
    const tampered = contents.replace(
      "server_name polaris.example.com;",
      "server_name polaris.example.com;\n  add_header X-Custom-Banner 'acme' always;"
    );
    const { drift } = parseNginxConfigText(tampered);
    expect(drift.some((d) => d.includes("unknown add_header: X-Custom-Banner"))).toBe(true);
  });

  it("flags a location-block count mismatch", () => {
    const { contents } = renderNginxConfig({ config: cfg(), ...ENV });
    const tampered = contents.replace(
      "}\n",
      "}\n  location = /custom { proxy_pass http://127.0.0.1:3000; }\n",
    );
    const { drift } = parseNginxConfigText(tampered);
    expect(drift.some((d) => d.includes("location block count"))).toBe(true);
  });

  it("returns empty drift on an exact-shape rendered config", () => {
    const { contents } = renderNginxConfig({
      config: cfg({ prometheusAllowIps: ["10.0.0.42"] }),
      ...ENV,
    });
    const { drift } = parseNginxConfigText(contents);
    expect(drift).toEqual([]);
  });
});

describe("parseNginxConfigText — missing pieces", () => {
  it("flags a missing `listen <port> ssl` directive but still returns defaults", () => {
    const { config, drift } = parseNginxConfigText("server { listen 80; }");
    expect(config.httpsPort).toBe(443); // default
    expect(drift.some((d) => d.includes("listen <port> ssl"))).toBe(true);
  });

  it("treats absent http3/quic as http3=false", () => {
    const minimal = `server {
  listen 443 ssl;
  ssl_protocols TLSv1.2 TLSv1.3;
  location / { proxy_pass http://127.0.0.1:3000; }
  location = /dash { proxy_pass http://127.0.0.1:3001; }
  location /dash/ { proxy_pass http://127.0.0.1:3001; }
  location = /metrics { proxy_pass http://127.0.0.1:3000/metrics; }
  location = /metrics-monitor-1 { proxy_pass http://127.0.0.1:9101/metrics; }
  location = /metrics-monitor-2 { proxy_pass http://127.0.0.1:9102/metrics; }
  location = /metrics-discovery { proxy_pass http://127.0.0.1:9110/metrics; }
}`;
    const { config } = parseNginxConfigText(minimal);
    expect(config.http3Enabled).toBe(false);
  });

  it("reports drift on a pre-dash 5-location config (forces re-adoption after upgrade)", () => {
    const preDash = `server {
  listen 443 ssl;
  ssl_protocols TLSv1.2 TLSv1.3;
  location / { proxy_pass http://127.0.0.1:3000; }
  location = /metrics { proxy_pass http://127.0.0.1:3000/metrics; }
  location = /metrics-monitor-1 { proxy_pass http://127.0.0.1:9101/metrics; }
  location = /metrics-monitor-2 { proxy_pass http://127.0.0.1:9102/metrics; }
  location = /metrics-discovery { proxy_pass http://127.0.0.1:9110/metrics; }
}`;
    const { drift } = parseNginxConfigText(preDash);
    expect(drift.some((d) => d.includes("location block count is 5 (expected 10)"))).toBe(true);
  });

  it("reports drift on a pre-restore-override 7-location config", () => {
    // The generation before the database-restore client_max_body_size override:
    // / + 2 dash + 4 metrics. Same re-adopt path as the pre-dash case — the
    // operator must adopt so the restore block lands explicitly, because
    // without it an oversized restore upload dies at nginx with a 413.
    const preRestore = `server {
  listen 443 ssl;
  ssl_protocols TLSv1.2 TLSv1.3;
  location / { proxy_pass http://127.0.0.1:3000; }
  location = /dash { proxy_pass http://127.0.0.1:3001; }
  location /dash/ { proxy_pass http://127.0.0.1:3001; }
  location = /metrics { proxy_pass http://127.0.0.1:3000/metrics; }
  location = /metrics-monitor-1 { proxy_pass http://127.0.0.1:9101/metrics; }
  location = /metrics-monitor-2 { proxy_pass http://127.0.0.1:9102/metrics; }
  location = /metrics-discovery { proxy_pass http://127.0.0.1:9110/metrics; }
}`;
    const { drift } = parseNginxConfigText(preRestore);
    expect(drift.some((d) => d.includes("location block count is 7 (expected 10)"))).toBe(true);
  });

  it("reports drift on a pre-api-docs 8-location config (forces re-adoption after upgrade)", () => {
    // The generation before the /api docs block: / + restore override + 2 dash
    // + 4 metrics. Same designed refuse-and-banner path — the operator adopts
    // so the docs block lands explicitly rather than by silent clobber.
    const preApiDocs = `server {
  listen 443 ssl;
  ssl_protocols TLSv1.2 TLSv1.3;
  location / { proxy_pass http://127.0.0.1:3000; }
  location = /api/v1/server-settings/database/restore { proxy_pass http://127.0.0.1:3000; }
  location = /dash { proxy_pass http://127.0.0.1:3001; }
  location /dash/ { proxy_pass http://127.0.0.1:3001; }
  location = /metrics { allow 10.0.0.42; deny all; proxy_pass http://127.0.0.1:3000/metrics; }
  location = /metrics-monitor-1 { allow 10.0.0.42; deny all; proxy_pass http://127.0.0.1:9101/metrics; }
  location = /metrics-monitor-2 { allow 10.0.0.42; deny all; proxy_pass http://127.0.0.1:9102/metrics; }
  location = /metrics-discovery { allow 10.0.0.42; deny all; proxy_pass http://127.0.0.1:9110/metrics; }
}`;
    const { config, drift } = parseNginxConfigText(preApiDocs);
    expect(drift.some((d) => d.includes("location block count is 8 (expected 10)"))).toBe(true);
    // Single-line location bodies still parse: the Prometheus IP is seeded.
    expect(config.prometheusAllowIps).toEqual(["10.0.0.42"]);
  });

  it("reports drift on a pre-firmware 9-location config (forces re-adoption after upgrade)", () => {
    // The generation before the firmware-image upload override (business rule
    // 87): / + restore override + 2 dash + 4 metrics + the /api docs block.
    // Same refuse-and-banner path — an operator who never adopts is the one
    // whose 100 MiB uploads die at the edge with a 413.
    const preFirmware = `server {
  listen 443 ssl;
  ssl_protocols TLSv1.2 TLSv1.3;
  location / { proxy_pass http://127.0.0.1:3000; }
  location = /api/v1/server-settings/database/restore { proxy_pass http://127.0.0.1:3000; }
  location = /dash { proxy_pass http://127.0.0.1:3001; }
  location /dash/ { proxy_pass http://127.0.0.1:3001; }
  location = /metrics { allow 10.0.0.42; deny all; proxy_pass http://127.0.0.1:3000/metrics; }
  location = /metrics-monitor-1 { allow 10.0.0.42; deny all; proxy_pass http://127.0.0.1:9101/metrics; }
  location = /metrics-monitor-2 { allow 10.0.0.42; deny all; proxy_pass http://127.0.0.1:9102/metrics; }
  location = /metrics-discovery { allow 10.0.0.42; deny all; proxy_pass http://127.0.0.1:9110/metrics; }
  location = /api { allow 10.0.0.42; deny all; proxy_pass http://127.0.0.1:3000; }
}`;
    const { drift } = parseNginxConfigText(preFirmware);
    expect(drift.some((d) => d.includes("location block count is 9 (expected 10)"))).toBe(true);
  });

  it("defaults managedMode=false (bootstrap caller decides when to flip it)", () => {
    const { contents } = renderNginxConfig({ config: cfg(), ...ENV });
    const { config } = parseNginxConfigText(contents);
    expect(config.managedMode).toBe(false);
  });
});
