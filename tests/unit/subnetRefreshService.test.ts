/**
 * tests/unit/subnetRefreshService.test.ts
 *
 * The per-subnet Discover button (`refreshSubnet`): what it creates, updates,
 * releases and leaves alone when it reconciles ONE DHCP scope and the gate's
 * VIP table against the subnet's reservation rows.
 *
 * The FortiGate is faked one layer up, at the reservationPushService transport
 * helpers, so the lease-shape parsing, the CMDB/lease precedence, the pending-
 * push collision handling and the business rule 77 VIP decisions all run for
 * real. Prisma is a recording fake; nothing here needs a database.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  subnetFindUnique: stubbed(prisma.subnet.findUnique),
  subnetUpdate: stubbed(prisma.subnet.update),
  resUpdate: stubbed(prisma.reservation.update),
  resUpdateMany: stubbed(prisma.reservation.updateMany),
  resCreateMany: stubbed(prisma.reservation.createMany),
  resFindMany: stubbed(prisma.reservation.findMany),
  transaction: stubbed(prisma.$transaction),
};

const m = vi.hoisted(() => ({
  logEvent: vi.fn(),
  callFortiOs: vi.fn(),
  listReservedAddresses: vi.fn(),
  findScopeIdForCidr: vi.fn(),
  buildTransport: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: m.logEvent }));
vi.mock("../../src/services/reservationPushService.js", async () => {
  const mac = await import("../../src/utils/mac.js");
  return {
    buildTransportForIntegration: m.buildTransport,
    findScopeIdForCidr: m.findScopeIdForCidr,
    listReservedAddresses: m.listReservedAddresses,
    callFortiOs: m.callFortiOs,
    normalizeMac: mac.normalizeMacLowerColon,
  };
});

const { refreshSubnet } = await import("../../src/services/subnetRefreshService.js");

// ─── Fixtures ────────────────────────────────────────────────────────────────

const GATE = "HUB1-a";
const CIDR = "10.1.0.0/24";

type Row = Record<string, unknown>;

function subnet(reservations: Row[] = [], over: Row = {}): Row {
  return {
    id: "sub-1",
    name: "Office",
    cidr: CIDR,
    discoveredBy: "int-1",
    fortigateDevice: GATE,
    integration: { id: "int-1", name: "FMG", type: "fortimanager", config: {} },
    reservations,
    ...over,
  };
}

function res(over: Row): Row {
  return {
    id: `r-${String(over.ipAddress)}`,
    status: "active",
    sourceType: "dhcp_lease",
    pushStatus: null,
    macAddress: null,
    hostname: null,
    owner: null,
    vipInfo: null,
    dhcpBinding: null,
    ...over,
  };
}

let leasesResponse: unknown = [];
let vipResponse: unknown = [];
let vipFails: Error | null = null;
let liveRows: Row[] = [];

function updatesFor(id: string): Row[] {
  return db.resUpdate.mock.calls
    .filter(([a]) => (a as { where: { id: string } }).where.id === id)
    .map(([a]) => (a as { data: Row }).data);
}
function created(): Row[] {
  return db.resCreateMany.mock.calls.flatMap(([a]) => (a as { data: Row[] }).data);
}
function eventsWith(action: string): Row[] {
  return m.logEvent.mock.calls.map(([e]) => e as Row).filter((e) => e.action === action);
}

beforeEach(() => {
  resetDbStub();
  for (const fn of Object.values(m)) fn.mockReset();
  leasesResponse = [];
  vipResponse = [];
  vipFails = null;
  liveRows = [];
  m.buildTransport.mockResolvedValue({ kind: "fake" });
  m.findScopeIdForCidr.mockResolvedValue({ scopeId: 7, serverInterface: "lan" });
  m.listReservedAddresses.mockResolvedValue([]);
  m.callFortiOs.mockImplementation(async (_t: unknown, _method: string, path: string) => {
    if (path.startsWith("/api/v2/monitor/system/dhcp")) return leasesResponse;
    if (path === "/api/v2/cmdb/firewall/vip") {
      if (vipFails) throw vipFails;
      return vipResponse;
    }
    throw new Error(`unexpected path ${path}`);
  });
  db.resUpdate.mockImplementation(async (a: unknown) => a);
  db.resUpdateMany.mockResolvedValue({ count: 0 });
  db.resCreateMany.mockImplementation(async (a: { data: unknown[] }) => ({ count: a.data.length }));
  db.resFindMany.mockImplementation(async () => liveRows);
  db.transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
  db.subnetUpdate.mockResolvedValue({});
});

// ─── Preconditions ───────────────────────────────────────────────────────────

describe("refreshSubnet — which subnets it will discover", () => {
  it("404s for a subnet that does not exist", async () => {
    db.subnetFindUnique.mockResolvedValue(null);
    await expect(refreshSubnet("nope", "alice")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("400s for a manually created subnet (no discovering integration)", async () => {
    db.subnetFindUnique.mockResolvedValue(subnet([], { discoveredBy: null, integration: null }));
    await expect(refreshSubnet("sub-1", "alice")).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("400s for a subnet discovered by a non-Fortinet integration", async () => {
    db.subnetFindUnique.mockResolvedValue(
      subnet([], { integration: { id: "i", name: "DHCP", type: "windowsserver", config: {} } }),
    );
    await expect(refreshSubnet("sub-1", "alice")).rejects.toMatchObject({ httpStatus: 400 });
    expect(m.buildTransport).not.toHaveBeenCalled();
  });

  it("400s when the subnet names no FortiGate device", async () => {
    db.subnetFindUnique.mockResolvedValue(subnet([], { fortigateDevice: null }));
    await expect(refreshSubnet("sub-1", "alice")).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("accepts a standalone FortiGate integration as well as FortiManager", async () => {
    db.subnetFindUnique.mockResolvedValue(
      subnet([], { integration: { id: "i", name: "FG", type: "fortigate", config: {} } }),
    );
    await expect(refreshSubnet("sub-1", "alice")).resolves.toMatchObject({ created: 0 });
    expect(m.buildTransport).toHaveBeenCalledWith(expect.objectContaining({ type: "fortigate" }), GATE);
  });
});

// ─── DHCP reconcile ──────────────────────────────────────────────────────────

describe("refreshSubnet — reading the live lease table", () => {
  it("accepts the grouped shape, keeps only this scope's interface, and drops 0.0.0.0", async () => {
    db.subnetFindUnique.mockResolvedValue(subnet());
    leasesResponse = [
      { server_interface: "lan", leases: [{ ip: "10.1.0.20", mac: "AA-BB-CC-00-00-20", hostname: "pc20" }, { ip: "0.0.0.0" }] },
      // Another server's lease outside this subnet: filtered out.
      { server_interface: "guest", leases: [{ ip: "10.9.0.5", mac: "aa:bb:cc:00:00:05" }] },
    ];
    const r = await refreshSubnet("sub-1", "alice");
    expect(r.created).toBe(1);
    expect(created()).toEqual([
      expect.objectContaining({ ipAddress: "10.1.0.20", macAddress: "aa:bb:cc:00:00:20", hostname: "pc20", sourceType: "dhcp_lease" }),
    ]);
  });

  it("keeps a lease on a different interface when its IP is still inside the subnet (VDOM case)", async () => {
    db.subnetFindUnique.mockResolvedValue(subnet());
    leasesResponse = [{ server_interface: "vdom-link", leases: [{ ip: "10.1.0.30" }] }];
    await refreshSubnet("sub-1", null);
    expect(created().map((c) => c.ipAddress)).toEqual(["10.1.0.30"]);
  });

  it("accepts the flat shape and the .results wrapper", async () => {
    db.subnetFindUnique.mockResolvedValue(subnet());
    leasesResponse = { results: [{ ip: "10.1.0.40", reserved: true }, { ip: "10.2.0.1" }] };
    await refreshSubnet("sub-1", null);
    // A lease the gate marks reserved is a reservation, not a lease.
    expect(created()).toEqual([expect.objectContaining({ ipAddress: "10.1.0.40", sourceType: "dhcp_reservation" })]);
  });
});

describe("refreshSubnet — DHCP reconcile", () => {
  it("lets a CMDB reservation win over a live lease at the same IP", async () => {
    db.subnetFindUnique.mockResolvedValue(subnet());
    m.listReservedAddresses.mockResolvedValue([{ id: 11, ip: "10.1.0.10", mac: "AA:BB:CC:00:00:10", description: "printer" }]);
    leasesResponse = [{ ip: "10.1.0.10", mac: "aa:bb:cc:99:99:99", hostname: "lease-name" }];
    await refreshSubnet("sub-1", null);
    expect(created()).toEqual([
      expect.objectContaining({ ipAddress: "10.1.0.10", sourceType: "dhcp_reservation", macAddress: "aa:bb:cc:00:00:10" }),
    ]);
  });

  it("recovers the hostname from a Polaris-written description, bracketed or legacy, and not from a foreign one", async () => {
    db.subnetFindUnique.mockResolvedValue(subnet());
    m.listReservedAddresses.mockResolvedValue([
      { id: 1, ip: "10.1.0.11", description: "Polaris/alice: front desk printer [prn-11]" },
      { id: 2, ip: "10.1.0.12", description: "Polaris: prn-12" },
      { id: 3, ip: "10.1.0.13", description: "hand-typed on the gate" },
    ]);
    await refreshSubnet("sub-1", null);
    const byIp = Object.fromEntries(created().map((c) => [c.ipAddress, c.hostname]));
    expect(byIp).toEqual({ "10.1.0.11": "prn-11", "10.1.0.12": "prn-12", "10.1.0.13": null });
  });

  it("creates discovered rows unowned and active, with skipDuplicates, and reports what actually landed", async () => {
    db.subnetFindUnique.mockResolvedValue(subnet());
    leasesResponse = [{ ip: "10.1.0.50" }, { ip: "10.1.0.51" }];
    db.resCreateMany.mockResolvedValueOnce({ count: 1 }); // one IP lost a race on @@unique
    const r = await refreshSubnet("sub-1", "alice");
    const call = db.resCreateMany.mock.calls[0][0] as { data: Row[]; skipDuplicates: boolean };
    expect(call.skipDuplicates).toBe(true);
    for (const row of call.data) {
      expect(row).toMatchObject({ status: "active", createdBy: null, subnetId: "sub-1" });
    }
    expect(r.created).toBe(1);
  });

  it("flips sourceType on a lease that became a reservation, and the canonical owner placeholder with it", async () => {
    db.subnetFindUnique.mockResolvedValue(
      subnet([
        res({ ipAddress: "10.1.0.60", sourceType: "dhcp_lease", owner: "dhcp-lease", macAddress: "aa:bb:cc:00:00:60" }),
        res({ ipAddress: "10.1.0.61", sourceType: "dhcp_lease", owner: "Facilities", macAddress: "aa:bb:cc:00:00:61" }),
      ]),
    );
    m.listReservedAddresses.mockResolvedValue([
      { id: 60, ip: "10.1.0.60", mac: "aa:bb:cc:00:00:60" },
      { id: 61, ip: "10.1.0.61", mac: "aa:bb:cc:00:00:61" },
    ]);
    const r = await refreshSubnet("sub-1", null);
    expect(updatesFor("r-10.1.0.60")[0]).toMatchObject({ sourceType: "dhcp_reservation", owner: "dhcp-reservation" });
    const operatorOwned = updatesFor("r-10.1.0.61")[0];
    expect(operatorOwned.sourceType).toBe("dhcp_reservation");
    expect(operatorOwned).not.toHaveProperty("owner");
    expect(r.updated).toBe(2);
    expect(created()).toEqual([]);
  });

  it("an unchanged reservation seen again only refreshes lastSeenLeased", async () => {
    db.subnetFindUnique.mockResolvedValue(
      subnet([res({ ipAddress: "10.1.0.62", sourceType: "dhcp_reservation", macAddress: "aa:bb:cc:00:00:62" })]),
    );
    m.listReservedAddresses.mockResolvedValue([{ id: 62, ip: "10.1.0.62", mac: "aa:bb:cc:00:00:62" }]);
    const r = await refreshSubnet("sub-1", null);
    expect(Object.keys(updatesFor("r-10.1.0.62")[0])).toEqual(["lastSeenLeased"]);
    expect(r.updated).toBe(1);
  });

  it("releases dhcp_* rows the device no longer reports, in one updateMany", async () => {
    db.subnetFindUnique.mockResolvedValue(
      subnet([
        res({ ipAddress: "10.1.0.70", sourceType: "dhcp_lease" }),
        res({ ipAddress: "10.1.0.71", sourceType: "dhcp_reservation" }),
        res({ ipAddress: "10.1.0.72", sourceType: "dhcp_lease", status: "released" }),
      ]),
    );
    const r = await refreshSubnet("sub-1", null);
    expect(db.resUpdateMany).toHaveBeenCalledTimes(1);
    expect(db.resUpdateMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ["r-10.1.0.70", "r-10.1.0.71"] } },
      data: { status: "released" },
    });
    expect(r.released).toBe(2);
  });

  it("leaves a manual row alone, counts it skipped, and never releases it", async () => {
    db.subnetFindUnique.mockResolvedValue(
      subnet([
        res({ ipAddress: "10.1.0.80", sourceType: "manual", owner: "ops" }),
        res({ ipAddress: "10.1.0.81", sourceType: "manual" }),
      ]),
    );
    leasesResponse = [{ ip: "10.1.0.80", mac: "aa:bb:cc:00:00:80" }];
    const r = await refreshSubnet("sub-1", null);
    expect(r.skipped).toBe(1);
    expect(updatesFor("r-10.1.0.80")).toEqual([]);
    expect(created()).toEqual([]);
    expect(db.resUpdateMany).not.toHaveBeenCalled();
  });
});

describe("refreshSubnet — pending push-queued rows", () => {
  it("adopts a pending row in place when the gate already holds the same reservation (same MAC)", async () => {
    db.subnetFindUnique.mockResolvedValue(
      subnet([res({ ipAddress: "10.1.0.90", sourceType: "manual", pushStatus: "pending", macAddress: "AA-BB-CC-00-00-90", hostname: "kiosk" })]),
    );
    m.listReservedAddresses.mockResolvedValue([{ id: 90, ip: "10.1.0.90", mac: "aa:bb:cc:00:00:90" }]);
    const r = await refreshSubnet("sub-1", "alice");
    expect(updatesFor("r-10.1.0.90")[0]).toMatchObject({
      sourceType: "dhcp_reservation",
      pushStatus: "synced",
      pushedToId: "int-1",
      pushedScopeId: 7,
      pushedEntryId: 90,
      pushError: null,
      pushAttempts: 0,
    });
    expect(eventsWith("reservation.push.queued.adopted")).toHaveLength(1);
    expect(r.updated).toBe(1);
    expect(created()).toEqual([]);
  });

  it("marks a pending row failed_permanent when the gate leased its IP to another MAC, and creates nothing there", async () => {
    db.subnetFindUnique.mockResolvedValue(
      subnet([res({ ipAddress: "10.1.0.91", sourceType: "manual", pushStatus: "pending", macAddress: "aa:bb:cc:00:00:91" })]),
    );
    leasesResponse = [{ ip: "10.1.0.91", mac: "aa:bb:cc:ff:ff:ff" }];
    const r = await refreshSubnet("sub-1", "alice");
    const patch = updatesFor("r-10.1.0.91")[0];
    expect(patch.pushStatus).toBe("failed_permanent");
    expect(String(patch.pushError)).toContain("aa:bb:cc:ff:ff:ff");
    // The row stays active so the @@unique keeps blocking a duplicate create.
    expect(patch).not.toHaveProperty("status");
    expect(eventsWith("reservation.push.queued.collided")[0]).toMatchObject({ level: "warning" });
    expect(r.skipped).toBe(1);
    expect(created()).toEqual([]);
  });

  it("treats a same-MAC live LEASE (not a CMDB entry) as a collision, not an adoption", async () => {
    db.subnetFindUnique.mockResolvedValue(
      subnet([res({ ipAddress: "10.1.0.92", sourceType: "manual", pushStatus: "pending", macAddress: "aa:bb:cc:00:00:92" })]),
    );
    leasesResponse = [{ ip: "10.1.0.92", mac: "aa:bb:cc:00:00:92" }];
    await refreshSubnet("sub-1", null);
    expect(updatesFor("r-10.1.0.92")[0].pushStatus).toBe("failed_permanent");
  });
});

// ─── VIP facts (business rule 77) ────────────────────────────────────────────

const vipRow = (name: string, extip: string, mapped: string[] = []) => ({
  name,
  extip,
  mappedip: mapped.map((range) => ({ range })),
  extintf: "wan1",
});

describe("refreshSubnet — a vip row learns the DHCP fact", () => {
  it("stamps dhcpBinding on a vip row at a leased address and never flips its sourceType", async () => {
    db.subnetFindUnique.mockResolvedValue(
      subnet([res({ ipAddress: "10.1.0.100", sourceType: "vip", owner: "web-vip" })]),
    );
    leasesResponse = [{ ip: "10.1.0.100", mac: "aa:bb:cc:00:01:00" }];
    const r = await refreshSubnet("sub-1", null);
    const patch = updatesFor("r-10.1.0.100")[0];
    expect(patch.dhcpBinding).toBe("lease");
    expect(patch).not.toHaveProperty("sourceType");
    expect(patch).not.toHaveProperty("expiresAt");
    expect(r.updated).toBe(1);
    expect(created()).toEqual([]);
  });
});

describe("refreshSubnet — VIP table read", () => {
  it("creates a vip row where nothing holds a VIP address, and ignores VIP addresses outside the subnet", async () => {
    db.subnetFindUnique.mockResolvedValue(subnet());
    vipResponse = [vipRow("web", "203.0.113.5", ["10.1.0.110"])];
    const r = await refreshSubnet("sub-1", null);
    const vipCreates = created().filter((c) => c.sourceType === "vip");
    expect(vipCreates).toEqual([
      expect.objectContaining({
        ipAddress: "10.1.0.110",
        owner: "web",
        hostname: "web",
        projectRef: `VIP: ${GATE}`,
        vipInfo: { name: "web", device: GATE, extip: "203.0.113.5", role: "mapped", isVirtualServer: false },
      }),
    ]);
    expect(r.vipsStamped).toBe(1);
  });

  it("stamps the snapshot onto a row a DHCP pass already holds, and only when it differs", async () => {
    const snap = { name: "web", device: GATE, extip: "203.0.113.5", role: "mapped", isVirtualServer: false };
    db.subnetFindUnique.mockResolvedValue(subnet());
    vipResponse = [vipRow("web", "203.0.113.5", ["10.1.0.111", "10.1.0.112"])];
    liveRows = [
      { id: "lease-111", ipAddress: "10.1.0.111", sourceType: "dhcp_lease", vipInfo: null },
      { id: "lease-112", ipAddress: "10.1.0.112", sourceType: "dhcp_lease", vipInfo: { ...snap } },
    ];
    const r = await refreshSubnet("sub-1", null);
    expect(updatesFor("lease-111")).toEqual([{ vipInfo: snap }]);
    expect(updatesFor("lease-112")).toEqual([]);
    expect(r.vipsStamped).toBe(1);
  });

  it("reads the subnet's rows AFTER the DHCP flush so a row created this pass gets its snapshot", async () => {
    db.subnetFindUnique.mockResolvedValue(subnet());
    const order: string[] = [];
    db.resCreateMany.mockImplementation(async (a: { data: unknown[] }) => { order.push("createMany"); return { count: a.data.length }; });
    db.resFindMany.mockImplementation(async () => { order.push("findMany"); return []; });
    leasesResponse = [{ ip: "10.1.0.113" }];
    vipResponse = [vipRow("web", "203.0.113.5", ["10.1.0.114"])];
    await refreshSubnet("sub-1", null);
    expect(order.indexOf("createMany")).toBeLessThan(order.indexOf("findMany"));
  });

  it("an unreadable VIP table is reported, never treated as 'no VIPs', and the DHCP reconcile still completes", async () => {
    db.subnetFindUnique.mockResolvedValue(
      subnet([res({ ipAddress: "10.1.0.120", sourceType: "dhcp_lease" })]),
    );
    leasesResponse = [{ ip: "10.1.0.121" }];
    vipFails = new Error("403 Forbidden");
    liveRows = [{ id: "vip-1", ipAddress: "10.1.0.122", sourceType: "vip", vipInfo: { name: "x", device: GATE } }];
    const r = await refreshSubnet("sub-1", null);
    expect(r.vipError).toBe("403 Forbidden");
    expect(r.created).toBe(1);
    expect(r.released).toBe(1);
    // No VIP decision ran: the stored VIP is untouched.
    expect(db.resFindMany).not.toHaveBeenCalled();
    expect(updatesFor("vip-1")).toEqual([]);
    expect(r.vipsCleared).toBe(0);
    const ev = eventsWith("subnet.refresh")[0];
    expect(String(ev.message)).toContain("could not be read");
    expect((ev.details as Row).vipError).toBe("403 Forbidden");
    expect(db.subnetUpdate).toHaveBeenCalled();
  });
});

describe("refreshSubnet — retiring a VIP the gate no longer reports", () => {
  beforeEach(() => {
    db.subnetFindUnique.mockResolvedValue(subnet());
    vipResponse = [];
  });

  it("leaves a snapshot stamped by ANOTHER gate alone (RFC1918 repeats behind gates)", async () => {
    liveRows = [{ id: "other", ipAddress: "10.1.0.130", sourceType: "vip", owner: "x", hostname: "x", vipInfo: { name: "x", device: "SPOKE9" } }];
    const r = await refreshSubnet("sub-1", null);
    expect(updatesFor("other")).toEqual([]);
    expect(r.vipsCleared).toBe(0);
  });

  it("only clears vipInfo (as DbNull) on a non-vip row; the row keeps its own sourceType", async () => {
    liveRows = [{ id: "lease", ipAddress: "10.1.0.131", sourceType: "dhcp_lease", vipInfo: { name: "web", device: GATE } }];
    const r = await refreshSubnet("sub-1", null);
    expect(updatesFor("lease")).toEqual([{ vipInfo: Prisma.DbNull }]);
    expect(r.vipsCleared).toBe(1);
  });

  it("converts a vip row in place when a DHCP entry now sits at its address, rewriting only a canonical owner", async () => {
    leasesResponse = [{ ip: "10.1.0.132", mac: "aa:bb:cc:00:01:32" }, { ip: "10.1.0.133" }];
    m.listReservedAddresses.mockResolvedValue([]);
    liveRows = [
      { id: "canon", ipAddress: "10.1.0.132", sourceType: "vip", owner: "web", hostname: "web", vipInfo: { name: "web", device: GATE } },
      { id: "custom", ipAddress: "10.1.0.133", sourceType: "vip", owner: "Team Blue", hostname: "api", vipInfo: { name: "api", device: GATE } },
    ];
    // The two DHCP addresses also exist as vip rows in the pre-read snapshot,
    // so the DHCP half only stamps dhcpBinding on them.
    db.subnetFindUnique.mockResolvedValue(
      subnet([
        res({ id: "canon", ipAddress: "10.1.0.132", sourceType: "vip" }),
        res({ id: "custom", ipAddress: "10.1.0.133", sourceType: "vip" }),
      ]),
    );
    const r = await refreshSubnet("sub-1", "alice");
    const canon = updatesFor("canon").find((d) => "sourceType" in d)!;
    expect(canon).toMatchObject({ sourceType: "dhcp_lease", vipInfo: Prisma.DbNull, owner: "dhcp-lease" });
    const custom = updatesFor("custom").find((d) => "sourceType" in d)!;
    expect(custom.sourceType).toBe("dhcp_lease");
    expect(custom).not.toHaveProperty("owner");
    expect(eventsWith("reservation.vip.replaced")).toHaveLength(2);
    expect(r.vipsCleared).toBe(2);
  });

  it("releases a vip row nothing else claims", async () => {
    liveRows = [{ id: "gone", ipAddress: "10.1.0.134", sourceType: "vip", owner: "old", hostname: "old", vipInfo: { name: "old", device: GATE } }];
    const r = await refreshSubnet("sub-1", null);
    expect(updatesFor("gone")).toEqual([{ status: "released", vipInfo: Prisma.DbNull }]);
    expect(eventsWith("reservation.vip.released")).toHaveLength(1);
    expect(r.vipsCleared).toBe(1);
  });
});

describe("refreshSubnet — completion", () => {
  it("bumps lastDiscoveredAt, writes one subnet.refresh Event with the counts, and returns them", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
      db.subnetFindUnique.mockResolvedValue(subnet());
      leasesResponse = [{ ip: "10.1.0.140" }];
      const r = await refreshSubnet("sub-1", "alice");
      expect(db.subnetUpdate).toHaveBeenCalledWith({
        where: { id: "sub-1" },
        data: { lastDiscoveredAt: new Date("2026-11-09T12:00:00Z") },
      });
      expect(r.lastDiscoveredAt).toEqual(new Date("2026-11-09T12:00:00Z"));
      const ev = eventsWith("subnet.refresh");
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ actor: "alice", resourceId: "sub-1", resourceType: "subnet" });
      expect(ev[0].details).toMatchObject({ created: 1, updated: 0, released: 0, skipped: 0, vipError: null, scopeId: 7 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not bump lastDiscoveredAt when the DHCP read fails", async () => {
    db.subnetFindUnique.mockResolvedValue(subnet());
    m.listReservedAddresses.mockRejectedValue(new Error("timeout"));
    await expect(refreshSubnet("sub-1", null)).rejects.toThrow("timeout");
    expect(db.subnetUpdate).not.toHaveBeenCalled();
  });
});
