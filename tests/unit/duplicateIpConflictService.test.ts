/**
 * tests/unit/duplicateIpConflictService.test.ts — the database-driven half of
 * src/services/duplicateIpConflictService.ts (business rule 40 and its
 * clauses (b) freshness, (c) one device, (g)/(h) eligibility, (i) operator
 * addressing, (j) the blank hold; rule 111(c) the token guard), on the shared
 * _dbStub with sibling services mocked at the seam.
 *
 * Complements tests/unit/duplicateIpConflict.test.ts and
 * tests/unit/duplicateIpWriteTime.test.ts (the PURE half: claimIsCurrent,
 * groupCurrentClaims, simulateIncomingClaim, resolveMergeTargets, …) and the
 * integration suites duplicateIpClear / integrationTokenTarget /
 * serialConflicts (real DB). Covered here: checkIpForIncomingClaim's
 * short-circuits and the cross-source context it loads, the reconcile's
 * raise / refresh / suppress / auto-close / stranded-row handling and its
 * scoped variant (reconcileDuplicateIpForAddresses), repointing, and the
 * three resolution verbs (reassign, clear, merge) including their refusals
 * and the 3-way "keep it open on the survivors" path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

const h = vi.hoisted(() => ({
  buildIpContexts: vi.fn(),
  resolvePendingIpOverrideConflicts: vi.fn(async () => 0),
  mergeAssets: vi.fn(),
  assertMergeTokenSafe: vi.fn(async () => undefined),
}));
vi.mock("../../src/services/subnetService.js", () => ({ buildIpContexts: h.buildIpContexts }));
vi.mock("../../src/services/ipOverrideService.js", () => ({ resolvePendingIpOverrideConflicts: h.resolvePendingIpOverrideConflicts }));
vi.mock("../../src/services/assetMergeService.js", () => ({ mergeAssets: h.mergeAssets, assertMergeTokenSafe: h.assertMergeTokenSafe }));
vi.mock("../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  checkIpForIncomingClaim, reconcileDuplicateIpConflicts, reconcileDuplicateIpForAddresses,
  repointDuplicateIpConflicts, reassignDuplicateIpAsset, clearDuplicateIpAsset, mergeDuplicateIpAssets,
  logDuplicateIpDismissal, toStoredMember, type IpClaimRow,
} from "../../src/services/duplicateIpConflictService.js";

const NOW = new Date("2026-06-10T12:00:00Z");
const recent = new Date(NOW.getTime() - 3_600_000);

function row(id: string, ip: string, extra: Partial<IpClaimRow> = {}): IpClaimRow {
  return {
    id, ip, hostname: `host-${id}`, assetType: "switch", status: "active", monitored: false,
    macAddress: `AA:00:00:00:00:${id.padStart(2, "0").slice(-2)}`, ipSource: "discovery", ipOverride: null,
    lastSeen: recent, ipLastSeen: recent, ...extra,
  };
}

/** What the conflict row stores for a set of claim rows. */
function conflictFor(ip: string, rows: IpClaimRow[], extra: Record<string, unknown> = {}) {
  return {
    id: "c1",
    assetId: rows[0]?.id ?? null,
    proposedAssetFields: { collisionReason: "duplicate-ip", ipAddress: ip, members: rows.map(toStoredMember), ...extra },
  };
}

let claims: IpClaimRow[] = [];

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(h)) f.mockReset();
  h.resolvePendingIpOverrideConflicts.mockResolvedValue(0);
  h.buildIpContexts.mockResolvedValue(new Map());
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  claims = [];
  // Every claims query (sweep CTE and the per-address loader) reads this list;
  // a scoped read filters to the addresses the tagged template was handed.
  stubbed(prisma.$queryRaw).mockImplementation(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const list = values.find((v) => Array.isArray(v) && v.every((x) => typeof x === "string" && /\d+\.\d+\.\d+\.\d+/.test(x))) as string[] | undefined;
    return list ? claims.filter((c) => list.includes(c.ip)) : claims;
  });
  stubbed(prisma.assetSource.findMany).mockResolvedValue([]);
  stubbed(prisma.conflict.findMany).mockResolvedValue([]);
  stubbed(prisma.conflict.create).mockResolvedValue({ id: "new-c" });
  stubbed(prisma.conflict.updateMany).mockResolvedValue({ count: 0 });
});
afterEach(() => vi.useRealTimers());

const events = () => eventLog.logEvent.mock.calls.map((c) => c[0]);

