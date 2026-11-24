/**
 * tests/unit/integrationDns.test.ts — the post-sync DNS pass of the asset-only
 * integrations (src/services/discovery/integrationDns.ts, business rule 11(b)):
 * who is a forward-lookup candidate, the IPv4 pick, the collision split, and
 * the pass end to end against the db stub — filled addresses written with
 * ipSource "dns" and audited, misses and collisions negative-cached, the PTR
 * half handed only the rows that already had an address.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const m = vi.hoisted(() => ({
  lookup: vi.fn(),
  getConfiguredResolver: vi.fn(),
  reverseDnsForAssets: vi.fn(),
  logEventsBatch: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/dnsService.js", () => ({ getConfiguredResolver: m.getConfiguredResolver }));
vi.mock("../../src/services/discovery/dhcp/dnsOui.js", () => ({ reverseDnsForAssets: m.reverseDnsForAssets }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEventsBatch: m.logEventsBatch }));

const {
  INTEGRATION_DNS_TYPES, forwardLookupName, pickForwardCandidates, firstIpv4, partitionResolved, runIntegrationDnsPass,
} = await import("../../src/services/discovery/integrationDns.js");

const db = {
  sourceFindMany: stubbed(prisma.assetSource.findMany),
  assetFindMany: stubbed(prisma.asset.findMany),
  assetUpdate: stubbed(prisma.asset.update),
  assetUpdateMany: stubbed(prisma.asset.updateMany),
};

const NOW = new Date("2026-11-24T12:00:00Z");
const log = vi.fn();

function asset(over: Record<string, unknown> = {}) {
  return {
    id: "a1", ipAddress: null, hostname: "pc01", dnsName: "pc01.corp.example", dnsNameFetchedAt: null, dnsNameTtl: null,
    status: "active", ipOverride: null, ipBlankPinned: false, primaryAddressIp: null, discoveredByIntegration: null,
    ...over,
  } as any;
}

beforeEach(() => {
  resetDbStub();
  log.mockReset();
  m.lookup.mockReset().mockResolvedValue([]);
  m.getConfiguredResolver.mockReset().mockResolvedValue({ lookup: m.lookup });
  m.reverseDnsForAssets.mockReset().mockResolvedValue(0);
  m.logEventsBatch.mockReset().mockResolvedValue(0);
  db.assetUpdate.mockResolvedValue({});
  db.assetUpdateMany.mockResolvedValue({ count: 0 });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("INTEGRATION_DNS_TYPES", () => {
  it("names the six asset-only integrations and none of the Phase 8 ones", () => {
    expect([...INTEGRATION_DNS_TYPES].sort()).toEqual(["activedirectory", "azurearc", "entraid", "proxmox", "truenas", "unraid"]);
    for (const t of ["fortimanager", "fortigate", "windowsserver"]) expect(INTEGRATION_DNS_TYPES.has(t)).toBe(false);
  });
});

describe("forwardLookupName", () => {
  it("prefers dnsName, falls back to hostname, lowercases and drops the root dot", () => {
    expect(forwardLookupName({ dnsName: "PC01.Corp.Example.", hostname: "x" })).toBe("pc01.corp.example");
    expect(forwardLookupName({ dnsName: null, hostname: "PC01" })).toBe("pc01");
  });
  it("refuses names that are not hostnames, and addresses", () => {
    expect(forwardLookupName({ dnsName: "my laptop", hostname: "Windows 11 VM" })).toBeNull();
    expect(forwardLookupName({ dnsName: "10.1.2.3", hostname: null })).toBeNull();
    expect(forwardLookupName({ dnsName: null, hostname: null })).toBeNull();
  });
});

describe("pickForwardCandidates", () => {
  const now = NOW.getTime();
  it("takes an eligible IP-less asset", () => {
    expect(pickForwardCandidates([asset()], new Set(), now).map((c) => c.name)).toEqual(["pc01.corp.example"]);
  });
  it("never touches an asset that has an address, a pin, or a retired status", () => {
    const out = pickForwardCandidates([
      asset({ id: "ip", ipAddress: "10.0.0.5" }),
      asset({ id: "ov", ipOverride: "10.0.0.6" }),
      asset({ id: "bl", ipBlankPinned: true }),
      asset({ id: "pp", primaryAddressIp: "10.0.0.7" }),
      asset({ id: "dc", status: "decommissioned" }),
      asset({ id: "di", status: "disabled" }),
    ], new Set(), now);
    expect(out).toEqual([]);
  });
  it("skips Fortinet-managed assets (rule 111(c)) and container-only assets", () => {
    const out = pickForwardCandidates([
      asset({ id: "fg", discoveredByIntegration: { type: "fortigate" } }),
      asset({ id: "fm", discoveredByIntegration: { type: "fortimanager" } }),
      asset({ id: "ct" }),
      asset({ id: "ad", discoveredByIntegration: { type: "activedirectory" } }),
    ], new Set(["ct"]), now);
    expect(out.map((c) => c.asset.id)).toEqual(["ad"]);
  });
  it("honours the negative cache for its TTL, default one hour", () => {
    const ago = (s: number) => new Date(now - s * 1000);
    const out = pickForwardCandidates([
      asset({ id: "fresh", dnsNameFetchedAt: ago(600) }),
      asset({ id: "stale", dnsNameFetchedAt: ago(3601) }),
      asset({ id: "shortTtl", dnsNameFetchedAt: ago(120), dnsNameTtl: 60 }),
    ], new Set(), now);
    expect(out.map((c) => c.asset.id)).toEqual(["stale", "shortTtl"]);
  });
});

describe("firstIpv4", () => {
  it("returns the first IPv4 answer and ignores IPv6 and junk", () => {
    expect(firstIpv4([{ address: "fd00::1" }, { address: "10.0.0.9" }, { address: "10.0.0.10" }])).toBe("10.0.0.9");
    expect(firstIpv4([{ address: "fd00::1" }])).toBeNull();
    expect(firstIpv4([{ address: "" }, { address: "nope" }])).toBeNull();
  });
});

describe("partitionResolved", () => {
  it("withholds an address another asset holds and one two candidates share", () => {
    const { write, collided } = partitionResolved([
      { assetId: "a", ip: "10.0.0.1" },
      { assetId: "b", ip: "10.0.0.2" },
      { assetId: "c", ip: "10.0.0.3" },
      { assetId: "d", ip: "10.0.0.3" },
    ], new Set(["10.0.0.2"]));
    expect(write).toEqual([{ assetId: "a", ip: "10.0.0.1" }]);
    expect(collided.map((c) => c.assetId).sort()).toEqual(["b", "c", "d"]);
  });
});

describe("runIntegrationDnsPass", () => {
  function seed(assets: any[], sources: Array<{ assetId: string; sourceKind: string }>, heldIps: string[] = []) {
    db.sourceFindMany.mockResolvedValue(sources);
    db.assetFindMany.mockImplementation(async (args: any) => {
      if (args?.where?.ipAddress) return heldIps.map((ip) => ({ ipAddress: ip }));
      const ids: string[] = args?.where?.id?.in ?? [];
      return assets.filter((a) => ids.includes(a.id));
    });
  }

  it("fills a resolved address with ipSource dns, audits it, and hands PTR only the addressed rows", async () => {
    const withIp = asset({ id: "b", ipAddress: "10.0.0.20", hostname: "srv02", dnsName: null });
    seed([asset({ id: "a" }), withIp], [{ assetId: "a", sourceKind: "ad" }, { assetId: "b", sourceKind: "ad" }]);
    m.lookup.mockResolvedValue([{ address: "10.0.0.10", family: 4 }]);
    m.reverseDnsForAssets.mockResolvedValue(1);

    const r = await runIntegrationDnsPass("int1", log, "system:discovery");

    expect(m.lookup).toHaveBeenCalledWith("pc01.corp.example");
    expect(db.assetUpdate).toHaveBeenCalledWith({
      where: { id: "a" },
      data: { ipAddress: "10.0.0.10", ipSource: "dns", dnsNameFetchedAt: NOW, dnsNameTtl: null },
    });
    const events = m.logEventsBatch.mock.calls[0]![0];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "asset.dns.forward_resolved", resourceId: "a", actor: "system:discovery" });
    expect(m.reverseDnsForAssets.mock.calls[0]![0].map((x: any) => x.id)).toEqual(["b"]);
    expect(r).toEqual({ ptrResolved: 1, forwardFilled: 1, forwardMissed: 0, forwardCollided: 0 });
  });

  it("negative-caches a miss and a collision without writing an address", async () => {
    seed(
      [asset({ id: "miss", dnsName: "gone.corp.example" }), asset({ id: "dup", dnsName: "dup.corp.example" })],
      [{ assetId: "miss", sourceKind: "entra" }, { assetId: "dup", sourceKind: "entra" }],
      ["10.0.0.50"],
    );
    m.lookup.mockImplementation(async (name: string) => {
      if (name === "gone.corp.example") throw new Error("ENOTFOUND");
      return [{ address: "10.0.0.50", family: 4 }];
    });

    const r = await runIntegrationDnsPass("int1", log, undefined);

    expect(db.assetUpdate).not.toHaveBeenCalled();
    expect(db.assetUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["miss", "dup"] } },
      data: { dnsNameFetchedAt: NOW, dnsNameTtl: null },
    });
    expect(r).toMatchObject({ forwardFilled: 0, forwardMissed: 1, forwardCollided: 1 });
    expect(log.mock.calls.some(([lvl, msg]) => lvl === "warning" && /already another asset's/.test(msg))).toBe(true);
  });

  it("never forward-looks-up a workload container", async () => {
    seed([asset({ id: "c", hostname: "nginx", dnsName: null })], [{ assetId: "c", sourceKind: "unraid-container" }]);
    await runIntegrationDnsPass("int1", log, undefined);
    expect(m.lookup).not.toHaveBeenCalled();
    expect(m.getConfiguredResolver).not.toHaveBeenCalled();
  });

  it("logs and returns zeros instead of throwing when the source read fails", async () => {
    db.sourceFindMany.mockRejectedValue(new Error("db down"));
    const r = await runIntegrationDnsPass("int1", log, undefined);
    expect(r).toEqual({ ptrResolved: 0, forwardFilled: 0, forwardMissed: 0, forwardCollided: 0 });
    expect(log).toHaveBeenCalledWith("error", "DNS pass failed: db down");
  });
});
