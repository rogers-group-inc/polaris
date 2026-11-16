/**
 * tests/unit/fortinetLinkStateService.test.ts
 *
 * Own suite for src/services/fortinetLinkStateService.ts — the FortiLink /
 * CAPWAP controller-link sweep. The three refusals, the batching and the
 * firmware handoff are pinned in tests/unit/fortinetLinkState.test.ts; this
 * file covers what that one does not: the load query, the grouping rules
 * (which integration, which controller name, which kind), serial matching,
 * the raw-status column, Event attribution, the metric and the swallowed
 * reconcile failure.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  inventories: new Map<string, Map<string, { connected: boolean; status: string; osVersion?: string }> | Error>(),
  loggedEvents: [] as Array<Record<string, unknown>>,
  reconcile: vi.fn(),
  recordFortilinkState: vi.fn(),
  fetchInventory: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/monitoringService.js", () => ({
  fetchFortinetControllerInventory: h.fetchInventory,
  resolveMonitorSettings: vi.fn(async () => ({ systemInfoIntervalSeconds: 600, interfacesPolling: "rest_api" })),
}));
vi.mock("../../src/services/eventLogService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/eventLogService.js")>();
  return {
    ...actual,
    logEventsBatch: vi.fn(async (inputs: Array<Record<string, unknown>>) => {
      h.loggedEvents.push(...inputs);
      return inputs.length;
    }),
  };
});
vi.mock("../../src/metrics.js", () => ({ recordFortilinkState: h.recordFortilinkState }));
vi.mock("../../src/services/fortinetLiveVersionService.js", () => ({ reconcileFortinetLiveVersions: h.reconcile }));
vi.mock("../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { logEventsBatch } from "../../src/services/eventLogService.js";
import { sweepFortinetLinkState } from "../../src/services/fortinetLinkStateService.js";

const FMG = { id: "i-fmg", type: "fortimanager", name: "CENTRAL-FMG", config: {} };

function asset(over: Record<string, unknown> = {}) {
  return {
    id: "a1", hostname: "SW-1", ipAddress: "10.0.0.5", assetType: "switch", serialNumber: "S1",
    fortinetTopology: { controllerFortigate: "GATE-A" },
    fortilinkStatus: null, fortilinkStatusRaw: null, discoveredByIntegrationId: "i-fmg", osVersion: null,
    fortilinkCheckedAt: null, monitored: true,
    ...over,
  };
}

function setInventory(device: string, kind: "switches" | "aps", rows: Record<string, { connected: boolean; status: string; osVersion?: string }> | Error) {
  h.inventories.set(`${device}::${kind}`, rows instanceof Error ? rows : new Map(Object.entries(rows)));
}

function statusWrites(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [arg] of stubbed(prisma.asset.updateMany).mock.calls) {
    if (!("fortilinkStatus" in arg.data)) continue;
    for (const id of arg.where.id.in) out[id] = arg.data.fortilinkStatus;
  }
  return out;
}

beforeEach(() => {
  resetDbStub();
  h.inventories.clear();
  h.loggedEvents.length = 0;
  h.reconcile.mockReset().mockResolvedValue(0);
  h.recordFortilinkState.mockReset();
  h.fetchInventory.mockReset().mockImplementation(async (_i: unknown, device: string, kind: string) => {
    const hit = h.inventories.get(`${device}::${kind}`);
    if (hit instanceof Error) throw hit;
    return { inventory: hit ?? new Map(), fetchDurationMs: 3 };
  });
  stubbed(prisma.integration.findMany).mockResolvedValue([FMG]);
  stubbed(prisma.asset.findMany).mockResolvedValue([]);
  stubbed(prisma.asset.updateMany).mockResolvedValue({ count: 0 });
  stubbed(prisma.asset.update).mockResolvedValue({});
});

describe("loading what to sweep", () => {
  it("returns a zero result without reading assets when no Fortinet integration is enabled", async () => {
    stubbed(prisma.integration.findMany).mockResolvedValue([]);

    const result = await sweepFortinetLinkState();

    expect(result).toEqual({ controllersRead: 0, controllersFailed: 0, transitions: 0, unchanged: 0 });
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
    expect(h.fetchInventory).not.toHaveBeenCalled();
    // An empty pass returns before the metric is recorded.
    expect(h.recordFortilinkState).not.toHaveBeenCalled();
  });

  it("asks only for enabled fortimanager / fortigate integrations", async () => {
    await sweepFortinetLinkState();
    expect(prisma.integration.findMany).toHaveBeenCalledWith({
      where: { type: { in: ["fortimanager", "fortigate"] }, enabled: true },
      select: { id: true, type: true, name: true, config: true },
    });
  });

  it("loads switches and APs with a serial, outside decommission and maintenance, discovered by those integrations, with a tight select", async () => {
    stubbed(prisma.integration.findMany).mockResolvedValue([FMG, { id: "i-fg", type: "fortigate", name: "FG", config: { host: "h" } }]);

    await sweepFortinetLinkState();

    const arg = stubbed(prisma.asset.findMany).mock.calls[0][0];
    expect(arg.where).toEqual({
      assetType: { in: ["switch", "access_point"] },
      status: { notIn: ["decommissioned", "maintenance"] },
      discoveredByIntegrationId: { in: ["i-fmg", "i-fg"] },
      serialNumber: { not: null },
    });
    // No monitored filter in the query: an unmonitored device is loaded so its
    // stale value can be cleared (rule 59(a)), but it is never swept.
    expect(Object.keys(arg.select).sort()).toEqual([
      "assetType", "cpuMemoryIntervalSec", "discoveredByIntegrationId", "fortilinkCheckedAt",
      "fortilinkStatus", "fortilinkStatusRaw", "fortinetTopology", "hostname", "id",
      "interfacesCredentialId", "interfacesPolling", "ipAddress", "monitorIntervalSec", "monitored",
      "osVersion", "probeTimeoutMs", "serialNumber", "systemInfoIntervalSec", "temperatureIntervalSec",
    ]);
  });

  it("does not read controllers when no asset qualifies", async () => {
    const result = await sweepFortinetLinkState();
    expect(h.fetchInventory).not.toHaveBeenCalled();
    expect(result.controllersRead).toBe(0);
  });
});

describe("controller grouping", () => {
  it("skips an asset whose integration row did not come back", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ discoveredByIntegrationId: "i-gone" })]);
    await sweepFortinetLinkState();
    expect(h.fetchInventory).not.toHaveBeenCalled();
  });

  it("skips a FortiManager-discovered device with no controller stamp (no host fallback for FMG)", async () => {
    stubbed(prisma.integration.findMany).mockResolvedValue([{ ...FMG, config: { host: "fmg.example" } }]);
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ fortinetTopology: null })]);
    await sweepFortinetLinkState();
    expect(h.fetchInventory).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only or non-string stamp as absent", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([
      asset({ id: "a1", fortinetTopology: { controllerFortigate: "   " } }),
      asset({ id: "a2", fortinetTopology: { controllerFortigate: 42 } }),
    ]);
    await sweepFortinetLinkState();
    expect(h.fetchInventory).not.toHaveBeenCalled();
  });

  it("trims the stamped controller name before using it as the wire / cache key", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ fortinetTopology: { controllerFortigate: "  GATE-A  " } })]);
    setInventory("GATE-A", "switches", { S1: { connected: true, status: "Connected" } });

    await sweepFortinetLinkState();

    expect(h.fetchInventory.mock.calls[0][1]).toBe("GATE-A");
    expect(statusWrites()).toEqual({ a1: "up" });
  });

  it("prefers the topology stamp over the integration host for a standalone FortiGate", async () => {
    stubbed(prisma.integration.findMany).mockResolvedValue([{ id: "i-fg", type: "fortigate", name: "FG", config: { host: "10.9.9.9" } }]);
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ discoveredByIntegrationId: "i-fg", fortinetTopology: { controllerFortigate: "FG-NAME" } })]);

    await sweepFortinetLinkState();

    expect(h.fetchInventory.mock.calls[0][1]).toBe("FG-NAME");
  });

  it("skips a standalone FortiGate device when neither a stamp nor a host exists", async () => {
    stubbed(prisma.integration.findMany).mockResolvedValue([{ id: "i-fg", type: "fortigate", name: "FG", config: {} }]);
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ discoveredByIntegrationId: "i-fg", fortinetTopology: {} })]);
    await sweepFortinetLinkState();
    expect(h.fetchInventory).not.toHaveBeenCalled();
  });

  it("passes the integration with a normalized config, the kind and the 20 s timeout", async () => {
    stubbed(prisma.integration.findMany).mockResolvedValue([{ ...FMG, config: null }]);
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ assetType: "access_point" })]);

    await sweepFortinetLinkState();

    expect(h.fetchInventory).toHaveBeenCalledWith(
      { id: "i-fmg", type: "fortimanager", name: "CENTRAL-FMG", config: {} },
      "GATE-A",
      "aps",
      20_000,
    );
  });

  it("keeps the same controller name under two integrations as two groups", async () => {
    stubbed(prisma.integration.findMany).mockResolvedValue([FMG, { id: "i-fmg2", type: "fortimanager", name: "FMG2", config: {} }]);
    stubbed(prisma.asset.findMany).mockResolvedValue([
      asset({ id: "a1", serialNumber: "S1" }),
      asset({ id: "a2", serialNumber: "S2", discoveredByIntegrationId: "i-fmg2" }),
    ]);

    const result = await sweepFortinetLinkState();

    expect(h.fetchInventory).toHaveBeenCalledTimes(2);
    expect(h.fetchInventory.mock.calls.map((c) => c[0].id).sort()).toEqual(["i-fmg", "i-fmg2"]);
    expect(result.controllersRead).toBe(2);
  });
});

describe("serial matching and the raw word", () => {
  it("matches a stored lower-case, padded serial against the upper-cased inventory key", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ serialNumber: "  s1  " })]);
    setInventory("GATE-A", "switches", { S1: { connected: false, status: "Disconnected" } });

    await sweepFortinetLinkState();

    expect(statusWrites()).toEqual({ a1: "down" });
  });

  it("reads a blank serial as unknown without consulting the inventory", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ serialNumber: "   ", fortilinkStatus: "up" })]);
    setInventory("GATE-A", "switches", { "": { connected: true, status: "Connected" } });

    await sweepFortinetLinkState();

    expect(statusWrites()).toEqual({ a1: "unknown" });
  });

  it("stores an empty raw status word as null", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ assetType: "access_point", fortilinkStatus: "down", fortilinkStatusRaw: "offline" })]);
    // An empty AP status gets isFortiapStatusOnline's benefit of the doubt (up).
    setInventory("GATE-A", "aps", { S1: { connected: false, status: "" } });

    await sweepFortinetLinkState();

    expect(statusWrites()).toEqual({ a1: "up" });
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { fortilinkStatusRaw: null } });
  });

  it("clears the raw word to null when a device leaves the table", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ fortilinkStatus: "up", fortilinkStatusRaw: "Connected" })]);
    setInventory("GATE-A", "switches", {});

    await sweepFortinetLinkState();

    expect(statusWrites()).toEqual({ a1: "unknown" });
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { fortilinkStatusRaw: null } });
  });

  it("issues no raw-word update for a steady device whose word did not move", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ fortilinkStatus: "up", fortilinkStatusRaw: "Connected" })]);
    setInventory("GATE-A", "switches", { S1: { connected: true, status: "Connected" } });

    const result = await sweepFortinetLinkState();

    expect(result).toMatchObject({ unchanged: 1, transitions: 0 });
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(prisma.asset.updateMany).toHaveBeenCalledTimes(1);
  });

  it("uses one timestamp for every write in the pass, and changedAt equals checkedAt on a transition", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([
      asset({ id: "a1", serialNumber: "S1", fortilinkStatus: "up" }),
      asset({ id: "a2", serialNumber: "S2", fortilinkStatus: "up" }),
    ]);
    setInventory("GATE-A", "switches", {
      S1: { connected: false, status: "Disconnected" },
      S2: { connected: true, status: "Connected" },
    });

    await sweepFortinetLinkState();

    const calls = stubbed(prisma.asset.updateMany).mock.calls.map((c) => c[0].data);
    const moved = calls.find((d) => "fortilinkStatus" in d)!;
    const confirmed = calls.find((d) => !("fortilinkStatus" in d))!;
    expect(moved.fortilinkChangedAt).toBe(moved.fortilinkCheckedAt);
    expect(confirmed.fortilinkCheckedAt).toBe(moved.fortilinkCheckedAt);
  });
});

describe("Events", () => {
  it("attributes the Event to the sweep, the integration and the asset (falling back to the IP for a name)", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ hostname: null, ipAddress: "2001:db8::5", fortilinkStatus: "down" })]);
    setInventory("GATE-A", "switches", { S1: { connected: true, status: "Connected" } });

    await sweepFortinetLinkState();

    expect(h.loggedEvents).toHaveLength(1);
    expect(h.loggedEvents[0]).toMatchObject({
      action: "asset.fortilink.changed",
      resourceId: "a1",
      resourceName: "2001:db8::5",
      actor: "system:fortilink-sweep",
      level: "info",
    });
  });

  it("logs one batch for the whole pass, and no batch when nothing moved", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ fortilinkStatus: "up" })]);
    setInventory("GATE-A", "switches", { S1: { connected: true, status: "Connected" } });
    await sweepFortinetLinkState();
    expect(logEventsBatch).not.toHaveBeenCalled();
  });

  it("logs a transition to unknown as an Event too", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ fortilinkStatus: "up" })]);
    setInventory("GATE-A", "switches", {});

    const result = await sweepFortinetLinkState();

    expect(result.transitions).toBe(1);
    expect(h.loggedEvents).toHaveLength(1);
    expect(String(h.loggedEvents[0].message)).toContain("unknown");
  });
});

describe("metrics and the firmware handoff", () => {
  it("records reads, failures and transitions once per non-empty pass", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([
      asset({ id: "a1", serialNumber: "S1", fortilinkStatus: "up" }),
      asset({ id: "a2", serialNumber: "S2", fortinetTopology: { controllerFortigate: "GATE-DARK" } }),
    ]);
    setInventory("GATE-A", "switches", { S1: { connected: false, status: "Disconnected" } });
    setInventory("GATE-DARK", "switches", new Error("dark"));

    const result = await sweepFortinetLinkState();

    expect(result).toEqual({ controllersRead: 1, controllersFailed: 1, transitions: 1, unchanged: 0 });
    expect(h.recordFortilinkState).toHaveBeenCalledWith(1, 1, 1);
  });

  it("does not call the reconcile when no row carried a version", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset()]);
    setInventory("GATE-A", "switches", { S1: { connected: true, status: "Connected" } });
    await sweepFortinetLinkState();
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("hands over the version for an unchanged device as well as a moved one, named by IP when there is no hostname", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ hostname: "", fortilinkStatus: "up", osVersion: "v1" })]);
    setInventory("GATE-A", "switches", { S1: { connected: true, status: "Connected", osVersion: "S108EP-v7.4.3-build0800" } });

    await sweepFortinetLinkState();

    expect(h.reconcile).toHaveBeenCalledWith([{
      assetId: "a1", hostname: "10.0.0.5", currentOsVersion: "v1",
      liveVersion: "S108EP-v7.4.3-build0800", reader: "fortilink-sweep",
    }]);
  });

  it("swallows a reconcile failure: the sweep still returns its result", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ fortilinkStatus: "down" })]);
    setInventory("GATE-A", "switches", { S1: { connected: true, status: "Connected", osVersion: "S108EP-v7.4.3-build0800" } });
    h.reconcile.mockRejectedValue(new Error("db gone"));

    const result = await sweepFortinetLinkState();

    expect(result.transitions).toBe(1);
    expect(h.recordFortilinkState).toHaveBeenCalledTimes(1);
  });

  it("never writes monitorStatus or any state-machine column", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset({ fortilinkStatus: "up" })]);
    setInventory("GATE-A", "switches", { S1: { connected: false, status: "Disconnected" } });

    await sweepFortinetLinkState();

    const keys = new Set<string>();
    for (const [arg] of stubbed(prisma.asset.updateMany).mock.calls) Object.keys(arg.data).forEach((k) => keys.add(k));
    for (const [arg] of stubbed(prisma.asset.update).mock.calls) Object.keys(arg.data).forEach((k) => keys.add(k));
    expect([...keys].sort()).toEqual(["fortilinkChangedAt", "fortilinkCheckedAt", "fortilinkStatus", "fortilinkStatusRaw"]);
  });
});
