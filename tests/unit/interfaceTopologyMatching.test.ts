/**
 * tests/unit/interfaceTopologyMatching.test.ts — which inventory asset an
 * operator-named aggregate resolves to. A core switch's `JEFFERSON-222E-1`
 * aggregate was drawn to a decommissioned `JEFFERSON-222E-6`: retired assets
 * were still candidates, and the suffix-stripped fragment prefix-matched every
 * numbered device in the family.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { findInterfaces, findAssets } = vi.hoisted(() => ({
  findInterfaces: vi.fn(),
  findAssets: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetInterface: { findMany: findInterfaces },
    asset: { findMany: findAssets },
  },
}));

import { inferInterfaceTopology } from "../../src/services/interfaceTopologyService.js";

const asset = (id: string, hostname: string) => ({
  id, hostname, serialNumber: `SN-${id}`, ipAddress: null,
  assetType: "switch", manufacturer: "Fortinet", model: null,
});

beforeEach(() => {
  findInterfaces.mockReset();
  findAssets.mockReset();
  findInterfaces.mockResolvedValue([
    { assetId: "core2", ifName: "JEFFERSON-222E-1", ifType: "aggregate", ifParent: null },
  ]);
});

describe("inferInterfaceTopology — candidate inventory", () => {
  it("asks only for live assets (decommissioned / disabled excluded)", async () => {
    findAssets.mockResolvedValue([]);
    await inferInterfaceTopology(["core2"]);
    const where = findAssets.mock.calls[0][0].where;
    expect(where.status).toEqual({ notIn: ["decommissioned", "disabled"] });
  });

  it("does not draw an edge to a numbered sibling of the named peer", async () => {
    findAssets.mockResolvedValue([asset("core2", "JEFF-248E-CORE2"), asset("ap6", "JEFFERSON-222E-6")]);
    const { edges } = await inferInterfaceTopology(["core2"]);
    expect(edges).toEqual([]);
  });

  it("resolves to the device named exactly as the interface, over the bare fragment", async () => {
    findAssets.mockResolvedValue([
      asset("core2", "JEFF-248E-CORE2"),
      asset("bare", "JEFFERSON-222E"),
      asset("exact", "JEFFERSON-222E-1"),
    ]);
    const { edges } = await inferInterfaceTopology(["core2"]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ sourceAssetId: "core2", targetAssetId: "exact", matchVia: "hostname" });
  });
});
