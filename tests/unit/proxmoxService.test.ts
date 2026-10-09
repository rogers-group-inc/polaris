/**
 * tests/unit/proxmoxService.test.ts
 *
 * The Proxmox VE client. Payloads are trimmed from a real two-node PVE 9.2
 * cluster (MACs and UUIDs replaced). Pins: cluster / resource parsing (and
 * templates dropped), guest identity + addressing (agent first, static config
 * second), ZFS layout and scan, the pool list (ZFS once, other storage as
 * capacity rows, Ceph health on Ceph storage), the ARC memory split, guest
 * usage, the address fallback in the transport, and the Query API allow-list.
 */

import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: h.request }));

const pve = await import("../../src/services/proxmoxService.js");
const { RateCounters } = await import("../../src/utils/rateCounters.js");

// ─── Fixtures (trimmed from a live cluster) ──────────────────────────────────

const CLUSTER_STATUS = [
  { id: "cluster", quorate: 1, type: "cluster", version: 2, nodes: 2, name: "lab" },
  { name: "pve1", online: 1, id: "node/pve1", type: "node", nodeid: 1, ip: "10.77.0.11", local: 1 },
  { id: "node/pve2", online: 0, name: "pve2", ip: "10.77.0.12", local: 0, type: "node", nodeid: 2 },
];

const RESOURCES = [
  { id: "node/pve1", type: "node", node: "pve1", status: "online", cpu: 0.24, maxcpu: 4, mem: 3150270464, maxmem: 6211530752, uptime: 298 },
  { id: "node/pve2", type: "node", node: "pve2", status: "offline", maxcpu: 4, maxmem: 6211534848 },
  { id: "lxc/100", type: "lxc", vmid: 100, name: "web", node: "pve1", status: "running", cpu: 0.05, maxcpu: 1, mem: 1241088, maxmem: 268435456, netin: 1298, netout: 726, uptime: 42 },
  { id: "qemu/101", type: "qemu", vmid: 101, name: "app01", node: "pve1", status: "running", cpu: 0.36, maxcpu: 2, mem: 586297344, maxmem: 1073741824, netin: 30509284, netout: 210749, uptime: 76 },
  { id: "lxc/200", type: "lxc", vmid: 200, name: "web", node: "pve2", status: "running", cpu: 0, maxcpu: 1, mem: 1241088, maxmem: 268435456, netin: 420, netout: 726 },
  { id: "qemu/201", type: "qemu", vmid: 201, name: "idle", node: "pve2", status: "stopped", cpu: 0, maxcpu: 1, mem: 0, maxmem: 536870912, netin: 0, netout: 0 },
  { id: "qemu/9000", type: "qemu", vmid: 9000, name: "tmpl", node: "pve1", status: "stopped", template: 1 },
  { id: "storage/pve1/tank", type: "storage", node: "pve1", status: "available" },
];

const VM_CONFIG = {
  ipconfig0: "ip=10.77.0.31/24,gw=10.77.0.1",
  net0: "virtio=02:00:00:00:01:01,bridge=vmbr0",
  net1: "e1000=02:00:00:00:01:02,bridge=vmbr1,tag=20",
  agent: "enabled=1",
  smbios1: "uuid=11111111-2222-3333-4444-555555555555",
  onboot: 1,
  name: "app01",
};

const AGENT_NET = {
  result: [
    { name: "lo", "hardware-address": "00:00:00:00:00:00", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "127.0.0.1", prefix: 8 }] },
    { name: "eth0", "hardware-address": "02:00:00:00:01:01", "ip-addresses": [
      { "ip-address-type": "ipv6", "ip-address": "fe80::1", prefix: 64 },
      { "ip-address-type": "ipv4", "ip-address": "10.77.0.99", prefix: 24 },
    ] },
  ],
};

const CT_CONFIG = {
  net0: "name=eth0,bridge=vmbr0,gw=10.77.0.1,hwaddr=02:00:00:00:02:01,ip=10.77.0.21/24,type=veth",
  ostype: "alpine",
  onboot: 0,
  hostname: "web",
};

