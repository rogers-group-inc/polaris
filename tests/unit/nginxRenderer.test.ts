/**
 * tests/unit/nginxRenderer.test.ts
 *
 * Covers the proxyConfig → nginx config rendering. Assertions are
 * fragment-based (not full golden-file equality) so the template's comments
 * can evolve without churn — but determinism is asserted via sha256 stability
 * across calls with identical input.
 */

import { describe, expect, it } from "vitest";
import { renderNginxConfig } from "../../src/services/nginxRenderer.js";
import { defaultProxyConfig, type ProxyConfig } from "../../src/types/proxyConfig.js";

// apiDocsAllow disabled in the baseline fixture so the metrics allow-list
// assertions stay about the metrics blocks alone; the /api block then renders
// as `deny all;` only, which is why every deny-count below is 5 (4 metrics +
// 1 api-docs). The api-docs block's own variants get their own describe.
const ENV = {
  serverName: "polaris.example.com",
  polarisPort: 3000,
  dashPort: 3001,
  apiDocsAllow: { enabled: false, allow: [] as string[] },
};

function cfg(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return { ...defaultProxyConfig(), ...overrides };
}

describe("renderNginxConfig — defaults", () => {
  const { contents, sha256 } = renderNginxConfig({ config: cfg(), ...ENV });

  it("emits the TCP listener on port 443", () => {
    expect(contents).toMatch(/^\s*listen 443 ssl;/m);
    expect(contents).toMatch(/^\s*http2 on;/m);
  });

  it("emits the QUIC listener with matching port + Alt-Svc header", () => {
    expect(contents).toMatch(/^\s*listen 443 quic reuseport;/m);
    expect(contents).toMatch(/^\s*http3 on;/m);
    expect(contents).toContain(`add_header Alt-Svc 'h3=":443"; ma=86400' always;`);
  });

  it("emits ssl_early_data only when QUIC is enabled", () => {
    expect(contents).toMatch(/ssl_early_data on;/);
  });

  it("emits HSTS with default max-age + includeSubDomains + preload", () => {
    expect(contents).toContain(
      `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;`
    );
  });

  it("emits both TLS protocols", () => {
    expect(contents).toMatch(/ssl_protocols\s+TLSv1\.2 TLSv1\.3;/);
  });

  it("emits only `deny all;` when prometheusAllowIps is empty", () => {
    // 4 metrics location blocks + the (disabled) api-docs block × 1 each = 5.
    expect((contents.match(/deny all;/g) ?? []).length).toBe(5);
    expect(contents).not.toMatch(/^\s*allow\b/m);
  });

  it("substitutes server_name from env input", () => {
    expect(contents).toMatch(/server_name polaris\.example\.com;/);
  });

  it("substitutes upstream port from env input", () => {
    expect(contents).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:3000;/);
    expect(contents).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:3000\/metrics;/);
  });

  it("emits worker metric proxy_pass targets unchanged", () => {
    expect(contents).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:9101\/metrics;/);
    expect(contents).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:9102\/metrics;/);
    expect(contents).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:9110\/metrics;/);
  });

  it("emits the two dash wallboard locations proxying to the dash port", () => {
    expect(contents).toMatch(/^\s*location = \/dash \{/m);
    expect(contents).toMatch(/^\s*location \/dash\/ \{/m);
    // Two dash locations × one proxy_pass each.
    expect((contents.match(/proxy_pass http:\/\/127\.0\.0\.1:3001;/g) ?? []).length).toBe(2);
    // Deliberately NO allow/deny inside the dash locations — the IP gate is
    // app-level (dash process). The only deny lines are the 4 metrics ones
    // plus the api-docs block's.
    expect((contents.match(/deny all;/g) ?? []).length).toBe(5);
  });

  it("substitutes a custom dash port", () => {
    const { contents: custom } = renderNginxConfig({ config: cfg(), ...ENV, dashPort: 4001 });
    expect((custom.match(/proxy_pass http:\/\/127\.0\.0\.1:4001;/g) ?? []).length).toBe(2);
    expect(custom).not.toMatch(/127\.0\.0\.1:3001/);
  });

  it("caps the request body above the largest per-route limit", () => {
    // nginx's 1m default sat BELOW what Polaris's own handlers accept, so an
    // upload the app would have taken (the 5m branding logo) died at the edge
    // with a 413 whose HTML body the frontend couldn't parse. Pinned at the
    // server level so every location inherits it.
    expect(contents).toMatch(/^\s*client_max_body_size 8m;/m);
  });

  it("lifts the body limit for the database-restore upload", () => {
    // A restore carries a pg_dump of the whole database and the route has no
    // fileSize of its own by design, so any finite ceiling here would silently
    // break somebody's restore.
    expect(contents).toMatch(/^\s*location = \/api\/v1\/server-settings\/database\/restore \{/m);
    const block = contents.split("location = /api/v1/server-settings/database/restore {")[1]!.split("}")[0]!;
    expect(block).toMatch(/^\s*client_max_body_size 0;/m);
    // Streaming rather than spooling is what keeps "unlimited" from being able
    // to fill nginx's client_body_temp volume.
    expect(block).toMatch(/^\s*proxy_request_buffering off;/m);
  });

  it("raises the body limit for the firmware image upload to the app's own 100 MiB ceiling", () => {
    // Server Settings → Repository (business rule 87): a switch / AP image is
    // up to 100 MiB and the route's multer limit is exactly that, so the edge
    // gets the same finite number rather than the restore's "unlimited".
    expect(contents).toMatch(/^\s*location = \/api\/v1\/server-settings\/firmware\/images \{/m);
    const block = contents.split("location = /api/v1/server-settings/firmware/images {")[1]!.split("}")[0]!;
    expect(block).toMatch(/^\s*client_max_body_size 100m;/m);
    expect(block).toMatch(/^\s*proxy_request_buffering off;/m);
    expect(block).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  });

  it("only those two locations override the limit", () => {
    // Anchored to directive lines so the surrounding explanatory comments
    // don't count as occurrences: the server-level 8m plus the two overrides.
    expect((contents.match(/^\s*client_max_body_size .+;/gm) ?? []).length).toBe(3);
    expect((contents.match(/^\s*proxy_request_buffering .+;/gm) ?? []).length).toBe(2);
  });

  it("points the restore override at the app upstream, not dash or metrics", () => {
    const block = contents.split("location = /api/v1/server-settings/database/restore {")[1]!.split("}")[0]!;
    expect(block).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  });

  it("is sha256-deterministic across calls", () => {
    const second = renderNginxConfig({ config: cfg(), ...ENV });
    expect(second.sha256).toBe(sha256);
    expect(second.contents).toBe(contents);
  });
});

describe("renderNginxConfig — http3 off", () => {
  const { contents } = renderNginxConfig({ config: cfg({ http3Enabled: false }), ...ENV });

  it("omits the QUIC listener entirely", () => {
    expect(contents).not.toMatch(/listen \d+ quic/);
    expect(contents).not.toMatch(/http3 on/);
  });

  it("omits the Alt-Svc header", () => {
    expect(contents).not.toMatch(/Alt-Svc/);
  });

  it("omits ssl_early_data", () => {
    expect(contents).not.toMatch(/ssl_early_data/);
  });

  it("still emits the TCP listener", () => {
    expect(contents).toMatch(/listen 443 ssl;/);
  });
});

describe("renderNginxConfig — HSTS off", () => {
  const { contents } = renderNginxConfig({
    config: cfg({ hsts: { enabled: false, maxAgeSeconds: 31536000, includeSubDomains: true, preload: true } }),
    ...ENV,
  });

  it("omits the STS header line", () => {
    expect(contents).not.toMatch(/Strict-Transport-Security/);
  });
});

describe("renderNginxConfig — custom HSTS", () => {
  it("respects maxAgeSeconds + omitted subdomains/preload", () => {
    const { contents } = renderNginxConfig({
      config: cfg({
        hsts: { enabled: true, maxAgeSeconds: 60, includeSubDomains: false, preload: false },
      }),
      ...ENV,
    });
    expect(contents).toContain(`add_header Strict-Transport-Security "max-age=60" always;`);
  });

  it("emits just max-age + includeSubDomains when preload is off", () => {
    const { contents } = renderNginxConfig({
      config: cfg({
        hsts: { enabled: true, maxAgeSeconds: 7200, includeSubDomains: true, preload: false },
      }),
      ...ENV,
    });
    expect(contents).toContain(
      `add_header Strict-Transport-Security "max-age=7200; includeSubDomains" always;`
    );
  });
});

describe("renderNginxConfig — TLS protocol scoping", () => {
  it("renders TLSv1.3 only", () => {
    const { contents } = renderNginxConfig({ config: cfg({ tlsProtocols: ["TLSv1.3"] }), ...ENV });
    expect(contents).toMatch(/ssl_protocols\s+TLSv1\.3;/);
  });

  it("renders TLSv1.2 only", () => {
    const { contents } = renderNginxConfig({ config: cfg({ tlsProtocols: ["TLSv1.2"] }), ...ENV });
    expect(contents).toMatch(/ssl_protocols\s+TLSv1\.2;/);
  });
});

describe("renderNginxConfig — port change", () => {
  const { contents } = renderNginxConfig({ config: cfg({ httpsPort: 8443 }), ...ENV });

  it("substitutes the TCP listener port", () => {
    expect(contents).toMatch(/listen 8443 ssl;/);
    expect(contents).not.toMatch(/listen 443 ssl;/);
  });

  it("substitutes the QUIC listener port", () => {
    expect(contents).toMatch(/listen 8443 quic reuseport;/);
  });

  it("substitutes the Alt-Svc port", () => {
    expect(contents).toContain(`add_header Alt-Svc 'h3=":8443"; ma=86400' always;`);
  });
});

describe("renderNginxConfig — Prometheus allow-list", () => {
  it("emits one allow line per IP plus deny all", () => {
    const { contents } = renderNginxConfig({
      config: cfg({ prometheusAllowIps: ["10.0.0.42", "10.0.0.43"] }),
      ...ENV,
    });
    // 4 metrics location blocks each get both allow lines + deny; the fifth
    // deny is the (disabled) api-docs block's.
    expect((contents.match(/allow 10\.0\.0\.42;/g) ?? []).length).toBe(4);
    expect((contents.match(/allow 10\.0\.0\.43;/g) ?? []).length).toBe(4);
    expect((contents.match(/deny all;/g) ?? []).length).toBe(5);
  });

  it("renders deny-only when the allow-list is empty", () => {
    const { contents } = renderNginxConfig({ config: cfg({ prometheusAllowIps: [] }), ...ENV });
    expect((contents.match(/deny all;/g) ?? []).length).toBe(5);
    expect(contents).not.toMatch(/^\s*allow\b/m);
  });
});

describe("renderNginxConfig — server_name + upstream port substitution", () => {
  it("renders custom server_name", () => {
    const { contents } = renderNginxConfig({
      ...ENV,
      config: cfg(),
      serverName: "polaris.acme.corp",
      polarisPort: 3000,
    });
    expect(contents).toMatch(/server_name polaris\.acme\.corp;/);
  });

  it("renders custom upstream port for the web routes only", () => {
    const { contents } = renderNginxConfig({
      ...ENV,
      config: cfg(),
      serverName: "polaris.example.com",
      polarisPort: 8080,
    });
    expect(contents).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:8080;/);
    expect(contents).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:8080\/metrics;/);
    // Worker ports stay fixed.
    expect(contents).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:9101\/metrics;/);
  });
});

