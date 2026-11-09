/**
 * tests/unit/dhcpPhasesExtracted3.test.ts — syncDhcpSubnets Phases 4 and 7c,
 * now modules under src/services/discovery/dhcp/ (CQ-B060 slice 3).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  releaseDnsResolvedAt: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({
  prisma: { reservation: { create: m.create, update: m.update, updateMany: m.updateMany } },
}));
vi.mock("../../src/services/dnsResolvedReservationService.js", () => ({ releaseDnsResolvedAt: m.releaseDnsResolvedAt }));

const { reserveInterfaceIps } = await import("../../src/services/discovery/dhcp/interfaceIpReservations.js");
const { recordObservedIpv6 } = await import("../../src/services/discovery/dhcp/observedIpv6.js");

const log = vi.fn();
const key = (s: string, ip: string) => `${s}|${ip}`;
const findSubnet = (ip: string) => (ip.startsWith("10.1.") ? { id: "net1" } : ip.startsWith("2001:db8:") ? { id: "net6" } : undefined);
beforeEach(() => { vi.clearAllMocks(); });

describe("Phase 4 — interface IP reservations", () => {
  const base = () => ({
    findSubnetForIp: findSubnet, reservationKey: key, projectRefLabel: "FortiManager Integration",
    integrationId: "i1", syncLog: log,
  });

  it("creates an interface_ip reservation, labelled by role, after releasing any DNS-resolved row", async () => {
    m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "r1", ...data }));
    const activeResMap = new Map<string, any>();
    const reservationNames: string[] = [];
    await reserveInterfaceIps({
      ...base(), activeResMap, reservationNames, upsertConflict: vi.fn(),
      result: { interfaceIps: [
        { ipAddress: "10.1.0.1", device: "FGT-A", interfaceName: "port1", role: "management" },
        { ipAddress: "192.0.2.1", device: "FGT-A", interfaceName: "wan1", role: "primary" }, // no known network
      ] } as never,
    });
    expect(m.releaseDnsResolvedAt).toHaveBeenCalledWith("net1", "10.1.0.1");
    expect(m.create.mock.calls[0][0].data).toMatchObject({ sourceType: "interface_ip", notes: "Management interface (port1) on FGT-A", owner: "network-team" });
    expect(activeResMap.get("net1|10.1.0.1")).toMatchObject({ id: "r1" });
    expect(reservationNames).toEqual(["10.1.0.1 (FGT-A/port1)"]);
  });

  it("a manual reservation at the address raises a conflict; an observed one is converted in place", async () => {
    const upsertConflict = vi.fn();
    m.update.mockResolvedValue({ id: "obs", sourceType: "interface_ip" });
    const activeResMap = new Map<string, any>([
      ["net1|10.1.0.2", { id: "man", sourceType: "manual" }],
      ["net1|10.1.0.3", { id: "obs", sourceType: "observed" }],
    ]);
    await reserveInterfaceIps({
      ...base(), activeResMap, reservationNames: [], upsertConflict,
      result: { interfaceIps: [
        { ipAddress: "10.1.0.2", device: "FGT-A", interfaceName: "port2", role: "secondary" },
        { ipAddress: "10.1.0.3", device: "FGT-A", interfaceName: "port3", role: "primary" },
      ] } as never,
    });
    expect(upsertConflict).toHaveBeenCalledWith("man", "i1", expect.objectContaining({ sourceType: "interface_ip", notes: "Secondary IP (port2) on FGT-A" }), expect.anything());
    expect(m.update.mock.calls[0][0]).toMatchObject({ where: { id: "obs" }, data: { sourceType: "interface_ip", expiresAt: null } });
    expect(m.create).not.toHaveBeenCalled();
  });
});

describe("Phase 7c — observed IPv6 (rule 125)", () => {
  it("records a seen IPv6 client address as an observed row, and never over another source", async () => {
    m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "o1", ...data }));
    const activeResMap = new Map<string, any>([["net6|2001:db8::99", { id: "dhcp", sourceType: "dhcp_lease" }]]);
    await recordObservedIpv6({
      result: {
        deviceInventory: [
          { ipv6Address: "2001:db8::10", macAddress: "aa:bb:cc:00:00:10", device: "FGT-A", isOnline: true },
          { ipv6Address: "2001:db8::99", macAddress: "aa:bb:cc:00:00:99", device: "FGT-A", isOnline: true },
        ],
        switchMacTable: [],
      } as never,
      now: new Date().toISOString(),
      activeResMap, findSubnetForIp: findSubnet, reservationKey: key,
      assetIdx: { findByMac: () => ({ hostname: "laptop-10" }) } as never,
      projectRefLabel: "FortiGate Integration", syncLog: log,
    });
    const created = m.create.mock.calls.map((c) => c[0].data);
    // Exactly the one free address — the DHCP-held one is left to its source.
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ ipAddress: "2001:db8::10", sourceType: "observed", subnetId: "net6" });
    expect(activeResMap.get("net6|2001:db8::10")).toMatchObject({ id: "o1" });
  });
});