const ZFS_MIRROR = {
  errors: "No known data errors", state: "ONLINE", name: "tank", leaf: 0,
  scan: "scrub repaired 0B in 00:00:01 with 0 errors on Sun Oct  4 00:24:02 2026",
  children: [{ name: "tank", state: "ONLINE", leaf: 0, children: [{
    name: "mirror-0", state: "ONLINE", leaf: 0, read: 0, write: 0, cksum: 0,
    children: [
      { name: "/dev/vdb1", state: "ONLINE", leaf: 1, read: 0, write: 0, cksum: 0 },
      { name: "/dev/vdc1", state: "ONLINE", leaf: 1, read: 0, write: 0, cksum: 3 },
    ],
  }] }],
};

// ─── Parsers ──────────────────────────────────────────────────────────────────

describe("parseProxmoxClusterStatus", () => {
  it("reads the cluster, its quorum and each node's online flag + address", () => {
    expect(pve.parseProxmoxClusterStatus(CLUSTER_STATUS)).toEqual({
      clusterName: "lab",
      quorate: true,
      nodes: [{ name: "pve1", online: true, ip: "10.77.0.11" }, { name: "pve2", online: false, ip: "10.77.0.12" }],
    });
  });
  it("reads a standalone node — no cluster row, no quorum to speak of", () => {
    const r = pve.parseProxmoxClusterStatus([{ type: "node", name: "solo", online: 1, ip: "10.0.0.5" }]);
    expect(r.clusterName).toBeNull();
    expect(r.quorate).toBeNull();
    expect(r.nodes).toEqual([{ name: "solo", online: true, ip: "10.0.0.5" }]);
  });
  it("survives garbage", () => {
    expect(pve.parseProxmoxClusterStatus(null)).toEqual({ clusterName: null, quorate: null, nodes: [] });
  });
});

describe("parseProxmoxResources", () => {
  it("splits nodes from guests, drops templates and storage rows", () => {
    const r = pve.parseProxmoxResources(RESOURCES);
    expect(r.nodes.map((n) => [n.name, n.online])).toEqual([["pve1", true], ["pve2", false]]);
    expect(r.guests.map((g) => `${g.type}/${g.vmid}@${g.node}`)).toEqual(["lxc/100@pve1", "qemu/101@pve1", "lxc/200@pve2", "qemu/201@pve2"]);
  });
});

describe("guest configs", () => {
  it("parses a QEMU NIC by its model, an LXC NIC by hwaddr, and ignores dhcp", () => {
    expect(pve.parseProxmoxNetConfig("virtio=bc:24:11:6b:cf:28,bridge=vmbr0")).toEqual({ mac: "BC:24:11:6B:CF:28", bridge: "vmbr0", ip: null });
    expect(pve.parseProxmoxNetConfig(CT_CONFIG.net0)).toEqual({ mac: "02:00:00:00:02:01", bridge: "vmbr0", ip: "10.77.0.21" });
    expect(pve.parseProxmoxNetConfig("name=eth0,hwaddr=02:00:00:00:02:09,ip=dhcp").ip).toBeNull();
    expect(pve.parseProxmoxNetConfig(undefined)).toEqual({ mac: null, bridge: null, ip: null });
  });

  it("keys a VM on its SMBIOS UUID, prefers the guest agent's address, keeps every MAC", () => {
    expect(pve.parseProxmoxGuestDetail("qemu", VM_CONFIG, AGENT_NET)).toEqual({
      uuid: "11111111-2222-3333-4444-555555555555",
      macs: ["02:00:00:00:01:01", "02:00:00:00:01:02"],
      ip: "10.77.0.99",
      bridge: "vmbr0",
      ostype: null,
      autostart: true,
    });
  });

  it("falls back to the cloud-init address when the agent cannot be asked", () => {
    expect(pve.parseProxmoxGuestDetail("qemu", VM_CONFIG, null).ip).toBe("10.77.0.31");
    expect(pve.parseProxmoxGuestDetail("qemu", { net0: "virtio=02:00:00:00:01:01" }, null).ip).toBeNull();
  });

  it("an LXC has no UUID; its address is its own or its config's", () => {
    const d = pve.parseProxmoxGuestDetail("lxc", CT_CONFIG, null);
    expect(d).toMatchObject({ uuid: null, ip: "10.77.0.21", ostype: "alpine", autostart: false, macs: ["02:00:00:00:02:01"] });
    const live = [{ name: "eth0", "ip-addresses": [{ "ip-address-type": "inet", "ip-address": "10.77.0.50", prefix: "24" }] }];
    expect(pve.parseProxmoxGuestDetail("lxc", CT_CONFIG, live).ip).toBe("10.77.0.50");
  });

  it("never takes loopback or link-local as a guest address", () => {
    expect(pve.firstGuestIpv4([{ name: "eth0", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "169.254.1.1" }] }])).toBeNull();
    expect(pve.firstGuestIpv4({ result: [] })).toBeNull();
  });
});

