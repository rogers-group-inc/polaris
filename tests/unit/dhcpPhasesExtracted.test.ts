/**
 * tests/unit/dhcpPhasesExtracted.test.ts — syncDhcpSubnets phases 7b, 7.5b,
 * 7.6, 8 and 9, now modules under src/services/discovery/dhcp/ (CQ-B060).
 *
 * Inside the 5,700-line function these could only be reached through a whole
 * discovery run; out of it, each is pinned on its own contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  reservationFindMany: stubbed(prisma.reservation.findMany),
  reservationUpdateMany: stubbed(prisma.reservation.updateMany),
  assetUpdate: stubbed(prisma.asset.update),
  assetUpdateMany: stubbed(prisma.asset.updateMany),
};

const m = vi.hoisted(() => ({
  reverse: vi.fn(),
  lookupOui: vi.fn(),
  lookupOuiOverride: vi.fn(),
  reconcileMacAddresses: vi.fn(),
  persistFortigateArpTables: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/dnsService.js", () => ({ getConfiguredResolver: async () => ({ reverse: m.reverse }) }));
vi.mock("../../src/services/ouiService.js", () => ({ lookupOui: m.lookupOui, lookupOuiOverride: m.lookupOuiOverride }));
vi.mock("../../src/services/macAddressService.js", () => ({ reconcileMacAddresses: m.reconcileMacAddresses }));
vi.mock("../../src/services/arpTableService.js", () => ({ persistFortigateArpTables: m.persistFortigateArpTables }));

const { stampArpPresence, persistRunArpTables } = await import("../../src/services/discovery/dhcp/arpTables.js");
const { reverseDnsForAssets, applyOuiManufacturers } = await import("../../src/services/discovery/dhcp/dnsOui.js");
const { clearStaleMacDeviceStamps } = await import("../../src/services/discovery/dhcp/staleMacDeviceStamps.js");

const log = vi.fn();
beforeEach(() => {
  resetDbStub(); vi.clearAllMocks(); });

describe("Phase 7.6 — ARP presence for DHCP reservations", () => {
  it("stamps only reservations whose reserved MAC the owning gate sees at that IP", async () => {
    db.reservationFindMany.mockResolvedValue([
      { id: "match", ipAddress: "10.0.0.5", macAddress: "aa:bb:cc:00:00:01", subnet: { fortigateDevice: "FGT-A" } },
      { id: "other-mac", ipAddress: "10.0.0.6", macAddress: "aa:bb:cc:00:00:09", subnet: { fortigateDevice: "FGT-A" } },
      { id: "other-gate", ipAddress: "10.0.0.5", macAddress: "aa:bb:cc:00:00:01", subnet: { fortigateDevice: "FGT-B" } },
    ]);
    await stampArpPresence({
      result: { arpTable: [
        { ip: "10.0.0.5", mac: "AA-BB-CC-00-00-01", fortigateDevice: "fgt-a" },
        { ip: "10.0.0.6", mac: "aa:bb:cc:00:00:02", fortigateDevice: "FGT-A" },
      ] } as never,
      integrationId: "i1",
      syncLog: log,
    });
    expect(db.reservationUpdateMany).toHaveBeenCalledTimes(1);
    expect(db.reservationUpdateMany.mock.calls[0][0].where).toEqual({ id: { in: ["match"] } });
    expect(db.reservationUpdateMany.mock.calls[0][0].data).toMatchObject({ staleNotifiedAt: null, staleSnoozedUntil: null });
  });

  it("does nothing without ARP rows, or when no row carries a usable MAC", async () => {
    await stampArpPresence({ result: {} as never, integrationId: "i1", syncLog: log });
    await stampArpPresence({ result: { arpTable: [{ ip: "10.0.0.5", mac: "00:00:00:00:00:00", fortigateDevice: "A" }] } as never, integrationId: "i1", syncLog: log });
    expect(db.reservationFindMany).not.toHaveBeenCalled();
  });
});

describe("Phase 7.5b — ARP table persist", () => {
  it("runs only for a Fortinet integration with answering gates, and never throws", async () => {
    const assetIdx = { findByMac: () => ({ id: "a1" }) } as never;
    await persistRunArpTables({ result: { arpQueriedDevices: ["FGT-A"] } as never, integrationId: "i1", integrationType: "windowsserver", assetIdx, syncLog: log });
    await persistRunArpTables({ result: { arpQueriedDevices: [] } as never, integrationId: "i1", integrationType: "fortigate", assetIdx, syncLog: log });
    expect(m.persistFortigateArpTables).not.toHaveBeenCalled();

    m.persistFortigateArpTables.mockRejectedValue(new Error("boom"));
    await persistRunArpTables({ result: { arpQueriedDevices: ["FGT-A"], devices: [{ name: "FGT-A", serial: "FGT60F01" }] } as never, integrationId: "i1", integrationType: "fortigate", assetIdx, syncLog: log });
    expect(m.persistFortigateArpTables.mock.calls[0][0].deviceSerials.get("FGT-A")).toBe("FGT60F01");
    expect(log).toHaveBeenCalledWith("error", "ARP table persist failed: boom");
  });
});

describe("Phase 7b — stale MAC device stamps", () => {
  it("clears a stamp only on a refreshed gate that no longer sees the MAC LOCALLY", async () => {
    const asset = { id: "a1", macAddresses: [
      { mac: "AA:BB:CC:00:00:01", device: "FGT-A" }, // gone from FGT-A's fresh inventory
      { mac: "AA:BB:CC:00:00:02", device: "FGT-A" }, // still seen, on a switch port: local
      { mac: "AA:BB:CC:00:00:04", device: "FGT-A" }, // "seen" only as a relayed (ZTNA) row: not local
      { mac: "AA:BB:CC:00:00:03", device: "FGT-B" }, // FGT-B not refreshed: left alone
    ] };
    await clearStaleMacDeviceStamps({
      result: {
        inventoryDevices: ["FGT-A"],
        deviceInventory: [
          { macAddress: "aa-bb-cc-00-00-02", device: "FGT-A", switchName: "SW-1" },
          { macAddress: "aa:bb:cc:00:00:04", device: "FGT-A" },
        ],
      } as never,
      assetIdx: { all: () => [asset] } as never,
      arpMacDeviceIndex: new Set(),
      syncLog: log,
    });
    expect(asset.macAddresses).toEqual([
      { mac: "AA:BB:CC:00:00:01" },
      { mac: "AA:BB:CC:00:00:02", device: "FGT-A" },
      { mac: "AA:BB:CC:00:00:04" },
      { mac: "AA:BB:CC:00:00:03", device: "FGT-B" },
    ]);
    expect(m.reconcileMacAddresses).toHaveBeenCalledWith("a1", asset.macAddresses);
  });
});

describe("Phases 8 and 9 — DNS and OUI", () => {
  it("reverse-resolves only assets with an address and a missing or expired PTR, and counts hits", async () => {
    const fresh = { id: "fresh", ipAddress: "10.0.0.1", dnsNameFetchedAt: new Date().toISOString(), dnsNameTtl: 3600 };
    const stale = { id: "stale", ipAddress: "10.0.0.2", dnsNameFetchedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), dnsNameTtl: 3600 };
    const never = { id: "never", ipAddress: "10.0.0.3" } as Record<string, unknown>;
    const noIp = { id: "noip" };
    m.reverse.mockImplementation(async (ip: string) => (ip === "10.0.0.3" ? [{ name: "host3.example", ttl: 300 }] : []));
    const n = await reverseDnsForAssets([fresh, stale, never, noIp], log);
    expect(m.reverse.mock.calls.map((c) => c[0]).sort()).toEqual(["10.0.0.2", "10.0.0.3"]);
    expect(n).toBe(1);
    expect(never.dnsName).toBe("host3.example");
  });

  it("writes dnsName only when it changed; a same-name or no-PTR result only restamps, batched per TTL", async () => {
    const renamed = { id: "renamed", ipAddress: "10.0.0.1", dnsName: "old.example" } as Record<string, unknown>;
    const same1 = { id: "same1", ipAddress: "10.0.0.2", dnsName: "s1.example" };
    const same2 = { id: "same2", ipAddress: "10.0.0.3", dnsName: "s2.example" };
    const otherTtl = { id: "other-ttl", ipAddress: "10.0.0.4", dnsName: "o.example" };
    const none = { id: "none", ipAddress: "10.0.0.5", dnsName: "kept.example" };
    const failed = { id: "failed", ipAddress: "10.0.0.6" };
    const answers: Record<string, Array<{ name: string; ttl: number }>> = {
      "10.0.0.1": [{ name: "new.example", ttl: 300 }],
      "10.0.0.2": [{ name: "s1.example", ttl: 300 }],
      "10.0.0.3": [{ name: "s2.example", ttl: 300 }],
      "10.0.0.4": [{ name: "o.example", ttl: 1200 }],
      "10.0.0.5": [],
    };
    m.reverse.mockImplementation(async (ip: string) => {
      if (ip === "10.0.0.6") throw new Error("SERVFAIL");
      return answers[ip];
    });
    const n = await reverseDnsForAssets([renamed, same1, same2, otherTtl, none, failed], log);
    expect(n).toBe(4);

    // Only the changed name goes through asset.update (it runs the dns_resolved reconcile).
    expect(db.assetUpdate).toHaveBeenCalledTimes(1);
    expect(db.assetUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: "renamed" }, data: { dnsName: "new.example", dnsNameTtl: 300 },
    });
    expect(renamed.dnsName).toBe("new.example");

    // The rest: one updateMany per TTL, never carrying dnsName (no PTR keeps the old name).
    const calls = db.assetUpdateMany.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.data).not.toHaveProperty("dnsName");
    const idsFor = (ttl: number | null) => calls.find((c) => c.data.dnsNameTtl === ttl)?.where.id.in.slice().sort();
    expect(idsFor(300)).toEqual(["same1", "same2"]);
    expect(idsFor(1200)).toEqual(["other-ttl"]);
    expect(idsFor(null)).toEqual(["none"]);
    // A failed lookup writes nothing, so it is retried next run.
    for (const c of calls) expect(c.where.id.in).not.toContain("failed");
    // Every write carries the same pass stamp.
    const stamps = new Set([db.assetUpdate.mock.calls[0][0].data.dnsNameFetchedAt, ...calls.map((c) => c.data.dnsNameFetchedAt)].map((d) => (d as Date).getTime()));
    expect(stamps.size).toBe(1);
  });

  it("applies overrides to named assets and looks up the rest, returning both counts", async () => {
    const named = { id: "n", macAddress: "aa:bb:cc:00:00:01", manufacturer: "Fortinet", model: null } as Record<string, unknown>;
    const unnamed = { id: "u", macAddress: "aa:bb:cc:00:00:02", manufacturer: null, model: "x" } as Record<string, unknown>;
    m.lookupOuiOverride.mockImplementation(async (mac: string) => (mac.endsWith("01") ? { manufacturer: "Acme", device: "Widget" } : null));
    m.lookupOui.mockResolvedValue("Contoso");
    const r = await applyOuiManufacturers([named, unnamed], log);
    expect(r).toEqual({ ouiOverridden: 1, ouiResolved: 1 });
    expect(named).toMatchObject({ manufacturer: "Acme", model: "Widget" });
    expect(unnamed).toMatchObject({ manufacturer: "Contoso", model: "x" });
  });
});
