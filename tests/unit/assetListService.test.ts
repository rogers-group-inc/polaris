/**
 * tests/unit/assetListService.test.ts — the GET /assets engine (CQ-T010; its
 * HTTP contract is exercised by the assets integration suites): the sort
 * whitelist, favorites-first paging across the boundary between the two
 * buckets, the default page, and the per-row monitoring-method summary (agent
 * owns everything; ICMP only when nothing else polls).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/monitoringService.js", () => ({ resolveMonitorSettings: h.resolve }));
vi.mock("../../src/services/notificationService.js", () => ({ activeAlertSummaryByAsset: async () => new Map() }));
vi.mock("../../src/services/subnetService.js", () => ({ buildIpContexts: async () => new Map() }));
vi.mock("../../src/services/addressConfidenceService.js", () => ({ buildAddressConfidence: async () => new Map() }));
vi.mock("../../src/services/discoveredHostnameService.js", () => ({ getDiscoveredHostnames: async () => new Map(), findAssetIdsByDiscoveredHostname: async () => [] }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { listAssetsPage, AssetListQuerySchema } from "../../src/services/assetListService.js";

const findMany = stubbed(prisma.asset.findMany);
const count = stubbed(prisma.asset.count);
const row = (id: string, over: Record<string, unknown> = {}) => ({ id, monitored: false, associatedIpRows: [], macAddressRows: [], fortinetTopology: null, managementAccess: null, ...over });
const q = (raw: Record<string, unknown>) => AssetListQuerySchema.parse(raw);

beforeEach(() => {
  resetDbStub();
  h.resolve.mockReset();
  findMany.mockResolvedValue([]);
  count.mockResolvedValue(0);
});

describe("ordering and paging", () => {
  it("defaults to 50 rows, newest first", async () => {
    const r = await listAssetsPage(q({}), {}, "op");
    expect(r).toMatchObject({ limit: 50, offset: 0 });
    expect(findMany.mock.calls[0][0]).toMatchObject({ orderBy: { createdAt: "desc" }, skip: 0, take: 50 });
  });

  it("only whitelisted sort keys reach Prisma; _server sorts by location then learnedLocation", async () => {
    await expect(listAssetsPage(q({ sortBy: "passwordHash" }), {}, "op")).rejects.toMatchObject({ httpStatus: 400 });
    await listAssetsPage(q({ sortBy: "_server", sortDir: "desc" }), {}, "op");
    expect(findMany.mock.calls[0][0].orderBy).toEqual([{ location: "desc" }, { learnedLocation: "desc" }]);
  });

  it("favorites-first: a window straddling the boundary takes the favorites' tail then the rest from 0", async () => {
    count.mockResolvedValueOnce(3).mockResolvedValueOnce(10); // favTotal, total
    findMany.mockResolvedValueOnce([row("f3")]).mockResolvedValueOnce([row("n1"), row("n2")]);
    const r = await listAssetsPage(q({ favoriteIds: "f1,f2,f3", offset: 2, limit: 3 }), {}, "op");
    expect(r.total).toBe(10);
    expect((r.enriched as Array<{ id: string }>).map((a) => a.id)).toEqual(["f3", "n1", "n2"]);
    const [fav, rest] = findMany.mock.calls.map((c) => c[0]);
    expect(fav).toMatchObject({ skip: 2, take: 3 });
    expect(fav.where.AND[1]).toEqual({ id: { in: ["f1", "f2", "f3"] } });
    expect(rest).toMatchObject({ skip: 0, take: 2 });
    expect(rest.where.AND[1]).toEqual({ id: { notIn: ["f1", "f2", "f3"] } });
  });

  it("favorites-first: a window wholly past the favorites skips the favorites query", async () => {
    count.mockResolvedValueOnce(2).mockResolvedValueOnce(10);
    findMany.mockResolvedValueOnce([row("n5")]);
    await listAssetsPage(q({ favoriteIds: "f1,f2", offset: 6, limit: 1 }), {}, "op");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 4, take: 1 });
  });
});

describe("monitoring methods per row", () => {
  it("unmonitored is none; an active agent owns everything; ICMP shows only when nothing else polls", async () => {
    findMany.mockResolvedValue([
      row("off"),
      row("agent", { monitored: true, managedAgent: { installStatus: "active" } }),
      row("snmp", { monitored: true }),
      row("ping", { monitored: true }),
    ]);
    h.resolve
      .mockResolvedValueOnce({ responseTimePolling: "icmp", cpuMemoryPolling: "snmp", interfacesPolling: "snmp", temperaturePolling: "disabled" })
      .mockResolvedValueOnce({ responseTimePolling: "icmp", cpuMemoryPolling: "disabled" });
    const r = (await listAssetsPage(q({}), {}, "op")).enriched as Array<{ id: string; monitoringMethods: string[] }>;
    expect(Object.fromEntries(r.map((a) => [a.id, a.monitoringMethods]))).toEqual({
      off: [], agent: ["agent"], snmp: ["snmp"], ping: ["icmp"],
    });
    expect(h.resolve).toHaveBeenCalledTimes(2);
  });
});

describe("Sources filter matches every source, not only the priority winner", () => {
  const queryRaw = stubbed((prisma as unknown as { $queryRaw: (...a: unknown[]) => unknown }).$queryRaw);

  it("contains: the cell's location OR any asset whose sources match", async () => {
    queryRaw.mockResolvedValueOnce([{ assetId: "a1" }, { assetId: "a2" }]);
    await listAssetsPage(q({ server: "OU=Plant" }), { server: "OU=Plant" }, "op");
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const arm = findMany.mock.calls[0][0].where.AND[0];
    expect(arm.OR[1]).toEqual({ id: { in: ["a1", "a2"] } });
    expect(arm.OR[0].OR).toHaveLength(2); // location, learnedLocation
  });

  it("not_contains: excludes the assets any of whose sources match", async () => {
    queryRaw.mockResolvedValueOnce([{ assetId: "a1" }]);
    await listAssetsPage(q({}), { server: "vcenter", serverOp: "not_contains" }, "op");
    const arm = findMany.mock.calls[0][0].where.AND[0];
    expect(arm.AND[1]).toEqual({ id: { notIn: ["a1"] } });
  });

  it("no term, or an empty / is_not_empty op, runs no source lookup", async () => {
    await listAssetsPage(q({}), { serverOp: "empty" }, "op");
    await listAssetsPage(q({}), { server: "  " }, "op");
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe("Monitored Via filter", () => {
  it("no monitoredVia param resolves nothing up front", async () => {
    await listAssetsPage(q({}), {}, "op");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({});
  });

  it("matches the column's own summary: any chosen method, a 'Multiple' row on each of its methods, monitored only", async () => {
    findMany.mockResolvedValueOnce([
      row("agent", { monitored: true, managedAgent: { installStatus: "active" } }),
      row("multi", { monitored: true }),
      row("ping", { monitored: true }),
      row("winrm", { monitored: true }),
    ]);
    h.resolve
      .mockResolvedValueOnce({ responseTimePolling: "icmp", cpuMemoryPolling: "snmp", interfacesPolling: "ssh" })
      .mockResolvedValueOnce({ responseTimePolling: "icmp" })
      .mockResolvedValueOnce({ responseTimePolling: "icmp", cpuMemoryPolling: "winrm" });
    await listAssetsPage(q({ monitoredVia: "SSH,agent,icmp" }), {}, "op");
    const [pre, page] = findMany.mock.calls.map((c) => c[0]);
    expect(pre.where).toEqual({ monitored: true });
    expect(page.where.AND).toContainEqual({ id: { in: ["agent", "multi", "ping"] } });
  });
});

describe("Sources column (rule 198)", () => {
  it("ships each row's sources in Sources-tab order, one per integration, kind + integration name only", async () => {
    findMany.mockResolvedValue([row("a1", {
      sources: [
        { sourceKind: "fortigate-endpoint", integrationId: "i1", lastSeen: new Date("2026-01-01"), integration: { name: "FMG" } },
        { sourceKind: "fortigate-endpoint", integrationId: "i1", lastSeen: new Date("2026-02-01"), integration: { name: "FMG" } },
        { sourceKind: "ad", integrationId: "i2", lastSeen: new Date("2026-01-01"), integration: { name: "Corp AD" } },
        { sourceKind: "manual", integrationId: null, lastSeen: new Date("2026-01-01"), integration: null },
      ],
    })]);
    count.mockResolvedValue(1);
    const r = await listAssetsPage(q({}), {}, "op");
    expect((r.enriched[0] as { sources: unknown }).sources).toEqual([
      { sourceKind: "ad", integrationName: "Corp AD" },
      { sourceKind: "fortigate-endpoint", integrationName: "FMG" },
      { sourceKind: "manual", integrationName: null },
    ]);
  });

  it("selects the source rows in the Sources tab's tie-break order", async () => {
    await listAssetsPage(q({}), {}, "op");
    expect(findMany.mock.calls[0][0].select.sources).toMatchObject({
      orderBy: [{ sourceKind: "asc" }, { lastSeen: "desc" }],
    });
  });

  it("a row with no source rows ships an empty list", async () => {
    findMany.mockResolvedValue([row("a1")]);
    count.mockResolvedValue(1);
    const r = await listAssetsPage(q({}), {}, "op");
    expect((r.enriched[0] as { sources: unknown }).sources).toEqual([]);
  });
});

describe("Sources filter (rule 198)", () => {
  const whereOf = () => findMany.mock.calls[0][0].where as { AND?: unknown[] };

  it("one kind → a relation `some` on that kind", async () => {
    await listAssetsPage(q({ sources: "ad" }), {}, "op");
    expect(whereOf().AND).toContainEqual({ sources: { some: { sourceKind: "ad" } } });
  });

  it("several kinds → any-of", async () => {
    await listAssetsPage(q({ sources: "ad,intune" }), {}, "op");
    expect(whereOf().AND).toContainEqual({ sources: { some: { sourceKind: { in: ["ad", "intune"] } } } });
  });

  it("`none` alone → assets with no source row", async () => {
    await listAssetsPage(q({ sources: "none" }), {}, "op");
    expect(whereOf().AND).toContainEqual({ sources: { none: {} } });
  });

  it("kinds plus `none` → either", async () => {
    await listAssetsPage(q({ sources: "manual,none" }), {}, "op");
    expect(whereOf().AND).toContainEqual({ OR: [{ sources: { some: { sourceKind: "manual" } } }, { sources: { none: {} } }] });
  });

  it("no param → no sources clause", async () => {
    await listAssetsPage(q({}), {}, "op");
    expect(JSON.stringify(findMany.mock.calls[0][0].where)).not.toContain("sourceKind");
  });
});
