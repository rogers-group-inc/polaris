/**
 * tests/unit/dependencyBlameMany.test.ts
 *
 * resolveDependencyBlameMany — the batched blame walk the rule-16 suppression
 * sweep uses to tell a child silenced by a DOWN parent from one silenced by a
 * parent in a maintenance window. It must load the graph one layer per query
 * for the whole set (not one walk per child), name each asset's chain, and
 * degrade to null — never throw — when a read fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    assetDependencyParent: { findMany: vi.fn() },
    asset: { findMany: vi.fn() },
    assetMaintenanceWindow: { findMany: vi.fn() },
  },
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));

const { resolveDependencyBlameMany } = await import("../../src/services/dependencyTreeService.js");

const node = (id: string, over: Record<string, unknown> = {}) => ({
  id, hostname: id.toUpperCase(), assetType: "switch", monitored: true, monitorStatus: "up",
  status: "active", dependencyLayer: 1, dependencySuppressed: false, dependencyTestUntil: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.assetMaintenanceWindow.findMany.mockResolvedValue([]);
});

describe("resolveDependencyBlameMany", () => {
  it("names a maintained parent and a down parent in one batched walk", async () => {
    // c1 → sw (in a window);  c2 → gw (down, no parents of its own).
    h.prisma.assetDependencyParent.findMany.mockImplementation(async ({ where }: any) => {
      const edges: Record<string, string> = { c1: "sw", c2: "gw" };
      return (where.assetId.in as string[])
        .filter((id) => edges[id])
        .map((id) => ({ assetId: id, parentAssetId: edges[id], source: "computed" }));
    });
    h.prisma.asset.findMany.mockImplementation(async ({ where }: any) => {
      const all = [node("sw", { status: "maintenance" }), node("gw", { monitorStatus: "down", assetType: "firewall" })];
      if (where.fortinetTopology) return []; // HA-standby read — no standbys here
      return all.filter((a) => (where.id.in as string[]).includes(a.id));
    });

    const out = await resolveDependencyBlameMany(["c1", "c2"]);

    expect(out.get("c1")?.rootCause).toMatchObject({ id: "sw", reason: "maintenance" });
    expect(out.get("c2")?.rootCause).toMatchObject({ id: "gw", reason: "down" });
    // The first layer is ONE query for both children.
    expect(h.prisma.assetDependencyParent.findMany.mock.calls[0][0].where.assetId.in).toEqual(["c1", "c2"]);
  });

  it("maps every asset to null when a read fails", async () => {
    h.prisma.assetDependencyParent.findMany.mockRejectedValue(new Error("db gone"));
    const out = await resolveDependencyBlameMany(["c1", "c2"]);
    expect(out.get("c1")).toBeNull();
    expect(out.get("c2")).toBeNull();
  });

  it("does no reads for an empty set", async () => {
    const out = await resolveDependencyBlameMany([]);
    expect(out.size).toBe(0);
    expect(h.prisma.assetDependencyParent.findMany).not.toHaveBeenCalled();
  });
});
