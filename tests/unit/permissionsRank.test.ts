/**
 * tests/unit/permissionsRank.test.ts — rankRole + pickHighestPrivilegeRoleId
 */

import { describe, it, expect, vi } from "vitest";

// permissions.ts imports prisma at module load (used only by the snapshot
// loader, not by the ranking functions under test).
vi.mock("../../src/db.js", () => ({ prisma: {} }));

import {
  rankRole,
  pickHighestPrivilegeRoleId,
  isAdminEquivalentPermissions,
  callerIsAdminEquivalent,
  assertNoPrivilegeEscalation,
} from "../../src/api/middleware/permissions.js";

const adminEquiv = { users: "fullwrite", roles: "fullwrite" };
const writer = { subnets: "write", reservations: "write" };
const reader = { subnets: "read" };
const none = {};

describe("isAdminEquivalentPermissions", () => {
  it("is true only when both users and roles are fullwrite", () => {
    expect(isAdminEquivalentPermissions(adminEquiv as any)).toBe(true);
    expect(isAdminEquivalentPermissions({ users: "fullwrite", roles: "write" } as any)).toBe(false);
    expect(isAdminEquivalentPermissions(writer as any)).toBe(false);
  });
});

describe("rankRole", () => {
  it("ranks an admin-equivalent role above any non-admin role", () => {
    expect(rankRole(adminEquiv)).toBe(Number.MAX_SAFE_INTEGER);
    expect(rankRole(adminEquiv)).toBeGreaterThan(rankRole(writer));
  });

  it("ranks by weighted sum for non-admin roles", () => {
    expect(rankRole(writer)).toBeGreaterThan(rankRole(reader));
    expect(rankRole(reader)).toBeGreaterThan(rankRole(none));
    expect(rankRole(none)).toBe(0);
  });
});

describe("pickHighestPrivilegeRoleId", () => {
  it("returns null for an empty list", () => {
    expect(pickHighestPrivilegeRoleId([])).toBeNull();
  });

  it("picks the most-privileged role", () => {
    const roles = [
      { id: "r-read", permissions: reader },
      { id: "r-admin", permissions: adminEquiv },
      { id: "r-write", permissions: writer },
    ];
    expect(pickHighestPrivilegeRoleId(roles)).toBe("r-admin");
  });

  it("breaks ties deterministically by lexicographically-smallest id", () => {
    const roles = [
      { id: "zeta", permissions: writer },
      { id: "alpha", permissions: writer },
      { id: "mid", permissions: writer },
    ];
    expect(pickHighestPrivilegeRoleId(roles)).toBe("alpha");
  });
});

/**
 * Business rule 47 — nobody hands out authority they do not hold.
 *
 * users:write and roles:write both sit a rung BELOW admin-equivalent, and both
 * used to be enough to manufacture an admin (create an account on an admin
 * role / promote one into it / add the two fullwrite grants to your own role).
 */
describe("assertNoPrivilegeEscalation", () => {
  const asCaller = (permissions: unknown) => ({ session: { roleSnapshot: { permissions } } } as any);
  const tokenCaller = (permissions: unknown) => ({ roleSnapshot: { permissions } } as any);

  it("reads the caller's own role from a session or a bearer token snapshot", () => {
    expect(callerIsAdminEquivalent(asCaller(adminEquiv))).toBe(true);
    expect(callerIsAdminEquivalent(tokenCaller(adminEquiv))).toBe(true);
    expect(callerIsAdminEquivalent(asCaller(writer))).toBe(false);
    // No snapshot resolved at all is not admin — it must never fail open.
    expect(callerIsAdminEquivalent({} as any)).toBe(false);
  });

  it("refuses a non-admin caller granting an admin-equivalent role", () => {
    const caller = asCaller({ users: "write", roles: "write" });
    expect(() => assertNoPrivilegeEscalation(caller, adminEquiv, 'the role "Administrator"'))
      .toThrow(/admin-equivalent control/);
  });

  it("refuses even a users:fullwrite caller who lacks roles:fullwrite", () => {
    const caller = asCaller({ users: "fullwrite", roles: "write" });
    expect(() => assertNoPrivilegeEscalation(caller, adminEquiv, "this permission set")).toThrow();
  });

  it("allows an admin-equivalent caller — this is a no-escalation rule, not four-eyes", () => {
    expect(() => assertNoPrivilegeEscalation(asCaller(adminEquiv), adminEquiv, "x")).not.toThrow();
  });

  it("ignores every target that is not admin-equivalent", () => {
    const caller = asCaller({ users: "write" });
    for (const target of [writer, reader, none, { users: "fullwrite" }, { roles: "fullwrite" }]) {
      expect(() => assertNoPrivilegeEscalation(caller, target, "x")).not.toThrow();
    }
  });

  it("does not fail open on a caller with no snapshot", () => {
    expect(() => assertNoPrivilegeEscalation({} as any, adminEquiv, "x")).toThrow();
  });

  it("throws a 403, not a 400", () => {
    try {
      assertNoPrivilegeEscalation(asCaller(writer), adminEquiv, "x");
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.httpStatus).toBe(403);
    }
  });
});
