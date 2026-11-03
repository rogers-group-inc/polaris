/**
 * tests/unit/roleUpdateAbsentKeys.test.ts — a function key ABSENT from a
 * posted permission matrix keeps its stored level.
 *
 * The role editor posts every key it knows. A browser holding a users.js
 * cached from before a migration added a key posts a matrix without it, and
 * `normalizePermissions` defaults a missing key to "none" — so an
 * administrator editing an unrelated cell silently revoked the new grant.
 * First seen with 20261103170000_dangerous_act_keys: admin would have lost
 * Merge Assets / Agent Deploy / Clear Alerts by renaming a role. Revoking is
 * still a statement: post the key at "none".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const roleRow = {
  id: "r1",
  name: "custom",
  description: null,
  isProtected: false,
  isBuiltIn: false,
  grantReviewNeeded: false,
  regionTags: [] as string[],
  otherTags: [] as string[],
  color: null,
  updatedAt: new Date("2026-11-03T00:00:00Z"),
  permissions: { assets: "write", assetMerge: "write", agentDeploy: "write", alertClear: "write", tags: "write" },
  _count: { users: 0 },
};

const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...roleRow, ...data }));
const findUnique = vi.fn(async () => roleRow);

vi.mock("../../src/db.js", () => ({
  prisma: { role: { findUnique: (...a: unknown[]) => findUnique(...(a as [])), update: (...a: unknown[]) => update(...(a as [{ data: Record<string, unknown> }])) } },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

import { updateRole } from "../../src/services/roleService.js";

beforeEach(() => { update.mockClear(); findUnique.mockClear(); });

describe("updateRole — keys absent from the posted matrix", () => {
  it("keeps the stored level for a key the client did not post", async () => {
    await updateRole("r1", { permissions: { assets: "read" } }, "admin");
    expect(update).toHaveBeenCalledTimes(1);
    const posted = update.mock.calls[0][0].data.permissions as Record<string, string>;
    expect(posted.assets).toBe("read");
    expect(posted.assetMerge).toBe("write");
    expect(posted.agentDeploy).toBe("write");
    expect(posted.alertClear).toBe("write");
    expect(posted.tags).toBe("write");
  });

  it("still revokes a key posted explicitly at none", async () => {
    await updateRole("r1", { permissions: { assetMerge: "none" } }, "admin");
    const posted = update.mock.calls[0][0].data.permissions as Record<string, string>;
    expect(posted.assetMerge).toBe("none");
    expect(posted.agentDeploy).toBe("write");
  });

  it("is a no-op when the posted keys match what is stored", async () => {
    await updateRole("r1", { permissions: { assets: "write" } }, "admin");
    expect(update).not.toHaveBeenCalled();
  });
});
