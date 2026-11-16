/**
 * tests/unit/ipsecConnectionService.test.ts
 *
 * Own suite for src/services/ipsecConnectionService.ts — the asset IPsec
 * tab's data.
 *
 * Contract (change-impact entry):
 *   - each half (IPsec / SSL-VPN) is replaced only when it was read:
 *     `undefined` preserves, `[]` wipes, the delete scoped by kind;
 *   - delete + chunked createMany in ONE transaction (1000 per chunk), capped
 *     at 5000 rows with a warn;
 *   - firstSeen carries only for the same name AND the same peer;
 *   - tunnels anchored to the last FULL pass, clamped, falling back to the
 *     newest batch;
 *   - peers matched to assets at READ time, underlay first, never the gate
 *     itself; a dial-up template's 0.0.0.0 is never resolved.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  resolveIpsToAssets: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/applicationMapService.js", () => ({ resolveIpsToAssets: h.resolveIpsToAssets }));
vi.mock("../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() } }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  persistIpsecConnections,
  readLatestIpsecTunnels,
  readAssetIpsec,
} from "../../src/services/ipsecConnectionService.js";
import type { IpsecConnectionSample } from "../../src/utils/fortiosIpsec.js";

const NOW = new Date("2026-11-14T12:00:00Z");
const EARLIER = new Date("2026-11-10T08:00:00Z");

function conn(over: Partial<IpsecConnectionSample> = {}): IpsecConnectionSample {
  return {
    name: "Overlay-1_0", kind: "advpn-spoke", parentTunnel: "Overlay-1", peerId: "spoke-1", userName: null,
    remoteGateway: "203.0.113.10", tunnelIp: "10.255.0.2", status: "up",
    incomingBytes: 100, outgoingBytes: 200, uptimeSec: 60, ...over,
  };
}

/** Every row handed to createMany, flattened across chunks. */
function created(): Array<Record<string, unknown>> {
  return stubbed(prisma.assetIpsecConnection.createMany).mock.calls.flatMap((c) => c[0].data);
}

function deleteScope(): unknown {
  return stubbed(prisma.assetIpsecConnection.deleteMany).mock.calls[0]?.[0].where;
}

beforeEach(() => {
  resetDbStub();
  h.resolveIpsToAssets.mockReset().mockResolvedValue(new Map());
  h.warn.mockReset();
  stubbed(prisma.assetIpsecConnection.findMany).mockResolvedValue([]);
  stubbed(prisma.assetIpsecConnection.deleteMany).mockResolvedValue({ count: 0 });
  stubbed(prisma.assetIpsecConnection.createMany).mockImplementation(async (a: { data: unknown[] }) => ({ count: a.data.length }));
});

// ─── persistIpsecConnections ───────────────────────────────────────────────

