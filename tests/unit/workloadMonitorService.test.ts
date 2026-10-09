import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  fetchUnraidSnapshot: vi.fn(),
  fetchTrueNasSnapshot: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({ prisma: { assetSource: { findFirst: h.findFirst } } }));
vi.mock("../../src/services/unraidService.js", () => ({ fetchUnraidSnapshot: h.fetchUnraidSnapshot }));
vi.mock("../../src/services/truenasService.js", () => ({ fetchTrueNasSnapshot: h.fetchTrueNasSnapshot }));

const wm = await import("../../src/services/workloadMonitorService.js");

const INTEGRATION = { id: "int1", type: "unraid", config: { host: "h", apiToken: "k" }, enabled: true };

const HOST_USAGE = {
  cpuPct: 25, perCorePct: [20, 30], memUsedBytes: 400, memTotalBytes: 1000,
  interfaces: [{ name: "eth0", operUp: true, rxBytes: 5, txBytes: 6, rxErrors: 0, txErrors: 0, rxDrops: 0, txDrops: 0, speedMbps: 1000 }],
};

function snapshot(over: Record<string, unknown> = {}) {
  return {
    fetchedAt: Date.now(),
    durationMs: 42,
    inventory: {
      platform: "unraid",
      hosts: [{
        hostname: "tower", os: "Unraid", osVersion: "7.2.0", ip: "h", serial: null, manufacturer: null, model: null,
        cpuCount: 4, memTotalBytes: 1000, uptimeSeconds: 99,
        pools: [{ name: "array", kind: "array", totalBytes: 100, usedBytes: 40, health: "STARTED" }],
        disks: [{ name: "disk1", serial: "sdc", temperatureC: 35, pool: "array" }, { name: "disk2", serial: null, temperatureC: null, pool: "array" }],
      }],
      vms: [{ platformId: "vm1", name: "win", uuid: null, state: "running", rawState: "RUNNING", cpuCount: null, memoryBytes: null, ip: null, macs: [], autostart: null }],
      containers: [
        { platformId: "c1", name: "plex", image: "plex", state: "running", rawState: "Up", ip: null, updateAvailable: false, version: null, latestVersion: null, memberCount: 1, ports: [], autostart: true },
        { platformId: "c2", name: "db", image: "pg", state: "stopped", rawState: "Exited (1)", ip: null, updateAvailable: null, version: null, latestVersion: null, memberCount: 1, ports: [], autostart: true },
        { platformId: "c3", name: "boot", image: "x", state: "other", rawState: "DEPLOYING", ip: null, updateAvailable: null, version: null, latestVersion: null, memberCount: 1, ports: [], autostart: true },
      ],
      inventoryComplete: true,
      presentVmNames: ["win"],
      presentContainerNames: ["plex", "db", "boot"],
    },
    hosts: new Map([["", HOST_USAGE]]),
    vmUsage: new Map(),
    containerUsage: new Map([["c1", { cpuPct: 250, memUsedBytes: 10, memTotalBytes: 1000 }]]),
    ...over,
  };
}

const source = (sourceKind: string, externalId: string) => ({ sourceKind, externalId, integration: INTEGRATION });

beforeEach(() => {
  wm.invalidateWorkloadSnapshot();
  h.findFirst.mockReset();
  h.fetchUnraidSnapshot.mockReset();
  h.fetchUnraidSnapshot.mockResolvedValue(snapshot());
});

