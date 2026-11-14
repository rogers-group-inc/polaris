/**
 * tests/unit/duplicateReservationConflictService.test.ts — the own suite for
 * src/services/duplicateReservationConflictService.ts (CQ-T010).
 *
 * Business rule 139 (+ 102(b)): an asset holding two or more DHCP bindings,
 * at least one a reservation, carries ONE pending `duplicate-reservation`
 * Conflict — raised, refreshed while the set holds, closed by the sweep when
 * it no longer qualifies, never re-raised for a set the operator dismissed.
 * Keep-one releases every other binding (ownership checked on every row
 * before any release; accepted only when all succeed); release-one resolves
 * once what remains no longer conflicts. Each binding's gate resolves to its
 * firewall through utils/fortinetParentKey (FortiManager's device name, never
 * a hostname match). The pure grouping is also pinned by
 * duplicateReservationGroups.test.ts; this file pins the sweep, the two verbs
 * and the audit events.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const m = vi.hoisted(() => ({ releaseReservation: vi.fn(), error: vi.fn() }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/reservationService.js", () => ({ releaseReservation: m.releaseReservation }));
vi.mock("../../src/utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: m.error, debug: vi.fn() },
}));

import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import type { HeldReservation, ReservationRow, MacOwnerRow } from "../../src/services/duplicateReservationConflictService.js";
const {
  DUPLICATE_RESERVATION_COLLISION_REASON,
  groupDuplicateReservations,
  bindingsConflict,
  reservationSetKey,
  reconcileDuplicateReservationConflicts,
  keepOneReservation,
  releaseOneReservation,
  logDuplicateReservationDismissal,
  logScanFailure,
} = await import("../../src/services/duplicateReservationConflictService.js");

const db = {
  resFindMany: stubbed(prisma.reservation.findMany),
  resFindUnique: stubbed(prisma.reservation.findUnique),
  macFindMany: stubbed(prisma.assetMacAddress.findMany),
  assetFindMany: stubbed(prisma.asset.findMany),
  conflictFindMany: stubbed(prisma.conflict.findMany),
  conflictCreate: stubbed(prisma.conflict.create),
  conflictUpdate: stubbed(prisma.conflict.update),
  conflictUpdateMany: stubbed(prisma.conflict.updateMany),
};

const MAC = "84:8B:CD:4C:45:40";
const CREATED = new Date("2026-10-01T00:00:00Z");

/** The sweep's fleet: active gate bindings, the MAC rows naming them, pending + dismissed conflicts. */
let fleetReservations: ReservationRow[] = [];
let fleetOwners: MacOwnerRow[] = [];
let pendingConflicts: Array<{ id: string; assetId: string | null; proposedAssetFields: unknown }> = [];
let dismissedConflicts: Array<{ assetId: string | null; proposedAssetFields: unknown }> = [];
let firewalls: Array<Record<string, unknown>> = [];

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  m.releaseReservation.mockReset();
  m.releaseReservation.mockResolvedValue({});
  m.error.mockReset();
  fleetReservations = [];
  fleetOwners = [];
  pendingConflicts = [];
  dismissedConflicts = [];
  firewalls = [];
  db.resFindMany.mockImplementation(async () => fleetReservations);
  db.macFindMany.mockImplementation(async () => fleetOwners);
  db.assetFindMany.mockImplementation(async () => firewalls);
  db.conflictFindMany.mockImplementation(async ({ where }: any) => (where.status === "pending" ? pendingConflicts : dismissedConflicts));
  db.conflictCreate.mockResolvedValue({ id: "c-new" });
  db.conflictUpdate.mockResolvedValue({});
  db.conflictUpdateMany.mockImplementation(async ({ where }: any) => ({ count: where.id.in.length }));
});

