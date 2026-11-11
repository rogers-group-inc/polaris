/**
 * tests/unit/syncSteps.test.ts — the steps vCenter, the workload sync and the
 * Generic API feed share (CQ-B036): the once-per-run asset preload, and the
 * tail of the missing-record sweep that decommissions an asset no other
 * discovery source still claims (enrichment kinds never count as a claim;
 * rule 70's ownership filter for the Generic API feed; maintenance windows
 * released BEFORE the status flips).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/maintenanceScheduleService.js", () => ({ releaseAssetsForDecommission: h.release }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { ENRICHMENT_SOURCE_KINDS } from "../../src/utils/assetProjection.js";
import { loadAssetsForSync, decommissionUnclaimedAssets } from "../../src/services/discovery/syncSteps.js";

const assetFindMany = stubbed(prisma.asset.findMany);
const assetUpdateMany = stubbed(prisma.asset.updateMany);
const sourceFindMany = stubbed(prisma.assetSource.findMany);
const NOW = new Date("2026-11-11T12:00:00Z");
const base = { now: NOW, actor: "op", integrationId: "int1", integrationName: "Lab vCenter", action: "asset.vcenter.decommissioned", reason: "missing-from-vcenter-inventory" };

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  h.release.mockReset().mockResolvedValue([]);
});

describe("loadAssetsForSync", () => {
  it("selects the shared columns plus the sync's extras, hydrates macAddresses, and indexes by id", async () => {
    assetFindMany.mockResolvedValue([
      { id: "a1", macAddressRows: [{ mac: "AA:BB:CC:00:00:01", macEnd: null, source: "vcenter-vnic", device: null, subnetCidr: null, subnetName: null, lastSeen: new Date(NOW), firstSeen: new Date(NOW) }] },
    ]);
    const { allAssets, assetById } = await loadAssetsForSync({ virtualization: true });
    const select = assetFindMany.mock.calls[0][0].select;
    expect(select).toMatchObject({ id: true, serialNumber: true, discoveredByIntegrationId: true, virtualization: true });
    expect(select.macAddressRows).toBeDefined();
    expect(allAssets[0].macAddresses.map((m: { mac: string }) => m.mac)).toEqual(["AA:BB:CC:00:00:01"]);
    expect(assetById.get("a1")).toBe(allAssets[0]);
  });
});

describe("decommissionUnclaimedAssets", () => {
  it("does nothing for no candidates", async () => {
    expect(await decommissionUnclaimedAssets([], base)).toEqual({ decommissioned: [], keptCount: 0 });
    expect(sourceFindMany).not.toHaveBeenCalled();
  });

  it("keeps an asset another ownership-bearing source claims; enrichment kinds are not a claim", async () => {
    sourceFindMany.mockResolvedValue([{ assetId: "kept" }]);
    assetFindMany.mockResolvedValue([{ id: "gone", hostname: "vm-gone", ipAddress: null, assetType: "server" }]);
    const r = await decommissionUnclaimedAssets(["kept", "gone", "gone"], base);
    expect(r).toEqual({ decommissioned: ["vm-gone"], keptCount: 1 });
    expect(sourceFindMany.mock.calls[0][0].where).toEqual({ assetId: { in: ["kept", "gone"] }, sourceKind: { notIn: [...ENRICHMENT_SOURCE_KINDS] } });
    expect(assetFindMany.mock.calls[0][0].where).toEqual({ id: { in: ["gone"] }, status: { not: "decommissioned" } });
  });

  it("releases maintenance before the status flips, then logs one Event per asset with the sync's noun", async () => {
    sourceFindMany.mockResolvedValue([]);
    assetFindMany.mockResolvedValue([
      { id: "h", hostname: "esx01", ipAddress: null, assetType: "hypervisor" },
      { id: "v", hostname: null, ipAddress: "10.0.0.9", assetType: "server" },
    ]);
    const r = await decommissionUnclaimedAssets(["h", "v"], { ...base, noun: (t) => (t === "hypervisor" ? "ESXi host" : "VM") });
    expect(r.decommissioned).toEqual(["esx01", "10.0.0.9"]);
    expect(h.release).toHaveBeenCalledWith(["h", "v"], expect.objectContaining({ at: NOW, statusChangedBy: "Lab vCenter" }));
    expect(h.release.mock.invocationCallOrder[0]).toBeLessThan(assetUpdateMany.mock.invocationCallOrder[0]);
    expect(assetUpdateMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ["h", "v"] } },
      data: { status: "decommissioned", statusChangedAt: NOW, statusChangedBy: "Lab vCenter" },
    });
    const events = eventLog.logEvent.mock.calls.map((c) => c[0]);
    expect(events.map((e) => e.message)).toEqual([
      `ESXi host "esx01" decommissioned — no longer present in "Lab vCenter", and no other discovery source claims it`,
      `VM "10.0.0.9" decommissioned — no longer present in "Lab vCenter", and no other discovery source claims it`,
    ]);
    expect(events[0]).toMatchObject({ action: "asset.vcenter.decommissioned", resourceId: "h", actor: "op", details: { reason: "missing-from-vcenter-inventory", integrationId: "int1" } });
  });

  it("ownedOnly (rule 70) limits the decision to assets this integration owns or nothing owns; no noun = the bare name", async () => {
    sourceFindMany.mockResolvedValue([]);
    assetFindMany.mockResolvedValue([{ id: "a", hostname: "feed-dev", ipAddress: null, assetType: "other" }]);
    await decommissionUnclaimedAssets(["a"], { ...base, ownedOnly: true });
    expect(assetFindMany.mock.calls[0][0].where.OR).toEqual([{ discoveredByIntegrationId: "int1" }, { discoveredByIntegrationId: null }]);
    expect(eventLog.logEvent.mock.calls[0][0].message).toMatch(/^"feed-dev" decommissioned/);
  });

  it("writes nothing when every unclaimed candidate is already decommissioned (or owned elsewhere)", async () => {
    sourceFindMany.mockResolvedValue([]);
    assetFindMany.mockResolvedValue([]);
    expect(await decommissionUnclaimedAssets(["a"], base)).toEqual({ decommissioned: [], keptCount: 0 });
    expect(h.release).not.toHaveBeenCalled();
    expect(assetUpdateMany).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});