describe("probeWorkload", () => {
  it("passes a running container, reporting 0 ms — a state read carries no latency", async () => {
    h.findFirst.mockResolvedValue(source("unraid-container", "int1:ctr:plex"));
    expect(await wm.probeWorkload("a", performance.now())).toEqual({ success: true, responseTimeMs: 0 });
  });

  it("fails a stopped container, naming the platform's state", async () => {
    h.findFirst.mockResolvedValue(source("unraid-container", "int1:ctr:db"));
    const r = await wm.probeWorkload("a", performance.now());
    expect(r.success).toBe(false);
    expect(r.error).toBe("Container is Exited (1)");
  });

  it("skips (no verdict) a workload in transition", async () => {
    h.findFirst.mockResolvedValue(source("unraid-container", "int1:ctr:boot"));
    expect((await wm.probeWorkload("a", performance.now())).skipped).toBe(true);
  });

  it("fails a container the host no longer reports", async () => {
    h.findFirst.mockResolvedValue(source("unraid-container", "int1:ctr:gone"));
    const r = await wm.probeWorkload("a", performance.now());
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/not present/) });
    expect(r.skipped).toBeUndefined();
  });

  it("SKIPS a workload when the host API is unreachable — but FAILS the host itself", async () => {
    h.fetchUnraidSnapshot.mockRejectedValue(new Error("Connection refused"));
    h.findFirst.mockResolvedValue(source("unraid-container", "int1:ctr:plex"));
    expect(await wm.probeWorkload("a", performance.now())).toMatchObject({ success: false, skipped: true });
    h.findFirst.mockResolvedValue(source("unraid-host", "int1:host"));
    const host = await wm.probeWorkload("h", performance.now());
    expect(host.success).toBe(false);
    expect(host.skipped).toBeUndefined();
  });

  it("does not read a missing container list (Docker stopped) as the container being gone", async () => {
    h.fetchUnraidSnapshot.mockResolvedValue(snapshot({
      inventory: { ...snapshot().inventory, containers: [], inventoryComplete: false },
    }));
    h.findFirst.mockResolvedValue(source("unraid-container", "int1:ctr:plex"));
    expect((await wm.probeWorkload("a", performance.now())).skipped).toBe(true);
  });

  it("passes the host with its uptime, and shares one snapshot across assets", async () => {
    h.findFirst.mockResolvedValue(source("unraid-host", "int1:host"));
    expect(await wm.probeWorkload("h", performance.now())).toEqual({ success: true, responseTimeMs: 0, uptimeSec: 99 });
    h.findFirst.mockResolvedValue(source("unraid-vm", "int1:vm:win"));
    expect((await wm.probeWorkload("v", performance.now())).success).toBe(true);
    expect(h.fetchUnraidSnapshot).toHaveBeenCalledTimes(1);
  });

  it("treats a disabled integration as unreachable", async () => {
    h.findFirst.mockResolvedValue({ ...source("unraid-container", "int1:ctr:plex"), integration: { ...INTEGRATION, enabled: false } });
    expect((await wm.probeWorkload("a", performance.now())).skipped).toBe(true);
  });
});

