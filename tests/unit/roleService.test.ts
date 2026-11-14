/**
 * tests/unit/roleService.test.ts — own unit suite for
 * src/services/roleService.ts (CQ-T010 batch 8c).
 *
 * Role CRUD under the protected / built-in / custom invariants, the reserved
 * names, the absent-key-keeps-its-level permission merge, rule 114(i)'s grant
 * review flag, rule 48(d)'s demotion guard and the last-admin counters.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ bumpRoleVersion: vi.fn() }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/api/middleware/permissions.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  bumpRoleVersion: h.bumpRoleVersion,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import {
  assertRoleDemotionAllowed,
  countAdminEquivalentUsers,
  createRole,
  deleteRole,
  getRole,
  isAdminEquivalentRole,
  listRoles,
  listRolesNeedingGrantReview,
  markRoleGrantReviewed,
  updateRole,
} from "../../src/services/roleService.js";

const ADMIN = { users: "fullwrite", roles: "fullwrite" } as const;
const UPDATED_AT = new Date("2026-11-14T10:00:00Z");

function roleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "role-1",
    name: "ops",
    description: null as string | null,
    permissions: { assets: "read" } as Record<string, string>,
    color: null as string | null,
    isBuiltIn: false,
    isProtected: false,
    grantReviewNeeded: false,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: UPDATED_AT,
    _count: { users: 0, apiTokens: 0 },
    ...overrides,
  };
}

/** details.diff of the first logged Event. */
function eventDiff(): Record<string, any> {
  return (eventLog.logEvent.mock.calls[0][0].details as { diff: Record<string, any> }).diff;
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  h.bumpRoleVersion.mockReset();
  stubbed(prisma.role.findMany).mockResolvedValue([]);
  stubbed(prisma.role.create).mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    roleRow({ id: "role-new", ...data }),
  );
  stubbed(prisma.role.update).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => roleRow({ ...data }));
});

