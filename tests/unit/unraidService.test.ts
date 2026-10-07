import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/services/discovery/discoveryEngine.js", () => ({
  indexHostname: vi.fn(), lookupHostname: vi.fn(), normalizeMacKey: vi.fn(), upsertAssetConflict: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({ prisma: {} }));

const {
  containerOwnIp,
  parseDockerMemUsage,
  parseDockerSize,
  parseUnraidHostUsage,
  parseUnraidInventory,
  parseUnraidPools,
  proxyQuery,
  unprefixId,
} = await import("../../src/services/unraidService.js");

// Synthetic — shaped like Unraid 7.2's GraphQL answer, no real host data.
const FIXTURE = {
  info: {
    os: { hostname: "tower", release: "6.12.0-unraid", distro: "Unraid OS", uptime: "2026-10-01T00:00:00Z" },
    system: { manufacturer: "To Be Filled By O.E.M.", model: "To Be Filled By O.E.M.", serial: "To Be Filled By O.E.M.", uuid: "x" },
    baseboard: { manufacturer: "ASRock", model: "B550M Pro4", serial: "M80-AB123" },
    cpu: { cores: 8, threads: 16 },
    versions: { core: { unraid: "7.2.0" } },
  },
  metrics: {
    cpu: { percentTotal: 12.5, cpus: [{ percentTotal: 10 }, { percentTotal: 15 }] },
    memory: { total: "34359738368", used: "30000000000", available: "24359738368" },
    network: [{ name: "eth0", operstate: "up", bytesReceived: "1000", bytesSent: "2000", receiveErrors: "0", transmitErrors: "0", receiveDropped: "1", transmitDropped: "0" }],
  },
  array: {
    state: "STARTED",
    capacity: { kilobytes: { total: "1000", used: "400", free: "600" } },
    parities: [{ name: "parity", device: "sdb", temp: 34, fsSize: null }],
    disks: [{ name: "disk1", device: "sdc", temp: 0, fsSize: "500" }],
    caches: [
      { name: "cache", device: "nvme0n1", temp: 41, fsSize: "200", fsUsed: "50", status: "DISK_OK" },
      { name: "cache2", device: "nvme1n1", temp: 40, fsSize: null },
    ],
  },
  docker: {
    containers: [
      { id: "srv:abc", names: ["/plex"], image: "lscr.io/linuxserver/plex", state: "RUNNING", status: "Up 2 days", autoStart: true, isUpdateAvailable: true, lanIpPorts: ["10.0.0.2:32400"], hostConfig: { networkMode: "bridge" }, networkSettings: { Networks: { bridge: { IPAddress: "172.17.0.2" } } } },
      { id: "srv:def", names: ["/pihole"], image: "pihole/pihole", state: "EXITED", status: "Exited (0)", autoStart: false, isUpdateAvailable: null, lanIpPorts: [], hostConfig: { networkMode: "br0" }, networkSettings: { Networks: { br0: { IPAddress: "10.0.0.53" } } } },
    ],
  },
  vms: { domains: [{ id: "srv:6f1c2b9e-1111-2222-3333-444455556666", name: "win11", state: "RUNNING" }, { id: "srv:x", name: "old", state: "SHUTOFF" }] },
};