describe("collectors", () => {
  it("reports host CPU / memory / per-core, and a container's usage clamped to 100 %", async () => {
    h.findFirst.mockResolvedValue(source("unraid-host", "int1:host"));
    expect(await wm.collectTelemetryWorkload("h")).toEqual({
      supported: true, data: { cpuPct: 25, memUsedBytes: 400, memTotalBytes: 1000, cpuCorePcts: [20, 30] },
    });
    h.findFirst.mockResolvedValue(source("unraid-container", "int1:ctr:plex"));
    expect(await wm.collectTelemetryWorkload("c")).toEqual({
      supported: true, data: { cpuPct: 100, memUsedBytes: 10, memTotalBytes: 1000 },
    });
  });

  it("declares an Unraid VM's usage unsupported rather than charting nothing as zero", async () => {
    h.findFirst.mockResolvedValue(source("unraid-vm", "int1:vm:win"));
    expect(await wm.collectTelemetryWorkload("v")).toEqual({ supported: false });
  });

  it("gives the host its interfaces + pools, each gated on its own method", async () => {
    h.findFirst.mockResolvedValue(source("unraid-host", "int1:host"));
    const r = await wm.collectSystemInfoWorkload("h", { interfacesPolling: "unraid", storagePolling: "disabled" });
    expect(r.data?.interfaces[0]).toMatchObject({ ifName: "eth0", operStatus: "up", speedBps: 1e9, inOctets: 5 });
    expect(r.data?.storage).toEqual([]);
    const pinned = await wm.collectSystemInfoWorkload("h", { interfacesPolling: "unraid", storagePolling: "unraid" }, { interfaces: [], storage: ["array"] });
    expect(pinned.data).toEqual({ interfaces: [], storage: [{ mountPath: "array", totalBytes: 100, usedBytes: 40 }] });
  });

  it("gives a container its own network's counters and no storage", async () => {
    h.fetchUnraidSnapshot.mockResolvedValue(snapshot({
      containerUsage: new Map([["c1", {
        cpuPct: 5, memUsedBytes: 10, memTotalBytes: 1000,
        interfaces: [{ name: "br0", operUp: true, rxBytes: 700, txBytes: 800, rxErrors: null, txErrors: null, rxDrops: null, txDrops: null, speedMbps: null }],
      }]]),
    }));
    h.findFirst.mockResolvedValue(source("unraid-container", "int1:ctr:plex"));
    const r = await wm.collectSystemInfoWorkload("c", { interfacesPolling: "unraid", storagePolling: null });
    expect(r).toEqual({
      supported: true,
      data: { interfaces: [{ ifName: "br0", operStatus: "up", speedBps: null, inOctets: 700, outOctets: 800, inErrors: null, outErrors: null }], storage: [] },
    });
  });

  it("carries a host interface's IP, MAC and VLAN into the sample when the platform reported them", async () => {
    h.fetchUnraidSnapshot.mockResolvedValue(snapshot({
      hosts: new Map([["", { ...HOST_USAGE, interfaces: [{ name: "br0.20", operUp: true, rxBytes: 1, txBytes: 2, rxErrors: 0, txErrors: 0, rxDrops: 0, txDrops: 0, speedMbps: null, ipAddress: "10.0.20.2", macAddress: "AA:BB:CC:DD:EE:01", vlanId: 20 }] }]]),
    }));
    h.findFirst.mockResolvedValue(source("unraid-host", "int1:host"));
    const r = await wm.collectSystemInfoWorkload("h", { interfacesPolling: "unraid", storagePolling: null });
    expect(r.data?.interfaces[0]).toMatchObject({ ifName: "br0.20", ipAddress: "10.0.20.2", macAddress: "AA:BB:CC:DD:EE:01", vlanId: 20 });
  });

  it("answers nothing (not an empty table) for a running container missing from this tick's stats", async () => {
    h.fetchUnraidSnapshot.mockResolvedValue(snapshot({ containerUsage: new Map() }));
    h.findFirst.mockResolvedValue(source("unraid-container", "int1:ctr:plex"));
    const r = await wm.collectSystemInfoWorkload("c", { interfacesPolling: "unraid", storagePolling: null });
    expect(r).toMatchObject({ supported: true, error: expect.stringMatching(/No usage/) });
    expect(r.data).toBeUndefined();
  });

  it("gives a stopped container an empty interface set, and a VM nothing", async () => {
    h.findFirst.mockResolvedValue(source("unraid-container", "int1:ctr:db"));
    expect(await wm.collectSystemInfoWorkload("c", { interfacesPolling: "unraid", storagePolling: null }))
      .toEqual({ supported: true, data: { interfaces: [], storage: [] } });
    h.findFirst.mockResolvedValue(source("unraid-vm", "int1:vm:win"));
    expect(await wm.collectSystemInfoWorkload("v", { interfacesPolling: "unraid", storagePolling: null })).toEqual({ supported: false });
  });

  it("passes a host's cache / free memory bands through when the platform splits them", async () => {
    h.fetchUnraidSnapshot.mockResolvedValue(snapshot({
      hosts: new Map([["", { ...HOST_USAGE, memUsedBytes: 300, memCachedBytes: 500, memFreeBytes: 200 }]]),
    }));
    h.findFirst.mockResolvedValue(source("unraid-host", "int1:host"));
    expect((await wm.collectTelemetryWorkload("h")).data).toMatchObject({ memUsedBytes: 300, memCachedBytes: 500, memFreeBytes: 200 });
  });

  it("reports readable disk temperatures as disk-class sensors on the host only", async () => {
    h.findFirst.mockResolvedValue(source("unraid-host", "int1:host"));
    expect((await wm.collectHardwareSensorsWorkload("h")).data).toEqual([
      { sensorName: "disk1 (array)", sensorClass: "disk", value: 35, unit: "°C", alarmStatus: null },
    ]);
    h.findFirst.mockResolvedValue(source("unraid-container", "int1:ctr:plex"));
    expect(await wm.collectHardwareSensorsWorkload("c")).toEqual({ supported: false });
  });
});

