/**
 * tests/unit/nocSdwanFeeds.test.ts
 *
 * The five SD-WAN dashboard feeds in nocDashboardService: rules off their
 * preferred link, sites down to one WAN path, SLA headroom, flapping members
 * and SLA compliance. Prisma is mocked, so these pin the JS folding (path
 * grouping, preference, usage %, drop and compliance arithmetic, owner
 * filtering); the SQL itself runs against a real database in
 * tests/integration/nocSdwanFeeds.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: { findMany: vi.fn() },
    assetInterface: { findMany: vi.fn() },
    notification: { findMany: vi.fn() },
    notificationRule: { findMany: vi.fn() },
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock("../../src/services/monitoringService.js", () => ({
  resolveMonitorSettings: vi.fn(),
  resolveProbeIntervalSec: (eff: { intervalSeconds: number }) => eff.intervalSeconds,
}));

vi.mock("../../src/services/notificationService.js", () => ({
  maintenanceHoldsByAsset: vi.fn(async () => new Map()),
}));

import * as noc from "../../src/services/nocDashboardService.js";
import { prisma } from "../../src/db.js";

const assetFindMany = prisma.asset.findMany as unknown as ReturnType<typeof vi.fn>;
const ifaceFindMany = (prisma as unknown as { assetInterface: { findMany: ReturnType<typeof vi.fn> } }).assetInterface.findMany;
const notifFindMany = (prisma as unknown as { notification: { findMany: ReturnType<typeof vi.fn> } }).notification.findMany;
const rawUnsafe = prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;

function gate(id: string, hostname: string) {
  return { id, hostname, ipAddress: "10.0.0.1", assetType: "firewall", location: "Site " + id, learnedLocation: hostname, snmpLocation: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  noc.clearSdwanHistoryCache();
  notifFindMany.mockResolvedValue([]);
  ifaceFindMany.mockResolvedValue([]);
  assetFindMany.mockResolvedValue([]);
});

describe("sdwanPathOf", () => {
  it("walks a member up its parent chain to the physical port", () => {
    const parents = new Map([["a|Overlay-1", "wan1.100"], ["a|wan1.100", "wan1"]]);
    expect(noc.sdwanPathOf("a", "Overlay-1", parents)).toBe("wan1");
    expect(noc.sdwanPathOf("a", "wan2", parents)).toBe("wan2");
  });

  it("stops on a cycle instead of looping", () => {
    const parents = new Map([["a|x", "y"], ["a|y", "x"]]);
    expect(noc.sdwanPathOf("a", "x", parents)).toBe("y");
  });
});

describe("foldSdwanPaths", () => {
  it("counts two overlays over one port as one path", () => {
    const parents = new Map([["a|Overlay-1", "wan1"], ["a|Overlay-2", "wan1"]]);
    const { paths } = noc.foldSdwanPaths("a", [
      { link: "Overlay-1", state: "up" }, { link: "Overlay-2", state: "up" },
    ], parents);
    expect(paths.size).toBe(1);
  });

  it("calls a member down when ANY health check does, and a path alive when any member on it is", () => {
    const parents = new Map([["a|Overlay-2", "wan2"]]);
    const { paths, downMembers } = noc.foldSdwanPaths("a", [
      { link: "wan1", state: "up" },
      { link: "wan2", state: "up" },
      { link: "wan2", state: "down" },        // second health check says down
      { link: "Overlay-2", state: "down" },
    ], parents);
    expect(paths.get("wan1")).toBe(true);
    expect(paths.get("wan2")).toBe(false);
    expect(downMembers).toEqual(["Overlay-2", "wan2"]);
  });
});

describe("sdwanPreferredMembers", () => {
  it("prefers the first configured member", () => {
    expect(noc.sdwanPreferredMembers({ availableMembers: ["wan1", "wan2"], priorityZones: [] }, () => null)).toEqual(["wan1"]);
  });

  it("prefers every member of the first priority zone", () => {
    const zone: Record<string, string> = { wan1: "underlay", wan2: "underlay", "Overlay-1": "overlay" };
    expect(noc.sdwanPreferredMembers(
      { availableMembers: ["wan1", "wan2", "Overlay-1"], priorityZones: ["underlay", "overlay"] },
      (m) => zone[m],
    )).toEqual(["wan1", "wan2"]);
  });

  it("falls back to the first member when zone membership is unknown", () => {
    expect(noc.sdwanPreferredMembers({ availableMembers: ["wan1", "wan2"], priorityZones: ["underlay"] }, () => null)).toEqual(["wan1"]);
  });
});

describe("sdwanSlaUsage", () => {
  it("reports the metric closest to its target", () => {
    const u = noc.sdwanSlaUsage({
      latencyMs: 50, jitterMs: 9, packetLoss: 1.5,
      latencyThresholdMs: 100, jitterThresholdMs: 30, packetLossThreshold: 2,
    });
    expect(u).toEqual({ pct: 75, label: "loss 1.5% of 2%" });
  });

  it("goes past 100 when the reading is over its target", () => {
    expect(noc.sdwanSlaUsage({
      latencyMs: 180, jitterMs: null, packetLoss: null,
      latencyThresholdMs: 150, jitterThresholdMs: null, packetLossThreshold: null,
    })?.pct).toBe(120);
  });

  it("is null when no metric has both a reading and a positive target", () => {
    expect(noc.sdwanSlaUsage({
      latencyMs: 50, jitterMs: 5, packetLoss: 0,
      latencyThresholdMs: null, jitterThresholdMs: 0, packetLossThreshold: null,
    })).toBeNull();
  });
});

function stats(over: Partial<noc.SdwanPairStats>): noc.SdwanPairStats {
  return {
    assetId: "a", link: "wan1", healthCheck: "HC", drops1h: 0, drops24h: 0,
    n1h: 60, in1h: 60, n24h: 1440, in24h: 1440, hasSla: true, ...over,
  };
}

describe("foldSdwanFlaps", () => {
  it("takes the worst health check per member rather than summing them", () => {
    const rows = noc.foldSdwanFlaps([
      stats({ link: "wan1", healthCheck: "A", drops24h: 3 }),
      stats({ link: "wan1", healthCheck: "B", drops24h: 5 }),
      stats({ link: "wan2", healthCheck: "A", drops24h: 0 }),
    ], "24h");
    expect(rows).toEqual([{ assetId: "a", value: 5, detail: "wan1 · B" }]);
  });

  it("reads the window it is asked for", () => {
    const s = [stats({ drops1h: 1, drops24h: 9 })];
    expect(noc.foldSdwanFlaps(s, "1h")[0].value).toBe(1);
    expect(noc.foldSdwanFlaps(s, "24h")[0].value).toBe(9);
  });
});

describe("foldSdwanCompliance", () => {
  it("ranks time out of SLA, worst first, and drops pairs that never left", () => {
    const rows = noc.foldSdwanCompliance([
      stats({ link: "wan1", n24h: 1000, in24h: 990 }),
      stats({ link: "wan2", n24h: 1000, in24h: 900 }),
      stats({ link: "wan3", n24h: 1000, in24h: 1000 }),
    ], "24h");
    expect(rows.map((r) => [r.detail, r.value])).toEqual([["HC · wan2", 10], ["HC · wan1", 1]]);
  });

  it("says when a health check has no SLA target to judge against", () => {
    const rows = noc.foldSdwanCompliance([stats({ n1h: 60, in1h: 30, hasSla: false })], "1h");
    expect(rows[0]).toMatchObject({ value: 50, detail: "HC · wan1 · no SLA target (alive time)" });
  });
});

describe("getSdwanRuleFailovers", () => {
  it("lists down rules first and drops a zone rule still inside its preferred zone", async () => {
    const now = new Date();
    rawUnsafe
      .mockResolvedValueOnce([
        { assetId: "g1", ruleName: "VoIP", mode: "sla", status: "up", selectedMember: "wan2", availableMembers: ["wan1", "wan2"], priorityZones: [], updatedAt: now },
        { assetId: "g1", ruleName: "Zoned", mode: "sla", status: "up", selectedMember: "wan2", availableMembers: ["wan1", "wan2", "Overlay-1"], priorityZones: ["underlay"], updatedAt: now },
        { assetId: "g2", ruleName: "To-HQ", mode: "manual", status: "down", selectedMember: null, availableMembers: ["Overlay-1"], priorityZones: [], updatedAt: now },
      ])
      // zone lookup for g1
      .mockResolvedValueOnce([
        { assetId: "g1", link: "wan1", zone: "underlay" },
        { assetId: "g1", link: "wan2", zone: "underlay" },
        { assetId: "g1", link: "Overlay-1", zone: "overlay" },
      ]);
    assetFindMany.mockResolvedValueOnce([gate("g1", "fgt-1"), gate("g2", "fgt-2")]);
    const rows = await noc.getSdwanRuleFailovers();
    expect(rows.map((r) => [r.ruleName, r.state, r.preferredMembers])).toEqual([
      ["To-HQ", "down", ["Overlay-1"]],
      ["VoIP", "failedOver", ["wan1"]],
    ]);
  });

  it("drops rules whose gate is no longer monitored", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "gone", ruleName: "VoIP", mode: "sla", status: "down", selectedMember: null, availableMembers: ["wan1", "wan2"], priorityZones: [], updatedAt: new Date() },
    ]);
    assetFindMany.mockResolvedValueOnce([]);
    expect(await noc.getSdwanRuleFailovers()).toEqual([]);
  });
});

describe("getSdwanSingleLinkSites", () => {
  it("lists a two-path gate down to one, and not a redundant one or a single-path one", async () => {
    const t = new Date();
    rawUnsafe
      .mockResolvedValueOnce([
        // g1: wan1 up, wan2 down → 1 of 2
        { assetId: "g1", link: "wan1", healthCheck: "HC", state: "up", timestamp: t },
        { assetId: "g1", link: "wan2", healthCheck: "HC", state: "down", timestamp: t },
        // g2: both up → redundant
        { assetId: "g2", link: "wan1", healthCheck: "HC", state: "up", timestamp: t },
        { assetId: "g2", link: "wan2", healthCheck: "HC", state: "up", timestamp: t },
        // g3: two overlays over one port → one path, never redundant
        { assetId: "g3", link: "Overlay-1", healthCheck: "HC", state: "up", timestamp: t },
        { assetId: "g3", link: "Overlay-2", healthCheck: "HC", state: "down", timestamp: t },
      ])
      // IPsec parents
      .mockResolvedValueOnce([
        { assetId: "g3", tunnelName: "Overlay-1", parentInterface: "wan1" },
        { assetId: "g3", tunnelName: "Overlay-2", parentInterface: "wan1" },
      ]);
    assetFindMany.mockResolvedValueOnce([gate("g1", "fgt-1"), gate("g2", "fgt-2"), gate("g3", "fgt-3")]);
    const rows = await noc.getSdwanSingleLinkSites();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assetId: "g1", alivePaths: 1, totalPaths: 2, alive: ["wan1"], downMembers: ["wan2"] });
  });
});

describe("getSdwanSlaHeadroom", () => {
  it("ranks live pairs by SLA use and skips dead members and target-less checks", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "g1", healthCheck: "HC", link: "wan1", state: "up", latencyMs: 90, jitterMs: 1, packetLoss: 0, latencyThresholdMs: 100, jitterThresholdMs: 30, packetLossThreshold: 2 },
      { assetId: "g1", healthCheck: "HC", link: "wan2", state: "up", latencyMs: 20, jitterMs: 1, packetLoss: 0, latencyThresholdMs: 100, jitterThresholdMs: 30, packetLossThreshold: 2 },
      { assetId: "g1", healthCheck: "HC", link: "wan3", state: "down", latencyMs: 99, jitterMs: null, packetLoss: null, latencyThresholdMs: 100, jitterThresholdMs: null, packetLossThreshold: null },
      { assetId: "g1", healthCheck: "DNS", link: "wan1", state: "up", latencyMs: 5, jitterMs: 1, packetLoss: 0, latencyThresholdMs: null, jitterThresholdMs: null, packetLossThreshold: null },
    ]);
    assetFindMany.mockResolvedValueOnce([gate("g1", "fgt-1")]);
    const rows = await noc.getSdwanSlaHeadroom();
    expect(rows.map((r) => [r.detail, r.value])).toEqual([
      ["HC · wan1 · latency 90 ms of 100 ms", 90],
      ["HC · wan2 · latency 20 ms of 100 ms", 20],
    ]);
  });
});

describe("the shared 24h pass", () => {
  it("feeds flapping and compliance from ONE query", async () => {
    rawUnsafe.mockResolvedValue([stats({ assetId: "g1", drops24h: 2, in24h: 1400 })]);
    assetFindMany.mockResolvedValue([gate("g1", "fgt-1")]);
    const flaps = await noc.getSdwanFlappingLinks("24h");
    const comp = await noc.getSdwanSlaCompliance("24h");
    expect(flaps[0]).toMatchObject({ id: "g1", value: 2 });
    expect(comp[0]).toMatchObject({ id: "g1", value: 2.78 });
    expect(rawUnsafe).toHaveBeenCalledTimes(1);
  });

  it("scans fleet-wide once and applies each widget's asset filter to the result", async () => {
    rawUnsafe.mockResolvedValue([
      stats({ assetId: "g1", drops24h: 2 }),
      stats({ assetId: "g2", drops24h: 7 }),
    ]);
    assetFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => gate(id, "fgt-" + id)));
    const onlyG1 = await noc.getSdwanFlappingLinks("24h", 100, ["g1"]);
    const onlyG2 = await noc.getSdwanFlappingLinks("24h", 100, ["g2"]);
    expect(onlyG1.map((r) => r.id)).toEqual(["g1"]);
    expect(onlyG2.map((r) => r.id)).toEqual(["g2"]);
    expect(rawUnsafe).toHaveBeenCalledTimes(1);
  });
});
