/**
 * tests/unit/searchServiceIpsec.test.ts — the global search's `ipsec` group:
 * a FortiGate's phase-1 tunnels and the peers / VPN users connected through
 * them, found by tunnel name, remote gateway, peer id, user or overlay
 * address, each hit naming the gate it lives on and the far-end device when
 * Polaris knows it.
 *
 * The database is mocked; the SQL itself is proven by
 * tests/integration/searchIpsec.test.ts. What is pinned here is the SHAPE of
 * a hit (id, title, subtitle, status, context), the scope prefixes, the
 * permission gate, and that the far end is resolved in one batch and never
 * to the gate itself.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    $queryRaw: vi.fn(),
    assetIpsecConnection: { findMany: vi.fn() },
    ipBlock: { findMany: vi.fn(async () => []) },
    subnet: { findMany: vi.fn(async () => []) },
    reservation: { findMany: vi.fn(async () => []) },
    asset: { findMany: vi.fn(async () => []) },
    assetSource: { findMany: vi.fn(async () => []) },
    assetMacAddress: { findMany: vi.fn(async () => []) },
    assetAssociatedIp: { findMany: vi.fn(async () => []) },
    assetIpHistory: { findMany: vi.fn(async () => []) },
    assetFortigateSighting: { findMany: vi.fn(async () => []) },
  },
  resolveIpsToAssets: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/applicationMapService.js", () => ({ resolveIpsToAssets: h.resolveIpsToAssets }));
vi.mock("../../src/services/notificationService.js", () => ({ activeAlertSummaryByAsset: vi.fn(async () => new Map()) }));
vi.mock("../../src/services/discoveredHostnameService.js", () => ({ findAssetIdsByDiscoveredHostname: vi.fn(async () => new Map()) }));

import { searchAll } from "../../src/services/searchService.js";

const HUB = "11111111-1111-4111-8111-111111111111";
const SPOKE = "22222222-2222-4222-8222-222222222222";

const tunnelRow = (over: Record<string, unknown> = {}) => ({
  assetId: HUB, hostname: "HUB1", tunnelName: "Overlay-1", remoteGateway: "10.3.1.2",
  parentInterface: "wan1", status: "up", ...over,
});
const connRow = (over: Record<string, unknown> = {}) => ({
  assetId: HUB, name: "Overlay-1_0", kind: "advpn-spoke", parentTunnel: "Overlay-1", peerId: "SPK1-ISP1",
  userName: null, remoteGateway: "10.3.1.2", tunnelIp: "10.254.250.13", status: "up",
  asset: { id: HUB, hostname: "HUB1" }, ...over,
});

beforeEach(() => {
  h.prisma.$queryRaw.mockReset();
  h.prisma.assetIpsecConnection.findMany.mockReset();
  h.resolveIpsToAssets.mockReset();
  h.prisma.$queryRaw.mockResolvedValue([]);
  h.prisma.assetIpsecConnection.findMany.mockResolvedValue([]);
  h.resolveIpsToAssets.mockResolvedValue(new Map());
});

describe("searchAll — the ipsec group", () => {
  it("shapes a tunnel hit: the gate it lives on, the far end by name, the IPsec tab as its target", async () => {
    h.prisma.$queryRaw.mockResolvedValueOnce([tunnelRow()]);
    h.resolveIpsToAssets.mockResolvedValueOnce(new Map([["10.3.1.2", { id: SPOKE, hostname: "SPK1", ipAddress: "10.3.1.2", assetType: "firewall" }]]));
    const r = await searchAll("ipsec:Overlay");
    expect(r.ipsec).toHaveLength(1);
    expect(r.ipsec[0]).toMatchObject({
      type: "ipsec",
      id: `${HUB}|tunnel|Overlay-1`,
      title: "Overlay-1",
      subtitle: "tunnel on HUB1 — 10.3.1.2 → SPK1 — via wan1",
      status: { kind: "up", label: "Up" },
      context: { assetId: HUB, hostname: "HUB1", kind: "tunnel", tunnelName: "Overlay-1", peerAssetId: SPOKE, peerHostname: "SPK1", tab: "ipsec" },
    });
    // The far ends resolve in ONE call for the whole hit set.
    expect(h.resolveIpsToAssets).toHaveBeenCalledTimes(1);
    expect(h.resolveIpsToAssets).toHaveBeenCalledWith(["10.3.1.2"]);
  });

  it("shapes a connection hit: the user leads for remote access, the peer id for a spoke, and the overlay address is shown", async () => {
    h.prisma.assetIpsecConnection.findMany.mockResolvedValueOnce([
      connRow(),
      connRow({ name: "ssl:1", kind: "ssl-vpn", parentTunnel: null, peerId: null, userName: "jdoe", remoteGateway: "203.0.113.7", tunnelIp: "10.212.134.200", status: "partial" }),
    ]);
    h.resolveIpsToAssets.mockResolvedValueOnce(new Map([["10.3.1.2", { id: SPOKE, hostname: "SPK1", ipAddress: "10.3.1.2", assetType: "firewall" }]]));
    const r = await searchAll("ipsec:1");
    expect(r.ipsec.map((x) => x.title)).toEqual(["Overlay-1_0 — SPK1-ISP1", "jdoe (ssl:1)"]);
    expect(r.ipsec[0].subtitle).toBe("ADVPN spoke on HUB1 via Overlay-1 — 10.3.1.2 → SPK1 — overlay 10.254.250.13");
    expect(r.ipsec[0].id).toBe(`${HUB}|conn|Overlay-1_0`);
    expect(r.ipsec[1].subtitle).toBe("SSL-VPN user on HUB1 — 203.0.113.7 — overlay 10.212.134.200");
    expect(r.ipsec[1].status).toEqual({ kind: "partial", label: "Partial" });
    expect(r.ipsec[1].context).toMatchObject({ assetId: HUB, kind: "ssl-vpn", userName: "jdoe", peerAssetId: null });
  });

  it("never names the gate as its own peer, and calls a 0.0.0.0 template what it is", async () => {
    h.prisma.$queryRaw.mockResolvedValueOnce([
      tunnelRow({ remoteGateway: "172.22.128.101" }),
      tunnelRow({ tunnelName: "Dialup-Template", remoteGateway: "0.0.0.0", parentInterface: null }),
    ]);
    h.resolveIpsToAssets.mockResolvedValueOnce(new Map([["172.22.128.101", { id: HUB, hostname: "HUB1", ipAddress: "172.22.128.101", assetType: "firewall" }]]));
    const r = await searchAll("ipsec:x");
    expect(r.ipsec[0].subtitle).toBe("tunnel on HUB1 — 172.22.128.101 — via wan1");
    expect(r.ipsec[0].context).toMatchObject({ peerAssetId: null });
    expect(r.ipsec[1].subtitle).toBe("tunnel on HUB1 — dial-up (any peer)");
    // 0.0.0.0 is never sent for resolution.
    expect(h.resolveIpsToAssets).toHaveBeenCalledWith(["172.22.128.101"]);
  });

  it("binds every term against the tunnel columns and the connection columns (AND of terms)", async () => {
    await searchAll("ipsec:overlay spk1");
    const [strings, ...values] = h.prisma.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toContain("asset_ipsec_tunnel_samples");
    expect(JSON.stringify(values)).toContain("%overlay%");
    expect(JSON.stringify(values)).toContain("%spk1%");
    const where = h.prisma.assetIpsecConnection.findMany.mock.calls[0][0].where;
    expect(where.AND).toHaveLength(2);
    expect(where.AND[0].OR.map((c: Record<string, unknown>) => Object.keys(c)[0]))
      .toEqual(["name", "parentTunnel", "peerId", "userName", "remoteGateway", "tunnelIp"]);
  });

  it("answers the `ipsec:` / `vpn:` / `v:` scopes with the ipsec group alone, at the scoped cap", async () => {
    for (const q of ["ipsec:Overlay", "vpn:Overlay", "v:Overlay", "IPSEC: Overlay"]) {
      h.prisma.$queryRaw.mockClear();
      h.prisma.assetIpsecConnection.findMany.mockClear();
      const r = await searchAll(q);
      expect(r.assets).toEqual([]);
      expect(r.sites).toEqual([]);
      expect(h.prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(h.prisma.assetIpsecConnection.findMany.mock.calls[0][0].take).toBe(200);
      expect(h.prisma.asset.findMany).not.toHaveBeenCalled();
    }
  });

  it("rides along with an unscoped search at the per-group cap, and is empty when the role cannot read assets", async () => {
    h.prisma.$queryRaw.mockResolvedValueOnce([tunnelRow()]);
    const r = await searchAll("Overlay", { blocks: false, subnets: false, reservations: false, assets: false, sites: false, ipsec: true });
    expect(r.ipsec).toHaveLength(1);
    expect(h.prisma.assetIpsecConnection.findMany.mock.calls[0][0].take).toBe(8);

    h.prisma.$queryRaw.mockClear();
    h.prisma.assetIpsecConnection.findMany.mockClear();
    const denied = await searchAll("Overlay", { blocks: false, subnets: false, reservations: false, assets: false, sites: false, ipsec: false });
    expect(denied.ipsec).toEqual([]);
    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(h.prisma.assetIpsecConnection.findMany).not.toHaveBeenCalled();
    // And the scoped form is refused the same way.
    expect((await searchAll("ipsec:Overlay", { blocks: true, subnets: true, reservations: true, assets: true, sites: true, ipsec: false })).ipsec).toEqual([]);
  });

  it("an older caller that passes no `ipsec` flag still gets the group (historical all-allowed behaviour)", async () => {
    h.prisma.$queryRaw.mockResolvedValueOnce([tunnelRow()]);
    const r = await searchAll("Overlay", { blocks: false, subnets: false, reservations: false, assets: false, sites: false });
    expect(r.ipsec).toHaveLength(1);
  });
});