describe("a multi-host (clustered) snapshot", () => {
  const node = (key: string, online: boolean, uptime: number) => ({
    ...snapshot().inventory.hosts[0], key, online, hostname: key, uptimeSeconds: uptime,
    pools: [{ name: `tank-${key}`, kind: "zfs", totalBytes: 10, usedBytes: 1, health: "ONLINE" }],
  });
  const cluster = () => snapshot({
    inventory: {
      ...snapshot().inventory,
      hosts: [node("pve1", true, 11), node("pve2", false, 0)],
      containers: [
        { ...snapshot().inventory.containers[0], platformId: "100", name: "web", identityKey: "100", hostKey: "pve1" },
        { ...snapshot().inventory.containers[0], platformId: "200", name: "web", identityKey: "200", hostKey: "pve2" },
      ],
    },
    hosts: new Map([["pve1", { ...HOST_USAGE, cpuPct: 7 }]]),
  });
  beforeEach(() => h.fetchUnraidSnapshot.mockResolvedValue(cluster()));

  it("reads each node by its own identity, and passes the online one with its uptime", async () => {
    h.findFirst.mockResolvedValue(source("unraid-host", "int1:node:pve1"));
    expect(await wm.probeWorkload("n1", 0)).toEqual({ success: true, responseTimeMs: 0, uptimeSec: 11 });
    expect((await wm.collectTelemetryWorkload("n1")).data).toMatchObject({ cpuPct: 7 });
    const sys = await wm.collectSystemInfoWorkload("n1", { interfacesPolling: null, storagePolling: "unraid" });
    expect(sys.data?.storage).toEqual([{ mountPath: "tank-pve1", totalBytes: 10, usedBytes: 1 }]);
  });

  it("FAILS a node the cluster reports offline — the answer came through a peer", async () => {
    h.findFirst.mockResolvedValue(source("unraid-host", "int1:node:pve2"));
    const r = await wm.probeWorkload("n2", 0);
    expect(r.success).toBe(false);
    expect(r.skipped).toBeUndefined();
    expect(r.error).toMatch(/offline/);
    expect((await wm.collectTelemetryWorkload("n2")).error).toMatch(/no CPU/);
  });

  it("calls a node no longer in the cluster absent, and never answers the single-host id", async () => {
    h.findFirst.mockResolvedValue(source("unraid-host", "int1:node:pve9"));
    expect((await wm.probeWorkload("n9", 0)).error).toMatch(/removed from the cluster/);
    h.findFirst.mockResolvedValue(source("unraid-host", "int1:host"));
    expect((await wm.probeWorkload("h", 0)).success).toBe(false);
  });

  it("tells two same-named containers apart by identityKey", async () => {
    h.findFirst.mockResolvedValue(source("unraid-container", "int1:ctr:200"));
    expect(await wm.probeWorkload("c200", 0)).toEqual({ success: true, responseTimeMs: 0 });
    h.findFirst.mockResolvedValue(source("unraid-container", "int1:ctr:web"));
    expect((await wm.probeWorkload("cweb", 0)).error).toMatch(/not present/);
  });
});
