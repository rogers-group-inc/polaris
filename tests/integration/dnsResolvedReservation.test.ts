/**
 * tests/integration/dnsResolvedReservation.test.ts
 *
 * Integration-test home for Business Rule 11 ("DNS-resolved reservations").
 * The service in src/services/dnsResolvedReservationService.ts is entirely
 * DB-driven (raw `inet`/`cidr` containment query + Prisma reads/writes), so
 * this is a service-level integration test, not a unit test — we drive the
 * service and assert against the resulting DB rows via prisma. Skips cleanly
 * when DATABASE_URL is unreachable (see _helpers.ts).
 *
 * NOTE on the Prisma extension auto-fire: the asset.create/update/upsert hooks
 * in src/db.ts call reconcileDnsResolvedForAsset() fire-and-forget (`void`).
 * So creating a fixture asset ALREADY triggers a reconcile in the background.
 * The tests therefore (a) create the containing subnet BEFORE the asset so the
 * auto-fire can land, (b) also call the service explicitly to exercise it
 * directly per the task, and (c) assert the END STATE of the DB rows after
 * polling briefly for the async auto-fire to settle — relying on the service's
 * idempotency so the explicit call + auto-fire converge on exactly one row.
 *
 * Rules exercised (read from the service, not assumed):
 *   - Eligible asset (active/maintenance/storage/quarantined) with an IPv4
 *     primary IP inside a known non-deprecated subnet and NO active reservation
 *     there → auto-create a reservation: sourceType="dns_resolved",
 *     createdBy="system:dns-resolved", carrying hostname + MAC.
 *   - hostname falls back to dnsName when hostname is null.
 *   - Defer to ANY active non-dns_resolved (authoritative) reservation at the
 *     same (subnet, ip): no create, no overwrite, no Conflict.
 *   - Status filter: ineligible statuses (decommissioned/disabled) create
 *     nothing and release an existing owned dns_resolved row.
 *   - IPv4-only: an IPv6 primary IP creates nothing.
 *   - IP outside any known subnet → nothing.
 *   - Deprecated containing subnet → nothing.
 *   - Release paths: releaseDnsResolvedForAsset (asset-delete hook) and
 *     releaseDnsResolvedAt (discovery hand-off) hard-delete the row.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import {
  reconcileDnsResolvedForAsset,
  releaseDnsResolvedForAsset,
  releaseDnsResolvedAt,
} from "../../src/services/dnsResolvedReservationService.js";

const d = dbDescribe;

// ─── Fixture helpers ────────────────────────────────────────────────────────

const BLOCK_CIDR_V4 = "10.77.0.0/16";
const SUBNET_CIDR = "10.77.1.0/24"; // /24 carved from the block
const TARGET_IP = "10.77.1.50"; // inside SUBNET_CIDR

async function makeBlockAndSubnet(opts?: { subnetStatus?: "available" | "reserved" | "deprecated" }) {
  const block = await prisma.ipBlock.create({
    data: { name: "DNS-Resolved Test Block", cidr: BLOCK_CIDR_V4, ipVersion: "v4" },
  });
  const subnet = await prisma.subnet.create({
    data: {
      blockId: block.id,
      cidr: SUBNET_CIDR,
      name: "DNS-Resolved Test Subnet",
      status: opts?.subnetStatus ?? "available",
    },
  });
  return { block, subnet };
}

async function makeAsset(over: Partial<{
  ipAddress: string | null;
  hostname: string | null;
  dnsName: string | null;
  macAddress: string | null;
  status: "active" | "maintenance" | "storage" | "quarantined" | "decommissioned" | "disabled";
}>) {
  // Use `in` checks so an EXPLICIT null (ipAddress: null, hostname: null)
  // is honored rather than coalesced back to the default by `??`.
  return prisma.asset.create({
    data: {
      ipAddress: "ipAddress" in over ? over.ipAddress! : TARGET_IP,
      hostname: "hostname" in over ? over.hostname! : "host01",
      dnsName: "dnsName" in over ? over.dnsName! : null,
      macAddress: "macAddress" in over ? over.macAddress! : "AA:BB:CC:DD:EE:01",
      status: over.status ?? "active",
    },
  });
}

/** All active dns_resolved reservations written by the system actor. */
function dnsRows() {
  return prisma.reservation.findMany({
    where: { sourceType: "dns_resolved" as any, createdBy: "system:dns-resolved", status: "active" },
  });
}

/**
 * Drive the service explicitly AND let the asset-write auto-fire (db.ts Prisma
 * extension) settle, then return the number of system dns_resolved rows. The
 * explicit call is idempotent w.r.t. the auto-fire (both target the same
 * (subnet, ip, active) slot guarded by a unique constraint), so the converged
 * end state is what we assert.
 */
