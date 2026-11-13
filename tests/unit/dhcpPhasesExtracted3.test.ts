/**
 * tests/unit/dhcpPhasesExtracted3.test.ts — syncDhcpSubnets Phases 4 and 7c,
 * now modules under src/services/discovery/dhcp/ (CQ-B060 slice 3).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  create: stubbed(prisma.reservation.create),
  createManyAndReturn: stubbed(prisma.reservation.createManyAndReturn),
  update: stubbed(prisma.reservation.update),
  updateMany: stubbed(prisma.reservation.updateMany),
};

const m = vi.hoisted(() => ({
  releaseDnsResolvedAt: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/dnsResolvedReservationService.js", () => ({ releaseDnsResolvedAt: m.releaseDnsResolvedAt }));
const adopt = vi.hoisted(() => ({ evidenceIndex: vi.fn(), run: vi.fn() }));
vi.mock("../../src/services/placeholderMacAdoptionService.js", () => ({
  buildMacEvidenceIndex: adopt.evidenceIndex,
  runPlaceholderMacAdoption: adopt.run,
}));

const { reserveInterfaceIps } = await import("../../src/services/discovery/dhcp/interfaceIpReservations.js");
const { recordObservedIpv6 } = await import("../../src/services/discovery/dhcp/observedIpv6.js");
const { adoptPlaceholderMacs } = await import("../../src/services/discovery/dhcp/placeholderMacAdoption.js");

const log = vi.fn();
const key = (s: string, ip: string) => `${s}|${ip}`;
const findSubnet = (ip: string) => (ip.startsWith("10.1.") ? { id: "net1" } : ip.startsWith("2001:db8:") ? { id: "net6" } : undefined);
beforeEach(() => {
  resetDbStub(); vi.clearAllMocks(); });

describe("Phase 4 — interface IP reservations", () => {
  const base = () => ({
    findSubnetForIp: findSubnet, reservationKey: key, projectRefLabel: "FortiManager Integration",
    integrationId: "i1", syncLog: log,
  });

  it("creates an interface_ip reservation, labelled by role, after releasing any DNS-resolved row", async () => {
    db.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "r1", ...data }));
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
    expect(db.create.mock.calls[0][0].data).toMatchObject({ sourceType: "interface_ip", notes: "Management interface (port1) on FGT-A", owner: "network-team" });
    expect(activeResMap.get("net1|10.1.0.1")).toMatchObject({ id: "r1" });
    expect(reservationNames).toEqual(["10.1.0.1 (FGT-A/port1)"]);
  });

  it("a manual reservation at the address raises a conflict; an observed one is converted in place", async () => {
    const upsertConflict = vi.fn();
    db.update.mockResolvedValue({ id: "obs", sourceType: "interface_ip" });
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
    expect(db.update.mock.calls[0][0]).toMatchObject({ where: { id: "obs" }, data: { sourceType: "interface_ip", expiresAt: null } });
    expect(db.create).not.toHaveBeenCalled();
  });
});

describe("Phase 7c — observed IPv6 (rule 125)", () => {
  const run = (activeResMap: Map<string, any>) => recordObservedIpv6({
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

  it("records a seen IPv6 client address as an observed row in ONE batch insert, and never over another source", async () => {
    db.createManyAndReturn.mockImplementation(async ({ data }: { data: Array<Record<string, unknown>> }) =>
      data.map((d, i) => ({ id: `o${i + 1}`, ...d })));
    const activeResMap = new Map<string, any>([["net6|2001:db8::99", { id: "dhcp", sourceType: "dhcp_lease" }]]);
    await run(activeResMap);
    expect(db.createManyAndReturn).toHaveBeenCalledTimes(1);
    const args = db.createManyAndReturn.mock.calls[0][0];
    expect(args.skipDuplicates).toBe(true); // a row something else claimed mid-run is skipped
    // Exactly the one free address — the DHCP-held one is left to its source.
    expect(args.data).toHaveLength(1);
    expect(args.data[0]).toMatchObject({ ipAddress: "2001:db8::10", sourceType: "observed", subnetId: "net6" });
    expect(activeResMap.get("net6|2001:db8::10")).toMatchObject({ id: "o1" });
    expect(db.create).not.toHaveBeenCalled();
  });

  it("retries row by row when the batch insert fails, so one bad row costs only itself", async () => {
    db.createManyAndReturn.mockRejectedValue(new Error("batch broke"));
    db.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "o1", ...data }));
    const activeResMap = new Map<string, any>();
    await run(activeResMap);
    expect(db.create).toHaveBeenCalledTimes(2);
    expect(activeResMap.get("net6|2001:db8::10")).toMatchObject({ id: "o1" });
  });
});

describe("Phase 7.7 — placeholder MAC adoption", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    result: {
      arpTable: [{ ip: "10.1.0.9", mac: "aa:bb:cc:00:00:09", fortigateDevice: "FGT-A" }],
      deviceInventory: [
        { macAddress: "aa:bb:cc:00:00:01", device: "FGT-A", switchName: "SW-1" }, // local
        { macAddress: "aa:bb:cc:00:00:02", device: "FGT-A" },                     // relayed: dropped
      ],
    } as never,
    adoptionBudget: { remaining: 5 } as never,
    arpMacDeviceIndex: new Set<string>(),
    integrationId: "i1", integrationName: "FMG", actor: "t", signal: undefined as AbortSignal | undefined, syncLog: log,
    ...over,
  });

  it("does nothing without budget, with an exhausted one, or once the run is aborted", async () => {
    await adoptPlaceholderMacs(input({ adoptionBudget: undefined }));
    await adoptPlaceholderMacs(input({ adoptionBudget: { remaining: 0 } }));
    const ac = new AbortController(); ac.abort();
    await adoptPlaceholderMacs(input({ signal: ac.signal }));
    expect(adopt.evidenceIndex).not.toHaveBeenCalled();
  });

  it("feeds ARP rows and only LOCAL inventory rows into the evidence, then runs the adoption", async () => {
    adopt.evidenceIndex.mockReturnValue(new Map([["k", "v"]]));
    adopt.run.mockResolvedValue({ attempted: 2, adopted: 1, failed: 1, deferred: 0 });
    await adoptPlaceholderMacs(input());
    const [arp, inv] = adopt.evidenceIndex.mock.calls[0];
    expect(arp).toHaveLength(1);
    expect(inv.map((d: { macAddress: string }) => d.macAddress)).toEqual(["aa:bb:cc:00:00:01"]);
    expect(adopt.run).toHaveBeenCalledWith(expect.objectContaining({ integrationId: "i1", budget: { remaining: 5 } }));
    expect(log).toHaveBeenCalledWith("info", "Placeholder MAC adoption: 1 reservation(s) updated to the discovered device's MAC, 1 failed");
  });

  it("skips the run with no evidence, and an adoption failure never throws", async () => {
    adopt.evidenceIndex.mockReturnValue(new Map());
    await adoptPlaceholderMacs(input());
    expect(adopt.run).not.toHaveBeenCalled();
    adopt.evidenceIndex.mockReturnValue(new Map([["k", "v"]]));
    adopt.run.mockRejectedValue(new Error("gate refused"));
    await expect(adoptPlaceholderMacs(input())).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("error", "Placeholder MAC adoption failed: gate refused");
  });
});