describe("renderNginxConfig — API docs allow block", () => {
  it("emits the /api location with the given allows + deny, proxying to the app port", () => {
    const { contents } = renderNginxConfig({
      ...ENV,
      config: cfg(),
      apiDocsAllow: {
        enabled: true,
        allow: ["127.0.0.0/8", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
      },
    });
    expect(contents).toMatch(/^\s*location = \/api \{/m);
    const block = contents.split("location = /api {")[1]!.split("}")[0]!;
    expect(block).toMatch(/^\s*allow 127\.0\.0\.0\/8;/m);
    expect(block).toMatch(/^\s*allow ::1;/m);
    expect(block).toMatch(/^\s*allow 10\.0\.0\.0\/8;/m);
    expect(block).toMatch(/^\s*allow 172\.16\.0\.0\/12;/m);
    expect(block).toMatch(/^\s*allow 192\.168\.0\.0\/16;/m);
    expect(block).toMatch(/^\s*deny all;/m);
    expect(block).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:3000;/);
    // The allows land ONLY in the /api block — the metrics blocks keep their
    // own (empty here) list. 5 allow lines total.
    expect((contents.match(/^\s*allow\b.*;/gm) ?? []).length).toBe(5);
  });

  it("renders deny-only when disabled — off means off at the edge too", () => {
    const { contents } = renderNginxConfig({
      ...ENV,
      config: cfg(),
      apiDocsAllow: { enabled: false, allow: [] },
    });
    const block = contents.split("location = /api {")[1]!.split("}")[0]!;
    expect(block).toMatch(/^\s*deny all;/m);
    expect(block).not.toMatch(/^\s*allow\b/m);
  });

  it("changes the hash when the docs scope changes — drift detection must see it", () => {
    const base = renderNginxConfig({ ...ENV, config: cfg() }).sha256;
    const widened = renderNginxConfig({
      ...ENV,
      config: cfg(),
      apiDocsAllow: { enabled: true, allow: ["127.0.0.0/8", "::1"] },
    }).sha256;
    expect(widened).not.toBe(base);
  });
});

describe("renderNginxConfig — leaves no unsubstituted placeholders", () => {
  it("default config", () => {
    const { contents } = renderNginxConfig({ config: cfg(), ...ENV });
    expect(contents).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("all toggles off", () => {
    const { contents } = renderNginxConfig({
      config: cfg({
        http3Enabled: false,
        hsts: { enabled: false, maxAgeSeconds: 31536000, includeSubDomains: false, preload: false },
        tlsProtocols: ["TLSv1.3"],
        prometheusAllowIps: [],
      }),
      ...ENV,
    });
    expect(contents).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

describe("renderNginxConfig — sha256 stability across irrelevant call shape", () => {
  it("renders identical bytes from identical config across instances", () => {
    const a = renderNginxConfig({ config: cfg({ httpsPort: 8443 }), ...ENV });
    const b = renderNginxConfig({ config: cfg({ httpsPort: 8443 }), ...ENV });
    expect(a.sha256).toBe(b.sha256);
  });

  it("changes hash when any setting changes", () => {
    const base = renderNginxConfig({ config: cfg(), ...ENV }).sha256;
    const portChange = renderNginxConfig({ config: cfg({ httpsPort: 8443 }), ...ENV }).sha256;
    const quicOff = renderNginxConfig({ config: cfg({ http3Enabled: false }), ...ENV }).sha256;
    const hstsOff = renderNginxConfig({
      config: cfg({ hsts: { ...cfg().hsts, enabled: false } }),
      ...ENV,
    }).sha256;
    expect(portChange).not.toBe(base);
    expect(quicOff).not.toBe(base);
    expect(hstsOff).not.toBe(base);
    expect(quicOff).not.toBe(portChange);
  });
});
