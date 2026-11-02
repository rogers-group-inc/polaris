/**
 * tests/integration/releasedAddressAndDuplicateReservations.test.ts
 *
 * Against a real database:
 *
 *  - Business rule 102(b): a DHCP binding released on the gate leaves the
 *    asset — its discovered rows at the address go, and an unpinned endpoint
 *    moves to its best remaining listed address, or to none. A pin, an
 *    interface-scrape row, and the same address behind another gate are left.
 *  - Business rule 139: an asset holding two DHCP reservations raises one
 *    `duplicate-reservation` conflict; the sweep is quiet on a re-run, keeps a
 *    dismissed set quiet, and POST /conflicts/:id/keep-reservation releases
 *    the others and resolves it.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable, ensureTestUser, authedAgent } from "./_helpers.js";
import { detachReleasedAddress } from "../../src/services/assetAddressService.js";
import {
  reconcileDuplicateReservationConflicts,
  DUPLICATE_RESERVATION_COLLISION_REASON,
} from "../../src/services/duplicateReservationConflictService.js";

const d = dbDescribe;
const PFX = "relaaddr-test";
const ETH = "AA:BB:CC:07:07:40";
const WIFI = "AA:BB:CC:07:07:41";
const GATE = "RELADDR-GW";
const OTHER_GATE = "RELADDR-GW2";
const BLOCK = "10.97.0.0/16";
const CIDR = "10.97.6.0/24";
const CIDR2 = "10.97.7.0/24";
let subnetId = "";
let subnet2Id = "";

const DUP_WHERE = {
  entityType: "asset",
  proposedAssetFields: { path: ["collisionReason"], equals: DUPLICATE_RESERVATION_COLLISION_REASON },
} as const;

async function cleanup(): Promise<void> {
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: PFX } }, select: { id: true } });
  await prisma.conflict.deleteMany({ where: { assetId: { in: assets.map((a) => a.id) } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.ipBlock.deleteMany({ where: { cidr: BLOCK } });
  await prisma.event.deleteMany({ where: { resourceName: { startsWith: PFX } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const block = await prisma.ipBlock.create({ data: { name: PFX, cidr: BLOCK, ipVersion: "v4" } });
  subnetId = (await prisma.subnet.create({ data: { blockId: block.id, cidr: CIDR, name: PFX, fortigateDevice: GATE } })).id;
  subnet2Id = (await prisma.subnet.create({ data: { blockId: block.id, cidr: CIDR2, name: PFX + "-2", fortigateDevice: GATE } })).id;
});

// Assets are created with their address set straight in the row and no
// subnet-matching write after, so rule 11's dns_resolved reservation never
// races the reservations these tests make (reservations first, assets second).
async function asset(name: string, ipAddress: string | null, over: Record<string, unknown> = {}) {
  return (await prisma.asset.create({
    data: {
      hostname: PFX + "-" + name, ipAddress, macAddress: ETH, assetType: "workstation", status: "active",
      macAddressRows: { create: [{ mac: ETH, source: "dhcp_reservation", lastSeen: new Date() }] },
      ...over,
    },
  })).id;
}
async function addr(assetId: string, ip: string, source: string, over: Record<string, unknown> = {}) {
  await prisma.assetAssociatedIp.create({
    data: { assetId, ip, source, mac: ETH, device: GATE, lastSeen: new Date(), firstSeen: new Date(), ...over },
  });
}
async function rowsOf(assetId: string) {
  return (await prisma.assetAssociatedIp.findMany({ where: { assetId }, select: { ip: true, source: true } }))
    .sort((a, b) => a.ip.localeCompare(b.ip) || a.source.localeCompare(b.source));
}
async function ipOf(assetId: string) {
  return (await prisma.asset.findUnique({ where: { id: assetId }, select: { ipAddress: true } }))?.ipAddress ?? null;
}

d("a released DHCP binding leaves the asset (business rule 102(b))", () => {
  it("drops the discovered rows at the address and moves the asset to its remaining listed address", async () => {
    const id = await asset("laptop", "10.97.6.10");
    await addr(id, "10.97.6.10", "dhcp-reservation");
    await addr(id, "10.97.6.44", "dhcp-lease");

    const out = await detachReleasedAddress({ ip: "10.97.6.10", gate: GATE, macAddress: ETH, actor: "tester" });

    expect(out).toMatchObject([{ assetId: id, removedRows: 1, movedTo: "10.97.6.44" }]);
    expect(await rowsOf(id)).toEqual([{ ip: "10.97.6.44", source: "dhcp-lease" }]);
    expect(await ipOf(id)).toBe("10.97.6.44");
    const ev = await prisma.event.findFirst({ where: { action: "asset.address_released", resourceId: id } });
    expect(ev?.actor).toBe("tester");
    expect(ev?.message).toContain("moved to 10.97.6.44");
  });

  it("clears the address when nothing else is listed, and keeps it in the IP history", async () => {
    const id = await asset("printer", "10.97.6.11");
    await addr(id, "10.97.6.11", "dhcp-reservation");
    // The asset write itself recorded the history row.
    expect(await prisma.assetIpHistory.count({ where: { assetId: id, ip: "10.97.6.11" } })).toBe(1);

    await detachReleasedAddress({ ip: "10.97.6.11", gate: GATE, macAddress: ETH });

    expect(await ipOf(id)).toBeNull();
    expect(await prisma.assetIpHistory.count({ where: { assetId: id, ip: "10.97.6.11" } })).toBe(1);
  });

  it("finds an asset with no address rows through its MAC", async () => {
    const id = await asset("norows", "10.97.6.12");
    await detachReleasedAddress({ ip: "10.97.6.12", gate: GATE, macAddress: ETH.toLowerCase() });
    expect(await ipOf(id)).toBeNull();
  });

  it("leaves a pinned address and one the device itself reports, but still drops the DHCP row", async () => {
    const pinned = await asset("pinned", "10.97.6.13", { ipOverride: "10.97.6.13" });
    await addr(pinned, "10.97.6.13", "dhcp-reservation");
    // One row per (asset, ip): the interface scrape owns this one, so the
    // device's own report is what the release meets.
    const scraped = await asset("scraped", "10.97.6.14", { macAddress: WIFI, macAddressRows: { create: [{ mac: WIFI, source: "monitor-interface" }] } });
    await addr(scraped, "10.97.6.14", "monitor-system-info", { mac: WIFI, device: null });

    await detachReleasedAddress({ ip: "10.97.6.13", gate: GATE, macAddress: ETH });
    await detachReleasedAddress({ ip: "10.97.6.14", gate: GATE, macAddress: WIFI });

    expect(await ipOf(pinned)).toBe("10.97.6.13");
    expect(await rowsOf(pinned)).toEqual([]);
    expect(await ipOf(scraped)).toBe("10.97.6.14");
    expect(await rowsOf(scraped)).toEqual([{ ip: "10.97.6.14", source: "monitor-system-info" }]);
  });

  it("does not touch the same address behind another gate", async () => {
    const id = await asset("elsewhere", "10.97.6.15", {
      macAddress: WIFI, learnedLocation: OTHER_GATE, macAddressRows: { create: [{ mac: WIFI, source: "dhcp_lease" }] },
    });
    await addr(id, "10.97.6.15", "dhcp-lease", { mac: WIFI, device: OTHER_GATE });

    expect(await detachReleasedAddress({ ip: "10.97.6.15", gate: GATE, macAddress: ETH })).toEqual([]);
    expect(await ipOf(id)).toBe("10.97.6.15");
    expect(await rowsOf(id)).toHaveLength(1);
  });
});

d("an asset holding two DHCP reservations is a conflict (business rule 139)", () => {
  async function twoReservations() {
    const a = await prisma.reservation.create({
      data: { subnetId, ipAddress: "10.97.6.20", macAddress: ETH, sourceType: "dhcp_reservation", status: "active", hostname: PFX + "-dup" },
    });
    const b = await prisma.reservation.create({
      data: { subnetId: subnet2Id, ipAddress: "10.97.7.20", macAddress: ETH.toLowerCase(), sourceType: "manual", pushStatus: "synced", status: "active", hostname: PFX + "-dup" },
    });
    const id = await asset("dup", "10.97.6.20");
    return { a: a.id, b: b.id, assetId: id };
  }

  it("raises one conflict, and a re-run changes nothing", async () => {
    const { a, b, assetId } = await twoReservations();
    const first = await reconcileDuplicateReservationConflicts();
    expect(first.raised).toBeGreaterThanOrEqual(1);
    const rows = await prisma.conflict.findMany({ where: { ...DUP_WHERE, assetId, status: "pending" } });
    expect(rows).toHaveLength(1);
    const held = (rows[0].proposedAssetFields as any).reservations as Array<{ reservationId: string; isPrimary: boolean }>;
    expect(held.map((r) => r.reservationId).sort()).toEqual([a, b].sort());
    expect(held.find((r) => r.reservationId === a)?.isPrimary).toBe(true);

    await reconcileDuplicateReservationConflicts();
    expect(await prisma.conflict.count({ where: { ...DUP_WHERE, assetId } })).toBe(1);
  });

  it("keeps a dismissed set quiet", async () => {
    const { assetId } = await twoReservations();
    await reconcileDuplicateReservationConflicts();
    await prisma.conflict.updateMany({
      where: { ...DUP_WHERE, assetId, status: "pending" },
      data: { status: "rejected", resolvedBy: "tester", resolvedAt: new Date() },
    });
    await reconcileDuplicateReservationConflicts();
    expect(await prisma.conflict.count({ where: { ...DUP_WHERE, assetId, status: "pending" } })).toBe(0);
  });

  it("keep-reservation releases the others and resolves the conflict; Accept is refused", async () => {
    const { a, b, assetId } = await twoReservations();
    await reconcileDuplicateReservationConflicts();
    const conflict = await prisma.conflict.findFirstOrThrow({ where: { ...DUP_WHERE, assetId, status: "pending" } });
    const { agent, csrf } = await authedAgent(app);

    const accept = await agent.post(`/api/v1/conflicts/${conflict.id}/accept`).set("X-CSRF-Token", csrf).send({});
    expect(accept.status).toBe(400);
    const bad = await agent.post(`/api/v1/conflicts/${conflict.id}/keep-reservation`).set("X-CSRF-Token", csrf).send({ reservationId: "nope" });
    expect(bad.status).toBe(400);

    const res = await agent.post(`/api/v1/conflicts/${conflict.id}/keep-reservation`).set("X-CSRF-Token", csrf).send({ reservationId: a });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ resolved: true, kept: a, released: [b] });
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: b } })).status).toBe("released");
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: a } })).status).toBe("active");
    expect((await prisma.conflict.findUniqueOrThrow({ where: { id: conflict.id } })).status).toBe("accepted");

    await reconcileDuplicateReservationConflicts();
    expect(await prisma.conflict.count({ where: { ...DUP_WHERE, assetId, status: "pending" } })).toBe(0);
  });

  it("closes the conflict on its own once the asset is down to one", async () => {
    const { b, assetId } = await twoReservations();
    await reconcileDuplicateReservationConflicts();
    await prisma.reservation.update({ where: { id: b }, data: { status: "released" } });
    const out = await reconcileDuplicateReservationConflicts();
    expect(out.closed).toBeGreaterThanOrEqual(1);
    const row = await prisma.conflict.findFirstOrThrow({ where: { ...DUP_WHERE, assetId } });
    expect(row.status).toBe("rejected");
    expect(row.resolvedBy).toBe("system:auto-resolved");
  });
});