const res = (id: string, over: Partial<ReservationRow> = {}): ReservationRow => ({
  id, ipAddress: `10.1.0.${id.replace(/\D/g, "") || 1}`, macAddress: MAC, hostname: "laptop-1",
  sourceType: "dhcp_reservation", pushStatus: null, createdAt: CREATED, createdBy: null,
  subnet: { id: "s1", cidr: "10.1.0.0/24", name: "Office", fortigateDevice: "FGT-A" }, ...over,
});
const owner = (over: Partial<MacOwnerRow["asset"]> = {}, mac = MAC): MacOwnerRow => ({
  mac, asset: { id: "a1", hostname: "laptop-1", ipAddress: "10.1.0.1", assetType: "workstation", status: "active", ...over },
});
const held = (id: string, over: Partial<HeldReservation> = {}): HeldReservation => ({
  reservationId: id, kind: "reservation", ipAddress: `10.1.0.${id.replace(/\D/g, "") || 1}`, macAddress: MAC,
  hostname: "laptop-1", sourceType: "dhcp_reservation", pushStatus: null, subnetId: "s1", subnetCidr: "10.1.0.0/24",
  subnetName: "Office", gate: "FGT-A", gateAssetId: null, createdAt: CREATED.toISOString(), createdBy: null, isPrimary: false, ...over,
});
const conflict = (reservations: HeldReservation[], over: Record<string, unknown> = {}) => ({
  id: "c1", assetId: "a1",
  proposedAssetFields: { collisionReason: DUPLICATE_RESERVATION_COLLISION_REASON, hostname: "laptop-1", assetIpAddress: "10.1.0.1", reservations },
  ...over,
});

// ─── the pure pieces, beyond duplicateReservationGroups.test.ts ─────────────

describe("bindingsConflict / reservationSetKey / groupDuplicateReservations edges", () => {
  it("one reservation alone, or any number of leases alone, is not a conflict", () => {
    expect(bindingsConflict([{ kind: "reservation" }])).toBe(false);
    expect(bindingsConflict([{ kind: "lease" }, { kind: "lease" }, { kind: "lease" }])).toBe(false);
    expect(bindingsConflict([])).toBe(false);
    expect(bindingsConflict([{ kind: "lease" }, { kind: "reservation" }])).toBe(true);
  });

  it("reservationSetKey is sorted and comma-joined", () => {
    expect(reservationSetKey([{ reservationId: "b" }, { reservationId: "a" }])).toBe("a,b");
    expect(reservationSetKey([])).toBe("");
  });

  it("orders a group's bindings by address then id, and groups by asset id", () => {
    const groups = groupDuplicateReservations(
      [res("r2", { ipAddress: "10.1.0.2" }), res("r9", { ipAddress: null }), res("r1", { ipAddress: "10.1.0.2" })],
      [owner()],
    );
    expect(groups[0].reservations.map((r) => r.reservationId)).toEqual(["r9", "r1", "r2"]);
  });

  it("a MAC listed twice by the SAME asset still has one holder", () => {
    const groups = groupDuplicateReservations([res("r1"), res("r2")], [owner(), owner()]);
    expect(groups).toHaveLength(1);
  });

  it("an excluded asset sharing the MAC does not make a live asset's MAC ambiguous", () => {
    const groups = groupDuplicateReservations(
      [res("r1"), res("r2")],
      [owner(), owner({ id: "old", status: "decommissioned" })],
    );
    expect(groups.map((g) => g.assetId)).toEqual(["a1"]);
  });

  it("an owner row with an unusable MAC is ignored", () => {
    expect(groupDuplicateReservations([res("r1"), res("r2")], [owner({}, "garbage")])).toEqual([]);
  });

  it("a row whose address is null is never primary", () => {
    const g = groupDuplicateReservations([res("r1", { ipAddress: null }), res("r2")], [owner({ ipAddress: null })]);
    expect(g[0].reservations.every((r) => r.isPrimary === false)).toBe(true);
  });

  it("a binding with no gate gets no gate asset", () => {
    const g = groupDuplicateReservations(
      [res("r1", { subnet: { id: "s9", cidr: "10.9.0.0/24", name: null, fortigateDevice: null } }), res("r2")],
      [owner()], new Map([["FGT-A", "fw1"]]),
    );
    expect(g[0].reservations.map((r) => [r.gate, r.gateAssetId])).toEqual([[null, null], ["FGT-A", "fw1"]]);
  });
});

// ─── reconcileDuplicateReservationConflicts ─────────────────────────────────