describe("buildProxmoxGuests", () => {
  it("places each guest on its node and keys LXCs by VMID — two same-named containers stay two", () => {
    const { guests } = pve.parseProxmoxResources(RESOURCES);
    const details = new Map([["qemu/101", pve.parseProxmoxGuestDetail("qemu", VM_CONFIG, AGENT_NET)]]);
    const { vms, containers } = pve.buildProxmoxGuests(guests, details);
    expect(vms.map((v) => [v.platformId, v.hostKey, v.uuid, v.state])).toEqual([
      ["101", "pve1", "11111111-2222-3333-4444-555555555555", "running"],
      ["201", "pve2", null, "stopped"],
    ]);
    expect(containers.map((c) => [c.name, c.identityKey, c.hostKey])).toEqual([["web", "100", "pve1"], ["web", "200", "pve2"]]);
  });
});

describe("ZFS", () => {
  it("reads a mirror's vdev and its members with their error counters", () => {
    expect(pve.parseProxmoxZfsGroups(ZFS_MIRROR)).toEqual([{
      role: "data", layout: "mirror", name: "mirror-0", health: "ONLINE",
      members: [
        expect.objectContaining({ name: "vdb1", device: "vdb1", health: "ONLINE", checksumErrors: 0 }),
        expect.objectContaining({ name: "vdc1", device: "vdc1", health: "ONLINE", checksumErrors: 3 }),
      ],
    }]);
  });

  it("reads a stripe (bare disks under the pool) and the log / cache rows beside it", () => {
    const detail = { children: [
      { name: "fast", children: [{ name: "/dev/sda", leaf: 1, state: "ONLINE" }, { name: "/dev/sdb", leaf: 1, state: "ONLINE" }] },
      { name: "logs", children: [{ name: "mirror-1", state: "ONLINE", children: [{ name: "/dev/nvme0n1", leaf: 1 }, { name: "/dev/nvme1n1", leaf: 1 }] }] },
      { name: "cache", children: [{ name: "/dev/nvme2n1", leaf: 1, state: "ONLINE" }] },
    ] };
    expect(pve.parseProxmoxZfsGroups(detail).map((g) => [g.role, g.layout, g.members.length])).toEqual([
      ["data", "stripe", 2], ["log", "mirror", 2], ["cache", null, 1],
    ]);
    expect(pve.parseProxmoxZfsGroups({ children: [{ name: "z", children: [{ name: "raidz2-0", children: [{ name: "/dev/sda", leaf: 1 }] }] }] })[0]!.layout).toBe("raidz2");
  });

  it("reads the last scrub, a running resilver, and nothing when none was ever run", () => {
    expect(pve.parseProxmoxZfsScan(ZFS_MIRROR.scan)).toMatchObject({ kind: "scrub", state: "finished", errors: 0 });
    expect(pve.parseProxmoxZfsScan("resilver in progress since Mon Oct  5 10:00:00 2026\n\t42.5% done")).toMatchObject({ kind: "resilver", state: "running", percent: 42.5 });
    expect(pve.parseProxmoxZfsScan("none requested")).toBeNull();
    expect(pve.parseProxmoxZfsScan(null)).toBeNull();
  });
});

