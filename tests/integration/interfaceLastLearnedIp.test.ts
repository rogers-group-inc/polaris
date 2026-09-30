/**
 * tests/integration/interfaceLastLearnedIp.test.ts
 *
 * AssetInterface.lastLearnedIp survives persistInterfaceRows' delete-replace.
 *
 * Every full scrape deletes a device's interface rows and recreates them, so a
 * new column is wiped on the next pass unless the writer carries it forward —
 * the failure the unit tests cannot see, because it lives in the transaction.
 * Pinned here against a real database: the address is learned, carried through
 * 0.0.0.0 scrapes, refreshed, forgotten after 30 days, and never invented for a
 * port that was never addressed.
 */

import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import { persistInterfaces, LAST_LEARNED_IP_TTL_MS } from "../../src/services/interfaceInventoryService.js";
import type { InterfaceSample } from "../../src/services/monitoringService.js";

const HOSTNAME = "iface-last-learned-test";
const DAY = 86_400_000;
let assetId = "";

const wipe = () => prisma.asset.deleteMany({ where: { hostname: { startsWith: HOSTNAME } } });
const port = (ifName: string, ipAddress: string | undefined): InterfaceSample =>
  ({ ifName, adminStatus: "up", operStatus: ipAddress && ipAddress !== "0.0.0.0" ? "up" : "down", ifType: "physical", ...(ipAddress !== undefined ? { ipAddress } : {}) });
const row = async (ifName: string) =>
  prisma.assetInterface.findFirstOrThrow({ where: { assetId, ifName }, select: { ipAddress: true, lastLearnedIp: true, lastLearnedIpAt: true } });

dbDescribe("interface last learned IP", () => {
  beforeAll(wipe);
  afterAll(wipe);
  beforeEach(async () => {
    await wipe();
    assetId = (await prisma.asset.create({ data: { hostname: HOSTNAME, assetType: "firewall", status: "active" } })).id;
  });

  it("learns, carries through 0.0.0.0, and refreshes across delete-replace passes", async () => {
    const t0 = new Date(Date.now() - 3 * DAY);
    await persistInterfaces(assetId, [port("wan1", "203.0.113.10/29"), port("wan2", "0.0.0.0")], t0);
    expect(await row("wan1")).toMatchObject({ lastLearnedIp: "203.0.113.10", lastLearnedIpAt: t0 });
    expect((await row("wan2")).lastLearnedIp).toBeNull();

    // The link drops and DHCP releases: the port reads 0.0.0.0 and keeps the lease it had.
    const t1 = new Date(Date.now() - 2 * DAY);
    await persistInterfaces(assetId, [port("wan1", "0.0.0.0 0.0.0.0"), port("wan2", "0.0.0.0")], t1);
    expect(await row("wan1")).toMatchObject({ ipAddress: "0.0.0.0 0.0.0.0", lastLearnedIp: "203.0.113.10", lastLearnedIpAt: t0 });
    expect((await row("wan2")).lastLearnedIp).toBeNull();

    // A pass that collected no address at all keeps it too.
    const t2 = new Date(Date.now() - DAY);
    await persistInterfaces(assetId, [port("wan1", undefined)], t2);
    expect((await row("wan1")).lastLearnedIp).toBe("203.0.113.10");

    // It comes back with a new lease: refreshed.
    const t3 = new Date();
    await persistInterfaces(assetId, [port("wan1", "203.0.113.22")], t3);
    expect(await row("wan1")).toMatchObject({ lastLearnedIp: "203.0.113.22", lastLearnedIpAt: t3 });
  });

  it("is seeded by the migration from each port's current address, bare", async () => {
    const seenAt = new Date(Date.now() - DAY);
    await prisma.assetInterface.createMany({
      data: [
        { assetId, ifName: "wan1", ipAddress: "203.0.113.10/29", firstSeen: seenAt, lastSeen: seenAt },
        { assetId, ifName: "vlan40", ipAddress: "10.4.1.1 255.255.255.0", firstSeen: seenAt, lastSeen: seenAt },
        { assetId, ifName: "wan2", ipAddress: "0.0.0.0 0.0.0.0", firstSeen: seenAt, lastSeen: seenAt },
        { assetId, ifName: "port1", ipAddress: null, firstSeen: seenAt, lastSeen: seenAt },
      ],
    });
    // The seed statement exactly as the migration ships it.
    const sql = readFileSync(resolve("prisma/migrations/20260928000000_interface_last_learned_ip/migration.sql"), "utf8");
    // From the statement at the start of a line — a comment above it also says "UPDATE".
    const update = sql.slice(sql.search(/^UPDATE /m));
    await prisma.$executeRawUnsafe(update.replace(/;\s*$/, "") + ` AND "assetId" = '${assetId}'`);
    expect(await row("wan1")).toMatchObject({ lastLearnedIp: "203.0.113.10", lastLearnedIpAt: seenAt });
    expect((await row("vlan40")).lastLearnedIp).toBe("10.4.1.1");
    expect((await row("wan2")).lastLearnedIp).toBeNull();
    expect((await row("port1")).lastLearnedIp).toBeNull();
  });

  it("forgets the address once it is 30 days old", async () => {
    const learned = new Date(Date.now() - LAST_LEARNED_IP_TTL_MS - DAY);
    await persistInterfaces(assetId, [port("wan1", "203.0.113.10")], learned);
    await persistInterfaces(assetId, [port("wan1", "0.0.0.0")], new Date());
    expect(await row("wan1")).toMatchObject({ lastLearnedIp: null, lastLearnedIpAt: null });
  });
});