describe("reconcileDuplicateReservationConflicts — scan", () => {
  it("reads only active gate bindings with a MAC, and stops before the MAC read when there are none", async () => {
    const out = await reconcileDuplicateReservationConflicts();
    expect(out).toEqual({ groups: 0, raised: 0, refreshed: 0, closed: 0, suppressed: 0 });
    expect(db.resFindMany.mock.calls[0][0].where).toEqual({
      status: "active",
      macAddress: { not: null },
      OR: [{ sourceType: "dhcp_reservation" }, { sourceType: "dhcp_lease" }, { pushStatus: "synced" }],
    });
    expect(db.macFindMany).not.toHaveBeenCalled();
  });

  it("looks up the MAC owners on single-MAC rows, normalised and deduplicated", async () => {
    fleetReservations = [res("r1", { macAddress: "84-8b-cd-4c-45-40" }), res("r2")];
    await reconcileDuplicateReservationConflicts();
    expect(db.macFindMany.mock.calls[0][0].where).toEqual({ mac: { in: [MAC] }, macEnd: null });
  });

  it("chunks the owner lookup at 1000 MACs", async () => {
    fleetReservations = Array.from({ length: 1001 }, (_, i) =>
      res(`r${i}`, { macAddress: `00:00:00:00:${String(Math.floor(i / 256) + 1).padStart(2, "0")}:${(i % 256).toString(16).padStart(2, "0")}` }));
    await reconcileDuplicateReservationConflicts();
    expect(db.macFindMany).toHaveBeenCalledTimes(2);
  });
});

describe("reconcileDuplicateReservationConflicts — raise", () => {
  beforeEach(() => {
    fleetReservations = [res("r1"), res("r2", { subnet: { id: "s2", cidr: "10.2.0.0/24", name: "Plant", fortigateDevice: "FGT-B" }, ipAddress: "10.2.0.2" })];
    fleetOwners = [owner()];
  });

  it("raises one asset conflict holding the set, and logs conflict.detected naming each binding", async () => {
    const out = await reconcileDuplicateReservationConflicts();
    expect(out).toEqual({ groups: 1, raised: 1, refreshed: 0, closed: 0, suppressed: 0 });
    const data = db.conflictCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      entityType: "asset", assetId: "a1", conflictFields: ["reservations"],
      existingAssetSnapshot: { hostname: "laptop-1", ipAddress: "10.1.0.1" },
      proposedAssetFields: { collisionReason: "duplicate-reservation", hostname: "laptop-1", assetIpAddress: "10.1.0.1" },
    });
    expect(data.proposedAssetFields.reservations.map((r: HeldReservation) => r.reservationId)).toEqual(["r1", "r2"]);
    expect(data.proposedAssetFields.reservations[0].isPrimary).toBe(true);
    expect(eventLog.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "conflict.detected", resourceType: "asset", resourceId: "a1", resourceName: "laptop-1", actor: "system",
      message: `"laptop-1" holds 2 DHCP bindings: 10.1.0.1 (reservation) on FGT-A, 10.2.0.2 (reservation) on FGT-B`,
      details: { collisionReason: "duplicate-reservation", reservationIds: ["r1", "r2"] },
    }));
  });

  it("filters pending conflicts by the collision reason on asset conflicts", async () => {
    await reconcileDuplicateReservationConflicts();
    expect(db.conflictFindMany.mock.calls[0][0].where).toEqual({
      entityType: "asset",
      proposedAssetFields: { path: ["collisionReason"], equals: "duplicate-reservation" },
      status: "pending",
    });
  });

  it("resolves each gate to its firewall by FortiManager device name, never by hostname", async () => {
    firewalls = [
      { id: "fw-a", hostname: "fgt-a-renamed", serialNumber: "FGT60F0000000001", assetType: "firewall", fortinetTopology: { deviceName: "FGT-A" } },
      // A firewall whose HOSTNAME is FGT-B but whose FMG device name is something else still resolves at step 3 —
      // the candidate query asks by deviceName, hostname and serial in one go.
      { id: "fw-b", hostname: "FGT-B", serialNumber: "FGT60F0000000002", assetType: "firewall", fortinetTopology: null },
    ];
    await reconcileDuplicateReservationConflicts();
    const where = db.assetFindMany.mock.calls[0][0].where;
    expect(where.OR[0]).toEqual({
      assetType: "firewall",
      OR: [
        { fortinetTopology: { path: ["deviceName"], equals: "FGT-A" } },
        { hostname: "FGT-A" },
        { serialNumber: "FGT-A" },
      ],
    });
    const stored = db.conflictCreate.mock.calls[0][0].data.proposedAssetFields.reservations;
    expect(stored.map((r: HeldReservation) => r.gateAssetId)).toEqual(["fw-a", "fw-b"]);
  });

  it("leaves the gate asset null when no firewall resolves", async () => {
    await reconcileDuplicateReservationConflicts();
    const stored = db.conflictCreate.mock.calls[0][0].data.proposedAssetFields.reservations;
    expect(stored.every((r: HeldReservation) => r.gateAssetId === null)).toBe(true);
  });

  it("names the asset by its address, then its id, when it has no hostname", async () => {
    fleetOwners = [owner({ hostname: null, ipAddress: null })];
    await reconcileDuplicateReservationConflicts();
    expect(eventLog.logEvent.mock.calls[0][0].resourceName).toBe("a1");
  });

  it("does not re-raise a set the operator dismissed", async () => {
    dismissedConflicts = [{ assetId: "a1", proposedAssetFields: { reservations: [held("r2"), held("r1")] } }];
    const out = await reconcileDuplicateReservationConflicts();
    expect(out).toMatchObject({ raised: 0, suppressed: 1 });
    expect(db.conflictCreate).not.toHaveBeenCalled();
    expect(db.conflictFindMany.mock.calls[1][0].where).toMatchObject({
      status: "rejected", assetId: { in: ["a1"] }, NOT: { resolvedBy: "system:auto-resolved" },
    });
  });

  it("raises again when the set differs from the one dismissed", async () => {
    dismissedConflicts = [{ assetId: "a1", proposedAssetFields: { reservations: [held("r1"), held("r7")] } }];
    expect((await reconcileDuplicateReservationConflicts()).raised).toBe(1);
  });

  it("a dismissed row with no stored set suppresses nothing", async () => {
    dismissedConflicts = [{ assetId: "a1", proposedAssetFields: null }];
    expect((await reconcileDuplicateReservationConflicts()).raised).toBe(1);
  });
});

