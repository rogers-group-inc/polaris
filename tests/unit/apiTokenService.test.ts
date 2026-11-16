/**
 * tests/unit/apiTokenService.test.ts — own unit suite for
 * src/services/apiTokenService.ts (CQ-T010 batch 8c).
 *
 * The trusted-host half (normalizeTrustedHosts, updateTrustedHosts, the
 * untrusted_host branch of verifyToken) has its own suite in
 * apiTokenTrustedHosts.test.ts; this one covers minting, the role catalogue,
 * the quarantine integration rule, revoke / delete, and verifyToken's
 * prefix / candidate / lastUsed paths.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
  deleteTokenAndTombstoneOwnership: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/utils/password.js", () => ({
  hashPassword: h.hashPassword,
  verifyPassword: h.verifyPassword,
}));
vi.mock("../../src/services/userOwnershipService.js", () => ({
  deleteTokenAndTombstoneOwnership: h.deleteTokenAndTombstoneOwnership,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  createToken,
  deleteToken,
  listQuarantineIntegrations,
  listRoleChoices,
  listTokens,
  revokeToken,
  verifyToken,
  _resetUntrustedHostEventThrottle,
} from "../../src/services/apiTokenService.js";

const ADMIN_PERMS = { users: "fullwrite", roles: "fullwrite" };
const QUARANTINE_PERMS = { assetsQuarantine: "write", assets: "read" };
const READ_PERMS = { assets: "read" };

function role(id: string, permissions: Record<string, string>, name = id) {
  return { id, name, description: null, permissions };
}

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "tok-1",
    name: "siem",
    tokenPrefix: "polaris_abcdefgh",
    roleId: "role-1",
    role: { name: "api-read" },
    integrationIds: [],
    trustedHosts: [],
    createdBy: "alice",
    createdAt: new Date("2026-11-01T00:00:00Z"),
    expiresAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  };
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  _resetUntrustedHostEventThrottle();
  h.hashPassword.mockReset().mockResolvedValue("argon-hash");
  h.verifyPassword.mockReset().mockResolvedValue({ valid: true });
  h.deleteTokenAndTombstoneOwnership.mockReset();
  // create echoes its data back as the stored row, joined to the role name.
  stubbed(prisma.apiToken.create).mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    storedRow({ id: "tok-new", ...data, role: { name: "bound-role" } }),
  );
  stubbed(prisma.apiToken.update).mockResolvedValue({});
});

describe("createToken", () => {
  it("rejects a blank name or role with 400 before touching the database", async () => {
    await expect(createToken({ name: "  ", roleId: "r", createdBy: "a" })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(createToken({ name: "x", roleId: " ", createdBy: "a" })).rejects.toMatchObject({ httpStatus: 400 });
    expect(prisma.role.findUnique).not.toHaveBeenCalled();
  });

  it("400s on an unknown role", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(null);
    await expect(createToken({ name: "x", roleId: "nope", createdBy: "a" })).rejects.toMatchObject({
      httpStatus: 400,
      message: expect.stringContaining("nope"),
    });
  });

  it("runs the caller's authorizeRole hook with the resolved role before anything is written (rule 48)", async () => {
    const r = role("role-1", READ_PERMS);
    stubbed(prisma.role.findUnique).mockResolvedValue(r);
    const authorizeRole = vi.fn(() => {
      throw Object.assign(new Error("Forbidden"), { httpStatus: 403 });
    });
    await expect(createToken({ name: "x", roleId: "role-1", createdBy: "a", authorizeRole })).rejects.toMatchObject({
      httpStatus: 403,
    });
    expect(authorizeRole).toHaveBeenCalledWith(r);
    expect(prisma.apiToken.findUnique).not.toHaveBeenCalled();
    expect(prisma.apiToken.create).not.toHaveBeenCalled();
  });

  it("409s on a duplicate (trimmed) name", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(role("role-1", READ_PERMS));
    stubbed(prisma.apiToken.findUnique).mockResolvedValue({ id: "old" });
    await expect(createToken({ name: " siem ", roleId: "role-1", createdBy: "a" })).rejects.toMatchObject({ httpStatus: 409 });
    expect(prisma.apiToken.findUnique).toHaveBeenCalledWith({ where: { name: "siem" } });
  });

  it("mints a polaris_ token, stores only its hash + 16-char prefix, and returns the raw value once", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(role("role-1", READ_PERMS));
    stubbed(prisma.apiToken.findUnique).mockResolvedValue(null);
    const expiresAt = new Date("2027-01-01T00:00:00Z");
    const res = await createToken({ name: " siem ", roleId: "role-1", createdBy: "alice", expiresAt, trustedHosts: ["10.1.2.5/24"] });

    // Tail is UP TO 32 alphanumerics: generateRawToken strips +/= from the
    // base64 rather than mapping them (src/utils/bearerToken.ts).
    expect(res.rawToken).toMatch(/^polaris_[A-Za-z0-9]{8,32}$/);
    expect(h.hashPassword).toHaveBeenCalledWith(res.rawToken);
    const data = stubbed(prisma.apiToken.create).mock.calls[0][0].data;
    expect(data).toMatchObject({
      name: "siem",
      tokenHash: "argon-hash",
      tokenPrefix: res.rawToken.slice(0, 16),
      roleId: "role-1",
      integrationIds: [],
      trustedHosts: ["10.1.2.0/24"],
      createdBy: "alice",
      expiresAt,
    });
    expect(JSON.stringify(data)).not.toContain(res.rawToken);
    expect(res.token).toMatchObject({ id: "tok-new", name: "siem", roleName: "bound-role", tokenPrefix: res.rawToken.slice(0, 16) });
    expect(res.token).not.toHaveProperty("tokenHash");
  });

  it("stores expiresAt null when none is given", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(role("role-1", READ_PERMS));
    await createToken({ name: "x", roleId: "role-1", createdBy: "a" });
    expect(stubbed(prisma.apiToken.create).mock.calls[0][0].data.expiresAt).toBeNull();
  });

  it("drops integrationIds for a role without quarantine write (they would never be read)", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(role("role-1", READ_PERMS));
    await createToken({ name: "x", roleId: "role-1", createdBy: "a", integrationIds: ["int-1"] });
    expect(stubbed(prisma.apiToken.create).mock.calls[0][0].data.integrationIds).toEqual([]);
    expect(prisma.integration.findMany).not.toHaveBeenCalled();
  });

  it("requires at least one integration when the role grants quarantine write", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(role("role-q", QUARANTINE_PERMS));
    await expect(createToken({ name: "x", roleId: "role-q", createdBy: "a" })).rejects.toMatchObject({ httpStatus: 400 });
    expect(prisma.apiToken.create).not.toHaveBeenCalled();
  });

  it("also treats fullwrite quarantine as needing integrations", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(role("role-q", { assetsQuarantine: "fullwrite" }));
    await expect(createToken({ name: "x", roleId: "role-q", createdBy: "a", integrationIds: [] })).rejects.toMatchObject({
      httpStatus: 400,
    });
  });

  it("400s naming unknown integration ids", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(role("role-q", QUARANTINE_PERMS));
    stubbed(prisma.integration.findMany).mockResolvedValue([{ id: "int-1", type: "fortigate" }]);
    await expect(
      createToken({ name: "x", roleId: "role-q", createdBy: "a", integrationIds: ["int-1", "int-ghost"] }),
    ).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("int-ghost") });
  });

  it("400s naming integrations that are not FortiManager / FortiGate", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(role("role-q", QUARANTINE_PERMS));
    stubbed(prisma.integration.findMany).mockResolvedValue([
      { id: "int-1", type: "fortimanager" },
      { id: "int-2", type: "vcenter" },
    ]);
    await expect(
      createToken({ name: "x", roleId: "role-q", createdBy: "a", integrationIds: ["int-1", "int-2"] }),
    ).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("int-2") });
  });

  it("de-duplicates valid quarantine integrations and stores them", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(role("role-q", QUARANTINE_PERMS));
    stubbed(prisma.integration.findMany).mockResolvedValue([
      { id: "int-1", type: "fortimanager" },
      { id: "int-2", type: "fortigate" },
    ]);
    await createToken({ name: "x", roleId: "role-q", createdBy: "a", integrationIds: ["int-1", "int-2", "int-1"] });
    expect(stubbed(prisma.integration.findMany).mock.calls[0][0].where).toEqual({ id: { in: ["int-1", "int-2"] } });
    expect(stubbed(prisma.apiToken.create).mock.calls[0][0].data.integrationIds).toEqual(["int-1", "int-2"]);
  });

  it("refuses an invalid trusted host before minting", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(role("role-1", READ_PERMS));
    await expect(createToken({ name: "x", roleId: "role-1", createdBy: "a", trustedHosts: ["not-an-ip"] })).rejects.toMatchObject({
      httpStatus: 400,
    });
    expect(h.hashPassword).not.toHaveBeenCalled();
    expect(prisma.apiToken.create).not.toHaveBeenCalled();
  });

  it("writes a warning Event when the bound role is admin-equivalent", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(role("role-a", ADMIN_PERMS, "admin"));
    await createToken({ name: "root-token", roleId: "role-a", createdBy: "alice" });
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "api_token.admin_equivalent",
      resourceType: "api_token",
      resourceId: "tok-new",
      resourceName: "root-token",
      actor: "alice",
      level: "warning",
    });
    expect(eventLog.logEvent.mock.calls[0][0].message).toContain('"admin"');
  });

  it("writes no Event for an ordinary role", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(role("role-1", READ_PERMS));
    await createToken({ name: "x", roleId: "role-1", createdBy: "a" });
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("does not treat users=fullwrite alone as admin-equivalent", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(role("role-u", { users: "fullwrite", roles: "write" }));
    await createToken({ name: "x", roleId: "role-u", createdBy: "a" });
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("listQuarantineIntegrations", () => {
  it("lists FMG / FortiGate rows by name with the pushQuarantine flag derived from config", async () => {
    stubbed(prisma.integration.findMany).mockResolvedValue([
      { id: "a", name: "A", type: "fortigate", enabled: true, config: { pushQuarantine: true } },
      { id: "b", name: "B", type: "fortimanager", enabled: false, config: { pushQuarantine: "true" } },
      { id: "c", name: "C", type: "fortimanager", enabled: true, config: null },
    ]);
    const out = await listQuarantineIntegrations();
    expect(stubbed(prisma.integration.findMany).mock.calls[0][0]).toMatchObject({
      where: { type: { in: ["fortimanager", "fortigate"] } },
      orderBy: { name: "asc" },
    });
    expect(out).toEqual([
      { id: "a", name: "A", type: "fortigate", enabled: true, pushQuarantineEnabled: true },
      { id: "b", name: "B", type: "fortimanager", enabled: false, pushQuarantineEnabled: false },
      { id: "c", name: "C", type: "fortimanager", enabled: true, pushQuarantineEnabled: false },
    ]);
    expect(out[0]).not.toHaveProperty("config");
  });
});

describe("listRoleChoices", () => {
  it("flags quarantine-write and admin-equivalent roles", async () => {
    stubbed(prisma.role.findMany).mockResolvedValue([
      role("a", ADMIN_PERMS, "admin"),
      role("q", QUARANTINE_PERMS, "api-quarantine"),
      role("r", { assetsQuarantine: "read" }, "api-read"),
    ]);
    const out = await listRoleChoices();
    expect(stubbed(prisma.role.findMany).mock.calls[0][0]).toEqual({ orderBy: { name: "asc" } });
    expect(out.map((r) => [r.id, r.grantsQuarantineWrite, r.adminEquivalent])).toEqual([
      ["a", false, true],
      ["q", true, false],
      ["r", false, false],
    ]);
    expect(out[0]).not.toHaveProperty("permissions");
  });
});

describe("listTokens", () => {
  it("returns summaries newest first without the hash", async () => {
    stubbed(prisma.apiToken.findMany).mockResolvedValue([storedRow({ tokenHash: "secret-hash" })]);
    const out = await listTokens();
    expect(stubbed(prisma.apiToken.findMany).mock.calls[0][0].orderBy).toEqual({ createdAt: "desc" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "tok-1", roleName: "api-read" });
    expect(out[0]).not.toHaveProperty("tokenHash");
    expect(out[0]).not.toHaveProperty("role");
  });

  it("returns [] when there are no tokens", async () => {
    stubbed(prisma.apiToken.findMany).mockResolvedValue([]);
    expect(await listTokens()).toEqual([]);
  });
});

describe("revokeToken", () => {
  it("404s on an unknown token", async () => {
    stubbed(prisma.apiToken.findUnique).mockResolvedValue(null);
    await expect(revokeToken("nope", "alice")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("409s on an already-revoked token and does not re-stamp it", async () => {
    stubbed(prisma.apiToken.findUnique).mockResolvedValue(storedRow({ revokedAt: new Date() }));
    await expect(revokeToken("tok-1", "alice")).rejects.toMatchObject({ httpStatus: 409 });
    expect(prisma.apiToken.update).not.toHaveBeenCalled();
  });

  it("stamps revokedAt + revokedBy", async () => {
    stubbed(prisma.apiToken.findUnique).mockResolvedValue(storedRow());
    await revokeToken("tok-1", "alice");
    const call = stubbed(prisma.apiToken.update).mock.calls[0][0];
    expect(call.where).toEqual({ id: "tok-1" });
    expect(call.data.revokedBy).toBe("alice");
    expect(call.data.revokedAt).toBeInstanceOf(Date);
  });
});

describe("deleteToken", () => {
  it("404s on an unknown token", async () => {
    stubbed(prisma.apiToken.findUnique).mockResolvedValue(null);
    await expect(deleteToken("nope")).rejects.toMatchObject({ httpStatus: 404 });
    expect(h.deleteTokenAndTombstoneOwnership).not.toHaveBeenCalled();
  });

  it("deletes through the tombstoning transaction and returns its counts (rule 48(e))", async () => {
    stubbed(prisma.apiToken.findUnique).mockResolvedValue({ id: "tok-1", name: "siem" });
    const counts = { subnets: 1, reservations: 0, credentials: 0, contacts: 0, assets: 2, maintenanceSchedules: 0 };
    h.deleteTokenAndTombstoneOwnership.mockResolvedValue(counts);
    const out = await deleteToken("tok-1");
    expect(h.deleteTokenAndTombstoneOwnership).toHaveBeenCalledWith({ id: "tok-1", name: "siem" });
    expect(out).toEqual({ name: "siem", tombstoned: counts });
    // The service never deletes the row directly — the transaction does.
    expect(prisma.apiToken.delete).not.toHaveBeenCalled();
  });
});

describe("verifyToken", () => {
  const RAW = "polaris_abcdefgh" + "y".repeat(24);
  const liveRow = { id: "tok-1", name: "siem", tokenHash: "h1", roleId: "role-1", integrationIds: ["int-1"], trustedHosts: [] };

  it("rejects an empty token or one without the polaris_ prefix without a query", async () => {
    expect(await verifyToken("", "10.0.0.1")).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyToken("shelob_abcdefgh" + "y".repeat(24), "10.0.0.1")).toEqual({ ok: false, reason: "invalid" });
    expect(prisma.apiToken.findMany).not.toHaveBeenCalled();
  });

  it("looks candidates up by the 16-char prefix, excluding revoked and expired rows", async () => {
    stubbed(prisma.apiToken.findMany).mockResolvedValue([]);
    expect(await verifyToken(RAW, "10.0.0.1")).toEqual({ ok: false, reason: "invalid" });
    const where = stubbed(prisma.apiToken.findMany).mock.calls[0][0].where;
    expect(where.tokenPrefix).toBe("polaris_abcdefgh");
    expect(where.revokedAt).toBeNull();
    expect(where.OR[0]).toEqual({ expiresAt: null });
    expect(where.OR[1].expiresAt.gt).toBeInstanceOf(Date);
  });

  it("a truncated token still only matches its prefix rows and fails on the hash", async () => {
    stubbed(prisma.apiToken.findMany).mockResolvedValue([liveRow]);
    h.verifyPassword.mockResolvedValue({ valid: false });
    expect(await verifyToken("polaris_abc", null)).toEqual({ ok: false, reason: "invalid" });
    expect(stubbed(prisma.apiToken.findMany).mock.calls[0][0].where.tokenPrefix).toBe("polaris_abc");
  });

  it("walks every candidate until one hash verifies", async () => {
    stubbed(prisma.apiToken.findMany).mockResolvedValue([
      { ...liveRow, id: "tok-a", tokenHash: "ha" },
      { ...liveRow, id: "tok-b", tokenHash: "hb", name: "other" },
    ]);
    h.verifyPassword.mockImplementation(async (_raw: string, hash: string) => ({ valid: hash === "hb" }));
    const res = await verifyToken(RAW, "10.0.0.1");
    expect(res).toEqual({ ok: true, token: { id: "tok-b", name: "other", roleId: "role-1", integrationIds: ["int-1"] } });
    expect(h.verifyPassword).toHaveBeenCalledTimes(2);
  });

  it("bumps lastUsedAt / lastUsedIp on success (IPv6 caller kept as given)", async () => {
    stubbed(prisma.apiToken.findMany).mockResolvedValue([liveRow]);
    await verifyToken(RAW, "2001:db8::5");
    const call = stubbed(prisma.apiToken.update).mock.calls[0][0];
    expect(call.where).toEqual({ id: "tok-1" });
    expect(call.data.lastUsedIp).toBe("2001:db8::5");
    expect(call.data.lastUsedAt).toBeInstanceOf(Date);
  });

  it("a failed lastUsed bump does not fail authentication", async () => {
    stubbed(prisma.apiToken.findMany).mockResolvedValue([liveRow]);
    stubbed(prisma.apiToken.update).mockRejectedValue(new Error("db down"));
    const res = await verifyToken(RAW, null);
    expect(res.ok).toBe(true);
    // let the swallowed rejection settle
    await new Promise((r) => setImmediate(r));
  });

  it("returns invalid when no candidate's hash matches, and bumps nothing", async () => {
    stubbed(prisma.apiToken.findMany).mockResolvedValue([liveRow]);
    h.verifyPassword.mockResolvedValue({ valid: false });
    expect(await verifyToken(RAW, "10.0.0.1")).toEqual({ ok: false, reason: "invalid" });
    expect(prisma.apiToken.update).not.toHaveBeenCalled();
  });
});
