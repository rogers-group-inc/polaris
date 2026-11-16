/**
 * tests/unit/trustedCaService.test.ts — business rule 189: uploaded CAs join
 * the process's default TLS trust store, on top of the ORIGINAL default,
 * applied once per distinct list, malformed PEMs skipped, never throwing.
 * node:tls and X509Certificate are mocked — the real store is never touched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  setDefault: vi.fn(),
  getDefault: vi.fn(() => ["ROOT-1\n", "ROOT-2\n"]),
  listCertificates: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock("node:tls", async (orig) => {
  const real = await orig<typeof import("node:tls")>();
  const mod = { ...real, setDefaultCACertificates: h.setDefault, getCACertificates: h.getDefault };
  return { ...mod, default: mod };
});
vi.mock("node:crypto", async (orig) => {
  const real = await orig<typeof import("node:crypto")>();
  class FakeX509 {
    fingerprint256: string;
    constructor(pem: string) {
      if (!pem.includes("BEGIN CERTIFICATE") || pem.includes("BAD")) throw new Error("not a certificate");
      this.fingerprint256 = pem.replace(/\s+/g, "");
    }
  }
  return { ...real, X509Certificate: FakeX509 };
});
vi.mock("../../src/services/serverSettingsService.js", () => ({ listCertificates: h.listCertificates }));
vi.mock("../../src/utils/logger.js", () => {
  const logger: Record<string, unknown> = { info: h.info, warn: h.warn, error: vi.fn(), debug: vi.fn() };
  logger.child = () => logger;
  return { logger };
});

import tls from "node:tls";
import {
  applyTrustedCas, refreshTrustedCas, usableCaPems, trustedCaSupported, _resetTrustedCasForTests,
} from "../../src/services/trustedCaService.js";

const pem = (n: string) => `-----BEGIN CERTIFICATE-----\n${n}\n-----END CERTIFICATE-----`;

beforeEach(() => {
  vi.clearAllMocks();
  h.getDefault.mockImplementation(() => ["ROOT-1\n", "ROOT-2\n"]);
  _resetTrustedCasForTests();
});

describe("usableCaPems", () => {
  it("keeps parseable certificates once each, skipping malformed ones", () => {
    const out = usableCaPems([pem("QQA"), "garbage", pem("QQB"), pem("QQA"), pem("BAD")]);
    expect(out.usable.map((p) => p.includes("QQA") ? "A" : "B")).toEqual(["A", "B"]);
    expect(out.skipped).toBe(2);
  });
});

describe("applyTrustedCas", () => {
  it("sets the store to the ORIGINAL default plus the uploads", () => {
    expect(applyTrustedCas([pem("QQA")])).toEqual({ added: 1, skipped: 0 });
    expect(h.getDefault).toHaveBeenCalledWith("default");
    const set = h.setDefault.mock.calls[0]![0] as string[];
    expect(set.slice(0, 2)).toEqual(["ROOT-1\n", "ROOT-2\n"]);
    expect(set).toHaveLength(3);
    expect(set[2]).toContain("QQA");
  });

  it("applies the same list once, and a changed list on top of the baseline, not the last set", () => {
    applyTrustedCas([pem("QQA")]);
    applyTrustedCas([pem("QQA")]);
    expect(h.setDefault).toHaveBeenCalledTimes(1);
    // The live default now includes A — the baseline must not be re-read.
    h.getDefault.mockImplementation(() => ["ROOT-1\n", "ROOT-2\n", pem("QQA") + "\n"]);
    applyTrustedCas([pem("QQB")]);
    const set = h.setDefault.mock.calls[1]![0] as string[];
    expect(set).toHaveLength(3);
    expect(set.some((p) => p.includes("QQA"))).toBe(false);
    expect(h.getDefault).toHaveBeenCalledTimes(1);
  });

  it("removing every upload restores the original default", () => {
    applyTrustedCas([pem("QQA")]);
    applyTrustedCas([]);
    expect(h.setDefault.mock.calls[1]![0]).toEqual(["ROOT-1\n", "ROOT-2\n"]);
  });

  it("on a Node without the API: applies nothing and warns once", () => {
    const t = tls as unknown as Record<string, unknown>;
    const saved = t.setDefaultCACertificates;
    t.setDefaultCACertificates = undefined;
    try {
      expect(trustedCaSupported()).toBe(false);
      expect(applyTrustedCas([pem("QQA")])).toBeNull();
      expect(applyTrustedCas([pem("QQA")])).toBeNull();
      expect(h.warn).toHaveBeenCalledTimes(1);
    } finally {
      t.setDefaultCACertificates = saved;
    }
  });
});

describe("refreshTrustedCas", () => {
  it("applies the uploaded CA certificates only (no keys, no server certs)", async () => {
    h.listCertificates.mockResolvedValue({
      trustedCAs: [{ type: "cert", pem: pem("QQA") }, { type: "key", pem: "-----BEGIN PRIVATE KEY-----" }],
      serverCerts: [{ type: "cert", pem: pem("QQS") }],
    });
    await refreshTrustedCas();
    const set = h.setDefault.mock.calls[0]![0] as string[];
    expect(set).toHaveLength(3);
    expect(set[2]).toContain("QQA");
  });

  it("never throws: a settings outage keeps the store in force", async () => {
    h.listCertificates.mockRejectedValue(new Error("db down"));
    await expect(refreshTrustedCas()).resolves.toBeUndefined();
    expect(h.setDefault).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalled();
  });
});
