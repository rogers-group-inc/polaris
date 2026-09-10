/**
 * tests/unit/nocDashboardService.test.ts
 *
 * Unit coverage for the NOC dashboard aggregates. Prisma + the monitor-settings
 * resolver are mocked so the tests assert the JS transformation logic (status
 * grouping, uptime math, packet-loss ratio, stale-poll grace, site bucketing,
 * top-N hydration ordering) without a live DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    assetTypeDef: { findMany: vi.fn() },
    event: { findMany: vi.fn() },
    notification: { findMany: vi.fn() },
    $queryRawUnsafe: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

vi.mock("../../src/services/monitoringService.js", () => ({
  resolveMonitorSettings: vi.fn(),
}));

import * as noc from "../../src/services/nocDashboardService.js";
import { prisma } from "../../src/db.js";
import { resolveMonitorSettings } from "../../src/services/monitoringService.js";
import { BUILT_IN_ASSET_TYPES } from "../../src/utils/assetTypes.js";

const groupBy = prisma.asset.groupBy as unknown as ReturnType<typeof vi.fn>;
const count = prisma.asset.count as unknown as ReturnType<typeof vi.fn>;
const findMany = prisma.asset.findMany as unknown as ReturnType<typeof vi.fn>;
const eventFindMany = prisma.event.findMany as unknown as ReturnType<typeof vi.fn>;
const rawUnsafe = prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;
const rawQuery = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;
const resolve = resolveMonitorSettings as unknown as ReturnType<typeof vi.fn>;
const notifFindMany = (prisma as unknown as { notification: { findMany: ReturnType<typeof vi.fn> } }).notification.findMany;
const typeDefFindMany = (prisma as unknown as { assetTypeDef: { findMany: ReturnType<typeof vi.fn> } }).assetTypeDef.findMany;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no active alerts — feeds keep their base ordering.
  notifFindMany.mockResolvedValue([]);
  // Default: an empty asset-type registry (only getFilterOptions reads it).
  typeDefFindMany.mockResolvedValue([]);
});

describe("getStatusSummary", () => {
  it("maps null monitorStatus to unknown, totals every state, and computes infra uptime%", async () => {
    groupBy
      // 1st call: all monitored, by status
      .mockResolvedValueOnce([
        { monitorStatus: "up", _count: { _all: 10 } },
        { monitorStatus: "down", _count: { _all: 2 } },
        { monitorStatus: "warning", _count: { _all: 1 } },
        { monitorStatus: null, _count: { _all: 3 } }, // null -> unknown
      ])
      // 2nd call: infra subset by status
      .mockResolvedValueOnce([
        { monitorStatus: "up", _count: { _all: 7 } },
        { monitorStatus: "down", _count: { _all: 1 } },
        { monitorStatus: "warning", _count: { _all: 5 } }, // excluded from uptime denom
      ]);
    count
      .mockResolvedValueOnce(3)  // activeAlertCount
      .mockResolvedValueOnce(0); // maintenance-window count

    const r = await noc.getStatusSummary();
    expect(r.statusCounts).toEqual({ total: 16, up: 10, down: 2, warning: 1, unknown: 3, recovering: 0, passive: 0, maintenance: 0 });
    // 7 / (7 + 1) = 87.5
    expect(r.uptimePercent).toBe(87.5);
    expect(r.activeAlertCount).toBe(3);
  });

  it("returns null uptime when there is no infra up/down to measure", async () => {
    groupBy.mockResolvedValueOnce([{ monitorStatus: "up", _count: { _all: 4 } }]).mockResolvedValueOnce([]);
    count.mockResolvedValue(0);
    const r = await noc.getStatusSummary();
    expect(r.uptimePercent).toBeNull();
    expect(r.statusCounts.total).toBe(4);
  });

  it("buckets maintenance-window assets separately (still in total, never in up/down/warning)", async () => {
    groupBy
      // maintenance assets are excluded from both groupBys server-side
      // (where status<>maintenance), so their frozen "down" never appears here
      .mockResolvedValueOnce([
        { monitorStatus: "up", _count: { _all: 10 } },
        { monitorStatus: "down", _count: { _all: 1 } },
      ])
      .mockResolvedValueOnce([{ monitorStatus: "up", _count: { _all: 5 } }]);
    count
      .mockResolvedValueOnce(1)  // activeAlertCount
      .mockResolvedValueOnce(2); // maintenance-window count

    const r = await noc.getStatusSummary();
    expect(r.statusCounts).toEqual({ total: 13, up: 10, down: 1, warning: 0, unknown: 0, recovering: 0, passive: 0, maintenance: 2 });
    // Both groupBys must carry the maintenance exclusion.
    expect(groupBy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ status: { not: "maintenance" } }),
    }));
    expect(groupBy).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ status: { not: "maintenance" } }),
    }));
  });
});

describe("getDownNodes", () => {
  it("coalesces the site label by location > learnedLocation > snmpLocation > (unknown)", async () => {
    findMany.mockResolvedValueOnce([
      { id: "a", hostname: "a", ipAddress: null, assetType: "switch", location: "HQ", learnedLocation: "x", snmpLocation: null, department: "NetEng", monitorStatus: "down", monitorStatusChangedAt: null },
      { id: "b", hostname: "b", ipAddress: null, assetType: "switch", location: null, learnedLocation: "Site-B", snmpLocation: "raw", department: null, monitorStatus: "down", monitorStatusChangedAt: null },
      { id: "c", hostname: "c", ipAddress: null, assetType: "switch", location: null, learnedLocation: null, snmpLocation: null, department: null, monitorStatus: "down", monitorStatusChangedAt: null },
    ]);
    count.mockResolvedValueOnce(3);
    const r = await noc.getDownNodes();
    expect(r.nodes.map((n) => n.site)).toEqual(["HQ", "Site-B", "(unknown)"]);
    expect(r.total).toBe(3);
  });

  it("total is the TRUE down count, not the capped row count", async () => {
    findMany.mockResolvedValueOnce([
      { id: "a", hostname: "a", ipAddress: null, assetType: "switch", location: "HQ", learnedLocation: null, snmpLocation: null, department: null, monitorStatus: "down", monitorStatusChangedAt: null },
    ]);
    count.mockResolvedValueOnce(5); // 4 more down beyond the limit-capped list
    const r = await noc.getDownNodes(1);
    expect(r.nodes).toHaveLength(1);
    expect(r.total).toBe(5);
  });

  it("orders youngest outage first (monitorStatusChangedAt desc, nulls last)", async () => {
    findMany.mockResolvedValueOnce([]);
    count.mockResolvedValueOnce(0);
    await noc.getDownNodes();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ monitorStatusChangedAt: { sort: "desc", nulls: "last" } }],
    }));
  });

  it("excludes maintenance-window assets (frozen monitorStatus is not a live outage)", async () => {
    findMany.mockResolvedValueOnce([]);
    count.mockResolvedValueOnce(0);
    await noc.getDownNodes();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ monitorStatus: "down", status: { not: "maintenance" } }),
    }));
  });

  it("excludes dependency-suppressed assets by default (one dead gate is one outage)", async () => {
    findMany.mockResolvedValueOnce([]);
    count.mockResolvedValueOnce(0);
    await noc.getDownNodes();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ dependencySuppressed: false }),
    }));
  });

  it("includeDependencyDown drops the suppression filter and flags those rows", async () => {
    findMany.mockResolvedValueOnce([
      { id: "a", hostname: "gate", ipAddress: null, assetType: "firewall", location: "HQ", learnedLocation: null, snmpLocation: null, department: null, monitorStatus: "down", monitorStatusChangedAt: null, dependencySuppressed: false },
      { id: "b", hostname: "sw", ipAddress: null, assetType: "switch", location: "HQ", learnedLocation: null, snmpLocation: null, department: null, monitorStatus: "down", monitorStatusChangedAt: null, dependencySuppressed: true },
    ]);
    count.mockResolvedValueOnce(2);
    const r = await noc.getDownNodes(100, null, true);
    // The absence of the key is the whole point: with it, the suppressed row
    // can never come back.
    const where = (findMany.mock.calls.at(-1)?.[0] as { where: Record<string, unknown> }).where;
    expect(where).not.toHaveProperty("dependencySuppressed");
    expect(where).toMatchObject({ monitorStatus: "down" });
    expect(r.nodes.map((n) => n.dependencySuppressed)).toEqual([false, true]);
  });

  // The widget's click-through offers "Acknowledge" for the alert its severity
  // pill is showing, so the row has to NAME that alert. Without the id the
  // widget would have to guess which of an asset's alerts the pill meant.
  it("names the alert behind the severity pill, and whether it is already acknowledged", async () => {
    findMany.mockResolvedValueOnce([
      { id: "a", hostname: "fw-1", ipAddress: null, assetType: "firewall", location: "HQ", learnedLocation: null, snmpLocation: null, department: null, monitorStatus: "down", monitorStatusChangedAt: null, dependencySuppressed: false },
      { id: "b", hostname: "sw-2", ipAddress: null, assetType: "switch", location: "HQ", learnedLocation: null, snmpLocation: null, department: null, monitorStatus: "down", monitorStatusChangedAt: null, dependencySuppressed: false },
      { id: "c", hostname: "ap-3", ipAddress: null, assetType: "access_point", location: "HQ", learnedLocation: null, snmpLocation: null, department: null, monitorStatus: "down", monitorStatusChangedAt: null, dependencySuppressed: false },
    ]);
    count.mockResolvedValueOnce(3);
    notifFindMany.mockReset();
    notifFindMany.mockResolvedValueOnce([
      { id: "n-a", assetId: "a", severity: "critical", acknowledged: false, rule: { trigger: { type: "asset_state", field: "monitorStatus" } } },
      { id: "n-b", assetId: "b", severity: "warning", acknowledged: true, rule: { trigger: { type: "asset_state", field: "monitorStatus" } } },
      // c is down with no automation covering it (business rule 36's `passive`)
      // — nothing to acknowledge, so the row must carry no alert id at all.
    ]);
    const r = await noc.getDownNodes();
    const byId = Object.fromEntries(r.nodes.map((n) => [n.id, n]));
    expect(byId.a.alertId).toBe("n-a");
    expect(byId.a.alertAcknowledged).toBe(false);
    expect(byId.b.alertId).toBe("n-b");
    expect(byId.b.alertAcknowledged).toBe(true);
    expect(byId.c.alertId).toBeUndefined();
    expect(byId.c.alertAcknowledged).toBeUndefined();
  });

  // At equal severity the choice is invisible to the pill, so it goes to the
  // one that still needs a human — otherwise an asset with two criticals, one
  // taken and one not, could read as "already acknowledged" and lose the verb.
  it("breaks a severity tie toward the UNACKNOWLEDGED alert", async () => {
    findMany.mockResolvedValueOnce([
      { id: "a", hostname: "fw-1", ipAddress: null, assetType: "firewall", location: "HQ", learnedLocation: null, snmpLocation: null, department: null, monitorStatus: "down", monitorStatusChangedAt: null, dependencySuppressed: false },
    ]);
    count.mockResolvedValueOnce(1);
    notifFindMany.mockReset();
    notifFindMany.mockResolvedValueOnce([
      { id: "n-taken", assetId: "a", severity: "critical", acknowledged: true, rule: { trigger: { type: "asset_state", field: "monitorStatus" } } },
      { id: "n-open", assetId: "a", severity: "critical", acknowledged: false, rule: { trigger: { type: "asset_state", field: "monitorStatus" } } },
    ]);
    const r = await noc.getDownNodes();
    expect(r.nodes[0].alertId).toBe("n-open");
    expect(r.nodes[0].alertAcknowledged).toBe(false);
    // The pill is unchanged either way — same severity.
    expect(r.nodes[0].alertSeverity).toBe("critical");
  });

  // A higher severity still wins outright, acknowledged or not: the row's pill
  // and the alert it names must be the same alert.
  it("still takes the most severe alert even when it is the acknowledged one", async () => {
    findMany.mockResolvedValueOnce([
      { id: "a", hostname: "fw-1", ipAddress: null, assetType: "firewall", location: "HQ", learnedLocation: null, snmpLocation: null, department: null, monitorStatus: "down", monitorStatusChangedAt: null, dependencySuppressed: false },
    ]);
    count.mockResolvedValueOnce(1);
    notifFindMany.mockReset();
    notifFindMany.mockResolvedValueOnce([
      { id: "n-crit", assetId: "a", severity: "critical", acknowledged: true, rule: { trigger: { type: "asset_state", field: "monitorStatus" } } },
      { id: "n-warn", assetId: "a", severity: "warning", acknowledged: false, rule: { trigger: { type: "asset_state", field: "monitorStatus" } } },
    ]);
    const r = await noc.getDownNodes();
    expect(r.nodes[0].alertSeverity).toBe("critical");
    expect(r.nodes[0].alertId).toBe("n-crit");
    expect(r.nodes[0].alertAcknowledged).toBe(true);
  });
});

describe("getDownInterfaces", () => {
  it("resolves the gate (firewall→hostname, else learnedLocation), keeps SQL order, drops unmonitored owners", async () => {
    const t = new Date("2026-06-30T00:00:00Z");
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "sw", ifName: "port12", ifLabel: "AP uplink", lastUpAt: t },
      { assetId: "fw", ifName: "wan2", ifLabel: null, lastUpAt: null },
      { assetId: "gone", ifName: "port3", ifLabel: null, lastUpAt: t }, // owner not monitored → dropped
    ]);
    findMany.mockResolvedValueOnce([
      { id: "sw", hostname: "fs-aisle-3", ipAddress: "10.1.2.5", assetType: "switch", location: null, learnedLocation: "fgt-plant-a", snmpLocation: null },
      { id: "fw", hostname: "fgt-dc-west", ipAddress: "10.9.0.1", assetType: "firewall", location: null, learnedLocation: "fmg-01", snmpLocation: null },
    ]);
    const r = await noc.getDownInterfaces();
    expect(r.map((x) => [x.assetId, x.ifName, x.gate])).toEqual([
      ["sw", "port12", "fgt-plant-a"], // switch → parent learnedLocation
      ["fw", "wan2", "fgt-dc-west"],   // firewall → own hostname, not learnedLocation
    ]);
    expect(r[0].lastUpAt).toBe(t);
    expect(r[1].ifLabel).toBeNull();
  });

  it("restricts to interfaces selected for monitoring (pin filter inside the SQL, before the LIMIT)", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    await noc.getDownInterfaces();
    const sql = rawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain(`s."ifName" = ANY(a."monitoredInterfaces")`);
  });

  it("returns empty without hitting findMany when no interface is down", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    const r = await noc.getDownInterfaces();
    expect(r).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("getDownIpsecTunnels", () => {
  it("returns down tunnels with parent interface + gate, keeps SQL order, drops unmonitored owners", async () => {
    const t = new Date("2026-06-30T00:00:00Z");
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "fw", tunnelName: "vpn-hq", parentInterface: "wan1", remoteGateway: "203.0.113.7", lastUpAt: t },
      { assetId: "fw", tunnelName: "vpn-dr", parentInterface: null, remoteGateway: null, lastUpAt: null },
      { assetId: "gone", tunnelName: "vpn-x", parentInterface: "wan2", remoteGateway: null, lastUpAt: t }, // owner not monitored → dropped
    ]);
    findMany.mockResolvedValueOnce([
      { id: "fw", hostname: "fgt-dc-west", ipAddress: "10.9.0.1", assetType: "firewall", location: null, learnedLocation: "fmg-01", snmpLocation: null },
    ]);
    const r = await noc.getDownIpsecTunnels();
    expect(r.map((x) => [x.tunnelName, x.parentInterface, x.gate])).toEqual([
      ["vpn-hq", "wan1", "fgt-dc-west"], // firewall gate = own hostname, not learnedLocation
      ["vpn-dr", null, "fgt-dc-west"],
    ]);
    expect(r[0].remoteGateway).toBe("203.0.113.7");
  });

  it("restricts to tunnels selected for monitoring (pin filter inside the SQL, before the LIMIT)", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    await noc.getDownIpsecTunnels();
    const sql = rawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain(`s."tunnelName" = ANY(a."monitoredIpsecTunnels")`);
  });

  it("returns empty without hitting findMany when no tunnel is down", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    const r = await noc.getDownIpsecTunnels();
    expect(r).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("getHighestCpu", () => {
  it("preserves the SQL order, rounds to 0.1, and drops ids with no asset row", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "a", value: 91.27 },
      { assetId: "gone", value: 80 },
      { assetId: "b", value: 70.0 },
    ]);
    findMany.mockResolvedValueOnce([
      { id: "b", hostname: "host-b", ipAddress: "10.0.0.2" },
      { id: "a", hostname: "host-a", ipAddress: "10.0.0.1" },
    ]);
    const r = await noc.getHighestCpu();
    expect(r.map((x) => x.id)).toEqual(["a", "b"]); // 'gone' filtered, order kept
    expect(r[0].value).toBe(91.3);
  });

  it("attaches a site label (location > learnedLocation > snmpLocation > (unknown)) for Group-by-Site", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "a", value: 90 },
      { assetId: "b", value: 80 },
    ]);
    findMany.mockResolvedValueOnce([
      { id: "a", hostname: "host-a", ipAddress: null, location: null, learnedLocation: "fgt-plant-a", snmpLocation: null },
      { id: "b", hostname: "host-b", ipAddress: null, location: null, learnedLocation: null, snmpLocation: null },
    ]);
    const r = await noc.getHighestCpu();
    expect(r.map((x) => x.site)).toEqual(["fgt-plant-a", "(unknown)"]);
  });
});

describe("getPacketLoss", () => {
  it("computes failed/total as a percentage rounded to 0.1", async () => {
    rawUnsafe.mockResolvedValueOnce([{ assetId: "a", total: 8n, failed: 1n }]);
    findMany.mockResolvedValueOnce([{ id: "a", hostname: "h", ipAddress: "1.2.3.4" }]);
    const r = await noc.getPacketLoss();
    expect(r[0].value).toBe(12.5); // 1/8
  });

  it("excludes 100%-loss assets in the SQL (hard-down = Down Nodes, not packet loss)", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    await noc.getPacketLoss();
    const sql = rawUnsafe.mock.calls[0][0] as string;
    // The loss test is asked of PACKETS, not of row outcomes. A row-based
    // `>= 1 failed row` test would filter out a device whose every ICMP burst
    // dropped packets while still getting something back (so no row is a
    // failure) — precisely the device this widget exists to surface.
    expect(sql).toContain("HAVING");
    expect(sql).toContain(`"packetsSent"`);
  });

  it("no longer trims the window to the first successful probe", async () => {
    // Both anchors were removed on 2026-09-01 (business rule 29). They existed
    // so a device coming back from an outage did not read ~92% and alert
    // because it had recovered — but they also collapsed a flapping device's
    // window to its last few probes and reported ~0% loss forever. Suppression
    // moved to the engine (the answering gate and ignoreAtOrAbove); the
    // measurement is plainly failed/total over the whole window.
    //
    // Asserted as ABSENCE on purpose: re-introducing a trim here would silently
    // restore the flapping bug, and nothing else in the suite would notice.
    rawUnsafe.mockResolvedValueOnce([]);
    await noc.getPacketLoss();
    const sql = rawUnsafe.mock.calls[0][0] as string;
    expect(sql).not.toContain("firstOk");
    expect(sql).not.toContain("GREATEST");
    expect(sql).not.toContain("recoveryStartedAt");
    expect(sql).not.toContain("LEFT JOIN");
  });

  it("steps over the failures of a run that reached DOWN", async () => {
    // Business rule 29h. The two ENGINE gates cannot see the case an operator
    // reports — a device dark for twelve minutes comes back, starts answering,
    // and its window still reads 40 % — so the outage's own probes are excluded
    // here, in the ONE query both the engine and this widget read. The unit is
    // the RUN, not the marked row: `assetDown` is only stampable from the probe
    // that DECLARES the outage, so the onset would otherwise survive.
    //
    // Asserted as SQL shape because the widget path is mocked; the behaviour
    // is pinned against real Postgres in tests/integration/probeLossQuery.test.ts.
    rawUnsafe.mockResolvedValueOnce([]);
    await noc.getPacketLoss();
    const sql = rawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain(`"runOutage"`);
    expect(sql).toContain(`WHERE NOT ("runOutage" AND NOT "success")`);
    // coalesce is load-bearing: bool_or over a run of pre-column NULL rows is
    // NULL, and `NOT (NULL AND NOT success)` is NULL, which WHERE reads as
    // false — dropping every failure in an UNSTAMPED run, i.e. all loss
    // everywhere. Without this assertion that regression is silent.
    expect(sql).toContain(`coalesce(bool_or("assetDown")`);
  });

  it("reports a fully-dark asset at 100% with no opt-in flag", async () => {
    // What includeFullyDown used to buy. With every row in the window counted,
    // an asset that answered nothing reads 100% naturally — and vanishing from
    // the widget would have read as "no loss", the opposite of the truth.
    rawUnsafe.mockResolvedValueOnce([{ assetId: "a", total: 20n, failed: 20n }]);
    findMany.mockResolvedValueOnce([{ id: "a", hostname: "h", ipAddress: "1.2.3.4" }]);
    const r = await noc.getPacketLoss();
    expect(r[0].value).toBe(100);
  });

  it("bounds the window with a timezone-proof now() (naive-UTC columns vs server TimeZone)", async () => {
    // Prisma timestamp columns are naive UTC; bare now() would interpret
    // them in the DB server's zone and silently widen/shrink the window by
    // the UTC offset (the "50% packet loss on a healthy device" bug — the
    // 15-min window reached ~5h back into a recovered outage).
    rawUnsafe.mockResolvedValueOnce([]);
    await noc.getPacketLoss();
    const sql = rawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain(`(now() AT TIME ZONE 'UTC')`);
    expect(sql).not.toMatch(/[^)]now\(\) -/);
  });
});

describe("getStalePolls", () => {
  it("keeps assets overdue past grace*interval and doubles the window for suppressed assets", async () => {
    const now = Date.now();
    findMany.mockResolvedValueOnce([
      // last polled 10 min ago, interval 60s, grace 3 -> overdue (10min >> 3min)
      { id: "stale", hostname: "s", ipAddress: null, lastMonitorAt: new Date(now - 10 * 60_000), assetType: "switch", discoveredByIntegrationId: null, discoveredByIntegration: null, monitorIntervalSec: null, cpuMemoryIntervalSec: null, temperatureIntervalSec: null, systemInfoIntervalSec: null, lldpIntervalSec: null, storageIntervalSec: null, probeTimeoutMs: null, dependencySuppressed: false },
      // last polled 6 min ago, suppressed -> window = 3*60*2 = 6 min, 6min is not > 6min boundary unless ==; use 5min to stay fresh
      { id: "fresh-suppressed", hostname: "f", ipAddress: null, lastMonitorAt: new Date(now - 5 * 60_000), assetType: "switch", discoveredByIntegrationId: null, discoveredByIntegration: null, monitorIntervalSec: null, cpuMemoryIntervalSec: null, temperatureIntervalSec: null, systemInfoIntervalSec: null, lldpIntervalSec: null, storageIntervalSec: null, probeTimeoutMs: null, dependencySuppressed: true },
    ]);
    resolve.mockResolvedValue({ intervalSeconds: 60 });
    const r = await noc.getStalePolls(3);
    expect(r.map((x) => x.id)).toEqual(["stale"]);
    expect(r[0].expectedIntervalSec).toBe(60);
  });

  it("treats a never-polled asset as stale", async () => {
    findMany.mockResolvedValueOnce([
      { id: "never", hostname: "n", ipAddress: null, lastMonitorAt: null, assetType: "switch", discoveredByIntegrationId: null, discoveredByIntegration: null, monitorIntervalSec: null, cpuMemoryIntervalSec: null, temperatureIntervalSec: null, systemInfoIntervalSec: null, lldpIntervalSec: null, storageIntervalSec: null, probeTimeoutMs: null, dependencySuppressed: false },
    ]);
    resolve.mockResolvedValue({ intervalSeconds: 60 });
    const r = await noc.getStalePolls();
    expect(r.map((x) => x.id)).toEqual(["never"]);
  });
});

describe("getRecentReboots", () => {
  it("maps device.reboot events, pulling hostname/ip from resourceName + details", async () => {
    const t = new Date("2026-06-20T00:00:00Z");
    eventFindMany.mockResolvedValueOnce([
      { id: "e1", resourceId: "asset-1", resourceName: "fw-1", timestamp: t, details: { ipAddress: "10.0.0.5" } },
      { id: "e2", resourceId: "asset-2", resourceName: null, timestamp: t, details: { hostname: "sw-2", ipAddress: null } },
    ]);
    const r = await noc.getRecentReboots();
    expect(r[0]).toMatchObject({ id: "asset-1", hostname: "fw-1", ipAddress: "10.0.0.5" });
    expect(r[1]).toMatchObject({ id: "asset-2", hostname: "sw-2" });
  });
});

describe("getRecentAlerts", () => {
  it("maps UNCLEARED notifications to {assetId, hostname, dimension, message, severity, raisedAt, ruleName, acknowledged}", async () => {
    const t = new Date("2026-06-20T00:00:00Z");
    notifFindMany.mockReset();
    notifFindMany.mockResolvedValueOnce([
      {
        id: "n1", assetId: "asset-1", assetHostname: "fw-1", dimension: null,
        message: "fw-1 is down", severity: "critical", triggeredAt: t,
        acknowledged: true, acknowledgedBy: "jsmith", rule: { name: "Asset down" },
      },
    ]);
    const r = await noc.getRecentAlerts();
    expect(r.alerts[0]).toEqual({
      id: "n1", assetId: "asset-1", hostname: "fw-1", dimension: null,
      message: "fw-1 is down", severity: "critical", raisedAt: t,
      ruleName: "Asset down", acknowledged: true, acknowledgedBy: "jsmith",
    });
    // It reads ALERTS, never audit Events — the whole point of the feed.
    expect(eventFindMany).not.toHaveBeenCalled();
    expect(notifFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ cleared: false }),
    }));
  });

  it("carries the dimension, so one automation's per-port alerts are tellable apart", async () => {
    // A per-interface automation raises one alert per pinned port: same rule,
    // same minute, same message template. Without the dimension the widget
    // renders rows that differ in nothing.
    const t = new Date("2026-06-20T00:00:00Z");
    notifFindMany.mockReset();
    notifFindMany.mockResolvedValueOnce([
      { id: "p10", assetId: "sw", assetHostname: "sw-1", dimension: "port10", message: "m", severity: "serious", triggeredAt: t, acknowledged: false, acknowledgedBy: null, rule: { name: "Interface down" } },
      { id: "p2", assetId: "sw", assetHostname: "sw-1", dimension: "port2", message: "m", severity: "serious", triggeredAt: t, acknowledged: false, acknowledgedBy: null, rule: { name: "Interface down" } },
    ]);
    const r = await noc.getRecentAlerts();
    // Equal severity AND equal timestamp → dimension orders NUMERICALLY, so
    // port2 precedes port10 (the asset Alerts tab's tiebreak).
    expect(r.alerts.map((x) => x.dimension)).toEqual(["port2", "port10"]);
  });

  it("reports a `serious` automation as serious, not the Event level's collapsed error", async () => {
    // The reported bug: the baseline IPsec automation is `serious`, but the feed
    // read `Event.level`, and severityLevel() folds critical AND serious into
    // "error" — so the widget pill said error.
    notifFindMany.mockReset();
    notifFindMany.mockResolvedValueOnce([
      {
        id: "n1", assetHostname: "PINERUN-101F-1", message: "PINERUN-101F-1: IPsec tunnel Overlay-2 is down",
        severity: "serious", triggeredAt: new Date("2026-06-20T00:00:00Z"),
        acknowledged: false, acknowledgedBy: null, rule: { name: "IPsec tunnel down" },
      },
    ]);
    const r = await noc.getRecentAlerts();
    expect(r.alerts[0].severity).toBe("serious");
  });

  it("orders severity-first on the AUTOMATION ladder (serious above warning), newest within a tier", async () => {
    const old = new Date("2026-06-20T00:00:00Z");
    const recent = new Date("2026-06-20T01:00:00Z");
    notifFindMany.mockReset();
    notifFindMany.mockResolvedValueOnce([
      { id: "warn-new", assetHostname: "a", message: "m", severity: "warning", triggeredAt: recent, acknowledged: false, acknowledgedBy: null, rule: { name: "r" } },
      { id: "serious-old", assetHostname: "b", message: "m", severity: "serious", triggeredAt: old, acknowledged: false, acknowledgedBy: null, rule: { name: "r" } },
      { id: "notice-new", assetHostname: "c", message: "m", severity: "notice", triggeredAt: recent, acknowledged: false, acknowledgedBy: null, rule: { name: "r" } },
      { id: "serious-new", assetHostname: "d", message: "m", severity: "serious", triggeredAt: recent, acknowledged: false, acknowledgedBy: null, rule: { name: "r" } },
    ]);
    const r = await noc.getRecentAlerts();
    expect(r.alerts.map((x) => x.id)).toEqual(["serious-new", "serious-old", "warn-new", "notice-new"]);
  });

  it("scopes to the filtered asset id set, and honors the row cap after ordering", async () => {
    notifFindMany.mockReset();
    notifFindMany.mockResolvedValueOnce([
      { id: "w", assetHostname: "a", message: "m", severity: "warning", triggeredAt: new Date(2), acknowledged: false, acknowledgedBy: null, rule: { name: "r" } },
      { id: "c", assetHostname: "b", message: "m", severity: "critical", triggeredAt: new Date(1), acknowledged: false, acknowledgedBy: null, rule: { name: "r" } },
    ]);
    const r = await noc.getRecentAlerts(1, ["asset-1"]);
    // The cap slices the SORTED list, so the critical survives a limit of 1.
    expect(r.alerts.map((x) => x.id)).toEqual(["c"]);
    // …and `total` reports what the cap hid, so the widget can say "1 of 2"
    // instead of silently ending. This is the whole reason a screenful of
    // criticals could hide every serious alert on the fleet.
    expect(r.total).toBe(2);
  });

  it("keeps assetId-null alerts under an asset filter — no filter can speak to them", async () => {
    // A host_metric alert (Polaris's own CPU) or a system-scoped event alert
    // carries no assetId. `assetId IN (...)` never matches NULL, so narrowing a
    // wallboard to a region used to make alerts about Polaris ITSELF vanish.
    notifFindMany.mockReset();
    notifFindMany.mockResolvedValueOnce([]);
    await noc.getRecentAlerts(100, ["asset-1"]);
    expect(notifFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        cleared: false,
        OR: [{ assetId: { in: ["asset-1"] } }, { assetId: null }],
      }),
    }));
  });

  it("survives a rule-less alert (SetNull on rule delete) and a deleted asset", async () => {
    notifFindMany.mockReset();
    notifFindMany.mockResolvedValueOnce([
      { id: "n1", assetHostname: null, message: "orphan", severity: "warning", triggeredAt: new Date(1), acknowledged: false, acknowledgedBy: null, rule: null },
    ]);
    const r = await noc.getRecentAlerts();
    expect(r.alerts[0]).toMatchObject({ ruleName: null, hostname: null, assetId: null, dimension: null });
  });
});

describe("getSitesWithIssues", () => {
  it("joins per-site counts with affected nodes bucketed by the same coalesced site key", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { site: "HQ", down: 2n, warning: 1n, total: 9n, lat: 36.1, lng: -86.7 },
    ]);
    findMany.mockResolvedValueOnce([
      { id: "n1", hostname: "n1", monitorStatus: "down", location: "HQ", learnedLocation: null, snmpLocation: null, department: "NetEng" },
      { id: "n2", hostname: "n2", monitorStatus: "warning", location: "HQ", learnedLocation: null, snmpLocation: null, department: "NetEng" },
    ]);
    const r = await noc.getSitesWithIssues();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ site: "HQ", downCount: 2, warningCount: 1, total: 9, division: "NetEng" });
    expect(r[0].nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  it("short-circuits to empty when no site has issues", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    const r = await noc.getSitesWithIssues();
    expect(r).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("getSlowestResponse", () => {
  it("returns the server-side averaged response times, hydrates names, preserves order, rounds to 0.1", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "a", avg_ms: 642.37 },
      { assetId: "gone", avg_ms: 300 },
      { assetId: "b", avg_ms: 120 },
    ]);
    findMany.mockResolvedValueOnce([
      { id: "b", hostname: "hb", ipAddress: "10.0.0.2" },
      { id: "a", hostname: "ha", ipAddress: "10.0.0.1" },
    ]);
    const r = await noc.getSlowestResponse();
    expect(r.map((x) => x.id)).toEqual(["a", "b"]); // 'gone' dropped, SQL order kept
    expect(r[0].value).toBe(642.4);
  });
});

describe("getHighestDiskUsage", () => {
  it("hydrates per-volume rows with hostname + mount-path detail, preserves SQL order, dedupes the id lookup", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "a", mountPath: "/var", pct: 96.27 },
      { assetId: "a", mountPath: "/", pct: 71.4 },   // same asset, second volume
      { assetId: "gone", mountPath: "/data", pct: 88 },
    ]);
    findMany.mockResolvedValueOnce([
      { id: "a", hostname: "db-04", ipAddress: "10.0.0.1" },
    ]);
    const r = await noc.getHighestDiskUsage();
    // 'gone' has no asset row → dropped; both of 'a's volumes kept, order preserved
    expect(r.map((x) => [x.id, x.detail, x.value])).toEqual([
      ["a", "/var", 96.3],
      ["a", "/", 71.4],
    ]);
    // id lookup deduped to the distinct asset set
    expect((findMany.mock.calls[0][0] as { where: { id: { in: string[] } } }).where.id.in).toEqual(["a", "gone"]);
  });

  it("returns empty without hitting findMany when there are no samples", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    const r = await noc.getHighestDiskUsage();
    expect(r).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("getHighestTemperature", () => {
  it("hydrates per-sensor rows with hostname + sensor-name detail, preserves SQL order, dedupes the id lookup", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "a", sensorName: "CPU Temp", value: 84.27 },
      { assetId: "a", sensorName: "Intake", value: 51.9 },  // same asset, second sensor
      { assetId: "gone", sensorName: "PS1 Temp", value: 70 },
    ]);
    findMany.mockResolvedValueOnce([
      { id: "a", hostname: "fgt-plant-a", ipAddress: "10.0.0.1" },
    ]);
    const r = await noc.getHighestTemperature();
    // 'gone' has no asset row → dropped; both of 'a's sensors kept, order preserved
    expect(r.map((x) => [x.id, x.detail, x.value])).toEqual([
      ["a", "CPU Temp", 84.3],
      ["a", "Intake", 51.9],
    ]);
    // id lookup deduped to the distinct asset set
    expect((findMany.mock.calls[0][0] as { where: { id: { in: string[] } } }).where.id.in).toEqual(["a", "gone"]);
  });

  it("returns empty without hitting findMany when there are no samples", async () => {
    rawUnsafe.mockResolvedValueOnce([]);
    const r = await noc.getHighestTemperature();
    expect(r).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("getFilterOptions", () => {
  it("offers every built-in plus every CUSTOM registry type, registry-labelled", async () => {
    findMany
      .mockResolvedValueOnce([
        { assetType: "firewall" }, { assetType: "network_camera" }, { assetType: "acme-widget" },
      ])
      .mockResolvedValueOnce([]);
    typeDefFindMany.mockResolvedValueOnce([
      { name: "network_camera", label: "Network Camera" },
      { name: "access_point", label: "Access Point" },
      // A type the operator just created in Server Settings, nothing typed as
      // it yet. It still gets a checkbox: the registry is the vocabulary the
      // operator sees, so it is the vocabulary the grid offers.
      { name: "plc", label: "PLC" },
    ]);
    rawQuery.mockResolvedValueOnce([]);
    const r = await noc.getFilterOptions();
    const names = r.assetTypes.map((t) => t.name);
    // Built-ins lead, in canonical order, whether or not the fleet owns any.
    expect(names.slice(0, BUILT_IN_ASSET_TYPES.length)).toEqual([...BUILT_IN_ASSET_TYPES]);
    // Then the customs by label: the registry's two ('plc' asset-less), plus
    // 'acme-widget', which no registry row claims but a live asset still wears.
    expect(names.slice(BUILT_IN_ASSET_TYPES.length)).toEqual(["acme-widget", "network_camera", "plc"]);
    // The registry supplies the label; a name with no row is humanized so the
    // grid never shows a raw snake_case value.
    expect(r.assetTypes.find((t) => t.name === "network_camera")!.label).toBe("Network Camera");
    expect(r.assetTypes.find((t) => t.name === "acme-widget")!.label).toBe("Acme-Widget");
    expect(r.assetTypes.find((t) => t.name === "access_point")!.label).toBe("Access Point");
  });

  it("returns distinct region tags and sorted FortiGate {name, regions} entries", async () => {
    findMany
      .mockResolvedValueOnce([
        { assetType: "firewall" }, { assetType: "server" },
      ])
      // 2nd findMany: distinct firewall learnedLocation values (unsorted from
      // the DB) + each gate's tags (region: prefix stripped, others dropped)
      .mockResolvedValueOnce([
        { learnedLocation: "RIVERBEND-FG", tags: ["region:Central Kentucky", "site:quarry"] },
        { learnedLocation: "ATLANTA-FG", tags: [] },
      ]);
    rawQuery.mockResolvedValueOnce([{ region: "East" }, { region: "West" }]);
    const r = await noc.getFilterOptions();
    expect(r.regions).toEqual(["East", "West"]);
    expect(r.fortigates).toEqual([
      { name: "ATLANTA-FG", regions: [] },
      { name: "RIVERBEND-FG", regions: ["Central Kentucky"] },
    ]); // sorted by name; regions = the gate's own region tags for picker narrowing
    // The FortiGate list is firewall learnedLocation values (the device name
    // switches/APs/endpoints reference), live assets only.
    expect(findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        assetType: "firewall",
        learnedLocation: { not: null },
        status: { notIn: ["decommissioned", "disabled"] },
      }),
      distinct: ["learnedLocation"],
    }));
  });
});

describe("getNocSummaryPayload", () => {
  beforeEach(() => {
    noc.clearNocFeedCache();
  });

  function grantAll() {
    return { canAssets: true, canEvents: true, assetTypes: null, regionNames: null, capLimit: null };
  }

  it("returns only the requested feeds, flattened to the legacy response keys", async () => {
    groupBy
      .mockResolvedValueOnce([{ monitorStatus: "up", _count: { _all: 3 } }]) // status: all monitored
      .mockResolvedValueOnce([]);                                            // status: infra subset
    // activeAlertCount + downNodes total return 1; the status feed's
    // maintenance-window count (where.status === "maintenance") returns 0.
    count.mockImplementation((args?: { where?: { status?: unknown } }) =>
      Promise.resolve(args?.where?.status === "maintenance" ? 0 : 1));
    findMany.mockResolvedValueOnce([
      { id: "a", hostname: "fw", ipAddress: null, assetType: "firewall", location: "HQ", learnedLocation: null, snmpLocation: null, department: null, monitorStatus: "down", monitorStatusChangedAt: null },
    ]);

    const r = await noc.getNocSummaryPayload({ feeds: ["status", "downNodes"], ...grantAll() });
    expect(Object.keys(r).sort()).toEqual(["activeAlertCount", "downNodes", "downNodesTotal", "statusCounts", "uptimePercent"]);
    expect((r.statusCounts as { total: number }).total).toBe(3);
    expect((r.downNodes as Array<{ id: string }>).map((n) => n.id)).toEqual(["a"]);
    expect(r.downNodesTotal).toBe(1);
  });

  it("null feeds returns the full payload shape", async () => {
    groupBy.mockResolvedValue([]);
    count.mockResolvedValue(0);
    findMany.mockResolvedValue([]);
    eventFindMany.mockResolvedValue([]);
    rawUnsafe.mockResolvedValue([]);
    resolve.mockResolvedValue({ intervalSeconds: 60 });

    const r = await noc.getNocSummaryPayload({ feeds: null, ...grantAll() });
    expect(Object.keys(r).sort()).toEqual([
      "activeAlertCount", "activeAlerts", "activeAlertsTotal", "diskUsage", "downInterfaces",
      "downIpsecTunnels", "downNodes", "downNodesTotal", "packetLoss", "recentReboots",
      "sitesWithIssues", "slowestResponse", "stalePolls", "statusCounts", "storageForecast",
      "temperature", "topCpu", "topMemory", "uptimePercent",
    ]);
  });

  it("permission-denied feeds return their empty value without touching the DB", async () => {
    const r = await noc.getNocSummaryPayload({
      feeds: null, canAssets: false, canEvents: false, assetTypes: null, regionNames: null, capLimit: null,
    });
    expect(r.statusCounts).toEqual({ total: 0, up: 0, down: 0, warning: 0, unknown: 0, recovering: 0, passive: 0, maintenance: 0 });
    expect(r.downNodes).toEqual([]);
    expect(r.downNodesTotal).toBe(0);
    expect(r.activeAlerts).toEqual([]);
    expect(r.activeAlertsTotal).toBe(0);
    expect(groupBy).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(eventFindMany).not.toHaveBeenCalled();
    expect(rawUnsafe).not.toHaveBeenCalled();
  });

  it("keys the downNodes cache on includeDependencyDown (a toggle can't be served a stale list)", async () => {
    count.mockResolvedValue(0);
    findMany.mockResolvedValue([]);
    await noc.getNocSummaryPayload({ feeds: ["downNodes"], ...grantAll() });
    await noc.getNocSummaryPayload({ feeds: ["downNodes"], ...grantAll(), includeDependencyDown: true });
    expect(findMany).toHaveBeenCalledTimes(2);
    expect((findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where)
      .toMatchObject({ dependencySuppressed: false });
    expect((findMany.mock.calls[1][0] as { where: Record<string, unknown> }).where)
      .not.toHaveProperty("dependencySuppressed");
    // Same request twice still shares the cache.
    await noc.getNocSummaryPayload({ feeds: ["downNodes"], ...grantAll(), includeDependencyDown: true });
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("drops unknown feed names silently", async () => {
    const r = await noc.getNocSummaryPayload({ feeds: ["bogus"], ...grantAll() });
    expect(r).toEqual({});
    expect(rawUnsafe).not.toHaveBeenCalled();
  });

  it("serves repeat requests for the same (feed, filter, cap) from the TTL cache", async () => {
    rawUnsafe.mockResolvedValue([{ assetId: "a", value: 50 }]);
    findMany.mockResolvedValue([{ id: "a", hostname: "h", ipAddress: null }]);

    await noc.getNocSummaryPayload({ feeds: ["topCpu"], ...grantAll() });
    await noc.getNocSummaryPayload({ feeds: ["topCpu"], ...grantAll() });
    expect(rawUnsafe).toHaveBeenCalledTimes(1); // second call was a cache hit

    // A different row cap is a different cache entry.
    await noc.getNocSummaryPayload({ feeds: ["topCpu"], ...grantAll(), capLimit: 1000 });
    expect(rawUnsafe).toHaveBeenCalledTimes(2);
  });

  it("keys the feed cache on the fortigates filter (per-site widgets don't share unfiltered payloads)", async () => {
    rawUnsafe.mockResolvedValue([]);
    findMany.mockResolvedValue([]);

    await noc.getNocSummaryPayload({ feeds: ["topCpu"], ...grantAll(), fortigateNames: ["RIVERBEND-FG"] });
    expect(rawUnsafe).toHaveBeenCalledTimes(1);
    // Same gate = cache hit; different gate (or none) = fresh computation.
    await noc.getNocSummaryPayload({ feeds: ["topCpu"], ...grantAll(), fortigateNames: ["RIVERBEND-FG"] });
    expect(rawUnsafe).toHaveBeenCalledTimes(1);
    await noc.getNocSummaryPayload({ feeds: ["topCpu"], ...grantAll(), fortigateNames: ["ASHFIELD-FG"] });
    expect(rawUnsafe).toHaveBeenCalledTimes(2);
    await noc.getNocSummaryPayload({ feeds: ["topCpu"], ...grantAll() });
    expect(rawUnsafe).toHaveBeenCalledTimes(3);
  });

  it("applies the caller's capLimit to the feed query", async () => {
    rawUnsafe.mockResolvedValue([]);
    await noc.getNocSummaryPayload({ feeds: ["topCpu"], ...grantAll(), capLimit: 1000 });
    // getHighestCpu binds LIMIT as the 2nd parameter.
    expect(rawUnsafe.mock.calls[0][2]).toBe(1000);
  });

  it("threads sampleCount into the sample-averaged feeds and keys the cache on it", async () => {
    rawUnsafe.mockResolvedValue([]);
    findMany.mockResolvedValue([]);

    await noc.getNocSummaryPayload({ feeds: ["topCpu"], ...grantAll(), sampleCount: 30 });
    // getHighestCpu binds sampleCount as the 3rd parameter; the window (1st
    // parameter, minutes) widens to hold 30 samples (30 × 6 = 180).
    expect(rawUnsafe.mock.calls[0][3]).toBe(30);
    expect(rawUnsafe.mock.calls[0][1]).toBe("180");

    // Same sampleCount = cache hit; a different sampleCount recomputes.
    await noc.getNocSummaryPayload({ feeds: ["topCpu"], ...grantAll(), sampleCount: 30 });
    expect(rawUnsafe).toHaveBeenCalledTimes(1);
    await noc.getNocSummaryPayload({ feeds: ["topCpu"], ...grantAll(), sampleCount: 5 });
    expect(rawUnsafe).toHaveBeenCalledTimes(2);

    // Absent sampleCount = the default (10), bound with the historical 60-min window.
    await noc.getNocSummaryPayload({ feeds: ["topCpu"], ...grantAll() });
    expect(rawUnsafe.mock.calls[2][3]).toBe(10);
    expect(rawUnsafe.mock.calls[2][1]).toBe("60");
  });
});

describe("resolveFilteredAssetIds", () => {
  it("returns null (no narrowing) when neither asset types nor regions filter", async () => {
    const r = await noc.resolveFilteredAssetIds({ assetTypes: null, regionNames: null });
    expect(r).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns null when every built-in type is enabled and there is no region filter", async () => {
    const all = [...BUILT_IN_ASSET_TYPES];
    const r = await noc.resolveFilteredAssetIds({ assetTypes: all, regionNames: [] });
    expect(r).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("filters by hidden built-in types (notIn) and region tags (hasSome region:<name>)", async () => {
    findMany.mockResolvedValueOnce([{ id: "x" }, { id: "y" }]);
    const r = await noc.resolveFilteredAssetIds({ assetTypes: ["server", "switch"], regionNames: ["East"] });
    expect(r).toEqual(["x", "y"]);
    const where = (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.assetType).toEqual({
      notIn: BUILT_IN_ASSET_TYPES.filter((t) => !["server", "switch"].includes(t)),
    });
    expect(where.tags).toEqual({ hasSome: ["region:East"] });
  });

  // The dimension the gear grid writes: names to hide outright. It is the only
  // one that can hide a CUSTOM type — the legacy enabled list derives its
  // hidden set from the built-ins, so a custom name was never in it.
  it("hides the named types, custom ones included", async () => {
    findMany.mockResolvedValueOnce([{ id: "a" }]);
    const r = await noc.resolveFilteredAssetIds({
      hideAssetTypes: ["network_camera", "printer"],
      regionNames: null,
    });
    expect(r).toEqual(["a"]);
    const where = (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.assetType).toEqual({ notIn: ["network_camera", "printer"] });
  });

  it("returns null when the hidden list is empty (nothing narrows)", async () => {
    const r = await noc.resolveFilteredAssetIds({ hideAssetTypes: [], regionNames: null });
    expect(r).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  // A stale bundle can send both. Union, not last-writer-wins: each names part
  // of what the operator switched off.
  it("unions the hidden list with a legacy enabled list", async () => {
    findMany.mockResolvedValueOnce([]);
    await noc.resolveFilteredAssetIds({
      assetTypes: ["server", "switch"],
      hideAssetTypes: ["network_camera"],
      regionNames: null,
    });
    const where = (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.assetType).toEqual({
      notIn: [
        "network_camera",
        ...BUILT_IN_ASSET_TYPES.filter((t) => !["server", "switch"].includes(t)),
      ],
    });
  });

  it("filters by FortiGate names across both haystacks (learnedLocation OR sighting rows, exact-insensitive)", async () => {
    findMany.mockResolvedValueOnce([{ id: "sw1" }]);
    const r = await noc.resolveFilteredAssetIds({ assetTypes: null, regionNames: null, fortigateNames: ["RIVERBEND-FG"] });
    expect(r).toEqual(["sw1"]);
    const where = (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.OR).toEqual([
      { learnedLocation: { equals: "RIVERBEND-FG", mode: "insensitive" } },
      { fortigateSightings: { some: { fortigateDevice: { equals: "RIVERBEND-FG", mode: "insensitive" } } } },
    ]);
  });

  it("__none__ sentinel matches gate-less assets (no sightings, learnedLocation not a known gate name)", async () => {
    findMany
      // 1st findMany: the known-gate name lookup (firewall learnedLocations)
      .mockResolvedValueOnce([{ learnedLocation: "RIVERBEND-FG" }])
      // 2nd findMany: the id-set resolution
      .mockResolvedValueOnce([{ id: "standalone-sw" }]);
    const r = await noc.resolveFilteredAssetIds({ assetTypes: null, regionNames: null, fortigateNames: ["__none__"] });
    expect(r).toEqual(["standalone-sw"]);
    const where = (findMany.mock.calls[1][0] as { where: Record<string, unknown> }).where;
    expect(where.OR).toEqual([
      {
        AND: [
          { OR: [{ learnedLocation: null }, { learnedLocation: { notIn: ["RIVERBEND-FG"] } }] },
          { fortigateSightings: { none: {} } },
        ],
      },
    ]);
  });

  it("__none__ combines with named gates in one OR (a site plus its strays)", async () => {
    findMany
      .mockResolvedValueOnce([]) // no known gates on record
      .mockResolvedValueOnce([]);
    await noc.resolveFilteredAssetIds({ assetTypes: null, regionNames: null, fortigateNames: ["RIVERBEND-FG", "__none__"] });
    const where = (findMany.mock.calls[1][0] as { where: Record<string, unknown> }).where;
    const or = where.OR as unknown[];
    expect(or.length).toBe(3); // 2 haystacks for the named gate + 1 gate-less arm
    expect(or[2]).toEqual({ AND: [{}, { fortigateSightings: { none: {} } }] });
  });

  it("ANDs the FortiGate narrowing with asset types (one site's switches/APs)", async () => {
    findMany.mockResolvedValueOnce([]);
    await noc.resolveFilteredAssetIds({
      assetTypes: ["switch", "access_point"],
      regionNames: null,
      fortigateNames: ["RIVERBEND-FG", "ASHFIELD-FG"],
    });
    const where = (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    // Both dimensions present as sibling keys = implicit Prisma AND.
    expect(where.assetType).toEqual({
      notIn: BUILT_IN_ASSET_TYPES.filter((t) => !["switch", "access_point"].includes(t)),
    });
    expect((where.OR as unknown[]).length).toBe(4); // 2 gates × 2 haystacks
  });
});

describe("alert-severity-aware ordering", () => {
  it("activeAlertSeverityByAsset keeps the HIGHEST severity per asset and maps legacy values", async () => {
    notifFindMany.mockResolvedValueOnce([
      { id: "n1", assetId: "a", severity: "warning", acknowledged: false },
      { id: "n2", assetId: "a", severity: "critical", acknowledged: false },
      { id: "n3", assetId: "b", severity: "info", acknowledged: false },     // legacy → rank 2
      { id: "n4", assetId: "c", severity: "error", acknowledged: true },     // legacy → rank 5
      { id: "n5", assetId: null, severity: "critical", acknowledged: false }, // host alert — no asset key
    ]);
    const m = await noc.activeAlertSeverityByAsset(["a", "b", "c"]);
    // The winner names itself and says whether someone has it, so a widget row
    // can offer Acknowledge for the same alert its pill is showing.
    expect(m.get("a")).toEqual({ severity: "critical", rank: 5, id: "n2", acknowledged: false });
    expect(m.get("b")).toEqual({ severity: "info", rank: 2, id: "n3", acknowledged: false });
    expect(m.get("c")).toEqual({ severity: "error", rank: 5, id: "n4", acknowledged: true });
    expect(m.has("")).toBe(false);
  });

  it("getDownNodes floats alerted nodes above newer unalerted outages (stable within rank)", async () => {
    const older = new Date("2026-07-01T00:00:00Z");
    const newer = new Date("2026-07-20T00:00:00Z");
    findMany.mockResolvedValueOnce([
      // Feed order = youngest outage first (the server orderBy).
      { id: "fresh", hostname: "fresh", ipAddress: null, assetType: "switch", location: "HQ", learnedLocation: null, snmpLocation: null, department: null, monitorStatus: "down", monitorStatusChangedAt: newer },
      { id: "alerted", hostname: "alerted", ipAddress: null, assetType: "switch", location: "HQ", learnedLocation: null, snmpLocation: null, department: null, monitorStatus: "down", monitorStatusChangedAt: older },
    ]);
    count.mockResolvedValueOnce(2);
    notifFindMany.mockResolvedValueOnce([
      { assetId: "alerted", severity: "serious", rule: { trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" } } },
    ]);
    const r = await noc.getDownNodes();
    expect(r.nodes.map((n) => n.id)).toEqual(["alerted", "fresh"]);
    expect(r.nodes[0].alertSeverity).toBe("serious");
    expect(r.nodes[0].alertRank).toBe(4);
    expect(r.nodes[1].alertRank).toBe(0);
  });

  it("getHighestTemperature ranks a cooler-but-alerted sensor above a hotter unalerted one", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "hot", sensorName: "cpu", value: 88 },
      { assetId: "warm", sensorName: "cpu", value: 61 },
    ]);
    findMany.mockResolvedValueOnce([
      { id: "hot", hostname: "hot", ipAddress: null, location: null, learnedLocation: null, snmpLocation: null },
      { id: "warm", hostname: "warm", ipAddress: null, location: null, learnedLocation: null, snmpLocation: null },
    ]);
    notifFindMany.mockResolvedValueOnce([
      { assetId: "warm", severity: "critical", rule: { trigger: { type: "asset_metric", metric: "hwSensorValue", operator: ">", threshold: 80 } } },
    ]);
    const r = await noc.getHighestTemperature();
    expect(r.map((x) => x.id)).toEqual(["warm", "hot"]);
    expect(r[0].alertSeverity).toBe("critical");
    // Value ordering still holds within the unalerted band.
    expect(r[1].value).toBe(88);
  });

});

describe("per-widget alert relevance (pill only when a matching automation fires)", () => {
  it("getHighestCpu does NOT pill an asset whose only active alert is a DISK automation", async () => {
    // The exact reported bug: a 6.1% CPU firewall shown as 'serious' because it
    // has an unrelated disk-full alert. The CPU widget must ignore it.
    rawUnsafe.mockResolvedValueOnce([{ assetId: "fw", value: 6.1 }]);
    findMany.mockResolvedValueOnce([
      { id: "fw", hostname: "fw", ipAddress: null, location: null, learnedLocation: null, snmpLocation: null },
    ]);
    notifFindMany.mockResolvedValueOnce([
      { assetId: "fw", severity: "serious", rule: { trigger: { type: "asset_metric", metric: "storageUsedPct", operator: ">", threshold: 90 } } },
    ]);
    const r = await noc.getHighestCpu();
    expect(r[0].alertSeverity).toBeUndefined();
    expect(r[0].alertRank).toBe(0);
  });

  it("getHighestCpu pills an asset whose active alert IS a cpuPct automation", async () => {
    rawUnsafe.mockResolvedValueOnce([{ assetId: "fw", value: 95 }]);
    findMany.mockResolvedValueOnce([
      { id: "fw", hostname: "fw", ipAddress: null, location: null, learnedLocation: null, snmpLocation: null },
    ]);
    notifFindMany.mockResolvedValueOnce([
      { assetId: "fw", severity: "critical", rule: { trigger: { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 } } },
    ]);
    const r = await noc.getHighestCpu();
    expect(r[0].alertSeverity).toBe("critical");
  });

  it("a composite trigger pills the widget when ANY leaf matches its metric", async () => {
    rawUnsafe.mockResolvedValueOnce([{ assetId: "fw", value: 92 }]);
    findMany.mockResolvedValueOnce([
      { id: "fw", hostname: "fw", ipAddress: null, location: null, learnedLocation: null, snmpLocation: null },
    ]);
    notifFindMany.mockResolvedValueOnce([
      {
        assetId: "fw",
        severity: "serious",
        rule: {
          trigger: {
            type: "composite",
            kind: "asset",
            op: "or",
            children: [
              { type: "asset_metric", metric: "memPct", operator: ">", threshold: 90 },
              { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 },
            ],
          },
        },
      },
    ]);
    const r = await noc.getHighestCpu();
    expect(r[0].alertSeverity).toBe("serious");
  });

  it("activeAlertSeverityByAsset filters out non-matching triggers under a metric relevance", async () => {
    notifFindMany.mockResolvedValueOnce([
      { id: "n-a", assetId: "a", severity: "critical", acknowledged: false, rule: { trigger: { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 } } },
      { id: "n-b", assetId: "b", severity: "critical", acknowledged: false, rule: { trigger: { type: "asset_metric", metric: "storageUsedPct", operator: ">", threshold: 90 } } },
      { id: "n-c", assetId: "c", severity: "warning", acknowledged: false, rule: null }, // rule deleted → matches nothing specific
    ]);
    const m = await noc.activeAlertSeverityByAsset(["a", "b", "c"], { kind: "metric", metrics: ["cpuPct"] });
    expect(m.get("a")).toEqual({ severity: "critical", rank: 5, id: "n-a", acknowledged: false });
    expect(m.has("b")).toBe(false);
    expect(m.has("c")).toBe(false);
  });

  it("getRecentReboots pills via the device.reboot event automation (glob actionPattern)", async () => {
    eventFindMany.mockResolvedValueOnce([
      { resourceId: "fw", resourceName: "fw", timestamp: new Date("2026-07-22T00:00:00Z"), details: {} },
    ]);
    notifFindMany.mockResolvedValueOnce([
      { assetId: "fw", severity: "notice", rule: { trigger: { type: "event", actionPattern: "device.*" } } },
    ]);
    const r = await noc.getRecentReboots();
    expect(r[0].alertSeverity).toBe("notice");
  });
});

describe("getStorageForecast", () => {
  it("hydrates forecast rows and sorts severity-first, then soonest-full", async () => {
    rawUnsafe.mockResolvedValueOnce([
      { assetId: "soon", mountPath: "/var", slope_per_day: 10e9, points: 12, last_used: 90e9, total_bytes: 100e9 },  // 1 day
      { assetId: "later", mountPath: "C:", slope_per_day: 1e9, points: 30, last_used: 50e9, total_bytes: 100e9 },    // 50 days
    ]);
    findMany.mockResolvedValueOnce([
      { id: "soon", hostname: "soon", ipAddress: null, location: null, learnedLocation: null, snmpLocation: null },
      { id: "later", hostname: "later", ipAddress: null, location: null, learnedLocation: null, snmpLocation: null },
    ]);
    // The later-full asset carries an active critical alert — it still leads.
    notifFindMany.mockResolvedValueOnce([
      { assetId: "later", severity: "critical", rule: { trigger: { type: "asset_metric", metric: "storageDaysUntilFull", operator: "<", threshold: 7 } } },
    ]);
    const r = await noc.getStorageForecast();
    expect(r.map((x) => [x.id, x.value])).toEqual([["later", 50], ["soon", 1]]);
    expect(r[0].alertSeverity).toBe("critical");
    expect(r[0].detail).toBe("C:");
    expect(r[1].usedPct).toBe(90);
  });
});