describe("checkIpForIncomingClaim — the asset form's pre-save question", () => {
  it("answers an empty address without a query", async () => {
    expect(await checkIpForIncomingClaim({ ip: "  " })).toEqual({ ip: "", holders: [], wouldConflict: false, qualifiedBy: null });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("an address only the edited asset holds is no conflict and loads no context", async () => {
    claims = [row("1", "10.0.0.5")];
    const r = await checkIpForIncomingClaim({ ip: "10.0.0.5", excludeAssetId: "1" });
    expect(r).toEqual({ ip: "10.0.0.5", holders: [], wouldConflict: false, qualifiedBy: null });
    expect(prisma.assetSource.findMany).not.toHaveBeenCalled();
  });

  it("rule 40(i): any current holder collides with a typed address", async () => {
    claims = [row("1", "10.0.0.5", { assetType: "workstation" })];
    const r = await checkIpForIncomingClaim({ ip: " 10.0.0.5 ", assetType: "workstation", macAddress: "BB:00:00:00:00:01" });
    expect(r).toMatchObject({ ip: "10.0.0.5", wouldConflict: true, qualifiedBy: "operator-addressed" });
    expect(r.holders.map((x) => x.assetId)).toEqual(["1"]);
  });

  it("rule 40(h): a deliberate reservation in the CONTAINING subnet admits a cross-source pair", async () => {
    claims = [row("1", "10.0.0.5", { assetType: "workstation" }), row("2", "10.0.0.5", { assetType: "workstation" })];
    stubbed(prisma.assetSource.findMany).mockResolvedValue([{ assetId: "1", sourceKind: "entra" }, { assetId: "2", sourceKind: "vcenter-vm" }]);
    h.buildIpContexts.mockResolvedValue(new Map([["10.0.0.5", { subnetId: "s1" }]]));
    stubbed(prisma.reservation.findMany).mockResolvedValue([{ ipAddress: "10.0.0.5", sourceType: "manual", dhcpBinding: null, vipInfo: null }]);
    const r = await reconcileDuplicateIpConflicts();
    expect(r.groups).toBe(1);
    expect(vi.mocked(prisma.reservation.findMany).mock.calls[0][0]!.where).toEqual({ status: "active", OR: [{ subnetId: "s1", ipAddress: "10.0.0.5" }] });
    expect(vi.mocked(prisma.conflict.create).mock.calls[0][0].data.proposedAssetFields).toMatchObject({ qualifiedBy: "cross-source" });
  });

  it("a reservation is not looked up for an address in no known subnet", async () => {
    claims = [row("1", "10.0.0.5", { assetType: "workstation" }), row("2", "10.0.0.5", { assetType: "workstation" })];
    await reconcileDuplicateIpConflicts();
    expect(prisma.reservation.findMany).not.toHaveBeenCalled();
  });
});

describe("reconcileDuplicateIpConflicts", () => {
  it("steady state with no duplicates issues zero writes", async () => {
    const r = await reconcileDuplicateIpConflicts();
    expect(r).toEqual({ groups: 0, raised: 0, refreshed: 0, closed: 0, suppressed: 0, conflicts: [] });
    expect(prisma.conflict.create).not.toHaveBeenCalled();
    expect(prisma.conflict.update).not.toHaveBeenCalled();
  });

  it("raises a new conflict on the lowest member id and audits it", async () => {
    claims = [row("b", "10.0.0.5"), row("a", "10.0.0.5")];
    const r = await reconcileDuplicateIpConflicts();
    expect(r).toMatchObject({ groups: 1, raised: 1 });
    expect(r.conflicts[0]).toMatchObject({ conflictId: "new-c", ip: "10.0.0.5", qualifiedBy: "asset-type" });
    const data = vi.mocked(prisma.conflict.create).mock.calls[0][0].data;
    expect(data).toMatchObject({ entityType: "asset", assetId: "a", conflictFields: ["ipAddress"] });
    expect(data.proposedAssetFields).toMatchObject({ collisionReason: "duplicate-ip", ipAddress: "10.0.0.5", hostname: "host-a" });
    expect(events()[0]).toMatchObject({ action: "conflict.detected", resourceId: "a", details: { assetIds: ["a", "b"] } });
  });

  it("rule 40(b): a stale discovered claim does not make a pair", async () => {
    const old = new Date("2026-05-01T00:00:00Z");
    claims = [row("a", "10.0.0.5"), row("b", "10.0.0.5", { lastSeen: old, ipLastSeen: old })];
    expect((await reconcileDuplicateIpConflicts()).groups).toBe(0);
  });

  it("refreshes the open conflict in place, re-pointing it only when its asset left the group", async () => {
    claims = [row("b", "10.0.0.5"), row("c", "10.0.0.5")];
    stubbed(prisma.conflict.findMany).mockImplementation(async ({ where }: { where: { status: unknown } }) =>
      where.status === "pending" ? [{ id: "open", assetId: "a", proposedAssetFields: { ipAddress: "10.0.0.5" } }] : []);
    const r = await reconcileDuplicateIpConflicts();
    expect(r).toMatchObject({ refreshed: 1, raised: 0 });
    const upd = vi.mocked(prisma.conflict.update).mock.calls[0][0];
    expect(upd.where).toEqual({ id: "open" });
    expect(upd.data).toMatchObject({ assetId: "b" });
    expect(prisma.conflict.create).not.toHaveBeenCalled();
  });

  it("keeps the FK when the conflict's asset is still a member", async () => {
    claims = [row("a", "10.0.0.5"), row("b", "10.0.0.5")];
    stubbed(prisma.conflict.findMany).mockImplementation(async ({ where }: { where: { status: unknown } }) =>
      where.status === "pending" ? [{ id: "open", assetId: "b", proposedAssetFields: { ipAddress: "10.0.0.5" } }] : []);
    await reconcileDuplicateIpConflicts();
    expect(vi.mocked(prisma.conflict.update).mock.calls[0][0].data).not.toHaveProperty("assetId");
  });

  it("does not re-raise a set the operator dismissed; a changed set raises again", async () => {
    claims = [row("a", "10.0.0.5"), row("b", "10.0.0.5")];
    const dismissed = { status: "rejected", proposedAssetFields: { ipAddress: "10.0.0.5", members: [{ assetId: "b" }, { assetId: "a" }] } };
    stubbed(prisma.conflict.findMany).mockImplementation(async ({ where }: { where: { status: unknown } }) =>
      where.status === "pending" ? [] : [dismissed]);
    expect(await reconcileDuplicateIpConflicts()).toMatchObject({ suppressed: 1, raised: 0 });

    claims.push(row("c", "10.0.0.5"));
    expect(await reconcileDuplicateIpConflicts()).toMatchObject({ suppressed: 0, raised: 1 });
  });

  it("an ACCEPTED earlier conflict on the address does not suppress a new one", async () => {
    claims = [row("a", "10.0.0.5"), row("b", "10.0.0.5")];
    stubbed(prisma.conflict.findMany).mockImplementation(async ({ where }: { where: { status: unknown } }) =>
      where.status === "pending" ? [] : [{ status: "accepted", proposedAssetFields: { ipAddress: "10.0.0.5", members: [{ assetId: "a" }, { assetId: "b" }] } }]);
    expect((await reconcileDuplicateIpConflicts()).raised).toBe(1);
  });

  it("auto-closes a pending conflict whose address no longer collides", async () => {
    stubbed(prisma.conflict.findMany).mockImplementation(async ({ where }: { where: { status: unknown } }) =>
      where.status === "pending" ? [{ id: "open", assetId: "a", proposedAssetFields: { ipAddress: "10.0.0.5" } }] : []);
    const r = await reconcileDuplicateIpConflicts();
    expect(r.closed).toBe(1);
    expect(prisma.conflict.update).toHaveBeenCalledWith({ where: { id: "open" }, data: { status: "rejected", resolvedBy: "system:auto-resolved", resolvedAt: NOW } });
    expect(events()[0]).toMatchObject({ action: "conflict.rejected", actor: "system", resourceName: "10.0.0.5" });
  });

  it("one pending row per address: extras after the oldest are closed as stranded", async () => {
    claims = [row("a", "10.0.0.5"), row("b", "10.0.0.5")];
    stubbed(prisma.conflict.findMany).mockImplementation(async ({ where }: { where: { status: unknown } }) =>
      where.status === "pending" ? [
        { id: "oldest", assetId: "a", proposedAssetFields: { ipAddress: "10.0.0.5" } },
        { id: "dup", assetId: "a", proposedAssetFields: { ipAddress: "10.0.0.5" } },
      ] : []);
    stubbed(prisma.conflict.updateMany).mockResolvedValue({ count: 1 });
    const r = await reconcileDuplicateIpConflicts();
    expect(prisma.conflict.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["dup"] }, status: "pending" }, data: expect.objectContaining({ status: "rejected" }) });
    expect(r).toMatchObject({ closed: 1, refreshed: 1 });
  });

  it("a scoped pass neither reads nor closes conflicts on other addresses", async () => {
    claims = [row("a", "10.0.0.5"), row("b", "10.0.0.5"), row("x", "10.0.0.9"), row("y", "10.0.0.9")];
    stubbed(prisma.conflict.findMany).mockImplementation(async ({ where }: { where: { status: unknown } }) =>
      where.status === "pending" ? [{ id: "elsewhere", assetId: "q", proposedAssetFields: { ipAddress: "10.9.9.9" } }] : []);
    const out = await reconcileDuplicateIpForAddresses(["10.0.0.5", null, " 10.0.0.5 ", undefined]);
    expect([...out.keys()]).toEqual(["10.0.0.5"]);
    expect(prisma.conflict.update).not.toHaveBeenCalled();
    expect(prisma.conflict.create).toHaveBeenCalledTimes(1);
  });

  it("reconcileDuplicateIpForAddresses with nothing to look at does nothing", async () => {
    expect((await reconcileDuplicateIpForAddresses([null, "", undefined])).size).toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("repointDuplicateIpConflicts", () => {
  it("moves only PENDING duplicate-ip conflicts from one asset to another", async () => {
    stubbed(prisma.conflict.updateMany).mockResolvedValue({ count: 2 });
    expect(await repointDuplicateIpConflicts("ghost", "survivor")).toBe(2);
    expect(vi.mocked(prisma.conflict.updateMany).mock.calls[0][0]).toMatchObject({
      where: { entityType: "asset", status: "pending", assetId: "ghost", proposedAssetFields: { path: ["collisionReason"], equals: "duplicate-ip" } },
      data: { assetId: "survivor" },
    });
  });
});

describe("reassignDuplicateIpAsset", () => {
  const pair = () => [row("a", "10.0.0.5"), row("b", "10.0.0.5")];
  beforeEach(() => {
    stubbed(prisma.asset.findUnique).mockResolvedValue({ id: "a", hostname: "host-a", ipAddress: "10.0.0.5", ipOverride: null, ipSource: "discovery", discoveredByIntegration: null });
    stubbed(prisma.asset.findFirst).mockResolvedValue(null);
  });

  it("refuses a conflict of another kind, an unknown member, and bad addresses", async () => {
    await expect(reassignDuplicateIpAsset({ id: "c", assetId: "a", proposedAssetFields: { collisionReason: "duplicate-serial" } }, "a", "10.0.0.6")).rejects.toMatchObject({ httpStatus: 400 });
    const c = conflictFor("10.0.0.5", pair());
    await expect(reassignDuplicateIpAsset(c, "zzz", "10.0.0.6")).rejects.toThrow(/not one of the assets/);
    await expect(reassignDuplicateIpAsset(c, "a", " ")).rejects.toThrow(/required/);
    await expect(reassignDuplicateIpAsset(c, "a", "10.0.0.999")).rejects.toThrow(/not a valid IP/);
    await expect(reassignDuplicateIpAsset(c, "a", "10.0.0.5")).rejects.toThrow(/same as the conflicting/);
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it("500s a conflict missing its address", async () => {
    await expect(reassignDuplicateIpAsset({ id: "c", assetId: "a", proposedAssetFields: { collisionReason: "duplicate-ip" } }, "a", "10.0.0.6")).rejects.toMatchObject({ httpStatus: 500 });
  });

  it("refuses an address another network-present asset holds (409) — that moves the duplicate", async () => {
    stubbed(prisma.asset.findFirst).mockResolvedValue({ id: "z", hostname: "printer" });
    await expect(reassignDuplicateIpAsset(conflictFor("10.0.0.5", pair()), "a", "10.0.0.6")).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining('"printer"') });
  });

  it("rule 111(c): a Fortinet-managed member needs integrations rights for a new address", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue({ id: "a", hostname: "fw", ipAddress: "10.0.0.5", ipOverride: null, ipSource: null, discoveredByIntegration: { type: "fortigate" } });
    await expect(reassignDuplicateIpAsset(conflictFor("10.0.0.5", pair()), "a", "10.0.0.6")).rejects.toMatchObject({ httpStatus: 403 });
    claims = [row("b", "10.0.0.5")];
    await expect(reassignDuplicateIpAsset(conflictFor("10.0.0.5", pair()), "a", "10.0.0.6", "op", { canManageIntegrations: true })).resolves.toMatchObject({ resolved: true });
  });

  it("writes the operator pin in ONE write, resolves the ip-override card, and closes the conflict when one claim remains", async () => {
    claims = [row("b", "10.0.0.5")]; // a has moved off
    const out = await reassignDuplicateIpAsset(conflictFor("10.0.0.5", pair()), "a", " 10.0.0.6 ", "op");
    expect(out).toEqual({ ipAddress: "10.0.0.5", newIpAddress: "10.0.0.6", assetId: "a", resolved: true, remaining: 0 });
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { ipAddress: "10.0.0.6", ipOverride: "10.0.0.6", ipBlankPinned: false, ipSource: "manual", ipCleared: null } });
    expect(h.resolvePendingIpOverrideConflicts).toHaveBeenCalledWith("a", "op");
    expect(prisma.conflict.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { status: "accepted", resolvedBy: "op", resolvedAt: NOW } });
    expect(events().map((e) => e.action)).toEqual(["asset.updated", "conflict.accepted"]);
    expect(events()[0].details).toMatchObject({ duplicateIp: "10.0.0.5", changes: { ipAddress: { from: "10.0.0.5", to: "10.0.0.6" } } });
  });

  it("a three-way collision stays open on the survivors", async () => {
    claims = [row("b", "10.0.0.5"), row("c", "10.0.0.5")];
    const out = await reassignDuplicateIpAsset(conflictFor("10.0.0.5", [row("a", "10.0.0.5"), ...claims]), "a", "10.0.0.6");
    expect(out).toMatchObject({ resolved: false, remaining: 2 });
    const data = vi.mocked(prisma.conflict.update).mock.calls[0][0].data as { proposedAssetFields: { members: Array<{ assetId: string }> } };
    expect(data.proposedAssetFields.members.map((m) => m.assetId)).toEqual(["b", "c"]);
  });

  // Was a bug until 2026-11-12: the survivors refresh in settleAfterMemberLeft
  // (and in mergeDuplicateIpAssets) rewrote proposedAssetFields WITHOUT
  // `qualifiedBy`, which the card picks its explainer from — so moving one
  // member off a 3-way operator-addressed (rule 40(i)) or cross-source (40(h))
  // collision relabelled the card as an infrastructure collision until the
  // next sweep.
  it("keeps the group's qualifiedBy when it rewrites the survivors", async () => {
    claims = [row("b", "10.0.0.5", { assetType: "workstation", ipSource: "manual" }), row("c", "10.0.0.5", { assetType: "workstation" })];
    const c = conflictFor("10.0.0.5", [row("a", "10.0.0.5", { assetType: "workstation" }), ...claims], { qualifiedBy: "operator-addressed" });
    await reassignDuplicateIpAsset(c, "a", "10.0.0.6");
    const data = vi.mocked(prisma.conflict.update).mock.calls[0][0].data as { proposedAssetFields: { qualifiedBy?: string } };
    expect(data.proposedAssetFields.qualifiedBy).toBe("operator-addressed");
  });
});

