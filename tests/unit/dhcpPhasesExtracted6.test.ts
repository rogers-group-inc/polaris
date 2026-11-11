/**
 * tests/unit/dhcpPhasesExtracted6.test.ts — syncDhcpSubnets Phase 3c (VIP
 * reservations) and the finalize tail, Phases 12 to 13.7, now modules under
 * src/services/discovery/dhcp/ (CQ-B060 slice 7).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  resCreate: stubbed(prisma.reservation.create),
  resUpdate: stubbed(prisma.reservation.update),
  sourceFindMany: stubbed(prisma.assetSource.findMany),
  assetUpdate: stubbed(prisma.asset.update),
  integrationFindUnique: stubbed(prisma.integration.findUnique),
  transaction: stubbed(prisma.$transaction),
};

const m = vi.hoisted(() => ({
  releaseDnsResolvedAt: vi.fn(),
  recompute: vi.fn(),
  regions: vi.fn(),
  tags: vi.fn(),
  descSync: vi.fn(),
  descEnabled: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/dnsResolvedReservationService.js", () => ({ releaseDnsResolvedAt: m.releaseDnsResolvedAt }));
vi.mock("../../src/services/dependencyTreeService.js", () => ({ recomputeDependencyTree: m.recompute }));
vi.mock("../../src/services/mapRegionService.js", () => ({ reconcileMapRegions: m.regions }));
vi.mock("../../src/services/tagAssignmentService.js", () => ({ reconcileAllTags: m.tags }));
vi.mock("../../src/services/descriptionSyncService.js", () => ({ runDescriptionSyncForIntegration: m.descSync }));
vi.mock("../../src/utils/descriptionSyncFlags.js", () => ({ anyDescriptionSyncEnabled: m.descEnabled }));

const { syncVipReservations } = await import("../../src/services/discovery/dhcp/vipReservations.js");
const { runFinalizeReconciles } = await import("../../src/services/discovery/dhcp/finalizeReconciles.js");

beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
  db.resCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `new-${String(data.ipAddress)}`, ...data }));
  db.resUpdate.mockResolvedValue({});
});

describe("Phase 3c — firewall VIP reservations", () => {
  const LABEL = "FortiManager Integration";
  const vip = (over: Record<string, unknown> = {}) => ({
    name: "web-dnat", device: "FGT-A", extip: "10.1.0.10", mappedips: ["10.1.0.20"], realservers: [] as string[], isVirtualServer: false,
    ...over,
  });
  const run = (vips: unknown[], activeResMap = new Map<string, any>()) => {
    const state = {
      result: { vips } as never, activeResMap,
      findSubnetForIp: (ip: string) => (ip.startsWith("10.1.") ? { id: "net1" } : undefined),
      reservationKey: (s: string, ip: string) => `${s}|${ip}`,
      upsertConflict: vi.fn() as never, projectRefLabel: LABEL,
      vipNames: [] as string[], integrationId: "i1", syncLog: vi.fn(),
    };
    return { state, done: syncVipReservations(state) };
  };

  it("reserves the external and mapped addresses, with vipInfo stamped at create", async () => {
    const { state, done } = run([vip({ mappedips: ["10.1.0.20", "192.0.2.5"] })]);
    await done;
    expect(db.resCreate).toHaveBeenCalledTimes(2); // 192.0.2.5 is in no known network
    expect(m.releaseDnsResolvedAt).toHaveBeenCalledWith("net1", "10.1.0.10");
    expect(db.resCreate.mock.calls[0][0].data).toMatchObject({
      ipAddress: "10.1.0.10", hostname: "web-dnat", owner: "web-dnat", projectRef: "VIP: FGT-A", sourceType: "vip",
      notes: 'Firewall VIP "web-dnat" (external) on FGT-A — ext: 10.1.0.10',
      vipInfo: { name: "web-dnat", device: "FGT-A", extip: "10.1.0.10", role: "external", isVirtualServer: false },
    });
    expect(state.vipNames).toEqual(["10.1.0.10 (web-dnat/external)", "10.1.0.20 (web-dnat/mapped)"]);
    expect(state.activeResMap.get("net1|10.1.0.20")).toMatchObject({ id: "new-10.1.0.20" });
    expect(state.syncLog).toHaveBeenCalledWith("info", "VIP sync: created 2 VIP reservation(s)");
  });

  it("labels a load-balance Virtual Server and its realservers apart from a plain VIP", async () => {
    await run([vip({ name: "vs-web", isVirtualServer: true, mappedips: [], realservers: ["10.1.0.31"] })]).done;
    expect(db.resCreate.mock.calls[1][0].data).toMatchObject({ projectRef: "VS: FGT-A", notes: expect.stringMatching(/^Virtual server "vs-web" \(realserver\)/) });
  });

  it("stamps, never conflicts, a manual row the operator claimed for this same VIP (rule 77)", async () => {
    const claimed = { id: "man", sourceType: "manual", vipInfo: { name: "web-dnat", device: "FGT-A", extip: "10.1.0.10", role: "mapped" } };
    const { state, done } = run([vip({ mappedips: [] })], new Map([["net1|10.1.0.10", claimed]]));
    await done;
    expect(state.upsertConflict).not.toHaveBeenCalled();
    expect(db.resUpdate).toHaveBeenCalledWith({ where: { id: "man" }, data: { vipInfo: expect.objectContaining({ role: "external" }) } });
    expect(db.resCreate).not.toHaveBeenCalled();
  });

  it("raises a conflict on a manual row naming a different VIP, or none", async () => {
    const { state, done } = run([vip({ mappedips: [] })], new Map([["net1|10.1.0.10", { id: "man", sourceType: "manual", vipInfo: null }]]));
    await done;
    expect(state.upsertConflict).toHaveBeenCalledWith("man", "i1", expect.objectContaining({ sourceType: "vip", owner: "web-dnat" }), expect.anything());
  });

  it("a renamed VIP refreshes vipInfo only — the operator-editable fields are left alone", async () => {
    const row = { id: "v1", sourceType: "vip", hostname: "my label", vipInfo: { name: "old-name", device: "FGT-A", role: "external" } };
    await run([vip({ mappedips: [] })], new Map([["net1|10.1.0.10", row]])).done;
    expect(db.resUpdate).toHaveBeenCalledWith({ where: { id: "v1" }, data: { vipInfo: expect.objectContaining({ name: "web-dnat" }) } });
    expect(row.hostname).toBe("my label");
  });

  it("a DHCP row at a VIP address takes the VIP's metadata over its canonical placeholders, then fills blanks only", async () => {
    const row: Record<string, unknown> = { id: "d1", sourceType: "dhcp_lease", owner: "dhcp-lease", projectRef: LABEL, vipInfo: null };
    const { state, done } = run([vip({ mappedips: [] })], new Map([["net1|10.1.0.10", row]]));
    await done;
    expect(db.resUpdate).toHaveBeenCalledWith({ where: { id: "d1" }, data: expect.objectContaining({ owner: "web-dnat", projectRef: "VIP: FGT-A" }) });
    expect(state.upsertConflict).toHaveBeenCalledWith("d1", "i1", expect.anything(), row, "fill-only");
  });

  it("logs, rather than throws, a failed create", async () => {
    db.resCreate.mockRejectedValueOnce(new Error("unique"));
    const { state, done } = run([vip({ mappedips: [] })]);
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to create VIP reservation for 10.1.0.10 (web-dnat): unique");
    expect(state.vipNames).toEqual([]);
  });
});

describe("Phases 12–13.7 — finalize reconciles", () => {
  const base = (over: Record<string, unknown> = {}) => ({
    integrationId: "i1", integrationType: "fortimanager", mode: "finalize" as const,
    result: { devices: [{ name: "FGT-A", hostname: "fgt-a" }], managementAccess: [] } as never,
    phaseMark: vi.fn(), syncLog: vi.fn(),
    ...over,
  });
  beforeEach(() => {
    m.recompute.mockResolvedValue({ scoped: 0, edgesWritten: 0, unresolved: 0, endpointEdges: 0 });
    m.regions.mockResolvedValue({ assetsTouched: 0, subnetsTouched: 0 });
    m.tags.mockResolvedValue({ added: 0, removed: 0 });
    db.integrationFindUnique.mockResolvedValue({ id: "i1", type: "fortimanager", config: {}, name: "FMG" });
    m.descEnabled.mockReturnValue(false);
    db.assetUpdate.mockImplementation((args: unknown) => args);
    db.transaction.mockResolvedValue([]);
  });

  it("runs each reconcile in order, marking the sub-phase timer between them", async () => {
    const order: string[] = [];
    m.recompute.mockImplementation(async () => { order.push("12"); return { scoped: 0 }; });
    m.regions.mockImplementation(async () => { order.push("13"); return { assetsTouched: 0, subnetsTouched: 0 }; });
    m.tags.mockImplementation(async () => { order.push("13.65"); return { added: 0, removed: 0 }; });
    const input = base();
    input.phaseMark.mockImplementation((n: string) => order.push(`mark:${n}`));
    await runFinalizeReconciles(input);
    expect(order).toEqual(["12", "mark:13", "13", "mark:13.65", "13.65", "mark:13.6", "mark:13.7"]);
    expect(m.recompute).toHaveBeenCalledWith("i1");
  });

  it("a failing reconcile is logged and the rest still run", async () => {
    m.recompute.mockRejectedValue(new Error("dag"));
    const input = base();
    await runFinalizeReconciles(input);
    expect(input.syncLog).toHaveBeenCalledWith("error", "Dependency tree recompute failed: dag");
    expect(m.regions).toHaveBeenCalled();
    expect(m.tags).toHaveBeenCalled();
  });

  it("writes each device's management-access summary once, onto the asset its AssetSource names", async () => {
    db.sourceFindMany.mockResolvedValue([
      { assetId: "a1", externalId: "FGT1" },
      { assetId: "a1", externalId: "FGT1" }, // a second row for the same asset
      { assetId: "a2", externalId: "SW1" },
    ]);
    const input = base({ result: { devices: [], managementAccess: [
      { serial: "FGT1", summary: { https: true } },
      { serial: "SW1", summary: { ssh: true } },
      { serial: "FGT1", summary: { https: false } }, // first one wins
    ] } });
    await runFinalizeReconciles(input);
    expect(db.sourceFindMany.mock.calls[0][0].where).toMatchObject({ integrationId: "i1", externalId: { in: ["FGT1", "SW1"] } });
    expect(db.transaction).toHaveBeenCalledWith([
      { where: { id: "a1" }, data: { managementAccess: { https: true } } },
      { where: { id: "a2" }, data: { managementAccess: { ssh: true } } },
    ]);
    expect(input.syncLog).toHaveBeenCalledWith("info", "Management-access: recorded allowaccess for 2 device(s)");
  });

  it("a scoped run reconciles descriptions for its own gate only (rule 142)", async () => {
    m.descEnabled.mockReturnValue(true);
    m.descSync.mockResolvedValue({ pushed: 0, adopted: 0, failed: 0, skippedDevices: 0, fmgMirrored: 0, fmgMirrorFailed: 0 });
    await runFinalizeReconciles(base({ mode: "finalize-scoped" }));
    expect(m.descSync).toHaveBeenCalledWith(expect.objectContaining({ id: "i1" }), ["FGT-A", "fgt-a"]);
    m.descSync.mockClear();
    await runFinalizeReconciles(base());
    expect(m.descSync).toHaveBeenCalledWith(expect.objectContaining({ id: "i1" }), undefined);
  });

  it("skips the Fortinet-only phases for any other integration type", async () => {
    await runFinalizeReconciles(base({ integrationType: "vcenter", result: { devices: [], managementAccess: [{ serial: "X", summary: {} }] } }));
    expect(db.sourceFindMany).not.toHaveBeenCalled();
    expect(db.integrationFindUnique).not.toHaveBeenCalled();
    expect(m.recompute).toHaveBeenCalled();
  });
});
