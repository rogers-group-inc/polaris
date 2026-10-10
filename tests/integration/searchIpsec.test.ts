/**
 * tests/integration/searchIpsec.test.ts — the global search's `ipsec` group
 * over the real database: the tunnel query's SQL (DISTINCT ON the newest row
 * per tunnel at or after the gate's last full pass, so a tunnel that
 * disappeared from the gate's config is not a hit), the connection search,
 * the far-end resolution, and the route gate.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { persistIpsecConnections } from "../../src/services/ipsecConnectionService.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

let hubId = "";
let spokeId = "";
const PASS = new Date("2026-10-09T12:00:00Z");
const EARLIER = new Date("2026-10-09T11:00:00Z");

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
    data: { hostname: "HUB1", assetType: "firewall", status: "active", ipAddress: "172.22.128.101", monitored: true, lastSystemInfoAt: PASS },
  })).id;
  spokeId = (await prisma.asset.create({
    data: { hostname: "SPK1", assetType: "firewall", status: "active", ipAddress: "10.3.1.2", monitored: true },
  })).id;
  await prisma.assetIpsecTunnelSample.createMany({
    data: [
      // The last full pass: two tunnels, one of them a dial-up template.
      { assetId: hubId, timestamp: PASS, tunnelName: "Overlay-1", parentInterface: "wan1", remoteGateway: "10.3.1.2", status: "up", cadence: "slow" },
      { assetId: hubId, timestamp: PASS, tunnelName: "Dialup-Overlay", parentInterface: "wan1", remoteGateway: "0.0.0.0", status: "down", cadence: "slow" },
      // A pinned tunnel's fast re-walk after the pass: the newest row wins.
      { assetId: hubId, timestamp: new Date(PASS.getTime() + 60_000), tunnelName: "Overlay-1", parentInterface: "wan1", remoteGateway: "10.3.1.2", status: "partial", cadence: "fast" },
      // A tunnel the operator deleted before the last pass: stale, never a hit.
      { assetId: hubId, timestamp: EARLIER, tunnelName: "Overlay-OLD", parentInterface: "wan1", remoteGateway: "10.9.9.9", status: "up", cadence: "slow" },
    ],
  });
  await persistIpsecConnections(hubId, {
    ipsec: [{ name: "Overlay-1_0", kind: "advpn-spoke", parentTunnel: "Overlay-1", peerId: "SPK1-ISP1", userName: null, remoteGateway: "10.3.1.2", tunnelIp: "10.254.250.13", status: "up", incomingBytes: 1, outgoingBytes: 1, uptimeSec: 60 }],
    sslVpn: [{ name: "ssl:1", kind: "ssl-vpn", parentTunnel: null, peerId: null, userName: "jdoe", remoteGateway: "203.0.113.7", tunnelIp: "10.212.134.200", status: "up", incomingBytes: 1, outgoingBytes: 1, uptimeSec: 60 }],
  }, PASS);
});

d("GET /api/v1/search — the ipsec group", () => {
  it("finds a tunnel by name with its newest state, the gate it lives on and the far-end device", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/search").query({ q: "ipsec:Overlay-1" });
    expect(res.status).toBe(200);
    const ids = res.body.ipsec.map((h: { id: string }) => h.id);
    expect(ids).toContain(`${hubId}|tunnel|Overlay-1`);
    expect(ids).toContain(`${hubId}|conn|Overlay-1_0`);
    expect(ids).not.toContain(`${hubId}|tunnel|Overlay-OLD`);
    const tunnel = res.body.ipsec.find((h: { id: string }) => h.id === `${hubId}|tunnel|Overlay-1`);
    expect(tunnel.status).toEqual({ kind: "partial", label: "Partial" });
    expect(tunnel.subtitle).toBe("tunnel on HUB1 — 10.3.1.2 → SPK1 — via wan1");
    expect(tunnel.context).toMatchObject({ assetId: hubId, peerAssetId: spokeId, peerHostname: "SPK1", tab: "ipsec" });
  });

  it("a stale tunnel from before the gate's last full pass is not a hit", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/search").query({ q: "Overlay-OLD" });
    expect(res.status).toBe(200);
    expect(res.body.ipsec).toEqual([]);
  });

  it("an address finds the tunnel and the peer connected from it, unscoped, beside the asset that holds it", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/search").query({ q: "10.3.1.2" });
    expect(res.status).toBe(200);
    expect(res.body.assets.map((h: { id: string }) => h.id)).toContain(spokeId);
    expect(res.body.ipsec.map((h: { id: string }) => h.id).sort()).toEqual([`${hubId}|conn|Overlay-1_0`, `${hubId}|tunnel|Overlay-1`].sort());
  });

  it("a VPN user is found by name and opens the gate", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/search").query({ q: "vpn:jdoe" });
    expect(res.status).toBe(200);
    expect(res.body.ipsec).toHaveLength(1);
    expect(res.body.ipsec[0]).toMatchObject({ title: "jdoe (ssl:1)", context: { assetId: hubId, kind: "ssl-vpn" } });
    expect(res.body.ipsec[0].subtitle).toBe("SSL-VPN user on HUB1 — 203.0.113.7 — overlay 10.212.134.200");
  });

  it("a dial-up template says so instead of naming 0.0.0.0 as a peer", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/search").query({ q: "ipsec:Dialup" });
    expect(res.body.ipsec[0].subtitle).toBe("tunnel on HUB1 — dial-up (any peer) — via wan1");
    expect(res.body.ipsec[0].context.peerAssetId).toBeNull();
  });
});