describe("clearDuplicateIpAsset — rule 40(j)", () => {
  const pair = () => [row("a", "10.0.0.5"), row("b", "10.0.0.5")];

  it("409s a member that no longer records the address", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue({ id: "a", hostname: "host-a", ipAddress: "10.0.0.7", ipOverride: null, ipSource: null });
    await expect(clearDuplicateIpAsset(conflictFor("10.0.0.5", pair()), "a")).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("404s a missing asset", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(null);
    await expect(clearDuplicateIpAsset(conflictFor("10.0.0.5", pair()), "a")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("blanks the address, drops any pin, remembers it in ipCleared, and closes the conflict", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue({ id: "a", hostname: "host-a", ipAddress: "10.0.0.5", ipOverride: "10.0.0.5", ipSource: "manual" });
    claims = [row("b", "10.0.0.5")];
    const out = await clearDuplicateIpAsset(conflictFor("10.0.0.5", pair()), "a", "op");
    expect(out).toEqual({ ipAddress: "10.0.0.5", assetId: "a", resolved: true, remaining: 0 });
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { ipAddress: null, ipOverride: null, ipBlankPinned: false, ipSource: null, ipCleared: "10.0.0.5" } });
    expect(h.resolvePendingIpOverrideConflicts).toHaveBeenCalledWith("a", "op");
    expect(events().at(-1)).toMatchObject({ action: "conflict.accepted", details: { cleared: true, assetId: "a" } });
  });

  it("leaves ip-override cards alone when there was no pin", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue({ id: "a", hostname: "host-a", ipAddress: "10.0.0.5", ipOverride: null, ipSource: "discovery" });
    await clearDuplicateIpAsset(conflictFor("10.0.0.5", pair()), "a");
    expect(h.resolvePendingIpOverrideConflicts).not.toHaveBeenCalled();
  });
});

