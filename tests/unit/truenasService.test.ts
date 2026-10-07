import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";

vi.mock("../../src/services/discovery/discoveryEngine.js", () => ({
  indexHostname: vi.fn(), lookupHostname: vi.fn(), normalizeMacKey: vi.fn(), upsertAssetConflict: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({ prisma: {} }));

const tn = await import("../../src/services/truenasService.js");

// Synthetic — shaped like TrueNAS 25.10's JSON-RPC answers, no real host data.
const INFO = {
  version: "TrueNAS-SCALE-25.10.1", hostname: "nas01", physmem: 68719476736, model: "AMD Ryzen 5 5600G",
  cores: 12, uptime_seconds: 3600, system_serial: "A1B2C3", system_product: "TrueNAS Mini X+", system_manufacturer: "iXsystems",
};
const POOLS = [{ name: "tank", status: "ONLINE", size: 1000, allocated: 250 }];
const APPS = [
  {
    name: "plex", state: "RUNNING", upgrade_available: true, image_updates_available: false, human_version: "1.40.0_1.2.3",
    version: "1.2.3", latest_version: "1.2.4",
    active_workloads: {
      containers: 1,
      container_details: [{ id: "x", service_name: "plex", image: "plexinc/pms-docker:1.40.0", state: "running" }],
      used_ports: [{ container_port: 32400, protocol: "tcp", host_ports: [{ host_port: 32400, host_ip: "0.0.0.0" }] }],
      images: ["plexinc/pms-docker:1.40.0"],
    },
  },
  { name: "custom-db", state: "CRASHED", upgrade_available: false, image_updates_available: true, active_workloads: { containers: 2, container_details: [], images: ["postgres:16"] } },
];
const VMS = [{
  id: 3, name: "win11", uuid: "AAAA-BBBB", vcpus: 1, cores: 4, threads: 2, memory: 8192, autostart: true,
  status: { state: "RUNNING" },
  devices: [{ attributes: { dtype: "NIC", mac: "00:a0:98:11:22:33" } }, { attributes: { dtype: "DISK" } }],
}];

describe("truenas parsing", () => {
  it("reads the host: product (not CPU) as model, version without the product prefix", () => {
    const h = tn.parseTrueNasHost(INFO, POOLS, { sda: 34, sdb: { temperature: 0 } }, [{ name: "sda", serial: "S1", pool: "tank" }], { host: "10.0.0.5" });
    expect(h).toMatchObject({ hostname: "nas01", os: "TrueNAS SCALE", osVersion: "25.10.1", model: "TrueNAS Mini X+", serial: "A1B2C3", cpuCount: 12, ip: "10.0.0.5" });
    expect(h.pools).toEqual([{ name: "tank", kind: "zfs", totalBytes: 1000, usedBytes: 250, health: "ONLINE" }]);
    expect(h.disks).toEqual([
      { name: "sda", serial: "S1", temperatureC: 34, pool: "tank" },
      { name: "sdb", serial: null, temperatureC: null, pool: null },
    ]);
  });

  it("reads Apps: either update flag counts, crashed is stopped, ports deduped", () => {
    const [plex, db] = tn.parseTrueNasApps(APPS);
    expect(plex).toMatchObject({ platformId: "plex", state: "running", updateAvailable: true, version: "1.40.0_1.2.3", latestVersion: "1.2.4", image: "plexinc/pms-docker:1.40.0", memberCount: 1, ports: ["*:32400"] });
    expect(db).toMatchObject({ state: "stopped", updateAvailable: true, image: "postgres:16", memberCount: 2 });
  });

  it("reads VMs: memory MiB → bytes, vCPU product, NIC MACs only", () => {
    const [vm] = tn.parseTrueNasVms(VMS);
    expect(vm).toMatchObject({ platformId: "3", name: "win11", uuid: "aaaa-bbbb", state: "running", cpuCount: 8, memoryBytes: 8192 * 1024 * 1024, macs: ["00:a0:98:11:22:33"] });
  });

  it("reads reporting.realtime: aggregate + ordered per-core CPU, memory used = total − available", () => {
    const u = tn.parseTrueNasRealtime({
      cpu: { cpu: { usage: 20 }, cpu10: { usage: 5 }, cpu2: { usage: 30 }, cpu1: { usage: 10 } },
      memory: { physical_memory_total: 1000, physical_memory_available: 400 },
      interfaces: { eno1: { link_state: "LINK_STATE_UP", speed: 1000 } },
    });
    expect(u.cpuPct).toBe(20);
    expect(u.perCorePct).toEqual([10, 30, 5]);
    expect(u.memUsedBytes).toBe(600);
    expect(u.interfaces[0]).toMatchObject({ name: "eno1", operUp: true, speedMbps: 1000, rxBytes: null });
  });

  it("reads app.stats rows keyed by app name", () => {
    const m = tn.parseTrueNasAppStats([{ app_name: "plex", cpu_usage: 7, memory: 123, networks: [], blkio: { read: 0, write: 0 } }]);
    expect(m.get("plex")).toEqual({ cpuPct: 7, memUsedBytes: 123, memTotalBytes: null });
  });

  it("allows only read methods through the query tool", () => {
    expect(tn.isProxyReadMethod("app.query")).toBe(true);
    expect(tn.isProxyReadMethod("system.info")).toBe(true);
    expect(tn.isProxyReadMethod("app.stop")).toBe(false);
    expect(tn.isProxyReadMethod("vm.delete")).toBe(false);
  });
});

// ─── The session, against a stub JSON-RPC server ─────────────────────────────

describe("truenas session (stub server)", () => {
  let wss: WebSocketServer;
  let port = 0;
  const jobs = new Map<number, { polls: number; method: string }>();
  let nextJob = 100;
  const calls: string[] = [];

  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0, path: "/api/current" });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    port = (wss.address() as AddressInfo).port;
    wss.on("connection", (ws) => {
      let authed = false;
      ws.on("message", (buf) => {
        const m = JSON.parse(String(buf));
        calls.push(m.method);
        const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
        const fail = (reason: string) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32001, message: "method call error", data: { reason } } }));
        if (m.method === "auth.login_with_api_key") { authed = m.params[0] === "good-key"; return reply(authed); }
        if (!authed) return fail("Not authenticated");
        switch (m.method) {
          case "system.info": return reply(INFO);
          case "pool.query": return reply(POOLS);
          case "app.query": return reply(m.params?.[0]?.length ? APPS.filter((a) => a.name === m.params[0][0][2]) : APPS);
          case "vm.query": return fail("Insufficient privileges"); // a key without VM_READ
          case "disk.temperatures": return reply({ sda: 33 });
          case "disk.query": return reply([{ name: "sda", serial: "S1", pool: "tank" }]);
          case "core.subscribe": {
            reply("sub-1");
            const name = String(m.params[0]);
            setTimeout(() => {
              const fields = name.startsWith("reporting.realtime")
                ? { cpu: { cpu: { usage: 11 } }, memory: { physical_memory_total: 100, physical_memory_available: 40 }, interfaces: {} }
                : [{ app_name: "plex", cpu_usage: 3, memory: 50, networks: [], blkio: { read: 0, write: 0 } }];
              ws.send(JSON.stringify({ jsonrpc: "2.0", method: "collection_update", params: { msg: "added", collection: name.split(":")[0], fields } }));
            }, 20);
            return;
          }
          case "app.upgrade":
          case "app.stop": { const id = nextJob++; jobs.set(id, { polls: 0, method: m.method }); return reply(id); }
          case "core.get_jobs": {
            const id = m.params[0][0][2];
            const j = jobs.get(id)!;
            j.polls++;
            return reply([{ id, state: j.polls >= 2 ? (j.method === "app.stop" ? "FAILED" : "SUCCESS") : "RUNNING", error: "app is busy" }]);
          }
          default: return fail(`unknown method ${m.method}`);
        }
      });
    });
  });
  afterAll(() => wss.close());

  const cfg = () => ({ host: "127.0.0.1", port, useTls: false, apiToken: "good-key" });

  it("tests the connection and names what it could not read", async () => {
    const r = await tn.testConnection(cfg());
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/nas01 \(TrueNAS 25\.10\.1\)/);
    expect(r.message).toMatch(/2 App\(s\)/);
    expect(r.message).toMatch(/VMs unreadable/);
  });

  it("refuses a bad key with an operator-readable reason", async () => {
    const r = await tn.testConnection({ ...cfg(), apiToken: "bad" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/rejected the API key/);
  });

  it("marks the inventory incomplete when VMs could not be read", async () => {
    const inv = await tn.discoverInventory(cfg());
    expect(inv.containers.map((c) => c.name)).toEqual(["plex", "custom-db"]);
    expect(inv.vms).toEqual([]);
    expect(inv.inventoryComplete).toBe(false);
  });

  it("builds a snapshot from the two event sources on one socket", async () => {
    const snap = await tn.fetchTrueNasSnapshot(cfg());
    expect(snap.host.cpuPct).toBe(11);
    expect(snap.host.memUsedBytes).toBe(60);
    expect(snap.containerUsage.get("plex")).toEqual({ cpuPct: 3, memUsedBytes: 50, memTotalBytes: null });
  });

  it("runs an update as app.upgrade when a catalog version is offered, and waits for the job", async () => {
    await expect(tn.appAction(cfg(), "plex", "update")).resolves.toBeUndefined();
    expect(calls).toContain("app.upgrade");
  }, 15_000);

  it("surfaces a failed job's error", async () => {
    await expect(tn.appAction(cfg(), "plex", "stop")).rejects.toThrow(/app is busy/);
  }, 15_000);

  it("refuses a write method in the query tool before connecting", async () => {
    await expect(tn.proxyQuery(cfg(), "app.delete", ["plex"])).rejects.toThrow(/Only read methods/);
  });
});
