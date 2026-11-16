/**
 * tests/unit/ssoProvisioning.test.ts — the shared find-or-provision path for
 * OIDC / LDAP / Entra App Proxy / Azure SAML logins.
 *
 * Contract (polaris-change-impact → auth-identity.md): a group-resolved role
 * overrides; a no-match login never demotes an existing user; a new user with
 * no match is `readonly` + needsRoleReview; ssoGroups are normalized, deduped
 * and capped; `authProvider` is stamped to the login path; usernames resolve
 * base → base-provider → provider-externalId; "azure" groups resolve under the
 * "saml" mapping provider.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/utils/password.js", () => ({ hashPassword: vi.fn(async (p: string) => `hash:${p.length}`) }));
vi.mock("../../src/services/groupMappingService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveGroupsToAccess: h.resolve,
}));

import { provisionExternalUser, type ExternalUserProfile } from "../../src/services/ssoProvisioning.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const roleFind = () => stubbed(prisma.role.findUnique);
const userFindFirst = () => stubbed(prisma.user.findFirst);
const userFindUnique = () => stubbed(prisma.user.findUnique);
const userUpdate = () => stubbed(prisma.user.update);
const userCreate = () => stubbed(prisma.user.create);

function profile(over: Partial<ExternalUserProfile> = {}): ExternalUserProfile {
  return { provider: "oidc", externalIdField: "oidcSubject", externalId: "sub-0123456789abcdef", usernameHint: "jdoe@example.com", displayName: "Jane Doe", email: "jdoe@example.com", groups: [], ...over };
}

function existingUser(over: Record<string, unknown> = {}) {
  return { id: "u1", roleId: "role-ops", role: { name: "operator" }, displayName: "Old Name", email: "old@example.com", lastLogin: new Date("2026-01-01"), ...over };
}

const updateData = () => userUpdate().mock.calls[0][0].data as Record<string, unknown>;
const createData = () => userCreate().mock.calls[0][0].data as Record<string, unknown>;

beforeEach(() => {
  resetDbStub();
  h.resolve.mockReset();
  h.resolve.mockResolvedValue({ roleId: null });
  roleFind().mockImplementation(async ({ where }: any) => (where.name === "readonly" ? { id: "role-readonly" } : where.id ? { id: where.id } : null));
  userFindFirst().mockResolvedValue(null);
  userFindUnique().mockResolvedValue(null);
  userUpdate().mockImplementation(async ({ data }: any) => ({ id: "u1", ...data }));
  userCreate().mockImplementation(async ({ data }: any) => ({ id: "new", ...data }));
});

describe("provisionExternalUser — guards", () => {
  it("refuses with 502 when the provider gave no stable id", async () => {
    await expect(provisionExternalUser(profile({ externalId: "" }))).rejects.toMatchObject({ httpStatus: 502 });
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("refuses with 500 when a new user needs readonly and the role is missing (mis-seeded)", async () => {
    roleFind().mockResolvedValue(null);
    await expect(provisionExternalUser(profile())).rejects.toMatchObject({ httpStatus: 500 });
    expect(userCreate()).not.toHaveBeenCalled();
  });
});

describe("provisionExternalUser — group resolution", () => {
  it("resolves azure logins under the saml mapping provider", async () => {
    await provisionExternalUser(profile({ provider: "azure", externalIdField: "azureOid", groups: ["G1"] }));
    expect(h.resolve).toHaveBeenCalledWith("saml", ["G1"]);
  });

  it("stores groups normalized for the provider, deduped, without blanks", async () => {
    await provisionExternalUser(profile({ provider: "ldap", externalIdField: "ldapUid", groups: ["CN=Admins,DC=x", "cn=admins,dc=x", "  ", "CN=Ops,DC=x"] }));
    expect(createData().ssoGroups).toEqual(["cn=admins,dc=x", "cn=ops,dc=x"]);
  });

  it("keeps case for oidc groups", async () => {
    await provisionExternalUser(profile({ groups: ["Admins", "admins"] }));
    expect(createData().ssoGroups).toEqual(["Admins", "admins"]);
  });

  it("caps stored groups at 256", async () => {
    const groups = Array.from({ length: 400 }, (_, i) => `g${i}`);
    await provisionExternalUser(profile({ groups }));
    const stored = createData().ssoGroups as string[];
    expect(stored).toHaveLength(256);
    expect(stored[0]).toBe("g0");
    expect(stored[255]).toBe("g255");
  });

  it("ignores a group-resolved role that no longer exists", async () => {
    h.resolve.mockResolvedValue({ roleId: "role-gone" });
    roleFind().mockImplementation(async ({ where }: any) => (where.name === "readonly" ? { id: "role-readonly" } : null));
    await provisionExternalUser(profile());
    expect(createData().roleId).toBe("role-readonly");
  });
});

describe("provisionExternalUser — existing user", () => {
  it("matches on the provider's own id column", async () => {
    userFindFirst().mockResolvedValue(existingUser());
    await provisionExternalUser(profile({ provider: "ldap", externalIdField: "ldapUid", externalId: "guid-1" }));
    expect(userFindFirst().mock.calls[0][0].where).toEqual({ ldapUid: "guid-1" });
    expect(userCreate()).not.toHaveBeenCalled();
  });

  it("keeps the current role when no group resolved one — a coverage gap never demotes", async () => {
    userFindFirst().mockResolvedValue(existingUser({ roleId: "role-admin", role: { name: "admin" } }));
    await provisionExternalUser(profile());
    expect(updateData().roleId).toBe("role-admin");
  });

  it("applies a group-resolved role", async () => {
    h.resolve.mockResolvedValue({ roleId: "role-netadmin" });
    userFindFirst().mockResolvedValue(existingUser());
    await provisionExternalUser(profile());
    expect(updateData().roleId).toBe("role-netadmin");
  });

  it("stamps authProvider to the login path, records groups and lastLogin", async () => {
    userFindFirst().mockResolvedValue(existingUser({ authProvider: "azure" }));
    await provisionExternalUser(profile({ provider: "entra-proxy", externalIdField: "azureOid", groups: ["GUID-A"] }));
    const d = updateData();
    expect(d.authProvider).toBe("entra-proxy");
    expect(d.ssoGroups).toEqual(["guid-a"]);
    expect(d.lastLogin).toBeInstanceOf(Date);
  });

  it("keeps the stored display name and email when the provider sends none", async () => {
    userFindFirst().mockResolvedValue(existingUser());
    await provisionExternalUser(profile({ displayName: null, email: "" }));
    expect(updateData()).toMatchObject({ displayName: "Old Name", email: "old@example.com" });
  });

  it("flags a non-admin's first login for role review, and nobody else", async () => {
    userFindFirst().mockResolvedValue(existingUser({ lastLogin: null }));
    await provisionExternalUser(profile());
    expect(updateData().needsRoleReview).toBe(true);

    resetDbStub();
    userFindFirst().mockResolvedValue(existingUser({ lastLogin: null, role: { name: "admin" } }));
    userUpdate().mockResolvedValue({});
    await provisionExternalUser(profile());
    expect(updateData()).not.toHaveProperty("needsRoleReview");

    resetDbStub();
    userFindFirst().mockResolvedValue(existingUser());
    userUpdate().mockResolvedValue({});
    await provisionExternalUser(profile());
    expect(updateData()).not.toHaveProperty("needsRoleReview");
  });
});

describe("provisionExternalUser — new user", () => {
  it("creates a readonly, review-flagged user with the external id and a placeholder hash", async () => {
    await provisionExternalUser(profile({ groups: ["g"] }));
    expect(createData()).toMatchObject({
      username: "jdoe", roleId: "role-readonly", authProvider: "oidc", oidcSubject: "sub-0123456789abcdef",
      ssoGroups: ["g"], displayName: "Jane Doe", email: "jdoe@example.com", needsRoleReview: true,
    });
    expect(createData().passwordHash).toBe("hash:64");
  });

  it("uses a group-resolved role and still flags review", async () => {
    h.resolve.mockResolvedValue({ roleId: "role-netadmin" });
    await provisionExternalUser(profile());
    expect(createData()).toMatchObject({ roleId: "role-netadmin", needsRoleReview: true });
  });

  it("derives the username from the local part, lowercased and stripped of unsafe characters", async () => {
    await provisionExternalUser(profile({ usernameHint: "Jane O'Neil+tag@example.com" }));
    expect(createData().username).toBe("janeoneiltag");
  });

  it("falls back to provider-<first 8 of the id> when the hint yields nothing", async () => {
    await provisionExternalUser(profile({ usernameHint: "@example.com" }));
    expect(createData().username).toBe("oidc-sub-0123");
  });

  it("resolves collisions base → base-provider → provider-<first 12 of the id>", async () => {
    userFindUnique().mockImplementation(async ({ where }: any) => (where.username === "jdoe" ? { id: "x" } : null));
    await provisionExternalUser(profile({ provider: "azure", externalIdField: "azureOid" }));
    expect(createData().username).toBe("jdoe-azure");

    resetDbStub();
    roleFind().mockResolvedValue({ id: "role-readonly" });
    userFindFirst().mockResolvedValue(null);
    userFindUnique().mockResolvedValue({ id: "taken" });
    userCreate().mockResolvedValue({});
    await provisionExternalUser(profile());
    expect(createData().username).toBe("oidc-sub-01234567");
  });

  it("stores null for a missing display name and email", async () => {
    await provisionExternalUser(profile({ displayName: "", email: null }));
    expect(createData()).toMatchObject({ displayName: null, email: null });
  });
});
