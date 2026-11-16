/**
 * tests/unit/addressConfidenceService.test.ts — the own suite for
 * src/services/addressConfidenceService.ts (business rule 103, CQ-T010).
 *
 * Complements addressConfidence.test.ts (the pure scoring in
 * utils/addressConfidence.ts) and tests/integration/addressConfidence.test.ts.
 *
 * Adds, on the shared db stub with the REAL scorer: which addresses get a score
 * (rows, primary, extra candidates), each evidence source as it is gathered
 * (row kinds, a manual row, reservations whose MAC is the asset's, every
 * SOURCE_ADDRESS_KINDS kind, ARP by MAC, the agent's source address, polling,
 * the operator), the three penalties (alive-elsewhere, claimed-elsewhere,
 * arp-elsewhere) and the detected-ambiguous re-kind, the query count staying
 * fixed for N assets, the address-check endpoint's 400 / 404 / warn / probe,
 * the polling-run seed being one statement, and confidenceToJson.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ ping: vi.fn() }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/utils/icmpPing.js", () => ({ pingHost: h.ping }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { AppError } from "../../src/utils/errors.js";
import { EVIDENCE_KINDS, CONFIDENCE_WARN_BELOW } from "../../src/utils/addressConfidence.js";
import {
  buildAddressConfidence,
  checkAddressConfidence,
  seedPollingRuns,
  confidenceToJson,
} from "../../src/services/addressConfidenceService.js";

const db = prisma as any;
const NOW = new Date("2026-11-10T12:00:00Z");
const H = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MAC = "AA:BB:CC:00:00:01";

type Row = { ip: string; mac: string | null; source: string; device: string | null; lastSeen: Date };

function assetRow(over: Record<string, unknown> = {}) {
  return {
    id: "a1", ipAddress: "10.0.0.5", ipOverride: null, primaryAddressIp: null, monitored: true, monitorStatus: "up",
    ipConfirmedFor: null, ipConfirmedSince: null, macAddress: null,
    associatedIpRows: [] as Row[], macAddressRows: [] as Array<{ mac: string }>,
    ...over,
  };
}

let assets: any[] = [];
let others: any[] = [];

beforeEach(() => {
  resetDbStub();
  h.ping.mockReset();
  assets = [];
  others = [];
  stubbed(db.asset.findMany).mockImplementation(async (q: any) => (q.where.id?.in ? assets : others));
  for (const m of ["reservation", "assetSource", "assetArpEntry", "managedAgent"]) stubbed(db[m].findMany).mockResolvedValue([]);
});

const kinds = (r: any) => r.parts.map((p: any) => p.kind);

describe("buildAddressConfidence — what gets scored", () => {
  it("returns an empty map, with no query, for no assets", async () => {
    expect((await buildAddressConfidence([])).size).toBe(0);
    expect(db.asset.findMany).not.toHaveBeenCalled();
  });

  it("returns an empty map when no asset has any address", async () => {
    assets = [assetRow({ ipAddress: null })];
    expect((await buildAddressConfidence(["a1"], { now: NOW })).size).toBe(0);
    expect(db.reservation.findMany).not.toHaveBeenCalled();
  });

  it("scores every listed address, the primary (even unbacked) and extra candidates", async () => {
    assets = [assetRow({ associatedIpRows: [{ ip: "10.0.0.6", mac: MAC, source: "monitor-system-info", device: null, lastSeen: NOW }] })];
    const out = await buildAddressConfidence(["a1"], { now: NOW, extraIps: new Map([["a1", ["10.0.0.7"]]]) });
    const per = out.get("a1")!;
    expect([...per.keys()].sort()).toEqual(["10.0.0.5", "10.0.0.6", "10.0.0.7"]);
    expect(per.get("10.0.0.5")!.score).toBe(0);
    expect(per.get("10.0.0.7")!.score).toBe(0);
    expect(per.get("10.0.0.6")!.score).toBe(95);
  });

  it("stays a fixed handful of queries for many assets", async () => {
    assets = Array.from({ length: 30 }, (_, i) => assetRow({
      id: `a${i}`, ipAddress: `10.0.1.${i}`, macAddress: `AA:BB:CC:00:01:${(i + 16).toString(16)}`,
    }));
    await buildAddressConfidence(assets.map((a) => a.id), { now: NOW });
    expect(db.asset.findMany).toHaveBeenCalledTimes(2);
    for (const m of ["reservation", "assetSource", "assetArpEntry", "managedAgent"]) expect(db[m].findMany).toHaveBeenCalledTimes(1);
  });

  it("skips the ARP read when the assets have no MAC at all", async () => {
    assets = [assetRow()];
    await buildAddressConfidence(["a1"], { now: NOW });
    expect(db.assetArpEntry.findMany).not.toHaveBeenCalled();
  });

  it("reads ARP for every MAC the asset is known by, normalised, within 24 h", async () => {
    assets = [assetRow({
      macAddress: "aa-bb-cc-00-00-01", macAddressRows: [{ mac: "aa:bb:cc:00:00:02" }],
      associatedIpRows: [{ ip: "10.0.0.5", mac: "aabb.cc00.0003", source: "arp", device: null, lastSeen: NOW }],
    })];
    await buildAddressConfidence(["a1"], { now: NOW });
    const where = stubbed(db.assetArpEntry.findMany).mock.calls[0][0].where;
    expect(where.macAddress.in.sort()).toEqual(["AA:BB:CC:00:00:01", "AA:BB:CC:00:00:02", "AA:BB:CC:00:00:03"]);
    expect(where.lastSeen).toEqual({ gte: ago(24 * H) });
  });

  it("asks only for active dhcp_reservation rows, non-inferred sources and non-revoked agents", async () => {
    assets = [assetRow()];
    await buildAddressConfidence(["a1"], { now: NOW });
    expect(stubbed(db.reservation.findMany).mock.calls[0][0].where).toEqual({ ipAddress: { in: ["10.0.0.5"] }, status: "active", sourceType: "dhcp_reservation" });
    expect(stubbed(db.assetSource.findMany).mock.calls[0][0].where.inferred).toBe(false);
    expect(stubbed(db.managedAgent.findMany).mock.calls[0][0].where).toMatchObject({ assetId: { in: ["a1"] }, bearerRevokedAt: null });
    const claimQ = stubbed(db.asset.findMany).mock.calls[1][0].where;
    expect(claimQ.id).toEqual({ notIn: ["a1"] });
    expect(claimQ.ipAddress).toEqual({ in: ["10.0.0.5"] });
  });
});

describe("buildAddressConfidence — evidence", () => {
  it.each([
    ["monitor-system-info", "interface"],
    ["agent-interface", "agent-interface"],
    ["device-inventory", "detected-online"],
    ["dhcp-reservation", "reservation-held"],
    ["dhcp-lease", "lease-held"],
    ["arp", "arp"],
    ["something-old", "recorded"],
  ])("an address row from %s counts as %s", async (source, kind) => {
    assets = [assetRow({ associatedIpRows: [{ ip: "10.0.0.5", mac: null, source, device: "FW-A", lastSeen: NOW }] })];
    const r = (await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!;
    expect(kinds(r)).toEqual([kind]);
    expect(r.parts[0].device).toBe("FW-A");
  });

  it("a manual row is the operator's choice: in score, not in evidenceScore", async () => {
    assets = [assetRow({ associatedIpRows: [{ ip: "10.0.0.5", mac: null, source: "manual", device: null, lastSeen: NOW }] })];
    const r = (await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!;
    expect(kinds(r)).toEqual(["operator"]);
    expect(r.score).toBe(80);
    expect(r.evidenceScore).toBe(0);
  });

  it("the pinned primary and a typed override each count as operator", async () => {
    assets = [assetRow({ primaryAddressIp: "10.0.0.5", ipOverride: "10.0.0.6" })];
    const per = (await buildAddressConfidence(["a1"], { now: NOW, extraIps: new Map([["a1", ["10.0.0.6"]]]) })).get("a1")!;
    expect(kinds(per.get("10.0.0.5"))).toEqual(["operator"]);
    expect(kinds(per.get("10.0.0.6"))).toEqual(["operator"]);
  });

  it("a reservation counts only when its MAC is one of the asset's: configured always, held from lastSeenLeased", async () => {
    assets = [assetRow({ macAddress: MAC })];
    stubbed(db.reservation.findMany).mockResolvedValue([
      { ipAddress: "10.0.0.5", macAddress: "aa:bb:cc:00:00:01", lastSeenLeased: ago(H), subnet: { fortigateDevice: "FW-A" } },
      { ipAddress: "10.0.0.5", macAddress: "11:22:33:44:55:66", lastSeenLeased: NOW, subnet: { fortigateDevice: "FW-B" } },
    ]);
    const r = (await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!;
    expect(kinds(r).sort()).toEqual(["reservation-configured", "reservation-held"]);
    expect(r.parts.every((p: any) => p.device === "FW-A")).toBe(true);
  });

  it("a reservation never leased counts as configured only", async () => {
    assets = [assetRow({ macAddress: MAC })];
    stubbed(db.reservation.findMany).mockResolvedValue([{ ipAddress: "10.0.0.5", macAddress: MAC, lastSeenLeased: null, subnet: null }]);
    const r = (await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!;
    expect(kinds(r)).toEqual(["reservation-configured"]);
    expect(r.parts[0].device).toBeNull();
  });

  it.each([
    ["fortigate-firewall", { mgmtIp: "10.0.0.5" }, "controller"],
    ["fortiswitch", { mgmtIp: "10.0.0.5" }, "controller"],
    ["fortiap", { mgmtIp: "10.0.0.5" }, "controller"],
    ["vcenter-vm", { guestIp: "10.0.0.5" }, "vcenter"],
    ["vcenter-host", { resolvedIp: "10.0.0.5" }, "vcenter"],
    ["unraid-host", { ip: "10.0.0.5" }, "hypervisor"],
    ["truenas-app", { ip: "10.0.0.5" }, "hypervisor"],
    ["proxmox-lxc", { ip: "10.0.0.5" }, "hypervisor"],
    ["proxmox-qemu", { ip: "10.0.0.5" }, "hypervisor"],
    ["arc", { ipAddresses: ["10.9.9.9", "10.0.0.5"] }, "arc"],
    ["fortigate-endpoint", { ipAddress: "10.0.0.5" }, "endpoint-sighting"],
    ["generic-api", { ip: "10.0.0.5" }, "generic-api"],
  ])("an AssetSource %s carrying the address counts as %s", async (sourceKind, observed, kind) => {
    assets = [assetRow()];
    stubbed(db.assetSource.findMany).mockResolvedValue([{ assetId: "a1", sourceKind, observed, lastSeen: NOW }]);
    const r = (await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!;
    expect(kinds(r)).toEqual([kind]);
  });

  it("a source naming a different address, a null blob or a non-array arc list adds nothing", async () => {
    assets = [assetRow()];
    stubbed(db.assetSource.findMany).mockResolvedValue([
      { assetId: "a1", sourceKind: "vcenter-vm", observed: { guestIp: "10.0.0.99" }, lastSeen: NOW },
      { assetId: "a1", sourceKind: "generic-api", observed: null, lastSeen: NOW },
      { assetId: "a1", sourceKind: "arc", observed: { ipAddresses: "10.0.0.5" }, lastSeen: NOW },
    ]);
    expect((await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!.parts).toEqual([]);
  });

  it("queries every address-carrying source kind", async () => {
    assets = [assetRow()];
    await buildAddressConfidence(["a1"], { now: NOW });
    const asked = stubbed(db.assetSource.findMany).mock.calls[0][0].where.sourceKind.in;
    for (const k of ["fortigate-firewall", "fortiswitch", "fortiap", "vcenter-vm", "vcenter-host", "unraid-host", "truenas-host",
      "proxmox-node", "unraid-vm", "truenas-vm", "proxmox-qemu", "unraid-container", "truenas-app", "proxmox-lxc", "arc",
      "fortigate-endpoint", "generic-api"]) expect(asked).toContain(k);
  });

  it("an ARP entry binding one of the asset's MACs to the address is an arp piece naming the gate", async () => {
    assets = [assetRow({ macAddressRows: [{ mac: MAC }] })];
    stubbed(db.assetArpEntry.findMany).mockResolvedValue([
      { ipAddress: "10.0.0.5", macAddress: "aa:bb:cc:00:00:01", lastSeen: NOW, asset: { hostname: "FW-A" } },
    ]);
    const r = (await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!;
    expect(r.parts).toEqual([expect.objectContaining({ kind: "arp", device: "FW-A" })]);
  });

  it("counts the agent's source address only when it is that private address (rule 103(e))", async () => {
    assets = [assetRow()];
    stubbed(db.managedAgent.findMany).mockResolvedValue([{ assetId: "a1", lastSeenIp: "::ffff:10.0.0.5", lastSeenAt: NOW }]);
    let r = (await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!;
    expect(kinds(r)).toEqual(["agent-source"]);

    assets = [assetRow({ ipAddress: "203.0.113.5" })];
    stubbed(db.managedAgent.findMany).mockResolvedValue([{ assetId: "a1", lastSeenIp: "203.0.113.5", lastSeenAt: NOW }]);
    r = (await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("203.0.113.5")!;
    expect(kinds(r)).toEqual([]);
  });

  it("an agent whose own interface report lacks its source address earns no agent-source piece", async () => {
    assets = [assetRow({ associatedIpRows: [{ ip: "10.0.0.6", mac: null, source: "agent-interface", device: null, lastSeen: NOW }] })];
    stubbed(db.managedAgent.findMany).mockResolvedValue([{ assetId: "a1", lastSeenIp: "10.0.0.5", lastSeenAt: NOW }]);
    const r = (await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!;
    expect(kinds(r)).toEqual([]);
  });

  it("credits polling to the run's address while up, and sustains its other evidence", async () => {
    assets = [assetRow({
      ipConfirmedFor: "10.0.0.5", ipConfirmedSince: ago(48 * H),
      associatedIpRows: [{ ip: "10.0.0.5", mac: null, source: "device-inventory", device: null, lastSeen: ago(60 * H) }],
    })];
    const r = (await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!;
    expect(kinds(r)).toContain("polling");
    expect(r.sustained).toBe(true);
    expect(r.parts.find((p: any) => p.kind === "detected-online")?.value).toBe(EVIDENCE_KINDS["detected-online"].weight);
  });

  it("gives no polling credit while the asset is down", async () => {
    assets = [assetRow({ monitorStatus: "down", ipConfirmedFor: "10.0.0.5", ipConfirmedSince: ago(48 * H) })];
    const r = (await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!;
    expect(kinds(r)).not.toContain("polling");
  });

  // Was a bug until 2026-11-14: the contract (rule 103 / the touches entry) gives polling credit "only
  // while the run's ipConfirmedFor equals the current ipAddress". The service
  // never compares against ipAddress: an asset whose primary moved from
  // 10.0.0.5 to 10.0.0.6 while the run still names 10.0.0.5 (always so for an
  // agent-driven monitor — pollingRunStart never restarts an agent-driven run)
  // keeps crediting 10.0.0.5 with 48 h of polling (+ sustained) and the actual
  // primary none. Right: the old address earns no polling piece.
  it("gives no polling credit to an address that is no longer the primary", async () => {
    assets = [assetRow({ ipAddress: "10.0.0.6", ipConfirmedFor: "10.0.0.5", ipConfirmedSince: ago(48 * H) })];
    const per = (await buildAddressConfidence(["a1"], { now: NOW, extraIps: new Map([["a1", ["10.0.0.5"]]]) })).get("a1")!;
    expect(kinds(per.get("10.0.0.5"))).not.toContain("polling");
  });
});

describe("buildAddressConfidence — penalties", () => {
  it("alive-elsewhere: the primary is down while a gate sees the asset online elsewhere within 1 h", async () => {
    assets = [assetRow({
      monitorStatus: "down",
      associatedIpRows: [
        { ip: "10.0.0.5", mac: null, source: "monitor-system-info", device: null, lastSeen: NOW },
        { ip: "10.0.0.6", mac: null, source: "device-inventory", device: "FW-A", lastSeen: ago(30 * 60_000) },
      ],
    })];
    const per = (await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!;
    const p = per.get("10.0.0.5")!.penalties;
    expect(p).toEqual([expect.objectContaining({ kind: "alive-elsewhere", factor: 0.3 })]);
    expect(p[0].detail).toContain("FW-A sees it online at 10.0.0.6");
    expect(per.get("10.0.0.6")!.penalties).toEqual([]);
  });

  it("no alive-elsewhere when the sighting is older than an hour, the asset is up, or unmonitored", async () => {
    const rows = (seen: Date) => [
      { ip: "10.0.0.5", mac: null, source: "monitor-system-info", device: null, lastSeen: NOW },
      { ip: "10.0.0.6", mac: null, source: "device-inventory", device: "FW-A", lastSeen: seen },
    ];
    for (const a of [
      assetRow({ monitorStatus: "down", associatedIpRows: rows(ago(2 * H)) }),
      assetRow({ monitorStatus: "up", associatedIpRows: rows(NOW) }),
      assetRow({ monitored: false, monitorStatus: "down", associatedIpRows: rows(NOW) }),
    ]) {
      assets = [a];
      expect((await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!.penalties).toEqual([]);
    }
  });

  it("claimed-elsewhere: another asset holds the address and was seen after this one's best evidence", async () => {
    assets = [assetRow({ associatedIpRows: [{ ip: "10.0.0.5", mac: null, source: "device-inventory", device: null, lastSeen: ago(3 * H) }] })];
    others = [{ id: "b1", hostname: "other-pc", ipAddress: "10.0.0.5", lastSeen: ago(H) }];
    const r = (await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!;
    expect(r.penalties).toEqual([expect.objectContaining({ kind: "claimed-elsewhere", factor: 0.5 })]);
    expect(r.penalties[0].detail).toContain("other-pc");
  });

  it("no claimed-elsewhere when the other asset was seen earlier, or never", async () => {
    assets = [assetRow({ associatedIpRows: [{ ip: "10.0.0.5", mac: null, source: "device-inventory", device: null, lastSeen: ago(H) }] })];
    others = [
      { id: "b1", hostname: "x", ipAddress: "10.0.0.5", lastSeen: ago(3 * H) },
      { id: "b2", hostname: "y", ipAddress: "10.0.0.5", lastSeen: null },
    ];
    expect((await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!.penalties).toEqual([]);
  });

  it("arp-elsewhere: a detected address whose MAC a gate binds to another address within 4 h", async () => {
    assets = [assetRow({ associatedIpRows: [{ ip: "10.0.0.5", mac: MAC, source: "device-inventory", device: null, lastSeen: NOW }] })];
    stubbed(db.assetArpEntry.findMany).mockResolvedValue([
      { ipAddress: "10.0.0.9", macAddress: MAC, lastSeen: ago(H), asset: { hostname: "FW-A" } },
    ]);
    const r = (await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!;
    expect(r.penalties).toEqual([expect.objectContaining({ kind: "arp-elsewhere", factor: 0.5 })]);
    expect(r.penalties[0].detail).toContain("FW-A's ARP table has this MAC at 10.0.0.9");
  });

  it("no arp-elsewhere when ARP also resolves the address itself, when the binding is older than 4 h, or the address is not detected", async () => {
    const detectedRow = { ip: "10.0.0.5", mac: MAC, source: "device-inventory", device: null, lastSeen: NOW };
    assets = [assetRow({ associatedIpRows: [detectedRow] })];
    stubbed(db.assetArpEntry.findMany).mockResolvedValue([{ ipAddress: "10.0.0.9", macAddress: MAC, lastSeen: ago(5 * H), asset: { hostname: "FW-A" } }]);
    expect((await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!.penalties).toEqual([]);

    assets = [assetRow({ associatedIpRows: [{ ...detectedRow, source: "monitor-system-info" }] })];
    stubbed(db.assetArpEntry.findMany).mockResolvedValue([{ ipAddress: "10.0.0.9", macAddress: MAC, lastSeen: NOW, asset: { hostname: "FW-A" } }]);
    expect((await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!.penalties).toEqual([]);
  });

  it("re-kinds detection as detected-ambiguous when ARP shows the card at several addresses", async () => {
    assets = [assetRow({ associatedIpRows: [{ ip: "10.0.0.5", mac: MAC, source: "device-inventory", device: null, lastSeen: NOW }] })];
    stubbed(db.assetArpEntry.findMany).mockResolvedValue([
      { ipAddress: "10.0.0.5", macAddress: MAC, lastSeen: NOW, asset: { hostname: "FW-A" } },
      { ipAddress: "10.0.0.9", macAddress: MAC, lastSeen: NOW, asset: { hostname: "FW-A" } },
    ]);
    const r = (await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!;
    expect(kinds(r).sort()).toEqual(["arp", "detected-ambiguous"]);
    expect(r.penalties).toEqual([]);
  });

  it("keeps detected-online when ARP shows the card at only this address", async () => {
    assets = [assetRow({ associatedIpRows: [{ ip: "10.0.0.5", mac: MAC, source: "device-inventory", device: null, lastSeen: NOW }] })];
    stubbed(db.assetArpEntry.findMany).mockResolvedValue([{ ipAddress: "10.0.0.5", macAddress: MAC, lastSeen: NOW, asset: { hostname: "FW-A" } }]);
    expect(kinds((await buildAddressConfidence(["a1"], { now: NOW })).get("a1")!.get("10.0.0.5")!).sort()).toEqual(["arp", "detected-online"]);
  });
});

describe("checkAddressConfidence", () => {
  it("400s an invalid address before any read", async () => {
    await expect(checkAddressConfidence("a1", "10.0.0.300")).rejects.toMatchObject({ httpStatus: 400 });
    expect(db.asset.findUnique).not.toHaveBeenCalled();
  });

  it("404s an unknown asset", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue(null);
    const err = await checkAddressConfidence("x", "10.0.0.5").catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(404);
  });

  it("scores a never-seen candidate 0 and warns, without probing unless asked", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue({ id: "a1" });
    assets = [assetRow()];
    const out = await checkAddressConfidence("a1", " 10.0.0.77 ", { now: NOW });
    expect(out).toMatchObject({
      ip: "10.0.0.77", evidenceScore: 0, evidenceBand: "very-low", score: 0, warn: true, warnBelow: CONFIDENCE_WARN_BELOW, probe: null,
    });
    expect(h.ping).not.toHaveBeenCalled();
  });

  it("judges on evidenceScore: an operator's own pin cannot vouch for itself", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue({ id: "a1" });
    assets = [assetRow({ primaryAddressIp: "10.0.0.5" })];
    const out = await checkAddressConfidence("a1", "10.0.0.5", { now: NOW });
    expect(out.score).toBe(80);
    expect(out.evidenceScore).toBe(0);
    expect(out.warn).toBe(true);
  });

  it("does not warn at or above the line", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue({ id: "a1" });
    assets = [assetRow({ associatedIpRows: [{ ip: "10.0.0.5", mac: null, source: "monitor-system-info", device: null, lastSeen: NOW }] })];
    const out = await checkAddressConfidence("a1", "10.0.0.5", { now: NOW });
    expect(out.evidenceScore).toBe(95);
    expect(out.warn).toBe(false);
    expect(out.evidenceBand).toBe("high");
  });

  it("reports a probe answer or its error beside the score, with a 2 s timeout", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue({ id: "a1" });
    assets = [assetRow()];
    h.ping.mockResolvedValue({ success: true });
    expect((await checkAddressConfidence("a1", "10.0.0.5", { probe: true, now: NOW })).probe).toEqual({ answered: true, error: null });
    expect(h.ping).toHaveBeenCalledWith("10.0.0.5", 2000);
    h.ping.mockResolvedValue({ success: false, error: "timeout" });
    expect((await checkAddressConfidence("a1", "10.0.0.5", { probe: true, now: NOW })).probe).toEqual({ answered: false, error: "timeout" });
    h.ping.mockResolvedValue({ success: false });
    expect((await checkAddressConfidence("a1", "10.0.0.5", { probe: true, now: NOW })).probe).toEqual({ answered: false, error: null });
  });

  it("accepts an IPv6 candidate", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue({ id: "a1" });
    assets = [assetRow()];
    expect((await checkAddressConfidence("a1", "2001:db8::5", { now: NOW })).ip).toBe("2001:db8::5");
  });
});

describe("seedPollingRuns", () => {
  it("is one raw statement that fills only empty runs for monitored, not-down assets", async () => {
    stubbed(db.$executeRawUnsafe).mockResolvedValue(4);
    expect(await seedPollingRuns()).toBe(4);
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const sql = String(stubbed(db.$executeRawUnsafe).mock.calls[0][0]);
    expect(sql).toContain(`"ipConfirmedSince" IS NULL`);
    expect(sql).toContain("a.monitored = true");
    expect(sql).toContain(`IS DISTINCT FROM 'down'`);
    expect(sql).toContain("interval '30 days'");
    expect(sql).toContain("s.success = true");
    expect(sql).toContain("GREATEST(");
  });
});

describe("confidenceToJson", () => {
  it("turns a per-IP map into a plain object, and undefined into {}", () => {
    const r = { score: 1 } as any;
    expect(confidenceToJson(new Map([["10.0.0.5", r]]))).toEqual({ "10.0.0.5": r });
    expect(confidenceToJson(undefined)).toEqual({});
  });
});
