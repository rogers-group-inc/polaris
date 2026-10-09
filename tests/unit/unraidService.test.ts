import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/services/discovery/discoveryEngine.js", () => ({
  indexHostname: vi.fn(), lookupHostname: vi.fn(), normalizeMacKey: vi.fn(), upsertAssetConflict: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({ prisma: {} }));

const {
  applyUnraidStorageLayout,
  containerOwnIp,
  normalizeUnraidContainerUsage,
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
  it("splits NetIO (received / sent, decimal units) the same way", () => {
    expect(parseDockerMemUsage("1.5GB / 300MB")).toEqual({ used: 1.5e9, limit: 3e8 });
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
  it("gives a user-defined bridge's NATed address no claim unless Unraid lists it as a LAN port", () => {
    const nets = { Networks: { proxynet: { IPAddress: "172.18.0.5" } } };
    expect(containerOwnIp("proxynet", nets)).toBeNull();
    expect(containerOwnIp("proxynet", nets, ["10.0.0.2:443"])).toBeNull();
    expect(containerOwnIp("lan", { Networks: { lan: { IPAddress: "10.0.0.60" } } }, ["10.0.0.60:80"])).toBe("10.0.0.60");
  });
  it("gives a container on br0 / a VLAN child / bond0 its LAN address", () => {
    expect(containerOwnIp("br0.20", { Networks: { "br0.20": { IPAddress: "10.0.20.5" } } })).toBe("10.0.20.5");
    expect(containerOwnIp("bond0", { Networks: { bond0: { IPAddress: "10.0.0.7" } } })).toBe("10.0.0.7");
  });
  it("records each container's network mode", () => {
    const inv = parseUnraidInventory(FIXTURE, { host: "10.0.0.2" }, { dockerFailed: false, vmsFailed: false });
    expect(inv.containers.map((c) => c.networkMode)).toEqual(["bridge", "br0"]);
  });
});

describe("normalizeUnraidContainerUsage", () => {
  const stat = (over: Partial<Record<string, number | null>> = {}) => ({
    cpuPct: 200, memUsedBytes: 10, memTotalBytes: 100, netRxBytes: 5000, netTxBytes: 6000, ...over,
  });

  it("divides docker's per-core CPU by the host's thread count", () => {
    const u = normalizeUnraidContainerUsage(new Map([["c1", stat()]]), [{ platformId: "c1", networkMode: "bridge" }], 32);
    expect(u.get("c1")!.cpuPct).toBe(6.25);
  });

  it("leaves CPU as docker printed it when the host reported no thread count", () => {
    const u = normalizeUnraidContainerUsage(new Map([["c1", stat({ cpuPct: 3 })]]), [{ platformId: "c1", networkMode: "bridge" }], null);
    expect(u.get("c1")!.cpuPct).toBe(3);
  });

  it("names the traffic row after the container's network", () => {
    const u = normalizeUnraidContainerUsage(new Map([["c1", stat()]]), [{ platformId: "c1", networkMode: "br0" }], 4);
    expect(u.get("c1")!.interfaces).toEqual([
      { name: "br0", operUp: true, rxBytes: 5000, txBytes: 6000, rxErrors: null, txErrors: null, rxDrops: null, txDrops: null, speedMbps: null },
    ]);
  });

  it("gives a container on the host's stack no interface — its traffic is the host's", () => {
    const u = normalizeUnraidContainerUsage(
      new Map([["c1", stat({ netRxBytes: 0, netTxBytes: 0 })], ["c2", stat()]]),
      [{ platformId: "c1", networkMode: "host" }, { platformId: "c2", networkMode: "container:vpn" }],
      4,
    );
    expect(u.get("c1")!.interfaces).toBeUndefined();
    expect(u.get("c2")!.interfaces).toBeUndefined();
  });
});

describe("applyUnraidStorageLayout", () => {
  const ad = (name: string, device: string, over: Record<string, unknown> = {}) => ({
    name, device, size: "1000", status: "DISK_OK", temp: 30, numErrors: "0", fsType: null, rotational: true, type: "DATA", ...over,
  });
  const LAYOUT = {
    array: {
      parityCheckStatus: { status: "OK", date: "2026-10-01T00:00:00Z", errors: 0, progress: 0, running: false, paused: false },
      parities: [ad("parity", "sdb", { type: "PARITY" })],
      disks: [ad("disk1", "sdc", { fsType: "xfs" }), ad("disk2", "sdd", { fsType: "btrfs", numErrors: "3" }), ad("disk3", "", { status: "DISK_NP" })],
      caches: [
        ad("cache", "nvme0n1", { fsType: "zfs", fsSize: "200", rotational: false }),
        ad("cache2", "nvme1n1", { fsType: "zfs", rotational: false }),
        ad("cache_ssd", "sde", { fsType: "btrfs", fsSize: "100", rotational: false }),
      ],
    },
    disks: [{ device: "/dev/sdc", name: "WDC WD40", serialNum: "WD-1", smartStatus: "OK", interfaceType: "SATA" }],
  };
  const pools = [
    { name: "array", kind: "array", totalBytes: 1, usedBytes: 0, health: "STARTED" },
    { name: "cache", kind: "pool", totalBytes: 1, usedBytes: 0, health: "DISK_OK" },
    { name: "cache_ssd", kind: "pool", totalBytes: 1, usedBytes: 0, health: "DISK_OK" },
  ];

  it("lays the array out as parity + data, each data disk with its own filesystem, empty slots dropped", () => {
    const [array] = applyUnraidStorageLayout(pools, LAYOUT);
    expect(array.filesystem).toBe("unraid-array (xfs, btrfs)");
    expect(array.scan).toMatchObject({ kind: "parity-check", state: "ok", errors: 0, percent: null });
    expect(array.groups!.map((g) => [g.role, g.members.map((m) => m.name)])).toEqual([["parity", ["parity"]], ["data", ["disk1", "disk2"]]]);
    expect(array.groups![1].members[0]).toMatchObject({ filesystem: "xfs", serial: "WD-1", model: "WDC WD40", smart: "OK", mediaType: "HDD", sizeBytes: 1000 * 1024, errors: 0 });
    expect(array.groups![1].members[1].errors).toBe(3);
  });

  it("gathers a named pool's members (`cache`, `cache2`) without claiming another pool's", () => {
    const [, cache, ssd] = applyUnraidStorageLayout(pools, LAYOUT);
    expect(cache.filesystem).toBe("zfs");
    expect(cache.groups![0].members.map((m) => [m.name, m.mediaType])).toEqual([["cache", "NVMe"], ["cache2", "NVMe"]]);
    expect(ssd.groups![0].members.map((m) => m.name)).toEqual(["cache_ssd"]);
  });

  it("leaves the pools untouched when the layout answer is missing", () => {
    expect(applyUnraidStorageLayout(pools, null)).toBe(pools);
  });
});

describe("query tool", () => {
  it("refuses mutations and subscriptions in the query tool", async () => {
    const cfg = { host: "h", apiToken: "k" };
    await expect(proxyQuery(cfg, "mutation { docker { stop(id: \"x\") { id } } }")).rejects.toThrow(/Only queries/);
    await expect(proxyQuery(cfg, "  # comment\n subscription { dockerContainerStats { id } }")).rejects.toThrow(/Only queries/);
  });
});