describe("reconcileDuplicateReservationConflicts — refresh and close", () => {
  it("leaves an open conflict alone while its blob is unchanged", async () => {
    fleetReservations = [res("r1"), res("r2")];
    fleetOwners = [owner()];
    await reconcileDuplicateReservationConflicts();
    const blob = db.conflictCreate.mock.calls[0][0].data.proposedAssetFields;
    resetEventLogStub();
    db.conflictCreate.mockClear();
    pendingConflicts = [{ id: "c1", assetId: "a1", proposedAssetFields: JSON.parse(JSON.stringify(blob)) }];
    const out = await reconcileDuplicateReservationConflicts();
    expect(out).toEqual({ groups: 1, raised: 0, refreshed: 0, closed: 0, suppressed: 0 });
    expect(db.conflictUpdate).not.toHaveBeenCalled();
    expect(db.conflictCreate).not.toHaveBeenCalled();
  });

  it("refreshes an open conflict when its set grew", async () => {
    fleetReservations = [res("r1"), res("r2"), res("r3")];
    fleetOwners = [owner()];
    pendingConflicts = [conflict([held("r1"), held("r2")])];
    const out = await reconcileDuplicateReservationConflicts();
    expect(out.refreshed).toBe(1);
    const data = db.conflictUpdate.mock.calls[0][0];
    expect(data.where).toEqual({ id: "c1" });
    expect(data.data.proposedAssetFields.reservations.map((r: HeldReservation) => r.reservationId)).toEqual(["r1", "r2", "r3"]);
  });

  it("refreshes when only a detail changed (the asset's hostname)", async () => {
    fleetReservations = [res("r1"), res("r2")];
    fleetOwners = [owner({ hostname: "laptop-renamed" })];
    pendingConflicts = [conflict([held("r1", { isPrimary: true }), held("r2")])];
    expect((await reconcileDuplicateReservationConflicts()).refreshed).toBe(1);
  });

  it("does not re-raise for an asset that already has an open conflict, even a previously dismissed set", async () => {
    fleetReservations = [res("r1"), res("r2")];
    fleetOwners = [owner()];
    pendingConflicts = [conflict([held("r1"), held("r2")])];
    dismissedConflicts = [{ assetId: "a1", proposedAssetFields: { reservations: [held("r1"), held("r2")] } }];
    const out = await reconcileDuplicateReservationConflicts();
    expect(out).toMatchObject({ raised: 0, suppressed: 0 });
  });

  it("auto-resolves an open conflict whose asset no longer qualifies, and logs it", async () => {
    pendingConflicts = [conflict([held("r1"), held("r2")])];
    const out = await reconcileDuplicateReservationConflicts();
    expect(out).toMatchObject({ groups: 0, closed: 1 });
    expect(db.conflictUpdate).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { status: "rejected", resolvedBy: "system:auto-resolved", resolvedAt: expect.any(Date) },
    });
    expect(eventLog.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "conflict.rejected", resourceId: "a1", resourceName: "laptop-1", actor: "system",
      details: { collisionReason: "duplicate-reservation" },
    }));
  });

  it("names an auto-resolved conflict by its asset id when the blob carries no hostname", async () => {
    pendingConflicts = [{ id: "c1", assetId: "a1", proposedAssetFields: null }];
    await reconcileDuplicateReservationConflicts();
    expect(eventLog.logEvent.mock.calls[0][0].resourceName).toBe("a1");
  });

  it("keeps the oldest pending row per asset and closes the extras and any row without an asset", async () => {
    fleetReservations = [res("r1"), res("r2")];
    fleetOwners = [owner()];
    pendingConflicts = [
      conflict([held("r1"), held("r2")], { id: "c-old" }),
      conflict([held("r1"), held("r2")], { id: "c-dup" }),
      { id: "c-orphan", assetId: null, proposedAssetFields: {} },
    ];
    const out = await reconcileDuplicateReservationConflicts();
    expect(db.conflictUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["c-dup", "c-orphan"] }, status: "pending" },
      data: { status: "rejected", resolvedBy: "system:auto-resolved", resolvedAt: expect.any(Date) },
    });
    expect(out.closed).toBe(2);
    expect(db.conflictFindMany.mock.calls[0][0].orderBy).toEqual({ createdAt: "asc" });
    expect(out.raised).toBe(0);
  });

  it("skips the dismissed-set read entirely when no asset qualifies", async () => {
    await reconcileDuplicateReservationConflicts();
    expect(db.conflictFindMany).toHaveBeenCalledTimes(1);
  });
});