describe("parseProxmoxPools", () => {
  const STORAGE = [
    { storage: "local", type: "dir", total: 16528584704, used: 4792070144, active: 1, enabled: 1 },
    { storage: "tank", type: "zfspool", total: 9881780224, used: 762961920, active: 1, enabled: 1 },
    { storage: "ceph-vm", type: "rbd", total: 1e12, used: 4e11, active: 1, enabled: 1, shared: 1 },
    { storage: "nfs-iso", type: "nfs", total: 0, used: 0, active: 0, enabled: 1 },
  ];
  const ZFS = [{ name: "tank", health: "ONLINE", size: 10200547328, alloc: 786202624, free: 9414344704 }];

  it("lists each ZFS pool once (with layout), other ACTIVE storage as capacity, Ceph health on Ceph storage", () => {
    const pools = pve.parseProxmoxPools(STORAGE, ZFS, new Map([["tank", ZFS_MIRROR]]), { health: "HEALTH_WARN", detail: "1 osds down" });
    expect(pools.map((p) => [p.name, p.kind, p.health])).toEqual([
      ["tank", "zfs", "ONLINE"],
      ["local", "dir", null],
      ["ceph-vm", "rbd", "HEALTH_WARN"],
    ]);
    expect(pools[0]).toMatchObject({ totalBytes: 10200547328, usedBytes: 786202624, filesystem: "zfs", scan: expect.objectContaining({ kind: "scrub" }) });
    expect(pools[0]!.groups).toHaveLength(1);
    expect(pools[2]!.healthDetail).toBe("1 osds down");
  });

  it("keeps a ZFS pool whose detail could not be read, without a layout", () => {
    const [tank] = pve.parseProxmoxPools([], ZFS, new Map(), null);
    expect(tank).toMatchObject({ name: "tank", health: "ONLINE" });
    expect(tank!.groups).toBeUndefined();
  });

  it("reads Ceph's health word and its first check summaries", () => {
    expect(pve.parseProxmoxCephHealth({ health: { status: "HEALTH_OK", checks: {} } })).toEqual({ health: "HEALTH_OK", detail: null });
    expect(pve.parseProxmoxCephHealth({ health: { status: "HEALTH_WARN", checks: { OSD_DOWN: { summary: { message: "1 osds down" } } } } }))
      .toEqual({ health: "HEALTH_WARN", detail: "1 osds down" });
    expect(pve.parseProxmoxCephHealth(null)).toBeNull();
  });
});

