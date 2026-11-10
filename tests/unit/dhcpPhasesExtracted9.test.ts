/**
 * tests/unit/dhcpPhasesExtracted9.test.ts — syncDhcpSubnets Phase 5, DHCP
 * lease / reservation entries, now src/services/discovery/dhcp/dhcpEntries.ts
 * (CQ-B060 slice 10). One case per branch of the existing-row ladder plus the
 * create and its dns_resolved retry. The infra-binding decision itself has its
 * own suite (infraDhcpBinding); here it is stubbed to a fixed patch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  del: vi.fn(),
  findFirst: vi.fn(),
  conflictUpdateMany: vi.fn(),
  logEvent: vi.fn(),
  releaseDns: vi.fn(),
  decideInfra: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({
  prisma: {
    reservation: { create: m.create, update: m.update, updateMany: m.updateMany, delete: m.del, findFirst: m.findFirst },
    conflict: { updateMany: m.conflictUpdateMany },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: m.logEvent }));
vi.mock("../../src/services/dnsResolvedReservationService.js", () => ({ releaseDnsResolvedAt: m.releaseDns }));
vi.mock("../../src/utils/infraDhcpBinding.js", () => ({
  isInfraSourceType: (t: string) => t === "fortiswitch" || t === "fortinap",
  decideInfraDhcpBinding: m.decideInfra,
}));

const { syncDhcpEntries } = await import("../../src/services/discovery/dhcp/dhcpEntries.js");

const LABEL = "FortiManager Integration";
const KEY = "net1|10.1.0.5";
beforeEach(() => {
  vi.clearAllMocks();
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new", ...data }));
  m.update.mockResolvedValue({});
  m.updateMany.mockResolvedValue({ count: 0 });
  m.conflictUpdateMany.mockResolvedValue({ count: 0 });
});

const lease = (over: Record<string, unknown> = {}) => ({
  ipAddress: "10.1.0.5", type: "dhcp-lease", device: "FGT-A", interfaceName: "lan", macAddress: "aa-bb-cc-dd-ee-01", hostname: "pc-1",
  ...over,
});
const reservation = (over: Record<string, unknown> = {}) => lease({ type: "dhcp-reservation", ...over });

function run(entries: unknown[], rows: Record<string, Record<string, unknown>> = {}, over: Record<string, unknown> = {}) {
  const state = {
    result: { dhcpEntries: entries } as never,
    activeResMap: new Map<string, any>(Object.entries(rows)),
    assetIdx: { findByMac: () => undefined } as never,
    currentVipKeys: new Set<string>(), vipQueriedDevices: new Set(["FGT-A"]),
    dhcpLeases: [] as string[], dhcpReservations: [] as string[],
    findSubnetForIp: (ip: string) => (ip.startsWith("10.1.") ? { id: "net1" } : undefined),
    reservationKey: (s: string, ip: string) => `${s}|${ip}`,
    upsertConflict: vi.fn() as never, projectRefLabel: LABEL,
    integrationId: "i1", integrationName: "FMG", actor: "system", syncLog: vi.fn(),
    ...over,
  };
  return { state, done: syncDhcpEntries(state as never) };
}
const summary = (syncLog: ReturnType<typeof vi.fn>) =>
  String(syncLog.mock.calls.find((c) => String(c[1]).startsWith("Phase 5 DHCP entry processing"))?.[1] ?? "");

describe("Phase 5 — new entries", () => {
  it("creates a lease named from the matched asset, MAC normalized, after releasing any DNS-resolved row", async () => {
    const asset = { hostname: "laptop-7", assignedTo: "jdoe" };
    const { state, done } = run([lease({ expireTime: 1_800_000_000, vci: "MSFT 5.0" })], {}, { assetIdx: { findByMac: (mac: string) => (mac === "AA:BB:CC:DD:EE:01" ? asset : undefined) } });
    await done;
    expect(m.releaseDns).toHaveBeenCalledWith("net1", "10.1.0.5");
    expect(m.create.mock.calls[0][0].data).toMatchObject({
      subnetId: "net1", ipAddress: "10.1.0.5", hostname: "laptop-7", owner: "jdoe", projectRef: LABEL,
      macAddress: "AA:BB:CC:DD:EE:01", sourceType: "dhcp_lease", expiresAt: new Date(1_800_000_000 * 1000), lastSeenLeased: null,
      notes: "DHCP lease on FGT-A (lan) — MAC: aa-bb-cc-dd-ee-01 — Model: MSFT 5.0",
    });
    expect(state.activeResMap.get(KEY)).toMatchObject({ id: "new" });
    expect(state.dhcpLeases).toEqual(["10.1.0.5 (pc-1)"]);
  });

  it("types a FortiSwitch / FortiAP by its vendor class, and records a held reservation's lastSeenLeased", async () => {
    const { state, done } = run([
      lease({ vci: "FortiSwitch-124F" }),
      reservation({ ipAddress: "10.1.0.6", vci: "FortiAP-231F", seenLeased: true }),
    ]);
    await done;
    expect(m.create.mock.calls.map((c) => c[0].data.sourceType)).toEqual(["fortiswitch", "fortinap"]);
    expect(m.create.mock.calls[1][0].data.lastSeenLeased).toBeInstanceOf(Date);
    expect(state.dhcpReservations).toEqual(["10.1.0.6 (pc-1)"]);
  });

  it("on a unique collision with a dns_resolved row, deletes it and retries once", async () => {
    m.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    m.findFirst.mockResolvedValue({ id: "dns1", sourceType: "dns_resolved" });
    const { state, done } = run([lease()]);
    await done;
    expect(m.del).toHaveBeenCalledWith({ where: { id: "dns1" } });
    expect(m.create).toHaveBeenCalledTimes(2);
    expect(summary(state.syncLog)).toContain("newCreateRetry=1");
  });

  it("on a collision with any other source, skips and logs it", async () => {
    m.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    m.findFirst.mockResolvedValue({ id: "m1", sourceType: "manual" });
    const { state, done } = run([lease()]);
    await done;
    expect(m.del).not.toHaveBeenCalled();
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to create DHCP lease for 10.1.0.5: collided with active manual reservation");
    expect(state.dhcpLeases).toEqual([]);
  });

  it("skips an entry with no address or no known network, and counts both", async () => {
    const { state, done } = run([lease({ ipAddress: "" }), lease({ ipAddress: "192.0.2.9" })]);
    await done;
    expect(m.create).not.toHaveBeenCalled();
    expect(summary(state.syncLog)).toMatch(/skipNoIp=1, skipNoSubnet=1/);
  });
});

describe("Phase 5 — a queued push at the address", () => {
  const pending = { id: "q1", sourceType: "manual", pushStatus: "pending", macAddress: "aa:bb:cc:dd:ee:01", pushedToId: "i1" };

  it("adopts it when the gate already holds the same MAC as a reservation", async () => {
    const row = { ...pending };
    await run([reservation({ scopeId: 3, entryId: 17 })], { [KEY]: row }).done;
    expect(m.update.mock.calls[0][0].data).toMatchObject({ sourceType: "dhcp_reservation", pushStatus: "synced", pushedScopeId: 3, pushedEntryId: 17 });
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "reservation.push.queued.adopted" }));
    expect(row.pushStatus).toBe("synced");
  });

  it("fails it permanently when a different MAC (or a lease) won the address", async () => {
    await run([lease({ macAddress: "11:22:33:44:55:66" })], { [KEY]: { ...pending } }).done;
    expect(m.update.mock.calls[0][0].data).toMatchObject({ pushStatus: "failed_permanent", pushError: "IP collided during queue — discovered dhcp_lease by 11:22:33:44:55:66" });
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "reservation.push.queued.collided", level: "warning" }));
    expect(m.create).not.toHaveBeenCalled();
  });
});

describe("Phase 5 — an existing row at the address", () => {
  it("a Polaris-pushed manual row is its own echo: flipped silently, pending conflicts dismissed", async () => {
    const { state, done } = run([reservation()], { [KEY]: { id: "p1", sourceType: "manual", pushedToId: "i1" } });
    await done;
    expect(m.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { sourceType: "dhcp_reservation" } });
    expect(m.conflictUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { reservationId: "p1", status: "pending" } }));
    expect(state.upsertConflict).not.toHaveBeenCalled();
  });

  it("any other manual row raises a conflict with the DHCP proposal", async () => {
    const row = { id: "m1", sourceType: "manual", pushedToId: null };
    const { state, done } = run([lease()], { [KEY]: row });
    await done;
    expect(state.upsertConflict).toHaveBeenCalledWith("m1", "i1", expect.objectContaining({ sourceType: "dhcp_lease", owner: "dhcp-lease", projectRef: LABEL }), row);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("a VIP the gate no longer reports is succeeded in place; canonical placeholders replaced, operator notes kept", async () => {
    const row: Record<string, unknown> = { id: "v1", sourceType: "vip", owner: "web-dnat", hostname: "web-dnat", notes: "my notes", macAddress: null, vipInfo: { name: "web-dnat", device: "FGT-A" } };
    await run([lease()], { [KEY]: row }).done;
    expect(m.update.mock.calls[0][0].data).toEqual({ sourceType: "dhcp_lease", vipInfo: null, owner: "dhcp-lease", macAddress: "AA:BB:CC:DD:EE:01" });
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "reservation.vip.replaced" }));
    expect(row.notes).toBe("my notes");
  });

  it("a VIP still on the gate only fills its MAC and raises a fill-only conflict", async () => {
    const row = { id: "v1", sourceType: "vip", macAddress: null, vipInfo: { name: "web", device: "FGT-A" } };
    const { state, done } = run([lease()], { [KEY]: row }, { currentVipKeys: new Set([KEY]) });
    await done;
    expect(m.update).toHaveBeenCalledWith({ where: { id: "v1" }, data: { macAddress: "AA:BB:CC:DD:EE:01" } });
    expect(state.upsertConflict).toHaveBeenCalledWith("v1", "i1", expect.anything(), row, "fill-only");
  });

  it("a lease that became a reservation flips type and its canonical owner", async () => {
    await run([reservation()], { [KEY]: { id: "d1", sourceType: "dhcp_lease", owner: "dhcp-lease", expiresAt: null } }).done;
    expect(m.update.mock.calls[0][0].data).toMatchObject({ sourceType: "dhcp_reservation", owner: "dhcp-reservation" });
  });

  it("a steady held reservation costs one updateMany for the whole run, not a write per row", async () => {
    const rows = {
      [KEY]: { id: "r1", sourceType: "dhcp_reservation", expiresAt: null },
      "net1|10.1.0.6": { id: "r2", sourceType: "dhcp_reservation", expiresAt: null },
    };
    const { state, done } = run([reservation({ seenLeased: true }), reservation({ ipAddress: "10.1.0.6", seenLeased: true })], rows);
    await done;
    expect(m.update).not.toHaveBeenCalled();
    expect(m.updateMany).toHaveBeenCalledTimes(1);
    expect(m.updateMany.mock.calls[0][0].where).toEqual({ id: { in: ["r1", "r2"] } });
    expect(summary(state.syncLog)).toContain("updateMany=1 covering 2 rows");
  });

  it("an observed row the gate's DHCP now binds becomes the DHCP row (rule 125)", async () => {
    const row = { id: "o1", sourceType: "observed", macAddress: null };
    await run([lease()], { [KEY]: row }).done;
    expect(m.update.mock.calls[0][0].data).toMatchObject({ sourceType: "dhcp_lease", owner: "dhcp-lease", hostname: "pc-1", macAddress: "AA:BB:CC:DD:EE:01", expiresAt: null });
    expect(row.sourceType).toBe("dhcp_lease");
  });

  it("a managed switch's own row records the binding the infra decision returns (rule 23)", async () => {
    m.decideInfra.mockReturnValueOnce({ dhcpBinding: "reserved", macAddress: "AA:BB:CC:DD:EE:01", lastSeenLeased: true });
    const row: Record<string, unknown> = { id: "f1", sourceType: "fortiswitch", dhcpBinding: "none" };
    await run([reservation()], { [KEY]: row }).done;
    expect(m.update.mock.calls[0][0].data).toMatchObject({ dhcpBinding: "reserved", macAddress: "AA:BB:CC:DD:EE:01", staleNotifiedAt: null });
    expect(row.dhcpBinding).toBe("reserved");
    m.decideInfra.mockReturnValueOnce(null);
    m.update.mockClear();
    await run([reservation()], { [KEY]: { id: "f2", sourceType: "fortinap" } }).done;
    expect(m.update).not.toHaveBeenCalled();
  });
});