// ─── keepOneReservation ─────────────────────────────────────────────────────

describe("keepOneReservation", () => {
  const set = [held("r1"), held("r2", { gate: "FGT-B" }), held("r3", { kind: "lease", sourceType: "dhcp_lease" })];

  it("refuses (400) a reservation that is not in the conflict's set, releasing nothing", async () => {
    const err = await keepOneReservation(conflict(set), "r9", "alice", () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(400);
    expect(m.releaseReservation).not.toHaveBeenCalled();
  });

  it("releases every other still-active binding, accepts the conflict, and logs conflict.accepted", async () => {
    db.resFindMany.mockResolvedValue([{ id: "r2", createdBy: null, ipAddress: "10.1.0.2" }, { id: "r3", createdBy: "bob", ipAddress: "10.1.0.3" }]);
    const out = await keepOneReservation(conflict(set), "r1", "alice", () => {});
    expect(out).toEqual({ kept: "r1", released: ["r2", "r3"], failed: [] });
    expect(db.resFindMany.mock.calls[0][0].where).toEqual({ id: { in: ["r2", "r3"] }, status: "active" });
    expect(m.releaseReservation.mock.calls).toEqual([["r2", "alice"], ["r3", "alice"]]);
    expect(db.conflictUpdate).toHaveBeenCalledWith({
      where: { id: "c1" }, data: { status: "accepted", resolvedBy: "alice", resolvedAt: expect.any(Date) },
    });
    expect(eventLog.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "conflict.accepted", level: "info", resourceId: "a1", resourceName: "laptop-1", actor: "alice",
      message: `Duplicate DHCP bindings on "laptop-1": kept the reservation 10.1.0.1 on FGT-A, released 2`,
      details: { collisionReason: "duplicate-reservation", kept: "r1", released: ["r2", "r3"], failed: [] },
    }));
  });

  it("runs the ownership check on every row before releasing any — a refusal releases nothing", async () => {
    db.resFindMany.mockResolvedValue([{ id: "r2", createdBy: null, ipAddress: null }, { id: "r3", createdBy: "bob", ipAddress: null }]);
    const mayRelease = vi.fn((row: { createdBy: string | null }) => {
      if (row.createdBy === "bob") throw new AppError(403, "you can only release reservations you created");
    });
    await expect(keepOneReservation(conflict(set), "r1", "alice", mayRelease)).rejects.toMatchObject({ httpStatus: 403 });
    expect(mayRelease).toHaveBeenCalledTimes(2);
    expect(m.releaseReservation).not.toHaveBeenCalled();
    expect(db.conflictUpdate).not.toHaveBeenCalled();
  });

  it("leaves the conflict open on a partial failure and logs conflict.resolve_failed at warning", async () => {
    db.resFindMany.mockResolvedValue([{ id: "r2", createdBy: null, ipAddress: null }, { id: "r3", createdBy: null, ipAddress: null }]);
    m.releaseReservation.mockImplementation(async (id: string) => { if (id === "r3") throw new Error("gate unreachable"); });
    const out = await keepOneReservation(conflict(set), "r1", "alice", () => {});
    expect(out).toEqual({ kept: "r1", released: ["r2"], failed: [{ reservationId: "r3", error: "gate unreachable" }] });
    expect(db.conflictUpdate).not.toHaveBeenCalled();
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "conflict.resolve_failed", level: "warning",
      message: `Duplicate DHCP bindings on "laptop-1": kept the reservation 10.1.0.1 on FGT-A, released 1, 1 failed — the conflict stays open`,
    });
  });

  it("records a non-Error rejection as its string", async () => {
    db.resFindMany.mockResolvedValue([{ id: "r2", createdBy: null, ipAddress: null }]);
    m.releaseReservation.mockRejectedValue("nope");
    const out = await keepOneReservation(conflict(set), "r1", undefined, () => {});
    expect(out.failed).toEqual([{ reservationId: "r2", error: "nope" }]);
  });

  it("accepts at once when the others are already gone, resolvedBy 'unknown' without an actor", async () => {
    db.resFindMany.mockResolvedValue([]);
    const out = await keepOneReservation(conflict(set), "r3", undefined, () => {});
    expect(out.released).toEqual([]);
    expect(db.conflictUpdate.mock.calls[0][0].data).toMatchObject({ status: "accepted", resolvedBy: "unknown" });
    expect(eventLog.logEvent.mock.calls[0][0].message).toBe(`Duplicate DHCP bindings on "laptop-1": kept the lease 10.1.0.3 on FGT-A, released 0`);
  });

  it("refuses everything for a conflict whose blob holds no set", async () => {
    await expect(keepOneReservation({ id: "c1", assetId: "a1", proposedAssetFields: null }, "r1", "alice", () => {}))
      .rejects.toMatchObject({ httpStatus: 400 });
  });
});