async function reconcileAndCountDnsRows(assetId: string): Promise<number> {
  await reconcileDnsResolvedForAsset(assetId).catch(() => undefined);
  // Brief settle for the background auto-fire that the fixture asset write kicked
  // off, then re-read. Poll a few times so we don't race the void reconcile.
  for (let i = 0; i < 10; i++) {
    const n = (await dnsRows()).length;
    if (n >= 1) {
      // The row exists, but the fire-and-forget reconcile that the fixture
      // asset create scheduled (db.ts Prisma extension) may still be in flight.
      // Drain it before returning so a straggler can't re-create the row AFTER
      // a caller (e.g. a release-path test) deletes it. Idempotent — the
      // straggler collides on the (subnet, ip, active) unique constraint.
      await settle();
      return (await dnsRows()).length;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  return (await dnsRows()).length;
}

/** Settle helper for the negative cases — wait out any in-flight auto-fire. */
async function settle() {
  await new Promise((r) => setTimeout(r, 120));
}

// ─── Suite scaffolding ──────────────────────────────────────────────────────

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
  // Wipe in FK order — reservations FK subnets FK ipBlocks; assets stand alone.
  await prisma.reservation.deleteMany();
  await prisma.subnet.deleteMany();
  await prisma.ipBlock.deleteMany();
  await prisma.asset.deleteMany();
});

// ─── Auto-create happy path ──────────────────────────────────────────────────

d("reconcileDnsResolvedForAsset: auto-create", () => {
  it("creates a dns_resolved reservation for an eligible asset in a known subnet", async () => {
    const { subnet } = await makeBlockAndSubnet();
    const asset = await makeAsset({ hostname: "web-01", macAddress: "AA:BB:CC:DD:EE:10" });

    expect(await reconcileAndCountDnsRows(asset.id)).toBe(1);

    const rows = await dnsRows();
    const r = rows[0];
    expect(r.subnetId).toBe(subnet.id);
    expect(r.ipAddress).toBe(TARGET_IP);
    expect(r.sourceType).toBe("dns_resolved");
    expect(r.createdBy).toBe("system:dns-resolved");
    expect(r.status).toBe("active");
    expect(r.hostname).toBe("web-01");
    expect(r.macAddress).toBe("AA:BB:CC:DD:EE:10");
    // Never pushed to a FortiGate.
    expect(r.pushStatus).toBeNull();
    expect(r.pushedToId).toBeNull();
  });

  it("falls back to dnsName for the reservation hostname when hostname is null", async () => {
    await makeBlockAndSubnet();
    const asset = await makeAsset({ hostname: null, dnsName: "srv01.corp.local" });

    expect(await reconcileAndCountDnsRows(asset.id)).toBe(1);
    const rows = await dnsRows();
    expect(rows[0].hostname).toBe("srv01.corp.local");
  });

  it("is idempotent — repeated reconciles converge on exactly one row", async () => {
    await makeBlockAndSubnet();
    const asset = await makeAsset({ hostname: "stable-01", macAddress: "AA:BB:CC:DD:EE:11" });

    expect(await reconcileAndCountDnsRows(asset.id)).toBe(1);
    // Second explicit pass: no duplicate, no second active row.
    await reconcileDnsResolvedForAsset(asset.id);
    expect((await dnsRows()).length).toBe(1);
  });

  it("two assets sharing one IP stop overwriting each other's row", async () => {
    await makeBlockAndSubnet();
    const a = await makeAsset({ hostname: "immich", macAddress: "E2:AC:39:7B:A2:00" });
    expect(await reconcileAndCountDnsRows(a.id)).toBe(1);
    const b = await makeAsset({ hostname: "immich", macAddress: "CE:27:1D:68:B1:C8" });
    await settle();
    const before = await prisma.event.count({ where: { action: "reservation.dns_resolved.updated" } });

    for (let i = 0; i < 3; i++) {
      await reconcileDnsResolvedForAsset(a.id);
      await reconcileDnsResolvedForAsset(b.id);
    }

    expect(await prisma.event.count({ where: { action: "reservation.dns_resolved.updated" } })).toBe(before);
    const rows = await dnsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].macAddress).toBe("E2:AC:39:7B:A2:00");
  });

  it("still follows the owning asset's own MAC change", async () => {
    await makeBlockAndSubnet();
    const a = await makeAsset({ hostname: "solo", macAddress: "AA:BB:CC:DD:EE:20" });
    expect(await reconcileAndCountDnsRows(a.id)).toBe(1);
    await prisma.asset.update({ where: { id: a.id }, data: { macAddress: "AA:BB:CC:DD:EE:21" } });
    await reconcileDnsResolvedForAsset(a.id);
    await settle();
    expect((await dnsRows())[0].macAddress).toBe("AA:BB:CC:DD:EE:21");
  });

  it("creates rows for every eligible status (active/maintenance/storage/quarantined)", async () => {
    const statuses = ["active", "maintenance", "storage", "quarantined"] as const;
    for (const status of statuses) {
      await prisma.reservation.deleteMany();
      await prisma.subnet.deleteMany();
      await prisma.ipBlock.deleteMany();
      await prisma.asset.deleteMany();
      await makeBlockAndSubnet();
      const asset = await makeAsset({ status, hostname: `h-${status}` });
      expect(await reconcileAndCountDnsRows(asset.id), `status=${status} should create`).toBe(1);
    }
  });
});

