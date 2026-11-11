/**
 * tests/unit/dhcpPhasesExtracted7.test.ts — syncDhcpSubnets Phase 5b, the
 * stale authoritative-row sweep, now src/services/discovery/dhcp/
 * staleAuthoritativeRows.ts (CQ-B060 slice 8).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  resUpdate: stubbed(prisma.reservation.update),
  conflictUpdateMany: stubbed(prisma.conflict.updateMany),
};

const m = vi.hoisted(() => ({
  logEvent: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: m.logEvent }));

const { releaseStaleAuthoritativeRows } = await import("../../src/services/discovery/dhcp/staleAuthoritativeRows.js");
const { Prisma } = await import("../../src/generated/prisma/client.js");

beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
  db.resUpdate.mockResolvedValue({});
  db.conflictUpdateMany.mockResolvedValue({ count: 0 });
});

const key = (s: string, ip: string) => `${s}|${ip}`;
function run(rows: Record<string, Record<string, unknown>>, over: Record<string, unknown> = {}) {
  const activeResMap = new Map<string, any>(Object.entries(rows));
  const state = {
    result: { dhcpReservationsInventoriedDevices: ["FGT-A"], dhcpEntries: [] } as never,
    activeResMap,
    allSubnets: [
      { id: "net1", discoveredBy: "i1", fortigateDevice: "FGT-A" },
      { id: "net2", discoveredBy: "other", fortigateDevice: "FGT-A" },
    ],
    findSubnetForIp: (ip: string) => (ip.startsWith("10.1.") ? { id: "net1" } : ip.startsWith("10.2.") ? { id: "net2" } : undefined),
    reservationKey: key,
    currentVipKeys: new Set<string>(), currentVipStampKeys: new Set<string>(), vipQueriedDevices: new Set(["FGT-A"]),
    integrationId: "i1", integrationName: "FMG", actor: "system", syncLog: vi.fn(),
    ...over,
  };
  return { state, done: releaseStaleAuthoritativeRows(state as never) };
}
const vipRow = (id: string, ip: string, device = "FGT-A") =>
  ({ id, status: "active", sourceType: "vip", subnetId: "net1", ipAddress: ip, vipInfo: { name: "web", device } });

describe("Phase 5b — VIP sweep", () => {
  it("releases a VIP reservation whose VIP left a gate whose VIP table read this cycle", async () => {
    const { state, done } = run({ [key("net1", "10.1.0.10")]: vipRow("v1", "10.1.0.10") });
    await done;
    expect(db.resUpdate).toHaveBeenCalledWith({ where: { id: "v1" }, data: { status: "released", vipInfo: null } });
    expect(db.conflictUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { reservationId: "v1", status: "pending" } }));
    expect(state.activeResMap.has(key("net1", "10.1.0.10"))).toBe(false);
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "reservation.vip.released" }));
    expect(state.syncLog).toHaveBeenCalledWith("info", "Stale-row sweep: released 1 VIP reservation(s), cleared 0 stale VIP stamp(s), released 0 DHCP reservation(s)");
  });

  it("keeps a VIP still reported, and one on a gate whose VIP table did not read (rule 53)", async () => {
    const { done } = run(
      { [key("net1", "10.1.0.10")]: vipRow("v1", "10.1.0.10"), [key("net1", "10.1.0.11")]: vipRow("v2", "10.1.0.11", "FGT-UNREAD") },
      { currentVipKeys: new Set([key("net1", "10.1.0.10")]) },
    );
    await done;
    expect(db.resUpdate).not.toHaveBeenCalled();
  });
});

describe("Phase 5b — stale VIP stamp on a row that owns its address (rule 77)", () => {
  const stamped = () => ({ id: "d1", status: "active", sourceType: "dhcp_lease", subnetId: "net1", ipAddress: "10.1.0.20", vipInfo: { name: "web", device: "FGT-A" } });

  it("clears only the VIP fact; the row stays active and in the index", async () => {
    const row = stamped();
    const { state, done } = run({ [key("net1", "10.1.0.20")]: row });
    await done;
    expect(db.resUpdate).toHaveBeenCalledWith({ where: { id: "d1" }, data: { vipInfo: Prisma.DbNull } });
    expect(row.vipInfo).toBeNull();
    expect(row.status).toBe("active");
    expect(state.activeResMap.has(key("net1", "10.1.0.20"))).toBe(true);
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "reservation.vip.cleared", message: expect.stringContaining("dhcp lease reservation at 10.1.0.20") }));
  });

  it("keeps a stamp whose named VIP is still on the gate", async () => {
    const { done } = run({ [key("net1", "10.1.0.20")]: stamped() }, { currentVipStampKeys: new Set([`FGT-A|web|${key("net1", "10.1.0.20")}`]) });
    await done;
    expect(db.resUpdate).not.toHaveBeenCalled();
  });
});

describe("Phase 5b — dhcp_reservation sweep", () => {
  const res = (id: string, subnetId: string, ip: string) =>
    ({ id, status: "active", sourceType: "dhcp_reservation", subnetId, ipAddress: ip, vipInfo: null, pushedToId: "push-1" });

  it("releases a reservation the gate's CMDB no longer has, clearing its push pointers", async () => {
    const { state, done } = run({ [key("net1", "10.1.0.30")]: res("r1", "net1", "10.1.0.30") });
    await done;
    expect(db.resUpdate).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { status: "released", pushedToId: null, pushedScopeId: null, pushedEntryId: null, pushStatus: null },
    });
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "reservation.dhcp_reservation.released", details: expect.objectContaining({ wasPushedByPolaris: true }),
    }));
    expect(state.activeResMap.size).toBe(0);
  });

  it("keeps one still on the gate and one in another integration's network; releases only when the gate's CMDB read", async () => {
    const { done } = run(
      {
        [key("net1", "10.1.0.31")]: res("on", "net1", "10.1.0.31"),
        [key("net2", "10.2.0.32")]: res("foreign", "net2", "10.2.0.32"),
        [key("net1", "10.1.0.33")]: res("unread", "net1", "10.1.0.33"),
      },
      {
        result: { dhcpReservationsInventoriedDevices: ["FGT-A"], dhcpEntries: [{ ipAddress: "10.1.0.31", device: "FGT-A" }] },
      },
    );
    await done;
    // FGT-A's CMDB read this cycle and no longer lists 10.1.0.33, so that row
    // goes; the same row survives a cycle in which the CMDB did not read.
    expect(db.resUpdate.mock.calls.map((c) => c[0].where.id)).toEqual(["unread"]);

    vi.clearAllMocks();
    const { done: done2 } = run(
      { [key("net1", "10.1.0.33")]: res("unread", "net1", "10.1.0.33") },
      { result: { dhcpReservationsInventoriedDevices: [], dhcpEntries: [] } },
    );
    await done2;
    expect(db.resUpdate).not.toHaveBeenCalled();
  });

  it("logs, rather than throws, a failed release and keeps the row indexed", async () => {
    db.resUpdate.mockRejectedValueOnce(new Error("locked"));
    const { state, done } = run({ [key("net1", "10.1.0.30")]: res("r1", "net1", "10.1.0.30") });
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to release stale DHCP reservation 10.1.0.30: locked");
    expect(state.activeResMap.size).toBe(1);
  });
});
