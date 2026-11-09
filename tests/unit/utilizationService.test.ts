/**
 * tests/unit/utilizationService.test.ts
 *
 * The dashboard's address-space figures: how subnets are bucketed per block
 * (a discovered "available" network is counted apart from a hand-carved one,
 * deprecated networks hold no space), the exact used-percent that keeps an
 * IPv6 block from reading 100% after one network, the Recently Reserved
 * widget's source-type filter semantics, and the per-block network list.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  blockCount: vi.fn(),
  blockFindMany: vi.fn(),
  blockFindUnique: vi.fn(),
  subnetCount: vi.fn(),
  subnetGroupBy: vi.fn(),
  resCount: vi.fn(),
  resFindMany: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    ipBlock: { count: m.blockCount, findMany: m.blockFindMany, findUnique: m.blockFindUnique },
    subnet: { count: m.subnetCount, groupBy: m.subnetGroupBy },
    reservation: { count: m.resCount, findMany: m.resFindMany },
  },
}));

const svc = await import("../../src/services/utilizationService.js");

const t = new Date("2026-11-01T00:00:00Z");

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.blockCount.mockResolvedValue(0);
  m.subnetCount.mockResolvedValue(0);
  m.subnetGroupBy.mockResolvedValue([]);
  m.resCount.mockResolvedValue(0);
  m.resFindMany.mockResolvedValue([]);
  m.blockFindMany.mockResolvedValue([]);
});

describe("getGlobalUtilization", () => {
  it("fills every status bucket, defaulting an absent one to zero", async () => {
    m.subnetGroupBy.mockResolvedValue([{ status: "reserved", _count: { id: 4 } }]);
    const r = await svc.getGlobalUtilization();
    expect(r.subnetsByStatus).toEqual({ available: 0, reserved: 4, deprecated: 0 });
  });

  it("counts only active reservations and lists the ten newest with their subnet", async () => {
    m.resCount.mockResolvedValue(42);
    m.resFindMany.mockResolvedValue([{
      id: "r1", ipAddress: "10.0.0.5", owner: "ops", projectRef: null, createdAt: t, expiresAt: null,
      subnet: { cidr: "10.0.0.0/24", name: "Core", purpose: "infra", vlan: 10 },
    }]);
    const r = await svc.getGlobalUtilization();
    expect(m.resCount).toHaveBeenCalledWith({ where: { status: "active" } });
    expect(m.resFindMany.mock.calls[0][0]).toMatchObject({ where: { status: "active" }, orderBy: { createdAt: "desc" }, take: 10 });
    expect(r.totalActiveReservations).toBe(42);
    expect(r.recentReservations[0]).toEqual({
      id: "r1", subnetCidr: "10.0.0.0/24", subnetName: "Core", subnetPurpose: "infra", vlan: 10,
      ipAddress: "10.0.0.5", owner: "ops", projectRef: null, createdAt: t, expiresAt: null,
    });
  });

  it("splits discovered from hand-carved available networks and leaves deprecated ones out of the allocation", async () => {
    m.blockFindMany.mockResolvedValue([{
      id: "b1", name: "Campus", cidr: "10.0.0.0/16",
      subnets: [
        { cidr: "10.0.0.0/24", status: "available", discoveredBy: "int-1" },
        { cidr: "10.0.1.0/24", status: "available", discoveredBy: null },
        { cidr: "10.0.2.0/23", status: "reserved", discoveredBy: null },
        { cidr: "10.0.128.0/17", status: "deprecated", discoveredBy: null },
      ],
    }]);
    const [b] = (await svc.getGlobalUtilization()).blockUtilization;
    expect(b).toMatchObject({
      totalSubnets: 4,
      discoveredSubnets: 1,
      availableSubnets: 1,
      reservedSubnets: 1,
      deprecatedSubnets: 1,
      blockAddresses: 65536,
      allocatedAddresses: 256 + 256 + 512,
    });
    // 1024 / 65536 = 1.56% → rounded
    expect(b.usedPercent).toBe(2);
  });

  it("keeps an IPv6 block's used-percent exact (one /64 in a /48 is not 100%)", async () => {
    m.blockFindMany.mockResolvedValue([{
      id: "b6", name: "v6", cidr: "2001:db8::/48",
      subnets: [{ cidr: "2001:db8:0:1::/64", status: "available", discoveredBy: null }],
    }]);
    const [b] = (await svc.getGlobalUtilization()).blockUtilization;
    expect(b.usedPercent).toBe(0);
    // The raw counts are capped at MAX_SAFE_INTEGER for IPv6 (documented).
    expect(b.blockAddresses).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("reads 100% for a fully carved IPv4 block", async () => {
    m.blockFindMany.mockResolvedValue([{
      id: "b1", name: "Small", cidr: "192.168.0.0/23",
      subnets: [
        { cidr: "192.168.0.0/24", status: "reserved", discoveredBy: null },
        { cidr: "192.168.1.0/24", status: "available", discoveredBy: "int" },
      ],
    }]);
    const [b] = (await svc.getGlobalUtilization()).blockUtilization;
    expect(b.usedPercent).toBe(100);
  });
});

describe("getRecentManualReservations", () => {
  const raw = {
    id: "r1", ipAddress: "10.0.0.9", hostname: "kiosk", owner: "ops", projectRef: null,
    macAddress: "aa:bb:cc:dd:ee:ff", createdAt: t, createdBy: "alice", expiresAt: null,
    subnet: { id: "s1", cidr: "10.0.0.0/24", name: "Core", vlan: null },
  };

  it("defaults to operator-typed (manual) reservations only", async () => {
    await svc.getRecentManualReservations();
    expect(m.resFindMany.mock.calls[0][0]).toMatchObject({ where: { status: "active", sourceType: { in: ["manual"] } }, take: 10 });
  });

  it("broadens to the caller's source types, and an empty list means no source filter", async () => {
    await svc.getRecentManualReservations(5, ["manual", "dhcp_reservation"]);
    expect(m.resFindMany.mock.calls[0][0].where).toEqual({ status: "active", sourceType: { in: ["manual", "dhcp_reservation"] } });
    await svc.getRecentManualReservations(5, []);
    expect(m.resFindMany.mock.calls[1][0].where).toEqual({ status: "active" });
  });

  it("a null limit lists everything", async () => {
    await svc.getRecentManualReservations(null);
    expect(m.resFindMany.mock.calls[0][0].take).toBeUndefined();
  });

  it("returns full attribution (hostname, MAC, createdBy) without a second fetch", async () => {
    m.resFindMany.mockResolvedValue([raw]);
    const [r] = await svc.getRecentManualReservations();
    expect(r).toEqual({
      id: "r1", subnetId: "s1", subnetCidr: "10.0.0.0/24", subnetName: "Core", vlan: null,
      ipAddress: "10.0.0.9", hostname: "kiosk", owner: "ops", projectRef: null,
      macAddress: "aa:bb:cc:dd:ee:ff", createdAt: t, createdBy: "alice", expiresAt: null,
    });
  });
});

describe("getBlockUtilization", () => {
  it("returns null for an unknown block", async () => {
    m.blockFindUnique.mockResolvedValue(null);
    await expect(svc.getBlockUtilization("x")).resolves.toBeNull();
  });

  it("reports each network's usable host count beside its reservation count", async () => {
    m.blockFindUnique.mockResolvedValue({
      id: "b1",
      subnets: [{ id: "s1", cidr: "10.0.0.0/24", name: "Core", purpose: null, vlan: 1, status: "available", tags: [], _count: { reservations: 3 } }],
    });
    const r = await svc.getBlockUtilization("b1");
    expect(r!.subnets[0]).toMatchObject({ usableHosts: 254, activeReservations: 3 });
  });

  // Was a bug until 2026-11-09 (found by CQ-T010): `activeReservations`
  // counted EVERY reservation on the subnet, released rows included (they are
  // kept, status "released"), so a churned network reported far more than it
  // holds. The count is filtered to status "active" (rule 69).
  it("counts only ACTIVE reservations toward activeReservations", async () => {
    m.blockFindUnique.mockResolvedValue({ id: "b1", subnets: [] });
    await svc.getBlockUtilization("b1");
    const include = m.blockFindUnique.mock.calls[0][0].include;
    expect(include.subnets.include._count.select.reservations).toEqual({ where: { status: "active" } });
  });
});