// ─── releaseOneReservation ──────────────────────────────────────────────────

describe("releaseOneReservation", () => {
  it("refuses (400) a reservation outside the set", async () => {
    await expect(releaseOneReservation(conflict([held("r1"), held("r2")]), "r9", "alice", () => {}))
      .rejects.toMatchObject({ name: "AppError", httpStatus: 400 });
  });

  it.each([null, { status: "released", createdBy: null }])("refuses (409) a reservation that is no longer active (%o)", async (row) => {
    db.resFindUnique.mockResolvedValue(row);
    await expect(releaseOneReservation(conflict([held("r1"), held("r2")]), "r1", "alice", () => {}))
      .rejects.toMatchObject({ httpStatus: 409, message: "That reservation is no longer active" });
    expect(m.releaseReservation).not.toHaveBeenCalled();
  });

  it("runs the ownership check before releasing", async () => {
    db.resFindUnique.mockResolvedValue({ status: "active", createdBy: "bob" });
    const mayRelease = vi.fn(() => { throw new AppError(403, "no"); });
    await expect(releaseOneReservation(conflict([held("r1"), held("r2")]), "r1", "alice", mayRelease)).rejects.toMatchObject({ httpStatus: 403 });
    expect(mayRelease).toHaveBeenCalledWith({ status: "active", createdBy: "bob" });
    expect(m.releaseReservation).not.toHaveBeenCalled();
  });

  it("resolves the conflict when what is left no longer conflicts", async () => {
    db.resFindUnique.mockResolvedValue({ status: "active", createdBy: null });
    db.resFindMany.mockResolvedValue([{ id: "r2" }]);
    const out = await releaseOneReservation(conflict([held("r1"), held("r2")]), "r1", "alice", () => {});
    expect(out).toEqual({ released: "r1", resolved: true, remaining: 1 });
    expect(m.releaseReservation).toHaveBeenCalledWith("r1", "alice");
    expect(db.conflictUpdate).toHaveBeenCalledWith({
      where: { id: "c1" }, data: { status: "accepted", resolvedBy: "alice", resolvedAt: expect.any(Date) },
    });
    expect(eventLog.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "conflict.accepted", resourceName: "laptop-1",
      message: `Duplicate DHCP bindings on "laptop-1": released the reservation 10.1.0.1 on FGT-A — resolved`,
      details: { collisionReason: "duplicate-reservation", reservationId: "r1", kind: "reservation", resolved: true },
    }));
  });

  it("keeps it pending with the released row dropped while two bindings with a reservation remain", async () => {
    const set = [held("r1", { kind: "lease" }), held("r2"), held("r3", { kind: "lease" })];
    db.resFindUnique.mockResolvedValue({ status: "active", createdBy: null });
    db.resFindMany.mockResolvedValue([{ id: "r2" }, { id: "r3" }]);
    const out = await releaseOneReservation(conflict(set), "r1", "alice", () => {});
    expect(out).toEqual({ released: "r1", resolved: false, remaining: 2 });
    const data = db.conflictUpdate.mock.calls[0][0].data;
    expect(data.status).toBeUndefined();
    expect(data.proposedAssetFields).toMatchObject({ collisionReason: "duplicate-reservation", hostname: "laptop-1" });
    expect(data.proposedAssetFields.reservations.map((r: HeldReservation) => r.reservationId)).toEqual(["r2", "r3"]);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "conflict.updated",
      message: `Duplicate DHCP bindings on "laptop-1": revoked the lease 10.1.0.1 on FGT-A — 2 still held`,
    });
  });

  it("revoking the reservation and leaving two leases resolves it", async () => {
    const set = [held("r1"), held("r2", { kind: "lease" }), held("r3", { kind: "lease" })];
    db.resFindUnique.mockResolvedValue({ status: "active", createdBy: null });
    db.resFindMany.mockResolvedValue([{ id: "r2" }, { id: "r3" }]);
    expect((await releaseOneReservation(conflict(set), "r1", "alice", () => {})).resolved).toBe(true);
  });

  it("propagates a failed release without touching the conflict", async () => {
    db.resFindUnique.mockResolvedValue({ status: "active", createdBy: null });
    m.releaseReservation.mockRejectedValue(new AppError(502, "gate said no"));
    await expect(releaseOneReservation(conflict([held("r1"), held("r2")]), "r1", "alice", () => {})).rejects.toMatchObject({ httpStatus: 502 });
    expect(db.conflictUpdate).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("treats a stored binding with no kind as a reservation (legacy blob)", async () => {
    const legacy = [{ ...held("r1"), kind: undefined }, { ...held("r2"), kind: undefined }] as unknown as HeldReservation[];
    db.resFindUnique.mockResolvedValue({ status: "active", createdBy: null });
    db.resFindMany.mockResolvedValue([{ id: "r2" }]);
    await releaseOneReservation(conflict(legacy), "r1", undefined, () => {});
    expect(eventLog.logEvent.mock.calls[0][0].details).toMatchObject({ kind: "reservation" });
    expect(db.conflictUpdate.mock.calls[0][0].data.resolvedBy).toBe("unknown");
  });
});

// ─── dismissal + scan-failure loggers ───────────────────────────────────────

describe("logDuplicateReservationDismissal / logScanFailure", () => {
  it("logs the dismissal with the binding count and the promise not to re-raise", () => {
    logDuplicateReservationDismissal(conflict([held("r1"), held("r2"), held("r3")]), "alice");
    expect(eventLog.logEvent).toHaveBeenCalledWith({
      action: "conflict.rejected", resourceType: "asset", resourceId: "a1", resourceName: "laptop-1", actor: "alice",
      message: `Duplicate DHCP reservation conflict dismissed — the asset keeps all 3 bindings; the same set will not re-raise ("laptop-1")`,
      details: { collisionReason: "duplicate-reservation" },
    });
  });

  it("names a dismissal without hostname or asset as empty", () => {
    logDuplicateReservationDismissal({ assetId: null, proposedAssetFields: null });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ resourceId: undefined, resourceName: "" });
    expect(eventLog.logEvent.mock.calls[0][0].message).toContain("keeps all 0 bindings");
  });

  it("logScanFailure logs at error with the cause", () => {
    const err = new Error("db down");
    logScanFailure(err);
    expect(m.error).toHaveBeenCalledWith({ err }, "duplicate-reservation conflict reconcile failed");
  });
});
