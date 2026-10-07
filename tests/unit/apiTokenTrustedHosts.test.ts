/**
 * tests/unit/apiTokenTrustedHosts.test.ts
 *
 * Per-token trusted hosts in apiTokenService:
 *   - normalizeTrustedHosts validates, canonicalizes and de-duplicates the
 *     operator's list, and an empty list stays empty ("any source")
 *   - verifyToken accepts a matching source, refuses a non-matching one as
 *     `untrusted_host` (never as a plain invalid token), fails closed on an
 *     unknown caller address, and leaves an empty list unrestricted
 *   - a refusal writes one warning Event per (token, address) per window and
 *     does not bump lastUsed
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    apiToken: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  logEvent: vi.fn(),
  verifyPassword: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));
vi.mock("../../src/utils/password.js", () => ({
  hashPassword: vi.fn(async () => "hash"),
  verifyPassword: h.verifyPassword,
}));

import {
  MAX_TRUSTED_HOSTS,
  normalizeTrustedHosts,
  updateTrustedHosts,
  verifyToken,
  _resetUntrustedHostEventThrottle,
} from "../../src/services/apiTokenService.js";

const RAW = "polaris_abcdefgh" + "x".repeat(24);

function tokenRow(trustedHosts: string[]) {
  return {
    id: "tok-1",
    name: "siem",
    tokenHash: "hash",
    tokenPrefix: RAW.slice(0, 16),
    roleId: "role-1",
    integrationIds: [],
    trustedHosts,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetUntrustedHostEventThrottle();
  h.verifyPassword.mockResolvedValue({ valid: true });
  h.prisma.apiToken.update.mockResolvedValue({});
});

describe("normalizeTrustedHosts", () => {
  it("returns [] for empty, blank or missing input", () => {
    expect(normalizeTrustedHosts(undefined)).toEqual([]);
    expect(normalizeTrustedHosts(null)).toEqual([]);
    expect(normalizeTrustedHosts([])).toEqual([]);
    expect(normalizeTrustedHosts(["", "  "])).toEqual([]);
  });

  it("accepts IPv4/IPv6 addresses and CIDRs, trimmed and lowercased", () => {
    expect(normalizeTrustedHosts([" 10.20.5.14 ", "10.20.0.0/16", "2001:DB8::1", "2001:db8::/32"])).toEqual([
      "10.20.5.14",
      "10.20.0.0/16",
      "2001:db8::1",
      "2001:db8::/32",
    ]);
  });

  it("zeroes host bits on an IPv4 CIDR and de-duplicates the result", () => {
    expect(normalizeTrustedHosts(["10.1.2.5/24", "10.1.2.0/24", "10.1.2.5/24"])).toEqual(["10.1.2.0/24"]);
  });

  it("rejects typos with a 400 naming every bad entry", () => {
    expect(() => normalizeTrustedHosts(["10.1.2.300", "10.0.0.0/33", "host.example", "10.1.1.1"])).toThrow(
      /10\.1\.2\.300, 10\.0\.0\.0\/33, host\.example/,
    );
  });

  it("rejects an IPv6 CIDR whose address half is not an address", () => {
    expect(() => normalizeTrustedHosts(["zz::/64"])).toThrow(/Invalid trusted host/);
  });

  it("caps the list length", () => {
    const many = Array.from({ length: MAX_TRUSTED_HOSTS + 1 }, (_, i) => `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`);
    expect(() => normalizeTrustedHosts(many)).toThrow(/at most 64/);
    expect(normalizeTrustedHosts(many.slice(0, MAX_TRUSTED_HOSTS))).toHaveLength(MAX_TRUSTED_HOSTS);
  });
});

describe("verifyToken with trusted hosts", () => {
  it("an empty list accepts any source and bumps lastUsed", async () => {
    h.prisma.apiToken.findMany.mockResolvedValue([tokenRow([])]);
    const r = await verifyToken(RAW, "203.0.113.9");
    expect(r).toEqual({ ok: true, token: { id: "tok-1", name: "siem", roleId: "role-1", integrationIds: [] } });
    expect(h.prisma.apiToken.update).toHaveBeenCalledTimes(1);
  });

  it("accepts an exact address and a CIDR member, including the ::ffff: mapped form", async () => {
    h.prisma.apiToken.findMany.mockResolvedValue([tokenRow(["10.20.5.14", "192.168.10.0/24"])]);
    expect((await verifyToken(RAW, "10.20.5.14")).ok).toBe(true);
    expect((await verifyToken(RAW, "::ffff:192.168.10.77")).ok).toBe(true);
  });

  it("refuses a source outside the list as untrusted_host, logs a warning, and does not bump lastUsed", async () => {
    h.prisma.apiToken.findMany.mockResolvedValue([tokenRow(["10.20.0.0/16"])]);
    const r = await verifyToken(RAW, "10.30.1.1");
    expect(r).toEqual({ ok: false, reason: "untrusted_host", tokenName: "siem", callerIp: "10.30.1.1" });
    expect(h.prisma.apiToken.update).not.toHaveBeenCalled();
    expect(h.logEvent).toHaveBeenCalledTimes(1);
    expect(h.logEvent.mock.calls[0][0]).toMatchObject({
      action: "api_token.untrusted_host",
      resourceId: "tok-1",
      level: "warning",
    });
  });

  it("fails closed when the caller address is unknown", async () => {
    h.prisma.apiToken.findMany.mockResolvedValue([tokenRow(["10.20.0.0/16"])]);
    expect(await verifyToken(RAW, null)).toMatchObject({ ok: false, reason: "untrusted_host" });
  });

  it("logs once per (token, address) within the window, again for a new address", async () => {
    h.prisma.apiToken.findMany.mockResolvedValue([tokenRow(["10.20.0.0/16"])]);
    await verifyToken(RAW, "10.30.1.1");
    await verifyToken(RAW, "10.30.1.1");
    await verifyToken(RAW, "10.30.1.1");
    expect(h.logEvent).toHaveBeenCalledTimes(1);
    await verifyToken(RAW, "10.30.1.2");
    expect(h.logEvent).toHaveBeenCalledTimes(2);
  });

  it("a wrong token is invalid, never untrusted_host, and logs nothing", async () => {
    h.prisma.apiToken.findMany.mockResolvedValue([tokenRow(["10.20.0.0/16"])]);
    h.verifyPassword.mockResolvedValue({ valid: false });
    expect(await verifyToken(RAW, "10.30.1.1")).toEqual({ ok: false, reason: "invalid" });
    expect(h.logEvent).not.toHaveBeenCalled();
  });

  it("a non-polaris bearer is invalid without a DB read", async () => {
    expect(await verifyToken("not-a-token", "10.20.1.1")).toEqual({ ok: false, reason: "invalid" });
    expect(h.prisma.apiToken.findMany).not.toHaveBeenCalled();
  });
});

describe("updateTrustedHosts", () => {
  const summaryRow = (trustedHosts: string[]) => ({
    ...tokenRow(trustedHosts),
    role: { name: "r" },
    createdBy: "admin",
    createdAt: new Date(),
    expiresAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    revokedAt: null,
    revokedBy: null,
  });

  it("replaces the list with the normalized one and returns the previous list", async () => {
    h.prisma.apiToken.findUnique.mockResolvedValue({ trustedHosts: ["10.0.0.1"], revokedAt: null });
    h.prisma.apiToken.update.mockResolvedValue(summaryRow(["10.1.2.0/24"]));
    const r = await updateTrustedHosts("tok-1", ["10.1.2.5/24", "10.1.2.0/24"]);
    expect(h.prisma.apiToken.update.mock.calls[0][0].data).toEqual({ trustedHosts: ["10.1.2.0/24"] });
    expect(r.before).toEqual(["10.0.0.1"]);
    expect(r.token.trustedHosts).toEqual(["10.1.2.0/24"]);
  });

  it("accepts an empty list (back to any source)", async () => {
    h.prisma.apiToken.findUnique.mockResolvedValue({ trustedHosts: ["10.0.0.1"], revokedAt: null });
    h.prisma.apiToken.update.mockResolvedValue(summaryRow([]));
    await updateTrustedHosts("tok-1", []);
    expect(h.prisma.apiToken.update.mock.calls[0][0].data).toEqual({ trustedHosts: [] });
  });

  it("rejects a malformed entry before touching the row", async () => {
    await expect(updateTrustedHosts("tok-1", ["10.1.2.300"])).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.prisma.apiToken.findUnique).not.toHaveBeenCalled();
  });

  it("is 404 for an unknown token and 409 for a revoked one", async () => {
    h.prisma.apiToken.findUnique.mockResolvedValueOnce(null);
    await expect(updateTrustedHosts("nope", [])).rejects.toMatchObject({ httpStatus: 404 });
    h.prisma.apiToken.findUnique.mockResolvedValueOnce({ trustedHosts: [], revokedAt: new Date() });
    await expect(updateTrustedHosts("tok-1", ["10.0.0.1"])).rejects.toMatchObject({ httpStatus: 409 });
    expect(h.prisma.apiToken.update).not.toHaveBeenCalled();
  });
});
