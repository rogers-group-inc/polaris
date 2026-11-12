/**
 * tests/unit/duplicateSerialConflictService.test.ts — the database-driven half
 * of src/services/duplicateSerialConflictService.ts (business rule 83 and
 * 83(c); rule 41's serial-first identity; rule 111(c) on merges; rule 157 via
 * the merge engine), on the shared _dbStub with the merge engine and the
 * duplicate-IP sibling mocked at the seam.
 *
 * Complements tests/unit/duplicateSerialConflict.test.ts (the PURE half:
 * isUsableSerial, controllerKeyFor, groupContestedSerials, claimFoldKey,
 * groupDuplicateSerialAssets, resolveMergeTargets, dismissal copy) and
 * tests/integration/serialConflicts.test.ts (real DB). Covered here:
 * recordControllerClaims (normalize / dedupe / skip placeholders / chunked
 * upsert / best-effort on failure), reconcileSerialConflicts for both
 * flavours (HA folding through fortigate-firewall source rows read
 * case-insensitively, a retired claiming gate, raise / refresh / suppress /
 * auto-close / stranded rows, pruning), mergeDuplicateSerialAssets, the
 * automatic absorbDuplicateSerialGroup executor, the out-of-card repoint and
 * settle hooks, and the two dismissal loggers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

const h = vi.hoisted(() => ({
  mergeAssets: vi.fn(),
  assertMergeTokenSafe: vi.fn(async () => undefined),
  reconcileDuplicateIpForAddresses: vi.fn(async () => new Map()),
  repointDuplicateIpConflicts: vi.fn(async () => 0),
}));
vi.mock("../../src/services/assetMergeService.js", () => ({ mergeAssets: h.mergeAssets, assertMergeTokenSafe: h.assertMergeTokenSafe }));
vi.mock("../../src/services/duplicateIpConflictService.js", () => ({
  reconcileDuplicateIpForAddresses: h.reconcileDuplicateIpForAddresses,
  repointDuplicateIpConflicts: h.repointDuplicateIpConflicts,
}));
vi.mock("../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  recordControllerClaims, reconcileSerialConflicts, mergeDuplicateSerialAssets, absorbDuplicateSerialGroup,
  repointDuplicateSerialConflicts, settleDuplicateSerialConflictsAfterMerge,
  logSerialClaimDismissal, logDuplicateSerialDismissal, type ControllerClaimInput,
} from "../../src/services/duplicateSerialConflictService.js";

const NOW = new Date("2026-06-10T12:00:00Z");
const HOUR = 3_600_000;
const SW = "S248EPTF18001234";

function claimInput(over: Partial<ControllerClaimInput> = {}): ControllerClaimInput {
  return { assetId: "sw1", deviceSerial: SW, sourceKind: "fortiswitch", controllerSerial: "FGT60F0000000001", controllerDevice: "HQ", integrationId: "i1", ...over };
}

function claimRow(id: string, controllerSerial: string | null, controllerDevice: string, ageHours = 1, over: Record<string, unknown> = {}) {
  const key = controllerSerial ? controllerSerial.toUpperCase() : `name:${controllerDevice.toLowerCase()}`;
  return {
    id, assetId: "sw1", deviceSerial: SW, sourceKind: "fortiswitch", controllerSerial, controllerDevice, controllerKey: key,
    integrationId: "i1", firstSeen: new Date(NOW.getTime() - 100 * HOUR), lastSeen: new Date(NOW.getTime() - ageHours * HOUR),
    asset: { id: "sw1", hostname: "IDF-1", assetType: "switch", status: "active" },
    ...over,
  };
}

function assetRow(id: string, serial: string, over: Record<string, unknown> = {}) {
  return { id, hostname: `host-${id}`, serialNumber: serial, assetType: "workstation", status: "active", ipAddress: null, macAddress: null, lastSeen: null, discoveredByIntegrationId: null, ...over };
}

let claimRows: ReturnType<typeof claimRow>[] = [];
let dupRows: ReturnType<typeof assetRow>[] = [];
let pendingClaim: Array<{ id: string; assetId: string | null; proposedAssetFields: unknown }> = [];
let pendingDupe: Array<{ id: string; assetId: string | null; proposedAssetFields: unknown }> = [];
let resolvedClaim: Array<{ status: string; proposedAssetFields: unknown }> = [];
let resolvedDupe: Array<{ status: string; proposedAssetFields: unknown }> = [];

const reasonOf = (where: { proposedAssetFields?: { equals?: string } }) => where.proposedAssetFields?.equals;

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(h)) f.mockReset();
  h.reconcileDuplicateIpForAddresses.mockResolvedValue(new Map());
  h.repointDuplicateIpConflicts.mockResolvedValue(0);
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  claimRows = []; dupRows = []; pendingClaim = []; pendingDupe = []; resolvedClaim = []; resolvedDupe = [];
  stubbed(prisma.assetControllerClaim.findMany).mockImplementation(async () => claimRows);
  stubbed(prisma.assetControllerClaim.deleteMany).mockResolvedValue({ count: 0 });
  stubbed(prisma.$queryRaw).mockImplementation(async () => dupRows);
  stubbed(prisma.assetSource.findMany).mockResolvedValue([]);
  stubbed(prisma.asset.findMany).mockResolvedValue([]);
  stubbed(prisma.integration.findMany).mockResolvedValue([]);
  stubbed(prisma.conflict.findMany).mockImplementation(async ({ where }: { where: any }) => {
    const pending = where.status === "pending";
    if (reasonOf(where) === "serial-two-controllers") return pending ? pendingClaim : resolvedClaim;
    return pending ? pendingDupe : resolvedDupe;
  });
  stubbed(prisma.conflict.create).mockResolvedValue({ id: "new-c" });
  stubbed(prisma.conflict.updateMany).mockResolvedValue({ count: 0 });
});
afterEach(() => vi.useRealTimers());

const events = () => eventLog.logEvent.mock.calls.map((c) => c[0]);

describe("recordControllerClaims", () => {
  it("normalizes the device serial, dedupes per (device, controller), and upserts in one transaction", async () => {
    const n = await recordControllerClaims([
      claimInput({ deviceSerial: ` ${SW.toLowerCase()} ` }),
      claimInput(),
      claimInput({ controllerSerial: "FGT60F0000000002", controllerDevice: "BRANCH" }),
    ]);
    expect(n).toBe(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const up = vi.mocked(prisma.assetControllerClaim.upsert).mock.calls.map((c) => c[0]);
    expect(up[0].where).toEqual({ deviceSerial_controllerKey: { deviceSerial: SW, controllerKey: "FGT60F0000000001" } });
    expect(up[0].create).toMatchObject({ firstSeen: NOW, lastSeen: NOW, integrationId: "i1" });
    expect(up[0].update).toMatchObject({ assetId: "sw1", lastSeen: NOW });
    expect(up[0].update).not.toHaveProperty("firstSeen");
  });

  it("keys a gate with no serial by its name", async () => {
    await recordControllerClaims([claimInput({ controllerSerial: null, controllerDevice: " Branch-FW " })]);
    expect(vi.mocked(prisma.assetControllerClaim.upsert).mock.calls[0][0].where).toEqual({ deviceSerial_controllerKey: { deviceSerial: SW, controllerKey: "name:branch-fw" } });
  });

  it("skips placeholder device serials and claims nobody can key — no write at all", async () => {
    expect(await recordControllerClaims([claimInput({ deviceSerial: "0000000000" }), claimInput({ controllerSerial: null, controllerDevice: "  " })])).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("is best-effort: a failed chunk is logged, counted out, and never thrown", async () => {
    stubbed(prisma.$transaction).mockRejectedValueOnce(new Error("deadlock"));
    await expect(recordControllerClaims([claimInput()])).resolves.toBe(0);
  });

  it("chunks at 200 rows per transaction", async () => {
    const inputs = Array.from({ length: 450 }, (_, i) => claimInput({ deviceSerial: `S248EPTF18${String(i).padStart(6, "0")}` }));
    expect(await recordControllerClaims(inputs)).toBe(450);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });
});

describe("reconcileSerialConflicts — flavour 1: one device, two controllers", () => {
  it("steady state issues zero conflict writes and still prunes 30-day-old claims", async () => {
    stubbed(prisma.assetControllerClaim.deleteMany).mockResolvedValue({ count: 4 });
    const r = await reconcileSerialConflicts(NOW);
    expect(r).toEqual({ contestedSerials: 0, duplicateSerials: 0, raised: 0, refreshed: 0, closed: 0, suppressed: 0, pruned: 4 });
    expect(vi.mocked(prisma.assetControllerClaim.deleteMany).mock.calls[0][0]).toEqual({ where: { lastSeen: { lt: new Date(NOW.getTime() - 30 * 24 * HOUR) } } });
    expect(prisma.conflict.create).not.toHaveBeenCalled();
  });

  it("reads only claims re-asserted within two days", async () => {
    await reconcileSerialConflicts(NOW);
    expect(vi.mocked(prisma.assetControllerClaim.findMany).mock.calls[0][0]!.where).toEqual({ lastSeen: { gte: new Date(NOW.getTime() - 48 * HOUR) } });
  });

  it("raises a conflict when two distinct gates claim one serial, newest claimant first, named by integration", async () => {
    claimRows = [claimRow("c1", "FGT60F0000000001", "HQ", 5), claimRow("c2", "FGT60F0000000002", "BRANCH", 1, { integrationId: "i2" })];
    stubbed(prisma.integration.findMany).mockResolvedValue([{ id: "i1", name: "FMG main" }, { id: "i2", name: "Branch FGT" }]);
    const r = await reconcileSerialConflicts(NOW);
    expect(r).toMatchObject({ contestedSerials: 1, raised: 1 });
    const data = vi.mocked(prisma.conflict.create).mock.calls[0][0].data;
    expect(data).toMatchObject({ entityType: "asset", assetId: "sw1", conflictFields: ["fortinetTopology"] });
    const claimants = (data.proposedAssetFields as { claimants: Array<{ controllerDevice: string; integrationName: string }> }).claimants;
    expect(claimants.map((c) => [c.controllerDevice, c.integrationName])).toEqual([["BRANCH", "Branch FGT"], ["HQ", "FMG main"]]);
    expect(events()[0]).toMatchObject({ action: "conflict.detected", message: expect.stringContaining("BRANCH and HQ") });
  });

  it("HA is one gate: member serials resolve through fortigate-firewall source rows, case-insensitively", async () => {
    claimRows = [claimRow("c1", "FGT60F0000000001", "HQ-A"), claimRow("c2", "FGT60F0000000002", "HQ-B")];
    stubbed(prisma.assetSource.findMany).mockResolvedValue([
      { externalId: "fgt60f0000000001", assetId: "cluster" },
      { externalId: "FGT60F0000000002", assetId: "cluster" },
    ]);
    const r = await reconcileSerialConflicts(NOW);
    expect(r.contestedSerials).toBe(0);
    expect(vi.mocked(prisma.assetSource.findMany).mock.calls[0][0]!.where).toEqual({ sourceKind: "fortigate-firewall" });
  });

  it("a name-only claim resolves through the firewall index (FMG device name), folding onto the serial claim's gate", async () => {
    claimRows = [claimRow("c1", "FGT60F0000000001", "HQ"), claimRow("c2", null, "HQ")];
    stubbed(prisma.assetSource.findMany).mockResolvedValue([{ externalId: "FGT60F0000000001", assetId: "gate" }]);
    stubbed(prisma.asset.findMany).mockImplementation(async ({ where }: { where: any }) =>
      where.assetType === "firewall"
        ? [{ id: "gate", hostname: "hq-fw", serialNumber: "FGT60F0000000001", assetType: "firewall", fortinetTopology: { deviceName: "HQ" } }]
        : [{ id: "gate", status: "active" }]);
    expect((await reconcileSerialConflicts(NOW)).contestedSerials).toBe(0);
  });

  it("rule 83(c): a claim from a decommissioned gate is not a claimant", async () => {
    claimRows = [claimRow("c1", "FGT60F0000000001", "OLD"), claimRow("c2", "FGT60F0000000002", "NEW")];
    stubbed(prisma.assetSource.findMany).mockResolvedValue([
      { externalId: "FGT60F0000000001", assetId: "old-gate" },
      { externalId: "FGT60F0000000002", assetId: "new-gate" },
    ]);
    stubbed(prisma.asset.findMany).mockImplementation(async ({ where }: { where: any }) =>
      where.id ? [{ id: "old-gate", status: "decommissioned" }, { id: "new-gate", status: "active" }] : []);
    expect((await reconcileSerialConflicts(NOW)).contestedSerials).toBe(0);
  });

  it("refreshes an open card, following the device's asset when it changed", async () => {
    claimRows = [claimRow("c1", "FGT60F0000000001", "HQ"), claimRow("c2", "FGT60F0000000002", "BR")];
    pendingClaim = [{ id: "open", assetId: "old-asset", proposedAssetFields: { deviceSerial: SW } }];
    const r = await reconcileSerialConflicts(NOW);
    expect(r).toMatchObject({ refreshed: 1, raised: 0 });
    expect(vi.mocked(prisma.conflict.update).mock.calls[0][0]).toMatchObject({ where: { id: "open" }, data: { assetId: "sw1" } });
  });

  it("does not re-raise the same dismissed pair; a third gate raises again", async () => {
    claimRows = [claimRow("c1", "FGT60F0000000001", "HQ"), claimRow("c2", "FGT60F0000000002", "BR")];
    resolvedClaim = [{ status: "rejected", proposedAssetFields: { deviceSerial: SW, claimants: [{ controllerKey: "fgt60f0000000002" }, { controllerKey: "FGT60F0000000001" }] } }];
    expect(await reconcileSerialConflicts(NOW)).toMatchObject({ suppressed: 1, raised: 0 });
    claimRows.push(claimRow("c3", "FGT60F0000000003", "DC"));
    expect(await reconcileSerialConflicts(NOW)).toMatchObject({ suppressed: 0, raised: 1 });
  });

  it("auto-closes a card once only one gate still claims the device (a completed move)", async () => {
    pendingClaim = [{ id: "open", assetId: "sw1", proposedAssetFields: { deviceSerial: SW } }];
    const r = await reconcileSerialConflicts(NOW);
    expect(r.closed).toBe(1);
    expect(prisma.conflict.update).toHaveBeenCalledWith({ where: { id: "open" }, data: { status: "rejected", resolvedBy: "system:auto-resolved", resolvedAt: NOW } });
    expect(events()[0].message).toMatch(/completed move/);
  });

  it("closes stranded extra pending rows for one serial", async () => {
    pendingClaim = [
      { id: "first", assetId: "sw1", proposedAssetFields: { deviceSerial: SW } },
      { id: "extra", assetId: "sw1", proposedAssetFields: { deviceSerial: SW } },
    ];
    stubbed(prisma.conflict.updateMany).mockResolvedValue({ count: 1 });
    const r = await reconcileSerialConflicts(NOW);
    expect(prisma.conflict.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["extra"] }, status: "pending" }, data: expect.objectContaining({ resolvedBy: "system:auto-resolved" }) });
    expect(r.closed).toBe(2); // the stranded one + the auto-closed survivor (no live contest)
  });
});

describe("reconcileSerialConflicts — flavour 2: two records, one serial", () => {
  it("raises on the lowest asset id with the members snapshot", async () => {
    dupRows = [assetRow("b", "ABC12345XYZ"), assetRow("a", "abc12345xyz ")];
    const r = await reconcileSerialConflicts(NOW);
    expect(r).toMatchObject({ duplicateSerials: 1, raised: 1 });
    const data = vi.mocked(prisma.conflict.create).mock.calls[0][0].data;
    expect(data).toMatchObject({ assetId: "a", conflictFields: ["serialNumber"], proposedAssetFields: { collisionReason: "duplicate-serial", serialNumber: "ABC12345XYZ", hostname: "host-a" } });
    expect(events()[0].message).toMatch(/recorded on 2 assets: host-a, host-b/);
  });

  it("refresh keeps the FK while its asset is still a member, else re-points to the primary", async () => {
    dupRows = [assetRow("a", "ABC12345XYZ"), assetRow("b", "ABC12345XYZ")];
    pendingDupe = [{ id: "open", assetId: "gone", proposedAssetFields: { serialNumber: "ABC12345XYZ" } }];
    await reconcileSerialConflicts(NOW);
    expect(vi.mocked(prisma.conflict.update).mock.calls[0][0].data).toMatchObject({ assetId: "a" });
  });

  it("suppresses a dismissed member set", async () => {
    dupRows = [assetRow("a", "ABC12345XYZ"), assetRow("b", "ABC12345XYZ")];
    resolvedDupe = [{ status: "rejected", proposedAssetFields: { serialNumber: "ABC12345XYZ", members: [{ assetId: "b" }, { assetId: "a" }] } }];
    expect(await reconcileSerialConflicts(NOW)).toMatchObject({ suppressed: 1, raised: 0 });
  });

  it("ignores a serial shared by more records than one device could be (vendor default)", async () => {
    dupRows = ["a", "b", "c", "d"].map((id) => assetRow(id, "ABC12345XYZ"));
    expect((await reconcileSerialConflicts(NOW)).duplicateSerials).toBe(0);
  });

  it("auto-closes a duplicate card whose serial is no longer shared", async () => {
    pendingDupe = [{ id: "open", assetId: "a", proposedAssetFields: { serialNumber: "ABC12345XYZ" } }];
    expect((await reconcileSerialConflicts(NOW)).closed).toBe(1);
    expect(events()[0].message).toMatch(/no longer carried by two assets/);
  });
});

describe("mergeDuplicateSerialAssets", () => {
  const conflict = (assetId = "b") => ({
    id: "c1", assetId,
    proposedAssetFields: { collisionReason: "duplicate-serial", serialNumber: "ABC12345XYZ", members: [{ assetId: "a", hostname: "host-a" }, { assetId: "b", hostname: "host-b" }] },
  });
  const merged = (ghostId: string) => ({
    survivorId: "a", absorbedId: ghostId, movedSources: 3, carriedMonitoring: false, movedMacs: 0, movedIps: 0, movedIpHistory: 0,
    movedSightings: 0, movedManagedAgent: false, movedDependencyParents: 2, movedDependents: 0, appliedFields: [],
  });

  beforeEach(() => {
    h.mergeAssets.mockImplementation(async ({ ghostId }: { ghostId: string }) => merged(ghostId));
  });

  it("refuses another conflict kind (400) and a missing serial (500)", async () => {
    await expect(mergeDuplicateSerialAssets({ id: "c", assetId: "a", proposedAssetFields: { collisionReason: "duplicate-ip" } }, "a", [])).rejects.toMatchObject({ httpStatus: 400 });
    await expect(mergeDuplicateSerialAssets({ id: "c", assetId: "a", proposedAssetFields: { collisionReason: "duplicate-serial" } }, "a", [])).rejects.toMatchObject({ httpStatus: 500 });
  });

  it("re-points the card at the survivor before merging, then closes it as accepted under the operator's name", async () => {
    const order: string[] = [];
    stubbed(prisma.conflict.update).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => { order.push(data.status ? `close:${String(data.status)}` : "repoint"); return {}; });
    h.mergeAssets.mockImplementation(async ({ ghostId }: { ghostId: string }) => { order.push("merge"); return merged(ghostId); });
    dupRows = [assetRow("a", "ABC12345XYZ")];
    const out = await mergeDuplicateSerialAssets(conflict(), "a", [], "op");
    expect(order).toEqual(["repoint", "merge", "close:accepted"]);
    expect(out).toEqual({ serialNumber: "ABC12345XYZ", survivorAssetId: "a", absorbedAssetIds: ["b"], movedSources: 3, resolved: true, remaining: 0 });
    expect(vi.mocked(prisma.conflict.update).mock.calls.at(-1)![0].data).toMatchObject({ resolvedBy: "op", resolvedAt: NOW });
    expect(events().map((e) => e.action)).toEqual(["asset.merged", "conflict.accepted"]);
    expect(events()[0].message).toContain("carried 2 dependency parent link(s)");
  });

  it("does not re-point when the card already names the survivor", async () => {
    await mergeDuplicateSerialAssets(conflict("a"), "a", ["b"]);
    expect(vi.mocked(prisma.conflict.update).mock.calls.every((c) => "status" in (c[0].data as object))).toBe(true);
  });

  it("rule 111(c): checks every ghost before any write when the caller passes rights", async () => {
    h.assertMergeTokenSafe.mockRejectedValueOnce(Object.assign(new Error("no"), { httpStatus: 403 }));
    await expect(mergeDuplicateSerialAssets(conflict(), "a", [], "op", { canManageIntegrations: false })).rejects.toMatchObject({ httpStatus: 403 });
    expect(prisma.conflict.update).not.toHaveBeenCalled();
    expect(h.mergeAssets).not.toHaveBeenCalled();
  });

  it("a 3-record group with one left standing refreshes the card on the survivors", async () => {
    dupRows = [assetRow("a", "ABC12345XYZ"), assetRow("c", "ABC12345XYZ")];
    const out = await mergeDuplicateSerialAssets(conflict("a"), "a", ["b"]);
    expect(out).toMatchObject({ resolved: false, remaining: 2 });
    const data = vi.mocked(prisma.conflict.update).mock.calls.at(-1)![0].data as { assetId: string; proposedAssetFields: { members: Array<{ assetId: string }> } };
    expect(data.assetId).toBe("a");
    expect(data.proposedAssetFields.members.map((m) => m.assetId)).toEqual(["a", "c"]);
  });
});

describe("absorbDuplicateSerialGroup — the automatic merge executor", () => {
  beforeEach(() => {
    h.mergeAssets.mockImplementation(async ({ ghostId }: { ghostId: string }) => ({ absorbedId: ghostId, movedSources: 1, movedManagedAgent: ghostId === "g2" }));
    stubbed(prisma.asset.findUnique).mockResolvedValue({ ipAddress: "10.0.0.5" });
  });

  it("re-points BOTH conflict flavours before each merge, then settles and reconciles the addresses involved", async () => {
    const order: string[] = [];
    stubbed(prisma.conflict.updateMany).mockImplementation(async () => { order.push("serial-repoint"); return { count: 0 }; });
    h.repointDuplicateIpConflicts.mockImplementation(async () => { order.push("ip-repoint"); return 0; });
    h.mergeAssets.mockImplementation(async ({ ghostId }: { ghostId: string }) => { order.push(`merge:${ghostId}`); return { absorbedId: ghostId, movedSources: 1, movedManagedAgent: ghostId === "g2" }; });
    const out = await absorbDuplicateSerialGroup({ id: "keep", hostname: null }, [{ id: "g1", ipAddress: "10.0.0.7" }, { id: "g2", ipAddress: null }], "system:merge");
    expect(order).toEqual(["serial-repoint", "ip-repoint", "merge:g1", "serial-repoint", "ip-repoint", "merge:g2"]);
    expect(out).toEqual({ absorbedIds: ["g1", "g2"], movedSources: 2, movedManagedAgent: true });
    expect(h.reconcileDuplicateIpForAddresses).toHaveBeenCalledWith(["10.0.0.5", "10.0.0.7", null]);
  });

  it("a settle failure after the merges committed is swallowed", async () => {
    h.reconcileDuplicateIpForAddresses.mockRejectedValue(new Error("db"));
    await expect(absorbDuplicateSerialGroup({ id: "keep", hostname: "k" }, [{ id: "g1", ipAddress: null }], "sys")).resolves.toMatchObject({ absorbedIds: ["g1"] });
  });

  it("a merge failure throws (the next cycle re-groups what is left)", async () => {
    h.mergeAssets.mockRejectedValue(new Error("merge failed"));
    await expect(absorbDuplicateSerialGroup({ id: "keep", hostname: "k" }, [{ id: "g1", ipAddress: null }], "sys")).rejects.toThrow("merge failed");
  });
});

describe("out-of-card merge hooks", () => {
  it("repointDuplicateSerialConflicts moves pending duplicate-serial cards only", async () => {
    stubbed(prisma.conflict.updateMany).mockResolvedValue({ count: 1 });
    expect(await repointDuplicateSerialConflicts("g", "s")).toBe(1);
    expect(vi.mocked(prisma.conflict.updateMany).mock.calls[0][0]).toMatchObject({
      where: { status: "pending", assetId: "g", proposedAssetFields: { equals: "duplicate-serial" } },
      data: { assetId: "s" },
    });
  });

  it("settles only the pending cards that name either side of the merge", async () => {
    pendingDupe = [
      { id: "mine", assetId: "s", proposedAssetFields: { serialNumber: "ABC12345XYZ", members: [{ assetId: "s" }, { assetId: "g" }] } },
      { id: "other", assetId: "x", proposedAssetFields: { serialNumber: "ZZZ99999QQQ", members: [{ assetId: "x" }, { assetId: "y" }] } },
    ];
    dupRows = [];
    const out = await settleDuplicateSerialConflictsAfterMerge({ survivorAssetId: "s", absorbedAssetId: "g", survivorLabel: "S", actor: "op" });
    expect(out).toEqual({ resolved: 1, refreshed: 0 });
    expect(prisma.conflict.update).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.conflict.update).mock.calls[0][0].where).toEqual({ id: "mine" });
  });
});

describe("dismissal loggers", () => {
  it("logSerialClaimDismissal names the gates", () => {
    logSerialClaimDismissal({ id: "c", assetId: "sw1", proposedAssetFields: { deviceSerial: SW, claimants: [{ controllerDevice: "HQ" }, { controllerSerial: "FGT2" }] } }, "op");
    expect(events()[0]).toMatchObject({ action: "conflict.rejected", resourceName: SW, actor: "op", details: { collisionReason: "serial-two-controllers", deviceSerial: SW }, message: expect.stringContaining("HQ, FGT2") });
  });

  it("logDuplicateSerialDismissal names the records", () => {
    logDuplicateSerialDismissal({ id: "c", assetId: null, proposedAssetFields: { serialNumber: "ABC12345XYZ", members: [{ assetId: "a", hostname: "pc-a" }, { assetId: "b" }] } });
    expect(events()[0]).toMatchObject({ resourceId: undefined, details: { collisionReason: "duplicate-serial", serialNumber: "ABC12345XYZ" }, message: expect.stringContaining("pc-a, b stay separate") });
  });
});