describe("unraid parsing", () => {
  const inv = parseUnraidInventory(FIXTURE, { host: "10.0.0.2" }, { dockerFailed: false, vmsFailed: false });

  it("reads the host, falling back to the baseboard past an O.E.M. placeholder", () => {
    expect(inv.platform).toBe("unraid");
    expect(inv.host.hostname).toBe("tower");
    expect(inv.host.osVersion).toBe("7.2.0");
    expect(inv.host.manufacturer).toBe("ASRock");
    expect(inv.host.serial).toBe("M80-AB123");
    expect(inv.host.cpuCount).toBe(16);
    expect(inv.host.ip).toBe("10.0.0.2");
  });

  it("reads containers: name without the slash, state, update flag, own IP only off-bridge", () => {
    expect(inv.containers.map((c) => [c.name, c.state, c.updateAvailable, c.ip])).toEqual([
      ["plex", "running", true, null],
      ["pihole", "stopped", null, "10.0.0.53"],
    ]);
    expect(inv.containers[0].platformId).toBe("srv:abc");
  });

  it("reads VMs with a UUID identity only when the id carries one", () => {
    expect(inv.vms.map((v) => [v.name, v.state, v.uuid])).toEqual([
      ["win11", "running", "6f1c2b9e-1111-2222-3333-444455556666"],
      ["old", "stopped", null],
    ]);
    expect(inv.inventoryComplete).toBe(true);
    expect(inv.presentContainerNames).toEqual(["plex", "pihole"]);
  });

  it("marks the read incomplete when Docker or the VM manager could not be read", () => {
    const r = parseUnraidInventory({ ...FIXTURE, docker: null }, { host: "h" }, { dockerFailed: true, vmsFailed: false });
    expect(r.inventoryComplete).toBe(false);
    expect(r.containers).toEqual([]);
  });

  it("builds the array pool plus each cache pool with a filesystem, in bytes", () => {
    expect(parseUnraidPools(FIXTURE.array)).toEqual([
      { name: "array", kind: "array", totalBytes: 1000 * 1024, usedBytes: 400 * 1024, health: "STARTED" },
      { name: "cache", kind: "pool", totalBytes: 200 * 1024, usedBytes: 50 * 1024, health: "DISK_OK" },
    ]);
  });

  it("drops a zero temperature (a spun-down disk) rather than charting 0 °C", () => {
    const disk1 = inv.host.disks.find((d) => d.name === "disk1")!;
    expect(disk1.temperatureC).toBeNull();
    expect(inv.host.disks.find((d) => d.name === "cache")!.temperatureC).toBe(41);
  });

  it("reads host usage with memory in use = total − available", () => {
    const u = parseUnraidHostUsage(FIXTURE);
    expect(u.cpuPct).toBe(12.5);
    expect(u.perCorePct).toEqual([10, 15]);
    expect(u.memTotalBytes).toBe(34359738368);
    expect(u.memUsedBytes).toBe(10000000000);
    expect(u.interfaces[0]).toMatchObject({ name: "eth0", operUp: true, rxBytes: 1000, rxDrops: 1 });
  });
});

describe("docker-stats parsing", () => {
  it("reads binary and decimal sizes", () => {
    expect(parseDockerSize("512MiB")).toBe(512 * 1024 * 1024);
    expect(parseDockerSize("1.5GiB")).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseDockerSize("3kB")).toBe(3000);
    expect(parseDockerSize("12B")).toBe(12);
    expect(parseDockerSize("n/a")).toBeNull();
  });
  it("splits mem usage into used / limit", () => {
    expect(parseDockerMemUsage("256MiB / 2GiB")).toEqual({ used: 256 * 1024 ** 2, limit: 2 * 1024 ** 3 });
  });
});

describe("helpers", () => {
  it("unprefixes a PrefixedID", () => {
    expect(unprefixId("server123:abc")).toBe("abc");
    expect(unprefixId("abc")).toBe("abc");
  });
  it("never gives a host-networked container its own IP", () => {
    expect(containerOwnIp("host", { Networks: { host: { IPAddress: "10.0.0.2" } } })).toBeNull();
    expect(containerOwnIp("container:vpn", {})).toBeNull();
  });
  it("refuses mutations and subscriptions in the query tool", async () => {
    const cfg = { host: "h", apiToken: "k" };
    await expect(proxyQuery(cfg, "mutation { docker { stop(id: \"x\") { id } } }")).rejects.toThrow(/Only queries/);
    await expect(proxyQuery(cfg, "  # comment\n subscription { dockerContainerStats { id } }")).rejects.toThrow(/Only queries/);
  });
});
