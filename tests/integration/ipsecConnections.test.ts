/**
 * tests/integration/ipsecConnections.test.ts
 *
 * The IPsec tab's storage and read contract:
 *
 *  - persistIpsecConnections replaces each half (IPsec children, SSL-VPN
 *    sessions) only when that half was read: an SSL read the token can't make
 *    must not wipe the ADVPN spokes, and vice versa;
 *  - firstSeen carries forward for the same peer on the same FortiOS child
 *    name, and RESETS when the slot is reused by a different peer
 *    ("Overlay-1_0" is an index, not an identity);
 *  - GET /assets/:id/ipsec nests nothing itself but returns the last full
 *    pass's tunnels beside the connections, each connection matched to an
 *    asset by its underlay address, then its overlay address — never to the
 *    gate itself;
 *  - GET /assets/:id/system-info still serves the tunnel list through the
 *    shared reader (its shape is what the System tab draws).
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { persistIpsecConnections } from "../../src/services/ipsecConnectionService.js";
import type { IpsecConnectionSample } from "../../src/utils/fortiosIpsec.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

let hubId = "";
let spokeId = "";

const spoke = (over: Partial<IpsecConnectionSample> = {}): IpsecConnectionSample => ({
  name: "Overlay-1_0", kind: "advpn-spoke", parentTunnel: "Overlay-1", peerId: "SPK1-ISP1", userName: null,
  remoteGateway: "10.3.1.2", tunnelIp: "10.254.250.13", status: "up",
  incomingBytes: 1000, outgoingBytes: 500, uptimeSec: 3600, ...over,
});
const sslUser = (over: Partial<IpsecConnectionSample> = {}): IpsecConnectionSample => ({
  name: "ssl:1", kind: "ssl-vpn", parentTunnel: null, peerId: null, userName: "jdoe",
  remoteGateway: "203.0.113.7", tunnelIp: "10.212.134.200", status: "up",
  incomingBytes: 10, outgoingBytes: 20, uptimeSec: 60, ...over,
});

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.assetIpsecConnection.deleteMany();
  await prisma.assetIpsecTunnelSample.deleteMany();
  await prisma.assetAssociatedIp.deleteMany();
  await prisma.assetSource.deleteMany();
  await prisma.asset.deleteMany();
  hubId = (await prisma.asset.create({
    data: { hostname: "HUB1", assetType: "firewall", status: "active", ipAddress: "172.22.128.101", monitored: true },
  })).id;
  spokeId = (await prisma.asset.create({
    data: { hostname: "SPK1", assetType: "firewall", status: "active", ipAddress: "172.22.128.103", monitored: true },
  })).id;
});

async function rows() {
  return prisma.assetIpsecConnection.findMany({ where: { assetId: hubId }, orderBy: { name: "asc" } });
}

d("persistIpsecConnections", () => {
  it("writes both halves and derives connectedSince from the reported uptime", async () => {
    const now = new Date("2026-10-09T12:00:00Z");
    expect(await persistIpsecConnections(hubId, { ipsec: [spoke()], sslVpn: [sslUser()] }, now)).toBe(2);
    const r = await rows();
    expect(r.map((x) => x.kind)).toEqual(["advpn-spoke", "ssl-vpn"]);
    expect(r[0].connectedSince?.toISOString()).toBe("2026-10-09T11:00:00.000Z");
    expect(Number(r[0].incomingBytes)).toBe(1000);
  });

  it("an unread SSL half keeps its rows while the IPsec half is replaced", async () => {
    await persistIpsecConnections(hubId, { ipsec: [spoke()], sslVpn: [sslUser()] }, new Date());
    await persistIpsecConnections(hubId, { ipsec: [], sslVpn: undefined }, new Date());
    expect((await rows()).map((x) => x.name)).toEqual(["ssl:1"]);
  });

  it("an unread IPsec half keeps its rows while SSL is replaced", async () => {
    await persistIpsecConnections(hubId, { ipsec: [spoke()], sslVpn: [sslUser()] }, new Date());
    await persistIpsecConnections(hubId, { ipsec: undefined, sslVpn: [] }, new Date());
    expect((await rows()).map((x) => x.name)).toEqual(["Overlay-1_0"]);
  });

  it("neither half read is a no-op", async () => {
    await persistIpsecConnections(hubId, { ipsec: [spoke()] }, new Date());
    expect(await persistIpsecConnections(hubId, {}, new Date())).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  it("carries firstSeen for the same peer and resets it when the slot changes hands", async () => {
    const t1 = new Date("2026-10-09T10:00:00Z");
    const t2 = new Date("2026-10-09T10:10:00Z");
    const t3 = new Date("2026-10-09T10:20:00Z");
    await persistIpsecConnections(hubId, { ipsec: [spoke()] }, t1);
    await persistIpsecConnections(hubId, { ipsec: [spoke()] }, t2);
    let [r] = await rows();
    expect(r.firstSeen.toISOString()).toBe(t1.toISOString());
    expect(r.lastSeen.toISOString()).toBe(t2.toISOString());
    // Same child name, different spoke.
    await persistIpsecConnections(hubId, { ipsec: [spoke({ peerId: "SPK2-ISP1", remoteGateway: "10.4.1.2" })] }, t3);
    [r] = await rows();
    expect(r.firstSeen.toISOString()).toBe(t3.toISOString());
  });

  it("caps a huge remote-access hub at 5000 rows without overrunning the bind-parameter limit", async () => {
    const many = Array.from({ length: 5001 }, (_, i) =>
      spoke({ name: `FCT_${i}`, kind: "remote-access", userName: `u${i}`, peerId: null, remoteGateway: `198.51.${i >> 8}.${i & 255}` }));
    expect(await persistIpsecConnections(hubId, { ipsec: many }, new Date())).toBe(5000);
    expect(await prisma.assetIpsecConnection.count({ where: { assetId: hubId } })).toBe(5000);
  });

  it("dedupes a repeated name instead of aborting the scrape", async () => {
    expect(await persistIpsecConnections(hubId, { ipsec: [spoke(), spoke()] }, new Date())).toBe(1);
  });
});

d("GET /assets/:id/ipsec", () => {
  it("returns tunnels + connections, matching peers by underlay then overlay address, never the gate itself", async () => {
    const at = new Date();
    await prisma.asset.update({ where: { id: hubId }, data: { lastSystemInfoAt: at } });
    await prisma.assetIpsecTunnelSample.create({
      data: { assetId: hubId, timestamp: at, cadence: "slow", tunnelName: "Overlay-1", parentInterface: "wan1", remoteGateway: "0.0.0.0", status: "dynamic" },
    });
    // SPK1's underlay address is a secondary IP of the spoke.
    await prisma.assetAssociatedIp.create({ data: { assetId: spokeId, ip: "10.3.1.2", source: "interface" } as any });
    await persistIpsecConnections(hubId, {
      ipsec: [
        spoke(),
        // Unknown underlay, overlay is the hub's own address → no match.
        spoke({ name: "Overlay-1_1", peerId: null, remoteGateway: "198.51.100.9", tunnelIp: "172.22.128.101" }),
      ],
    }, at);

    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${hubId}/ipsec`);
    expect(res.status).toBe(200);
    expect(res.body.tunnels.map((t: any) => [t.tunnelName, t.status])).toEqual([["Overlay-1", "dynamic"]]);
    const byName = Object.fromEntries(res.body.connections.map((c: any) => [c.name, c]));
    expect(byName["Overlay-1_0"].matchedAsset).toMatchObject({ id: spokeId, hostname: "SPK1" });
    expect(byName["Overlay-1_1"].matchedAsset).toBeNull();
    expect(res.body.collectedAt).toBeTruthy();
    expect("pollIntervalSec" in res.body).toBe(true);
  });

  it("system-info still serves the full-pass tunnel batch, not the pinned fast batch", async () => {
    const full = new Date(Date.now() - 60_000);
    const fast = new Date();
    await prisma.asset.update({ where: { id: hubId }, data: { lastSystemInfoAt: full } });
    await prisma.assetIpsecTunnelSample.createMany({ data: [
      { assetId: hubId, timestamp: full, cadence: "slow", tunnelName: "H2H-1", status: "up", incomingBytes: BigInt(5) },
      { assetId: hubId, timestamp: full, cadence: "slow", tunnelName: "Overlay-1", status: "dynamic" },
      { assetId: hubId, timestamp: fast, cadence: "fast", tunnelName: "H2H-1", status: "up" },
    ] });
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${hubId}/system-info`);
    expect(res.status).toBe(200);
    expect(res.body.ipsecTunnels.map((t: any) => t.tunnelName)).toEqual(["H2H-1", "Overlay-1"]);
    expect(res.body.ipsecTunnels[0].incomingBytes).toBe(5);
  });
});
