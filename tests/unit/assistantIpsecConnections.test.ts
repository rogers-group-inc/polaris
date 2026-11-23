/**
 * tests/unit/assistantIpsecConnections.test.ts
 *
 * The assistant's list_ipsec_connections tool and its create_report source:
 *   - the gate is resolved by id / hostname / ip, and a call naming none is a
 *     tool error, not a query;
 *   - kind / tunnel / status reach listIpsecConnections as the SQL filter
 *     (ADVPN peers without the remote-access users is kind ["advpn-spoke"]);
 *   - rows carry the peer's public (underlay) address and its matched device;
 *   - create_report builds a CSV-able table from it (seen live 2026-11-23:
 *     the ADVPN peers of a hub could be listed but never exported).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  listIpsecConnections: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/ipsecConnectionService.js", () => ({ listIpsecConnections: h.listIpsecConnections }));

import { runAssistantTool, type AssistantReportPayload } from "../../src/services/assistantToolService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const req = { session: { userId: "u1", roleSnapshot: { permissions: { assets: "read" } } } } as any;
const SINCE = new Date("2026-11-23T09:00:00Z");
const SEEN = new Date("2026-11-23T10:20:00Z");

function conn(over: Record<string, unknown> = {}) {
  return {
    name: "Overlay-1_0", kind: "advpn-spoke", parentTunnel: "Overlay-1", peerId: "SPOKE-A", userName: null,
    remoteGateway: "203.0.113.10", tunnelIp: "10.255.0.2", status: "up", incomingBytes: 10, outgoingBytes: 20,
    connectedSince: SINCE, firstSeen: SINCE, lastSeen: SEEN,
    matchedAsset: { id: "a2", hostname: "SPOKE-A", ipAddress: "10.1.1.1", assetType: "firewall" },
    ...over,
  };
}

beforeEach(() => {
  resetDbStub();
  h.listIpsecConnections.mockReset().mockResolvedValue({ connections: [], collectedAt: null });
  stubbed(prisma.asset.findFirst).mockResolvedValue({ id: "hub1", hostname: "HUB-1" });
});

describe("list_ipsec_connections", () => {
  it("needs a gate — a call naming none queries nothing", async () => {
    const r = await runAssistantTool("list_ipsec_connections", JSON.stringify({ kind: ["advpn-spoke"] }), { req, maxRows: 50 });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.data)).toMatch(/id, hostname or ip/);
    expect(stubbed(prisma.asset.findFirst)).not.toHaveBeenCalled();
    expect(h.listIpsecConnections).not.toHaveBeenCalled();
  });

  it("says not found for an unknown gate", async () => {
    stubbed(prisma.asset.findFirst).mockResolvedValue(null);
    const r = await runAssistantTool("list_ipsec_connections", JSON.stringify({ hostname: "nope" }), { req, maxRows: 50 });
    expect(r).toMatchObject({ ok: true, data: { found: false } });
    expect(h.listIpsecConnections).not.toHaveBeenCalled();
  });

  it("passes kind / tunnel / status through as the filter and resolves the gate case-insensitively", async () => {
    await runAssistantTool("list_ipsec_connections",
      JSON.stringify({ hostname: "hub-1", kind: ["advpn-spoke"], tunnel: ["Overlay-1"], status: "up" }), { req, maxRows: 50 });
    expect(stubbed(prisma.asset.findFirst).mock.calls[0][0].where).toEqual({ hostname: { equals: "hub-1", mode: "insensitive" } });
    expect(h.listIpsecConnections).toHaveBeenCalledWith("hub1", { kinds: ["advpn-spoke"], parentTunnels: ["Overlay-1"], status: "up" });
  });

  it("rejects a kind that does not exist", async () => {
    const r = await runAssistantTool("list_ipsec_connections", JSON.stringify({ hostname: "HUB-1", kind: ["advpn"] }), { req, maxRows: 50 });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.data)).toMatch(/Invalid arguments/);
  });

  it("returns the public IP and matched device per peer, capped at maxRows", async () => {
    h.listIpsecConnections.mockResolvedValue({
      connections: [conn(), conn({ name: "Overlay-1_1", peerId: "SPOKE-B", remoteGateway: "198.51.100.7", matchedAsset: null })],
      collectedAt: SEEN,
    });
    const r = await runAssistantTool("list_ipsec_connections", JSON.stringify({ hostname: "HUB-1" }), { req, maxRows: 1 });
    expect(r.data).toMatchObject({
      gate: "HUB-1", collectedAt: SEEN.toISOString(), total: 2, returned: 1, truncated: true,
      rows: [{ gate: "HUB-1", peerId: "SPOKE-A", peerDevice: "SPOKE-A", remoteGateway: "203.0.113.10", connectedSince: SINCE.toISOString() }],
    });
  });

  it("is a create_report source — the rows come from the service, not the model", async () => {
    h.listIpsecConnections.mockResolvedValue({ connections: [conn(), conn({ name: "Overlay-3_0", parentTunnel: "Overlay-3", remoteGateway: "198.51.100.7" })], collectedAt: SEEN });
    const reports: AssistantReportPayload[] = [];
    const r = await runAssistantTool("create_report", JSON.stringify({
      title: "HUB-1 ADVPN peers", source: "list_ipsec_connections",
      args: { hostname: "HUB-1", kind: ["advpn-spoke"] }, columns: ["parentTunnel", "peerId", "remoteGateway"], formats: ["csv"],
    }), { req, maxRows: 1, onReport: (x) => reports.push(x) });
    expect(r.ok).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      rowCount: 2, truncated: false, formats: ["csv"],
      columns: [{ key: "parentTunnel", label: "Tunnel" }, { key: "peerId", label: "Peer ID" }, { key: "remoteGateway", label: "Public IP" }],
      rows: [
        { parentTunnel: "Overlay-1", peerId: "SPOKE-A", remoteGateway: "203.0.113.10" },
        { parentTunnel: "Overlay-3", peerId: "SPOKE-A", remoteGateway: "198.51.100.7" },
      ],
    });
  });
});
