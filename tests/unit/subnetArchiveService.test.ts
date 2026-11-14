/**
 * tests/unit/subnetArchiveService.test.ts — the own suite for
 * src/services/subnetArchiveService.ts (business rules 41 and 158(d), CQ-T010).
 *
 * Complements tests/integration/subnetArchive.test.ts (a deprecated row still
 * 409s a same-CIDR create; archiving frees it) and
 * tests/integration/subnetSupersedeDeprecated.test.ts (the discovery wiring).
 *
 * Adds, on the shared db stub: the snapshot's denormalised block / integration
 * identity (and its fallbacks when the block or integration is gone), the
 * explicit column copy that never carries a push POINTER, the 500-row
 * createMany chunks, the transaction client threaded through, snapshot staying
 * additive (no delete), archive = snapshot + delete in ONE transaction with the
 * `subnet.archived` Event after it, the 404s, the delete's 409 while a pending
 * chassis conflict reads the entry, and the list's paging clamps.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import {
  snapshotSubnet,
  archiveSubnet,
  getArchivedSubnet,
  deleteArchivedSubnet,
  listArchivedSubnets,
} from "../../src/services/subnetArchiveService.js";

const db = prisma as any;

const CREATED = new Date("2026-01-01T00:00:00Z");
const UPDATED = new Date("2026-02-01T00:00:00Z");

function subnetRow(over: Record<string, unknown> = {}) {
  return {
    id: "s1", blockId: "b1", cidr: "10.1.0.0/24", name: "DHCP: lan (FW-A)", purpose: "p", status: "available",
    vlan: 10, tags: ["dhcp-discovered"], discoveredBy: "int-1", fortigateDevice: "FW-A", fortigateSerial: "FGT1",
    createdBy: "alice", lastDiscoveredAt: UPDATED, createdAt: CREATED, updatedAt: UPDATED,
    block: { cidr: "10.0.0.0/8", name: "Corp" }, integration: { name: "FMG" },
    ...over,
  };
}

function resRow(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `r${i}`, ipAddress: `10.1.0.${i}`, hostname: `h${i}`, owner: null, projectRef: null, expiresAt: null,
    notes: null, status: "active", sourceType: "dhcp_reservation", createdBy: "disc", macAddress: "aa:bb:cc:00:00:01",
    dhcpBinding: null, vipInfo: null, pushStatus: "synced", pushedAt: UPDATED, lastSeenLeased: null, lastSeenArp: null,
    createdAt: CREATED, updatedAt: UPDATED,
    ...over,
  };
}

async function expectAppError(p: Promise<unknown>, status: number, msg?: RegExp) {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).httpStatus).toBe(status);
  if (msg) expect((err as Error).message).toMatch(msg);
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  stubbed(db.archivedSubnet.create).mockResolvedValue({ id: "arch-1" });
  stubbed(db.reservation.findMany).mockResolvedValue([]);
  stubbed(db.archivedReservation.createMany).mockResolvedValue({ count: 0 });
});

describe("snapshotSubnet", () => {
  it("404s an unknown subnet and writes nothing", async () => {
    stubbed(db.subnet.findUnique).mockResolvedValue(null);
    await expectAppError(snapshotSubnet("nope", { reason: "operator" }), 404, /nope/);
    expect(db.archivedSubnet.create).not.toHaveBeenCalled();
  });

  it("copies the subnet with its block and integration identity denormalised", async () => {
    stubbed(db.subnet.findUnique).mockResolvedValue(subnetRow());
    const out = await snapshotSubnet("s1", { reason: "chassis-replaced", actor: "bob" });
    expect(out).toEqual({ archivedSubnetId: "arch-1", cidr: "10.1.0.0/24", reservationCount: 0 });
    const data = stubbed(db.archivedSubnet.create).mock.calls[0][0].data;
    expect(data).toMatchObject({
      originalSubnetId: "s1", blockId: "b1", blockCidr: "10.0.0.0/8", blockName: "Corp", cidr: "10.1.0.0/24",
      name: "DHCP: lan (FW-A)", purpose: "p", status: "available", vlan: 10, tags: ["dhcp-discovered"],
      discoveredBy: "int-1", integrationName: "FMG", fortigateDevice: "FW-A", fortigateSerial: "FGT1",
      createdBy: "alice", lastDiscoveredAt: UPDATED, originalCreatedAt: CREATED, originalUpdatedAt: UPDATED,
      archivedBy: "bob", archiveReason: "chassis-replaced",
    });
  });

  it("falls back to blank block identity, null integration name and null actor", async () => {
    stubbed(db.subnet.findUnique).mockResolvedValue(subnetRow({ block: null, integration: null }));
    await snapshotSubnet("s1", { reason: "operator" });
    const data = stubbed(db.archivedSubnet.create).mock.calls[0][0].data;
    expect(data.blockCidr).toBe("");
    expect(data.blockName).toBe("");
    expect(data.integrationName).toBeNull();
    expect(data.archivedBy).toBeNull();
  });

  it("copies reservations column by column and never carries a push pointer", async () => {
    stubbed(db.subnet.findUnique).mockResolvedValue(subnetRow());
    stubbed(db.reservation.findMany).mockResolvedValue([
      resRow(5, { vipInfo: { extip: "1.2.3.4" }, pushedScopeId: 3, pushedEntryId: 7, pushedToId: "int-1" }),
    ]);
    const out = await snapshotSubnet("s1", { reason: "operator" });
    expect(out.reservationCount).toBe(1);
    const q = stubbed(db.reservation.findMany).mock.calls[0][0];
    expect(q.where).toEqual({ subnetId: "s1" });
    expect(q.select.pushedScopeId).toBeUndefined();
    expect(q.select.pushedEntryId).toBeUndefined();
    expect(q.select.pushedToId).toBeUndefined();
    const row = stubbed(db.archivedReservation.createMany).mock.calls[0][0].data[0];
    expect(row).toMatchObject({
      archivedSubnetId: "arch-1", originalReservationId: "r5", ipAddress: "10.1.0.5", hostname: "h5",
      status: "active", sourceType: "dhcp_reservation", macAddress: "aa:bb:cc:00:00:01", vipInfo: { extip: "1.2.3.4" },
      pushStatus: "synced", pushedAt: UPDATED, originalCreatedAt: CREATED, originalUpdatedAt: UPDATED,
    });
    expect(row).not.toHaveProperty("pushedScopeId");
    expect(row).not.toHaveProperty("pushedEntryId");
    expect(row).not.toHaveProperty("pushedToId");
    expect(row).not.toHaveProperty("id");
  });

  it("maps a null vipInfo to undefined (Prisma's Json null rule)", async () => {
    stubbed(db.subnet.findUnique).mockResolvedValue(subnetRow());
    stubbed(db.reservation.findMany).mockResolvedValue([resRow(1)]);
    await snapshotSubnet("s1", { reason: "operator" });
    expect(stubbed(db.archivedReservation.createMany).mock.calls[0][0].data[0].vipInfo).toBeUndefined();
  });

  it("copies in 500-row createMany chunks, not per row", async () => {
    stubbed(db.subnet.findUnique).mockResolvedValue(subnetRow());
    stubbed(db.reservation.findMany).mockResolvedValue(Array.from({ length: 1201 }, (_, i) => resRow(i)));
    const out = await snapshotSubnet("s1", { reason: "operator" });
    expect(out.reservationCount).toBe(1201);
    const sizes = stubbed(db.archivedReservation.createMany).mock.calls.map((c) => c[0].data.length);
    expect(sizes).toEqual([500, 500, 201]);
  });

  it("issues no createMany for an empty subnet", async () => {
    stubbed(db.subnet.findUnique).mockResolvedValue(subnetRow());
    await snapshotSubnet("s1", { reason: "operator" });
    expect(db.archivedReservation.createMany).not.toHaveBeenCalled();
  });

  it("is additive: never deletes or updates a live row, and writes no Event", async () => {
    stubbed(db.subnet.findUnique).mockResolvedValue(subnetRow());
    stubbed(db.reservation.findMany).mockResolvedValue([resRow(1)]);
    await snapshotSubnet("s1", { reason: "chassis-replaced" });
    expect(db.subnet.delete).not.toHaveBeenCalled();
    expect(db.subnet.update).not.toHaveBeenCalled();
    expect(db.reservation.deleteMany).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("runs every read and write on the transaction client when one is passed", async () => {
    const tx = {
      subnet: { findUnique: vi.fn().mockResolvedValue(subnetRow()) },
      archivedSubnet: { create: vi.fn().mockResolvedValue({ id: "arch-tx" }) },
      reservation: { findMany: vi.fn().mockResolvedValue([resRow(1)]) },
      archivedReservation: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const out = await snapshotSubnet("s1", { reason: "operator" }, tx as any);
    expect(out.archivedSubnetId).toBe("arch-tx");
    expect(tx.archivedReservation.createMany).toHaveBeenCalledTimes(1);
    expect(db.subnet.findUnique).not.toHaveBeenCalled();
    expect(db.archivedSubnet.create).not.toHaveBeenCalled();
  });
});

describe("archiveSubnet", () => {
  it("snapshots then deletes the live subnet inside one transaction, then writes subnet.archived", async () => {
    stubbed(db.subnet.findUnique).mockResolvedValue(subnetRow());
    stubbed(db.reservation.findMany).mockResolvedValue([resRow(1), resRow(2)]);
    const out = await archiveSubnet("s1", { actor: "bob" });
    expect(out).toEqual({ archivedSubnetId: "arch-1", cidr: "10.1.0.0/24", reservationCount: 2 });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.subnet.delete).toHaveBeenCalledWith({ where: { id: "s1" } });
    expect(stubbed(db.archivedSubnet.create).mock.calls[0][0].data.archiveReason).toBe("operator");
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "subnet.archived", resourceType: "subnet", resourceId: "s1", resourceName: "10.1.0.0/24", actor: "bob",
      details: { archivedSubnetId: "arch-1", cidr: "10.1.0.0/24", reservationCount: 2, reason: "operator" },
    });
  });

  it("passes a chassis-replaced reason through and leaves actor undefined when absent", async () => {
    stubbed(db.subnet.findUnique).mockResolvedValue(subnetRow());
    await archiveSubnet("s1", { reason: "chassis-replaced" });
    expect(stubbed(db.archivedSubnet.create).mock.calls[0][0].data).toMatchObject({ archiveReason: "chassis-replaced", archivedBy: null });
    expect(eventLog.logEvent.mock.calls[0][0].actor).toBeUndefined();
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ details: { reason: "chassis-replaced" } });
  });

  it("404s an unknown subnet: nothing deleted, no Event", async () => {
    stubbed(db.subnet.findUnique).mockResolvedValue(null);
    await expectAppError(archiveSubnet("gone"), 404);
    expect(db.subnet.delete).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("writes no Event when the delete fails (the transaction rolls back)", async () => {
    stubbed(db.subnet.findUnique).mockResolvedValue(subnetRow());
    stubbed(db.subnet.delete).mockRejectedValue(new Error("boom"));
    await expect(archiveSubnet("s1")).rejects.toThrow("boom");
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("getArchivedSubnet", () => {
  it("returns the row with its reservations ordered by IP", async () => {
    stubbed(db.archivedSubnet.findUnique).mockResolvedValue({ id: "a1", reservations: [] });
    expect(await getArchivedSubnet("a1")).toEqual({ id: "a1", reservations: [] });
    expect(stubbed(db.archivedSubnet.findUnique).mock.calls[0][0]).toEqual({
      where: { id: "a1" }, include: { reservations: { orderBy: { ipAddress: "asc" } } },
    });
  });

  it("404s an unknown id", async () => {
    stubbed(db.archivedSubnet.findUnique).mockResolvedValue(null);
    await expectAppError(getArchivedSubnet("x"), 404, /x not found/);
  });
});

describe("deleteArchivedSubnet", () => {
  const archived = {
    id: "a1", cidr: "10.1.0.0/24", name: "n", blockCidr: "10.0.0.0/8", fortigateSerial: "FGT1",
    archivedAt: UPDATED, archiveReason: "operator", _count: { reservations: 4 },
  };

  it("404s an unknown entry", async () => {
    stubbed(db.archivedSubnet.findUnique).mockResolvedValue(null);
    await expectAppError(deleteArchivedSubnet("x"), 404);
    expect(db.archivedSubnet.delete).not.toHaveBeenCalled();
  });

  it("409s while a pending subnet conflict reads the entry", async () => {
    stubbed(db.archivedSubnet.findUnique).mockResolvedValue(archived);
    stubbed(db.conflict.findFirst).mockResolvedValue({ id: "c1" });
    await expectAppError(deleteArchivedSubnet("a1"), 409, /pending chassis-replacement conflict/);
    expect(stubbed(db.conflict.findFirst).mock.calls[0][0].where).toEqual({
      entityType: "subnet", status: "pending", proposedSubnetFields: { path: ["archivedSubnetId"], equals: "a1" },
    });
    expect(db.archivedSubnet.delete).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("deletes the entry and writes a warning-level subnet.archive_deleted Event", async () => {
    stubbed(db.archivedSubnet.findUnique).mockResolvedValue(archived);
    stubbed(db.conflict.findFirst).mockResolvedValue(null);
    const out = await deleteArchivedSubnet("a1", { actor: "carol" });
    expect(out).toEqual({ cidr: "10.1.0.0/24", reservationCount: 4 });
    expect(db.archivedSubnet.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "subnet.archive_deleted", resourceId: "a1", resourceName: "10.1.0.0/24", actor: "carol", level: "warning",
      details: { archivedSubnetId: "a1", reservationCount: 4, fortigateSerial: "FGT1", archiveReason: "operator" },
    });
  });

  it("leaves actor undefined when none is given", async () => {
    stubbed(db.archivedSubnet.findUnique).mockResolvedValue(archived);
    stubbed(db.conflict.findFirst).mockResolvedValue(null);
    await deleteArchivedSubnet("a1");
    expect(eventLog.logEvent.mock.calls[0][0].actor).toBeUndefined();
  });
});

describe("listArchivedSubnets", () => {
  beforeEach(() => {
    stubbed(db.archivedSubnet.findMany).mockResolvedValue([{ id: "a1" }]);
    stubbed(db.archivedSubnet.count).mockResolvedValue(7);
  });

  it("defaults to 50 newest-first with no filter, and reports the unpaged total", async () => {
    const out = await listArchivedSubnets();
    expect(out).toEqual({ archivedSubnets: [{ id: "a1" }], total: 7, limit: 50, offset: 0 });
    const q = stubbed(db.archivedSubnet.findMany).mock.calls[0][0];
    expect(q).toMatchObject({ where: {}, orderBy: { archivedAt: "desc" }, take: 50, skip: 0 });
    expect(stubbed(db.archivedSubnet.count).mock.calls[0][0]).toEqual({ where: {} });
  });

  it("applies every filter to both the page and the count", async () => {
    await listArchivedSubnets({ cidr: "10.1.", blockId: "b1", fortigateSerial: "FGT1" });
    const where = { cidr: { contains: "10.1." }, blockId: "b1", fortigateSerial: "FGT1" };
    expect(stubbed(db.archivedSubnet.findMany).mock.calls[0][0].where).toEqual(where);
    expect(stubbed(db.archivedSubnet.count).mock.calls[0][0]).toEqual({ where });
  });

  it("clamps limit to 1..200 and offset to >= 0", async () => {
    expect((await listArchivedSubnets({ limit: 1000, offset: -5 }))).toMatchObject({ limit: 200, offset: 0 });
    expect((await listArchivedSubnets({ limit: 0 }))).toMatchObject({ limit: 1 });
    expect((await listArchivedSubnets({ limit: 25, offset: 50 }))).toMatchObject({ limit: 25, offset: 50 });
    expect(stubbed(db.archivedSubnet.findMany).mock.calls[2][0]).toMatchObject({ take: 25, skip: 50 });
  });
});
