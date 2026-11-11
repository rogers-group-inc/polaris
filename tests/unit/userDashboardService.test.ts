/**
 * tests/unit/userDashboardService.test.ts — per-user dashboard layout storage
 * (CQ-T010): no row reads as the EMPTY layout (no seeded defaults), a stored
 * layout round-trips untouched (older versions included), and a save upserts
 * by user and returns what was stored.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { getLayoutForUser, saveLayoutForUser, type DashboardLayout } from "../../src/services/userDashboardService.js";

const findUnique = stubbed(prisma.userDashboard.findUnique);
const upsert = stubbed(prisma.userDashboard.upsert);

beforeEach(() => resetDbStub());

const layout: DashboardLayout = {
  version: 3,
  activeId: "d1",
  dashboards: [{ id: "d1", name: "Main", columns: [{ id: "c1", width: 6, widgets: [{ id: "w1", type: "downAssets", height: 1, config: {} }] }] }],
};

describe("getLayoutForUser", () => {
  it("an operator with no row gets the empty layout, not seeded defaults", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getLayoutForUser("u1")).toEqual({ version: 3, dashboards: [], activeId: "" });
    expect(findUnique).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });
  it("a stored layout comes back as stored, an older version included", async () => {
    const v2 = { version: 2, columns: [] };
    findUnique.mockResolvedValue({ userId: "u1", layout: v2 });
    expect(await getLayoutForUser("u1")).toBe(v2);
  });
});

describe("saveLayoutForUser", () => {
  it("upserts by user and returns the stored layout", async () => {
    upsert.mockImplementation(async ({ create }: { create: { layout: unknown } }) => ({ userId: "u1", layout: create.layout }));
    expect(await saveLayoutForUser("u1", layout)).toEqual(layout);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ userId: "u1" });
    expect(arg.create).toEqual({ userId: "u1", layout });
    expect(arg.update).toEqual({ layout });
  });
});