// ─── Defer to authoritative reservation ──────────────────────────────────────

d("reconcileDnsResolvedForAsset: defers to authoritative reservations", () => {
  it("does not create or overwrite when an active manual reservation exists at the target", async () => {
    const { subnet } = await makeBlockAndSubnet();
    const manual = await prisma.reservation.create({
      data: {
        subnetId: subnet.id,
        ipAddress: TARGET_IP,
        hostname: "operator-named",
        status: "active",
        sourceType: "manual",
        createdBy: "alice",
      },
    });
    const asset = await makeAsset({ hostname: "discovered-name" });

    const result = await reconcileDnsResolvedForAsset(asset.id);
    await settle();
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(true);

    // The manual row is untouched, no dns_resolved row added, no Conflict.
    const manualAfter = await prisma.reservation.findUnique({ where: { id: manual.id } });
    expect(manualAfter?.sourceType).toBe("manual");
    expect(manualAfter?.hostname).toBe("operator-named");
    expect((await dnsRows()).length).toBe(0);
    expect(await prisma.conflict.count()).toBe(0);
  });

  it("defers to a dhcp_reservation (any non-dns_resolved sourceType wins)", async () => {
    const { subnet } = await makeBlockAndSubnet();
    await prisma.reservation.create({
      data: {
        subnetId: subnet.id,
        ipAddress: TARGET_IP,
        status: "active",
        sourceType: "dhcp_reservation",
        createdBy: "system:discovery",
      },
    });
    const asset = await makeAsset({});

    const result = await reconcileDnsResolvedForAsset(asset.id);
    await settle();
    expect(result.created).toBe(0);
    expect((await dnsRows()).length).toBe(0);
  });
});

// ─── Status filtering ────────────────────────────────────────────────────────

d("reconcileDnsResolvedForAsset: ineligible asset statuses", () => {
  for (const status of ["decommissioned", "disabled"] as const) {
    it(`creates nothing for a ${status} asset`, async () => {
      await makeBlockAndSubnet();
      const asset = await makeAsset({ status });
      const result = await reconcileDnsResolvedForAsset(asset.id);
      await settle();
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(true);
      expect((await dnsRows()).length).toBe(0);
    });
  }

  it("releases an existing owned dns_resolved row when the asset becomes decommissioned", async () => {
    await makeBlockAndSubnet();
    const asset = await makeAsset({ hostname: "to-decom", macAddress: "AA:BB:CC:DD:EE:20" });

    // First create the row while eligible.
    expect(await reconcileAndCountDnsRows(asset.id)).toBe(1);

    // Now flip to decommissioned and reconcile — the row should be released.
    // (The update itself also auto-fires a reconcile that would release it.)
    await prisma.asset.update({ where: { id: asset.id }, data: { status: "decommissioned" } });
    const result = await reconcileDnsResolvedForAsset(asset.id);
    await settle();
    // Either our explicit call or the update auto-fire performs the release;
    // the asserted end-state is that no system row survives.
    expect(result.skipped).toBe(true);
    expect((await dnsRows()).length).toBe(0);
  });
});

// ─── IPv4-only / no-subnet / deprecated-subnet ───────────────────────────────

