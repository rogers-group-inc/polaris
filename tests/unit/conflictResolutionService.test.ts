/**
 * tests/unit/conflictResolutionService.test.ts — the discovery conflict
 * resolution engine (src/services/conflictResolutionService.ts) on the shared
 * _dbStub, its sibling services mocked at the seam.
 *
 * Complements tests/integration/chassisSwap.test.ts and
 * tests/integration/agentHostPinArchive.test.ts (which drive the subnet
 * chassis and decommissioned-agent variants end to end against a real DB).
 * Covered here, without a database: listConflicts' manufacturer
 * normalization, countPendingConflicts' fold of a chassis swap into ONE
 * decision per serial pair (rule 41(a)), loadPendingConflict's 404 / 409,
 * the accept / reject dispatch per entity type, the REFUSED accepts of the
 * report-only collision reasons (rules 40, 83, 139), the reservation merge vs
 * manual-apply modes, the asset accept field rules (blank-fill, os always
 * overwrites, NetBIOS hostname upgrade, field winners, AD disabled ⇒
 * decommissioned, source tags, AssetSource identity casing), the ghost absorb
 * (one transaction, rule 157 afterAssetMerged), the ip-override accept /
 * reject, and the asset reject (sibling flavour creates nothing; otherwise a
 * separate asset with the right default type per source).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

const h = vi.hoisted(() => ({
  afterAssetMerged: vi.fn(async () => undefined),
  absorbAssetRelations: vi.fn(async () => ({ movedSources: 2, movedMacs: 1, movedIps: 0, movedIpHistory: 0, movedSightings: 0, movedManagedAgent: true })),
  resolveMonitoringCarry: vi.fn(() => ({ carried: false, adopted: [] as string[] })),
  recompute: vi.fn(async () => undefined),
  acceptChassis: vi.fn(async () => undefined),
  rejectChassis: vi.fn(async () => undefined),
  acceptDecomAgent: vi.fn(async () => undefined),
  logDecomDismissal: vi.fn(),
  logIpDismissal: vi.fn(),
  logSerialClaimDismissal: vi.fn(),
  logDupSerialDismissal: vi.fn(),
  logDupResDismissal: vi.fn(),
}));

vi.mock("../../src/services/assetRemovalService.js", () => ({ afterAssetMerged: h.afterAssetMerged }));
vi.mock("../../src/services/assetMergeService.js", () => ({
  absorbAssetRelations: h.absorbAssetRelations,
  resolveMonitoringCarry: h.resolveMonitoringCarry,
}));
vi.mock("../../src/services/monitorOverrideService.js", () => ({ recomputeMonitorOverrideForAssets: h.recompute }));
vi.mock("../../src/services/subnetChassisConflictService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  acceptChassisReplacement: h.acceptChassis,
  rejectChassisReplacement: h.rejectChassis,
}));
vi.mock("../../src/services/agentHostPinService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  acceptDecommissionedAgentConflict: h.acceptDecomAgent,
  logDecommissionedAgentDismissal: h.logDecomDismissal,
}));
vi.mock("../../src/services/duplicateIpConflictService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  logDuplicateIpDismissal: h.logIpDismissal,
}));
vi.mock("../../src/services/duplicateSerialConflictService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  logSerialClaimDismissal: h.logSerialClaimDismissal,
  logDuplicateSerialDismissal: h.logDupSerialDismissal,
}));
vi.mock("../../src/services/duplicateReservationConflictService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  logDuplicateReservationDismissal: h.logDupResDismissal,
}));

import { prisma } from "../../src/db.js";
import { setAliasMap, _resetAliasMap } from "../../src/utils/manufacturerNormalize.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  listConflicts, countPendingConflicts, loadPendingConflict,
  acceptConflict, mergeAssetConflict, rejectConflict,
} from "../../src/services/conflictResolutionService.js";

const NOW = new Date("2026-06-10T12:00:00Z");

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(h)) f.mockClear();
  h.resolveMonitoringCarry.mockImplementation(() => ({ carried: false, adopted: [] }));
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  stubbed(prisma.assetSource.findUnique).mockResolvedValue(null);
  stubbed(prisma.asset.create).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-asset", ...data }));
});
afterEach(() => {
  vi.useRealTimers();
  _resetAliasMap();
});

const lastEvent = () => eventLog.logEvent.mock.calls.at(-1)![0];
const assetUpdateData = () => vi.mocked(prisma.asset.update).mock.calls[0][0].data as Record<string, unknown>;

function assetConflict(proposed: Record<string, unknown>, existing: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    id: "c1",
    entityType: "asset",
    assetId: "a1",
    proposedDeviceId: "DEV-ABC",
    integrationId: "int-1",
    asset: { id: "a1", hostname: "pc01", assetType: "workstation", tags: ["manual"], ...existing },
    proposedAssetFields: proposed,
    ...extra,
  };
}

describe("listConflicts", () => {
  it("filters by entity type and status (all ⇒ no status filter), and pages", async () => {
    stubbed(prisma.conflict.findMany).mockResolvedValue([]);
    stubbed(prisma.conflict.count).mockResolvedValue(0);
    await listConflicts(["asset"], "all", 10, 20);
    const args = vi.mocked(prisma.conflict.findMany).mock.calls[0][0]!;
    expect(args.where).toEqual({ entityType: { in: ["asset"] } });
    expect(args).toMatchObject({ skip: 20, take: 10 });
    await listConflicts(["asset", "subnet"], "pending", 10, 0);
    expect(vi.mocked(prisma.conflict.findMany).mock.calls[1][0]!.where).toEqual({ entityType: { in: ["asset", "subnet"] }, status: "pending" });
  });

  it("normalizes a proposed manufacturer on asset rows only", async () => {
    setAliasMap([["dell inc.", "Dell"]]);
    const rows = [
      { entityType: "asset", proposedAssetFields: { manufacturer: "Dell Inc." } },
      { entityType: "reservation", proposedAssetFields: { manufacturer: "Dell Inc." } },
      { entityType: "asset", proposedAssetFields: null },
    ];
    stubbed(prisma.conflict.findMany).mockResolvedValue(rows);
    stubbed(prisma.conflict.count).mockResolvedValue(3);
    const out = await listConflicts(["asset", "reservation"], "pending", 50, 0);
    expect(out.total).toBe(3);
    expect((out.conflicts[0].proposedAssetFields as { manufacturer: string }).manufacturer).toBe("Dell");
    expect((out.conflicts[1].proposedAssetFields as { manufacturer: string }).manufacturer).toBe("Dell Inc.");
  });
});

describe("countPendingConflicts — rule 41(a): one chassis swap is one decision", () => {
  it("folds subnet rows by (old, new) serial pair, counting unpaired rows singly", async () => {
    stubbed(prisma.conflict.count).mockResolvedValue(10); // 4 subnet + 6 other
    stubbed(prisma.conflict.findMany).mockResolvedValue([
      { proposedSubnetFields: { oldSerial: "FGT1", newSerial: "FGT2" } },
      { proposedSubnetFields: { oldSerial: "fgt1", newSerial: "fgt2 " } },
      { proposedSubnetFields: { oldSerial: "FGT3", newSerial: "FGT4" } },
      { proposedSubnetFields: null },
    ]);
    expect(await countPendingConflicts(["asset", "subnet"])).toBe(6 + 2 + 1);
  });

  it("does not read subnet rows when the viewer cannot see them", async () => {
    stubbed(prisma.conflict.count).mockResolvedValue(4);
    expect(await countPendingConflicts(["asset"])).toBe(4);
    expect(prisma.conflict.findMany).not.toHaveBeenCalled();
  });
});

describe("loadPendingConflict", () => {
  it("404s a missing conflict", async () => {
    stubbed(prisma.conflict.findUnique).mockResolvedValue(null);
    await expect(loadPendingConflict("x")).rejects.toMatchObject({ httpStatus: 404 });
  });
  it("409s one that is already resolved", async () => {
    stubbed(prisma.conflict.findUnique).mockResolvedValue({ id: "x", status: "accepted" });
    await expect(loadPendingConflict("x")).rejects.toMatchObject({ httpStatus: 409 });
  });
  it("returns a pending conflict", async () => {
    stubbed(prisma.conflict.findUnique).mockResolvedValue({ id: "x", status: "pending" });
    expect(await loadPendingConflict("x")).toEqual({ id: "x", status: "pending" });
  });
});

describe("reservation conflicts", () => {
  const base = {
    id: "c1", entityType: "reservation", reservationId: "r1",
    proposedHostname: "disc-host", proposedOwner: "disc-owner", proposedProjectRef: null, proposedNotes: "n",
  };

  it("manual mode applies only the conflicting fields plus the proposed sourceType", async () => {
    await acceptConflict({
      ...base, conflictFields: ["hostname"], proposedSourceType: "dhcp_reservation",
      reservation: { sourceType: "manual", ipAddress: "10.0.0.5", hostname: "mine", owner: "me" },
    }, "alice");
    expect(prisma.reservation.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { hostname: "disc-host", sourceType: "dhcp_reservation" } });
    expect(lastEvent()).toMatchObject({ action: "conflict.accepted", resourceType: "reservation", message: expect.stringContaining("(hostname)") });
    expect(prisma.conflict.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { status: "accepted", resolvedBy: "alice", resolvedAt: NOW } });
  });

  it("merge mode (no manual side) blank-fills and lands on sourceType vip", async () => {
    await acceptConflict({
      ...base, conflictFields: [], proposedSourceType: "dhcp_lease",
      reservation: { sourceType: "dhcp_lease", ipAddress: "10.0.0.5", hostname: "", owner: "kept" },
    });
    expect(prisma.reservation.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { hostname: "disc-host", notes: "n", sourceType: "vip" } });
    expect(lastEvent().message).toMatch(/folded dhcp_lease metadata into VIP record/);
  });

  it("skips the write when merge mode has nothing to fill on a VIP", async () => {
    await acceptConflict({
      ...base, proposedHostname: null, proposedOwner: null, proposedNotes: null, conflictFields: [],
      reservation: { sourceType: "vip", ipAddress: "10.0.0.5" },
    });
    expect(prisma.reservation.update).not.toHaveBeenCalled();
  });

  it("refuses an accept with no reservation link (500)", async () => {
    await expect(acceptConflict({ ...base, reservation: null, conflictFields: [] })).rejects.toMatchObject({ httpStatus: 500 });
    expect(prisma.conflict.update).not.toHaveBeenCalled();
  });

  it("reject keeps the values, logs, and marks the row rejected", async () => {
    await rejectConflict({ ...base, conflictFields: [], reservation: { ipAddress: "10.0.0.5" } }, "bob");
    expect(prisma.reservation.update).not.toHaveBeenCalled();
    expect(lastEvent()).toMatchObject({ action: "conflict.rejected", resourceId: "r1" });
    expect(vi.mocked(prisma.conflict.update).mock.calls[0][0].data).toMatchObject({ status: "rejected", resolvedBy: "bob" });
  });
});

describe("subnet (chassis-replaced) conflicts dispatch to subnetChassisConflictService", () => {
  it("accept and reject", async () => {
    const c = { id: "c9", entityType: "subnet" };
    await acceptConflict(c, "a");
    expect(h.acceptChassis).toHaveBeenCalledWith(c, "a");
    await rejectConflict(c, "a");
    expect(h.rejectChassis).toHaveBeenCalledWith(c, "a");
  });
});

describe("asset accept — refused for report-only / verb-owned collision reasons", () => {
  for (const reason of ["duplicate-ip", "serial-two-controllers", "duplicate-serial", "duplicate-reservation"]) {
    it(`refuses ${reason} with a 400 and leaves the row pending`, async () => {
      await expect(acceptConflict(assetConflict({ collisionReason: reason }))).rejects.toMatchObject({ httpStatus: 400 });
      expect(prisma.conflict.update).not.toHaveBeenCalled();
      expect(prisma.asset.update).not.toHaveBeenCalled();
    });
  }

  it("refuses an asset conflict missing its asset link or device id (500)", async () => {
    await expect(acceptConflict({ ...assetConflict({}), asset: null })).rejects.toMatchObject({ httpStatus: 500 });
    await expect(acceptConflict(assetConflict({}, {}, { proposedDeviceId: null }))).rejects.toMatchObject({ httpStatus: 500 });
  });

  it("rule 123: decommissioned-agent accept is handed to agentHostPinService", async () => {
    const c = assetConflict({ collisionReason: "decommissioned-agent-checkin" });
    await acceptConflict(c, "op");
    expect(h.acceptDecomAgent).toHaveBeenCalledWith(c, "op");
    expect(vi.mocked(prisma.conflict.update).mock.calls[0][0].data).toMatchObject({ status: "accepted" });
  });
});

describe("asset accept — field rules", () => {
  it("blank-fills, always overwrites os / osVersion, retypes only 'other', and adds Entra tags", async () => {
    await acceptConflict(assetConflict(
      { hostname: "PC01-new", serialNumber: "SN1", model: "M2", os: "Windows", osVersion: "11", trustType: "AzureAd", complianceState: "Compliant", assetType: "laptop" },
      { model: "M1", os: "Win10", osVersion: "10" },
    ));
    const d = assetUpdateData();
    expect(d).toMatchObject({ serialNumber: "SN1", os: "Windows", osVersion: "11", tags: ["manual", "entraid", "auto-discovered", "azuread", "intune-compliant"] });
    expect(d).not.toHaveProperty("model");
    expect(d).not.toHaveProperty("hostname");
    expect(d).not.toHaveProperty("assetType");
  });

  it("NetBIOS upgrade: the longer canonical hostname replaces the truncated one", async () => {
    await acceptConflict(assetConflict({ hostname: "WORKSTATION-LONGNAME", matchedVia: "netbios" }, { hostname: "WORKSTATION-LON" }));
    expect(assetUpdateData().hostname).toBe("WORKSTATION-LONGNAME");
  });

  it("an exact match never replaces a set hostname", async () => {
    await acceptConflict(assetConflict({ hostname: "WORKSTATION-LONGNAME", matchedVia: "exact" }, { hostname: "WORKSTATION-LON" }));
    expect(assetUpdateData()).not.toHaveProperty("hostname");
  });

  it("merge field winners override the defaults both ways and are named in the audit line", async () => {
    await mergeAssetConflict(assetConflict({ model: "New", os: "Linux" }, { model: "Old", os: "Win" }), "op", { model: "proposed", os: "existing" });
    const d = assetUpdateData();
    expect(d.model).toBe("New");
    expect(d).not.toHaveProperty("os");
    expect(lastEvent().message).toContain("merged with selections: model=proposed, os=existing");
    expect(vi.mocked(prisma.conflict.update).mock.calls[0][0].data).toMatchObject({ status: "accepted", resolvedBy: "op" });
  });

  it("AD: a disabled computer decommissions the asset and tags it", async () => {
    await acceptConflict(assetConflict({ assetTagPrefix: "ad:", disabled: true }), "op");
    expect(assetUpdateData()).toMatchObject({ status: "decommissioned", statusChangedAt: NOW, statusChangedBy: "op", tags: ["manual", "activedirectory", "auto-discovered", "ad-disabled"] });
  });

  it("clamps acquiredAt to lastSeen when registration postdates the last sighting", async () => {
    await acceptConflict(assetConflict({ registrationDateTime: "2026-05-01T00:00:00Z" }, { lastSeen: new Date("2026-04-01T00:00:00Z") }));
    expect(assetUpdateData().acquiredAt).toEqual(new Date("2026-04-01T00:00:00Z"));
  });

  it("Entra / AD externalIds are lowercased; vCenter ids are kept verbatim", async () => {
    await acceptConflict(assetConflict({}));
    expect(vi.mocked(prisma.assetSource.upsert).mock.calls[0][0].where).toEqual({ sourceKind_externalId: { sourceKind: "entra", externalId: "dev-abc" } });
    await acceptConflict(assetConflict({ sourceType: "vcenter", assetType: "hypervisor" }));
    expect(vi.mocked(prisma.assetSource.upsert).mock.calls[1][0].where).toEqual({ sourceKind_externalId: { sourceKind: "vcenter-host", externalId: "DEV-ABC" } });
  });

  it("the AssetSource row carries the integration and a source-shaped observed blob", async () => {
    await acceptConflict(assetConflict({ sourceType: "azurearc", hostname: "srv", arcStatus: "Disconnected" }));
    const up = vi.mocked(prisma.assetSource.upsert).mock.calls[0][0];
    expect(up.create).toMatchObject({ assetId: "a1", sourceKind: "arc", integrationId: "int-1", inferred: false, observed: { kind: "arc", name: "srv", status: "Disconnected" } });
    expect(assetUpdateData().tags).toEqual(["manual", "azurearc", "auto-discovered", "arc-disconnected"]);
  });

  it("a workload conflict maps to its source kind from sourceType + workloadRole", async () => {
    await acceptConflict(assetConflict({ sourceType: "proxmox", workloadRole: "container" }));
    expect(vi.mocked(prisma.assetSource.upsert).mock.calls[0][0].create).toMatchObject({ sourceKind: "proxmox-lxc", externalId: "DEV-ABC" });
    expect(assetUpdateData().tags).toEqual(["manual", "proxmox", "auto-discovered"]);
  });
});

describe("asset accept — ghost absorb (sibling flavour)", () => {
  const ghost = { id: "g1", serialNumber: "GSN", ipAddress: "10.1.1.1", os: "GhostOS", tags: ["vcenter", "x"], lastSeen: new Date("2026-06-09T00:00:00Z"), lastSeenSource: "vcenter" };

  beforeEach(() => {
    stubbed(prisma.assetSource.findUnique).mockResolvedValue({ assetId: "g1", asset: ghost });
  });

  it("absorbs relations, updates the target and deletes the ghost in ONE transaction, then runs rule 157", async () => {
    await acceptConflict(assetConflict({ os: "" }, { serialNumber: null, ipAddress: null }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.absorbAssetRelations).toHaveBeenCalledWith(prisma, "g1", "a1");
    expect(prisma.asset.delete).toHaveBeenCalledWith({ where: { id: "g1" } });
    expect(h.afterAssetMerged).toHaveBeenCalledWith("g1", "a1");
    const d = assetUpdateData();
    expect(d).toMatchObject({ serialNumber: "GSN", ipAddress: "10.1.1.1", os: "GhostOS", lastSeen: ghost.lastSeen, lastSeenSource: "vcenter" });
    expect(d.tags).toEqual(["manual", "entraid", "auto-discovered", "vcenter", "x"]);
    expect(lastEvent().message).toMatch(/absorbed and removed ghost asset g1 — carried over 2 source row\(s\), 1 MAC\(s\), agent enrollment/);
  });

  it("the conflict's own values outrank the ghost's", async () => {
    await acceptConflict(assetConflict({ serialNumber: "PROPOSED" }, { serialNumber: null }));
    expect(assetUpdateData().serialNumber).toBe("PROPOSED");
  });

  it("recomputes monitorOverride when monitoring was carried, and swallows a failure", async () => {
    h.resolveMonitoringCarry.mockImplementation(() => ({ carried: true, adopted: ["pollInterval"] }));
    h.recompute.mockRejectedValueOnce(new Error("boom"));
    await expect(acceptConflict(assetConflict({}))).resolves.toBeUndefined();
    expect(h.recompute).toHaveBeenCalledWith(prisma, ["a1"]);
    expect(lastEvent().message).toContain("monitoring (with 1 config field(s))");
  });

  it("the source row already on the target itself is not a ghost", async () => {
    stubbed(prisma.assetSource.findUnique).mockResolvedValue({ assetId: "a1", asset: { id: "a1" } });
    await acceptConflict(assetConflict({}));
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.asset.delete).not.toHaveBeenCalled();
  });
});

describe("ip-override conflicts", () => {
  it("accept writes the discovered IP and releases both pins in ONE write", async () => {
    await acceptConflict(assetConflict({ collisionReason: "ip-override", ipAddress: "10.0.0.9", overrideIp: "10.0.0.1" }), "op");
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { ipAddress: "10.0.0.9", ipOverride: null, ipBlankPinned: false, ipSource: "discovery" } });
    expect(lastEvent().message).toContain("(was 10.0.0.1)");
  });

  it("accept with no proposed IP is a 500", async () => {
    await expect(acceptConflict(assetConflict({ collisionReason: "ip-override" }))).rejects.toMatchObject({ httpStatus: 500 });
  });

  it("reject keeps the pin — no asset write — and names a blank pin", async () => {
    await rejectConflict(assetConflict({ collisionReason: "ip-override", ipAddress: "10.0.0.9", blankPinned: true }));
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(lastEvent().message).toContain("kept pinned address no address (cleared)");
  });
});

describe("asset reject", () => {
  it("dispatches each report-only reason to its own dismissal logger", async () => {
    const cases: Array<[string, ReturnType<typeof vi.fn>]> = [
      ["duplicate-ip", h.logIpDismissal],
      ["serial-two-controllers", h.logSerialClaimDismissal],
      ["duplicate-serial", h.logDupSerialDismissal],
      ["duplicate-reservation", h.logDupResDismissal],
      ["decommissioned-agent-checkin", h.logDecomDismissal],
    ];
    for (const [reason, fn] of cases) {
      const c = assetConflict({ collisionReason: reason });
      await rejectConflict(c, "op");
      expect(fn).toHaveBeenCalledWith(c, "op");
    }
    expect(prisma.asset.create).not.toHaveBeenCalled();
  });

  it("sibling flavour: the proposed device already has its asset ⇒ nothing created", async () => {
    stubbed(prisma.assetSource.findUnique).mockResolvedValue({ assetId: "other" });
    await rejectConflict(assetConflict({ hostname: "pc01", bothAssetsExist: true }));
    expect(prisma.asset.create).not.toHaveBeenCalled();
    expect(prisma.assetSource.upsert).not.toHaveBeenCalled();
    expect(lastEvent()).toMatchObject({ action: "conflict.rejected", resourceId: "other" });
  });

  it("otherwise creates a separate asset and stamps its AssetSource", async () => {
    await rejectConflict(assetConflict({ hostname: "pc01", lastSeen: "2026-06-01T00:00:00Z", registrationDateTime: "2026-06-05T00:00:00Z" }), "op");
    const data = vi.mocked(prisma.asset.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({ hostname: "pc01", assetType: "workstation", status: "active", statusChangedBy: "op", lastSeenSource: "conflict-reject", tags: ["entraid", "auto-discovered"] });
    expect(data.acquiredAt).toEqual(new Date("2026-06-01T00:00:00Z")); // clamped to lastSeen
    expect(data.notes).toMatch(/Auto-created after hostname collision was rejected — Entra device DEV-ABC/);
    expect(vi.mocked(prisma.assetSource.upsert).mock.calls[0][0].create).toMatchObject({ assetId: "new-asset", sourceKind: "entra", externalId: "dev-abc" });
    expect(vi.mocked(prisma.conflict.update).mock.calls[0][0].data).toMatchObject({ status: "rejected" });
  });

  it("picks the default asset type per source when none was proposed", async () => {
    const types: Array<[Record<string, unknown>, string]> = [
      [{ assetTagPrefix: "ad:" }, "other"],
      [{ sourceType: "vcenter" }, "server"],
      [{ sourceType: "azurearc" }, "server"],
      [{ sourceType: "genericapi" }, "other"],
      [{ sourceType: "unraid", workloadRole: "host" }, "hypervisor"],
      [{ sourceType: "truenas", workloadRole: "container" }, "container"],
    ];
    for (const [p] of types) await rejectConflict(assetConflict(p));
    const got = vi.mocked(prisma.asset.create).mock.calls.map((c) => (c[0].data as { assetType: string }).assetType);
    expect(got).toEqual(types.map(([, t]) => t));
  });

  it("AD: a disabled computer is created decommissioned and tagged", async () => {
    await rejectConflict(assetConflict({ assetTagPrefix: "ad:", disabled: true }));
    expect(vi.mocked(prisma.asset.create).mock.calls[0][0].data).toMatchObject({ status: "decommissioned", tags: ["activedirectory", "auto-discovered", "ad-disabled"] });
  });

  it("refuses a reject with no device id (500)", async () => {
    await expect(rejectConflict(assetConflict({}, {}, { proposedDeviceId: null }))).rejects.toMatchObject({ httpStatus: 500 });
  });
});