describe("persistIpsecConnections — which halves are replaced", () => {
  it("does nothing at all when neither half was read", async () => {
    expect(await persistIpsecConnections("fw1", {}, NOW)).toBe(0);
    expect(prisma.assetIpsecConnection.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("replaces every row when both halves were read", async () => {
    const n = await persistIpsecConnections("fw1", { ipsec: [conn()], sslVpn: [conn({ name: "ssl:0", kind: "ssl-vpn", parentTunnel: null })] }, NOW);
    expect(n).toBe(2);
    expect(deleteScope()).toEqual({ assetId: "fw1" });
    expect(created().map((r) => r.name)).toEqual(["Overlay-1_0", "ssl:0"]);
  });

  it("an IPsec-only read deletes only the non-SSL rows", async () => {
    await persistIpsecConnections("fw1", { ipsec: [conn()] }, NOW);
    expect(deleteScope()).toEqual({ assetId: "fw1", kind: { not: "ssl-vpn" } });
  });

  it("an SSL-only read deletes only the SSL rows", async () => {
    await persistIpsecConnections("fw1", { sslVpn: [conn({ name: "ssl:0", kind: "ssl-vpn" })] }, NOW);
    expect(deleteScope()).toEqual({ assetId: "fw1", kind: "ssl-vpn" });
  });

  it("an empty half that WAS read wipes its rows and inserts nothing", async () => {
    const n = await persistIpsecConnections("fw1", { ipsec: [] }, NOW);
    expect(n).toBe(0);
    expect(deleteScope()).toEqual({ assetId: "fw1", kind: { not: "ssl-vpn" } });
    expect(prisma.assetIpsecConnection.createMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("runs the delete and the inserts in one transaction, with skipDuplicates", async () => {
    await persistIpsecConnections("fw1", { ipsec: [conn()] }, NOW);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(stubbed(prisma.$transaction).mock.calls[0][0]).toHaveLength(2);
    expect(stubbed(prisma.assetIpsecConnection.createMany).mock.calls[0][0].skipDuplicates).toBe(true);
  });

  // Was a bug until 2026-11-16: it returned data.length, counting rows skipDuplicates dropped.
  it("returns the rows the inserts actually wrote", async () => {
    stubbed(prisma.assetIpsecConnection.createMany).mockResolvedValueOnce({ count: 1 });
    const n = await persistIpsecConnections("fw1", { ipsec: [conn({ name: "a" }), conn({ name: "b" })] }, NOW);
    expect(n).toBe(1);
  });
});

describe("persistIpsecConnections — row shape", () => {
  it("maps every column, rounds bytes to BigInt, and derives connectedSince from uptime", async () => {
    await persistIpsecConnections("fw1", { ipsec: [conn({ incomingBytes: 1234.6, outgoingBytes: 0, uptimeSec: 90 })] }, NOW);
    const [row] = created();
    expect(row).toMatchObject({
      assetId: "fw1", name: "Overlay-1_0", kind: "advpn-spoke", parentTunnel: "Overlay-1", peerId: "spoke-1",
      userName: null, remoteGateway: "203.0.113.10", tunnelIp: "10.255.0.2", status: "up",
      incomingBytes: 1235n, outgoingBytes: 0n,
      connectedSince: new Date(NOW.getTime() - 90_000),
      firstSeen: NOW, lastSeen: NOW,
    });
    expect(typeof row.id).toBe("string");
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("stores null bytes for null / non-finite counters", async () => {
    await persistIpsecConnections("fw1", { ipsec: [conn({ incomingBytes: null, outgoingBytes: Number.NaN })] }, NOW);
    expect(created()[0]).toMatchObject({ incomingBytes: null, outgoingBytes: null });
  });

  it("stores connectedSince null for a null or negative uptime, and NOW for zero", async () => {
    await persistIpsecConnections("fw1", { ipsec: [
      conn({ name: "a", uptimeSec: null }),
      conn({ name: "b", uptimeSec: -5 }),
      conn({ name: "c", uptimeSec: 0 }),
    ] }, NOW);
    const rows = created();
    expect(rows[0].connectedSince).toBeNull();
    expect(rows[1].connectedSince).toBeNull();
    expect(rows[2].connectedSince).toEqual(NOW);
  });

  it("keeps IPv6 peer addresses verbatim", async () => {
    await persistIpsecConnections("fw1", { ipsec: [conn({ remoteGateway: "2001:db8::10", tunnelIp: "fd00::2" })] }, NOW);
    expect(created()[0]).toMatchObject({ remoteGateway: "2001:db8::10", tunnelIp: "fd00::2" });
  });

  it("drops a duplicate name, first one wins (IPsec before SSL)", async () => {
    const n = await persistIpsecConnections("fw1", {
      ipsec: [conn({ name: "x", peerId: "first" }), conn({ name: "x", peerId: "second" })],
      sslVpn: [conn({ name: "x", kind: "ssl-vpn", peerId: "ssl" })],
    }, NOW);
    expect(n).toBe(1);
    expect(created()).toHaveLength(1);
    expect(created()[0].peerId).toBe("first");
  });
});

describe("persistIpsecConnections — firstSeen carry", () => {
  it("carries firstSeen for the same name with the same gateway, peer id and user", async () => {
    stubbed(prisma.assetIpsecConnection.findMany).mockResolvedValue([
      { name: "Overlay-1_0", remoteGateway: "203.0.113.10", peerId: "spoke-1", userName: null, firstSeen: EARLIER },
    ]);
    await persistIpsecConnections("fw1", { ipsec: [conn()] }, NOW);
    expect(created()[0].firstSeen).toEqual(EARLIER);
    expect(prisma.assetIpsecConnection.findMany).toHaveBeenCalledWith({
      where: { assetId: "fw1" },
      select: { name: true, remoteGateway: true, peerId: true, userName: true, firstSeen: true },
    });
  });

  it.each([
    ["remoteGateway", { remoteGateway: "198.51.100.1" }],
    ["peerId", { peerId: "spoke-2" }],
    ["userName", { userName: "alice" }],
  ])("resets firstSeen when the slot's %s changed (a different spoke in a reused slot)", async (_f, change) => {
    stubbed(prisma.assetIpsecConnection.findMany).mockResolvedValue([
      { name: "Overlay-1_0", remoteGateway: "203.0.113.10", peerId: "spoke-1", userName: null, firstSeen: EARLIER },
    ]);
    await persistIpsecConnections("fw1", { ipsec: [conn(change)] }, NOW);
    expect(created()[0].firstSeen).toEqual(NOW);
  });

  it("stamps NOW on a brand-new name", async () => {
    stubbed(prisma.assetIpsecConnection.findMany).mockResolvedValue([
      { name: "other", remoteGateway: "203.0.113.10", peerId: "spoke-1", userName: null, firstSeen: EARLIER },
    ]);
    await persistIpsecConnections("fw1", { ipsec: [conn()] }, NOW);
    expect(created()[0].firstSeen).toEqual(NOW);
  });
});

describe("persistIpsecConnections — scale", () => {
  it("chunks inserts at 1000 rows inside the one transaction", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => conn({ name: `c${i}` }));
    const n = await persistIpsecConnections("fw1", { ipsec: many }, NOW);
    expect(n).toBe(2500);
    const sizes = stubbed(prisma.assetIpsecConnection.createMany).mock.calls.map((c) => c[0].data.length);
    expect(sizes).toEqual([1000, 1000, 500]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("caps at 5000 rows with a loud warn", async () => {
    const many = Array.from({ length: 5003 }, (_, i) => conn({ name: `c${i}` }));
    const n = await persistIpsecConnections("fw1", { ipsec: many }, NOW);
    expect(n).toBe(5000);
    expect(created()).toHaveLength(5000);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0][0]).toMatchObject({ assetId: "fw1", reported: 5003, kept: 5000, dropped: 3 });
  });

  it("retries the transaction on a Postgres deadlock", async () => {
    const deadlock = Object.assign(new Error("deadlock"), { code: "40P01" });
    stubbed(prisma.$transaction).mockRejectedValueOnce(deadlock);
    const n = await persistIpsecConnections("fw1", { ipsec: [conn()] }, NOW);
    expect(n).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("surfaces a non-deadlock failure untouched", async () => {
    stubbed(prisma.$transaction).mockRejectedValueOnce(new Error("disk full"));
    await expect(persistIpsecConnections("fw1", { ipsec: [conn()] }, NOW)).rejects.toThrow("disk full");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

// ─── readLatestIpsecTunnels ────────────────────────────────────────────────

const T_LATEST = new Date("2026-11-14T12:05:00Z");
const T_FULL = new Date("2026-11-14T12:00:00Z");

function tunnelRow(over: Record<string, unknown> = {}) {
  return {
    timestamp: T_FULL, tunnelName: "HQ", parentInterface: "wan1", remoteGateway: "198.51.100.1",
    status: "up", incomingBytes: 10n, outgoingBytes: 20n, proxyIdCount: 2, assetId: "fw1", ...over,
  };
}

describe("readLatestIpsecTunnels", () => {
  it("answers [] when the asset has no tunnel samples", async () => {
    stubbed(prisma.assetIpsecTunnelSample.findFirst).mockResolvedValue(null);
    expect(await readLatestIpsecTunnels("fw1", T_FULL)).toEqual([]);
    expect(prisma.assetIpsecTunnelSample.findMany).not.toHaveBeenCalled();
  });

  it("anchors on lastSystemInfoAt (the full pass), not the newest pinned-only batch", async () => {
    stubbed(prisma.assetIpsecTunnelSample.findFirst).mockResolvedValue({ timestamp: T_LATEST });
    stubbed(prisma.assetIpsecTunnelSample.findMany).mockResolvedValue([tunnelRow()]);

    const rows = await readLatestIpsecTunnels("fw1", T_FULL);

    expect(prisma.assetIpsecTunnelSample.findMany).toHaveBeenCalledWith({
      where: { assetId: "fw1", timestamp: T_FULL },
      orderBy: { tunnelName: "asc" },
    });
    expect(rows).toEqual([{
      timestamp: T_FULL, tunnelName: "HQ", parentInterface: "wan1", remoteGateway: "198.51.100.1",
      status: "up", incomingBytes: 10, outgoingBytes: 20, proxyIdCount: 2,
    }]);
  });

  it("uses the newest batch when there is no lastSystemInfoAt", async () => {
    stubbed(prisma.assetIpsecTunnelSample.findFirst).mockResolvedValue({ timestamp: T_LATEST });
    stubbed(prisma.assetIpsecTunnelSample.findMany).mockResolvedValue([]);
    await readLatestIpsecTunnels("fw1", null);
    expect(stubbed(prisma.assetIpsecTunnelSample.findMany).mock.calls[0][0].where.timestamp).toEqual(T_LATEST);
    // anchor === latest, so no second query
    expect(prisma.assetIpsecTunnelSample.findMany).toHaveBeenCalledTimes(1);
  });

  it("clamps an anchor ahead of the newest row (that pass's IPsec read failed)", async () => {
    stubbed(prisma.assetIpsecTunnelSample.findFirst).mockResolvedValue({ timestamp: T_FULL });
    stubbed(prisma.assetIpsecTunnelSample.findMany).mockResolvedValue([tunnelRow()]);
    await readLatestIpsecTunnels("fw1", T_LATEST);
    expect(stubbed(prisma.assetIpsecTunnelSample.findMany).mock.calls[0][0].where.timestamp).toEqual(T_FULL);
  });

  it("falls back to the newest batch when the anchor batch is empty", async () => {
    stubbed(prisma.assetIpsecTunnelSample.findFirst).mockResolvedValue({ timestamp: T_LATEST });
    stubbed(prisma.assetIpsecTunnelSample.findMany)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([tunnelRow({ timestamp: T_LATEST, tunnelName: "PINNED" })]);

    const rows = await readLatestIpsecTunnels("fw1", T_FULL);

    expect(prisma.assetIpsecTunnelSample.findMany).toHaveBeenCalledTimes(2);
    expect(stubbed(prisma.assetIpsecTunnelSample.findMany).mock.calls[1][0].where.timestamp).toEqual(T_LATEST);
    expect(rows.map((r) => r.tunnelName)).toEqual(["PINNED"]);
  });

  it("maps null byte counters to null", async () => {
    stubbed(prisma.assetIpsecTunnelSample.findFirst).mockResolvedValue({ timestamp: T_FULL });
    stubbed(prisma.assetIpsecTunnelSample.findMany).mockResolvedValue([tunnelRow({ incomingBytes: null, outgoingBytes: null })]);
    const [row] = await readLatestIpsecTunnels("fw1", T_FULL);
    expect(row.incomingBytes).toBeNull();
    expect(row.outgoingBytes).toBeNull();
  });
});

// ─── readAssetIpsec ────────────────────────────────────────────────────────

function connRow(over: Record<string, unknown> = {}) {
  return {
    id: "c1", assetId: "fw1", name: "Overlay-1_0", kind: "advpn-spoke", parentTunnel: "Overlay-1",
    peerId: "spoke-1", userName: null, remoteGateway: "203.0.113.10", tunnelIp: "10.255.0.2", status: "up",
    incomingBytes: 5n, outgoingBytes: 6n, connectedSince: EARLIER, firstSeen: EARLIER, lastSeen: NOW, ...over,
  };
}

const SPOKE = { id: "spoke-asset", hostname: "SPOKE-1", ipAddress: "203.0.113.10", assetType: "firewall", extra: "dropped" };
const SELF = { id: "fw1", hostname: "HUB", ipAddress: "198.51.100.1", assetType: "firewall" };

function setup(opts: {
  asset?: Record<string, unknown> | null;
  tunnels?: Array<Record<string, unknown>>;
  conns?: Array<Record<string, unknown>>;
  twins?: Array<Record<string, unknown>>;
  resolved?: Array<[string, Record<string, unknown>]>;
}) {
  stubbed(prisma.asset.findUnique).mockResolvedValue(
    opts.asset === undefined ? { lastSystemInfoAt: T_FULL, monitoredIpsecTunnels: [], monitoredInterfaces: [] } : opts.asset,
  );
  const tunnels = opts.tunnels ?? [];
  stubbed(prisma.assetIpsecTunnelSample.findFirst).mockResolvedValue(tunnels.length ? { timestamp: T_FULL } : null);
  stubbed(prisma.assetIpsecTunnelSample.findMany).mockResolvedValue(tunnels);
  stubbed(prisma.assetIpsecConnection.findMany).mockResolvedValue(opts.conns ?? []);
  stubbed(prisma.assetInterface.findMany).mockResolvedValue(opts.twins ?? []);
  h.resolveIpsToAssets.mockResolvedValue(new Map(opts.resolved ?? []));
}

describe("readAssetIpsec", () => {
  it("answers an empty payload, without resolving, for a gate with nothing", async () => {
    setup({});
    expect(await readAssetIpsec("fw1")).toEqual({ tunnels: [], connections: [], collectedAt: null });
    expect(h.resolveIpsToAssets).not.toHaveBeenCalled();
    expect(prisma.assetInterface.findMany).not.toHaveBeenCalled();
  });

  it("orders connections by parent tunnel then name", async () => {
    setup({});
    await readAssetIpsec("fw1");
    expect(prisma.assetIpsecConnection.findMany).toHaveBeenCalledWith({
      where: { assetId: "fw1" },
      orderBy: [{ parentTunnel: "asc" }, { name: "asc" }],
    });
  });

  it("tolerates a missing asset row (no anchor, no pins)", async () => {
    setup({ asset: null, tunnels: [tunnelRow()] });
    const out = await readAssetIpsec("fw1");
    expect(out.tunnels[0]).toMatchObject({ pinned: false, interfacePinned: false });
  });

  it("attaches each tunnel's interface-twin overlay address and both pin states", async () => {
    setup({
      asset: { lastSystemInfoAt: T_FULL, monitoredIpsecTunnels: ["HQ"], monitoredInterfaces: ["DC"] },
      tunnels: [tunnelRow({ tunnelName: "DC" }), tunnelRow({ tunnelName: "HQ" }), tunnelRow({ tunnelName: "DIAL", remoteGateway: "0.0.0.0" })],
      twins: [{ ifName: "HQ", ipAddress: "10.255.0.1" }, { ifName: "DIAL", ipAddress: "0.0.0.0" }],
    });

    const out = await readAssetIpsec("fw1");

    expect(prisma.assetInterface.findMany).toHaveBeenCalledWith({
      where: { assetId: "fw1", ifName: { in: ["DC", "HQ", "DIAL"] } },
      select: { ifName: true, ipAddress: true },
    });
    const byName = Object.fromEntries(out.tunnels.map((t) => [t.tunnelName, t]));
    expect(byName.HQ).toMatchObject({ overlayIp: "10.255.0.1", pinned: true, interfacePinned: false });
    expect(byName.DC).toMatchObject({ overlayIp: null, pinned: false, interfacePinned: true });
    // An unaddressed twin is not an overlay address.
    expect(byName.DIAL.overlayIp).toBeNull();
  });

  it("resolves every usable address once — underlays, overlays, tunnel gateways — never 0.0.0.0", async () => {
    setup({
      tunnels: [tunnelRow({ remoteGateway: "198.51.100.7" }), tunnelRow({ tunnelName: "DIAL", remoteGateway: "0.0.0.0" })],
      conns: [connRow(), connRow({ name: "b", remoteGateway: "0.0.0.0", tunnelIp: null })],
    });

    await readAssetIpsec("fw1");

    expect(h.resolveIpsToAssets).toHaveBeenCalledTimes(1);
    expect([...h.resolveIpsToAssets.mock.calls[0][0]].sort()).toEqual(["10.255.0.2", "198.51.100.7", "203.0.113.10"]);
  });

  it("matches a site-to-site tunnel's far end by its remote gateway, never the gate itself", async () => {
    setup({
      tunnels: [tunnelRow({ tunnelName: "TO-SPOKE", remoteGateway: "203.0.113.10" }), tunnelRow({ tunnelName: "LOOP", remoteGateway: "198.51.100.1" })],
      resolved: [["203.0.113.10", SPOKE], ["198.51.100.1", SELF]],
    });
    const out = await readAssetIpsec("fw1");
    const byName = Object.fromEntries(out.tunnels.map((t) => [t.tunnelName, t]));
    expect(byName["TO-SPOKE"].matchedAsset).toEqual({ id: "spoke-asset", hostname: "SPOKE-1", ipAddress: "203.0.113.10", assetType: "firewall" });
    expect(byName.LOOP.matchedAsset).toBeNull();
  });

  it("matches a peer by its underlay first, then its overlay; a self-resolution is skipped", async () => {
    const OVERLAY_ASSET = { id: "ov", hostname: "OV", ipAddress: "10.255.0.2", assetType: "server" };
    setup({
      conns: [
        connRow({ name: "under" }),
        connRow({ name: "nat", remoteGateway: "192.0.2.99" }),
        connRow({ name: "self", remoteGateway: "198.51.100.1" }),
        connRow({ name: "none", remoteGateway: "192.0.2.50", tunnelIp: "10.9.9.9" }),
      ],
      resolved: [["203.0.113.10", SPOKE], ["10.255.0.2", OVERLAY_ASSET], ["198.51.100.1", SELF]],
    });

    const out = await readAssetIpsec("fw1");
    const byName = Object.fromEntries(out.connections.map((c) => [c.name, c]));

    expect(byName.under.matchedAsset?.id).toBe("spoke-asset");
    expect(byName.under.matchedAsset).not.toHaveProperty("extra");
    expect(byName.nat.matchedAsset?.id).toBe("ov");
    // The gate's own underlay is skipped; the overlay still links.
    expect(byName.self.matchedAsset?.id).toBe("ov");
    expect(byName.none.matchedAsset).toBeNull();
  });

  it("maps connection BigInt counters to numbers and passes the rest through", async () => {
    setup({ conns: [connRow({ incomingBytes: null })] });
    const [c] = (await readAssetIpsec("fw1")).connections;
    expect(c).toEqual({
      name: "Overlay-1_0", kind: "advpn-spoke", parentTunnel: "Overlay-1", peerId: "spoke-1", userName: null,
      remoteGateway: "203.0.113.10", tunnelIp: "10.255.0.2", status: "up", incomingBytes: null, outgoingBytes: 6,
      connectedSince: EARLIER, firstSeen: EARLIER, lastSeen: NOW, matchedAsset: null,
    });
  });

  it("reports collectedAt as the newest connection lastSeen", async () => {
    const later = new Date(NOW.getTime() + 60_000);
    setup({ conns: [connRow({ name: "a", lastSeen: NOW }), connRow({ name: "b", lastSeen: later }), connRow({ name: "c", lastSeen: EARLIER })] });
    expect((await readAssetIpsec("fw1")).collectedAt).toEqual(later);
  });

  it("falls back to the tunnel batch stamp for collectedAt when there are no connections", async () => {
    setup({ tunnels: [tunnelRow()] });
    expect((await readAssetIpsec("fw1")).collectedAt).toEqual(T_FULL);
  });
});
