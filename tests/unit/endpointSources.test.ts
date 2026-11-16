/**
 * tests/unit/endpointSources.test.ts — the own suite for
 * src/services/discovery/dhcp/endpointSources.ts (syncDhcpSubnets Phases 10
 * and 11, CQ-T010).
 *
 * Phase 10: the gate each fortigate-endpoint row names (rule 101(b): the IPAM
 * gate, an overlap settled by the pathway / prior gate, else the pathway, else
 * the prior one, bare-named), the prior row handed to the upsert (keyed by the
 * normalized MAC), the lastSeen-only bulk refresh, the one manual-placeholder
 * sweep, and failure isolation for every step.
 *
 * Phase 11: the one bulk source read, the per-asset projection, which fields
 * are written (non-null and different only), the ipSource re-tag, the IP
 * override release, the primary-address pin (rule 102), the acquiredAt clamp
 * (rule 9), the os / osVersion change baseline, and the count / log lines.
 *
 * The projection is stubbed; endpointGate, assetSourceLocation, the invariant
 * clamp and the concurrency helper run for real.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const m = vi.hoisted(() => ({ project: vi.fn() }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/utils/assetProjection.js", () => ({ projectAssetFromSources: m.project }));

const { stampEndpointSources, applyEndpointProjection } = await import("../../src/services/discovery/dhcp/endpointSources.js");

const db = {
  sourceFindMany: stubbed(prisma.assetSource.findMany),
  sourceDeleteMany: stubbed(prisma.assetSource.deleteMany),
  raw: stubbed((prisma as any).$executeRawUnsafe),
  assetUpdate: stubbed(prisma.asset.update),
};

const NOW = "2026-11-14T08:00:00.000Z";

beforeEach(() => {
  resetDbStub();
  m.project.mockReset();
  db.sourceFindMany.mockResolvedValue([]);
  db.sourceDeleteMany.mockResolvedValue({ count: 0 });
  db.raw.mockResolvedValue(1);
  db.assetUpdate.mockResolvedValue({});
});

type Row = Record<string, any>;
function index(rows: Row[]) {
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  return { findById: (id: string) => byId.get(id) };
}

// ─── Phase 10 ────────────────────────────────────────────────────────────────

describe("stampEndpointSources (Phase 10)", () => {
  const SUBNETS = [
    { cidr: "10.1.0.0/24", status: "active", fortigateDevice: "FGT-NET" },
    { cidr: "10.9.0.0/24", status: "active", fortigateDevice: "FGT-X" },
    { cidr: "10.9.0.0/24", status: "active", fortigateDevice: "FGT-Y" },
    { cidr: "10.7.0.0/24", status: "deprecated", fortigateDevice: "FGT-OLD" },
  ];
  function run(assets: Row[], over: Record<string, unknown> = {}) {
    const upsert = vi.fn(async (..._a: any[]): Promise<unknown> => "written");
    const state = {
      fortigateEndpointAssetIds: new Set(assets.map((a) => a.id as string)),
      fortigateEndpointDeviceByAsset: new Map<string, string>(),
      allSubnets: SUBNETS,
      assetIdx: index(assets) as never,
      integrationId: "i1", integrationName: "HQ FMG", integrationType: "fortimanager", now: NOW,
      upsertFortigateEndpointSource: upsert,
      syncLog: vi.fn(),
      ...over,
    };
    return { state, upsert };
  }
  const ep = (id: string, ip: string | null, mac: string | null = `AA:AA:AA:AA:AA:${id.slice(-2).padStart(2, "0")}`) =>
    ({ id, macAddress: mac, ipAddress: ip, lastSeen: null });
  const gateOf = (upsert: ReturnType<typeof run>["upsert"], id: string) => upsert.mock.calls.find((c) => c[0] === id)?.[6];

  it("does nothing for a run that touched no endpoint", async () => {
    const { state, upsert } = run([]);
    expect(await stampEndpointSources(state)).toBe(0);
    expect(db.sourceFindMany).not.toHaveBeenCalled();
    expect(db.sourceDeleteMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(state.syncLog).not.toHaveBeenCalled();
  });

  it("preloads the prior rows of exactly the touched endpoints", async () => {
    const { state } = run([ep("e01", "10.1.0.5"), ep("e02", "10.1.0.6")]);
    await stampEndpointSources(state);
    expect(db.sourceFindMany).toHaveBeenCalledWith({
      where: { sourceKind: "fortigate-endpoint", assetId: { in: ["e01", "e02"] } },
      select: { assetId: true, externalId: true, integrationId: true, observed: true, lastSeen: true },
    });
  });

  it("names the gate whose network holds the address, ignoring a deprecated network (rule 101(b))", async () => {
    const { state, upsert } = run([ep("e01", "10.1.0.5"), ep("e02", "10.7.0.5")]);
    state.fortigateEndpointDeviceByAsset.set("e01", "FGT-PATH");
    await stampEndpointSources(state);
    expect(gateOf(upsert, "e01")).toBe("FGT-NET");
    expect(gateOf(upsert, "e02")).toBeNull();
    expect(upsert).toHaveBeenCalledWith("e01", "i1", expect.objectContaining({ id: "e01" }), "fortimanager", new Date(NOW), "HQ FMG", "FGT-NET", undefined);
  });

  it("settles an overlap with the pathway's gate, then the prior gate; an unsettled overlap falls to the pathway", async () => {
    db.sourceFindMany.mockResolvedValue([{ assetId: "e02", externalId: "X", integrationId: "i1", observed: { learnedLocation: "FGT-Y" }, lastSeen: new Date(NOW) }]);
    const { state, upsert } = run([ep("e01", "10.9.0.5"), ep("e02", "10.9.0.6"), ep("e03", "10.9.0.7")]);
    state.fortigateEndpointDeviceByAsset.set("e01", "FGT-Y");
    state.fortigateEndpointDeviceByAsset.set("e03", "FGT-ELSEWHERE");
    await stampEndpointSources(state);
    expect(gateOf(upsert, "e01")).toBe("FGT-Y");
    expect(gateOf(upsert, "e02")).toBe("FGT-Y");
    expect(gateOf(upsert, "e03")).toBe("FGT-ELSEWHERE");
  });

  it("outside IPAM: the pathway's gate, then the prior gate (bare-named and trimmed), then null", async () => {
    db.sourceFindMany.mockResolvedValue([
      { assetId: "e02", externalId: "a", integrationId: "i1", observed: { learnedLocation: "  HQ FMG:FGT-PRIOR " }, lastSeen: new Date(NOW) },
      { assetId: "e03", externalId: "b", integrationId: "i1", observed: { learnedLocation: "   " }, lastSeen: new Date(NOW) },
      { assetId: "e04", externalId: "c", integrationId: "i1", observed: null, lastSeen: new Date(NOW) },
    ]);
    const { state, upsert } = run([ep("e01", "192.0.2.1"), ep("e02", "192.0.2.2"), ep("e03", null), ep("e04", "2001:db8::4")]);
    state.fortigateEndpointDeviceByAsset.set("e01", "FGT-PATH");
    await stampEndpointSources(state);
    expect(gateOf(upsert, "e01")).toBe("FGT-PATH");
    expect(gateOf(upsert, "e02")).toBe("FGT-PRIOR");
    expect(gateOf(upsert, "e03")).toBeNull();
    expect(gateOf(upsert, "e04")).toBeNull();
  });

  it("hands each upsert its prior row by normalized MAC, and the asset's own lastSeen when it has one", async () => {
    const prior = { assetId: "e01", externalId: "AA:BB:CC:DD:EE:01", integrationId: "i1", observed: { x: 1 }, lastSeen: new Date("2026-11-01T00:00:00Z") };
    db.sourceFindMany.mockResolvedValue([prior]);
    const seen = new Date("2026-11-13T00:00:00Z");
    const { state, upsert } = run([{ id: "e01", macAddress: " aa:bb:cc:dd:ee:01 ", ipAddress: null, lastSeen: seen }]);
    await stampEndpointSources(state);
    expect(upsert.mock.calls[0][4]).toEqual(seen);
    expect(upsert.mock.calls[0][7]).toEqual({ assetId: "e01", integrationId: "i1", observed: { x: 1 }, lastSeen: prior.lastSeen });
  });

  it("skips an endpoint missing from the index or with no MAC, and one the upsert declined", async () => {
    const { state, upsert } = run([ep("e01", "10.1.0.5", null), ep("e02", "10.1.0.6"), ep("e03", "10.1.0.7")]);
    state.fortigateEndpointAssetIds.add("ghost");
    upsert.mockImplementation(async (id: string) => (id === "e03" ? null : "unchanged"));
    expect(await stampEndpointSources(state)).toBe(1);
    expect(upsert.mock.calls.map((c) => c[0])).toEqual(["e02", "e03"]);
    expect(db.sourceDeleteMany).toHaveBeenCalledTimes(1);
    expect(db.sourceDeleteMany).toHaveBeenCalledWith({ where: { assetId: { in: ["e02"] }, sourceKind: "manual" } });
    expect(db.raw).not.toHaveBeenCalled();
    expect(state.syncLog).not.toHaveBeenCalled();
  });

  it("refreshes lastSeen-only rows in ONE parameterized statement keyed by the upper-cased MAC", async () => {
    const t1 = new Date("2026-11-14T07:00:00.000Z");
    const t2 = new Date("2026-11-14T07:30:00.000Z");
    const { state, upsert } = run([ep("e01", "10.1.0.5", "aa:aa:aa:aa:aa:01"), ep("e02", "10.1.0.6", "AA:AA:AA:AA:AA:02"), ep("e03", "10.1.0.7")]);
    upsert.mockImplementation(async (id: string) => (id === "e01" ? t1 : id === "e02" ? t2 : "written"));
    expect(await stampEndpointSources(state)).toBe(3);
    expect(db.raw).toHaveBeenCalledTimes(1);
    const [sql, ...params] = db.raw.mock.calls[0];
    expect(sql).toContain('UPDATE "asset_sources" s SET "lastSeen" = v.ls, "syncedAt" = $1::timestamp');
    expect(sql).toContain("($2::text, $3::timestamp), ($4::text, $5::timestamp)");
    expect(sql).toContain(`s."sourceKind" = 'fortigate-endpoint' AND s."externalId" = v.ext`);
    expect(params.slice(1)).toEqual(["AA:AA:AA:AA:AA:01", t1.toISOString(), "AA:AA:AA:AA:AA:02", t2.toISOString()]);
    expect(Number.isNaN(Date.parse(params[0]))).toBe(false);
    expect([...db.sourceDeleteMany.mock.calls[0][0].where.assetId.in].sort()).toEqual(["e01", "e02", "e03"]);
  });

  it("a failed prior preload is logged and the flush still stamps, with no prior row", async () => {
    db.sourceFindMany.mockRejectedValue(new Error("timeout"));
    const { state, upsert } = run([ep("e01", "10.1.0.5")]);
    expect(await stampEndpointSources(state)).toBe(1);
    expect(state.syncLog).toHaveBeenCalledWith("error", "fortigate-endpoint AssetSource: prior-gate preload failed (timeout)");
    expect(upsert.mock.calls[0][7]).toBeUndefined();
  });

  it("a failed lastSeen refresh and a failed manual sweep never throw", async () => {
    db.raw.mockRejectedValue(new Error("deadlock"));
    db.sourceDeleteMany.mockRejectedValue(new Error("locked"));
    const { state, upsert } = run([ep("e01", "10.1.0.5")]);
    upsert.mockResolvedValue(new Date(NOW));
    expect(await stampEndpointSources(state)).toBe(1);
    expect(state.syncLog).toHaveBeenCalledWith("error", "fortigate-endpoint AssetSource: lastSeen refresh failed (deadlock)");
    expect(state.syncLog).toHaveBeenCalledTimes(1);
  });

  it("counts a rejected upsert as failed and keeps the others", async () => {
    const { state, upsert } = run([ep("e01", "10.1.0.5"), ep("e02", "10.1.0.6"), ep("e03", "10.1.0.7")]);
    upsert.mockImplementation(async (id: string) => { if (id !== "e02") throw new Error("boom"); return "written"; });
    expect(await stampEndpointSources(state)).toBe(1);
    expect(state.syncLog).toHaveBeenCalledWith("error", "fortigate-endpoint AssetSource: stamped 1, 2 failed");
    expect(db.sourceDeleteMany).toHaveBeenCalledWith({ where: { assetId: { in: ["e02"] }, sourceKind: "manual" } });
  });
});

// ─── Phase 11 ────────────────────────────────────────────────────────────────

describe("applyEndpointProjection (Phase 11)", () => {
  const NOTHING = { hostname: null, os: null, osVersion: null, manufacturer: null, model: null, learnedLocation: null, ipAddress: null, serialNumber: null };
  const projected = (p: Record<string, unknown>) => ({ projected: { ...NOTHING, ...p } });
  function run(assets: Row[], over: Record<string, unknown> = {}) {
    return {
      fortigateEndpointAssetIds: new Set(assets.map((a) => a.id as string)),
      assetIdx: index(assets) as never,
      integrationType: "fortigate",
      noteChangeBaseline: vi.fn(),
      syncLog: vi.fn(),
      ...over,
    };
  }

  it("does nothing for a run that touched no endpoint", async () => {
    const state = run([]);
    expect(await applyEndpointProjection(state)).toBe(0);
    expect(db.sourceFindMany).not.toHaveBeenCalled();
    expect(m.project).not.toHaveBeenCalled();
  });

  it("reads every touched asset's sources in one query and projects each asset from its own rows", async () => {
    const seen = new Date("2026-11-14T07:00:00Z");
    db.sourceFindMany.mockResolvedValue([
      { assetId: "e1", sourceKind: "fortigate-endpoint", inferred: false, observed: { hostname: "pc-1" }, lastSeen: seen },
      { assetId: "e2", sourceKind: "intune", inferred: true, observed: null, lastSeen: null },
      { assetId: "e1", sourceKind: "intune", inferred: false, observed: {}, lastSeen: null },
    ]);
    m.project.mockReturnValue(projected({}));
    await applyEndpointProjection(run([{ id: "e1" }, { id: "e2" }, { id: "e3" }]));
    expect(db.sourceFindMany).toHaveBeenCalledTimes(1);
    expect(db.sourceFindMany).toHaveBeenCalledWith({
      where: { assetId: { in: ["e1", "e2", "e3"] } },
      select: { assetId: true, sourceKind: true, inferred: true, observed: true, lastSeen: true },
    });
    expect(m.project.mock.calls.map((c) => c[0])).toEqual([
      [
        { sourceKind: "fortigate-endpoint", inferred: false, observed: { hostname: "pc-1" }, lastSeen: seen },
        { sourceKind: "intune", inferred: false, observed: {}, lastSeen: null },
      ],
      [{ sourceKind: "intune", inferred: true, observed: null, lastSeen: null }],
      [],
    ]);
  });

  it("writes every string field the projection disagrees with, and only those, then mirrors them in memory", async () => {
    const asset: Row = {
      id: "e1", hostname: "old", os: "Windows", osVersion: "10", manufacturer: "Dell", model: "Latitude", learnedLocation: "FGT-A",
      ipAddress: "10.1.0.5", serialNumber: "SN1",
    };
    m.project.mockReturnValue(projected({
      hostname: "new", os: "Windows", osVersion: "11", manufacturer: null, model: "Precision", learnedLocation: "FGT-B", serialNumber: "SN2",
    }));
    const state = run([asset]);
    expect(await applyEndpointProjection(state)).toBe(1);
    expect(db.assetUpdate).toHaveBeenCalledWith({
      where: { id: "e1" },
      data: { hostname: "new", osVersion: "11", model: "Precision", learnedLocation: "FGT-B", serialNumber: "SN2" },
    });
    expect(asset).toMatchObject({ hostname: "new", os: "Windows", osVersion: "11", manufacturer: "Dell", serialNumber: "SN2" });
    expect(state.noteChangeBaseline).toHaveBeenCalledWith(asset, ["osVersion"]);
    expect(state.syncLog).toHaveBeenCalledWith("info", "fortigate-endpoint projection apply: corrected 1 of 1 touched assets");
  });

  it("baselines os and osVersion together, before the in-memory assign", async () => {
    const asset: Row = { id: "e1", os: "Linux", osVersion: "5" };
    m.project.mockReturnValue(projected({ os: "Windows", osVersion: "11" }));
    const state = run([asset]);
    state.noteChangeBaseline.mockImplementation((a: Row) => expect(a.os).toBe("Linux"));
    await applyEndpointProjection(state);
    expect(state.noteChangeBaseline).toHaveBeenCalledWith(asset, ["os", "osVersion"]);
  });

  it("an address correction re-tags ipSource with the integration type", async () => {
    m.project.mockReturnValue(projected({ ipAddress: "2001:db8::9" }));
    const state = run([{ id: "e1", ipAddress: "10.1.0.5" }]);
    await applyEndpointProjection(state);
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "e1" }, data: { ipAddress: "2001:db8::9", ipSource: "fortigate:fortigate-endpoint" } });
    expect(state.noteChangeBaseline).not.toHaveBeenCalled();
  });

  it("stages an IP override the projection agrees with, so the pin can release; one it disagrees with is a plain correction", async () => {
    m.project.mockReturnValueOnce(projected({ ipAddress: "10.1.0.6" })).mockReturnValueOnce(projected({ ipAddress: "10.1.0.8" }));
    await applyEndpointProjection(run([
      { id: "agree", ipAddress: "10.1.0.6", ipOverride: "10.1.0.6" },
      { id: "differ", ipAddress: "10.1.0.6", ipOverride: "10.1.0.6" },
    ]));
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "agree" }, data: { ipAddress: "10.1.0.6", ipSource: "fortigate:fortigate-endpoint" } });
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "differ" }, data: { ipAddress: "10.1.0.8", ipSource: "fortigate:fortigate-endpoint" } });
  });

  it("a primary-address pin keeps its address — even an agreeing override is not staged — but other fields still land (rule 102)", async () => {
    m.project.mockReturnValueOnce(projected({ ipAddress: "10.1.0.99" })).mockReturnValueOnce(projected({ ipAddress: "10.1.0.7", hostname: "pc-new" }));
    const state = run([
      { id: "pinned", ipAddress: "10.1.0.6", primaryAddressIp: "10.1.0.6" },
      { id: "both", ipAddress: "10.1.0.6", ipOverride: "10.1.0.7", primaryAddressIp: "10.1.0.6", hostname: "pc" },
    ]);
    expect(await applyEndpointProjection(state)).toBe(1);
    expect(db.assetUpdate).toHaveBeenCalledTimes(1);
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "both" }, data: { hostname: "pc-new" } });
  });

  it("clamps acquiredAt down to lastSeen on the write (rule 9)", async () => {
    const lastSeen = new Date("2026-11-01T00:00:00Z");
    m.project.mockReturnValue(projected({ hostname: "pc-new" }));
    await applyEndpointProjection(run([{ id: "e1", hostname: "pc", acquiredAt: new Date("2026-11-10T00:00:00Z"), lastSeen }]));
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "e1" }, data: { hostname: "pc-new", acquiredAt: lastSeen } });
  });

  it("skips an asset missing from the index, and a quiet sync writes and logs nothing", async () => {
    m.project.mockReturnValue(projected({ hostname: "pc" }));
    const state = run([{ id: "e1", hostname: "pc" }]);
    state.fortigateEndpointAssetIds.add("ghost");
    expect(await applyEndpointProjection(state)).toBe(0);
    expect(m.project).toHaveBeenCalledTimes(1);
    expect(db.assetUpdate).not.toHaveBeenCalled();
    expect(state.syncLog).not.toHaveBeenCalled();
  });

  it("a failed write is counted and logged; the asset in memory is left as it was", async () => {
    const bad: Row = { id: "bad", hostname: "a" };
    m.project.mockReturnValue(projected({ hostname: "b" }));
    db.assetUpdate.mockImplementation(async ({ where }: any) => { if (where.id === "bad") throw new Error("locked"); return {}; });
    const state = run([bad, { id: "good", hostname: "a" }]);
    expect(await applyEndpointProjection(state)).toBe(1);
    expect(state.syncLog).toHaveBeenCalledWith("error", "fortigate-endpoint projection apply: corrected 1, 1 failed");
    expect(bad.hostname).toBe("a");
  });

  it("a failed bulk source read is logged and the pass skipped, like Phase 10's preload", async () => {
    db.sourceFindMany.mockRejectedValue(new Error("db gone"));
    const state = run([{ id: "e1" }]);
    // Was a bug until 2026-11-16: the failure propagated out of the phase.
    expect(await applyEndpointProjection(state)).toBe(0);
    expect(state.syncLog).toHaveBeenCalledWith("error", "fortigate-endpoint projection apply: AssetSource preload failed (db gone)");
  });
});
