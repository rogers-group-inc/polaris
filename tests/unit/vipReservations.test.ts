/**
 * tests/unit/vipReservations.test.ts — the own suite for
 * src/services/discovery/dhcp/vipReservations.ts (syncDhcpSubnets Phase 3c, CQ-T010).
 *
 * Pins the VIP / Virtual Server reservation pass: one row per external, mapped
 * and realserver address that a known network holds (vipInfo stamped at create,
 * the DNS-resolved placeholder released first), the manual-row stamp-not-
 * conflict for the same VIP (rule 77) and the conflict for any other, the
 * `vip` row refresh that never touches operator fields, the DHCP-row path
 * (canonical placeholders overwritten, then a fill-only conflict), writes only
 * on change, and failure isolation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const m = vi.hoisted(() => ({ releaseDnsResolvedAt: vi.fn() }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/dnsResolvedReservationService.js", () => ({ releaseDnsResolvedAt: m.releaseDnsResolvedAt }));

const { syncVipReservations } = await import("../../src/services/discovery/dhcp/vipReservations.js");

const db = {
  create: stubbed(prisma.reservation.create),
  update: stubbed(prisma.reservation.update),
};

const LABEL = "FortiManager Integration";

beforeEach(() => {
  resetDbStub();
  m.releaseDnsResolvedAt.mockReset().mockResolvedValue(undefined);
  db.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `new-${String(data.ipAddress)}`, ...data }));
  db.update.mockResolvedValue({});
});

type Row = Record<string, any>;
const vip = (over: Row = {}) => ({
  device: "FGT-A", name: "web-dnat", extip: "10.1.0.10", mappedips: [] as string[], extintf: "wan1", isVirtualServer: false, realservers: [] as string[],
  ...over,
});
function run(vips: unknown[] | undefined, rows: Record<string, Row> = {}) {
  const state = {
    result: { vips } as never,
    activeResMap: new Map<string, any>(Object.entries(rows)),
    findSubnetForIp: (ip: string) => (ip.startsWith("10.1.") ? { id: "net1" } : ip.startsWith("2001:db8:") ? { id: "net6" } : undefined),
    reservationKey: (s: string, ip: string) => `${s}|${ip}`,
    upsertConflict: vi.fn(async (..._a: any[]) => undefined),
    projectRefLabel: LABEL,
    vipNames: [] as string[],
    integrationId: "i1",
    syncLog: vi.fn(),
  };
  return { state, done: syncVipReservations(state as never) };
}
const info = (over: Row = {}) => ({ name: "web-dnat", device: "FGT-A", extip: "10.1.0.10", role: "external", isVirtualServer: false, ...over });

describe("syncVipReservations — nothing to do", () => {
  it("an absent or empty VIP list writes and logs nothing", async () => {
    for (const vips of [undefined, []]) {
      const { state, done } = run(vips);
      await done;
      expect(state.syncLog).not.toHaveBeenCalled();
    }
    expect(db.create).not.toHaveBeenCalled();
  });

  it("an address in no known network is skipped", async () => {
    const { state, done } = run([vip({ extip: "203.0.113.5" })]);
    await done;
    expect(db.create).not.toHaveBeenCalled();
    expect(m.releaseDnsResolvedAt).not.toHaveBeenCalled();
    expect(state.syncLog).not.toHaveBeenCalled();
  });
});

describe("syncVipReservations — create", () => {
  it("reserves the external, each mapped and each realserver address, releasing a DNS-resolved placeholder first", async () => {
    const { state, done } = run([vip({ mappedips: ["10.1.0.20"], realservers: ["2001:db8::31"], isVirtualServer: true, name: "vs-web" })]);
    await done;
    expect(db.create.mock.calls.map((c) => [c[0].data.ipAddress, c[0].data.vipInfo.role])).toEqual([
      ["10.1.0.10", "external"], ["10.1.0.20", "mapped"], ["2001:db8::31", "realserver"],
    ]);
    expect(db.create.mock.calls[2][0].data).toEqual({
      subnetId: "net6", ipAddress: "2001:db8::31", hostname: "vs-web", owner: "vs-web", projectRef: "VS: FGT-A",
      notes: 'Virtual server "vs-web" (realserver) on FGT-A — ext: 10.1.0.10',
      status: "active", sourceType: "vip",
      vipInfo: { name: "vs-web", device: "FGT-A", extip: "10.1.0.10", role: "realserver", isVirtualServer: true },
    });
    expect(m.releaseDnsResolvedAt).toHaveBeenNthCalledWith(1, "net1", "10.1.0.10");
    expect(m.releaseDnsResolvedAt.mock.invocationCallOrder[0]).toBeLessThan(db.create.mock.invocationCallOrder[0]);
    expect(state.activeResMap.get("net6|2001:db8::31")).toMatchObject({ id: "new-2001:db8::31" });
    expect(state.vipNames).toEqual(["10.1.0.10 (vs-web/external)", "10.1.0.20 (vs-web/mapped)", "2001:db8::31 (vs-web/realserver)"]);
    expect(state.syncLog).toHaveBeenCalledWith("info", "VIP sync: created 3 VIP reservation(s)");
  });

  it("a plain DNAT VIP is labelled 'Firewall VIP' with a VIP projectRef", async () => {
    await run([vip()]).done;
    expect(db.create.mock.calls[0][0].data).toMatchObject({
      projectRef: "VIP: FGT-A", notes: 'Firewall VIP "web-dnat" (external) on FGT-A — ext: 10.1.0.10',
    });
  });

  it("a failed placeholder release or create is logged for that address and the next still lands", async () => {
    m.releaseDnsResolvedAt.mockRejectedValueOnce(new Error("dns"));
    db.create.mockImplementationOnce(async () => { throw new Error("unique"); });
    const { state, done } = run([vip({ mappedips: ["10.1.0.20", "10.1.0.21"] })]);
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to create VIP reservation for 10.1.0.10 (web-dnat): dns");
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to create VIP reservation for 10.1.0.20 (web-dnat): unique");
    expect(state.vipNames).toEqual(["10.1.0.21 (web-dnat/mapped)"]);
    expect(state.syncLog).toHaveBeenCalledWith("info", "VIP sync: created 1 VIP reservation(s)");
  });
});

describe("syncVipReservations — a manual row at the address (rule 77)", () => {
  it("a claim already naming this VIP is restamped only when a fact changed — never a conflict", async () => {
    const claimed: Row = { id: "man", sourceType: "manual", vipInfo: info({ role: "mapped" }) };
    const { state, done } = run([vip()], { "net1|10.1.0.10": claimed });
    await done;
    expect(db.update).toHaveBeenCalledWith({ where: { id: "man" }, data: { vipInfo: info() } });
    expect(claimed.vipInfo).toEqual(info());
    expect(state.upsertConflict).not.toHaveBeenCalled();
    expect(db.create).not.toHaveBeenCalled();
    expect(state.syncLog).not.toHaveBeenCalled();
  });

  it("an unchanged claim writes nothing (a missing isVirtualServer reads as false)", async () => {
    const { isVirtualServer: _drop, ...noFlag } = info();
    const { state, done } = run([vip()], { "net1|10.1.0.10": { id: "man", sourceType: "manual", vipInfo: noFlag } });
    await done;
    expect(db.update).not.toHaveBeenCalled();
    expect(state.upsertConflict).not.toHaveBeenCalled();
  });

  it("an extip change on the same VIP restamps the claim", async () => {
    const { done } = run([vip({ extip: "10.1.0.11", mappedips: ["10.1.0.20"] })], {
      "net1|10.1.0.20": { id: "man", sourceType: "manual", vipInfo: info({ role: "mapped" }) },
    });
    await done;
    expect(db.update).toHaveBeenCalledWith({ where: { id: "man" }, data: { vipInfo: info({ extip: "10.1.0.11", role: "mapped" }) } });
  });

  it("a claim for a different VIP, another gate's VIP of that name, or none at all is a collision → conflict", async () => {
    for (const vipInfo of [info({ name: "other" }), info({ device: "FGT-B" }), null]) {
      const row = { id: "man", sourceType: "manual", vipInfo };
      const { state, done } = run([vip()], { "net1|10.1.0.10": row });
      await done;
      expect(state.upsertConflict).toHaveBeenCalledWith("man", "i1", {
        hostname: "web-dnat", owner: "web-dnat", projectRef: "VIP: FGT-A",
        notes: 'Firewall VIP "web-dnat" (external) on FGT-A — ext: 10.1.0.10', sourceType: "vip",
      }, row);
    }
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("syncVipReservations — an existing vip row", () => {
  it("a rename refreshes vipInfo only; the operator-editable fields are left alone", async () => {
    const row: Row = { id: "v1", sourceType: "vip", hostname: "my label", owner: "me", vipInfo: info({ name: "old-name" }) };
    const { state, done } = run([vip()], { "net1|10.1.0.10": row });
    await done;
    expect(db.update).toHaveBeenCalledWith({ where: { id: "v1" }, data: { vipInfo: info() } });
    expect(row).toMatchObject({ hostname: "my label", owner: "me", vipInfo: info() });
    expect(state.vipNames).toEqual([]);
  });

  it("a first snapshot is written; an identical one is not", async () => {
    await run([vip()], { "net1|10.1.0.10": { id: "v1", sourceType: "vip", vipInfo: null } }).done;
    expect(db.update).toHaveBeenCalledTimes(1);
    db.update.mockClear();
    await run([vip()], { "net1|10.1.0.10": { id: "v1", sourceType: "vip", vipInfo: info() } }).done;
    expect(db.update).not.toHaveBeenCalled();
  });

  // BUG: the `vip` branch's change test compares name / device / role /
  // isVirtualServer but not `extip`. When a VIP's external address changes
  // while its mapped address stays (10.1.0.10 → 10.1.0.11, mapped 10.1.0.20),
  // the mapped row keeps vipInfo.extip = "10.1.0.10" forever — and
  // assetVipService reads that extip as "the EXTERNAL address the device
  // answers on" for the asset's General tab. The manual branch above does
  // compare extip. Right: the row is restamped with extip "10.1.0.11".
  it.fails("an extip change on the same VIP restamps a vip row's snapshot", async () => {
    const row: Row = { id: "v1", sourceType: "vip", vipInfo: info({ role: "mapped" }) };
    await run([vip({ extip: "10.1.0.11", mappedips: ["10.1.0.20"] })], { "net1|10.1.0.20": row }).done;
    expect(db.update).toHaveBeenCalledWith({ where: { id: "v1" }, data: { vipInfo: info({ extip: "10.1.0.11", role: "mapped" }) } });
  });
});

describe("syncVipReservations — a DHCP row at a VIP address", () => {
  it("takes the VIP's metadata over the canonical DHCP placeholders, then raises a fill-only conflict", async () => {
    const row: Row = { id: "d1", sourceType: "dhcp_reservation", owner: "dhcp-reservation", projectRef: LABEL, vipInfo: null };
    const { state, done } = run([vip()], { "net1|10.1.0.10": row });
    await done;
    expect(db.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { vipInfo: info(), owner: "web-dnat", projectRef: "VIP: FGT-A" } });
    expect(row).toMatchObject({ vipInfo: info(), owner: "web-dnat", projectRef: "VIP: FGT-A" });
    expect(state.upsertConflict).toHaveBeenCalledWith("d1", "i1", expect.objectContaining({ sourceType: "vip", owner: "web-dnat" }), row, "fill-only");
  });

  it("an operator's owner and projectRef survive; an unchanged snapshot writes nothing, but the fill-only conflict still runs", async () => {
    const row: Row = { id: "d1", sourceType: "dhcp_lease", owner: "alice", projectRef: "PRJ-9", vipInfo: info() };
    const { state, done } = run([vip()], { "net1|10.1.0.10": row });
    await done;
    expect(db.update).not.toHaveBeenCalled();
    expect(row.owner).toBe("alice");
    expect(state.upsertConflict).toHaveBeenCalledWith("d1", "i1", expect.anything(), row, "fill-only");
  });

  // BUG: same omission as the vip branch — the DHCP-row change test ignores
  // `extip`, so a DHCP row whose VIP moved to a new external address keeps the
  // stale vipInfo.extip. Right: the snapshot is rewritten with the new extip.
  it.fails("an extip change on the same VIP restamps a DHCP row's snapshot", async () => {
    const row: Row = { id: "d1", sourceType: "dhcp_lease", owner: "alice", projectRef: "PRJ-9", vipInfo: info({ role: "mapped" }) };
    await run([vip({ extip: "10.1.0.11", mappedips: ["10.1.0.20"] })], { "net1|10.1.0.20": row }).done;
    expect(db.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { vipInfo: info({ extip: "10.1.0.11", role: "mapped" }) } });
  });

  it("any other source type at the address (interface IP, infra) is left alone", async () => {
    const { state, done } = run([vip()], { "net1|10.1.0.10": { id: "x", sourceType: "interface_ip", vipInfo: null } });
    await done;
    expect(db.update).not.toHaveBeenCalled();
    expect(db.create).not.toHaveBeenCalled();
    expect(state.upsertConflict).not.toHaveBeenCalled();
  });
});
