/**
 * tests/unit/dhcpEntries.test.ts — the own suite for
 * src/services/discovery/dhcp/dhcpEntries.ts (syncDhcpSubnets Phase 5, CQ-T010).
 *
 * Pins every branch an existing reservation can take when the gate reports a
 * DHCP entry at its address — the queued-push adopt / collide pair, the
 * Polaris-pushed echo, the manual conflict, VIP succession vs the fill-only
 * merge, the dhcp_* source flip / lease renewal / deferred staleness bump,
 * the observed IPv6 supersede (rule 125) and the infra binding record (rule 23:
 * sourceType and expiresAt never touched) — plus the create path with its
 * dns_resolved release, the one P2002 retry, and the summary counters.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const m = vi.hoisted(() => ({ releaseDns: vi.fn() }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/dnsResolvedReservationService.js", () => ({ releaseDnsResolvedAt: m.releaseDns }));

import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
const { syncDhcpEntries } = await import("../../src/services/discovery/dhcp/dhcpEntries.js");

const db = {
  resCreate: stubbed(prisma.reservation.create),
  resUpdate: stubbed(prisma.reservation.update),
  resUpdateMany: stubbed(prisma.reservation.updateMany),
  resFindFirst: stubbed(prisma.reservation.findFirst),
  resDelete: stubbed(prisma.reservation.delete),
  conflictUpdateMany: stubbed(prisma.conflict.updateMany),
};

let nextId = 0;
beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  m.releaseDns.mockReset();
  m.releaseDns.mockResolvedValue(undefined);
  nextId = 0;
  db.resCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `new${++nextId}`, ...data }));
  db.resUpdate.mockResolvedValue({});
  db.resUpdateMany.mockResolvedValue({ count: 0 });
  db.conflictUpdateMany.mockResolvedValue({ count: 0 });
  db.resDelete.mockResolvedValue({});
});

type Entry = Record<string, any>;

function lease(over: Entry = {}): Entry {
  return {
    ipAddress: "10.0.0.5", macAddress: "aa-bb-cc-dd-ee-01", hostname: "laptop1",
    type: "dhcp-lease", device: "FGT1", interfaceName: "port1", ...over,
  };
}
function reservation(over: Entry = {}): Entry {
  return lease({ type: "dhcp-reservation", ...over });
}

function run(entries: Entry[] | undefined, over: Record<string, unknown> = {}) {
  const state = {
    result: { dhcpEntries: entries } as never,
    activeResMap: new Map<string, any>(),
    dnsResolvedKeys: undefined as ReadonlySet<string> | undefined,
    assetIdx: { findByMac: vi.fn((_mac: string): any => undefined) } as any,
    currentVipKeys: new Set<string>(),
    vipQueriedDevices: new Set<string>(),
    dhcpLeases: [] as string[],
    dhcpReservations: [] as string[],
    findSubnetForIp: (ip: string) => (ip.startsWith("10.") ? { id: "s1" } : undefined),
    reservationKey: (s: string, ip: string) => `${s}|${ip}`,
    upsertConflict: vi.fn(async (..._a: any[]) => undefined),
    projectRefLabel: "FortiGate Integration",
    integrationId: "int1",
    integrationName: "Main FGT",
    actor: "discovery",
    syncLog: vi.fn(),
    ...over,
  };
  return { state, done: syncDhcpEntries(state as never) };
}

function summary(state: { syncLog: ReturnType<typeof vi.fn> }): string {
  const call = state.syncLog.mock.calls.find((c) => c[0] === "info");
  return call ? String(call[1]) : "";
}

describe("syncDhcpEntries — no work", () => {
  it("writes nothing and logs no summary when the result has no DHCP entries", async () => {
    const { state, done } = run([]);
    await done;
    expect(state.syncLog).not.toHaveBeenCalled();
    expect(db.resCreate).not.toHaveBeenCalled();
    expect(db.resUpdateMany).not.toHaveBeenCalled();
  });

  it("tolerates an absent dhcpEntries array", async () => {
    const { state, done } = run(undefined);
    await done;
    expect(state.syncLog).not.toHaveBeenCalled();
  });

  it("skips an entry with no IP and counts it", async () => {
    const { state, done } = run([lease({ ipAddress: "" })]);
    await done;
    expect(db.resCreate).not.toHaveBeenCalled();
    expect(summary(state)).toContain("1 entries");
    expect(summary(state)).toContain("skipNoIp=1");
  });

  it("skips an entry outside every known subnet and counts it", async () => {
    const { state, done } = run([lease({ ipAddress: "192.168.9.9" })]);
    await done;
    expect(db.resCreate).not.toHaveBeenCalled();
    expect(summary(state)).toContain("skipNoSubnet=1");
  });
});

describe("syncDhcpEntries — create path", () => {
  it("creates a dhcp_lease row with the lease end, normalized MAC and the composed notes", async () => {
    const { state, done } = run([lease({ expireTime: 1_800_000_000, vci: "MSFT 5.0", ssid: "Corp", accessPoint: "AP-1" })]);
    await done;
    expect(db.resCreate).toHaveBeenCalledTimes(1);
    const data = db.resCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      subnetId: "s1", ipAddress: "10.0.0.5", hostname: "laptop1", owner: "dhcp-lease",
      projectRef: "FortiGate Integration", macAddress: "AA:BB:CC:DD:EE:01", status: "active",
      sourceType: "dhcp_lease", lastSeenLeased: null,
    });
    expect(data.expiresAt).toEqual(new Date(1_800_000_000 * 1000));
    expect(data.notes).toBe("DHCP lease on FGT1 (port1) — MAC: aa-bb-cc-dd-ee-01 — Model: MSFT 5.0 — SSID: Corp — AP: AP-1");
    expect(state.dhcpLeases).toEqual(["10.0.0.5 (laptop1)"]);
    expect(state.activeResMap.get("s1|10.0.0.5")).toMatchObject({ id: "new1" });
  });

  it("creates a dhcp_reservation row with no expiry and a presence baseline when the client is online", async () => {
    const { state, done } = run([reservation({ seenLeased: true, expireTime: 1_800_000_000 })]);
    await done;
    const data = db.resCreate.mock.calls[0][0].data;
    expect(data.sourceType).toBe("dhcp_reservation");
    expect(data.owner).toBe("dhcp-reservation");
    expect(data.expiresAt).toBeUndefined();
    expect(data.lastSeenLeased).toBeInstanceOf(Date);
    expect(data.notes.startsWith("DHCP reservation on FGT1 (port1)")).toBe(true);
    expect(state.dhcpReservations).toEqual(["10.0.0.5 (laptop1)"]);
    expect(state.dhcpLeases).toEqual([]);
  });

  it("gives an offline reservation no presence baseline", async () => {
    const { done } = run([reservation({ seenLeased: false })]);
    await done;
    expect(db.resCreate.mock.calls[0][0].data.lastSeenLeased).toBeNull();
  });

  it("stamps no presence baseline on a lease even when it is seen leased", async () => {
    const { done } = run([lease({ seenLeased: true })]);
    await done;
    expect(db.resCreate.mock.calls[0][0].data.lastSeenLeased).toBeNull();
  });

  it("types a FortiSwitch / FortiAP by its vendor class, case-blind", async () => {
    const { done } = run([
      lease({ ipAddress: "10.0.0.6", vci: "FortiSwitch-148F" }),
      reservation({ ipAddress: "10.0.0.7", vci: "FORTIAP-231F" }),
    ]);
    await done;
    expect(db.resCreate.mock.calls[0][0].data.sourceType).toBe("fortiswitch");
    expect(db.resCreate.mock.calls[1][0].data.sourceType).toBe("fortinap");
  });

  it("takes hostname and owner from the asset the MAC matches, looking it up by the normalized MAC", async () => {
    const assetIdx = { findByMac: vi.fn(() => ({ hostname: "asset-host", assignedTo: "jdoe" })) };
    const { done } = run([lease({ hostname: "dhcp-name" })], { assetIdx });
    await done;
    expect(assetIdx.findByMac).toHaveBeenCalledWith("AA:BB:CC:DD:EE:01");
    expect(db.resCreate.mock.calls[0][0].data).toMatchObject({ hostname: "asset-host", owner: "jdoe" });
  });

  it("falls back to the DHCP hostname and the placeholder owner when the matched asset has neither", async () => {
    const assetIdx = { findByMac: vi.fn(() => ({ hostname: null, assignedTo: null })) };
    const { done } = run([lease({ hostname: "dhcp-name" })], { assetIdx });
    await done;
    expect(db.resCreate.mock.calls[0][0].data).toMatchObject({ hostname: "dhcp-name", owner: "dhcp-lease" });
  });

  it("does no MAC lookup and stores a null MAC / hostname when the entry carries neither", async () => {
    const assetIdx = { findByMac: vi.fn() };
    const { state, done } = run([lease({ macAddress: undefined, hostname: undefined })], { assetIdx });
    await done;
    expect(assetIdx.findByMac).not.toHaveBeenCalled();
    const data = db.resCreate.mock.calls[0][0].data;
    expect(data.macAddress).toBeNull();
    expect(data.hostname).toBeNull();
    expect(data.notes).toBe("DHCP lease on FGT1 (port1)");
    expect(state.dhcpLeases).toEqual(["10.0.0.5 (undefined)"]);
  });

  it("labels the summary entry by MAC when the lease has no hostname", async () => {
    const { state, done } = run([lease({ hostname: "" })]);
    await done;
    expect(state.dhcpLeases).toEqual(["10.0.0.5 (aa-bb-cc-dd-ee-01)"]);
  });

  it("releases a dns_resolved row before every create when the load's key set is unknown", async () => {
    const { done } = run([lease()]);
    await done;
    expect(m.releaseDns).toHaveBeenCalledWith("s1", "10.0.0.5");
    expect(m.releaseDns.mock.invocationCallOrder[0]).toBeLessThan(db.resCreate.mock.invocationCallOrder[0]);
  });

  it("skips the release when the load saw no dns_resolved row at the key", async () => {
    const { state, done } = run([lease()], { dnsResolvedKeys: new Set(["s1|10.9.9.9"]) });
    await done;
    expect(m.releaseDns).not.toHaveBeenCalled();
    expect(db.resCreate).toHaveBeenCalledTimes(1);
    expect(summary(state)).toContain("dnsReleases=0");
  });

  it("releases when the load saw a dns_resolved row at the key", async () => {
    const { done } = run([lease()], { dnsResolvedKeys: new Set(["s1|10.0.0.5"]) });
    await done;
    expect(m.releaseDns).toHaveBeenCalledTimes(1);
  });

  it("on a unique collision with a dns_resolved row, deletes it and retries the create once", async () => {
    db.resCreate
      .mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }))
      .mockImplementationOnce(async ({ data }: any) => ({ id: "retry", ...data }));
    db.resFindFirst.mockResolvedValue({ id: "dns1", sourceType: "dns_resolved" });
    const { state, done } = run([lease()]);
    await done;
    expect(db.resFindFirst.mock.calls[0][0].where).toEqual({ subnetId: "s1", ipAddress: "10.0.0.5", status: "active" });
    expect(db.resDelete).toHaveBeenCalledWith({ where: { id: "dns1" } });
    expect(db.resCreate).toHaveBeenCalledTimes(2);
    expect(state.activeResMap.get("s1|10.0.0.5")).toMatchObject({ id: "retry" });
    expect(summary(state)).toContain("newCreateRetry=1");
    expect(summary(state)).toContain("deletes=1");
  });

  it("on a unique collision with any other source, logs it, skips the IP and never deletes", async () => {
    db.resCreate.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    db.resFindFirst.mockResolvedValue({ id: "man1", sourceType: "manual" });
    const { state, done } = run([lease()]);
    await done;
    expect(db.resDelete).not.toHaveBeenCalled();
    expect(state.activeResMap.size).toBe(0);
    expect(state.dhcpLeases).toEqual([]);
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to create DHCP lease for 10.0.0.5: collided with active manual reservation");
    expect(summary(state)).toContain("skipCollision=1");
  });

  it("names a vanished colliding row as (missing)", async () => {
    db.resCreate.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    db.resFindFirst.mockResolvedValue(null);
    const { state, done } = run([reservation()]);
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to create DHCP reservation for 10.0.0.5: collided with active (missing) reservation");
  });

  it("counts a non-unique create failure, logs it, and carries on with the next entry", async () => {
    db.resCreate
      .mockRejectedValueOnce(new Error("db down"))
      .mockImplementationOnce(async ({ data }: any) => ({ id: "ok", ...data }));
    const { state, done } = run([lease(), lease({ ipAddress: "10.0.0.9" })]);
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to create DHCP lease for 10.0.0.5: db down");
    expect(state.activeResMap.has("s1|10.0.0.9")).toBe(true);
    expect(summary(state)).toContain("newCreateFail=1");
    expect(summary(state)).toContain("newCreate=1");
  });

  it("counts a failed dns release as a failed create without trying the insert", async () => {
    m.releaseDns.mockRejectedValueOnce(new Error("release boom"));
    const { state, done } = run([lease()]);
    await done;
    expect(db.resCreate).not.toHaveBeenCalled();
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to create DHCP lease for 10.0.0.5: release boom");
  });
});

describe("syncDhcpEntries — a queued (pending) push at the address", () => {
  function pending(over: Record<string, unknown> = {}) {
    return { id: "p1", sourceType: "manual", pushStatus: "pending", pushedToId: "int1", macAddress: "aa:bb:cc:dd:ee:01", hostname: "printer", ...over };
  }

  it("adopts the row when the gate already holds a reservation for the same MAC", async () => {
    const res = pending();
    const { state, done } = run([reservation({ scopeId: 3, entryId: 7, seenLeased: true })], { activeResMap: new Map([["s1|10.0.0.5", res]]) });
    await done;
    expect(db.resUpdate).toHaveBeenCalledTimes(1);
    const { where, data } = db.resUpdate.mock.calls[0][0];
    expect(where).toEqual({ id: "p1" });
    expect(data).toMatchObject({
      sourceType: "dhcp_reservation", pushedToId: "int1", pushedScopeId: 3, pushedEntryId: 7,
      pushStatus: "synced", pushError: null, pushQueuedAt: null, pushAttempts: 0, pushLastAttemptAt: null,
      staleNotifiedAt: null, staleSnoozedUntil: null,
    });
    expect(data.lastSeenLeased).toBeInstanceOf(Date);
    expect(db.conflictUpdateMany).toHaveBeenCalledWith({
      where: { reservationId: "p1", status: "pending" },
      data: { status: "rejected", resolvedBy: "auto", resolvedAt: expect.any(Date) },
    });
    expect(res.sourceType).toBe("dhcp_reservation");
    expect(res.pushStatus).toBe("synced");
    expect(db.resCreate).not.toHaveBeenCalled();
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ action: "reservation.push.queued.adopted", level: "info", resourceId: "p1", resourceName: "printer", actor: "discovery" });
    expect(ev.details).toMatchObject({ integrationId: "int1", deviceName: "FGT1", scopeId: 3, entryId: 7, ip: "10.0.0.5", mac: "AA:BB:CC:DD:EE:01" });
    expect(summary(state)).toContain("pendingAdopt=1");
  });

  it("adopts without a presence stamp when the client is not seen leased", async () => {
    const { done } = run([reservation({ scopeId: 3, entryId: 7 })], { activeResMap: new Map([["s1|10.0.0.5", pending()]]) });
    await done;
    expect(db.resUpdate.mock.calls[0][0].data).not.toHaveProperty("lastSeenLeased");
  });

  it("marks the push failed_permanent when the gate holds the IP for a different MAC", async () => {
    const res = pending();
    const { state, done } = run([reservation({ macAddress: "11:22:33:44:55:66", scopeId: 3, entryId: 7 })], { activeResMap: new Map([["s1|10.0.0.5", res]]) });
    await done;
    const data = db.resUpdate.mock.calls[0][0].data;
    expect(data).toMatchObject({ pushStatus: "failed_permanent", pushError: "IP collided during queue — discovered dhcp_reservation by 11:22:33:44:55:66" });
    expect(data.pushLastAttemptAt).toBeInstanceOf(Date);
    expect(res.pushStatus).toBe("failed_permanent");
    expect(res.sourceType).toBe("manual");
    expect(db.conflictUpdateMany).not.toHaveBeenCalled();
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ action: "reservation.push.queued.collided", level: "warning" });
    expect(ev.details).toMatchObject({ pendingMac: "AA:BB:CC:DD:EE:01", discoveredSourceType: "dhcp_reservation", discoveredMac: "11:22:33:44:55:66" });
    expect(summary(state)).toContain("pendingCollide=1");
  });

  it("treats a dynamic lease at the address as a collision even for the same MAC", async () => {
    const { done } = run([lease({ scopeId: 3, entryId: 7 })], { activeResMap: new Map([["s1|10.0.0.5", pending()]]) });
    await done;
    expect(db.resUpdate.mock.calls[0][0].data.pushStatus).toBe("failed_permanent");
    expect(eventLog.logEvent.mock.calls[0][0].action).toBe("reservation.push.queued.collided");
  });

  it("collides when the reservation lacks a numeric scope / entry id", async () => {
    const { done } = run([reservation({ scopeId: "3", entryId: 7 })], { activeResMap: new Map([["s1|10.0.0.5", pending()]]) });
    await done;
    expect(db.resUpdate.mock.calls[0][0].data.pushStatus).toBe("failed_permanent");
  });

  it("collides when the pending row has no MAC, and omits the 'by' clause when the entry has none", async () => {
    const { done } = run([reservation({ macAddress: undefined, scopeId: 1, entryId: 1 })], { activeResMap: new Map([["s1|10.0.0.5", pending({ macAddress: null, hostname: null })]]) });
    await done;
    expect(db.resUpdate.mock.calls[0][0].data.pushError).toBe("IP collided during queue — discovered dhcp_reservation");
    expect(eventLog.logEvent.mock.calls[0][0].resourceName).toBe("10.0.0.5");
  });
});

describe("syncDhcpEntries — manual rows", () => {
  it("silently flips a Polaris-pushed row seeing its own echo and dismisses its pending conflicts", async () => {
    const res = { id: "m1", sourceType: "manual", pushedToId: "int1", hostname: "keep-me", owner: "ops" };
    const { state, done } = run([reservation({ seenLeased: true })], { activeResMap: new Map([["s1|10.0.0.5", res]]) });
    await done;
    const data = db.resUpdate.mock.calls[0][0].data;
    expect(data.sourceType).toBe("dhcp_reservation");
    expect(data.lastSeenLeased).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty("hostname");
    expect(data).not.toHaveProperty("owner");
    expect(db.conflictUpdateMany.mock.calls[0][0].where).toEqual({ reservationId: "m1", status: "pending" });
    expect(state.upsertConflict).not.toHaveBeenCalled();
    expect(summary(state)).toContain("polarisEcho=1");
  });

  it("stamps no presence on an echo seen only as a lease", async () => {
    const { done } = run([lease({ seenLeased: true })], { activeResMap: new Map([["s1|10.0.0.5", { id: "m1", sourceType: "manual", pushedToId: "int1" }]]) });
    await done;
    expect(db.resUpdate.mock.calls[0][0].data).toEqual({ sourceType: "dhcp_reservation" });
  });

  it("raises a conflict for an operator-typed manual row and writes nothing to it", async () => {
    const res = { id: "m2", sourceType: "manual", pushedToId: null };
    const { state, done } = run([lease({ expireTime: 1_800_000_000 })], { activeResMap: new Map([["s1|10.0.0.5", res]]) });
    await done;
    expect(db.resUpdate).not.toHaveBeenCalled();
    expect(state.upsertConflict).toHaveBeenCalledWith("m2", "int1", {
      hostname: "laptop1", owner: "dhcp-lease", projectRef: "FortiGate Integration",
      notes: "DHCP lease on FGT1 (port1) — MAC: aa-bb-cc-dd-ee-01", sourceType: "dhcp_lease",
    }, res);
    expect(summary(state)).toContain("manualConflict=1");
    expect(summary(state)).toContain("upsertConflicts=1");
  });
});

describe("syncDhcpEntries — VIP rows", () => {
  function vip(over: Record<string, unknown> = {}) {
    return {
      id: "v1", sourceType: "vip", vipInfo: { name: "web-vip", device: "FGT1" },
      owner: "web-vip", hostname: "web-vip", notes: "Firewall VIP web-vip", macAddress: null, ...over,
    };
  }

  it("converts a vanished VIP's row in place, replacing only its canonical placeholders", async () => {
    const res = vip();
    const { state, done } = run([reservation({ seenLeased: true })], {
      activeResMap: new Map([["s1|10.0.0.5", res]]), vipQueriedDevices: new Set(["FGT1"]),
    });
    await done;
    const data = db.resUpdate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      sourceType: "dhcp_reservation", vipInfo: null, owner: "dhcp-reservation",
      macAddress: "AA:BB:CC:DD:EE:01", staleNotifiedAt: null, staleSnoozedUntil: null,
    });
    expect(data.notes.startsWith("DHCP reservation on FGT1")).toBe(true);
    expect(data.lastSeenLeased).toBeInstanceOf(Date);
    expect(db.conflictUpdateMany.mock.calls[0][0].where).toEqual({ reservationId: "v1", status: "pending" });
    expect(res).toMatchObject({ sourceType: "dhcp_reservation", vipInfo: null, owner: "dhcp-reservation", macAddress: "AA:BB:CC:DD:EE:01" });
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev.action).toBe("reservation.vip.replaced");
    expect(ev.message).toBe('VIP "web-vip" no longer on FGT1 — converted to dhcp reservation at 10.0.0.5');
    expect(ev.details).toMatchObject({ priorVipInfo: { name: "web-vip", device: "FGT1" }, newSourceType: "dhcp_reservation", fortigateDevice: "FGT1" });
    expect(state.upsertConflict).not.toHaveBeenCalled();
    expect(summary(state)).toContain("vipSucc=1");
  });

  it("keeps an operator's owner and notes through the succession", async () => {
    const { done } = run([lease()], {
      activeResMap: new Map([["s1|10.0.0.5", vip({ owner: "Web team", notes: "Do not touch" })]]),
      vipQueriedDevices: new Set(["FGT1"]),
    });
    await done;
    const data = db.resUpdate.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("owner");
    expect(data).not.toHaveProperty("notes");
    expect(data.sourceType).toBe("dhcp_lease");
  });

  it("treats an owner matching the discovery hostname (a renamed VIP) as canonical, and empty / 'Virtual server' notes too", async () => {
    const { done } = run([lease()], {
      activeResMap: new Map([["s1|10.0.0.5", vip({ vipInfo: { name: "renamed", device: "FGT1" }, owner: "web-vip", notes: "Virtual server vs1" })]]),
      vipQueriedDevices: new Set(["FGT1"]),
    });
    await done;
    const data = db.resUpdate.mock.calls[0][0].data;
    expect(data.owner).toBe("dhcp-lease");
    expect(data.notes.startsWith("DHCP lease")).toBe(true);
  });

  it("never replaces an existing MAC on succession", async () => {
    const { done } = run([lease()], {
      activeResMap: new Map([["s1|10.0.0.5", vip({ macAddress: "11:11:11:11:11:11" })]]),
      vipQueriedDevices: new Set(["FGT1"]),
    });
    await done;
    expect(db.resUpdate.mock.calls[0][0].data).not.toHaveProperty("macAddress");
  });

  it("raises a fill-only conflict and silently fills the MAC while the VIP still exists", async () => {
    const res = vip();
    const { state, done } = run([lease()], {
      activeResMap: new Map([["s1|10.0.0.5", res]]),
      currentVipKeys: new Set(["s1|10.0.0.5"]), vipQueriedDevices: new Set(["FGT1"]),
    });
    await done;
    expect(db.resUpdate).toHaveBeenCalledWith({ where: { id: "v1" }, data: { macAddress: "AA:BB:CC:DD:EE:01" } });
    expect(res.macAddress).toBe("AA:BB:CC:DD:EE:01");
    expect(state.upsertConflict.mock.calls[0][4]).toBe("fill-only");
    expect(state.upsertConflict.mock.calls[0][3]).toBe(res);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
    expect(summary(state)).toContain("vipMacFill=1");
  });

  it("never treats a VIP as gone when its gate's VIP table did not read this cycle", async () => {
    const { state, done } = run([lease()], { activeResMap: new Map([["s1|10.0.0.5", vip({ macAddress: "11:11:11:11:11:11" })]]) });
    await done;
    expect(db.resUpdate).not.toHaveBeenCalled();
    expect(state.upsertConflict.mock.calls[0][4]).toBe("fill-only");
  });
});

describe("syncDhcpEntries — existing dhcp_* rows", () => {
  it("flips a lease promoted to a reservation: source, placeholder owner, expiry cleared and presence stamped", async () => {
    const res = { id: "d1", sourceType: "dhcp_lease", owner: "dhcp-lease", expiresAt: new Date("2026-11-14T00:00:00Z") };
    const { state, done } = run([reservation({ seenLeased: true })], { activeResMap: new Map([["s1|10.0.0.5", res]]) });
    await done;
    const data = db.resUpdate.mock.calls[0][0].data;
    expect(data).toMatchObject({ sourceType: "dhcp_reservation", owner: "dhcp-reservation", expiresAt: null, staleNotifiedAt: null });
    expect(data.lastSeenLeased).toBeInstanceOf(Date);
    expect(res.expiresAt).toBeNull();
    expect(db.resUpdateMany).not.toHaveBeenCalled();
    expect(summary(state)).toContain("dhcpFlipMixed=1");
  });

  it("flips a reservation demoted to a lease and keeps an operator-stamped owner", async () => {
    const res = { id: "d1", sourceType: "dhcp_reservation", owner: "Finance", expiresAt: null };
    const { done } = run([lease({ expireTime: 1_800_000_000 })], { activeResMap: new Map([["s1|10.0.0.5", res]]) });
    await done;
    const data = db.resUpdate.mock.calls[0][0].data;
    expect(data.sourceType).toBe("dhcp_lease");
    expect(data).not.toHaveProperty("owner");
    expect(data.expiresAt).toEqual(new Date(1_800_000_000 * 1000));
  });

  it("carries a renewed lease's new end onto the row without changing its source", async () => {
    const res = { id: "d1", sourceType: "dhcp_lease", owner: "dhcp-lease", expiresAt: new Date(1_700_000_000 * 1000) };
    const { done } = run([lease({ expireTime: 1_800_000_000 })], { activeResMap: new Map([["s1|10.0.0.5", res]]) });
    await done;
    expect(db.resUpdate.mock.calls[0][0].data).toEqual({
      sourceType: "dhcp_lease", expiresAt: new Date(1_800_000_000 * 1000), owner: "dhcp-lease",
    });
    expect(res.expiresAt).toEqual(new Date(1_800_000_000 * 1000));
  });

  it("writes nothing for a lease whose end moved by less than the jitter tolerance", async () => {
    const res = { id: "d1", sourceType: "dhcp_lease", owner: "dhcp-lease", expiresAt: new Date(1_800_000_000 * 1000 + 30_000) };
    const { state, done } = run([lease({ expireTime: 1_800_000_000 })], { activeResMap: new Map([["s1|10.0.0.5", res]]) });
    await done;
    expect(db.resUpdate).not.toHaveBeenCalled();
    expect(summary(state)).toContain("noChange=1");
  });

  it("defers steady-state presence bumps into one updateMany covering every row", async () => {
    const map = new Map<string, any>([
      ["s1|10.0.0.5", { id: "r5", sourceType: "dhcp_reservation", owner: "dhcp-reservation", expiresAt: null }],
      ["s1|10.0.0.6", { id: "r6", sourceType: "dhcp_reservation", owner: "dhcp-reservation", expiresAt: null }],
    ]);
    const { state, done } = run([reservation({ seenLeased: true }), reservation({ ipAddress: "10.0.0.6", seenLeased: true })], { activeResMap: map });
    await done;
    expect(db.resUpdate).not.toHaveBeenCalled();
    expect(db.resUpdateMany).toHaveBeenCalledTimes(1);
    const arg = db.resUpdateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: { in: ["r5", "r6"] } });
    expect(arg.data).toMatchObject({ staleNotifiedAt: null, staleSnoozedUntil: null });
    expect(arg.data.lastSeenLeased).toBeInstanceOf(Date);
    expect(summary(state)).toContain("updateMany=1 covering 2 rows");
    expect(summary(state)).toContain("dhcpFlipBumpOnly=2");
  });

  it("writes nothing for a reservation whose client is not online", async () => {
    const { state, done } = run([reservation()], { activeResMap: new Map([["s1|10.0.0.5", { id: "r5", sourceType: "dhcp_reservation", expiresAt: null }]]) });
    await done;
    expect(db.resUpdate).not.toHaveBeenCalled();
    expect(db.resUpdateMany).not.toHaveBeenCalled();
    expect(summary(state)).toContain("0 DB writes");
  });
});

describe("syncDhcpEntries — observed IPv6 rows (rule 125)", () => {
  it("supersedes an observed row in place with the DHCP binding's facts", async () => {
    const res = { id: "o1", sourceType: "observed", macAddress: null, expiresAt: new Date() };
    const { state, done } = run([lease({ expireTime: 1_800_000_000 })], { activeResMap: new Map([["s1|10.0.0.5", res]]) });
    await done;
    const data = db.resUpdate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      sourceType: "dhcp_lease", owner: "dhcp-lease", hostname: "laptop1", macAddress: "AA:BB:CC:DD:EE:01",
      expiresAt: new Date(1_800_000_000 * 1000),
    });
    expect(res.sourceType).toBe("dhcp_lease");
    expect(res.macAddress).toBe("AA:BB:CC:DD:EE:01");
    expect(db.resCreate).not.toHaveBeenCalled();
    expect(summary(state)).toContain("observedSuperseded=1");
  });

  it("clears the sighting expiry when the gate reserves the address, and leaves hostname / MAC alone when the entry has none", async () => {
    const { done } = run([reservation({ hostname: undefined, macAddress: undefined })], {
      activeResMap: new Map([["s1|10.0.0.5", { id: "o1", sourceType: "observed", macAddress: "11:11:11:11:11:11" }]]),
    });
    await done;
    const data = db.resUpdate.mock.calls[0][0].data;
    expect(data.expiresAt).toBeNull();
    expect(data).not.toHaveProperty("hostname");
    expect(data).not.toHaveProperty("macAddress");
  });
});

describe("syncDhcpEntries — managed switch / AP rows (rule 23)", () => {
  it("records the lease binding, fills a blank MAC and the display lease clock — never sourceType or expiresAt", async () => {
    const res: Record<string, any> = { id: "i1", sourceType: "fortiswitch", dhcpBinding: null, macAddress: null, leaseExpiresAt: null };
    const { state, done } = run([lease({ expireTime: 1_800_000_000, seenLeased: true })], { activeResMap: new Map([["s1|10.0.0.5", res]]) });
    await done;
    const data = db.resUpdate.mock.calls[0][0].data;
    expect(data).toMatchObject({ dhcpBinding: "lease", macAddress: "AA:BB:CC:DD:EE:01", leaseExpiresAt: new Date(1_800_000_000 * 1000), staleNotifiedAt: null });
    expect(data.lastSeenLeased).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty("sourceType");
    expect(data).not.toHaveProperty("expiresAt");
    expect(res).toMatchObject({ sourceType: "fortiswitch", dhcpBinding: "lease", macAddress: "AA:BB:CC:DD:EE:01" });
    expect(summary(state)).toContain("infraBinding=1");
  });

  it("records a real reservation on an AP row and clears a stale lease clock", async () => {
    const res: Record<string, any> = { id: "i2", sourceType: "fortinap", dhcpBinding: "lease", macAddress: "11:11:11:11:11:11", leaseExpiresAt: new Date(1_700_000_000_000) };
    const { done } = run([reservation()], { activeResMap: new Map([["s1|10.0.0.5", res]]) });
    await done;
    expect(db.resUpdate.mock.calls[0][0].data).toEqual({ dhcpBinding: "reservation", leaseExpiresAt: null });
    expect(res.leaseExpiresAt).toBeNull();
    expect(res.macAddress).toBe("11:11:11:11:11:11");
  });

  it("writes nothing when the binding is already recorded", async () => {
    const res = { id: "i3", sourceType: "fortinap", dhcpBinding: "reservation", macAddress: "AA:BB:CC:DD:EE:01", leaseExpiresAt: null };
    const { state, done } = run([reservation()], { activeResMap: new Map([["s1|10.0.0.5", res]]) });
    await done;
    expect(db.resUpdate).not.toHaveBeenCalled();
    expect(summary(state)).toContain("infraNoChange=1");
  });
});

describe("syncDhcpEntries — other rows and the summary", () => {
  it("leaves a row of any other source alone and never creates a second row at the address", async () => {
    const { done } = run([lease()], { activeResMap: new Map([["s1|10.0.0.5", { id: "x", sourceType: "interface_ip" }]]) });
    await done;
    expect(db.resUpdate).not.toHaveBeenCalled();
    expect(db.resCreate).not.toHaveBeenCalled();
  });

  it("sums the statements it issued into the summary line", async () => {
    const map = new Map<string, any>([
      ["s1|10.0.0.6", { id: "m2", sourceType: "manual", pushedToId: null }],
      ["s1|10.0.0.7", { id: "r7", sourceType: "dhcp_reservation", owner: "dhcp-reservation", expiresAt: null }],
    ]);
    const { state, done } = run([
      lease(),
      lease({ ipAddress: "10.0.0.6" }),
      reservation({ ipAddress: "10.0.0.7", seenLeased: true }),
      lease({ ipAddress: "" }),
    ], { activeResMap: map });
    await done;
    const line = summary(state);
    expect(line).toContain("Phase 5 DHCP entry processing: 4 entries, 4 DB writes");
    expect(line).toContain("creates=1");
    expect(line).toContain("dnsReleases=1");
    expect(line).toContain("upsertConflicts=1");
    expect(line).toContain("updateMany=1 covering 1 rows");
    expect(line).toContain("skipNoIp=1");
  });
});
