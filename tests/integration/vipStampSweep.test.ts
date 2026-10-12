/**
 * tests/integration/vipStampSweep.test.ts
 *
 * Discovery Phase 5b clears a stale VIP stamp from a reservation that owns its
 * address on its own account — an operator's claim that inherited the VIP
 * snapshot (business rule 77), or a DHCP reservation/lease the VIP arrived on
 * second. Before this sweep only `sourceType: "vip"` rows were retired, and the
 * per-subnet discover (the other path that clears stamps) refuses a network no
 * integration discovered, so a claimed address in a hand-built WAN network
 * reported its deleted VIP on the asset forever.
 *
 * Also pins the existing `vip` row release — this file is the first test of
 * either Phase 5b VIP path against a real database.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable, waitForEventCount } from "./_helpers.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";

const d = dbDescribe;
const INTG_NAME = "vip-stamp-sweep-test";
const GATE = "VIPSWEEP-GW";
const OTHER_GATE = "VIPSWEEP-OTHER-GW";
/** A hand-built WAN network: no `discoveredBy`, no `fortigateDevice`. */
const WAN_CIDR = "203.0.113.0/28";
const WAN_IP = "203.0.113.5";
/** A gate-discovered LAN for the DHCP-reservation case. */
const LAN_CIDR = "10.83.0.0/24";
const LAN_IP = "10.83.0.20";
const BLOCK_CIDR = "203.0.113.0/24";
const LAN_BLOCK_CIDR = "10.83.0.0/16";

let integrationId = "";
let wanSubnetId = "";
let lanSubnetId = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

