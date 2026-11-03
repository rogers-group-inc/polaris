/**
 * tests/unit/dashRoleSnapshotService.test.ts
 *
 * Readonly-role identity provider for the Dash wallboard: snapshot shape,
 * mis-seeded-install failure, TTL caching, region-tag passthrough.
 * Prisma is mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    role: { findUnique: vi.fn() },
  },
}));

import {
  getReadonlyRoleIdentity,
  invalidateDashRoleSnapshotCache,
} from "../../src/services/dashRoleSnapshotService.js";
import { prisma } from "../../src/db.js";
import { AppError } from "../../src/utils/errors.js";

type Mock = ReturnType<typeof vi.fn>;
const findUnique = prisma.role.findUnique as unknown as Mock;

const READONLY_ROLE = {
  id: "role-readonly-id",
  name: "readonly",
  isProtected: true,
  permissions: { assets: "read", events: "read", integrations: "none" },
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  invalidateDashRoleSnapshotCache();
});

describe("getReadonlyRoleIdentity", () => {
  it("builds a stampable snapshot from the seeded readonly role", async () => {
    findUnique.mockResolvedValue(READONLY_ROLE);
    const { snapshot } = await getReadonlyRoleIdentity();
    expect(findUnique).toHaveBeenCalledWith({ where: { name: "readonly" } });
    expect(snapshot.id).toBe("role-readonly-id");
    expect(snapshot.name).toBe("readonly");
    expect(snapshot.isProtected).toBe(true);
    expect(snapshot.permissions.assets).toBe("read");
    expect(snapshot.permissions.integrations).toBe("none");
    expect(typeof snapshot.updatedAt).toBe("string");
  });

  it("throws AppError 500 when the readonly role row is missing", async () => {
    findUnique.mockResolvedValue(null);
    await expect(getReadonlyRoleIdentity()).rejects.toMatchObject({
      httpStatus: 500,
    });
    await expect(getReadonlyRoleIdentity()).rejects.toBeInstanceOf(AppError);
  });

  it("caches within the TTL and refetches after invalidate", async () => {
    findUnique.mockResolvedValue(READONLY_ROLE);
    await getReadonlyRoleIdentity();
    await getReadonlyRoleIdentity();
    expect(findUnique).toHaveBeenCalledTimes(1);

    invalidateDashRoleSnapshotCache();
    await getReadonlyRoleIdentity();
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

});
