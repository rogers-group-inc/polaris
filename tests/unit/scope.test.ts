/**
 * tests/unit/scope.test.ts — src/services/notifications/scope.ts (CQ-T010).
 *
 * The scope → assets loader and the per-asset / per-dimension gates every
 * automation trigger path shares. Complements, rather than repeats:
 *   - notificationMonitoredGate.test.ts   (assetCanTrigger's monitored half through the engine)
 *   - notificationMaintenanceSuppression.test.ts (rule 16 freeze through the engine)
 *   - notificationDeviceDownHandoff.test.ts (rule 29(i) handoff through the engine)
 *   - notificationProbeLossGate.test.ts   (rule 29 answering gate through the engine)
 *   - assetTagTrigger / fcPortCounters / streamFailingField (incidental imports)
 * Here each exported function is pinned directly: the scopeWhere shape
 * (empty scope ⇒ nothing, monitored gate never makes an empty scope select),
 * subnet + condition narrowing, the per-tick memo, the region-snapshot dedupe,
 * rule 78's maintenance-owed set, rule 16's freshness boundary, and the pin
 * gates of rule 57 including the PoE-fault carve-out.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

const h = vi.hoisted(() => ({
  resolveDependencyBlame: vi.fn(),
  decorateRelationLeafHits: vi.fn(async () => undefined),
}));
vi.mock("../../src/services/dependencyTreeService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveDependencyBlame: h.resolveDependencyBlame,
}));
vi.mock("../../src/services/scopeRelationIndex.js", () => ({ decorateRelationLeafHits: h.decorateRelationLeafHits }));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import type { Trigger } from "../../src/services/notificationTypes.js";
import type { ScopeAssetRow } from "../../src/services/notifications/ruleModel.js";
import {
  assetCanTrigger,
  isSuppressedForNotifications,
  clearScopeAssetCache,
  loadScopeAssets,
  loadScopeAssetIds,
  loadScopeRegionSnapshots,
  suppressionOwedToMaintenance,
  frozenReadingIsFresh,
  frozenFreshnessFor,
  assetIsAnsweringProbes,
  triggerNeedsAnsweringDevice,
  triggerHandsOffWhenDeviceDown,
  assetIsDown,
  interfaceIsPinned,
  poeFaultCoversUnpinned,
  interfaceDimLabel,
  tunnelIsPinned,
  storageIsPinned,
  pinTestForTrigger,
  regionSnapshot,
} from "../../src/services/notifications/scope.js";

const T = (t: Record<string, unknown>): Trigger => t as unknown as Trigger;
const row = (o: Partial<ScopeAssetRow> & { id: string }): ScopeAssetRow =>
  ({ status: "active", dependencySuppressed: false, tags: [], ...o }) as unknown as ScopeAssetRow;

beforeEach(() => {
  resetDbStub();
  h.resolveDependencyBlame.mockReset();
  h.decorateRelationLeafHits.mockReset();
  h.decorateRelationLeafHits.mockImplementation(async () => undefined);
  clearScopeAssetCache(false);
});

describe("assetCanTrigger / isSuppressedForNotifications", () => {
  it("passes a monitored, active, unsuppressed asset", () => {
    expect(assetCanTrigger({ monitored: true, status: "active", dependencySuppressed: false })).toBe(true);
  });
  it("refuses monitored === false", () => {
    expect(assetCanTrigger({ monitored: false, status: "active", dependencySuppressed: false })).toBe(false);
  });
  it("lets an absent monitored flag through (host pseudo-asset)", () => {
    expect(assetCanTrigger({ status: "active", dependencySuppressed: false })).toBe(true);
  });
  it("refuses maintenance and dependency-suppressed (rule 16)", () => {
    expect(assetCanTrigger({ monitored: true, status: "maintenance", dependencySuppressed: false })).toBe(false);
    expect(assetCanTrigger({ monitored: true, status: "active", dependencySuppressed: true })).toBe(false);
  });
  it("isSuppressedForNotifications is maintenance OR dependencySuppressed only", () => {
    expect(isSuppressedForNotifications({ status: "maintenance", dependencySuppressed: false })).toBe(true);
    expect(isSuppressedForNotifications({ status: "active", dependencySuppressed: true })).toBe(true);
    expect(isSuppressedForNotifications({ status: "decommissioned", dependencySuppressed: false })).toBe(false);
  });
});

describe("loadScopeAssets", () => {
  it("an empty, non-allAssets scope matches nothing and does not query", async () => {
    expect(await loadScopeAssets({})).toEqual([]);
    expect(await loadScopeAssets({}, { monitoredOnly: true })).toEqual([]);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });

  it("allAssets queries with an empty where, or the monitored gate when asked", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([] as never);
    await loadScopeAssets({ allAssets: true });
    expect(vi.mocked(prisma.asset.findMany).mock.calls[0][0]!.where).toEqual({});
    await loadScopeAssets({ allAssets: true }, { monitoredOnly: true });
    expect(vi.mocked(prisma.asset.findMany).mock.calls[1][0]!.where).toEqual({ monitored: true });
  });

  it("ANDs every dimension and appends the monitored gate last", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([] as never);
    await loadScopeAssets(
      { assetTypes: ["switch"], tags: ["core"], assetIds: ["a1"], integrationIds: ["i1"], manufacturers: ["Cisco"], models: ["9300"] },
      { monitoredOnly: true },
    );
    const where = vi.mocked(prisma.asset.findMany).mock.calls[0][0]!.where as { AND: unknown[] };
    expect(where.AND).toEqual([
      { assetType: { in: ["switch"] } },
      { tags: { hasSome: ["core"] } },
      { id: { in: ["a1"] } },
      { discoveredByIntegrationId: { in: ["i1"] } },
      { OR: [{ manufacturer: { contains: "Cisco", mode: "insensitive" } }] },
      { OR: [{ model: { contains: "9300", mode: "insensitive" } }] },
      { monitored: true },
    ]);
  });

  it("selects the monitored flag and the rule-118 stream timestamps", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([] as never);
    await loadScopeAssets({ allAssets: true });
    const select = vi.mocked(prisma.asset.findMany).mock.calls[0][0]!.select as Record<string, boolean>;
    for (const k of ["monitored", "telemetryFailingSince", "systemInfoFailingSince", "monitoredStorage", "fortilinkStatus"]) {
      expect(select[k]).toBe(true);
    }
  });

  it("subnetCidrs narrows in memory, with bare IPs as /32 and bad IPs dropped", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([
      row({ id: "in", ipAddress: "10.1.2.3" }),
      row({ id: "exact", ipAddress: "192.168.0.9" }),
      row({ id: "out", ipAddress: "10.9.0.1" }),
      row({ id: "none", ipAddress: null }),
      row({ id: "garbage", ipAddress: "not-an-ip" }),
    ] as never);
    const ids = await loadScopeAssetIds({ subnetCidrs: ["10.1.0.0/16", "192.168.0.9"] });
    expect(ids).toEqual(["in", "exact"]);
    const where = vi.mocked(prisma.asset.findMany).mock.calls[0][0]!.where as { AND: unknown[] };
    expect(where.AND).toEqual([{ ipAddress: { not: null } }]);
  });

  it("a condition-only scope loads, decorates, then filters in memory", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([
      row({ id: "a", assetType: "switch" }),
      row({ id: "b", assetType: "server" }),
    ] as never);
    const condition = { op: "and", children: [{ field: "assetType", operator: "equals", value: "switch" }] };
    const ids = await loadScopeAssetIds({ condition } as never);
    expect(ids).toEqual(["a"]);
    expect(h.decorateRelationLeafHits).toHaveBeenCalledTimes(1);
  });

  it("memoises per scope only while a pass owns the cache", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([row({ id: "a" })] as never);
    await loadScopeAssets({ allAssets: true });
    await loadScopeAssets({ allAssets: true });
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(2);

    clearScopeAssetCache(true);
    const first = await loadScopeAssets({ allAssets: true });
    const second = await loadScopeAssets({ allAssets: true });
    expect(second).toBe(first);
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(3);
    // The monitored gate is part of the key.
    await loadScopeAssets({ allAssets: true }, { monitoredOnly: true });
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(4);
    // Clearing empties the memo.
    clearScopeAssetCache(true);
    await loadScopeAssets({ allAssets: true });
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(5);
  });
});

describe("loadScopeRegionSnapshots", () => {
  it("reads monitored devices only and dedupes case-/order-blind", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([
      row({ id: "a", tags: ["region:East", "region:HQ", "core"] }),
      row({ id: "b", tags: ["region:hq", "region:east"] }),
      row({ id: "c", tags: ["core"] }),
      row({ id: "d", tags: ["Region:West"] }),
    ] as never);
    const snaps = await loadScopeRegionSnapshots({ allAssets: true });
    expect(snaps).toEqual([["East", "HQ"], ["West"]]);
    expect(vi.mocked(prisma.asset.findMany).mock.calls[0][0]!.where).toEqual({ monitored: true });
  });
});

describe("suppressionOwedToMaintenance (rule 78)", () => {
  it("no suppressed candidate ⇒ no blame walk", async () => {
    const out = await suppressionOwedToMaintenance([row({ id: "a" }), row({ id: "m", status: "maintenance", dependencySuppressed: true } as never)]);
    expect(out.size).toBe(0);
    expect(h.resolveDependencyBlame).not.toHaveBeenCalled();
  });

  it("claims only assets whose blame chain runs through maintenance; a failed walk claims nothing", async () => {
    h.resolveDependencyBlame.mockImplementation(async (id: string) => {
      if (id === "m") return { chain: [{ reason: "down" }, { reason: "maintenance" }] };
      if (id === "d") return { chain: [{ reason: "down" }] };
      return null;
    });
    const out = await suppressionOwedToMaintenance([
      row({ id: "m", dependencySuppressed: true }),
      row({ id: "d", dependencySuppressed: true }),
      row({ id: "x", dependencySuppressed: true }),
      row({ id: "free" }),
    ]);
    expect([...out]).toEqual(["m"]);
    expect(h.resolveDependencyBlame).toHaveBeenCalledTimes(3);
  });
});

describe("frozenReadingIsFresh / frozenFreshnessFor (rule 16)", () => {
  const start = new Date("2026-03-01T10:00:00Z");
  it("no reading never counts", () => {
    expect(frozenReadingIsFresh(null, false, start)).toBe(false);
    expect(frozenReadingIsFresh(undefined, true, start)).toBe(false);
  });
  it("dependency-suppressed only: any reading is current", () => {
    expect(frozenReadingIsFresh(new Date(0), false, null)).toBe(true);
  });
  it("in maintenance: strictly after the window start, and never without one", () => {
    expect(frozenReadingIsFresh(new Date(start.getTime() + 1), true, start)).toBe(true);
    expect(frozenReadingIsFresh(start, true, start)).toBe(false);
    expect(frozenReadingIsFresh(new Date(start.getTime() - 1), true, start)).toBe(false);
    expect(frozenReadingIsFresh(new Date(start.getTime() + 1), true, null)).toBe(false);
  });

  it("frozenFreshnessFor queries open windows for in-maintenance ids only and uses the EARLIEST start", async () => {
    const early = new Date("2026-03-01T08:00:00Z");
    vi.mocked(prisma.assetMaintenanceWindow.findMany).mockResolvedValue([
      { assetId: "m", startedAt: start },
      { assetId: "m", startedAt: early },
    ] as never);
    const fresh = await frozenFreshnessFor([{ id: "m", status: "maintenance" }, { id: "s", status: "active" }]);
    const arg = vi.mocked(prisma.assetMaintenanceWindow.findMany).mock.calls[0][0]!;
    expect(arg.where).toEqual({ assetId: { in: ["m"] }, endedAt: null });
    expect(fresh("m", new Date("2026-03-01T09:00:00Z"))).toBe(true);
    expect(fresh("m", new Date("2026-03-01T07:00:00Z"))).toBe(false);
    expect(fresh("s", new Date(0))).toBe(true);
  });

  it("frozenFreshnessFor makes no query when nothing is in maintenance", async () => {
    const fresh = await frozenFreshnessFor([{ id: "s", status: "active" }]);
    expect(prisma.assetMaintenanceWindow.findMany).not.toHaveBeenCalled();
    expect(fresh("s", null)).toBe(false);
  });
});

describe("answering / down gates (rule 29)", () => {
  it.each([
    ["up", true], ["warning", true], ["down", false], ["recovering", false],
    ["unknown", false], ["passive", false], [null, false],
  ] as const)("assetIsAnsweringProbes(%s) = %s", (s, want) => {
    expect(assetIsAnsweringProbes({ monitorStatus: s })).toBe(want);
  });
  it("assetIsDown is `down` alone", () => {
    expect(assetIsDown({ monitorStatus: "down" })).toBe(true);
    expect(assetIsDown({ monitorStatus: "passive" })).toBe(false);
    expect(assetIsDown({ monitorStatus: null })).toBe(false);
  });
  it("triggerNeedsAnsweringDevice is probeLossPct asset_metric only", () => {
    expect(triggerNeedsAnsweringDevice(T({ type: "asset_metric", metric: "probeLossPct" }))).toBe(true);
    expect(triggerNeedsAnsweringDevice(T({ type: "asset_metric", metric: "responseTimeMs" }))).toBe(false);
    expect(triggerNeedsAnsweringDevice(T({ type: "host_metric", metric: "probeLossPct" }))).toBe(false);
  });
});

describe("triggerHandsOffWhenDeviceDown (rule 29(i))", () => {
  it("probe-derived metrics and the stream-failing fields hand off", () => {
    expect(triggerHandsOffWhenDeviceDown(T({ type: "asset_metric", metric: "probeLossPct" }))).toBe(true);
    expect(triggerHandsOffWhenDeviceDown(T({ type: "asset_metric", metric: "responseTimeMs" }))).toBe(true);
    expect(triggerHandsOffWhenDeviceDown(T({ type: "asset_state", field: "telemetryFailingMinutes" }))).toBe(true);
    expect(triggerHandsOffWhenDeviceDown(T({ type: "asset_state", field: "systemInfoFailingMinutes" }))).toBe(true);
  });
  it("everything else freezes", () => {
    expect(triggerHandsOffWhenDeviceDown(T({ type: "asset_metric", metric: "cpuPct" }))).toBe(false);
    expect(triggerHandsOffWhenDeviceDown(T({ type: "asset_state", field: "ifOperStatus" }))).toBe(false);
    expect(triggerHandsOffWhenDeviceDown(T({ type: "host_metric", metric: "cpuPct" }))).toBe(false);
    expect(triggerHandsOffWhenDeviceDown(T({ type: "event", actionPattern: "*" }))).toBe(false);
  });
  it("a composite hands off only when every leaf (nested too) would, and only kind=asset", () => {
    const loss = { type: "asset_metric", metric: "probeLossPct" };
    const rt = { type: "asset_metric", metric: "responseTimeMs" };
    const cpu = { type: "asset_metric", metric: "cpuPct" };
    expect(triggerHandsOffWhenDeviceDown(T({ type: "composite", kind: "asset", op: "and", children: [loss, { op: "or", children: [rt] }] }))).toBe(true);
    expect(triggerHandsOffWhenDeviceDown(T({ type: "composite", kind: "asset", op: "and", children: [loss, { op: "or", children: [cpu] }] }))).toBe(false);
    expect(triggerHandsOffWhenDeviceDown(T({ type: "composite", kind: "host", op: "and", children: [loss] }))).toBe(false);
  });
});

describe("pin gates (rule 57)", () => {
  it("interface / tunnel / storage pins test membership and default to false", () => {
    expect(interfaceIsPinned({ monitoredInterfaces: ["port1"] }, "port1")).toBe(true);
    expect(interfaceIsPinned({ monitoredInterfaces: ["port1"] }, "port2")).toBe(false);
    expect(interfaceIsPinned(undefined, "port1")).toBe(false);
    expect(interfaceIsPinned({}, "port1")).toBe(false);
    expect(tunnelIsPinned({ monitoredIpsecTunnels: ["vpn1"] }, "vpn1")).toBe(true);
    expect(tunnelIsPinned(undefined, "vpn1")).toBe(false);
    expect(storageIsPinned({ monitoredStorage: ["/"] }, "/")).toBe(true);
    expect(storageIsPinned({ monitoredStorage: ["/"] }, "/boot")).toBe(false);
  });

  it("poeFaultCoversUnpinned: poeStatus == fault | other-fault only", () => {
    expect(poeFaultCoversUnpinned(T({ type: "asset_state", field: "poeStatus", operator: "==", value: "fault" }))).toBe(true);
    expect(poeFaultCoversUnpinned(T({ type: "asset_state", field: "poeStatus", operator: "==", value: "other-fault" }))).toBe(true);
    expect(poeFaultCoversUnpinned(T({ type: "asset_state", field: "poeStatus", operator: "!=", value: "delivering" }))).toBe(false);
    expect(poeFaultCoversUnpinned(T({ type: "asset_state", field: "poeStatus", operator: "==", value: "searching" }))).toBe(false);
    expect(poeFaultCoversUnpinned(T({ type: "asset_state", field: "ifOperStatus", operator: "==", value: "fault" }))).toBe(false);
  });

  it.each([
    [{ type: "asset_metric", metric: "ifInBps" }, "interface"],
    [{ type: "asset_metric", metric: "ifOutErrorRate" }, "interface"],
    [{ type: "asset_metric", metric: "fcLinkFailureRate" }, "interface"],
    [{ type: "asset_metric", metric: "ipsecThroughputBps" }, "tunnel"],
    [{ type: "asset_metric", metric: "storageUsedPct" }, "storage"],
    [{ type: "asset_metric", metric: "storageDaysUntilFull" }, "storage"],
    [{ type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" }, "interface"],
    [{ type: "asset_state", field: "poeStatus", operator: "==", value: "searching" }, "interface"],
    [{ type: "asset_state", field: "ipsecStatus", operator: "==", value: "down" }, "tunnel"],
    [{ type: "asset_state", field: "poeStatus", operator: "==", value: "fault" }, null],
    [{ type: "asset_metric", metric: "cpuPct" }, null],
    [{ type: "host_metric", metric: "cpuPct" }, null],
  ] as const)("pinTestForTrigger(%j) → %s", (trig, kind) => {
    const fn = pinTestForTrigger(T(trig as unknown as Record<string, unknown>));
    const expected = kind === "interface" ? interfaceIsPinned : kind === "tunnel" ? tunnelIsPinned : kind === "storage" ? storageIsPinned : null;
    expect(fn).toBe(expected);
  });
});

describe("interfaceDimLabel / regionSnapshot", () => {
  it("adds a differing, trimmed alias; omits empty or equal ones", () => {
    expect(interfaceDimLabel("port1", "Indoor AP")).toBe("port1 (Indoor AP)");
    expect(interfaceDimLabel("port1", "  Indoor AP  ")).toBe("port1 (Indoor AP)");
    expect(interfaceDimLabel("port1", "port1")).toBe("port1");
    expect(interfaceDimLabel("port1", "   ")).toBe("port1");
    expect(interfaceDimLabel("port1", null)).toBe("port1");
    expect(interfaceDimLabel("port1")).toBe("port1");
  });
  it("regionSnapshot strips the prefix case-blind and drops a bare prefix", () => {
    expect(regionSnapshot(["region:East", "REGION:West", "core", "region:"])).toEqual(["East", "West"]);
    expect(regionSnapshot([])).toEqual([]);
  });
});