describe("mergeDuplicateIpAssets", () => {
  const mergeResult = (ghostId: string) => ({
    survivorId: "a", absorbedId: ghostId, movedSources: 2, carriedMonitoring: true, monitorFieldsAdopted: [],
    movedMacs: 0, movedIps: 0, movedIpHistory: 0, movedSightings: 0, movedManagedAgent: false,
    movedDependencyParents: 0, replacedDependencyParents: 0, movedDependents: 1, appliedFields: [],
  });

  beforeEach(() => {
    h.mergeAssets.mockImplementation(async ({ ghostId }: { ghostId: string }) => mergeResult(ghostId));
  });

  it("re-points the conflict at the survivor BEFORE the first merge (the cascade would delete it)", async () => {
    const order: string[] = [];
    stubbed(prisma.conflict.update).mockImplementation(async () => { order.push("repoint"); return {}; });
    h.mergeAssets.mockImplementation(async ({ ghostId }: { ghostId: string }) => { order.push(`merge:${ghostId}`); return mergeResult(ghostId); });
    const c = { ...conflictFor("10.0.0.5", [row("a", "10.0.0.5"), row("b", "10.0.0.5")]), assetId: "b" };
    claims = [row("a", "10.0.0.5")];
    const out = await mergeDuplicateIpAssets(c, "a", ["b"], "op");
    expect(order.slice(0, 2)).toEqual(["repoint", "merge:b"]);
    expect(out).toEqual({ ipAddress: "10.0.0.5", survivorAssetId: "a", absorbedAssetIds: ["b"], movedSources: 2, resolved: true, remaining: 0 });
    expect(events().map((e) => e.action)).toEqual(["asset.merged", "conflict.accepted"]);
    expect(events()[0].message).toContain("monitoring carried over");
  });

  it("checks the rule 111(c) token guard for every ghost before any write — only when the caller passes rights", async () => {
    h.assertMergeTokenSafe.mockRejectedValueOnce(Object.assign(new Error("no"), { httpStatus: 403 }));
    const c = conflictFor("10.0.0.5", [row("a", "10.0.0.5"), row("b", "10.0.0.5")]);
    await expect(mergeDuplicateIpAssets(c, "a", ["b"], "op", { canManageIntegrations: false })).rejects.toMatchObject({ httpStatus: 403 });
    expect(h.mergeAssets).not.toHaveBeenCalled();
    expect(prisma.conflict.update).not.toHaveBeenCalled();

    h.assertMergeTokenSafe.mockClear();
    claims = [row("a", "10.0.0.5")];
    await mergeDuplicateIpAssets(c, "a", ["b"], "op");
    expect(h.assertMergeTokenSafe).not.toHaveBeenCalled();
  });

  it("refuses a survivor that is not a member", async () => {
    await expect(mergeDuplicateIpAssets(conflictFor("10.0.0.5", [row("a", "10.0.0.5"), row("b", "10.0.0.5")]), "zzz", ["b"])).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("a 3-way collision with one left unmerged stays open on the survivors", async () => {
    claims = [row("a", "10.0.0.5"), row("c", "10.0.0.5")];
    const c = conflictFor("10.0.0.5", [row("a", "10.0.0.5"), row("b", "10.0.0.5"), row("c", "10.0.0.5")]);
    const out = await mergeDuplicateIpAssets(c, "a", ["b"]);
    expect(out).toMatchObject({ resolved: false, remaining: 2 });
  });
});

describe("logDuplicateIpDismissal", () => {
  it("writes the dismissal audit line naming the address and members", () => {
    logDuplicateIpDismissal(conflictFor("10.0.0.5", [row("a", "10.0.0.5"), row("b", "10.0.0.5")]), "op");
    expect(events()[0]).toMatchObject({
      action: "conflict.rejected", resourceId: "a", resourceName: "10.0.0.5", actor: "op",
      message: expect.stringContaining("host-a, host-b keep the address"),
    });
  });
});
