/**
 * tests/unit/subnetChassisConflictService.test.ts — the own suite for
 * src/services/subnetChassisConflictService.ts (business rule 41 / 41(a),
 * CQ-T010).
 *
 * Complements:
 *   - chassisDiff.test.ts — diffReservationLines' verdicts and migratability;
 *   - tests/integration/subnetArchive.test.ts — raise / refresh / reject
 *     dedup, the diff and accept, migration (create vs update, manual + no
 *     binding, queue vs Polaris-only, refusals, one Event) on a real DB;
 *   - tests/integration/chassisSwap.test.ts — the bulk adopt / merge / dismiss;
 *   - conflictResolutionService.test.ts — the dispatcher (mocks this module).
 *
 * Adds, on the shared db stub: serial NORMALIZATION everywhere a pair is
 * compared (case / whitespace), the refreshed row carrying the integration,
 * the raise Event's wording with and without a device name, the 409 guards
 * (no payload, no archive, subnet gone), the diff's empty "new" side when the
 * subnet is gone, migration's input trimming / de-duplication, the createdBy
 * fallback to the actor, push eligibility needing a fortigateDevice, the
 * 100-op transaction chunks (a whole /24 at once), no Event when nothing
 * migrated; chassisSwapKey; the bulk verbs' 400 for an equal pair, the
 * rule-111(c) merge-token check BEFORE any write (and only when the caller
 * says whether it may manage integrations), finding each chassis's asset by a
 * case-different source externalId then by Asset.serialNumber, every
 * mergeSkipped reason, which sources and MAC rows are dropped from the
 * survivor, and the old chassis's controller claims removed (rule 83(c)).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ getArchived: vi.fn(), merge: vi.fn(), assertToken: vi.fn() }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/subnetArchiveService.js", () => ({ getArchivedSubnet: h.getArchived }));
vi.mock("../../src/services/assetMergeService.js", () => ({ mergeAssets: h.merge, assertMergeTokenSafe: h.assertToken }));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import {
  acceptChassisReplacement,
  adoptChassisSwap,
  buildChassisDiff,
  chassisSwapKey,
  migrateArchivedReservations,
  raiseChassisReplacedConflict,
  rejectChassisReplacement,
  rejectChassisSwap,
  type ChassisReplacedPayload,
} from "../../src/services/subnetChassisConflictService.js";

const db = prisma as any;

const payload = (over: Partial<ChassisReplacedPayload> = {}): ChassisReplacedPayload => ({
  collisionReason: "chassis-replaced", cidr: "10.1.0.0/24", blockId: "b1", oldSerial: "FGT60F0000000001", newSerial: "FGT60F0000000002",
  oldDeviceName: "SITE-A-FW", newDeviceName: "SITE-A-FW", archivedSubnetId: "arch-1", ...over,
});

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(h)) f.mockReset();
  h.assertToken.mockResolvedValue(undefined);
});

// ─── Raise / refresh ─────────────────────────────────────────────────────────

describe("raiseChassisReplacedConflict", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    subnetId: "s1", cidr: "10.1.0.0/24", blockId: "b1", oldSerial: " fgt60f0000000001 ", newSerial: "FGT60F0000000002",
    oldDeviceName: "SITE-A-FW", newDeviceName: null, archivedSubnetId: "arch-1", integrationId: "i1", integrationName: "FMG", ...over,
  });

  it("suppresses a blank or equal pair (compared normalized) without a query", async () => {
    expect(await raiseChassisReplacedConflict(input({ oldSerial: "  " }))).toBe("suppressed");
    expect(await raiseChassisReplacedConflict(input({ newSerial: "FGT60F0000000001 ", oldSerial: "fgt60f0000000001" }))).toBe("suppressed");
    expect(db.conflict.findMany).not.toHaveBeenCalled();
  });

  it("raises one subnet conflict with the normalized pair, and a warning Event", async () => {
    db.conflict.findMany.mockResolvedValue([]);
    expect(await raiseChassisReplacedConflict(input())).toBe("raised");
    expect(db.conflict.findMany.mock.calls[0][0].where).toEqual({
      entityType: "subnet", proposedSubnetFields: { path: ["collisionReason"], equals: "chassis-replaced" },
      subnetId: "s1", status: { in: ["pending", "rejected"] },
    });
    expect(db.conflict.create).toHaveBeenCalledWith({ data: {
      entityType: "subnet", subnetId: "s1", integrationId: "i1", conflictFields: ["fortigateSerial"],
      proposedSubnetFields: payload({ newDeviceName: null }),
    } });
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ level: "warning", action: "conflict.detected", resourceType: "subnet", resourceId: "s1", actor: "system" });
    expect(ev.message).toBe("Subnet 10.1.0.0/24 is now served by a different FortiGate chassis — serial FGT60F0000000001 replaced by FGT60F0000000002. Its previous reservations are archived for review.");
    expect(ev.details).toMatchObject({ integrationName: "FMG" });
  });

  it("names the new device in the Event when known", async () => {
    db.conflict.findMany.mockResolvedValue([]);
    await raiseChassisReplacedConflict(input({ newDeviceName: "SITE-A-FW-2", actor: "alice" }));
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ actor: "alice", message: expect.stringContaining('(device "SITE-A-FW-2")') });
  });

  it("refreshes a pending row of the same pair (stored in another case) instead of stacking, and logs nothing", async () => {
    db.conflict.findMany.mockResolvedValue([{ id: "c1", status: "pending", proposedSubnetFields: { oldSerial: "fgt60f0000000001", newSerial: "fgt60f0000000002" } }]);
    expect(await raiseChassisReplacedConflict(input({ archivedSubnetId: "arch-2" }))).toBe("refreshed");
    expect(db.conflict.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { proposedSubnetFields: payload({ newDeviceName: null, archivedSubnetId: "arch-2" }), integrationId: "i1" } });
    expect(db.conflict.create).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("a rejected row of the same pair suppresses; a different pair (a second swap) raises anew", async () => {
    db.conflict.findMany.mockResolvedValue([{ id: "c1", status: "rejected", proposedSubnetFields: { oldSerial: "FGT60F0000000001", newSerial: "FGT60F0000000002" } }]);
    expect(await raiseChassisReplacedConflict(input())).toBe("suppressed");
    expect(await raiseChassisReplacedConflict(input({ oldSerial: "FGT60F0000000002", newSerial: "FGT60F0000000003" }))).toBe("raised");
  });
});

// ─── Single-row resolution ───────────────────────────────────────────────────

describe("accept / reject one conflict", () => {
  it("accept stamps the NEW serial on the subnet and logs the adoption", async () => {
    await acceptChassisReplacement({ subnetId: "s1", proposedSubnetFields: payload() }, "alice");
    expect(db.subnet.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { fortigateSerial: "FGT60F0000000002" } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "subnet.chassis.adopted", actor: "alice", message: "Subnet 10.1.0.0/24 adopted FortiGate chassis FGT60F0000000002 (was FGT60F0000000001)" });
  });

  it("accept refuses a row with no payload or whose subnet is gone", async () => {
    await expect(acceptChassisReplacement({ subnetId: "s1", proposedSubnetFields: null })).rejects.toMatchObject({ httpStatus: 409 });
    await expect(acceptChassisReplacement({ subnetId: null, proposedSubnetFields: payload() })).rejects.toMatchObject({ httpStatus: 409, message: "This conflict's subnet no longer exists" });
    expect(db.subnet.update).not.toHaveBeenCalled();
  });

  it("reject only logs (the row is the dedup marker), and copes with a payload-less row", async () => {
    await rejectChassisReplacement({ subnetId: "s1", proposedSubnetFields: payload() }, "bob");
    await rejectChassisReplacement({ subnetId: null, proposedSubnetFields: null });
    expect(eventLog.logEvent.mock.calls[0][0].message).toBe("Chassis-replacement conflict for 10.1.0.0/24 dismissed (FGT60F0000000001 → FGT60F0000000002)");
    expect(eventLog.logEvent.mock.calls[1][0]).toMatchObject({ message: "Chassis-replacement conflict dismissed", details: undefined, resourceId: undefined });
    expect(db.subnet.update).not.toHaveBeenCalled();
  });
});

// ─── The diff ────────────────────────────────────────────────────────────────

const arch = (ip: string | null, over: Record<string, unknown> = {}) => ({
  ipAddress: ip, hostname: `h-${ip}`, macAddress: null, owner: "net", sourceType: "manual", status: "active", notes: null, projectRef: null,
  expiresAt: null, createdBy: "carol", ...over,
});

describe("buildChassisDiff", () => {
  it("refuses a conflict with no archived snapshot", async () => {
    await expect(buildChassisDiff({ subnetId: "s1", proposedSubnetFields: { cidr: "x" } })).rejects.toMatchObject({ httpStatus: 409 });
    await expect(buildChassisDiff({ subnetId: "s1", proposedSubnetFields: null })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("the old side from the archive, the new side live; a vanished subnet is an empty new side, not an error", async () => {
    h.getArchived.mockResolvedValue({ reservations: [arch("10.1.0.5"), arch("10.1.0.6", { sourceType: "vip" })] });
    db.reservation.findMany.mockResolvedValue([arch("10.1.0.6", { sourceType: "vip" })]);
    const r = await buildChassisDiff({ subnetId: "s1", proposedSubnetFields: payload() });
    expect(h.getArchived).toHaveBeenCalledWith("arch-1");
    expect(r.lines.map((l) => [l.ip, l.verdict, l.migratable])).toEqual([["10.1.0.5", "only-old", true], ["10.1.0.6", "same", false]]);
    db.reservation.findMany.mockClear();
    const gone = await buildChassisDiff({ subnetId: null, proposedSubnetFields: payload() });
    expect(db.reservation.findMany).not.toHaveBeenCalled();
    expect(gone.lines.every((l) => l.verdict === "only-old")).toBe(true);
  });
});

// ─── Migration ───────────────────────────────────────────────────────────────

describe("migrateArchivedReservations", () => {
  const conflict = { id: "c1", subnetId: "s1", proposedSubnetFields: payload() };
  const subnet = (over: Record<string, unknown> = {}) => ({
    id: "s1", fortigateDevice: "SITE-A-FW", discoveredBy: "i1", integration: { type: "fortimanager", config: { pushReservations: true } }, ...over,
  });

  beforeEach(() => {
    db.subnet.findUnique.mockResolvedValue(subnet());
    h.getArchived.mockResolvedValue({ reservations: [arch("10.1.0.5"), arch("10.1.0.6", { createdBy: null }), arch(null)] });
    db.reservation.findMany.mockResolvedValue([]);
  });

  it("refuses without an archive, without a subnet id, or when the subnet is gone", async () => {
    await expect(migrateArchivedReservations({ ...conflict, proposedSubnetFields: {} }, ["10.1.0.5"])).rejects.toMatchObject({ httpStatus: 409 });
    await expect(migrateArchivedReservations({ ...conflict, subnetId: null }, ["10.1.0.5"])).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(/nothing to migrate onto/) });
    db.subnet.findUnique.mockResolvedValue(null);
    await expect(migrateArchivedReservations(conflict, ["10.1.0.5"])).rejects.toMatchObject({ httpStatus: 409, message: "This conflict's subnet no longer exists" });
  });

  it("trims and de-duplicates the addresses; an empty selection is a 400", async () => {
    await expect(migrateArchivedReservations(conflict, ["  ", ""])).rejects.toMatchObject({ httpStatus: 400, message: "No addresses were selected to migrate" });
    const out = await migrateArchivedReservations(conflict, [" 10.1.0.5", "10.1.0.5 "], { actor: "alice" });
    expect(out.created).toBe(1);
    expect(db.reservation.findMany.mock.calls[0][0].where).toEqual({ subnetId: "s1", ipAddress: { in: ["10.1.0.5"] }, status: "active" });
  });

  it("a created row keeps the archived author, else the actor; pushed rows are QUEUED with no old-chassis pointers", async () => {
    const out = await migrateArchivedReservations(conflict, ["10.1.0.5", "10.1.0.6"], { actor: "alice" });
    expect(out).toEqual({ created: 2, updated: 0, queuedForPush: 2, skipped: [] });
    const [a, b] = db.reservation.create.mock.calls.map((c: any[]) => c[0].data);
    expect(a.createdBy).toBe("carol");
    expect(b.createdBy).toBe("alice");
    expect(a).toMatchObject({
      subnetId: "s1", ipAddress: "10.1.0.5", sourceType: "manual", dhcpBinding: null, status: "active",
      pushedToId: "i1", pushStatus: "pending", pushAttempts: 0, pushedScopeId: null, pushedEntryId: null, pushedAt: null,
    });
    expect(a.pushQueuedAt).toBeInstanceOf(Date);
    expect(eventLog.logEvent.mock.calls[0][0].message).toBe('Migrated 2 reservation(s) from FortiGate chassis FGT60F0000000001 onto FGT60F0000000002 for 10.1.0.0/24 — queued for push to "SITE-A-FW"');
  });

  it("push on but no fortigateDevice: Polaris-only, nothing queued", async () => {
    db.subnet.findUnique.mockResolvedValue(subnet({ fortigateDevice: null }));
    const out = await migrateArchivedReservations(conflict, ["10.1.0.5"]);
    expect(out.queuedForPush).toBe(0);
    expect(db.reservation.create.mock.calls[0][0].data).toMatchObject({ pushedToId: null, pushStatus: null, pushQueuedAt: null });
    expect(eventLog.logEvent.mock.calls[0][0].message).toMatch(/Polaris-only \(DHCP push is off for this integration\)$/);
  });

  it("a live row at the address is updated in place", async () => {
    db.reservation.findMany.mockResolvedValue([{ id: "live-5", ipAddress: "10.1.0.5" }]);
    const out = await migrateArchivedReservations(conflict, ["10.1.0.5"]);
    expect(out).toMatchObject({ created: 0, updated: 1 });
    expect(db.reservation.update.mock.calls[0][0]).toMatchObject({ where: { id: "live-5" }, data: { sourceType: "manual", hostname: "h-10.1.0.5" } });
    expect(db.reservation.update.mock.calls[0][0].data).not.toHaveProperty("createdBy");
  });

  it("nothing migrated (every address skipped) writes no transaction and no Event", async () => {
    h.getArchived.mockResolvedValue({ reservations: [arch("10.1.0.7", { sourceType: "dhcp_lease" })] });
    const out = await migrateArchivedReservations(conflict, ["10.1.0.7", "10.1.0.99"]);
    expect(out.skipped).toEqual([{ ip: "10.1.0.7", reason: "observed" }, { ip: "10.1.0.99", reason: "not-in-archive" }]);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("a whole /24 is written in transactions of at most 100", async () => {
    const ips = Array.from({ length: 254 }, (_, i) => `10.1.0.${i + 1}`);
    h.getArchived.mockResolvedValue({ reservations: ips.map((ip) => arch(ip)) });
    const out = await migrateArchivedReservations(conflict, ips);
    expect(out.created).toBe(254);
    expect(db.$transaction.mock.calls.map((c: any[]) => c[0].length)).toEqual([100, 100, 54]);
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect((eventLog.logEvent.mock.calls[0][0].details as { ips: string[] }).ips).toHaveLength(254);
  });
});

// ─── One swap, one decision (rule 41(a)) ─────────────────────────────────────

describe("chassisSwapKey", () => {
  it("is the normalized pair, blank-tolerant", () => {
    expect(chassisSwapKey(" fgt1 ", "Fgt2")).toBe("FGT1>FGT2");
    expect(chassisSwapKey(null, undefined)).toBe(">");
  });
});

describe("adoptChassisSwap / rejectChassisSwap", () => {
  const OLD = "FGT60F0000000001", NEW = "FGT60F0000000002";
  const pending = [
    { id: "c1", subnetId: "s1", proposedSubnetFields: payload({ oldSerial: OLD.toLowerCase() }) },
    { id: "c2", subnetId: "s2", proposedSubnetFields: payload({ cidr: "10.2.0.0/24" }) },
    { id: "c3", subnetId: "s3", proposedSubnetFields: payload({ newSerial: "FGT60F0000000009" }) },
  ];

  beforeEach(() => {
    db.conflict.findMany.mockResolvedValue(pending);
    db.assetControllerClaim.deleteMany.mockResolvedValue({ count: 3 });
    db.assetSource.findMany.mockResolvedValue([]);
    db.asset.findMany.mockResolvedValue([]);
    db.assetMacAddress.findMany.mockResolvedValue([]);
  });

  it("an equal or blank pair is a 400; a pair with nothing pending is a 404", async () => {
    await expect(adoptChassisSwap(OLD, ` ${OLD.toLowerCase()}`)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(rejectChassisSwap("", NEW)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(adoptChassisSwap(OLD, "FGT60F0000000777")).rejects.toMatchObject({ httpStatus: 404 });
    await expect(rejectChassisSwap(OLD, "FGT60F0000000777")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("adopts every pending network of THIS pair (any case) in one transaction, and drops the old chassis's controller claims", async () => {
    const out = await adoptChassisSwap(OLD, NEW.toLowerCase(), { actor: "alice" });
    expect(out).toEqual({ adopted: 2, cidrs: ["10.1.0.0/24", "10.2.0.0/24"], mergedAssetId: null, mergeSkipped: null, removedClaims: 3 });
    expect(db.subnet.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["s1", "s2"] } }, data: { fortigateSerial: NEW } });
    expect(db.conflict.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: ["c1", "c2"] }, status: "pending" }, data: { status: "accepted", resolvedBy: "alice" } });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.assetControllerClaim.deleteMany).toHaveBeenCalledWith({ where: { controllerKey: OLD } });
    const actions = eventLog.logEvent.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual(["subnet.chassis.adopted", "subnet.chassis.adopted", "subnet.chassis.swap_adopted"]);
    expect(h.merge).not.toHaveBeenCalled();
    expect(h.assertToken).not.toHaveBeenCalled();
  });

  it("merge: each chassis's asset found by a case-different source externalId, then by serialNumber", async () => {
    db.assetSource.findMany.mockImplementation(async ({ where }: any) => (where.sourceKind === "fortigate-firewall" && !where.assetId
      ? [{ externalId: OLD.toLowerCase(), assetId: "a-old" }]
      : []));
    db.asset.findMany.mockResolvedValue([{ id: "a-new", serialNumber: ` ${NEW.toLowerCase()} ` }, { id: "a-other", serialNumber: OLD }]);
    h.merge.mockResolvedValue({ survivorId: "a-new", movedChildren: 2 });
    const out = await adoptChassisSwap(OLD, NEW, { mergeOldAsset: true, actor: "alice" });
    expect(h.merge).toHaveBeenCalledWith({ canonicalId: "a-new", ghostId: "a-old", canManageIntegrations: undefined });
    expect(out).toMatchObject({ mergedAssetId: "a-new", mergeSkipped: null });
    expect(eventLog.logEvent.mock.calls.find((c) => c[0].action === "asset.merged")![0]).toMatchObject({
      resourceId: "a-new", details: { reason: "chassis-replaced", oldSerial: OLD, newSerial: NEW, absorbedAssetId: "a-old", survivorId: "a-new", movedChildren: 2 },
    });
    expect(eventLog.logEvent.mock.calls.at(-1)![0].message).toMatch(/, old gate merged into the new one$/);
  });

  it("merge drops only the DEAD chassis's firewall source and the MAC rows that came from the old box", async () => {
    db.assetSource.findMany.mockImplementation(async ({ where }: any) => {
      if (where.assetId === "a-new") return [{ id: "src-dead", externalId: OLD.toLowerCase() }, { id: "src-live", externalId: NEW }];
      return [{ externalId: OLD, assetId: "a-old" }, { externalId: NEW, assetId: "a-new" }];
    });
    db.assetMacAddress.findMany.mockResolvedValue([{ id: "mac-1" }, { id: "mac-2" }]);
    h.merge.mockResolvedValue({ survivorId: "a-new" });
    await adoptChassisSwap(OLD, NEW, { mergeOldAsset: true });
    expect(db.assetMacAddress.findMany).toHaveBeenCalledWith({ where: { assetId: "a-old" }, select: { id: true } });
    // MAC rows read BEFORE the merge moves them.
    expect(db.assetMacAddress.findMany.mock.invocationCallOrder[0]).toBeLessThan(h.merge.mock.invocationCallOrder[0]);
    expect(db.assetSource.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["src-dead"] } } });
    expect(db.assetMacAddress.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["mac-1", "mac-2"] }, assetId: "a-new" } });
    expect(db.asset.findMany).not.toHaveBeenCalled(); // both found by source
  });

  it.each([
    ["old-asset-not-found", [{ externalId: NEW, assetId: "a-new" }]],
    ["new-asset-not-found", [{ externalId: OLD, assetId: "a-old" }]],
    ["same-asset", [{ externalId: OLD, assetId: "a-1" }, { externalId: NEW, assetId: "a-1" }]],
  ])("a merge that cannot happen says why (%s) and the adoption still lands", async (why, sources) => {
    db.assetSource.findMany.mockResolvedValue(sources);
    const out = await adoptChassisSwap(OLD, NEW, { mergeOldAsset: true });
    expect(out).toMatchObject({ adopted: 2, mergedAssetId: null, mergeSkipped: why });
    expect(h.merge).not.toHaveBeenCalled();
  });

  it("rule 111(c): the merge-token check runs BEFORE any write, and a refusal writes nothing", async () => {
    db.assetSource.findMany.mockResolvedValue([{ externalId: OLD, assetId: "a-old" }, { externalId: NEW, assetId: "a-new" }]);
    h.assertToken.mockRejectedValue(new AppError(403, "merging would hand a typed address a token"));
    await expect(adoptChassisSwap(OLD, NEW, { mergeOldAsset: true, canManageIntegrations: false })).rejects.toMatchObject({ httpStatus: 403 });
    expect(h.assertToken).toHaveBeenCalledWith({ canonicalId: "a-new", ghostId: "a-old", canManageIntegrations: false });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.assetControllerClaim.deleteMany).not.toHaveBeenCalled();
  });

  it("reject: every pending row of the pair rejected at once, one Event naming the networks", async () => {
    const out = await rejectChassisSwap(OLD.toLowerCase(), NEW, "bob");
    expect(out).toEqual({ rejected: 2 });
    expect(db.conflict.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: ["c1", "c2"] }, status: "pending" }, data: { status: "rejected", resolvedBy: "bob" } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "subnet.chassis.dismissed", resourceName: `${OLD} → ${NEW}`, details: { cidrs: ["10.1.0.0/24", "10.2.0.0/24"] } });
  });
});
