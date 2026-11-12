/**
 * tests/integration/subnetArchive.test.ts
 *
 * The subnet archive and the chassis-replacement conflict (business rule 41),
 * against a real Postgres. Skips cleanly when DATABASE_URL isn't reachable;
 * see tests/integration/_helpers.ts.
 *
 * The one assertion this file exists for is FREES THE CIDR. Everything else in
 * the feature is downstream of it: a retired subnet used to stay in `subnets`
 * as `status="deprecated"`, still holding `@@unique([blockId, cidr])`, so a
 * replacement gate serving the same address space could never be recorded —
 * discovery's lookup index skips deprecated rows (no update path) while
 * `createSubnetRowChecked`'s overlap check counts them (no create path), and
 * the subnet was skipped on every run with a self-overlap message. The
 * "a deprecated row still blocks it" test below pins the old behaviour so the
 * archive's reason for existing stays visible.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import {
  snapshotSubnet,
  archiveSubnet,
  getArchivedSubnet,
  listArchivedSubnets,
  deleteArchivedSubnet,
} from "../../src/services/subnetArchiveService.js";
import {
  raiseChassisReplacedConflict,
  acceptChassisReplacement,
  buildChassisDiff,
  migrateArchivedReservations,
} from "../../src/services/subnetChassisConflictService.js";
import { createSubnetRowChecked } from "../../src/services/subnetService.js";

const d = dbDescribe;

// Synthetic serials — never paste real fleet serials into tests.
const OLD_SN = "FGT60FTK00000001";
const NEW_SN = "FGT81FTK00000002";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.conflict.deleteMany();
  await prisma.archivedSubnet.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.subnet.deleteMany();
  await prisma.ipBlock.deleteMany();
  await prisma.integration.deleteMany();
  await prisma.event.deleteMany({ where: { action: { startsWith: "subnet.chassis" } } });
});

async function seed(opts: { cidr?: string; serial?: string | null } = {}) {
  const cidr = opts.cidr ?? "10.77.1.0/24";
  const block = await prisma.ipBlock.create({
    data: { name: "Archive Test Block", cidr: "10.77.0.0/16", ipVersion: "v4" },
  });
  const subnet = await prisma.subnet.create({
    data: {
      blockId: block.id,
      cidr,
      name: "DHCP: lan (gate-a)",
      status: "available",
      fortigateDevice: "gate-a",
      fortigateSerial: opts.serial === undefined ? OLD_SN : opts.serial,
    },
  });
  await prisma.reservation.createMany({
    data: [
      { subnetId: subnet.id, ipAddress: "10.77.1.10", hostname: "printer", sourceType: "manual", status: "active" },
      { subnetId: subnet.id, ipAddress: "10.77.1.11", hostname: "cam", sourceType: "dhcp_reservation", status: "active" },
      { subnetId: subnet.id, ipAddress: "10.77.1.1", hostname: "gw", sourceType: "interface_ip", status: "active" },
    ],
  });
  return { block, subnet };
}

d("subnet archive — snapshot", () => {
  it("copies the subnet and every reservation, leaving the live rows alone", async () => {
    const { subnet } = await seed();

    const snap = await snapshotSubnet(subnet.id, { reason: "chassis-replaced", actor: "tester" });
    expect(snap.reservationCount).toBe(3);

    const archived = await getArchivedSubnet(snap.archivedSubnetId);
    expect(archived.cidr).toBe("10.77.1.0/24");
    expect(archived.fortigateSerial).toBe(OLD_SN);
    expect(archived.archiveReason).toBe("chassis-replaced");
    expect(archived.reservations).toHaveLength(3);
    // Block identity is denormalized so the archive survives a block deletion.
    expect(archived.blockCidr).toBe("10.77.0.0/16");

    // Additive: nothing was removed.
    expect(await prisma.subnet.count({ where: { id: subnet.id } })).toBe(1);
    expect(await prisma.reservation.count({ where: { subnetId: subnet.id } })).toBe(3);
  });

  it("does not carry the device-side push pointers forward", async () => {
    // They address a DHCP entry in a scope on a chassis that no longer exists.
    const { subnet } = await seed();
    const snap = await snapshotSubnet(subnet.id, { reason: "operator", actor: null });
    const archived = await getArchivedSubnet(snap.archivedSubnetId);
    for (const r of archived.reservations) {
      expect(r).not.toHaveProperty("pushedScopeId");
      expect(r).not.toHaveProperty("pushedEntryId");
    }
  });
});

d("subnet archive — retire", () => {
  it("a DEPRECATED row still blocks its CIDR — the reason the archive exists", async () => {
    const { block, subnet } = await seed();
    await prisma.subnet.update({ where: { id: subnet.id }, data: { status: "deprecated" } });

    await expect(
      createSubnetRowChecked({
        blockId: block.id,
        cidr: "10.77.1.0/24",
        name: "DHCP: lan (gate-b)",
        status: "available",
      }),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("archiving frees the CIDR so a replacement gate's subnet can be created", async () => {
    const { block, subnet } = await seed();

    const result = await archiveSubnet(subnet.id, { actor: "tester" });
    expect(result.reservationCount).toBe(3);

    // Live rows gone, archive intact.
    expect(await prisma.subnet.count({ where: { id: subnet.id } })).toBe(0);
    expect(await prisma.reservation.count({ where: { subnetId: subnet.id } })).toBe(0);
    const archived = await getArchivedSubnet(result.archivedSubnetId);
    expect(archived.reservations).toHaveLength(3);

    // The whole point.
    const fresh = await createSubnetRowChecked({
      blockId: block.id,
      cidr: "10.77.1.0/24",
      name: "DHCP: lan (gate-b)",
      status: "available",
      fortigateDevice: "gate-b",
      fortigateSerial: NEW_SN,
    });
    expect(fresh.cidr).toBe("10.77.1.0/24");
    expect(fresh.fortigateSerial).toBe(NEW_SN);
  });

  it("archived rows survive deletion of the block they came from", async () => {
    // No FK out to ip_blocks, deliberately: subnets cascade from blocks, so an
    // FK would let a block deletion erase the archive.
    const { block, subnet } = await seed();
    const snap = await snapshotSubnet(subnet.id, { reason: "operator", actor: null });

    await prisma.reservation.deleteMany({ where: { subnetId: subnet.id } });
    await prisma.ipBlock.delete({ where: { id: block.id } });

    const archived = await getArchivedSubnet(snap.archivedSubnetId);
    expect(archived.cidr).toBe("10.77.1.0/24");
    expect(archived.blockCidr).toBe("10.77.0.0/16");
  });

  it("lists newest first with an unpaged total", async () => {
    const { subnet } = await seed();
    await archiveSubnet(subnet.id, { actor: "tester" });
    const listed = await listArchivedSubnets({ limit: 10 });
    expect(listed.total).toBe(1);
    expect(listed.archivedSubnets[0]!.cidr).toBe("10.77.1.0/24");
  });
});

d("subnet archive — delete (rule 158(d))", () => {
  it("removes the entry and the reservations archived with it, and says so in Events", async () => {
    const { subnet } = await seed();
    const snap = await archiveSubnet(subnet.id, { actor: "tester" });
    await prisma.event.deleteMany({ where: { action: "subnet.archive_deleted" } });

    const res = await deleteArchivedSubnet(snap.archivedSubnetId, { actor: "tester" });
    expect(res).toEqual({ cidr: "10.77.1.0/24", reservationCount: 3 });
    expect(await prisma.archivedSubnet.count()).toBe(0);
    expect(await prisma.archivedReservation.count()).toBe(0);

    let ev = null;
    for (let i = 0; i < 40 && !ev; i++) {
      ev = await prisma.event.findFirst({ where: { action: "subnet.archive_deleted", resourceId: snap.archivedSubnetId } });
      if (!ev) await new Promise((r) => setTimeout(r, 50));
    }
    expect(ev).toMatchObject({ level: "warning", actor: "tester", resourceName: "10.77.1.0/24" });
  });

  it("is a 404 for an entry that is not there", async () => {
    await expect(deleteArchivedSubnet("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("is refused while a PENDING chassis-replacement conflict still reads the entry, and allowed once it is resolved", async () => {
    const { block, subnet } = await seed();
    const snap = await snapshotSubnet(subnet.id, { reason: "chassis-replaced" });
    const conflict = await prisma.conflict.create({
      data: {
        entityType: "subnet",
        subnetId: subnet.id,
        status: "pending",
        proposedSubnetFields: { collisionReason: "chassis-replaced", cidr: subnet.cidr, blockId: block.id, oldSerial: OLD_SN, newSerial: NEW_SN, archivedSubnetId: snap.archivedSubnetId },
      } as never,
    });
    await expect(deleteArchivedSubnet(snap.archivedSubnetId)).rejects.toMatchObject({ httpStatus: 409 });
    expect(await prisma.archivedSubnet.count()).toBe(1);

    await prisma.conflict.update({ where: { id: conflict.id }, data: { status: "rejected" } });
    await deleteArchivedSubnet(snap.archivedSubnetId);
    expect(await prisma.archivedSubnet.count()).toBe(0);
  });

  it("another entry's pending conflict does not hold this one", async () => {
    const { subnet } = await seed();
    const a = await snapshotSubnet(subnet.id, { reason: "operator" });
    const b = await snapshotSubnet(subnet.id, { reason: "operator" });
    await prisma.conflict.create({
      data: { entityType: "subnet", subnetId: subnet.id, status: "pending", proposedSubnetFields: { collisionReason: "chassis-replaced", archivedSubnetId: a.archivedSubnetId } } as never,
    });
    await deleteArchivedSubnet(b.archivedSubnetId);
    expect((await prisma.archivedSubnet.findMany()).map((r) => r.id)).toEqual([a.archivedSubnetId]);
  });
});

d("chassis-replacement conflict", () => {
  async function raise(subnetId: string, blockId: string, from = OLD_SN, to = NEW_SN) {
    const snap = await snapshotSubnet(subnetId, { reason: "chassis-replaced", actor: null });
    return raiseChassisReplacedConflict({
      subnetId,
      cidr: "10.77.1.0/24",
      blockId,
      oldSerial: from,
      newSerial: to,
      oldDeviceName: "gate-a",
      newDeviceName: "gate-a",
      archivedSubnetId: snap.archivedSubnetId,
    });
  }

  it("raises one pending conflict carrying the serial pair", async () => {
    const { block, subnet } = await seed();
    expect(await raise(subnet.id, block.id)).toBe("raised");

    const rows = await prisma.conflict.findMany({ where: { entityType: "subnet" } });
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.proposedSubnetFields as any;
    expect(payload.collisionReason).toBe("chassis-replaced");
    expect(payload.oldSerial).toBe(OLD_SN);
    expect(payload.newSerial).toBe(NEW_SN);
  });

  it("refreshes rather than stacking duplicates on a later run", async () => {
    const { block, subnet } = await seed();
    await raise(subnet.id, block.id);
    expect(await raise(subnet.id, block.id)).toBe("refreshed");
    expect(await prisma.conflict.count({ where: { entityType: "subnet" } })).toBe(1);
  });

  it("a rejected pair never re-raises, but a different pair does", async () => {
    const { block, subnet } = await seed();
    await raise(subnet.id, block.id);
    await prisma.conflict.updateMany({ where: { entityType: "subnet" }, data: { status: "rejected" } });

    expect(await raise(subnet.id, block.id)).toBe("suppressed");
    // Swapped a second time — a genuinely new transition.
    expect(await raise(subnet.id, block.id, OLD_SN, "FGT81FTK00000003")).toBe("raised");
  });

  it("refuses to raise when the serials are equal or blank", async () => {
    const { block, subnet } = await seed();
    const snap = await snapshotSubnet(subnet.id, { reason: "chassis-replaced", actor: null });
    const base = {
      subnetId: subnet.id, cidr: "10.77.1.0/24", blockId: block.id,
      archivedSubnetId: snap.archivedSubnetId,
    };
    expect(await raiseChassisReplacedConflict({ ...base, oldSerial: OLD_SN, newSerial: OLD_SN })).toBe("suppressed");
    expect(await raiseChassisReplacedConflict({ ...base, oldSerial: "", newSerial: NEW_SN })).toBe("suppressed");
  });

  it("the diff reads the archive against the live subnet, and refuses device-owned lines", async () => {
    const { block, subnet } = await seed();
    await raise(subnet.id, block.id);

    // The new gate reports one of the old addresses and one of its own.
    await prisma.reservation.deleteMany({ where: { subnetId: subnet.id } });
    await prisma.reservation.createMany({
      data: [
        { subnetId: subnet.id, ipAddress: "10.77.1.10", hostname: "printer", sourceType: "manual", status: "active" },
        { subnetId: subnet.id, ipAddress: "10.77.1.99", hostname: "new-host", sourceType: "dhcp_lease", status: "active" },
      ],
    });

    const conflict = await prisma.conflict.findFirstOrThrow({ where: { entityType: "subnet" } });
    const { lines } = await buildChassisDiff(conflict);

    const byIp = new Map(lines.map((l) => [l.ip, l]));
    expect(byIp.get("10.77.1.10")).toMatchObject({ verdict: "same", migratable: true });
    expect(byIp.get("10.77.1.11")).toMatchObject({ verdict: "only-old", migratable: true });
    expect(byIp.get("10.77.1.99")).toMatchObject({ verdict: "only-new", migratable: false });
    // The gateway interface address is the new box's own config to state.
    expect(byIp.get("10.77.1.1")).toMatchObject({
      verdict: "only-old",
      migratable: false,
      notMigratableReason: "device-owned",
    });
  });

  it("accepting stamps the new serial so the next run sees no change", async () => {
    const { block, subnet } = await seed();
    await raise(subnet.id, block.id);
    const conflict = await prisma.conflict.findFirstOrThrow({ where: { entityType: "subnet" } });

    await acceptChassisReplacement(conflict, "tester");

    const after = await prisma.subnet.findUniqueOrThrow({ where: { id: subnet.id } });
    expect(after.fortigateSerial).toBe(NEW_SN);
  });

  it("leaves the stored serial alone while the conflict is pending", async () => {
    // The pending conflict IS the unresolved state; the stored serial is what
    // keeps the detection derivable from the subnet row itself.
    const { block, subnet } = await seed();
    await raise(subnet.id, block.id);
    const after = await prisma.subnet.findUniqueOrThrow({ where: { id: subnet.id } });
    expect(after.fortigateSerial).toBe(OLD_SN);
  });
});

d("chassis-replacement — migrating reservations onto the new gate", () => {
  /** Raise a conflict, then replace the live rows with what the new gate reports. */
  async function replaced(opts: { push?: boolean } = {}) {
    const { block, subnet } = await seed();
    const snap = await snapshotSubnet(subnet.id, { reason: "chassis-replaced", actor: null });
    await raiseChassisReplacedConflict({
      subnetId: subnet.id,
      cidr: "10.77.1.0/24",
      blockId: block.id,
      oldSerial: OLD_SN,
      newSerial: NEW_SN,
      archivedSubnetId: snap.archivedSubnetId,
    });

    if (opts.push) {
      const integration = await prisma.integration.create({
        data: {
          name: "Test FMG",
          type: "fortimanager",
          config: { host: "fmg.invalid", pushReservations: true },
        },
      });
      await prisma.subnet.update({
        where: { id: subnet.id },
        data: { discoveredBy: integration.id },
      });
    }

    // The new gate knows about one of the old addresses (with a different
    // hostname) and nothing else.
    await prisma.reservation.deleteMany({ where: { subnetId: subnet.id } });
    await prisma.reservation.create({
      data: {
        subnetId: subnet.id, ipAddress: "10.77.1.10", hostname: "whatever-the-new-box-says",
        sourceType: "dhcp_lease", status: "active",
      },
    });

    const conflict = await prisma.conflict.findFirstOrThrow({ where: { entityType: "subnet" } });
    return { block, subnet, conflict };
  }

  it("creates an only-old line and updates a colliding one in place", async () => {
    const { subnet, conflict } = await replaced();

    const out = await migrateArchivedReservations(conflict, ["10.77.1.10", "10.77.1.11"], {
      actor: "tester",
    });
    expect(out).toMatchObject({ created: 1, updated: 1 });

    const rows = await prisma.reservation.findMany({
      where: { subnetId: subnet.id }, orderBy: { ipAddress: "asc" },
    });
    const byIp = new Map(rows.map((r) => [r.ipAddress, r]));
    // .10 existed, so it was updated in place — an insert would have violated
    // the unique index on (subnetId, ipAddress, status).
    expect(byIp.get("10.77.1.10")).toMatchObject({ hostname: "printer", sourceType: "manual" });
    expect(byIp.get("10.77.1.11")).toMatchObject({ hostname: "cam", sourceType: "manual" });
  });

  it("lands every migrated row as manual with no DHCP binding claim", async () => {
    // Only a manual row is pushable, and with push off the claim is Polaris's
    // alone — which manual + dhcpBinding null states exactly (rule 23's split).
    const { subnet, conflict } = await replaced();
    await migrateArchivedReservations(conflict, ["10.77.1.11"], { actor: "tester" });
    const row = await prisma.reservation.findFirstOrThrow({
      where: { subnetId: subnet.id, ipAddress: "10.77.1.11" },
    });
    expect(row.sourceType).toBe("manual");
    expect(row.dhcpBinding).toBeNull();
  });

  it("does not queue a push when the integration has DHCP push off", async () => {
    const { subnet, conflict } = await replaced();
    const out = await migrateArchivedReservations(conflict, ["10.77.1.11"], { actor: "tester" });
    expect(out.queuedForPush).toBe(0);
    const row = await prisma.reservation.findFirstOrThrow({
      where: { subnetId: subnet.id, ipAddress: "10.77.1.11" },
    });
    expect(row.pushStatus).toBeNull();
    expect(row.pushQueuedAt).toBeNull();
  });

  it("QUEUES rather than pushing inline when DHCP push is on", async () => {
    // A brand-new gate is exactly the device most likely to be briefly
    // unreachable; the operator's migrate must not fail on that.
    const { subnet, conflict } = await replaced({ push: true });
    const out = await migrateArchivedReservations(conflict, ["10.77.1.11"], { actor: "tester" });
    expect(out.queuedForPush).toBe(1);
    const row = await prisma.reservation.findFirstOrThrow({
      where: { subnetId: subnet.id, ipAddress: "10.77.1.11" },
    });
    expect(row.pushStatus).toBe("pending");
    expect(row.pushQueuedAt).not.toBeNull();
    // Never the dead chassis's pointers.
    expect(row.pushedScopeId).toBeNull();
    expect(row.pushedEntryId).toBeNull();
  });

  it("refuses the non-migratable source types, with a reason each", async () => {
    const { conflict } = await replaced();
    // 10.77.1.1 is the old gate's interface address.
    const out = await migrateArchivedReservations(conflict, ["10.77.1.1", "10.77.1.11"], {
      actor: "tester",
    });
    expect(out.created).toBe(1);
    expect(out.skipped).toEqual([{ ip: "10.77.1.1", reason: "device-owned" }]);
  });

  it("skips an address the archive never held", async () => {
    const { conflict } = await replaced();
    const out = await migrateArchivedReservations(conflict, ["10.77.1.222"], { actor: "tester" });
    expect(out).toMatchObject({ created: 0, updated: 0 });
    expect(out.skipped).toEqual([{ ip: "10.77.1.222", reason: "not-in-archive" }]);
  });

  it("refuses an empty selection", async () => {
    const { conflict } = await replaced();
    await expect(migrateArchivedReservations(conflict, [], {})).rejects.toMatchObject({
      httpStatus: 400,
    });
  });

  it("leaves the conflict OPEN so an operator can migrate in passes", async () => {
    const { conflict } = await replaced();
    await migrateArchivedReservations(conflict, ["10.77.1.11"], { actor: "tester" });
    const after = await prisma.conflict.findUniqueOrThrow({ where: { id: conflict.id } });
    expect(after.status).toBe("pending");
  });

  it("writes ONE Event for the batch, naming every address", async () => {
    const { conflict } = await replaced();
    await migrateArchivedReservations(conflict, ["10.77.1.10", "10.77.1.11"], { actor: "tester" });
    // logEvent is fire-and-forget; give it a tick to land.
    await new Promise((r) => setTimeout(r, 250));
    const events = await prisma.event.findMany({
      where: { action: "subnet.chassis.reservations_migrated" },
    });
    expect(events).toHaveLength(1);
    expect((events[0]!.details as any).ips).toEqual(["10.77.1.10", "10.77.1.11"]);
  });
});
