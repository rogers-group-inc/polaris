/**
 * tests/unit/searchService.test.ts — the global search's dispatch, gating,
 * merging and hit shapes (CQ-T010).
 *
 * Complements, does not repeat:
 *   - parseSearchTerms.test.ts / normalizeMac.test.ts — term + MAC parsing
 *   - searchAssetFilter.test.ts — assetFilterWhere and the gear filter
 *     reaching every asset lookup, incl. the thumbprint exemption
 *   - searchServiceOrigin.test.ts — the Device Map origin (tree, then sighting)
 *   - searchServiceIpsec.test.ts — the ipsec group and its scopes
 *   - assetMonitorPillState.test.ts — the status pill
 *   - integration/agentHostPinArchive.test.ts — archived pins against a real DB
 *
 * What was unreached: the 2-character floor (1 under a scope); every scope
 * prefix and its long / short form running ONLY its own group at the scoped
 * cap; a denied group never being queried; the single-term IP / CIDR / MAC
 * special cases (exact reservation IP, normalized exact CIDR, MAC equals) and
 * their absence on a multi-term query; the `entra:` / `ad:` / `fgt:` source-key
 * prefix; the ips group (free vs reserved, needs both subnets and reservations
 * readable); the asset merge order and its per-group cap; the alert summary
 * stamped in ONE call; the thumbprint pin hits leading the group; and the
 * block / subnet / reservation hit shapes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

const h = vi.hoisted(() => ({
  activeAlertSummaryByAsset: vi.fn(),
  findAssetIdsByDiscoveredHostname: vi.fn(),
  findAssetsByPinFingerprint: vi.fn(),
}));
vi.mock("../../src/services/applicationMapService.js", () => ({ resolveIpsToAssets: vi.fn(async () => new Map()) }));
vi.mock("../../src/services/notificationService.js", () => ({ activeAlertSummaryByAsset: h.activeAlertSummaryByAsset }));
vi.mock("../../src/services/discoveredHostnameService.js", () => ({ findAssetIdsByDiscoveredHostname: h.findAssetIdsByDiscoveredHostname }));
vi.mock("../../src/services/agentHostPinService.js", () => ({ findAssetsByPinFingerprint: h.findAssetsByPinFingerprint }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { searchAll, type SearchAllowed } from "../../src/services/searchService.js";

const asset = (id: string, over: Record<string, unknown> = {}) => ({
  id, hostname: id, ipAddress: null, macAddress: null, assetTag: null, assetType: "workstation",
  manufacturer: null, model: null, serialNumber: null, learnedLocation: null, monitored: false,
  monitorStatus: null, status: "active", dependencySuppressed: false, dependencyTestUntil: null, ...over,
});

const MANY = ["ipBlock", "subnet", "reservation", "assetSource", "assetMacAddress", "assetAssociatedIp", "assetIpHistory",
  "assetIpsecConnection", "asset", "assetDependencyParent", "assetFortigateSighting"];

const NONE: SearchAllowed = { blocks: false, subnets: false, reservations: false, assets: false, sites: false, ipsec: false, pins: false };

beforeEach(() => {
  resetDbStub();
  for (const m of MANY) stubbed((prisma as any)[m].findMany).mockResolvedValue([]);
  stubbed(prisma.$queryRaw).mockResolvedValue([]);
  h.activeAlertSummaryByAsset.mockReset();
  h.activeAlertSummaryByAsset.mockResolvedValue(new Map());
  h.findAssetIdsByDiscoveredHostname.mockReset();
  h.findAssetIdsByDiscoveredHostname.mockResolvedValue(new Map());
  h.findAssetsByPinFingerprint.mockReset();
  h.findAssetsByPinFingerprint.mockResolvedValue([]);
});

const calledModels = () => MANY.filter((m) => stubbed((prisma as any)[m].findMany).mock.calls.length > 0);
const argsOf = (model: string, i = 0) => stubbed((prisma as any)[model].findMany).mock.calls[i]![0];

describe("the query floor", () => {
  it("an unscoped query under 2 characters runs nothing and echoes the trimmed query", async () => {
    const r = await searchAll("  a ");
    expect(r).toEqual({ query: "a", blocks: [], subnets: [], reservations: [], assets: [], ips: [], sites: [], ipsec: [] });
    expect(calledModels()).toEqual([]);
  });

  it("a scope lowers the floor to one character; an empty scoped query runs nothing", async () => {
    await searchAll("b:f");
    expect(calledModels()).toEqual(["ipBlock"]);
    resetDbStub();
    for (const m of MANY) stubbed((prisma as any)[m].findMany).mockResolvedValue([]);
    const r = await searchAll("block:   ");
    expect(r.blocks).toEqual([]);
    expect(calledModels()).toEqual([]);
  });

  it("a query of only quote characters has no terms and runs nothing", async () => {
    await searchAll('""');
    expect(calledModels()).toEqual([]);
  });
});

describe("scopes run only their own group, at the scoped cap", () => {
  it.each([
    ["block:core", "ipBlock"], ["b:core", "ipBlock"],
    ["network:core", "subnet"], ["n:core", "subnet"], ["NETWORK:core", "subnet"],
    ["reservation:core", "reservation"], ["r:core", "reservation"],
  ])("%s → %s only, take 200", async (q, model) => {
    await searchAll(q);
    expect(calledModels()).toEqual([model]);
    expect(argsOf(model).take).toBe(200);
  });

  it("asset: and map: go through the asset column scan at 200; map: adds the pinned-firewall filter", async () => {
    await searchAll("a:core");
    expect(argsOf("asset").take).toBe(200);
    expect(argsOf("asset").where.assetType).toBeUndefined();
    stubbed(prisma.asset.findMany).mockClear();
    await searchAll("m:core");
    expect(argsOf("asset").where).toMatchObject({ assetType: "firewall", latitude: { not: null }, longitude: { not: null } });
    expect(argsOf("asset").take).toBe(200);
  });

  it("a denied scope returns the empty result without querying", async () => {
    for (const q of ["b:x", "n:x", "r:x", "a:x", "m:x", "v:x"]) {
      const r = await searchAll(q, NONE);
      expect(r.query).toBe(q);
    }
    expect(calledModels()).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("tag: runs a raw tag scan per allowed group only, and loads the matched rows", async () => {
    stubbed(prisma.$queryRaw).mockResolvedValue([{ id: "x1" }]);
    stubbed(prisma.ipBlock.findMany).mockResolvedValue([{ id: "x1", name: "Plant", cidr: "10.0.0.0/8", description: null }]);
    const r = await searchAll("tag:plant", { ...NONE, blocks: true });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(argsOf("ipBlock").where).toEqual({ id: { in: ["x1"] } });
    expect(r.blocks).toEqual([{ type: "block", id: "x1", title: "Plant", subtitle: "10.0.0.0/8" }]);
    expect(r.subnets).toEqual([]);
  });
});

describe("single-term special cases", () => {
  it("a single CIDR term ORs the normalized exact CIDR with the substring scan", async () => {
    await searchAll("n:10.1.1.5/24");
    expect(argsOf("subnet").where).toEqual({
      OR: [{ cidr: "10.1.1.0/24" }, { AND: [expect.objectContaining({ OR: expect.any(Array) })] }],
    });
  });

  it("a single IP term ORs the exact reservation IP, active reservations only", async () => {
    await searchAll("r:10.0.0.5");
    expect(argsOf("reservation").where).toMatchObject({ status: "active", OR: [{ ipAddress: "10.0.0.5" }, { AND: expect.any(Array) }] });
  });

  it("a multi-term query is plain text: one AND clause per term, no exact-IP branch", async () => {
    await searchAll('r:10.0.0.5 "plant two"');
    const where = argsOf("reservation").where;
    expect(where.OR).toBeUndefined();
    expect(where.AND).toHaveLength(2);
    expect(where.AND[1].OR[0]).toEqual({ hostname: { contains: "plant two", mode: "insensitive" } });
  });

  it("a single MAC term matches the normalized MAC exactly; a text term matches it as a substring", async () => {
    await searchAll("a:aa-bb-cc-dd-ee-ff");
    const macCol = argsOf("asset").where.AND[0].OR.find((c: any) => c.macAddress);
    expect(macCol).toEqual({ macAddress: { equals: "AA:BB:CC:DD:EE:FF", mode: "insensitive" } });
    stubbed(prisma.asset.findMany).mockClear();
    await searchAll("a:core");
    expect(argsOf("asset").where.AND[0].OR.find((c: any) => c.macAddress)).toEqual({ macAddress: { contains: "core", mode: "insensitive" } });
  });

  it("an entra: / ad: / fgt: prefix is stripped for the source-key search only", async () => {
    await searchAll("a:entra:3f2a-77");
    expect(argsOf("assetSource").where.AND).toEqual([{ externalId: { contains: "3f2a-77", mode: "insensitive" } }]);
    expect(argsOf("asset").where.AND[0].OR[0]).toEqual({ hostname: { contains: "entra:3f2a-77", mode: "insensitive" } });
  });
});

describe("the ips group", () => {
  beforeEach(() => {
    stubbed(prisma.subnet.findMany).mockImplementation(async (args: any) =>
      args?.where?.status ? [{ id: "s1", cidr: "10.0.0.0/24", name: "Office" }, { id: "s2", cidr: "bogus", name: "Bad" }] : []);
  });

  it("a free address names its subnet; deprecated subnets are not considered", async () => {
    stubbed(prisma.reservation.findFirst).mockResolvedValue(null);
    const r = await searchAll("10.0.0.9");
    expect(r.ips).toEqual([{
      type: "ip", id: "s1|10.0.0.9", title: "10.0.0.9", subtitle: "free — in 10.0.0.0/24 (Office)",
      context: { subnetId: "s1", subnetCidr: "10.0.0.0/24", subnetName: "Office", ipAddress: "10.0.0.9", reservationId: null },
    }]);
    const subnetLookup = stubbed(prisma.subnet.findMany).mock.calls.find((c) => c[0]?.where?.status)![0];
    expect(subnetLookup.where).toEqual({ status: { not: "deprecated" } });
  });

  it("a reserved address names its holder (hostname, else owner, else 'reserved')", async () => {
    stubbed(prisma.reservation.findFirst).mockResolvedValue({ id: "r1", hostname: null, owner: "facilities" });
    const r = await searchAll("10.0.0.9");
    expect(r.ips[0]!.subtitle).toBe("facilities — in 10.0.0.0/24");
    expect(r.ips[0]!.context!.reservationId).toBe("r1");
    stubbed(prisma.reservation.findFirst).mockResolvedValue({ id: "r1", hostname: null, owner: null });
    expect((await searchAll("10.0.0.9")).ips[0]!.subtitle).toBe("reserved — in 10.0.0.0/24");
  });

  it("an address in no subnet has no ips hit; a role without both subnets and reservations gets none", async () => {
    expect((await searchAll("192.168.9.9")).ips).toEqual([]);
    stubbed(prisma.subnet.findMany).mockClear();
    const r = await searchAll("10.0.0.9", { ...NONE, subnets: true });
    expect(r.ips).toEqual([]);
    expect(stubbed(prisma.subnet.findMany).mock.calls.some((c) => c[0]?.where?.status)).toBe(false);
  });
});

describe("the asset group", () => {
  it("merges column hits first, then source / MAC / IP / IP-history side hits, deduped and capped at 8", async () => {
    stubbed(prisma.asset.findMany).mockImplementation(async (args: any) =>
      args.where?.AND ? [asset("A-col"), asset("A-dup")] : []);
    stubbed(prisma.assetSource.findMany).mockResolvedValue([{ asset: asset("A-dup") }, { asset: asset("B-src") }]);
    stubbed(prisma.assetMacAddress.findMany).mockResolvedValue([{ asset: asset("C-mac") }]);
    stubbed(prisma.assetAssociatedIp.findMany).mockResolvedValue([{ asset: asset("D-ip") }]);
    stubbed(prisma.assetIpHistory.findMany).mockResolvedValue(
      ["E1", "E2", "E3", "E4", "E5", "E6"].map((id) => ({ asset: asset(id) })));
    const r = await searchAll("core", { ...NONE, assets: true });
    expect(r.assets.map((a) => a.id)).toEqual(["A-col", "A-dup", "B-src", "C-mac", "D-ip", "E1", "E2", "E3"]);
  });

  it("a hit found by its DISCOVERED name says so in the subtitle", async () => {
    h.findAssetIdsByDiscoveredHostname.mockResolvedValue(new Map([["P1", "old-name"]]));
    stubbed(prisma.asset.findMany).mockImplementation(async (args: any) =>
      args.where?.id?.in?.includes("P1") ? [asset("P1", { hostname: "pinned", ipAddress: "10.0.0.4" })] : []);
    const r = await searchAll("old-name", { ...NONE, assets: true });
    expect(r.assets[0]).toMatchObject({ id: "P1", title: "pinned", subtitle: "discovered: old-name — 10.0.0.4" });
  });

  it("the discovered-hostname lookup runs ONCE for the assets and sites groups together", async () => {
    await searchAll("core");
    expect(h.findAssetIdsByDiscoveredHostname).toHaveBeenCalledTimes(1);
    expect(h.findAssetIdsByDiscoveredHostname).toHaveBeenCalledWith(["core"]);
  });

  it("stamps the active-alert summary in one call, only on hits that have one", async () => {
    stubbed(prisma.asset.findMany).mockImplementation(async (args: any) =>
      args.where?.AND ? [asset("A1"), asset("A2")] : []);
    h.activeAlertSummaryByAsset.mockResolvedValue(new Map([["A2", { severity: "critical", count: 2, unacknowledged: 1 }]]));
    const r = await searchAll("core", { ...NONE, assets: true });
    expect(h.activeAlertSummaryByAsset).toHaveBeenCalledTimes(1);
    expect(h.activeAlertSummaryByAsset).toHaveBeenCalledWith(["A1", "A2"]);
    expect(r.assets[0]!.alert).toBeUndefined();
    expect(r.assets[1]!.alert).toEqual({ severity: "critical", count: 2, unacknowledged: 1 });
  });

  it("no asset or site hits → the alert summary is never asked for", async () => {
    await searchAll("core");
    expect(h.activeAlertSummaryByAsset).not.toHaveBeenCalled();
  });
});

describe("thumbprint pin hits (rule 123)", () => {
  const FP = "SHA256:abcdefghijklmnop";

  it("only searched when pins is explicitly true (the no-argument default is), with the whole query", async () => {
    await searchAll(FP, { blocks: true, subnets: true, reservations: true, assets: true, sites: true });
    expect(h.findAssetsByPinFingerprint).not.toHaveBeenCalled();
    await searchAll(FP);
    expect(h.findAssetsByPinFingerprint).toHaveBeenCalledTimes(1);
    h.findAssetsByPinFingerprint.mockClear();
    await searchAll(`${FP} extra`, { ...NONE, assets: true, pins: true });
    expect(h.findAssetsByPinFingerprint).toHaveBeenCalledWith(`${FP} extra`);
  });

  it("pin hits lead the group, replace a duplicate, load a missing asset, and name the pin", async () => {
    stubbed(prisma.asset.findMany).mockImplementation(async (args: any) => {
      if (args.where?.AND) return [asset("COL"), asset("HOST-1", { ipAddress: "10.0.0.7" })];
      if (args.where?.id?.in) return args.where.id.in.includes("GONE") ? [asset("GONE", { status: "decommissioned" })] : [];
      return [];
    });
    h.findAssetsByPinFingerprint.mockResolvedValue([
      { assetId: "HOST-1", kind: "ssh", host: "10.0.0.7", port: 22, archived: false },
      { assetId: "GONE", kind: "tls", host: "gone.example", port: 443, archived: true },
      { assetId: "NOWHERE", kind: "tls", host: "x", port: 1, archived: false },
    ]);
    const r = await searchAll(FP, { ...NONE, assets: true, pins: true });
    expect(r.assets.map((a) => a.id)).toEqual(["HOST-1", "GONE", "COL"]);
    expect(r.assets[0]!.subtitle).toBe("SSH host key 10.0.0.7:22 — 10.0.0.7");
    expect(r.assets[1]!.subtitle).toBe("TLS certificate gone.example:443 — archived on decommission — workstation");
    expect(r.assets[1]!.context).toMatchObject({ pinMatch: { kind: "tls", host: "gone.example", port: 443, archived: true } });
  });

  it("asset: scope passes the scoped cap to the pin lookup", async () => {
    await searchAll(`a:${FP}`, { ...NONE, assets: true, pins: true });
    expect(h.findAssetsByPinFingerprint).toHaveBeenCalledWith(FP, 200);
  });
});

describe("hit shapes", () => {
  it("block, subnet and reservation hits", async () => {
    stubbed(prisma.ipBlock.findMany).mockResolvedValue([{ id: "b1", name: "HQ", cidr: "10.0.0.0/16", description: "head office" }]);
    stubbed(prisma.subnet.findMany).mockResolvedValue([{ id: "s1", name: "Users", cidr: "10.0.1.0/24", purpose: null }]);
    stubbed(prisma.reservation.findMany).mockResolvedValue([
      { id: "r1", hostname: null, ipAddress: "10.0.1.9", owner: "it", subnet: { id: "s1", cidr: "10.0.1.0/24", name: "Users" } },
      { id: "r2", hostname: null, ipAddress: null, owner: null, subnet: null },
    ]);
    const r = await searchAll("hq");
    expect(r.blocks).toEqual([{ type: "block", id: "b1", title: "HQ", subtitle: "10.0.0.0/16 — head office" }]);
    expect(r.subnets).toEqual([{ type: "subnet", id: "s1", title: "Users", subtitle: "10.0.1.0/24", context: { cidr: "10.0.1.0/24" } }]);
    expect(r.reservations[0]).toMatchObject({ type: "reservation", id: "r1", title: "10.0.1.9", subtitle: "10.0.1.9 — 10.0.1.0/24 — it" });
    expect(r.reservations[1]).toMatchObject({ title: "reservation", subtitle: "" });
    expect(argsOf("ipBlock").take).toBe(8);
  });
});
