/**
 * tests/unit/proxyConfigService.test.ts — the proxyConfig Setting row: parse
 * with defaults, the 5 s cache, the partial merge, and validation (the nginx
 * GUI, business rule 117(o) consumes it).
 *
 * The tlsProtocols injection guard has its own suite
 * (proxyConfigTlsInjection.test.ts); this one covers the rest of the module.
 *
 * Contract: the service header lists the validation rules — httpsPort 1-65535,
 * hsts.maxAgeSeconds a non-negative integer, tlsProtocols a non-empty subset
 * of {TLSv1.2, TLSv1.3} including 1.3 under HTTP/3, every allow-list entry an
 * IP, managedMode boolean — and the PUT route relies on it ("saveProxyConfig
 * → mergeProxyConfig + validateProxyConfig field-checks every value and 400s
 * on bad input"), since saveProxyConfig merges the request body WITHOUT
 * parseProxyConfig's type checks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  getProxyConfig,
  proxyConfigRowExists,
  saveProxyConfig,
  invalidateProxyConfigCache,
} from "../../src/services/proxyConfigService.js";
import { defaultProxyConfig, type ProxyConfig } from "../../src/types/proxyConfig.js";

function stored(value: unknown): void {
  stubbed(prisma.setting.findUnique).mockResolvedValue(value === null ? null : { key: "proxyConfig", value });
}
function lastSaved(): ProxyConfig {
  const calls = stubbed(prisma.setting.upsert).mock.calls;
  return calls[calls.length - 1][0].update.value as ProxyConfig;
}

beforeEach(() => {
  resetDbStub();
  invalidateProxyConfigCache();
  stored(null);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("getProxyConfig (parse)", () => {
  it("answers the defaults with no row", async () => {
    expect(await getProxyConfig()).toEqual(defaultProxyConfig());
    expect(prisma.setting.findUnique).toHaveBeenCalledWith({ where: { key: "proxyConfig" } });
  });

  it("answers the defaults for a non-object row", async () => {
    stored("nonsense");
    expect(await getProxyConfig()).toEqual(defaultProxyConfig());
  });

  it("reads a full stored row", async () => {
    const row: ProxyConfig = {
      httpsPort: 8443,
      hsts: { enabled: false, maxAgeSeconds: 600, includeSubDomains: false, preload: false },
      tlsProtocols: ["TLSv1.3"],
      http3Enabled: false,
      prometheusAllowIps: ["10.0.0.1", "2001:db8::1"],
      managedMode: true,
      lastAppliedAt: "2026-11-01T00:00:00Z",
      lastAppliedHash: "abc",
    };
    stored(row);
    expect(await getProxyConfig()).toEqual(row);
  });

  it("drops bad fields to their defaults one by one", async () => {
    stored({
      httpsPort: 70000,
      hsts: { enabled: "yes", maxAgeSeconds: -5, includeSubDomains: 1, preload: false },
      tlsProtocols: ["TLSv1.0", "SSLv3"],
      http3Enabled: "true",
      prometheusAllowIps: ["10.0.0.1", "not-an-ip", 7, "::1"],
      managedMode: "true",
      lastAppliedAt: 5,
      lastAppliedHash: null,
    });
    const d = defaultProxyConfig();
    const c = await getProxyConfig();
    expect(c.httpsPort).toBe(d.httpsPort);
    expect(c.hsts).toEqual({ enabled: d.hsts.enabled, maxAgeSeconds: d.hsts.maxAgeSeconds, includeSubDomains: d.hsts.includeSubDomains, preload: false });
    expect(c.tlsProtocols).toEqual(d.tlsProtocols);
    expect(c.http3Enabled).toBe(d.http3Enabled);
    expect(c.prometheusAllowIps).toEqual(["10.0.0.1", "::1"]);
    expect(c.managedMode).toBe(false);
    expect(c.lastAppliedAt).toBeNull();
    expect(c.lastAppliedHash).toBeNull();
  });

  it("accepts a numeric-string port and floors a fractional max-age", async () => {
    stored({ httpsPort: "8443", hsts: { maxAgeSeconds: 99.9 } });
    const c = await getProxyConfig();
    expect(c.httpsPort).toBe(8443);
    expect(c.hsts.maxAgeSeconds).toBe(99);
  });

  it("keeps the allowed protocols of a mixed list, and an explicitly empty allow-list", async () => {
    stored({ tlsProtocols: ["TLSv1.0", "TLSv1.3"], prometheusAllowIps: [] });
    const c = await getProxyConfig();
    expect(c.tlsProtocols).toEqual(["TLSv1.3"]);
    expect(c.prometheusAllowIps).toEqual([]);
  });
});

describe("getProxyConfig (cache)", () => {
  it("serves from cache for 5 s, then re-reads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T00:00:00Z"));
    stored({ httpsPort: 1443 });
    expect((await getProxyConfig()).httpsPort).toBe(1443);
    stored({ httpsPort: 2443 });
    vi.setSystemTime(new Date("2026-11-16T00:00:04.999Z"));
    expect((await getProxyConfig()).httpsPort).toBe(1443);
    vi.setSystemTime(new Date("2026-11-16T00:00:05Z"));
    expect((await getProxyConfig()).httpsPort).toBe(2443);
    expect(prisma.setting.findUnique).toHaveBeenCalledTimes(2);
  });

  it("invalidateProxyConfigCache forces a re-read", async () => {
    stored({ httpsPort: 1443 });
    await getProxyConfig();
    stored({ httpsPort: 2443 });
    invalidateProxyConfigCache();
    expect((await getProxyConfig()).httpsPort).toBe(2443);
  });
});

describe("proxyConfigRowExists", () => {
  it("is false with no row and true with one (even an unparseable one)", async () => {
    expect(await proxyConfigRowExists()).toBe(false);
    stored("garbage");
    expect(await proxyConfigRowExists()).toBe(true);
  });
});

describe("saveProxyConfig — merge", () => {
  it("merges a partial update over the current row and persists the whole config", async () => {
    stored({ httpsPort: 8443, prometheusAllowIps: ["10.0.0.1"] });
    const out = await saveProxyConfig({ http3Enabled: false });
    expect(out).toEqual({ ...defaultProxyConfig(), httpsPort: 8443, prometheusAllowIps: ["10.0.0.1"], http3Enabled: false });
    expect(prisma.setting.upsert).toHaveBeenCalledWith({
      where: { key: "proxyConfig" },
      update: { value: out },
      create: { key: "proxyConfig", value: out },
    });
  });

  it("merges hsts field by field", async () => {
    const out = await saveProxyConfig({ hsts: { preload: false } as ProxyConfig["hsts"] });
    expect(out.hsts).toEqual({ ...defaultProxyConfig().hsts, preload: false });
  });

  it("lets lastAppliedAt / lastAppliedHash be cleared with an explicit null", async () => {
    stored({ lastAppliedAt: "2026-11-01T00:00:00Z", lastAppliedHash: "abc" });
    const out = await saveProxyConfig({ lastAppliedAt: null, lastAppliedHash: null });
    expect(out.lastAppliedAt).toBeNull();
    expect(out.lastAppliedHash).toBeNull();
    invalidateProxyConfigCache();
    const kept = await saveProxyConfig({ httpsPort: 443 });
    expect(kept.lastAppliedHash).toBe("abc");
  });

  it("invalidates the cache after a write so the next read is the DB's", async () => {
    await getProxyConfig();
    await saveProxyConfig({ httpsPort: 9443 });
    stored({ httpsPort: 9443 });
    expect((await getProxyConfig()).httpsPort).toBe(9443);
    expect(prisma.setting.findUnique).toHaveBeenCalledTimes(2);
  });

  it("accepts IPv4 and IPv6 allow-list entries", async () => {
    const out = await saveProxyConfig({ prometheusAllowIps: ["192.0.2.10", "2001:db8::10", "::1"] });
    expect(out.prometheusAllowIps).toEqual(["192.0.2.10", "2001:db8::10", "::1"]);
  });
});

describe("saveProxyConfig — validation (400, nothing written)", () => {
  const cases: Array<[string, Partial<ProxyConfig>, RegExp]> = [
    ["port 0", { httpsPort: 0 }, /httpsPort/],
    ["port 65536", { httpsPort: 65536 }, /httpsPort/],
    ["fractional port", { httpsPort: 443.5 }, /httpsPort/],
    ["string port", { httpsPort: "443" as never }, /httpsPort/],
    ["negative max-age", { hsts: { ...defaultProxyConfig().hsts, maxAgeSeconds: -1 } }, /maxAgeSeconds/],
    ["fractional max-age", { hsts: { ...defaultProxyConfig().hsts, maxAgeSeconds: 1.5 } }, /maxAgeSeconds/],
    ["empty protocol list", { tlsProtocols: [] }, /at least one/],
    ["HTTP/3 without TLSv1.3", { http3Enabled: true, tlsProtocols: ["TLSv1.2"] }, /QUIC/],
    ["a hostname in the allow-list", { prometheusAllowIps: ["prom.example.com"] }, /Invalid Prometheus allow IP/],
    ["a CIDR in the allow-list", { prometheusAllowIps: ["10.0.0.0/8"] }, /Invalid Prometheus allow IP/],
    ["a non-string allow-list entry", { prometheusAllowIps: [42 as never] }, /Invalid Prometheus allow IP/],
  ];

  it.each(cases)("refuses %s", async (_label, input, msg) => {
    await expect(saveProxyConfig(input)).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(msg) });
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });

  it("allows TLSv1.2 alone once HTTP/3 is off", async () => {
    const out = await saveProxyConfig({ http3Enabled: false, tlsProtocols: ["TLSv1.2"] });
    expect(lastSaved().tlsProtocols).toEqual(["TLSv1.2"]);
    expect(out.http3Enabled).toBe(false);
  });

  it("propagates a failed write", async () => {
    stubbed(prisma.setting.upsert).mockRejectedValue(new Error("write failed"));
    await expect(saveProxyConfig({ httpsPort: 8443 })).rejects.toThrow("write failed");
  });

  // Was a bug until 2026-11-14: saveProxyConfig({ managedMode: "false" }) resolves and persists the
  // STRING "false" (truthy — nginxApplyService's `if (!cfg.managedMode)` gate
  // reads it as adopted). The service header lists "managedMode: boolean" as a
  // validation rule; validateProxyConfig never checks it. Right: a 400, nothing
  // written. (The PUT route refuses managedMode, but POST /apply passes its
  // body straight to saveProxyConfig.)
  it("refuses a non-boolean managedMode", async () => {
    await expect(saveProxyConfig({ managedMode: "false" as never })).rejects.toMatchObject({ httpStatus: 400 });
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });

  // Was a bug until 2026-11-14: saveProxyConfig({ http3Enabled: "false" }) (and the same for the hsts
  // flags) persists the string, which the renderer reads as TRUE — the operator
  // turned HTTP/3 off and nginx gets `listen … quic` + `ssl_early_data on`; on
  // the next cache miss parseProxyConfig then flips it to the default (true).
  // The PUT route's comment says validateProxyConfig "field-checks every value
  // and 400s on bad input". Right: a 400, nothing written.
  it("refuses non-boolean http3Enabled / hsts flags", async () => {
    await expect(saveProxyConfig({ http3Enabled: "false" as never })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(
      saveProxyConfig({ hsts: { ...defaultProxyConfig().hsts, enabled: "false" as never } }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });
});