describe("usage", () => {
  const node = pve.parseProxmoxResources(RESOURCES).nodes[0]!;
  const status = { memory: { used: 3093757952, total: 6211530752, free: 2406612992, available: 3117772800 } };

  it("carves the ZFS ARC out of `used` into the cached band — used + cached + free = total", () => {
    const u = pve.proxmoxNodeUsage(node, status, { cpu: 0.2, arcsize: 577794705.87 } as any, new RateCounters(), "pve1", 0);
    expect(u.cpuPct).toBeCloseTo(24);
    expect(u.memCachedBytes).toBe(577794706);
    expect(u.memUsedBytes).toBe(3093757952 - 577794706);
    expect(u.memUsedBytes! + u.memCachedBytes! + u.memFreeBytes!).toBe(6211530752);
  });

  it("leaves memory as one figure when there is no ARC", () => {
    const u = pve.proxmoxNodeUsage(node, status, { cpu: 0.2 } as any, new RateCounters(), "pve1", 0);
    expect(u.memUsedBytes).toBe(3093757952);
    expect(u.memCachedBytes).toBeUndefined();
  });

  it("integrates the node's RRD traffic rate into one cumulative interface row", () => {
    const c = new RateCounters();
    pve.proxmoxNodeUsage(node, status, { cpu: 0.1, netin: 1000, netout: 500 } as any, c, "pve1", 0);
    const u = pve.proxmoxNodeUsage(node, status, { cpu: 0.1, netin: 1000, netout: 500 } as any, c, "pve1", 30_000);
    expect(u.interfaces).toEqual([expect.objectContaining({ name: "all interfaces", rxBytes: 30_000, txBytes: 15_000 })]);
  });

  it("reports a guest's CPU against its own vCPU allotment, and network only while running", () => {
    const [ct100, vm101, , vm201] = pve.parseProxmoxResources(RESOURCES).guests;
    expect(pve.proxmoxGuestUsage(vm101!)).toMatchObject({ cpuPct: 36, memUsedBytes: 586297344, memTotalBytes: 1073741824 });
    expect(pve.proxmoxGuestUsage(ct100!).interfaces).toEqual([expect.objectContaining({ rxBytes: 1298, txBytes: 726 })]);
    expect(pve.proxmoxGuestUsage(vm201!).interfaces).toEqual([]);
  });

  it("takes the last RRD row that carries data, and the version off pveversion", () => {
    expect(pve.lastRrdRow([{ cpu: 0.1, time: 1 }, { cpu: 0.2, time: 2 }, { time: 3 }])).toEqual({ cpu: 0.2, time: 2 });
    expect(pve.lastRrdRow(null)).toBeNull();
    expect(pve.proxmoxVersion("pve-manager/9.2.2/b9984c6d90a4bd80")).toBe("9.2.2");
  });

  it("builds an offline node as a host that is not online, with what /cluster/resources knew", () => {
    const res = pve.parseProxmoxResources(RESOURCES).nodes[1];
    const host = pve.buildProxmoxHost({ name: "pve2", online: false, ip: "10.77.0.12" }, res, null);
    expect(host).toMatchObject({ key: "pve2", online: false, hostname: "pve2", ip: "10.77.0.12", cpuCount: 4, pools: [] });
  });
});

// ─── Transport ────────────────────────────────────────────────────────────────

type Behaviour = { error?: string } | { status: number; body: unknown };

function fakeHttps(byHost: Record<string, Behaviour>) {
  h.request.mockImplementation((opts: any, cb: (res: any) => void) => {
    const req = new EventEmitter() as any;
    req.destroy = () => {};
    req.end = () => {
      const b = byHost[opts.hostname];
      queueMicrotask(() => {
        if (!b || "error" in b) {
          req.emit("error", Object.assign(new Error(b && "error" in b ? b.error! : "ECONNREFUSED"), { code: b && "error" in b ? b.error : "ECONNREFUSED" }));
          return;
        }
        const res = new EventEmitter() as any;
        res.statusCode = b.status;
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify(b.body)));
        res.emit("end");
      });
    };
    return req;
  });
}

const CFG = { host: "10.0.0.1", fallbackHosts: ["10.0.0.2", "10.0.0.1"], apiTokenId: "polaris@pve!mon", apiToken: "s3cret", verifyTls: false };

