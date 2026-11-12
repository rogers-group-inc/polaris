/**
 * tests/unit/autoMonitorApplyScope.test.ts
 *
 * `applyAutoMonitorForClass(..., onlyAssetIds)` — a scoped Discover Now
 * applies the integration's auto-monitor selection to its ONE gate's devices
 * (business rule 142), never the whole integration's fleet.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { applyAutoMonitorForClass, type AutoMonitorSelection } from "../../src/services/autoMonitorInterfacesService.js";

const selection = { types: ["physical"] } as unknown as AutoMonitorSelection;

beforeEach(() => {
  resetDbStub();
  vi.mocked(prisma.asset.findMany).mockReset();
  vi.mocked(prisma.asset.findMany).mockResolvedValue([] as any);
});

describe("applyAutoMonitorForClass — onlyAssetIds", () => {
  it("narrows the asset read to the given ids", async () => {
    await applyAutoMonitorForClass("intg-1", "fortiswitch", selection, "tester", new Set(["sw1", "sw2"]));
    const where = (vi.mocked(prisma.asset.findMany).mock.calls[0][0] as any).where;
    expect(where).toMatchObject({ discoveredByIntegrationId: "intg-1", assetType: "switch", id: { in: ["sw1", "sw2"] } });
  });

  it("an empty set applies to nothing and reads nothing", async () => {
    const r = await applyAutoMonitorForClass("intg-1", "fortiswitch", selection, "tester", new Set());
    expect(r.devices).toBe(0);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });

  it("omitted keeps the integration-wide read", async () => {
    await applyAutoMonitorForClass("intg-1", "fortigate", selection);
    const where = (vi.mocked(prisma.asset.findMany).mock.calls[0][0] as any).where;
    expect(where).toEqual({ discoveredByIntegrationId: "intg-1", assetType: "firewall" });
  });
});
