/**
 * tests/unit/queueService.test.ts — the queue mode and the pg-boss runtime
 * lifecycle, against a fake PgBoss (CQ-T010).
 *
 * Complements, does not repeat:
 *   - queueDiscovery.test.ts — DISCOVERY_QUEUE_NAME / heartbeat constant and
 *     publishDiscoveryJob from the discovery runner's side
 *   - capacityService / capacityAdvisorService / networkScanValidate — callers
 *     that mock this module
 *
 * What was unreached: getQueueMode's cursor fallbacks (no row, a malformed
 * value, pg-boss not detected, a DB error) and its cache; setQueueMode
 * changing the Setting but never the boot-time mode; every publisher being a
 * no-op / false while pg-boss is not running; ensureBoss (the direct URL, the
 * pool size, no URL → cursor); ensureQueues (stately per-asset queues with
 * their per-cadence expiry, the one-time recreate of a queue stored with the
 * old singleton policy, the singleton discovery + scan queues with the job
 * heartbeat); the publishers' singleton keys and the 500-job insert chunk;
 * failActiveDiscoveryJobs failing only ACTIVE jobs; the discovery / scan /
 * monitor workers' registration and dispatch; stop; and the stalled-worker
 * watchdog (four consecutive stalled readings → stop → start).
 *
 * Module state is per-process, so every test loads a fresh copy
 * (vi.resetModules) and its own stubbed client. Timers are fake: the metrics
 * interval and the floating loop's idle sleep never fire on their own.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  const instances: any[] = [];
  const seedQueues = new Map<string, Record<string, unknown>>();
  class FakeBoss {
    opts: Record<string, unknown>;
    queues = new Map<string, Record<string, unknown>>();
    handlers = new Map<string, { opts: Record<string, unknown>; fn: (jobs: unknown[]) => Promise<void> }>();
    on = vi.fn();
    start = vi.fn(async () => undefined);
    stop = vi.fn(async () => undefined);
    createQueue = vi.fn(async (name: string, o: Record<string, unknown>) => {
      if (!this.queues.has(name)) this.queues.set(name, { name, ...o });
    });
    getQueue = vi.fn(async (name: string) => this.queues.get(name) ?? null);
    deleteQueue = vi.fn(async (name: string) => { this.queues.delete(name); });
    updateQueue = vi.fn(async () => undefined);
    work = vi.fn(async (name: string, opts: Record<string, unknown>, fn: (jobs: unknown[]) => Promise<void>) => {
      this.handlers.set(name, { opts, fn });
      return "worker-id";
    });
    insert = vi.fn(async () => undefined);
    send = vi.fn(async () => "job-id");
    findJobs = vi.fn(async (): Promise<Array<{ id: string; state: string }>> => []);
    fail = vi.fn(async () => undefined);
    fetch = vi.fn(async () => []);
    complete = vi.fn(async () => undefined);
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      for (const [k, v] of seedQueues) this.queues.set(k, { ...v });
      instances.push(this);
    }
  }
  return {
    instances,
    seedQueues,
    FakeBoss,
    directUrl: vi.fn(() => "postgres://direct/polaris"),
    metrics: {
      setPgbossQueueJobs: vi.fn(),
      setPgbossJobAge: vi.fn(),
      recordQueueMode: vi.fn(),
      setMonitorWorkers: vi.fn(),
    },
    run: {
      runProbeFor: vi.fn(async () => undefined),
      runProbeBatchFor: vi.fn(async () => undefined),
      runTelemetryFor: vi.fn(async () => undefined),
      runSystemInfoFor: vi.fn(async () => undefined),
      runFastFilteredFor: vi.fn(async () => undefined),
      runLldpFor: vi.fn(async () => undefined),
      runStorageFor: vi.fn(async () => undefined),
      runProcessesFor: vi.fn(async () => undefined),
      runEventLogFor: vi.fn(async () => undefined),
      runCustomWidgetsFor: vi.fn(async () => undefined),
      runSdwanFor: vi.fn(async () => undefined),
      runLossSweepFor: vi.fn(async () => undefined),
    },
  };
});

vi.mock("pg-boss", () => ({ PgBoss: h.FakeBoss }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/utils/dbConnections.js", () => ({ getDirectDatabaseUrl: h.directUrl }));
vi.mock("../../src/metrics.js", () => h.metrics);
vi.mock("../../src/services/monitoringService.js", () => h.run);

type Q = typeof import("../../src/services/queueService.js");
let q: Q;
let prisma: any;

async function load(mode: "cursor" | "pgboss" | null = null): Promise<Q> {
  vi.resetModules();
  prisma = (await import("../../src/db.js")).prisma;
  q = await import("../../src/services/queueService.js");
  prisma.setting.findUnique.mockResolvedValue(mode ? { key: "monitor.queueMode", value: { mode } } : null);
  return q;
}
async function loadPgboss(): Promise<Q> {
  await load("pgboss");
  await q.initializeQueue();
  return q;
}
const boss = (i = 0) => h.instances[i];

const ENV_KEYS = ["POLARIS_PGBOSS_POOL_SIZE", "POLARIS_DISCOVERY_WORKERS", "POLARIS_MONITOR_FLOATING_WORKERS", "POLARIS_MONITOR_PROBE_WORKERS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  vi.useFakeTimers();
  h.instances.length = 0;
  h.seedQueues.clear();
  h.directUrl.mockReset();
  h.directUrl.mockReturnValue("postgres://direct/polaris");
  for (const f of Object.values(h.metrics)) f.mockReset();
  for (const f of Object.values(h.run)) f.mockClear();
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(async () => {
  if (q) await q.stopPgbossWorkers();
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("queue mode", () => {
  it("defaults to cursor with no Setting, and caches the read", async () => {
    await load(null);
    await expect(q.getQueueMode()).resolves.toBe("cursor");
    await q.getQueueMode();
    expect(prisma.setting.findUnique).toHaveBeenCalledTimes(1);
    expect(q.getBootTimeMode()).toBe("cursor");
  });

  it("a pgboss Setting reads as cursor until pg-boss has been detected", async () => {
    await load("pgboss");
    expect(q.isPgbossInstalled()).toBe(false);
    await expect(q.getQueueMode()).resolves.toBe("cursor");
  });

  it("initializeQueue detects pg-boss, captures the boot mode and records it", async () => {
    await loadPgboss();
    expect(q.isPgbossInstalled()).toBe(true);
    expect(q.getBootTimeMode()).toBe("pgboss");
    expect(h.metrics.recordQueueMode).toHaveBeenCalledWith("pgboss");
  });

  it("a malformed value or a DB error falls back to cursor", async () => {
    await load(null);
    prisma.setting.findUnique.mockResolvedValue({ value: { mode: "rabbitmq" } });
    await expect(q.getQueueMode()).resolves.toBe("cursor");
    await load(null);
    prisma.setting.findUnique.mockRejectedValue(new Error("db down"));
    await expect(q.getQueueMode()).resolves.toBe("cursor");
  });

  it("setQueueMode writes the Setting and the cache, but never the running process's mode", async () => {
    await load(null);
    await q.initializeQueue();
    await q.setQueueMode("pgboss");
    expect(prisma.setting.upsert).toHaveBeenCalledWith({
      where: { key: "monitor.queueMode" },
      update: { value: { mode: "pgboss" } },
      create: { key: "monitor.queueMode", value: { mode: "pgboss" } },
    });
    await expect(q.getQueueMode()).resolves.toBe("pgboss");
    expect(q.getBootTimeMode()).toBe("cursor");
  });
});

describe("cursor mode: nothing reaches pg-boss", () => {
  it("producer / workers never open a connection, and every publisher is a no-op", async () => {
    await load("cursor");
    await q.initializeQueue();
    await q.startQueueProducer();
    await q.startDiscoveryWorker(async () => undefined);
    await q.startScanWorker(async () => undefined);
    await q.startPgbossWorkers();
    expect(h.instances).toHaveLength(0);
    expect(q.isPgbossRunning()).toBe(false);
    await expect(q.publishDiscoveryJob("i1", "alice")).resolves.toBe(false);
    await expect(q.publishScanJob("r1", "s1", "alice")).resolves.toBe(false);
    await expect(q.failActiveDiscoveryJobs("i1", "x")).resolves.toBe(0);
    await expect(q.publishMonitorJobsBulk("probe", [{ assetId: "a" }])).resolves.toBeUndefined();
    await expect(q.stopPgbossWorkers()).resolves.toBeUndefined();
  });

  it("pgboss mode without a database URL stays on cursor", async () => {
    await loadPgboss();
    h.directUrl.mockReturnValue("");
    await q.startQueueProducer();
    expect(h.instances).toHaveLength(0);
  });
});

describe("ensureBoss + ensureQueues (via startQueueProducer)", () => {
  it("opens ONE connection on the direct URL with the configured pool size", async () => {
    process.env.POLARIS_PGBOSS_POOL_SIZE = "35";
    await loadPgboss();
    await q.startQueueProducer();
    await q.startQueueProducer();
    expect(h.instances).toHaveLength(1);
    expect(boss().opts).toEqual({ connectionString: "postgres://direct/polaris", max: 35 });
    expect(boss().start).toHaveBeenCalledTimes(1);
    expect(boss().on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(q.isPgbossRunning()).toBe(true);
  });

  it("a non-numeric pool size falls back to 20", async () => {
    process.env.POLARIS_PGBOSS_POOL_SIZE = "lots";
    await loadPgboss();
    await q.startQueueProducer();
    expect(boss().opts.max).toBe(20);
  });

  it("every monitor queue is stately with no retry and its own expiry; config is re-applied with updateQueue", async () => {
    await loadPgboss();
    await q.startQueueProducer();
    const created = new Map<string, any>(boss().createQueue.mock.calls.map((c: any[]) => [c[0], c[1]]));
    for (const name of Object.values(q.QUEUE_NAMES)) {
      expect(created.get(name)).toMatchObject({ policy: "stately", retryLimit: 0, deleteAfterSeconds: 86_400, retentionSeconds: 3_600 });
    }
    expect(created.get(q.QUEUE_NAMES.probe).expireInSeconds).toBe(30);
    expect(created.get(q.QUEUE_NAMES.lossSample).expireInSeconds).toBe(15);
    expect(created.get(q.QUEUE_NAMES.systemInfo).expireInSeconds).toBe(300);
    const updated = new Map<string, any>(boss().updateQueue.mock.calls.map((c: any[]) => [c[0], c[1]]));
    expect(updated.get(q.QUEUE_NAMES.telemetry)).toEqual({ retryLimit: 0, deleteAfterSeconds: 86_400, retentionSeconds: 3_600, expireInSeconds: 180 });
    expect(boss().deleteQueue).not.toHaveBeenCalled();
  });

  it("the discovery and scan queues are singleton with the job heartbeat", async () => {
    await loadPgboss();
    await q.startQueueProducer();
    const created = new Map<string, any>(boss().createQueue.mock.calls.map((c: any[]) => [c[0], c[1]]));
    for (const name of [q.DISCOVERY_QUEUE_NAME, "polaris-network-scan"]) {
      expect(created.get(name)).toMatchObject({ policy: "singleton", retryLimit: 0, retentionSeconds: 7_200, expireInSeconds: 3_600, heartbeatSeconds: q.DISCOVERY_JOB_HEARTBEAT_SECONDS });
    }
  });

  it("a monitor queue stored with the old singleton policy is recreated once as stately", async () => {
    h.seedQueues.set("polaris-monitor-probe", { name: "polaris-monitor-probe", policy: "singleton" });
    await loadPgboss();
    await q.startQueueProducer();
    expect(boss().deleteQueue).toHaveBeenCalledTimes(1);
    expect(boss().deleteQueue).toHaveBeenCalledWith("polaris-monitor-probe");
    expect(boss().queues.get("polaris-monitor-probe").policy).toBe("stately");
  });
});

describe("publishers (pg-boss live)", () => {
  beforeEach(async () => {
    await loadPgboss();
    await q.startQueueProducer();
  });

  it("bulk monitor jobs: one insert per 500, each keyed asset:cadence", async () => {
    const jobs = Array.from({ length: 1001 }, (_, i) => ({ assetId: `a${i}`, transport: "snmp", assetType: "switch", probeIntervalSec: 30 }));
    await q.publishMonitorJobsBulk("telemetry", jobs);
    expect(boss().insert).toHaveBeenCalledTimes(3);
    const [name, first] = boss().insert.mock.calls[0];
    expect(name).toBe("polaris-monitor-telemetry");
    expect(first).toHaveLength(500);
    expect(first[0]).toEqual({ data: { assetId: "a0", transport: "snmp", assetType: "switch", verboseDebug: undefined, probeIntervalSec: 30 }, singletonKey: "a0:telemetry" });
    expect(boss().insert.mock.calls[2][1]).toHaveLength(1);
    boss().insert.mockClear();
    await q.publishMonitorJobsBulk("probe", []);
    expect(boss().insert).not.toHaveBeenCalled();
  });

  it("probe batches and sweep chunks are keyed by chunk index, labelled mixed", async () => {
    await q.publishProbeBatchJob([{ id: "a1", target: "10.0.0.1", timeoutMs: 2000 }], 3, { verboseDebug: true });
    expect(boss().send).toHaveBeenLastCalledWith("polaris-monitor-probe",
      { assetId: "probe-batch:3", probeBatch: [{ id: "a1", target: "10.0.0.1", timeoutMs: 2000 }], transport: "icmp", assetType: "mixed", verboseDebug: true },
      { singletonKey: "probe:chunk:3" });
    await q.publishMonitorSweepJob("lossSample", ["a1", "a2"], 7, { transport: "icmp" });
    expect(boss().send).toHaveBeenLastCalledWith("polaris-monitor-losssample",
      expect.objectContaining({ assetId: "sweep:7", assetIds: ["a1", "a2"], assetType: "mixed" }),
      { singletonKey: "lossSample:chunk:7" });
    boss().send.mockClear();
    await q.publishProbeBatchJob([], 1);
    await q.publishMonitorSweepJob("lossSample", [], 1);
    expect(boss().send).not.toHaveBeenCalled();
  });

  it("discovery is keyed on the integration, scan on the SCAN (not the run)", async () => {
    await expect(q.publishDiscoveryJob("int-1", "alice")).resolves.toBe(true);
    expect(boss().send).toHaveBeenLastCalledWith(q.DISCOVERY_QUEUE_NAME, { integrationId: "int-1", actor: "alice" }, { singletonKey: "int-1" });
    const scope = { kind: "fmg-device", deviceName: "FG-1" } as never;
    await q.publishDiscoveryJob("int-1", "alice", scope);
    expect(boss().send.mock.calls.at(-1)[1]).toEqual({ integrationId: "int-1", actor: "alice", scope });
    await expect(q.publishScanJob("run-9", "scan-2", "bob")).resolves.toBe(true);
    expect(boss().send).toHaveBeenLastCalledWith("polaris-network-scan", { runId: "run-9", scanId: "scan-2", actor: "bob" }, { singletonKey: "scan-2" });
  });

  it("failActiveDiscoveryJobs fails only the ACTIVE jobs for that integration", async () => {
    boss().findJobs.mockResolvedValue([{ id: "j1", state: "active" }, { id: "j2", state: "created" }, { id: "j3", state: "active" }]);
    await expect(q.failActiveDiscoveryJobs("int-1", "cancelled")).resolves.toBe(2);
    expect(boss().findJobs).toHaveBeenCalledWith(q.DISCOVERY_QUEUE_NAME, { key: "int-1" });
    expect(boss().fail).toHaveBeenCalledWith(q.DISCOVERY_QUEUE_NAME, ["j1", "j3"], { message: "cancelled" });
    boss().fail.mockClear();
    boss().findJobs.mockResolvedValue([{ id: "j2", state: "created" }]);
    await expect(q.failActiveDiscoveryJobs("int-1", "x")).resolves.toBe(0);
    expect(boss().fail).not.toHaveBeenCalled();
  });

  it("stop is graceful, resets everything, and a later start opens a fresh connection", async () => {
    await q.stopPgbossWorkers();
    expect(boss(0).stop).toHaveBeenCalledWith({ graceful: true, timeout: 30_000 });
    expect(q.isPgbossRunning()).toBe(false);
    await expect(q.publishScanJob("r", "s", "a")).resolves.toBe(false);
    await q.startQueueProducer();
    expect(h.instances).toHaveLength(2);
    expect(boss(1).createQueue).toHaveBeenCalled();
  });
});

describe("workers", () => {
  it("discovery worker: default concurrency 2, hands the job's data to the injected handler, registers once", async () => {
    await loadPgboss();
    const handler = vi.fn(async () => undefined);
    await q.startDiscoveryWorker(handler);
    await q.startDiscoveryWorker(handler);
    expect(boss().work).toHaveBeenCalledTimes(1);
    const reg = boss().handlers.get(q.DISCOVERY_QUEUE_NAME);
    expect(reg.opts).toEqual({ localConcurrency: 2, batchSize: 1, pollingIntervalSeconds: 5 });
    await reg.fn([{ data: { integrationId: "i9", actor: "sched", scope: { kind: "x" } } }]);
    expect(handler).toHaveBeenCalledWith("i9", "sched", { kind: "x" });
  });

  it("scan worker: one at a time per node, run id + actor to the handler", async () => {
    await loadPgboss();
    const handler = vi.fn(async () => undefined);
    await q.startScanWorker(handler);
    const reg = boss().handlers.get("polaris-network-scan");
    expect(reg.opts.localConcurrency).toBe(1);
    await reg.fn([{ data: { runId: "r1", scanId: "s1", actor: "alice" } }]);
    expect(handler).toHaveBeenCalledWith("r1", "alice");
  });

  it("monitor workers: a handler per cadence, sized from env, dispatching to the matching runner", async () => {
    process.env.POLARIS_MONITOR_PROBE_WORKERS = "6";
    await loadPgboss();
    await q.startPgbossWorkers();
    for (const name of Object.values(q.QUEUE_NAMES)) expect(boss().handlers.has(name)).toBe(true);
    expect(boss().handlers.get("polaris-monitor-probe").opts).toEqual({ localConcurrency: 6, batchSize: 1, pollingIntervalSeconds: 1 });
    expect(h.metrics.setMonitorWorkers).toHaveBeenCalledWith(expect.objectContaining({ probe: 6, telemetry: 24, lldp: 12, sdwan: 8, floating: 32 }));

    const probe = boss().handlers.get("polaris-monitor-probe").fn;
    await probe([{ id: "j", data: { assetId: "a1", transport: "snmp", assetType: "switch", probeIntervalSec: 60 } }]);
    expect(h.run.runProbeFor).toHaveBeenCalledWith("a1", { transport: "snmp", assetType: "switch", verbose: false }, 60);
    const batch = [{ id: "a2", target: "10.0.0.2", timeoutMs: 1000 }];
    await probe([{ id: "j", data: { assetId: "probe-batch:0", probeBatch: batch } }]);
    expect(h.run.runProbeBatchFor).toHaveBeenCalledWith(batch, { transport: "unknown", assetType: "unknown", verbose: false });
    await probe([]); // an empty fetch is not an error

    await boss().handlers.get("polaris-monitor-losssample").fn([{ id: "j", data: { assetId: "sweep:1", assetIds: ["x", "y"] } }]);
    expect(h.run.runLossSweepFor).toHaveBeenCalledWith(["x", "y"], expect.any(Object));
    await boss().handlers.get("polaris-monitor-losssample").fn([{ id: "j", data: { assetId: "solo" } }]);
    expect(h.run.runLossSweepFor).toHaveBeenLastCalledWith(["solo"], expect.any(Object));

    await boss().handlers.get("polaris-monitor-sdwan").fn([{ id: "j", data: { assetId: "fg1" } }]);
    expect(h.run.runSdwanFor).toHaveBeenCalledWith("fg1", expect.any(Object));
  });

  it("a runner failure fails the job (rethrows to pg-boss)", async () => {
    await loadPgboss();
    await q.startPgbossWorkers();
    h.run.runTelemetryFor.mockRejectedValueOnce(new Error("snmp timeout"));
    await expect(boss().handlers.get("polaris-monitor-telemetry").fn([{ id: "j", data: { assetId: "a1" } }])).rejects.toThrow("snmp timeout");
  });

  // Was a bug until 2026-11-12: resolveEnvInt() rejected 0, so =0 gave 32
  // floating workers and the 'pool disabled' branch was unreachable.
  it("POLARIS_MONITOR_FLOATING_WORKERS=0 disables the floating pool", async () => {
    process.env.POLARIS_MONITOR_FLOATING_WORKERS = "0";
    await loadPgboss();
    await q.startPgbossWorkers();
    expect(h.metrics.setMonitorWorkers).toHaveBeenCalledWith(expect.objectContaining({ floating: 0 }));
  });
});

describe("the stalled-worker watchdog", () => {
  const stalled = [{ name: "polaris-monitor-probe", state: "created", count: 60, age_seconds: 90 }];

  it("zero-fills every queue's gauges, then sets what the query returned", async () => {
    await loadPgboss();
    prisma.$queryRaw.mockResolvedValue([{ name: "polaris-monitor-telemetry", state: "created", count: 4, age_seconds: 12.5 }]);
    await q.startQueueProducer();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.metrics.setPgbossQueueJobs).toHaveBeenCalledWith("polaris-network-scan", "failed", 0);
    expect(h.metrics.setPgbossQueueJobs).toHaveBeenLastCalledWith("polaris-monitor-telemetry", "created", 4);
    expect(h.metrics.setPgbossJobAge).toHaveBeenLastCalledWith("polaris-monitor-telemetry", "created", 12.5);
  });

  it("acts only after FOUR consecutive stalled readings, with a hard stop", async () => {
    await loadPgboss();
    prisma.$queryRaw.mockResolvedValue(stalled);
    await q.startPgbossWorkers();
    await vi.advanceTimersByTimeAsync(0);          // reading 1 (immediate)
    await vi.advanceTimersByTimeAsync(15_000 * 2); // readings 2, 3
    expect(boss(0).stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);     // reading 4 → recovery
    expect(boss(0).stop).toHaveBeenCalledWith({ graceful: false, timeout: 10_000 });
  });

  it("a healthy reading in between resets the count", async () => {
    await loadPgboss();
    prisma.$queryRaw.mockResolvedValue(stalled);
    await q.startPgbossWorkers();
    await vi.advanceTimersByTimeAsync(15_000 * 2); // readings 1-3
    prisma.$queryRaw.mockResolvedValueOnce([{ name: "polaris-monitor-probe", state: "active", count: 1, age_seconds: 1 }]);
    await vi.advanceTimersByTimeAsync(15_000);     // healthy
    await vi.advanceTimersByTimeAsync(15_000 * 3); // 3 more stalled
    expect(boss(0).stop).not.toHaveBeenCalled();
  });

  it("heavy queues stalled while probes run still count as stalled", async () => {
    await loadPgboss();
    prisma.$queryRaw.mockResolvedValue([
      { name: "polaris-monitor-systeminfo", state: "created", count: 80, age_seconds: 300 },
      { name: "polaris-monitor-probe", state: "active", count: 5, age_seconds: 1 },
    ]);
    await q.startPgbossWorkers();
    await vi.advanceTimersByTimeAsync(15_000 * 3);
    expect(boss(0).stop).toHaveBeenCalledWith({ graceful: false, timeout: 10_000 });
  });

  // The watchdog reads the SHARED pgboss.job table, so a web (producer) or
  // discovery process sees the same stall. Only the process running the
  // monitor consumers may act on it: before 2026-11-12 a producer stopped
  // its own boss (and would have started monitor workers in the wrong role).
  it("a producer-only process never acts on a stall", async () => {
    await loadPgboss();
    prisma.$queryRaw.mockResolvedValue(stalled);
    await q.startQueueProducer();
    await vi.advanceTimersByTimeAsync(15_000 * 8);
    expect(boss(0).stop).not.toHaveBeenCalled();
    expect(h.instances).toHaveLength(1);
    expect(q.isPgbossRunning()).toBe(true);
  });

  // Was a bug until 2026-11-12: recovery stopped the boss but never cleared the
  // start* idempotency flags, so startPgbossWorkers() returned at once and the
  // process was left with NO boss — monitoring, discovery and scan dispatch all
  // stopped until a restart, while the log said recovery completed.
  it("after recovery pg-boss is running again on a fresh connection", async () => {
    await loadPgboss();
    prisma.$queryRaw.mockResolvedValue(stalled);
    await q.startPgbossWorkers();
    await vi.advanceTimersByTimeAsync(15_000 * 3);
    expect(boss(0).stop).toHaveBeenCalledWith({ graceful: false, timeout: 10_000 });
    expect(h.instances).toHaveLength(2);
    expect(q.isPgbossRunning()).toBe(true);
  });

  it("recovery also brings back the discovery and scan consumers this process ran", async () => {
    await loadPgboss();
    prisma.$queryRaw.mockResolvedValue(stalled);
    const disc = vi.fn(async () => undefined);
    const scan = vi.fn(async () => undefined);
    await q.startPgbossWorkers();
    await q.startDiscoveryWorker(disc);
    await q.startScanWorker(scan);
    await vi.advanceTimersByTimeAsync(15_000 * 3);
    expect(h.instances).toHaveLength(2);
    const fresh = boss(1);
    expect(fresh.handlers.has("polaris-discovery-run")).toBe(true);
    await fresh.handlers.get("polaris-discovery-run").fn([{ id: "d", data: { integrationId: "i1", actor: "a" } }]);
    expect(disc).toHaveBeenCalledWith("i1", "a", undefined);
    expect([...fresh.handlers.keys()].some((k: string) => /scan/.test(k))).toBe(true);
  });
});
