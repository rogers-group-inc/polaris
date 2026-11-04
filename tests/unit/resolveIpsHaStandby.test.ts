/**
 * resolveIpsToAssets when an HA pair shares an address: both members carry
 * the cluster's synced interface IPs, so a tunnel's remote gateway (or any
 * traffic to the cluster) used to resolve to whichever member the query
 * returned first — often the standby. The active member must win.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  assets: [] as Array<{ id: string; hostname: string; ipAddress: string | null; assetType: string; haRole?: string }>,
  assoc:  [] as Array<{ ip: string; assetId: string }>,
}));

vi.mock("../../src/db.js", () => {
  const lite = (a: (typeof db.assets)[number]) => ({
    id: a.id, hostname: a.hostname, ipAddress: a.ipAddress, assetType: a.assetType,
    monitorStatus: null, manufacturer: null, model: null, tags: [],
  });
  return {
    prisma: {
      asset: {
        findMany: vi.fn(async ({ where }: any) => {
          let rows = db.assets;
          if (where.ipAddress?.in) rows = rows.filter((a) => a.ipAddress && where.ipAddress.in.includes(a.ipAddress));
          if (where.id?.in) rows = rows.filter((a) => where.id.in.includes(a.id));
          if (where.fortinetTopology) {
            rows = rows.filter((a) => a.haRole === where.fortinetTopology.equals);
            return rows.map((a) => ({ id: a.id }));
          }
          return rows.map(lite);
        }),
      },
      assetAssociatedIp: {
        findMany: vi.fn(async ({ where }: any) => db.assoc.filter((r) => where.ip.in.includes(r.ip))),
      },
    },
  };
});

import { resolveIpsToAssets, pickIpHolder } from "../../src/services/applicationMapService.js";

beforeEach(() => {
  db.assets = [];
  db.assoc = [];
});

describe("resolveIpsToAssets — HA pairs", () => {
  it("resolves a shared associated address to the active member, not the standby", async () => {
    db.assets = [
      { id: "fw-b", hostname: "HUB1-b", ipAddress: "172.22.128.105", assetType: "firewall", haRole: "secondary" },
      { id: "fw-a", hostname: "HUB1-a", ipAddress: "172.22.128.101", assetType: "firewall", haRole: "primary" },
    ];
    // Standby listed first — the order the old resolver trusted.
    db.assoc = [{ ip: "203.0.113.10", assetId: "fw-b" }, { ip: "203.0.113.10", assetId: "fw-a" }];
    const out = await resolveIpsToAssets(["203.0.113.10"]);
    expect(out.get("203.0.113.10")?.id).toBe("fw-a");
  });

  it("looks past a standby that holds the address as its PRIMARY to an active member holding it associated", async () => {
    db.assets = [
      { id: "fw-b", hostname: "FW-b", ipAddress: "198.51.100.1", assetType: "firewall", haRole: "secondary" },
      { id: "fw-a", hostname: "FW-a", ipAddress: "10.0.0.1",     assetType: "firewall", haRole: "primary" },
    ];
    db.assoc = [{ ip: "198.51.100.1", assetId: "fw-a" }];
    const out = await resolveIpsToAssets(["198.51.100.1"]);
    expect(out.get("198.51.100.1")?.id).toBe("fw-a");
  });

  it("still resolves to a standby when it is the only holder", async () => {
    db.assets = [{ id: "fw-b", hostname: "FW-b", ipAddress: null, assetType: "firewall", haRole: "secondary" }];
    db.assoc = [{ ip: "203.0.113.10", assetId: "fw-b" }];
    const out = await resolveIpsToAssets(["203.0.113.10"]);
    expect(out.get("203.0.113.10")?.id).toBe("fw-b");
  });

  it("leaves non-firewall resolution unchanged: a primary-address holder wins and the associated table is not consulted for it", async () => {
    db.assets = [
      { id: "srv-1", hostname: "srv-1", ipAddress: "10.1.1.5", assetType: "server" },
      { id: "srv-2", hostname: "srv-2", ipAddress: null,       assetType: "server" },
    ];
    db.assoc = [{ ip: "10.1.1.5", assetId: "srv-2" }];
    const out = await resolveIpsToAssets(["10.1.1.5"]);
    expect(out.get("10.1.1.5")?.id).toBe("srv-1");
  });
});

describe("pickIpHolder", () => {
  it("takes the first non-standby, else the first", () => {
    const a = { id: "a" }, b = { id: "b" };
    expect(pickIpHolder([a, b], new Set(["a"]))).toBe(b);
    expect(pickIpHolder([a, b], new Set())).toBe(a);
    expect(pickIpHolder([a], new Set(["a"]))).toBe(a);
  });
});
