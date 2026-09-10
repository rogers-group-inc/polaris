/**
 * tests/integration/ipUpstreamChain.test.ts
 *
 * The IP-keyed upstream sweep against a real database: an asset with an
 * address and no MAC gets its Last Seen Switch / AP derived through the owning
 * gate's ARP cache, the switch forwarding table and the AP station table.
 *
 * What is worth a database here is the SCOPING — the containing subnet names
 * its gate by FortiManager device name (not the gate's hostname), the ARP row
 * must come from THAT gate and no other, a second MAC at the address refuses
 * the whole chain, a stale address claim is skipped, and an asset that already
 * has a MAC is never touched. Plus the audit row after the write.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resolveIpUpstreamForMaclessAssets } from "../../src/services/ipUpstreamChainService.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

const d = dbDescribe;

const FMG_DEVICE_NAME = "SITE-A-FGT-PRIMARY";
const OTHER_DEVICE_NAME = "SITE-B-FGT-PRIMARY";
const IP = "10.40.12.63";
const MAC = "AA:BB:CC:DD:EE:63";
const OTHER_MAC = "11:22:33:44:55:66";

let gateA = "";
let gateB = "";
let sw = "";
let ap = "";

async function wipe(): Promise<void> {
  await prisma.event.deleteMany({ where: { actor: "system:upstream-chain" } });
  await prisma.assetWirelessStation.deleteMany();
  await prisma.assetMacTableEntry.deleteMany();
  await prisma.assetArpEntry.deleteMany();
  await prisma.assetIpHistory.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.subnet.deleteMany();
  await prisma.ipBlock.deleteMany();
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await wipe();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await wipe();

  const block = await prisma.ipBlock.create({
    data: { name: "Site A", cidr: "10.40.0.0/16", ipVersion: "v4" },
  });
  // The subnet names its gate the way FortiManager does — deliberately NOT the
  // gate's hostname, so a hostname match would find nothing.
  await prisma.subnet.create({
    data: { blockId: block.id, cidr: "10.40.12.0/24", name: "Site A users", status: "available", fortigateDevice: FMG_DEVICE_NAME },
  });

  gateA = (await prisma.asset.create({
    data: { hostname: "fgt-a.example.internal", assetType: "firewall", status: "active", ipAddress: "10.40.12.1", fortinetTopology: { deviceName: FMG_DEVICE_NAME } as any },
  })).id;
  gateB = (await prisma.asset.create({
    data: { hostname: "fgt-b.example.internal", assetType: "firewall", status: "active", ipAddress: "10.41.12.1", fortinetTopology: { deviceName: OTHER_DEVICE_NAME } as any },
  })).id;
  sw = (await prisma.asset.create({
    data: { hostname: "FS-248E-01", assetType: "switch", status: "active", ipAddress: "10.40.12.20" },
  })).id;
  ap = (await prisma.asset.create({
    data: { hostname: "AP-LOBBY-1", assetType: "access_point", status: "active", ipAddress: "10.40.12.30" },
  })).id;
});

async function maclessAsset(over: Record<string, unknown> = {}): Promise<string> {
  const a = await prisma.asset.create({
    data: {
      hostname: "AD-WORKSTATION-7", assetType: "workstation", status: "active",
      ipAddress: IP, ipSource: "manual", ...over,
    } as any,
  });
  return a.id;
}

/**
 * Drop the `asset_ip_history` row db.ts writes for an asset's IP, and be sure
 * it stays dropped.
 *
 * `db.ts → recordIpHistory()` is FIRE-AND-FORGET by design ("history is
 * best-effort and the caller doesn't await"), so its INSERT is still in flight
 * when `prisma.asset.create` resolves. Deleting immediately can WIN that race,
 * and the upsert then lands after the delete and puts a `lastSeen = now` row
 * back — which makes a deliberately stale claim read as fresh. Waiting for the
 * row to appear proves the single in-flight upsert has landed, so the delete
 * after it is final. This is the same class of trap as the dns_resolved
 * auto-create race; do not replace it with a bare deleteMany.
 *
 * The wait must FAIL when the row never shows, not fall through. A timed-out
 * loop followed by `deleteMany` deletes nothing and still satisfies
 * `count === 0`, so the test goes green, the upsert lands a moment later, and
 * the stale claim it was supposed to set up reads as fresh — the original
 * failure, back as a rare CI-only flake with no evidence pointing here. So the
 * appearance is asserted, and the budget is generous: this is one row on a
 * contended runner, and waiting is free when it arrives on the first poll.
 */
