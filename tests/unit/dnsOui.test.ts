/**
 * tests/unit/dnsOui.test.ts — syncDhcpSubnets Phases 8 (reverse DNS) and 9
 * (OUI manufacturer) as their own module (src/services/discovery/dhcp/dnsOui.ts).
 *
 * tests/unit/dhcpPhasesExtracted.test.ts pins the headline of each phase; this
 * suite covers the edges: the PTR TTL arithmetic, the one stamp per pass, the
 * per-TTL restamp batching and its chunking, a failed restamp, a failed
 * lookup, and the 9a / 9b override rules (an override's device wins over the
 * model; both phases mutate the in-memory rows later phases read).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const m = vi.hoisted(() => ({
  reverse: vi.fn(),
  getConfiguredResolver: vi.fn(),
  lookupOui: vi.fn(),
  lookupOuiOverride: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/dnsService.js", () => ({ getConfiguredResolver: m.getConfiguredResolver }));
vi.mock("../../src/services/ouiService.js", () => ({ lookupOui: m.lookupOui, lookupOuiOverride: m.lookupOuiOverride }));

const { reverseDnsForAssets, applyOuiManufacturers } = await import("../../src/services/discovery/dhcp/dnsOui.js");

const db = {
  assetUpdate: stubbed(prisma.asset.update),
  assetUpdateMany: stubbed(prisma.asset.updateMany),
};

const NOW = new Date("2026-11-16T12:00:00Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
const log = vi.fn();

beforeEach(() => {
  resetDbStub();
  log.mockReset();
  m.reverse.mockReset().mockResolvedValue([]);
  m.getConfiguredResolver.mockReset().mockResolvedValue({ reverse: m.reverse });
  m.lookupOui.mockReset().mockResolvedValue(null);
  m.lookupOuiOverride.mockReset().mockResolvedValue(null);
  db.assetUpdate.mockResolvedValue({});
  db.assetUpdateMany.mockResolvedValue({ count: 0 });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reverseDnsForAssets (Phase 8)", () => {
  it("does no lookup, builds no resolver and logs nothing when every PTR is fresh", async () => {
    const n = await reverseDnsForAssets([
      { id: "a", ipAddress: "10.0.0.1", dnsNameFetchedAt: ago(10), dnsNameTtl: 60 },
      { id: "b" },
    ], log);
    expect(n).toBe(0);
    expect(m.getConfiguredResolver).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("uses the 3600 s default TTL when none is stored, and treats exactly-TTL as still fresh", async () => {
    await reverseDnsForAssets([
      { id: "default-fresh", ipAddress: "10.0.0.1", dnsNameFetchedAt: ago(3599) },
      { id: "default-edge", ipAddress: "10.0.0.2", dnsNameFetchedAt: ago(3600) },
      { id: "default-stale", ipAddress: "10.0.0.3", dnsNameFetchedAt: ago(3601) },
      { id: "short", ipAddress: "10.0.0.4", dnsNameFetchedAt: ago(61), dnsNameTtl: 60 },
      { id: "zero", ipAddress: "10.0.0.5", dnsNameFetchedAt: ago(1), dnsNameTtl: 0 },
    ], log);
    expect(m.reverse.mock.calls.map((c) => c[0]).sort()).toEqual(["10.0.0.3", "10.0.0.4", "10.0.0.5"]);
  });

  it("writes a new name per row with the pass stamp and the record's TTL, and mutates the in-memory row", async () => {
    const a = { id: "a", ipAddress: "10.0.0.1", dnsName: null } as Record<string, unknown>;
    m.reverse.mockResolvedValue([{ name: "host-a.example", ttl: 120 }, { name: "alias.example", ttl: 5 }]);
    const n = await reverseDnsForAssets([a], log);
    expect(n).toBe(1);
    expect(a.dnsName).toBe("host-a.example");
    expect(db.assetUpdate).toHaveBeenCalledWith({
      where: { id: "a" },
      data: { dnsName: "host-a.example", dnsNameFetchedAt: NOW, dnsNameTtl: 120 },
    });
    expect(db.assetUpdateMany).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("info", "DNS lookup: resolved 1 of 1 assets");
  });

  it("stores a null TTL when the record carries none", async () => {
    m.reverse.mockResolvedValue([{ name: "x.example" }]);
    await reverseDnsForAssets([{ id: "a", ipAddress: "10.0.0.1" }], log);
    expect(db.assetUpdate.mock.calls[0][0].data.dnsNameTtl).toBeNull();
  });

  it("restamps same-name and no-PTR rows in one updateMany per TTL value, never touching dnsName", async () => {
    const answers: Record<string, Array<{ name: string; ttl?: number }>> = {
      "10.0.0.1": [{ name: "s1", ttl: 300 }],
      "10.0.0.2": [{ name: "s2", ttl: 300 }],
      "10.0.0.3": [],
      "10.0.0.4": [],
    };
    m.reverse.mockImplementation(async (ip: string) => answers[ip]);
    const none = { id: "n1", ipAddress: "10.0.0.3", dnsName: "kept.example" } as Record<string, unknown>;
    const n = await reverseDnsForAssets([
      { id: "s1", ipAddress: "10.0.0.1", dnsName: "s1" },
      { id: "s2", ipAddress: "10.0.0.2", dnsName: "s2" },
      none,
      { id: "n2", ipAddress: "10.0.0.4" },
    ], log);
    expect(n).toBe(2);
    expect(db.assetUpdate).not.toHaveBeenCalled();
    const calls = db.assetUpdateMany.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      { where: { id: { in: ["s1", "s2"] } }, data: { dnsNameFetchedAt: NOW, dnsNameTtl: 300 } },
      { where: { id: { in: ["n1", "n2"] } }, data: { dnsNameFetchedAt: NOW, dnsNameTtl: null } },
    ]);
    expect(none.dnsName).toBe("kept.example");
  });

  it("chunks a restamp at 1000 ids", async () => {
    const assets = Array.from({ length: 2001 }, (_, i) => ({ id: `a${i}`, ipAddress: `10.${i >> 8}.${i & 255}.1` }));
    await reverseDnsForAssets(assets, log);
    expect(db.assetUpdateMany.mock.calls.map((c) => c[0].where.id.in.length)).toEqual([1000, 1000, 1]);
  });

  it("logs a failed restamp and carries on with the other chunks", async () => {
    m.reverse.mockImplementation(async (ip: string) => (ip === "10.0.0.1" ? [{ name: "s", ttl: 60 }] : []));
    db.assetUpdateMany.mockRejectedValueOnce(new Error("deadlock")).mockResolvedValue({ count: 1 });
    await reverseDnsForAssets([
      { id: "s", ipAddress: "10.0.0.1", dnsName: "s" },
      { id: "n", ipAddress: "10.0.0.2" },
    ], log);
    expect(db.assetUpdateMany).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith("error", "DNS lookup: failed to record the fetch time on 1 asset(s): deadlock");
  });

  it("neither counts nor restamps an asset whose lookup threw (it is retried next run)", async () => {
    m.reverse.mockRejectedValue(new Error("SERVFAIL"));
    const n = await reverseDnsForAssets([{ id: "a", ipAddress: "10.0.0.1" }], log);
    expect(n).toBe(0);
    expect(db.assetUpdate).not.toHaveBeenCalled();
    expect(db.assetUpdateMany).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1); // the "resolving N" line only
  });

  it("resolves an IPv6-only asset by its ipAddress field only (no address, no lookup)", async () => {
    await reverseDnsForAssets([{ id: "v6", ipAddress: null, ipv6Address: "2001:db8::1" }], log);
    expect(m.reverse).not.toHaveBeenCalled();
  });
});

describe("applyOuiManufacturers (Phase 9)", () => {
  it("does nothing for assets without a MAC", async () => {
    const out = await applyOuiManufacturers([{ id: "a", manufacturer: null }, { id: "b", manufacturer: "Dell" }], log);
    expect(out).toEqual({ ouiOverridden: 0, ouiResolved: 0 });
    expect(m.lookupOui).not.toHaveBeenCalled();
    expect(m.lookupOuiOverride).not.toHaveBeenCalled();
  });

  it("9a — an override replaces a differing manufacturer and, with a device, the model", async () => {
    const a = { id: "a", macAddress: "AA:BB:CC:00:00:01", manufacturer: "Fortinet", model: "FAP-231F" };
    m.lookupOuiOverride.mockResolvedValue({ manufacturer: "Acme Wireless", device: "Acme AP" });
    const out = await applyOuiManufacturers([a], log);
    expect(out).toEqual({ ouiOverridden: 1, ouiResolved: 0 });
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "a" }, data: { manufacturer: "Acme Wireless", model: "Acme AP" } });
    expect(a).toMatchObject({ manufacturer: "Acme Wireless", model: "Acme AP" });
    expect(log).toHaveBeenCalledWith("info", "OUI overrides: applied to 1 assets");
  });

  it("9a — an override that already matches writes nothing and is not counted", async () => {
    m.lookupOuiOverride.mockResolvedValue({ manufacturer: "Fortinet", device: "FAP-231F" });
    const out = await applyOuiManufacturers([{ id: "a", macAddress: "AA:BB:CC:00:00:01", manufacturer: "Fortinet", model: "FAP-231F" }], log);
    expect(out.ouiOverridden).toBe(0);
    expect(db.assetUpdate).not.toHaveBeenCalled();
  });

  it("9a — only the model changes when the manufacturer already matches", async () => {
    m.lookupOuiOverride.mockResolvedValue({ manufacturer: "Fortinet", device: "Custom" });
    await applyOuiManufacturers([{ id: "a", macAddress: "AA:BB:CC:00:00:01", manufacturer: "Fortinet", model: "Old" }], log);
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "a" }, data: { model: "Custom" } });
  });

  it("9a — a failed write is not counted and does not stop the pass", async () => {
    m.lookupOuiOverride.mockResolvedValue({ manufacturer: "Acme" });
    db.assetUpdate.mockRejectedValueOnce(new Error("db")).mockResolvedValue({});
    const out = await applyOuiManufacturers([
      { id: "a", macAddress: "AA:BB:CC:00:00:01", manufacturer: "X" },
      { id: "b", macAddress: "AA:BB:CC:00:00:02", manufacturer: "Y" },
    ], log);
    expect(out.ouiOverridden).toBe(1);
  });

  it("9b — fills a missing manufacturer from the OUI table, with the override's device as model", async () => {
    const a = { id: "a", macAddress: "AA:BB:CC:00:00:01", manufacturer: null, model: null } as Record<string, unknown>;
    m.lookupOui.mockResolvedValue("Dell Inc.");
    m.lookupOuiOverride.mockResolvedValue({ manufacturer: "Dell Inc.", device: "Latitude" });
    const out = await applyOuiManufacturers([a], log);
    expect(out).toEqual({ ouiOverridden: 0, ouiResolved: 1 });
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "a" }, data: { manufacturer: "Dell Inc.", model: "Latitude" } });
    expect(a).toMatchObject({ manufacturer: "Dell Inc.", model: "Latitude" });
    expect(log).toHaveBeenCalledWith("info", "OUI lookup: resolved 1 of 1 assets");
  });

  it("9b — leaves the asset alone when the OUI is unknown", async () => {
    const out = await applyOuiManufacturers([{ id: "a", macAddress: "AA:BB:CC:00:00:01", manufacturer: "" }], log);
    expect(out.ouiResolved).toBe(0);
    expect(m.lookupOuiOverride).not.toHaveBeenCalled();
    expect(db.assetUpdate).not.toHaveBeenCalled();
  });

  it("9b — writes the manufacturer only when there is no override device", async () => {
    m.lookupOui.mockResolvedValue("HP");
    await applyOuiManufacturers([{ id: "a", macAddress: "AA:BB:CC:00:00:01", manufacturer: null, model: "Elite" }], log);
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "a" }, data: { manufacturer: "HP" } });
  });

  it("an asset 9a named is not looked up again in 9b; an unnamed one is not seen by 9a", async () => {
    m.lookupOuiOverride.mockResolvedValue(null);
    m.lookupOui.mockResolvedValue("Vendor");
    await applyOuiManufacturers([
      { id: "named", macAddress: "AA:BB:CC:00:00:01", manufacturer: "Fortinet" },
      { id: "unnamed", macAddress: "AA:BB:CC:00:00:02", manufacturer: null },
    ], log);
    expect(m.lookupOui.mock.calls.map((c) => c[0])).toEqual(["AA:BB:CC:00:00:02"]);
    // 9a asks once (named); 9b asks once more for the device field (unnamed)
    expect(m.lookupOuiOverride.mock.calls.map((c) => c[0])).toEqual(["AA:BB:CC:00:00:01", "AA:BB:CC:00:00:02"]);
  });
});
