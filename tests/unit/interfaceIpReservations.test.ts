/**
 * tests/unit/interfaceIpReservations.test.ts — syncDhcpSubnets Phase 4 as its
 * own module (src/services/discovery/dhcp/interfaceIpReservations.ts →
 * reserveInterfaceIps): an `interface_ip` reservation per gate interface
 * address inside a known network.
 *
 * Contract: a manual row at the address raises a Conflict (never overwritten);
 * an `observed` row (rule 125(b), evidence not a claim) converts in place; any
 * other existing row is left alone; a new row is created after any
 * dns_resolved placeholder at the address is released, and the run's
 * in-memory index + summary list are updated so later phases see it. Errors
 * are logged per address, never thrown. tests/unit/dhcpPhasesExtracted3.test.ts
 * pins the headline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const m = vi.hoisted(() => ({ releaseDnsResolvedAt: vi.fn() }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/dnsResolvedReservationService.js", () => ({ releaseDnsResolvedAt: m.releaseDnsResolvedAt }));

const { reserveInterfaceIps } = await import("../../src/services/discovery/dhcp/interfaceIpReservations.js");

const db = {
  create: stubbed(prisma.reservation.create),
  update: stubbed(prisma.reservation.update),
};

const log = vi.fn();
const upsertConflict = vi.fn();
const key = (subnetId: string, ip: string) => `${subnetId}|${ip}`;
const findSubnet = (ip: string) =>
  ip.startsWith("10.1.") ? { id: "net1" } : ip.startsWith("2001:db8:1:") ? { id: "net6" } : undefined;

type Iface = { ipAddress: string | null; device: string; interfaceName: string; role: string };
function run(interfaceIps: Iface[], activeResMap = new Map<string, any>(), reservationNames: string[] = []) {
  return reserveInterfaceIps({
    result: { interfaceIps } as never,
    activeResMap,
    findSubnetForIp: findSubnet,
    reservationKey: key,
    upsertConflict: upsertConflict as never,
    projectRefLabel: "FortiGate Integration",
    reservationNames,
    integrationId: "int1",
    syncLog: log,
  });
}

beforeEach(() => {
  resetDbStub();
  log.mockReset();
  upsertConflict.mockReset();
  m.releaseDnsResolvedAt.mockReset().mockResolvedValue(undefined);
  db.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `new-${data.ipAddress}`, ...data }));
  db.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ id: where.id, ...data }));
});

describe("reserveInterfaceIps", () => {
  it("does nothing for an empty list, a null address or an address in no known network", async () => {
    await run([]);
    await run([
      { ipAddress: null, device: "FGT-A", interfaceName: "port9", role: "primary" },
      { ipAddress: "192.0.2.1", device: "FGT-A", interfaceName: "wan1", role: "primary" },
    ]);
    expect(m.releaseDnsResolvedAt).not.toHaveBeenCalled();
    expect(db.create).not.toHaveBeenCalled();
  });

  it("creates the full interface_ip row and records it in the index and the summary", async () => {
    const map = new Map<string, any>();
    const names: string[] = [];
    await run([{ ipAddress: "10.1.0.1", device: "FGT-A", interfaceName: "port1", role: "primary" }], map, names);
    expect(m.releaseDnsResolvedAt).toHaveBeenCalledWith("net1", "10.1.0.1");
    expect(m.releaseDnsResolvedAt.mock.invocationCallOrder[0]).toBeLessThan(db.create.mock.invocationCallOrder[0]);
    expect(db.create).toHaveBeenCalledWith({
      data: {
        subnetId: "net1",
        ipAddress: "10.1.0.1",
        hostname: "FGT-A",
        owner: "network-team",
        projectRef: "FortiGate Integration",
        notes: "Interface (port1) on FGT-A",
        status: "active",
        sourceType: "interface_ip",
      },
    });
    expect(map.get("net1|10.1.0.1")).toMatchObject({ id: "new-10.1.0.1" });
    expect(names).toEqual(["10.1.0.1 (FGT-A/port1)"]);
  });

  it("labels the note by role", async () => {
    await run([
      { ipAddress: "10.1.0.1", device: "G", interfaceName: "mgmt", role: "management" },
      { ipAddress: "10.1.0.2", device: "G", interfaceName: "port2", role: "secondary" },
      { ipAddress: "10.1.0.3", device: "G", interfaceName: "port3", role: "anything-else" },
    ]);
    expect(db.create.mock.calls.map((c) => c[0].data.notes)).toEqual([
      "Management interface (mgmt) on G",
      "Secondary IP (port2) on G",
      "Interface (port3) on G",
    ]);
  });

  it("reserves an IPv6 interface address in its IPv6 network", async () => {
    await run([{ ipAddress: "2001:db8:1::1", device: "FGT-A", interfaceName: "port1", role: "primary" }]);
    expect(db.create.mock.calls[0][0].data).toMatchObject({ subnetId: "net6", ipAddress: "2001:db8:1::1", sourceType: "interface_ip" });
  });

  it("creates once when the same address is reported twice in one run", async () => {
    const map = new Map<string, any>();
    await run([
      { ipAddress: "10.1.0.1", device: "FGT-A", interfaceName: "port1", role: "primary" },
      { ipAddress: "10.1.0.1", device: "FGT-A", interfaceName: "port1", role: "primary" },
    ], map);
    expect(db.create).toHaveBeenCalledTimes(1);
  });

  it("raises a Conflict against a manual row instead of overwriting it", async () => {
    const manual = { id: "man", sourceType: "manual", hostname: "operator-host" };
    const map = new Map<string, any>([["net1|10.1.0.5", manual]]);
    await run([{ ipAddress: "10.1.0.5", device: "FGT-A", interfaceName: "port5", role: "management" }], map);
    expect(upsertConflict).toHaveBeenCalledWith(
      "man",
      "int1",
      { hostname: "FGT-A", owner: "network-team", projectRef: "FortiGate Integration", notes: "Management interface (port5) on FGT-A", sourceType: "interface_ip" },
      manual,
    );
    expect(db.create).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(map.get("net1|10.1.0.5")).toBe(manual);
  });

  it("converts an observed row in place (rule 125) and clears its expiry", async () => {
    const map = new Map<string, any>([["net6|2001:db8:1::5", { id: "obs", sourceType: "observed", expiresAt: new Date() }]]);
    await run([{ ipAddress: "2001:db8:1::5", device: "FGT-A", interfaceName: "port1", role: "primary" }], map);
    expect(db.update).toHaveBeenCalledWith({
      where: { id: "obs" },
      data: { sourceType: "interface_ip", hostname: "FGT-A", owner: "network-team", projectRef: "FortiGate Integration", notes: "Interface (port1) on FGT-A", expiresAt: null },
    });
    expect(map.get("net6|2001:db8:1::5")).toMatchObject({ id: "obs", sourceType: "interface_ip" });
    expect(upsertConflict).not.toHaveBeenCalled();
    expect(m.releaseDnsResolvedAt).not.toHaveBeenCalled();
  });

  it("leaves every other existing source untouched", async () => {
    const sources = ["interface_ip", "dhcp_reservation", "dhcp_lease", "vip", "fortiswitch", "fortinap", "dns_resolved", "external"];
    const map = new Map<string, any>(sources.map((s, i) => [`net1|10.1.1.${i}`, { id: s, sourceType: s }]));
    await run(sources.map((_, i) => ({ ipAddress: `10.1.1.${i}`, device: "FGT-A", interfaceName: `p${i}`, role: "primary" })), map);
    expect(db.create).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(upsertConflict).not.toHaveBeenCalled();
  });

  it("logs a failed observed conversion and keeps the old row in the index", async () => {
    const obs = { id: "obs", sourceType: "observed" };
    const map = new Map<string, any>([["net1|10.1.0.7", obs]]);
    db.update.mockRejectedValue(new Error("row locked"));
    await run([{ ipAddress: "10.1.0.7", device: "FGT-A", interfaceName: "port7", role: "primary" }], map);
    expect(log).toHaveBeenCalledWith("error", "Failed to convert observed address 10.1.0.7 to an interface IP on FGT-A/port7: row locked");
    expect(map.get("net1|10.1.0.7")).toBe(obs);
  });

  it("logs a failed create (or a failed placeholder release) per address and carries on", async () => {
    const names: string[] = [];
    db.create.mockRejectedValueOnce(new Error("unique violation"));
    m.releaseDnsResolvedAt.mockImplementation(async (_s: string, ip: string) => {
      if (ip === "10.1.0.2") throw new Error("release failed");
    });
    await run([
      { ipAddress: "10.1.0.1", device: "G", interfaceName: "p1", role: "primary" },
      { ipAddress: "10.1.0.2", device: "G", interfaceName: "p2", role: "primary" },
      { ipAddress: "10.1.0.3", device: "G", interfaceName: "p3", role: "primary" },
    ], new Map(), names);
    expect(log).toHaveBeenCalledWith("error", "Failed to create reservation for interface IP 10.1.0.1 on G/p1: unique violation");
    expect(log).toHaveBeenCalledWith("error", "Failed to create reservation for interface IP 10.1.0.2 on G/p2: release failed");
    expect(names).toEqual(["10.1.0.3 (G/p3)"]);
  });
});