d("reconcileDnsResolvedForAsset: addressing guards", () => {
  it("creates nothing for an IPv6 primary IP", async () => {
    // Build an IPv6 block/subnet so even containment can't accidentally match.
    const block = await prisma.ipBlock.create({
      data: { name: "v6 block", cidr: "fd00:dead::/32", ipVersion: "v6" },
    });
    await prisma.subnet.create({
      data: { blockId: block.id, cidr: "fd00:dead:beef::/48", name: "v6 sub", status: "available" },
    });
    const asset = await makeAsset({ ipAddress: "fd00:dead:beef::5" });

    const result = await reconcileDnsResolvedForAsset(asset.id);
    await settle();
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(true);
    expect((await dnsRows()).length).toBe(0);
  });

  it("creates nothing when the IP falls outside every known subnet", async () => {
    await makeBlockAndSubnet(); // subnet is 10.77.1.0/24
    const asset = await makeAsset({ ipAddress: "192.168.99.5" }); // outside it
    const result = await reconcileDnsResolvedForAsset(asset.id);
    await settle();
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(true);
    expect((await dnsRows()).length).toBe(0);
  });

  it("creates nothing when the only containing subnet is deprecated", async () => {
    await makeBlockAndSubnet({ subnetStatus: "deprecated" });
    const asset = await makeAsset({});
    const result = await reconcileDnsResolvedForAsset(asset.id);
    await settle();
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(true);
    expect((await dnsRows()).length).toBe(0);
  });

  it("creates nothing for an asset with no primary IP", async () => {
    await makeBlockAndSubnet();
    const asset = await makeAsset({ ipAddress: null });
    const result = await reconcileDnsResolvedForAsset(asset.id);
    await settle();
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(true);
    expect((await dnsRows()).length).toBe(0);
  });
});

// ─── Release paths ───────────────────────────────────────────────────────────

d("release paths", () => {
  it("releaseDnsResolvedForAsset hard-deletes the asset's owned dns_resolved row", async () => {
    await makeBlockAndSubnet();
    const asset = await makeAsset({ hostname: "doomed-01", macAddress: "AA:BB:CC:DD:EE:30" });
    expect(await reconcileAndCountDnsRows(asset.id)).toBe(1);

    // Asset-delete hook runs BEFORE the asset row is removed (still has
    // hostname/MAC to find owned rows by) — emulate that ordering here.
    await releaseDnsResolvedForAsset(asset.id);

    // Hard-delete, not status flip: the row is gone entirely (no released row).
    expect((await dnsRows()).length).toBe(0);
    expect(
      await prisma.reservation.count({ where: { sourceType: "dns_resolved" as any } }),
    ).toBe(0);
  });

  it("releaseDnsResolvedAt hard-deletes the dns_resolved row at a (subnet, ip) for discovery hand-off", async () => {
    const { subnet } = await makeBlockAndSubnet();
    const asset = await makeAsset({ hostname: "handoff-01", macAddress: "AA:BB:CC:DD:EE:31" });
    expect(await reconcileAndCountDnsRows(asset.id)).toBe(1);

    await releaseDnsResolvedAt(subnet.id, TARGET_IP);

    expect((await dnsRows()).length).toBe(0);
    expect(
      await prisma.reservation.count({ where: { sourceType: "dns_resolved" as any } }),
    ).toBe(0);
  });

  it("releaseDnsResolvedAt leaves an authoritative reservation at the same target untouched", async () => {
    const { subnet } = await makeBlockAndSubnet();
    const manual = await prisma.reservation.create({
      data: {
        subnetId: subnet.id,
        ipAddress: TARGET_IP,
        status: "active",
        sourceType: "manual",
        createdBy: "alice",
      },
    });
    // Discovery hand-off only targets dns_resolved rows — the manual row stays.
    await releaseDnsResolvedAt(subnet.id, TARGET_IP);
    const after = await prisma.reservation.findUnique({ where: { id: manual.id } });
    expect(after).not.toBeNull();
    expect(after?.sourceType).toBe("manual");
  });
});

// ─── IP-change cleanup (stale-row release) ───────────────────────────────────

d("reconcileDnsResolvedForAsset: IP change releases the stale row", () => {
  it("moves the dns_resolved row to the new IP and releases the old one", async () => {
    // Two subnets in the same block so both IPs are inside a known subnet.
    const block = await prisma.ipBlock.create({
      data: { name: "two-subnet block", cidr: BLOCK_CIDR_V4, ipVersion: "v4" },
    });
    await prisma.subnet.create({
      data: { blockId: block.id, cidr: "10.77.1.0/24", name: "sub-a", status: "available" },
    });
    await prisma.subnet.create({
      data: { blockId: block.id, cidr: "10.77.2.0/24", name: "sub-b", status: "available" },
    });

    const asset = await makeAsset({ ipAddress: "10.77.1.50", hostname: "mover-01", macAddress: "AA:BB:CC:DD:EE:40" });
    expect(await reconcileAndCountDnsRows(asset.id)).toBe(1);
    let rows = await dnsRows();
    expect(rows[0].ipAddress).toBe("10.77.1.50");

    // Asset's IP changes; reconcile should create at the new IP and release old.
    // The update auto-fires a reconcile too; assert the converged end-state.
    await prisma.asset.update({ where: { id: asset.id }, data: { ipAddress: "10.77.2.50" } });
    await reconcileDnsResolvedForAsset(asset.id);
    await settle();

    rows = await dnsRows();
    expect(rows.length).toBe(1);
    expect(rows[0].ipAddress).toBe("10.77.2.50");
  });
});