async function dropIpHistory(assetId: string): Promise<void> {
  let appeared = false;
  for (let i = 0; i < 150; i++) {
    if ((await prisma.assetIpHistory.count({ where: { assetId } })) > 0) {
      appeared = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(
    appeared,
    "db.ts recordIpHistory() never wrote an asset_ip_history row within 3s — " +
      "deleting now would race the in-flight upsert instead of following it",
  ).toBe(true);
  await prisma.assetIpHistory.deleteMany({ where: { assetId } });
  expect(await prisma.assetIpHistory.count({ where: { assetId } })).toBe(0);
}

async function arp(gateId: string, mac: string, ifName = "internal3"): Promise<void> {
  await prisma.assetArpEntry.create({ data: { assetId: gateId, ipAddress: IP, macAddress: mac, ifName } });
}

/**
 * One learned FDB row. `vlanId` is a parameter because `AssetMacTableEntry` is
 * unique on `(assetId, macAddress, vlanId)` — a switch learns a MAC on exactly
 * ONE port per VLAN, so two rows for the same MAC on the same switch must
 * differ by VLAN. The chain solver keys on `(assetId, ifName)` and ignores
 * `vlanId` entirely (`ipUpstreamChainService.ts → portKey()`), so the VLAN a
 * row carries never changes which port wins.
 */
async function fdb(switchId: string, mac: string, ifName: string, vlanId = 12): Promise<void> {
  await prisma.assetMacTableEntry.create({ data: { assetId: switchId, macAddress: mac, ifName, status: "learned", vlanId } });
}

d("ip upstream chain sweep", () => {
  it("derives the switch port and AP for a MAC-less asset through the owning gate's ARP row", async () => {
    const id = await maclessAsset();
    await arp(gateA, MAC);
    // The MAC shows on the access port AND on the uplink trunk above it; the
    // trunk has learned many MACs and must lose. The two rows carry different
    // VLANs because the table is unique per (switch, MAC, VLAN) — see fdb() —
    // and the solver ranks on port cardinality, which the VLAN does not enter.
    await fdb(sw, MAC, "port15", 12);
    await fdb(sw, MAC, "port48", 99);
    for (let i = 0; i < 5; i++) await fdb(sw, `00:00:00:00:00:0${i}`, "port48");
    await prisma.assetWirelessStation.create({ data: { apAssetId: ap, staMacAddr: MAC, source: "snmp" } });

    const r = await resolveIpUpstreamForMaclessAssets();
    expect(r.candidates).toBe(1);
    expect(r.resolvedMac).toBe(1);
    expect(r.switchStamps).toBe(1);
    expect(r.apStamps).toBe(1);

    const a = await prisma.asset.findUniqueOrThrow({ where: { id }, select: { lastSeenSwitch: true, lastSeenAp: true, macAddress: true } });
    expect(a.lastSeenSwitch).toBe("FS-248E-01/port15");
    expect(a.lastSeenAp).toBe("AP-LOBBY-1");
    // The MAC is derived, never adopted.
    expect(a.macAddress).toBeNull();

    const events = await prisma.event.findMany({ where: { resourceId: id, actor: "system:upstream-chain" }, select: { action: true } });
    expect(events.map((e) => e.action).sort()).toEqual(["asset.switch_port.changed", "asset.wireless_ap.changed"]);
  });

  it("ignores another gate's ARP row for the same address (overlapping RFC1918)", async () => {
    const id = await maclessAsset();
    // Only site B's gate has resolved the address, with a device that lives at
    // site B. The subnet says site A owns it — nothing may be stamped.
    await arp(gateB, OTHER_MAC);
    await fdb(sw, OTHER_MAC, "port3");

    const r = await resolveIpUpstreamForMaclessAssets();
    expect(r.resolvedMac).toBe(0);
    expect(r.switchStamps).toBe(0);
    const a = await prisma.asset.findUniqueOrThrow({ where: { id }, select: { lastSeenSwitch: true } });
    expect(a.lastSeenSwitch).toBeNull();
  });

  it("refuses an address the owning gate sees two MACs at", async () => {
    const id = await maclessAsset();
    await arp(gateA, MAC, "internal3");
    await arp(gateA, OTHER_MAC, "internal4");
    await fdb(sw, MAC, "port15");

    const r = await resolveIpUpstreamForMaclessAssets();
    expect(r.ambiguous).toBe(1);
    expect(r.switchStamps).toBe(0);
    const a = await prisma.asset.findUniqueOrThrow({ where: { id }, select: { lastSeenSwitch: true } });
    expect(a.lastSeenSwitch).toBeNull();
  });

  it("skips an asset whose discovered address claim is stale, with no history row", async () => {
    // Discovered (not operator-owned), last asserted a month ago, no history
    // row — a leftover record, not a current claim (rule 40). This is the
    // `?? row.lastSeen` FALLBACK arm of claimIsFresh.
    //
    // Dropping the history row is load-bearing: db.ts upserts
    // asset_ip_history on every write carrying an asset's IP, so the create
    // above already made a row stamped lastSeen=now. Leaving it would make
    // ipLastSeen win and the claim read as FRESH — which is exactly why this
    // test failed the first time it ever ran against a real database. See
    // dropIpHistory for why a plain deleteMany here is not enough.
    const id = await maclessAsset({ ipSource: "fortigate", lastSeen: new Date(Date.now() - 30 * 86_400_000) });
    await dropIpHistory(id);
    await arp(gateA, MAC);
    await fdb(sw, MAC, "port15");

    const r = await resolveIpUpstreamForMaclessAssets();
    expect(r.staleClaims).toBe(1);
    expect(r.candidates).toBe(0);
    const a = await prisma.asset.findUniqueOrThrow({ where: { id }, select: { lastSeenSwitch: true } });
    expect(a.lastSeenSwitch).toBeNull();
  });

  it("skips a discovered claim whose HISTORY row is a month old", async () => {
    // The shape a stale claim actually has in production: the address IS in
    // asset_ip_history, because db.ts put it there, and it was last asserted a
    // month ago. `ipLastSeen` is preferred over the asset's own `lastSeen` in
    // claimIsFresh, so this arm is the one that decides real assets — the case
    // above only reaches the fallback, and before this test nothing covered it.
    const old = new Date(Date.now() - 30 * 86_400_000);
    const id = await maclessAsset({ ipSource: "fortigate" });
    await prisma.asset.update({ where: { id }, data: { lastSeen: old } });
    await prisma.assetIpHistory.updateMany({ where: { assetId: id }, data: { lastSeen: old } });
    await arp(gateA, MAC);
    await fdb(sw, MAC, "port15");

    const r = await resolveIpUpstreamForMaclessAssets();
    expect(r.staleClaims).toBe(1);
    expect(r.candidates).toBe(0);
    const a = await prisma.asset.findUniqueOrThrow({ where: { id }, select: { lastSeenSwitch: true } });
    expect(a.lastSeenSwitch).toBeNull();
  });

  it("never touches an asset that already has a MAC", async () => {
    const id = await maclessAsset({ macAddress: MAC });
    await arp(gateA, MAC);
    await fdb(sw, MAC, "port15");

    const r = await resolveIpUpstreamForMaclessAssets();
    expect(r.candidates).toBe(0);
    const a = await prisma.asset.findUniqueOrThrow({ where: { id }, select: { lastSeenSwitch: true } });
    expect(a.lastSeenSwitch).toBeNull();
  });

  it("reaches the AP by the station's own recorded address when no ARP row exists", async () => {
    const id = await maclessAsset();
    await prisma.assetWirelessStation.create({ data: { apAssetId: ap, staMacAddr: MAC, staIpAddr: IP, source: "snmp" } });

    const r = await resolveIpUpstreamForMaclessAssets();
    expect(r.resolvedMac).toBe(0);
    expect(r.apStamps).toBe(1);
    const a = await prisma.asset.findUniqueOrThrow({ where: { id }, select: { lastSeenAp: true, lastSeenSwitch: true } });
    expect(a.lastSeenAp).toBe("AP-LOBBY-1");
    expect(a.lastSeenSwitch).toBeNull();
  });

  it("writes nothing on a second pass when nothing moved", async () => {
    await maclessAsset();
    await arp(gateA, MAC);
    await fdb(sw, MAC, "port15");
    await resolveIpUpstreamForMaclessAssets();
    const again = await resolveIpUpstreamForMaclessAssets();
    expect(again.switchStamps).toBe(0);
    expect(again.apStamps).toBe(0);
    const events = await prisma.event.count({ where: { actor: "system:upstream-chain" } });
    expect(events).toBe(1);
  });
});