async function cleanup(): Promise<void> {
  const blocks = await prisma.ipBlock.findMany({
    where: { cidr: { in: [BLOCK_CIDR, LAN_BLOCK_CIDR] } },
    select: { id: true },
  });
  const blockIds = blocks.map((b) => b.id);
  if (blockIds.length) {
    const subnets = await prisma.subnet.findMany({ where: { blockId: { in: blockIds } }, select: { id: true } });
    const subnetIds = subnets.map((s) => s.id);
    if (subnetIds.length) {
      await prisma.conflict.deleteMany({ where: { reservation: { subnetId: { in: subnetIds } } } });
      await prisma.reservation.deleteMany({ where: { subnetId: { in: subnetIds } } });
      await prisma.subnet.deleteMany({ where: { id: { in: subnetIds } } });
    }
    await prisma.ipBlock.deleteMany({ where: { id: { in: blockIds } } });
  }
  const intgs = await prisma.integration.findMany({ where: { name: INTG_NAME }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({
    data: { type: "fortimanager", name: INTG_NAME, config: {}, enabled: true },
  });
  integrationId = intg.id;
  const wanBlock = await prisma.ipBlock.create({ data: { name: "vipsweep-wan", cidr: BLOCK_CIDR, ipVersion: "v4" } });
  const lanBlock = await prisma.ipBlock.create({ data: { name: "vipsweep-lan", cidr: LAN_BLOCK_CIDR, ipVersion: "v4" } });
  const wan = await prisma.subnet.create({
    data: { blockId: wanBlock.id, cidr: WAN_CIDR, name: "WAN (manual)", status: "available" },
  });
  const lan = await prisma.subnet.create({
    data: {
      blockId: lanBlock.id, cidr: LAN_CIDR, name: "LAN", status: "available",
      discoveredBy: integrationId, fortigateDevice: GATE,
    },
  });
  wanSubnetId = wan.id;
  lanSubnetId = lan.id;
});

type Vip = { name: string; extip: string; mappedips?: string[]; device?: string };

/** One gate's sync result: its VIP table and nothing else. */
function resultWith(vips: Vip[], vipInventoried: string[]) {
  return {
    subnets: [], devices: [], interfaceIps: [], dhcpEntries: [],
    deviceInventory: [], inventoryDevices: [],
    knownDeviceNames: [GATE, OTHER_GATE], knownDeviceSerials: [],
    fortiSwitches: [], fortiAps: [],
    vips: vips.map((v) => ({
      device: v.device ?? GATE, name: v.name, extip: v.extip, mappedips: v.mappedips ?? [],
      extintf: "wan1", isVirtualServer: false, realservers: [],
    })),
    switchMacTable: [], arpTable: [], arpQueriedDevices: [],
    cmdbSwitchSerials: [], cmdbApSerials: [],
    switchInventoriedDevices: [], apInventoriedDevices: [],
    vipInventoriedDevices: vipInventoried,
    dhcpReservationsInventoriedDevices: [], dhcpLeasesInventoriedDevices: [],
  } as any;
}

const sync = (vips: Vip[], vipInventoried: string[] = [GATE]) =>
  syncDhcpSubnets(integrationId, INTG_NAME, "fortimanager", resultWith(vips, vipInventoried), "tester", "skip-deprecation");

const stamp = (name: string, ip: string, device = GATE) => ({
  name, device, extip: ip, role: "external", isVirtualServer: false,
});

async function seedClaim(subnetId: string, ip: string, vipName: string, sourceType: "manual" | "dhcp_reservation" = "manual") {
  return prisma.reservation.create({
    data: {
      subnetId, ipAddress: ip, hostname: "operator-host", owner: "netops", notes: "typed by an operator",
      status: "active", sourceType, vipInfo: stamp(vipName, ip),
    },
  });
}

const readRow = (id: string) =>
  prisma.reservation.findUnique({
    where: { id },
    select: { status: true, sourceType: true, vipInfo: true, hostname: true, owner: true, notes: true },
  });

d("Phase 5b clears stale VIP stamps on rows that own their address", () => {
  it("clears a manual claim's stamp in a hand-built WAN network once the VIP is gone", async () => {
    const row = await seedClaim(wanSubnetId, WAN_IP, "web-443");
    await sync([]);

    const after = await readRow(row.id);
    expect(after?.vipInfo).toBeNull();
    // Only the VIP fact goes — the claim and every operator field survive.
    expect(after?.status).toBe("active");
    expect(after?.sourceType).toBe("manual");
    expect(after?.hostname).toBe("operator-host");
    expect(after?.owner).toBe("netops");
    expect(after?.notes).toBe("typed by an operator");

    // logEvent is fire-and-forget inside discovery.
    expect(await waitForEventCount("reservation.vip.cleared", 1, row.id)).toBeGreaterThanOrEqual(1);
  });

  it("clears the stamp when another VIP still shares the external address", async () => {
    // A WAN external is routinely shared by several port-forward VIPs; deleting
    // one leaves the address live, so membership must be judged by VIP name.
    const row = await seedClaim(wanSubnetId, WAN_IP, "web-443");
    await sync([{ name: "ssh-22", extip: WAN_IP }]);

    const after = await readRow(row.id);
    expect(after?.vipInfo).toBeNull();
    expect(after?.status).toBe("active");
  });

  it("keeps the stamp while its VIP is still on the gate", async () => {
    const row = await seedClaim(wanSubnetId, WAN_IP, "web-443");
    await sync([{ name: "web-443", extip: WAN_IP }]);

    const after = await readRow(row.id);
    expect((after?.vipInfo as any)?.name).toBe("web-443");
  });

  it("keeps the stamp when the gate's VIP table did not read this cycle", async () => {
    // An unread table is never "no VIPs" (rule 53).
    const row = await seedClaim(wanSubnetId, WAN_IP, "web-443");
    await sync([], []);

    const after = await readRow(row.id);
    expect((after?.vipInfo as any)?.name).toBe("web-443");
  });

  it("leaves a stamp naming a different gate alone", async () => {
    // Rule 17's per-device scoping: OTHER_GATE's table was not read here.
    const row = await prisma.reservation.create({
      data: {
        subnetId: wanSubnetId, ipAddress: WAN_IP, hostname: "h", status: "active",
        sourceType: "manual", vipInfo: stamp("web-443", WAN_IP, OTHER_GATE),
      },
    });
    await sync([]);

    const after = await readRow(row.id);
    expect((after?.vipInfo as any)?.device).toBe(OTHER_GATE);
  });

  it("clears a DHCP reservation's stamp without releasing the reservation", async () => {
    const row = await seedClaim(lanSubnetId, LAN_IP, "app-dnat", "dhcp_reservation");
    await sync([]);

    const after = await readRow(row.id);
    expect(after?.vipInfo).toBeNull();
    expect(after?.sourceType).toBe("dhcp_reservation");
    // The CMDB DHCP query did not read this cycle, so the dhcp_reservation
    // sweep has no say — the row stays active.
    expect(after?.status).toBe("active");
  });

  it("still releases a stale `vip` row and clears its stamp", async () => {
    const row = await prisma.reservation.create({
      data: {
        subnetId: wanSubnetId, ipAddress: WAN_IP, hostname: "web-443", owner: "web-443",
        status: "active", sourceType: "vip", vipInfo: stamp("web-443", WAN_IP),
      },
    });
    await sync([]);

    const after = await readRow(row.id);
    expect(after?.status).toBe("released");
    expect(after?.vipInfo).toBeNull();
  });
});
