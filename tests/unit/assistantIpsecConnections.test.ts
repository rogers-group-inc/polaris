/**
 * tests/unit/assistantIpsecConnections.test.ts
 *
 * The assistant's list_ipsec_connections tool and its create_report source:
 *   - the gate is resolved by id / hostname / ip — a live asset over a
 *     decommissioned twin, and among several the one holding connections —
 *     and a call naming none is a tool error, not a query;
 *   - kind / excludeKind / tunnel / status reach listIpsecConnections as the
 *     SQL filter, each as one value, a list or "a, b" (a bare string failed
 *     the first live report, 2026-11-23);
 *   - rows carry the peer's public (underlay) address and its matched device;
 *   - create_report builds a CSV-able table from it;
 *   - a filter that matched nothing on a gate that HAS connections answers
 *     with the kinds the gate holds, and create_report then shows NO card
 *     (seen live 2026-11-23: kind advpn-spoke on a hub whose spokes were
 *     stored as dialup-peer → an empty report).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  listIpsecConnections: vi.fn(),
  countIpsecConnectionsByKind: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/ipsecConnectionService.js", () => ({
  listIpsecConnections: h.listIpsecConnections,
  countIpsecConnectionsByKind: h.countIpsecConnectionsByKind,
}));

import { runAssistantTool, type AssistantReportPayload } from "../../src/services/assistantToolService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const req = { session: { userId: "u1", roleSnapshot: { permissions: { assets: "read" } } } } as any;
const SINCE = new Date("2026-11-23T09:00:00Z");
const SEEN = new Date("2026-11-23T10:20:00Z");

function conn(over: Record<string, unknown> = {}) {
  return {
    name: "Overlay-1_0", kind: "dialup-peer", parentTunnel: "Overlay-1", peerId: "SPOKE-A", userName: null,
    remoteGateway: "203.0.113.10", tunnelIp: "10.255.0.2", status: "up", incomingBytes: 10, outgoingBytes: 20,
    connectedSince: SINCE, firstSeen: SINCE, lastSeen: SEEN,
    matchedAsset: { id: "a2", hostname: "SPOKE-A", ipAddress: "10.1.1.1", assetType: "firewall" },
    ...over,
  };
}

const ON_GATE = [
  { kind: "remote-access", parentTunnel: "IPsecRA_VPN", count: 35 },
  { kind: "dialup-peer", parentTunnel: "Overlay-1", count: 176 },
  { kind: "dialup-peer", parentTunnel: "Overlay-3", count: 116 },
];

const call = (args: Record<string, unknown>, maxRows = 50) =>
  runAssistantTool("list_ipsec_connections", JSON.stringify(args), { req, maxRows });

beforeEach(() => {
  resetDbStub();
  h.listIpsecConnections.mockReset().mockResolvedValue({ connections: [], collectedAt: null });
  h.countIpsecConnectionsByKind.mockReset().mockResolvedValue([]);
  stubbed(prisma.asset.findMany).mockResolvedValue([{ id: "hub1", hostname: "HUB-1", status: "active" }]);
  stubbed(prisma.assetIpsecConnection.groupBy).mockResolvedValue([]);
});

describe("list_ipsec_connections — the gate", () => {
  it("needs a gate — a call naming none queries nothing", async () => {
    const r = await call({ kind: ["dialup-peer"] });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.data)).toMatch(/id, hostname or ip/);
    expect(stubbed(prisma.asset.findMany)).not.toHaveBeenCalled();
    expect(h.listIpsecConnections).not.toHaveBeenCalled();
  });

  it("says not found for an unknown gate", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([]);
    expect(await call({ hostname: "nope" })).toMatchObject({ ok: true, data: { found: false } });
    expect(h.listIpsecConnections).not.toHaveBeenCalled();
  });

  it("matches the hostname case-insensitively", async () => {
    await call({ hostname: "hub-1" });
    expect(stubbed(prisma.asset.findMany).mock.calls[0][0].where).toEqual({ hostname: { equals: "hub-1", mode: "insensitive" } });
    expect(h.listIpsecConnections.mock.calls[0][0]).toBe("hub1");
  });

  it("prefers a live gate over a decommissioned twin with the same name", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([
      { id: "old", hostname: "HUB-1", status: "decommissioned" },
      { id: "hub1", hostname: "HUB-1", status: "active" },
    ]);
    await call({ hostname: "HUB-1" });
    expect(h.listIpsecConnections.mock.calls[0][0]).toBe("hub1");
  });

  it("among several live gates picks the one holding connections", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([
      { id: "a", hostname: "HUB-1", status: "active" },
      { id: "b", hostname: "HUB-1", status: "active" },
    ]);
    stubbed(prisma.assetIpsecConnection.groupBy).mockResolvedValue([{ assetId: "b", _count: { _all: 300 } }]);
    await call({ hostname: "HUB-1" });
    expect(h.listIpsecConnections.mock.calls[0][0]).toBe("b");
  });
});

describe("list_ipsec_connections — filters", () => {
  it("passes kind / excludeKind / tunnel / status through as the filter", async () => {
    await call({ hostname: "HUB-1", kind: ["dialup-peer"], excludeKind: ["remote-access", "ssl-vpn"], tunnel: ["Overlay-1"], status: "up" });
    expect(h.listIpsecConnections).toHaveBeenCalledWith("hub1", {
      kinds: ["dialup-peer"], excludeKinds: ["remote-access", "ssl-vpn"], parentTunnels: ["Overlay-1"], status: "up",
    });
  });

  it("takes a kind as one string or a comma list, not only an array", async () => {
    await call({ hostname: "HUB-1", kind: "advpn-spoke", excludeKind: "remote-access, ssl-vpn", tunnel: "Overlay-1" });
    expect(h.listIpsecConnections.mock.calls[0][1]).toMatchObject({
      kinds: ["advpn-spoke"], excludeKinds: ["remote-access", "ssl-vpn"], parentTunnels: ["Overlay-1"],
    });
  });

  it("rejects a kind that does not exist", async () => {
    const r = await call({ hostname: "HUB-1", kind: ["advpn"] });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.data)).toMatch(/Invalid arguments/);
  });

  it("returns the public IP and matched device per peer, capped at maxRows", async () => {
    h.listIpsecConnections.mockResolvedValue({
      connections: [conn(), conn({ name: "Overlay-1_1", peerId: "SPOKE-B", remoteGateway: "198.51.100.7", matchedAsset: null })],
      collectedAt: SEEN,
    });
    const r = await call({ hostname: "HUB-1" }, 1);
    expect(r.data).toMatchObject({
      gates: [{ gate: "HUB-1", assetId: "hub1", connections: 2, collectedAt: SEEN.toISOString() }], total: 2, returned: 1, truncated: true,
      rows: [{ gate: "HUB-1", peerId: "SPOKE-A", peerDevice: "SPOKE-A", remoteGateway: "203.0.113.10", connectedSince: SINCE.toISOString() }],
    });
    expect(h.countIpsecConnectionsByKind).not.toHaveBeenCalled();
  });
});

describe("list_ipsec_connections — an empty filtered result", () => {
  it("lists what the gate holds and the non-remote-access kinds to retry with", async () => {
    h.countIpsecConnectionsByKind.mockResolvedValue(ON_GATE);
    const r = await call({ hostname: "HUB-1", kind: ["advpn-spoke", "advpn-shortcut"] });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ total: 0, connectionsOnGate: ON_GATE });
    expect((r.data as { retryHint: string }).retryHint).toMatch(/non-remote-access kinds are dialup-peer\b/);
  });

  it("says nothing extra when the gate has no connections at all, or no filter was given", async () => {
    expect(await call({ hostname: "HUB-1", kind: ["advpn-spoke"] })).not.toHaveProperty("data.retryHint");
    h.countIpsecConnectionsByKind.mockResolvedValue(ON_GATE);
    expect(await call({ hostname: "HUB-1" })).not.toHaveProperty("data.retryHint");
    expect(h.countIpsecConnectionsByKind).toHaveBeenCalledTimes(1);
  });
});

describe("create_report from list_ipsec_connections", () => {
  const report = (args: Record<string, unknown>, reports: AssistantReportPayload[]) =>
    runAssistantTool("create_report", JSON.stringify({
      title: "HUB-1 site peers", source: "list_ipsec_connections", args,
      columns: ["parentTunnel", "peerId", "remoteGateway"], formats: ["csv"],
    }), { req, maxRows: 1, onReport: (x) => reports.push(x) });

  it("builds the table from the service's rows, not the model's", async () => {
    h.listIpsecConnections.mockResolvedValue({ connections: [conn(), conn({ name: "Overlay-3_0", parentTunnel: "Overlay-3", remoteGateway: "198.51.100.7" })], collectedAt: SEEN });
    const reports: AssistantReportPayload[] = [];
    const r = await report({ hostname: "HUB-1", excludeKind: ["remote-access", "ssl-vpn"] }, reports);
    expect(r.ok).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      rowCount: 2, truncated: false, formats: ["csv"],
      columns: [{ key: "parentTunnel", label: "Tunnel" }, { key: "remoteGateway", label: "Public IP" }, { key: "peerId", label: "Peer ID" }],
      rows: [
        { parentTunnel: "Overlay-1", peerId: "SPOKE-A", remoteGateway: "203.0.113.10" },
        { parentTunnel: "Overlay-3", peerId: "SPOKE-A", remoteGateway: "198.51.100.7" },
      ],
    });
  });

  it("shows NO card for a wrong-kind empty result — the model gets the kinds to retry with", async () => {
    h.countIpsecConnectionsByKind.mockResolvedValue(ON_GATE);
    const reports: AssistantReportPayload[] = [];
    const r = await report({ hostname: "HUB-1", kind: ["advpn-spoke"] }, reports);
    expect(reports).toHaveLength(0);
    expect(r.ok).toBe(false);
    expect(r.data).toMatchObject({ connectionsOnGate: ON_GATE });
    expect(JSON.stringify(r.data)).toMatch(/EMPTY/);
  });

  it("still shows an empty card when the gate genuinely has no connections", async () => {
    const reports: AssistantReportPayload[] = [];
    const r = await report({ hostname: "HUB-1", kind: ["advpn-spoke"] }, reports);
    expect(r.ok).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0].rowCount).toBe(0);
  });
});

describe("list_ipsec_connections — several gates in one call", () => {
  beforeEach(() => {
    stubbed(prisma.asset.findMany).mockImplementation(async (q: any) => {
      const name = String(q.where.hostname?.equals ?? "").toUpperCase();
      return name === "HUB-1" ? [{ id: "hub1", hostname: "HUB-1", status: "active" }]
        : name === "HUB-2" ? [{ id: "hub2", hostname: "HUB-2", status: "active" }]
        : [];
    });
    h.listIpsecConnections.mockImplementation(async (id: string) => ({
      connections: id === "hub1"
        ? [conn({ remoteGateway: "203.0.113.10" }), conn({ name: "Overlay-1_1", remoteGateway: "198.51.100.7" })]
        : [conn({ name: "Overlay-2_0", parentTunnel: "Overlay-2", remoteGateway: "203.0.113.10" })],
      collectedAt: SEEN,
    }));
  });

  it("combines every named gate's rows, each row naming its gate, and names what did not resolve", async () => {
    const r = await call({ hostname: ["HUB-1", "hub-2", "NOPE"], excludeKind: ["remote-access", "ssl-vpn"] });
    expect(h.listIpsecConnections.mock.calls.map((x) => x[0])).toEqual(["hub1", "hub2"]);
    expect(r.data).toMatchObject({
      total: 3,
      gates: [{ gate: "HUB-1", connections: 2 }, { gate: "HUB-2", connections: 1 }],
      notFound: ["NOPE"],
    });
    expect((r.data as { rows: Array<{ gate: string }> }).rows.map((x) => x.gate)).toEqual(["HUB-1", "HUB-1", "HUB-2"]);
  });

  it("asks for a gate named twice only once", async () => {
    await call({ hostname: "HUB-1, hub-1" });
    expect(h.listIpsecConnections).toHaveBeenCalledTimes(1);
  });

  it("dedupes by public IP across both gates in a report, keeping every column and counting what it removed", async () => {
    const reports: AssistantReportPayload[] = [];
    const r = await runAssistantTool("create_report", JSON.stringify({
      title: "Hub peers, unique public IPs", source: "list_ipsec_connections",
      args: { hostname: ["HUB-1", "HUB-2"] }, dedupeBy: ["remoteGateway"],
    }), { req, maxRows: 50, onReport: (x) => reports.push(x) });
    expect(r.data).toMatchObject({ rowCount: 2, totalMatching: 3, dedupedBy: ["remoteGateway"], duplicatesRemoved: 1 });
    const rep = reports[0];
    expect(rep.rows.map((x) => [x.gate, x.remoteGateway, x.duplicatesRemoved])).toEqual([
      ["HUB-1", "203.0.113.10", 1], ["HUB-1", "198.51.100.7", 0],
    ]);
    // No columns asked → every source column, then the duplicates count.
    expect(rep.columns.map((x) => x.key)).toEqual([
      "gate", "parentTunnel", "remoteGateway", "tunnelIp", "status", "uptime", "incomingBytes", "outgoingBytes",
      "name", "kind", "peerId", "peerDevice", "userName", "connectedSince", "lastSeen", "duplicatesRemoved",
    ]);
  });

  it("refuses a dedupe key the source has no column for instead of shipping repeats", async () => {
    const reports: AssistantReportPayload[] = [];
    const r = await runAssistantTool("create_report", JSON.stringify({
      title: "x", source: "list_ipsec_connections", args: { hostname: "HUB-1" }, dedupeBy: "publicIp",
    }), { req, maxRows: 50, onReport: (x) => reports.push(x) });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.data)).toMatch(/publicIp.*remoteGateway/);
    expect(reports).toHaveLength(0);
  });
});

describe("list_ipsec_connections — uptime", () => {
  it("is the uptime as of the scrape that saw the session, never a now-relative one", async () => {
    h.listIpsecConnections.mockResolvedValue({
      connections: [
        conn({ connectedSince: new Date(SEEN.getTime() - (2 * 86400 + 3 * 3600) * 1000) }),
        conn({ name: "b", connectedSince: null }),
      ],
      collectedAt: SEEN,
    });
    const r = await call({ hostname: "HUB-1" });
    expect((r.data as { rows: Array<{ uptime: string | null }> }).rows.map((x) => x.uptime)).toEqual(["2d 3h", null]);
  });
});