describe("proxmoxGet", () => {
  beforeEach(() => h.request.mockReset());

  it("dedupes the address list, keeping order", () => {
    expect(pve.proxmoxEndpoints(CFG)).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("sends the token header and unwraps `data`", async () => {
    fakeHttps({ "10.0.0.1": { status: 200, body: { data: { version: "9.2.2" } } } });
    await expect(pve.proxmoxGet({ ...CFG, fallbackHosts: [] }, "/version")).resolves.toEqual({ version: "9.2.2" });
    const opts = h.request.mock.calls[0]![0];
    expect(opts.headers.Authorization).toBe("PVEAPIToken=polaris@pve!mon=s3cret");
    expect(opts.path).toBe("/api2/json/version");
    expect(opts.port).toBe(8006);
    expect(opts.rejectUnauthorized).toBe(false);
  });

  it("moves to the next address when one does not answer, and starts there next time", async () => {
    const cfg = { ...CFG, host: "10.9.0.1", fallbackHosts: ["10.9.0.2"] };
    fakeHttps({ "10.9.0.1": { error: "ECONNREFUSED" }, "10.9.0.2": { status: 200, body: { data: [1] } } });
    await expect(pve.proxmoxGet(cfg, "/nodes")).resolves.toEqual([1]);
    h.request.mockClear();
    await pve.proxmoxGet(cfg, "/nodes");
    expect(h.request.mock.calls.map((c) => c[0].hostname)).toEqual(["10.9.0.2"]);
  });

  it("does NOT fall through on an answer — a bad token is the cluster's verdict, not a dead address", async () => {
    const cfg = { ...CFG, host: "10.8.0.1", fallbackHosts: ["10.8.0.2"] };
    fakeHttps({ "10.8.0.1": { status: 401, body: {} }, "10.8.0.2": { status: 200, body: { data: [] } } });
    await expect(pve.proxmoxGet(cfg, "/nodes")).rejects.toThrow(/rejected the API token/);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("reports Proxmox's own reason for a refused request", async () => {
    fakeHttps({ "10.7.0.1": { status: 500, body: { data: null, message: "No QEMU guest agent configured\n" } } });
    await expect(pve.proxmoxGet({ ...CFG, host: "10.7.0.1", fallbackHosts: [] }, "/nodes/a/qemu/1/agent/x"))
      .rejects.toThrow(/No QEMU guest agent configured/);
  });

  it("names every address when none answers", async () => {
    fakeHttps({});
    await expect(pve.proxmoxGet({ ...CFG, host: "10.6.0.1", fallbackHosts: ["10.6.0.2"] }, "/version"))
      .rejects.toThrow(/No configured Proxmox address answered — Connection refused — 10\.6\.0\.1:8006; Connection refused — 10\.6\.0\.2:8006/);
  });
});

describe("testConnection", () => {
  beforeEach(() => h.request.mockReset());

  it("summarizes the cluster, counting offline nodes", async () => {
    h.request.mockImplementation((opts: any, cb: (res: any) => void) => {
      const req = new EventEmitter() as any;
      req.destroy = () => {};
      req.end = () => queueMicrotask(() => {
        const data = opts.path.endsWith("/version") ? { version: "9.2.2" }
          : opts.path.endsWith("/cluster/status") ? CLUSTER_STATUS : RESOURCES;
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ data })));
        res.emit("end");
      });
      return req;
    });
    const r = await pve.testConnection({ ...CFG, host: "10.5.0.1", fallbackHosts: [] });
    expect(r).toEqual({ ok: true, message: 'Connected to cluster "lab" (Proxmox VE 9.2.2) — 2 node(s) (1 offline), 2 VM(s), 2 container(s)' });
  });
});

describe("isProxyReadPath", () => {
  it("allows the reads an operator needs to explain a discovery, and nothing else", () => {
    for (const p of ["/version", "/cluster/resources", "/cluster/status", "/nodes", "/nodes/pve1/status", "/nodes/pve1/disks/zfs/tank",
      "/nodes/pve1/qemu/101/config", "/nodes/pve1/qemu/101/agent/network-get-interfaces", "/nodes/pve1/lxc/100/interfaces",
      "/nodes/pve1/rrddata?timeframe=hour&cf=AVERAGE"]) {
      expect(pve.isProxyReadPath(p), p).toBe(true);
    }
    for (const p of ["/access/users", "/nodes/pve1/execute", "/nodes/pve1/qemu/101/agent/exec", "/cluster/../access/users", "/storage", "/nodes/pve1/qemu/101/status/start"]) {
      expect(pve.isProxyReadPath(p), p).toBe(false);
    }
  });
});
