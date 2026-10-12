/**
 * tests/unit/proxyConfigTlsInjection.test.ts
 *
 * `tlsProtocols` is written UNQUOTED into `ssl_protocols ...;` in the nginx
 * config Polaris installs as root. saveProxyConfig merges the request body
 * without parseProxyConfig's allowlist, so the allowlist has to hold in
 * validateProxyConfig and again in the renderer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { upsert } = vi.hoisted(() => ({ upsert: vi.fn(async () => ({})) }));
vi.mock("../../src/db.js", () => ({
  prisma: { setting: { findUnique: vi.fn(async () => null), upsert } },
}));

import { saveProxyConfig, invalidateProxyConfigCache } from "../../src/services/proxyConfigService.js";
import { renderNginxConfig } from "../../src/services/nginxRenderer.js";
import { defaultProxyConfig } from "../../src/types/proxyConfig.js";

const ENV = {
  serverName: "polaris.example.com",
  polarisPort: 3000,
  dashPort: 3001,
  apiDocsAllow: { enabled: false, allow: [] as string[] },
};

beforeEach(() => {
  upsert.mockClear();
  invalidateProxyConfigCache();
});

describe("saveProxyConfig — tlsProtocols", () => {
  it("accepts the two real protocols", async () => {
    const saved = await saveProxyConfig({ tlsProtocols: ["TLSv1.2", "TLSv1.3"] });
    expect(saved.tlsProtocols).toEqual(["TLSv1.2", "TLSv1.3"]);
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("refuses an element that would smuggle a directive into the config", async () => {
    const hostile = "TLSv1.3;\n    include /etc/shadow";
    await expect(saveProxyConfig({ tlsProtocols: [hostile as any] })).rejects.toMatchObject({ httpStatus: 400 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses a hostile element even alongside a valid one", async () => {
    await expect(
      saveProxyConfig({ tlsProtocols: ["TLSv1.3", "TLSv1.3; ssl_certificate /tmp/x" as any] }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses protocols outside the allowlist rather than quietly dropping them", async () => {
    await expect(saveProxyConfig({ tlsProtocols: ["TLSv1.0" as any] })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("refuses a non-array value", async () => {
    await expect(saveProxyConfig({ tlsProtocols: "TLSv1.3" as any })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("refuses a non-array prometheusAllowIps instead of crashing on it", async () => {
    await expect(saveProxyConfig({ prometheusAllowIps: "10.0.0.1" as any })).rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe("renderNginxConfig — defence in depth", () => {
  it("renders the allowlisted protocols", () => {
    const { contents } = renderNginxConfig({ config: { ...defaultProxyConfig(), tlsProtocols: ["TLSv1.2", "TLSv1.3"] }, ...ENV });
    expect(contents).toContain("TLSv1.2 TLSv1.3");
  });

  it("refuses to render a stored config carrying anything else", () => {
    const config = { ...defaultProxyConfig(), tlsProtocols: ["TLSv1.3; include /etc/x" as any] };
    expect(() => renderNginxConfig({ config, ...ENV })).toThrow(/unsupported value/);
  });
});
