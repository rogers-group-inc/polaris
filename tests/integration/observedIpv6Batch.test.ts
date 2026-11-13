/**
 * tests/integration/observedIpv6Batch.test.ts — Phase 7c's observed IPv6 rows
 * go in as one createManyAndReturn with skipDuplicates (efficiency audit
 * group 3). Against a real database: an address something else claimed after
 * the run built its plan is skipped by the unique index, quietly, as the old
 * per-row P2002 was, and the rest land.
 */

import { it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { recordObservedIpv6 } from "../../src/services/discovery/dhcp/observedIpv6.js";

const BLOCK = "2001:db8:77::/48";
const NET = "2001:db8:77:1::/64";

async function cleanup() {
  if (!dbReachable) return;
  const subnets = await prisma.subnet.findMany({ where: { cidr: NET }, select: { id: true } });
  await prisma.reservation.deleteMany({ where: { subnetId: { in: subnets.map((s) => s.id) } } });
  await prisma.subnet.deleteMany({ where: { cidr: NET } });
  await prisma.ipBlock.deleteMany({ where: { cidr: BLOCK } });
}
beforeEach(cleanup);
afterAll(cleanup);

dbDescribe("recordObservedIpv6 batch insert", () => {
  it("skips an address claimed mid-run and records the rest", async () => {
    const block = await prisma.ipBlock.create({ data: { name: "obs6", cidr: BLOCK, ipVersion: "v6" } });
    const net = await prisma.subnet.create({ data: { blockId: block.id, cidr: NET, name: "obs6-net", status: "available" } });
    // Claimed after the plan was made: in the DB, not in the run's map.
    await prisma.reservation.create({
      data: { subnetId: net.id, ipAddress: "2001:db8:77:1::10", status: "active", sourceType: "dhcp_lease", hostname: "claimed" },
    });
    const logs: Array<[string, string]> = [];
    const activeResMap = new Map<string, any>();
    await recordObservedIpv6({
      result: {
        deviceInventory: [
          { ipv6Address: "2001:db8:77:1::10", macAddress: "aa:bb:cc:00:77:10", device: "FGT-A", isOnline: true },
          { ipv6Address: "2001:db8:77:1::11", macAddress: "aa:bb:cc:00:77:11", device: "FGT-A", isOnline: true },
          { ipv6Address: "2001:db8:77:1::12", macAddress: "aa:bb:cc:00:77:12", device: "FGT-A", isOnline: true },
        ],
        switchMacTable: [],
      } as never,
      now: new Date().toISOString(),
      activeResMap,
      findSubnetForIp: (ip) => (ip.startsWith("2001:db8:77:1:") ? { id: net.id } : undefined),
      reservationKey: (subnetId, ip) => `${subnetId}|${ip}`,
      assetIdx: { findByMac: () => null } as never,
      projectRefLabel: "FortiGate Integration",
      syncLog: (level, message) => { logs.push([level, message]); },
    });

    const rows = await prisma.reservation.findMany({ where: { subnetId: net.id }, orderBy: { ipAddress: "asc" } });
    expect(rows.map((r) => [r.ipAddress, r.sourceType])).toEqual([
      ["2001:db8:77:1::10", "dhcp_lease"], // the claimant wins, untouched
      ["2001:db8:77:1::11", "observed"],
      ["2001:db8:77:1::12", "observed"],
    ]);
    expect(activeResMap.has(`${net.id}|2001:db8:77:1::11`)).toBe(true);
    expect(activeResMap.has(`${net.id}|2001:db8:77:1::10`)).toBe(false);
    expect(logs.filter(([level]) => level !== "info")).toEqual([]); // no batch failure, no row error
  });
});
