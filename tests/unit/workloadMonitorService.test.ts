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

function snapshot(over: Record<string, unknown> = {}) {
  return {
    fetchedAt: Date.now(),
    durationMs: 42,
    inventory: {
      platform: "unraid",
      host: {
        hostname: "tower", os: "Unraid", osVersion: "7.2.0", ip: "h", serial: null, manufacturer: null, model: null,
        cpuCount: 4, memTotalBytes: 1000, uptimeSeconds: 99,
        pools: [{ name: "array", kind: "array", totalBytes: 100, usedBytes: 40, health: "STARTED" }],
        disks: [{ name: "disk1", serial: "sdc", temperatureC: 35, pool: "array" }, { name: "disk2", serial: null, temperatureC: null, pool: "array" }],
      },
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
    host: {
      cpuPct: 25, perCorePct: [20, 30], memUsedBytes: 400, memTotalBytes: 1000,
      interfaces: [{ name: "eth0", operUp: true, rxBytes: 5, txBytes: 6, rxErrors: 0, txErrors: 0, rxDrops: 0, txDrops: 0, speedMbps: 1000 }],
    },
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

  it("reports readable disk temperatures as disk-class sensors on the host only", async () => {
    h.findFirst.mockResolvedValue(source("unraid-host", "int1:host"));
    expect((await wm.collectHardwareSensorsWorkload("h")).data).toEqual([
      { sensorName: "disk1 (array)", sensorClass: "disk", value: 35, unit: "°C", alarmStatus: null },
    ]);
    h.findFirst.mockResolvedValue(source("unraid-container", "int1:ctr:plex"));
    expect(await wm.collectHardwareSensorsWorkload("c")).toEqual({ supported: false });
  });
});
