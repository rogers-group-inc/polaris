/**
 * tests/unit/staleAuthoritativeRows.test.ts — the own suite for
 * src/services/discovery/dhcp/staleAuthoritativeRows.ts (syncDhcpSubnets Phase 5b, CQ-T010).
 *
 * Pins the three sweeps over the active-reservation index: a `vip` row whose
 * VIP left a gate whose VIP table read (released, pending conflicts
 * auto-rejected, dropped from the index), a stale VIP stamp on a row that owns
 * its address (rule 77 — only the stamp goes), and a `dhcp_reservation` the
 * gate's CMDB no longer lists (scoped to this integration's networks and to
 * gates whose CMDB read — rules 17 / 53; a lease at the address still counts as
 * "on the gate"). Every Event, the summary line, and per-row failure isolation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
const { releaseStaleAuthoritativeRows } = await import("../../src/services/discovery/dhcp/staleAuthoritativeRows.js");
const { Prisma } = await import("../../src/generated/prisma/client.js");

const db = {
  resUpdate: stubbed(prisma.reservation.update),
  conflictUpdateMany: stubbed(prisma.conflict.updateMany),
};

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  db.resUpdate.mockResolvedValue({});
  db.conflictUpdateMany.mockResolvedValue({ count: 0 });
});

type Row = Record<string, any>;
const key = (s: string, ip: string) => `${s}|${ip}`;
function run(rows: Record<string, Row | null>, over: Record<string, unknown> = {}) {
  const activeResMap = new Map<string, any>(Object.entries(rows));
  const state = {
    result: { dhcpReservationsInventoriedDevices: ["FGT-A"], dhcpEntries: [] } as never,
    activeResMap,
    allSubnets: [
      { id: "net1", discoveredBy: "i1", fortigateDevice: "FGT-A" },
      { id: "net2", discoveredBy: "other", fortigateDevice: "FGT-A" },
      { id: "net3", discoveredBy: "i1", fortigateDevice: null },
      { id: "net4", discoveredBy: "i1", fortigateDevice: "FGT-B" },
    ],
    findSubnetForIp: (ip: string) => {
      const p = ip.split(".").slice(0, 2).join(".");
      return ({ "10.1": { id: "net1" }, "10.2": { id: "net2" }, "10.3": { id: "net3" }, "10.4": { id: "net4" } } as Record<string, { id: string }>)[p];
    },
    reservationKey: key,
    currentVipKeys: new Set<string>(), currentVipStampKeys: new Set<string>(), vipQueriedDevices: new Set(["FGT-A"]),
    integrationId: "i1", integrationName: "HQ FMG", actor: "discovery" as string | undefined, syncLog: vi.fn(),
    ...over,
  };
  return { state, done: releaseStaleAuthoritativeRows(state) };
}
const vipRow = (id: string, ip: string, over: Row = {}): Row =>
  ({ id, status: "active", sourceType: "vip", subnetId: "net1", ipAddress: ip, vipInfo: { name: "web", device: "FGT-A", role: "external" }, ...over });
const resRow = (id: string, subnetId: string | null, ip: string, over: Row = {}): Row =>
  ({ id, status: "active", sourceType: "dhcp_reservation", subnetId, ipAddress: ip, vipInfo: null, pushedToId: null, ...over });
const events = () => eventLog.logEvent.mock.calls.map((c) => c[0]);
const updatedIds = () => db.resUpdate.mock.calls.map((c) => c[0].where.id);

describe("releaseStaleAuthoritativeRows — index hygiene", () => {
  it("skips empty and non-active entries, and writes no summary when nothing changed", async () => {
    const { state, done } = run({
      a: null,
      b: vipRow("v1", "10.1.0.1", { status: "released" }),
      c: resRow("r1", "net1", "10.1.0.2", { status: "expired" }),
    });
    await done;
    expect(db.resUpdate).not.toHaveBeenCalled();
    expect(state.syncLog).not.toHaveBeenCalled();
  });

  it("never sweeps a lease, an infra row, or a manual row without a stamp", async () => {
    const { done } = run({
      [key("net1", "10.1.0.3")]: resRow("l", "net1", "10.1.0.3", { sourceType: "dhcp_lease" }),
      [key("net1", "10.1.0.4")]: resRow("s", "net1", "10.1.0.4", { sourceType: "fortiswitch" }),
      [key("net1", "10.1.0.5")]: resRow("m", "net1", "10.1.0.5", { sourceType: "manual" }),
    });
    await done;
    expect(db.resUpdate).not.toHaveBeenCalled();
  });
});

describe("releaseStaleAuthoritativeRows — the vip sweep", () => {
  it("releases the row, auto-rejects its pending conflicts, drops it from the index and audits it", async () => {
    const k = key("net1", "10.1.0.10");
    const { state, done } = run({ [k]: vipRow("v1", "10.1.0.10") });
    await done;
    expect(db.resUpdate).toHaveBeenCalledWith({ where: { id: "v1" }, data: { status: "released", vipInfo: null } });
    expect(db.conflictUpdateMany).toHaveBeenCalledWith({
      where: { reservationId: "v1", status: "pending" },
      data: { status: "rejected", resolvedBy: "auto", resolvedAt: expect.any(Date) },
    });
    expect(state.activeResMap.has(k)).toBe(false);
    expect(events()).toEqual([{
      action: "reservation.vip.released", resourceType: "reservation", resourceId: "v1", resourceName: "10.1.0.10", actor: "discovery",
      message: 'VIP "web" no longer on FGT-A — reservation released',
      details: {
        integrationId: "i1", integrationName: "HQ FMG", reservationId: "v1", ipAddress: "10.1.0.10",
        priorVipInfo: { name: "web", device: "FGT-A", role: "external" }, fortigateDevice: "FGT-A",
      },
    }]);
    expect(state.syncLog).toHaveBeenCalledWith("info", "Stale-row sweep: released 1 VIP reservation(s), cleared 0 stale VIP stamp(s), released 0 DHCP reservation(s)");
  });

  it("keeps a VIP still reported, one on an unread gate (rule 53), and one with no snapshot", async () => {
    const { state, done } = run(
      {
        [key("net1", "10.1.0.10")]: vipRow("current", "10.1.0.10"),
        [key("net1", "10.1.0.11")]: vipRow("unread", "10.1.0.11", { vipInfo: { name: "web", device: "FGT-Z" } }),
        [key("net1", "10.1.0.12")]: vipRow("bare", "10.1.0.12", { vipInfo: null }),
      },
      { currentVipKeys: new Set([key("net1", "10.1.0.10")]) },
    );
    await done;
    expect(db.resUpdate).not.toHaveBeenCalled();
    expect(state.activeResMap.size).toBe(3);
  });

  it("a failed release is logged; the row stays indexed and its conflicts untouched", async () => {
    db.resUpdate.mockRejectedValueOnce(new Error("locked"));
    const { state, done } = run({ [key("net1", "10.1.0.10")]: vipRow("v1", "10.1.0.10") });
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to release stale VIP reservation 10.1.0.10: locked");
    expect(db.conflictUpdateMany).not.toHaveBeenCalled();
    expect(state.activeResMap.size).toBe(1);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("releaseStaleAuthoritativeRows — stale VIP stamps (rule 77)", () => {
  it("clears the stamp from a manual claim; the row stays active, indexed, and every operator field survives", async () => {
    const k = key("net1", "10.1.0.20");
    const row = resRow("m1", "net1", "10.1.0.20", { sourceType: "manual", owner: "ops", vipInfo: { name: "web", device: "FGT-A" } });
    const { state, done } = run({ [k]: row });
    await done;
    expect(db.resUpdate).toHaveBeenCalledWith({ where: { id: "m1" }, data: { vipInfo: Prisma.DbNull } });
    expect(row).toMatchObject({ vipInfo: null, status: "active", owner: "ops" });
    expect(state.activeResMap.get(k)).toBe(row);
    expect(events()).toEqual([{
      action: "reservation.vip.cleared", resourceType: "reservation", resourceId: "m1", resourceName: "10.1.0.20", actor: "discovery",
      message: "VIP \"web\" no longer on FGT-A — cleared from manual reservation at 10.1.0.20",
      details: {
        integrationId: "i1", integrationName: "HQ FMG", reservationId: "m1", ipAddress: "10.1.0.20", sourceType: "manual",
        priorVipInfo: { name: "web", device: "FGT-A" }, fortigateDevice: "FGT-A",
      },
    }]);
    expect(state.syncLog).toHaveBeenCalledWith("info", "Stale-row sweep: released 0 VIP reservation(s), cleared 1 stale VIP stamp(s), released 0 DHCP reservation(s)");
  });

  it("keeps a stamp whose VIP of that NAME still covers the address, and one naming an unread gate", async () => {
    const { done } = run(
      {
        [key("net1", "10.1.0.20")]: resRow("keep", "net1", "10.1.0.20", { sourceType: "manual", vipInfo: { name: "web", device: "FGT-A" } }),
        [key("net1", "10.1.0.21")]: resRow("unread", "net1", "10.1.0.21", { sourceType: "manual", vipInfo: { name: "web", device: "FGT-Z" } }),
      },
      { currentVipStampKeys: new Set([`FGT-A|web|${key("net1", "10.1.0.20")}`]) },
    );
    await done;
    expect(db.resUpdate).not.toHaveBeenCalled();
  });

  it("a renamed VIP at the address does not keep the old name's stamp", async () => {
    const { done } = run(
      { [key("net1", "10.1.0.20")]: resRow("m1", "net1", "10.1.0.20", { sourceType: "manual", vipInfo: { name: "old-web", device: "FGT-A" } }) },
      { currentVipStampKeys: new Set([`FGT-A|new-web|${key("net1", "10.1.0.20")}`]) },
    );
    await done;
    expect(updatedIds()).toEqual(["m1"]);
  });

  it("a nameless stamp reads '(unknown)', and a row with no IP names '(subnet)'", async () => {
    const { done } = run({ k: resRow("m1", "net1", "", { sourceType: "dhcp_lease", ipAddress: null, vipInfo: { device: "FGT-A" } }) });
    await done;
    expect(events()[0]).toMatchObject({
      resourceName: "",
      message: 'VIP "(unknown)" no longer on FGT-A — cleared from dhcp lease reservation at (subnet)',
    });
  });

  it("a cleared dhcp_reservation falls through: the reservation sweep still judges the row itself", async () => {
    const k = key("net1", "10.1.0.30");
    const { state, done } = run({ [k]: resRow("r1", "net1", "10.1.0.30", { vipInfo: { name: "web", device: "FGT-A" } }) });
    await done;
    expect(db.resUpdate.mock.calls.map((c) => c[0].data)).toEqual([
      { vipInfo: Prisma.DbNull },
      { status: "released", pushedToId: null, pushedScopeId: null, pushedEntryId: null, pushStatus: null },
    ]);
    expect(events().map((e) => e.action)).toEqual(["reservation.vip.cleared", "reservation.dhcp_reservation.released"]);
    expect(state.activeResMap.has(k)).toBe(false);
  });

  it("a failed clear is logged and leaves the in-memory stamp", async () => {
    db.resUpdate.mockRejectedValueOnce(new Error("timeout"));
    const row = resRow("m1", "net1", "10.1.0.20", { sourceType: "manual", vipInfo: { name: "web", device: "FGT-A" } });
    const { state, done } = run({ k: row });
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to clear stale VIP stamp on 10.1.0.20: timeout");
    expect(row.vipInfo).toEqual({ name: "web", device: "FGT-A" });
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("releaseStaleAuthoritativeRows — the dhcp_reservation sweep", () => {
  it("releases a reservation the gate's CMDB read and no longer lists, clearing its push pointers", async () => {
    const k = key("net1", "10.1.0.30");
    const { state, done } = run({ [k]: resRow("r1", "net1", "10.1.0.30", { pushedToId: "srv-1" }) });
    await done;
    expect(db.resUpdate).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { status: "released", pushedToId: null, pushedScopeId: null, pushedEntryId: null, pushStatus: null },
    });
    expect(db.conflictUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { reservationId: "r1", status: "pending" } }));
    expect(events()).toEqual([{
      action: "reservation.dhcp_reservation.released", resourceType: "reservation", resourceId: "r1", resourceName: "10.1.0.30", actor: "discovery",
      message: "DHCP reservation for 10.1.0.30 no longer on FGT-A — reservation released",
      details: { integrationId: "i1", integrationName: "HQ FMG", reservationId: "r1", ipAddress: "10.1.0.30", fortigateDevice: "FGT-A", wasPushedByPolaris: true },
    }]);
    expect(state.activeResMap.has(k)).toBe(false);
    expect(state.syncLog).toHaveBeenCalledWith("info", "Stale-row sweep: released 0 VIP reservation(s), cleared 0 stale VIP stamp(s), released 1 DHCP reservation(s)");
  });

  it("an entry at the address keeps the row — a lease counts, but only from a gate whose CMDB read", async () => {
    const { done } = run(
      {
        [key("net1", "10.1.0.31")]: resRow("leased", "net1", "10.1.0.31"),
        [key("net1", "10.1.0.32")]: resRow("otherGate", "net1", "10.1.0.32"),
      },
      {
        result: {
          dhcpReservationsInventoriedDevices: ["FGT-A"],
          dhcpEntries: [
            { type: "dhcp-lease", ipAddress: "10.1.0.31", device: "FGT-A" },
            { type: "dhcp-reservation", ipAddress: "10.1.0.32", device: "FGT-UNREAD" },
            { type: "dhcp-reservation", ipAddress: "", device: "FGT-A" },
            { type: "dhcp-reservation", ipAddress: "192.0.2.1", device: "FGT-A" },
          ],
        },
      },
    );
    await done;
    expect(updatedIds()).toEqual(["otherGate"]);
    expect(events()[0].details).toMatchObject({ wasPushedByPolaris: false });
  });

  it("scope: never a row with no network, in another integration's network, on a gateless network, or under an unread gate", async () => {
    const { done } = run({
      a: resRow("noSubnet", null, "10.1.0.40"),
      b: resRow("unknownSubnet", "net9", "10.9.0.40"),
      c: resRow("foreign", "net2", "10.2.0.40"),
      d: resRow("gateless", "net3", "10.3.0.40"),
      e: resRow("unread", "net4", "10.4.0.40"),
    });
    await done;
    expect(db.resUpdate).not.toHaveBeenCalled();
  });

  it("tolerates a result with no dhcpEntries array and no inventoried list", async () => {
    const { done } = run({ k: resRow("r1", "net1", "10.1.0.30") }, { result: { dhcpEntries: undefined } });
    await done;
    expect(db.resUpdate).not.toHaveBeenCalled();
  });

  it("a failed release is logged, the row stays indexed, and the sweep moves on", async () => {
    db.resUpdate.mockRejectedValueOnce(new Error("locked"));
    const { state, done } = run({ a: resRow("r1", "net1", "10.1.0.30"), b: resRow("r2", "net1", "10.1.0.31") });
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to release stale DHCP reservation 10.1.0.30: locked");
    expect([...state.activeResMap.keys()]).toEqual(["a"]);
    expect(events().map((e) => e.resourceId)).toEqual(["r2"]);
  });
});