describe("listRoles / getRole", () => {
  it("lists by name with user counts and a normalized matrix", async () => {
    stubbed(prisma.role.findMany).mockResolvedValue([roleRow({ _count: { users: 3 }, grantReviewNeeded: undefined })]);
    const [r] = await listRoles();
    expect(stubbed(prisma.role.findMany).mock.calls[0][0]).toMatchObject({ orderBy: { name: "asc" } });
    expect(r.userCount).toBe(3);
    expect(r.grantReviewNeeded).toBe(false);
    expect(r.permissions.assets).toBe("read");
    // every function key is present after normalization
    expect(Object.keys(r.permissions).length).toBe(FUNCTION_KEYS.length);
    expect(r).not.toHaveProperty("_count");
  });

  it("getRole 404s on an unknown id", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(null);
    await expect(getRole("x")).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("createRole", () => {
  it.each(["a", "x".repeat(33), "has space", "dot.ted", ""])("400s on an invalid name %j", async (name) => {
    await expect(createRole({ name, permissions: {} })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it.each(["admin", "ADMIN", "ReadOnly"])("409s on the reserved name %j in any case", async (name) => {
    await expect(createRole({ name, permissions: {} })).rejects.toMatchObject({ httpStatus: 409 });
    expect(prisma.role.create).not.toHaveBeenCalled();
  });

  it("409s on a case-insensitive collision with an existing role", async () => {
    stubbed(prisma.role.findMany).mockResolvedValue([{ id: "r", name: "NetOps" }]);
    await expect(createRole({ name: "netops", permissions: {} })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("400s on a malformed colour or an over-long description", async () => {
    await expect(createRole({ name: "ops", permissions: {}, color: "red" })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(createRole({ name: "ops", permissions: {}, color: "#12345" })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(createRole({ name: "ops", permissions: {}, description: "d".repeat(201) })).rejects.toMatchObject({
      httpStatus: 400,
    });
  });

  it("creates a custom role with a normalized matrix, lowercased colour, bumps the version and audits", async () => {
    const out = await createRole(
      { name: " ops ", description: "  ", permissions: { assets: "write", bogus: "write" } as never, color: " #AABBCC " },
      "alice",
    );
    const data = stubbed(prisma.role.create).mock.calls[0][0].data;
    expect(data).toMatchObject({ name: "ops", description: null, color: "#aabbcc", isBuiltIn: false, isProtected: false });
    expect(data.permissions.assets).toBe("write");
    expect(data.permissions).not.toHaveProperty("bogus");
    expect(data.permissions.users).toBe("none");
    expect(h.bumpRoleVersion).toHaveBeenCalledWith("role-new", UPDATED_AT);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "role.created",
      resourceType: "role",
      resourceId: "role-new",
      resourceName: "ops",
      actor: "alice",
    });
    expect(out.id).toBe("role-new");
  });
});

describe("updateRole", () => {
  it("404s on an unknown role", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(null);
    await expect(updateRole("x", { description: "d" })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("403s on a protected role, whatever the edit", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(roleRow({ name: "admin", isProtected: true, isBuiltIn: true }));
    await expect(updateRole("role-1", { description: "d" })).rejects.toMatchObject({ httpStatus: 403 });
    expect(prisma.role.update).not.toHaveBeenCalled();
  });

  it("lets a built-in (unprotected) role be edited", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(roleRow({ name: "networkadmin", isBuiltIn: true }));
    await updateRole("role-1", { description: "edited" });
    expect(prisma.role.update).toHaveBeenCalled();
  });

  it("is a no-op (no write, no bump, no Event) when nothing changes", async () => {
    const before = roleRow({ description: "d", color: "#aabbcc" });
    stubbed(prisma.role.findUnique).mockResolvedValue(before);
    await updateRole("role-1", { name: "ops", description: " d ", color: "#AABBCC", permissions: { assets: "read" } as never });
    expect(prisma.role.update).not.toHaveBeenCalled();
    expect(h.bumpRoleVersion).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("renames, refusing a collision that excludes the role itself", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(roleRow());
    stubbed(prisma.role.findMany).mockResolvedValue([{ id: "role-2", name: "NOC" }]);
    await expect(updateRole("role-1", { name: "noc" })).rejects.toMatchObject({ httpStatus: 409 });
    expect(stubbed(prisma.role.findMany).mock.calls[0][0].where).toEqual({ NOT: { id: "role-1" } });

    stubbed(prisma.role.findMany).mockResolvedValue([]);
    await updateRole("role-1", { name: "ops2" }, "alice");
    expect(stubbed(prisma.role.update).mock.calls[0][0].data).toEqual({ name: "ops2" });
    expect(eventDiff().name).toEqual({ from: "ops", to: "ops2" });
  });

  it("refuses renaming a custom role to a reserved name", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(roleRow());
    await expect(updateRole("role-1", { name: "Admin" })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("a key absent from the posted matrix keeps its stored level", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(roleRow({ permissions: { assets: "read", subnets: "write" } }));
    await updateRole("role-1", { permissions: { assets: "write" } as never });
    const { data } = stubbed(prisma.role.update).mock.calls[0][0];
    expect(data.permissions.assets).toBe("write");
    expect(data.permissions.subnets).toBe("write");
  });

  it("an explicit 'none' revokes a stored grant", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(roleRow({ permissions: { assets: "read", subnets: "write" } }));
    await updateRole("role-1", { permissions: { subnets: "none" } as never });
    expect(stubbed(prisma.role.update).mock.calls[0][0].data.permissions.subnets).toBe("none");
  });

  it("records only the changed keys under permissionChanges", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(roleRow({ permissions: { assets: "read" } }));
    await updateRole("role-1", { permissions: { assets: "write", subnets: "read" } as never }, "alice");
    const diff = eventDiff();
    expect(diff.permissionChanges.to).toEqual({
      assets: { from: "read", to: "write" },
      subnets: { from: "none", to: "read" },
    });
    expect(h.bumpRoleVersion).toHaveBeenCalledWith("role-1", UPDATED_AT);
  });

  it("saving an unchanged matrix clears the rule-114(i) review flag", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(roleRow({ grantReviewNeeded: true }));
    await updateRole("role-1", { permissions: { assets: "read" } as never });
    expect(stubbed(prisma.role.update).mock.calls[0][0].data).toEqual({ grantReviewNeeded: false });
    expect(eventDiff().grantReviewNeeded).toEqual({ from: true, to: false });
  });

  it("a non-permission edit leaves the review flag alone", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(roleRow({ grantReviewNeeded: true }));
    await updateRole("role-1", { description: "x" });
    expect(stubbed(prisma.role.update).mock.calls[0][0].data).toEqual({ description: "x" });
  });

  it("clears a colour with '' and rejects a malformed one", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(roleRow({ color: "#112233" }));
    await updateRole("role-1", { color: "" });
    expect(stubbed(prisma.role.update).mock.calls[0][0].data).toEqual({ color: null });
    await expect(updateRole("role-1", { color: "#zzzzzz" })).rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe("markRoleGrantReviewed / listRolesNeedingGrantReview", () => {
  it("404s on an unknown role", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(null);
    await expect(markRoleGrantReviewed("x")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("is a no-op on an unflagged role", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(roleRow());
    await markRoleGrantReviewed("role-1", "alice");
    expect(prisma.role.update).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("clears the flag and audits role.grant_reviewed", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(roleRow({ grantReviewNeeded: true }));
    const out = await markRoleGrantReviewed("role-1", "alice");
    expect(stubbed(prisma.role.update).mock.calls[0][0].data).toEqual({ grantReviewNeeded: false });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "role.grant_reviewed", resourceId: "role-1", actor: "alice" });
    expect(out.grantReviewNeeded).toBe(false);
  });

  it("lists the flagged role names", async () => {
    stubbed(prisma.role.findMany).mockResolvedValue([{ name: "a" }, { name: "b" }]);
    expect(await listRolesNeedingGrantReview()).toEqual(["a", "b"]);
    expect(stubbed(prisma.role.findMany).mock.calls[0][0].where).toEqual({ grantReviewNeeded: true });
  });
});

describe("deleteRole", () => {
  it("404s on an unknown role", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(null);
    await expect(deleteRole("x")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("409s on a built-in role", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(roleRow({ isBuiltIn: true }));
    await expect(deleteRole("role-1")).rejects.toMatchObject({ httpStatus: 409 });
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });

  it("409s while a user holds the role", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(roleRow({ _count: { users: 2, apiTokens: 0 } }));
    await expect(deleteRole("role-1")).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining("2 user") });
  });

  it("409s while an API token is bound to the role", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(roleRow({ _count: { users: 0, apiTokens: 1 } }));
    await expect(deleteRole("role-1")).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining("API token") });
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });

  it("deletes an unused custom role and audits", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(roleRow());
    await deleteRole("role-1", "alice");
    expect(stubbed(prisma.role.delete).mock.calls[0][0]).toEqual({ where: { id: "role-1" } });
    expect(stubbed(prisma.role.findUnique).mock.calls[0][0].include).toEqual({
      _count: { select: { users: true, apiTokens: true } },
    });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "role.deleted", resourceName: "ops", actor: "alice" });
  });
});

describe("assertRoleDemotionAllowed (rule 48(d))", () => {
  it("allows any edit to a role that was not admin-equivalent", async () => {
    await expect(assertRoleDemotionAllowed("r", { users: "fullwrite" }, false, false)).resolves.toBeUndefined();
    expect(prisma.role.findMany).not.toHaveBeenCalled();
  });

  it("allows an edit that keeps the role admin-equivalent", async () => {
    await expect(assertRoleDemotionAllowed("r", ADMIN, true, false)).resolves.toBeUndefined();
  });

  it("403s a demotion by a caller who is not admin-equivalent", async () => {
    await expect(assertRoleDemotionAllowed("r", ADMIN, false, false)).rejects.toMatchObject({ httpStatus: 403 });
  });

  it("409s a demotion that would leave no other active admin-equivalent account", async () => {
    stubbed(prisma.role.findMany).mockResolvedValue([
      { id: "r", permissions: ADMIN },
      { id: "r-other", permissions: ADMIN },
      { id: "r-low", permissions: { users: "fullwrite" } },
    ]);
    stubbed(prisma.user.count).mockResolvedValue(0);
    await expect(assertRoleDemotionAllowed("r", ADMIN, false, true)).rejects.toMatchObject({ httpStatus: 409 });
    expect(stubbed(prisma.user.count).mock.calls[0][0].where).toEqual({ roleId: { in: ["r-other"] }, disabledAt: null });
  });

  it("409s without a count when no other role is admin-equivalent", async () => {
    stubbed(prisma.role.findMany).mockResolvedValue([{ id: "r", permissions: ADMIN }]);
    await expect(assertRoleDemotionAllowed("r", ADMIN, false, true)).rejects.toMatchObject({ httpStatus: 409 });
    expect(prisma.user.count).not.toHaveBeenCalled();
  });

  it("allows the demotion when another admin-equivalent account remains", async () => {
    stubbed(prisma.role.findMany).mockResolvedValue([
      { id: "r", permissions: ADMIN },
      { id: "r-other", permissions: ADMIN },
    ]);
    stubbed(prisma.user.count).mockResolvedValue(1);
    await expect(assertRoleDemotionAllowed("r", ADMIN, false, true)).resolves.toBeUndefined();
  });
});

describe("countAdminEquivalentUsers / isAdminEquivalentRole", () => {
  it("is 0 without a count when no role is admin-equivalent", async () => {
    stubbed(prisma.role.findMany).mockResolvedValue([{ id: "r", permissions: { users: "fullwrite", roles: "write" } }]);
    expect(await countAdminEquivalentUsers()).toBe(0);
    expect(prisma.user.count).not.toHaveBeenCalled();
  });

  it("counts enabled users on admin-equivalent roles, optionally excluding one (rule 140)", async () => {
    stubbed(prisma.role.findMany).mockResolvedValue([
      { id: "r-a", permissions: ADMIN },
      { id: "r-b", permissions: { assets: "read" } },
    ]);
    stubbed(prisma.user.count).mockResolvedValue(4);
    expect(await countAdminEquivalentUsers()).toBe(4);
    expect(stubbed(prisma.user.count).mock.calls[0][0].where).toEqual({ roleId: { in: ["r-a"] }, disabledAt: null });
    await countAdminEquivalentUsers("u-1");
    expect(stubbed(prisma.user.count).mock.calls[1][0].where).toEqual({
      roleId: { in: ["r-a"] },
      disabledAt: null,
      NOT: { id: "u-1" },
    });
  });

  it("isAdminEquivalentRole: false for a missing role, true only for both fullwrite grants", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValueOnce(null);
    expect(await isAdminEquivalentRole("x")).toBe(false);
    stubbed(prisma.role.findUnique).mockResolvedValueOnce({ id: "r", permissions: ADMIN });
    expect(await isAdminEquivalentRole("r")).toBe(true);
    stubbed(prisma.role.findUnique).mockResolvedValueOnce({ id: "r", permissions: { users: "fullwrite", roles: "write" } });
    expect(await isAdminEquivalentRole("r")).toBe(false);
  });
});
