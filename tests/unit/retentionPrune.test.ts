/**
 * tests/unit/retentionPrune.test.ts — own unit suite (CQ-T010) for
 * src/services/monitoring/retentionPrune.ts.
 *
 * The only export that does work is `runRetentionPrune`; every per-table prune
 * helper is driven through it. Prisma is the shared stub (each model's
 * deleteMany resolves a count), TimescaleDB's drop_chunks / compress-after are
 * mocked per table, the advisory lock's side connection is a mocked `pg.Client`,
 * and the clock is frozen so every cutoff is exact.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  retention: null as unknown,
  compress: {} as Record<string, number>,
  url: "postgres://direct",
  locked: true,
  clients: [] as Array<{ opts: unknown; queries: Array<[string, unknown]>; ended: boolean; connected: boolean }>,
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

vi.mock("../../src/services/timescaleService.js", () => ({
  dropChunks: vi.fn(async () => undefined),
  getEffectiveCompressAfterDays: vi.fn((t: string) => h.compress[t] ?? 0),
}));

vi.mock("../../src/utils/dbConnections.js", () => ({
  getDirectDatabaseUrl: vi.fn(() => h.url),
}));

vi.mock("../../src/services/sampleRetentionService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/sampleRetentionService.js")>();
  return {
    ...actual,
    getSampleRetention: vi.fn(async () => h.retention),
    getAppMapConnectionRetentionDays: vi.fn(async () => (h.retention as { appMapConnections: { days: number } }).appMapConnections.days),
    getArpEntryRetentionDays: vi.fn(async () => (h.retention as { arpEntries: { days: number } }).arpEntries.days),
  };
});

vi.mock("pg", () => {
  class Client {
    opts: unknown;
    queries: Array<[string, unknown]> = [];
    ended = false;
    connected = false;
    constructor(opts: unknown) {
      this.opts = opts;
      h.clients.push(this);
    }
    async connect() { this.connected = true; }
    async query(sql: string, params: unknown) {
      this.queries.push([sql, params]);
      return { rows: [{ locked: h.locked }] };
    }
    async end() { this.ended = true; }
  }
  return { default: { Client } };
});

import { runRetentionPrune, RETENTION_PRUNE_INTERVAL_MS } from "../../src/services/monitoring/retentionPrune.js";
import { dropChunks } from "../../src/services/timescaleService.js";
import { defaultSampleRetention, FOREVER, type SampleRetention } from "../../src/services/sampleRetentionService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 14, 3, 0, 0);

const MONITOR_MODELS = ["assetMonitorSample", "assetMonitorSampleHourly", "assetMonitorSampleDaily"];
const TELEMETRY_MODELS = [
  "assetTelemetrySample", "assetTelemetrySampleHourly", "assetTelemetrySampleDaily",
  "assetHardwareSensorSample", "assetHardwareSensorSampleHourly", "assetHardwareSensorSampleDaily",
  "assetProcessSample", "assetProcessSampleHourly", "assetProcessSampleDaily",
];
const SYSTEM_INFO_MODELS = [
  "assetInterfaceSample", "assetInterfaceSampleHourly", "assetInterfaceSampleDaily",
  "assetStorageSample", "assetStorageSampleHourly", "assetStorageSampleDaily",
  "assetIpsecTunnelSample", "assetIpsecTunnelSampleHourly", "assetIpsecTunnelSampleDaily",
  "assetPerfSlaSample", "assetPerfSlaSampleHourly", "assetPerfSlaSampleDaily",
  "assetLldpNeighbor", "assetCustomWidgetSample", "assetStateSample",
  "assetProcessLogSample", "assetServiceLogSample", "assetProcessConnection", "assetArpEntry",
  "assetPathCheckSample", "assetPathCheckSampleHourly", "assetPathCheckSampleDaily",
  "assetPathCheckTraceroute",
];
const ALL_MODELS = [...MONITOR_MODELS, ...TELEMETRY_MODELS, ...SYSTEM_INFO_MODELS];

const del = (model: string) => stubbed((prisma as unknown as Record<string, { deleteMany: unknown }>)[model]!.deleteMany);
const whereOf = (model: string, call = 0) => (del(model).mock.calls[call]![0] as { where: Record<string, unknown> }).where;
const findSetting = () => stubbed(prisma.setting.findUnique);
const upsertSetting = () => stubbed(prisma.setting.upsert);
const dropped = () => vi.mocked(dropChunks).mock.calls.map(([t, d]) => [t, (d as Date).getTime()] as const);
const droppedAt = (table: string) => dropped().filter(([t]) => t === table).map(([, ms]) => ms);

function retention(patch: (r: SampleRetention) => void = () => {}): SampleRetention {
  const r = defaultSampleRetention();
  patch(r);
  return r;
}

beforeEach(() => {
  resetDbStub();
  vi.mocked(dropChunks).mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.retention = retention();
  h.compress = {};
  h.url = "postgres://direct";
  h.locked = true;
  h.clients = [];
  for (const m of ALL_MODELS) del(m).mockResolvedValue({ count: 0 });
  findSetting().mockResolvedValue(null);
  upsertSetting().mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runRetentionPrune — due check", () => {
  it("defaults to a 24 h interval", () => {
    expect(RETENTION_PRUNE_INTERVAL_MS).toBe(24 * HOUR);
  });

  it("skips as not-due inside the interval, with one Setting read and no lock or delete", async () => {
    findSetting().mockResolvedValue({ value: { at: NOW - 23 * HOUR } });
    const r = await runRetentionPrune();
    expect(r).toEqual({ monitor: 0, telemetry: 0, systemInfo: 0, skipped: true, reason: "not-due" });
    expect(findSetting()).toHaveBeenCalledTimes(1);
    expect(findSetting().mock.calls[0]![0]).toEqual({ where: { key: "lastRetentionPruneAt" } });
    expect(h.clients).toHaveLength(0);
    for (const m of ALL_MODELS) expect(del(m)).not.toHaveBeenCalled();
  });

  it("is due exactly at the interval", async () => {
    findSetting().mockResolvedValue({ value: { at: NOW - 24 * HOUR } });
    expect((await runRetentionPrune()).skipped).toBe(false);
  });

  it("treats a missing row or a non-numeric stamp as never pruned", async () => {
    expect((await runRetentionPrune()).skipped).toBe(false);
    findSetting().mockResolvedValue({ value: { at: "yesterday" } });
    expect((await runRetentionPrune()).skipped).toBe(false);
  });

  it("honours a caller-supplied interval", async () => {
    findSetting().mockResolvedValue({ value: { at: NOW - 2 * HOUR } });
    expect((await runRetentionPrune(HOUR)).skipped).toBe(false);
    expect((await runRetentionPrune(3 * HOUR)).reason).toBe("not-due");
  });

  it("persists the run's timestamp after a successful prune", async () => {
    await runRetentionPrune();
    expect(upsertSetting()).toHaveBeenCalledWith({
      where: { key: "lastRetentionPruneAt" },
      update: { value: { at: NOW } },
      create: { key: "lastRetentionPruneAt", value: { at: NOW } },
    });
  });
});

describe("runRetentionPrune — advisory lock", () => {
  it("takes and releases the session lock on a dedicated direct connection", async () => {
    const r = await runRetentionPrune();
    expect(r.skipped).toBe(false);
    expect(h.clients).toHaveLength(1);
    const c = h.clients[0]!;
    expect(c.opts).toEqual({ connectionString: "postgres://direct" });
    expect(c.connected).toBe(true);
    expect(c.queries).toEqual([
      ["SELECT pg_try_advisory_lock($1, $2) AS locked", [0x504c5253, 1]],
      ["SELECT pg_advisory_unlock($1, $2)", [0x504c5253, 1]],
    ]);
    expect(c.ended).toBe(true);
  });

  it("skips as lock-held when another replica holds the lock, and still closes the connection", async () => {
    h.locked = false;
    const r = await runRetentionPrune();
    expect(r).toEqual({ monitor: 0, telemetry: 0, systemInfo: 0, skipped: true, reason: "lock-held" });
    const c = h.clients[0]!;
    expect(c.queries).toHaveLength(1);
    expect(c.ended).toBe(true);
    for (const m of ALL_MODELS) expect(del(m)).not.toHaveBeenCalled();
    expect(upsertSetting()).not.toHaveBeenCalled();
  });

  it("re-checks the stamp inside the lock and skips when another replica just pruned", async () => {
    findSetting()
      .mockResolvedValueOnce({ value: { at: NOW - 25 * HOUR } })
      .mockResolvedValueOnce({ value: { at: NOW - 1000 } });
    const r = await runRetentionPrune();
    expect(r.skipped).toBe(true);
    // Reported as "lock-held" — the inner re-check's null shares that path.
    expect(r.reason).toBe("lock-held");
    for (const m of ALL_MODELS) expect(del(m)).not.toHaveBeenCalled();
    expect(h.clients[0]!.ended).toBe(true);
  });

  it("runs uncoordinated when there is no direct database URL", async () => {
    h.url = "";
    const r = await runRetentionPrune();
    expect(r.skipped).toBe(false);
    expect(h.clients).toHaveLength(0);
    expect(upsertSetting()).toHaveBeenCalled();
  });

  it("releases the lock and closes the connection when a prune throws, and does not stamp the run", async () => {
    del("assetMonitorSample").mockRejectedValue(new Error("deadlock"));
    h.retention = retention((r) => { r.assets.detail = 3; });
    h.compress = { asset_monitor_samples: 7 };
    await expect(runRetentionPrune()).rejects.toThrow("deadlock");
    const c = h.clients[0]!;
    expect(c.queries.map(([s]) => s)).toContain("SELECT pg_advisory_unlock($1, $2)");
    expect(c.ended).toBe(true);
    expect(upsertSetting()).not.toHaveBeenCalled();
  });
});

describe("runRetentionPrune — counts", () => {
  it("sums each stream's deleted rows", async () => {
    for (const m of ALL_MODELS) del(m).mockResolvedValue({ count: 1 });
    const r = await runRetentionPrune();
    expect(r.monitor).toBe(3);
    expect(r.telemetry).toBe(9);
    expect(r.skipped).toBe(false);
  });

  // Was a bug until 2026-11-14: pruneSystemInfoSamples destructures its Promise.all into 22 names but
  // the array holds 23 promises (the asset_service_log_samples prune was added
  // without a name), so every name from `processConn` on is shifted one slot
  // and the LAST result — the path-check traceroute prune — is never summed.
  // Input: the traceroute deleteMany deletes 1,000 rows, every other delete
  // 1 row. Wrong: systemInfo = 25 (the 1,000 vanishes from the result and the
  // "Pruned old monitor samples" log). Right: 1,025 (26 deleteMany calls,
  // three selection-aware detail tiers making two each).
  it("counts every system-info delete, the path-check traceroutes included", async () => {
    for (const m of ALL_MODELS) del(m).mockResolvedValue({ count: 1 });
    del("assetPathCheckTraceroute").mockResolvedValue({ count: 1000 });
    const r = await runRetentionPrune();
    expect(r.systemInfo).toBe(1025);
  });

  it("still runs the traceroute prune on the flat pathCheckTraceroutes window", async () => {
    h.retention = retention((r) => { r.pathCheckTraceroutes.days = 10; });
    await runRetentionPrune();
    expect(droppedAt("asset_path_check_traceroutes")).toEqual([NOW - 10 * DAY]);
    expect(whereOf("assetPathCheckTraceroute")).toEqual({ timestamp: { lt: new Date(NOW - 10 * DAY) } });
  });
});

describe("tiered prune (pruneTierByDays)", () => {
  it("never touches a FOREVER tier", async () => {
    h.retention = retention((r) => { r.assets.detail = FOREVER; r.assets.hourly = FOREVER; r.assets.daily = FOREVER; });
    await runRetentionPrune();
    for (const m of MONITOR_MODELS) expect(del(m)).not.toHaveBeenCalled();
    expect(droppedAt("asset_monitor_samples")).toEqual([]);
    expect(droppedAt("asset_monitor_samples_hourly")).toEqual([]);
  });

  it("drops whole chunks at the cutoff and skips the row-DELETE when everything is past the compression frontier", async () => {
    h.compress = { asset_monitor_samples_hourly: 7, asset_monitor_samples_daily: 7 };
    await runRetentionPrune();
    expect(droppedAt("asset_monitor_samples_hourly")).toEqual([NOW - 30 * DAY]);
    expect(droppedAt("asset_monitor_samples_daily")).toEqual([NOW - 365 * DAY]);
    expect(del("assetMonitorSampleHourly")).not.toHaveBeenCalled();
    expect(del("assetMonitorSampleDaily")).not.toHaveBeenCalled();
  });

  it("bounds the residue DELETE to the uncompressed [frontier, cutoff) window for a short tier", async () => {
    h.retention = retention((r) => { r.cpuMem.detail = 3; });
    h.compress = { asset_telemetry_samples: 7 };
    await runRetentionPrune();
    expect(droppedAt("asset_telemetry_samples")).toEqual([NOW - 3 * DAY]);
    expect(whereOf("assetTelemetrySample")).toEqual({ timestamp: { gte: new Date(NOW - 7 * DAY), lt: new Date(NOW - 3 * DAY) } });
  });

  it("deletes unbounded below the cutoff when the table has no compression", async () => {
    await runRetentionPrune();
    expect(whereOf("assetMonitorSample")).toEqual({ timestamp: { lt: new Date(NOW - 7 * DAY) } });
    expect(whereOf("assetMonitorSampleHourly")).toEqual({ bucketStart: { lt: new Date(NOW - 30 * DAY) } });
    expect(whereOf("assetMonitorSampleDaily")).toEqual({ bucketStart: { lt: new Date(NOW - 365 * DAY) } });
  });

  it("prunes a tier set to 0 (off) up to now", async () => {
    h.retention = retention((r) => { r.hardware.hourly = 0; });
    await runRetentionPrune();
    expect(droppedAt("asset_hardware_sensor_samples_hourly")).toEqual([NOW]);
    expect(whereOf("assetHardwareSensorSampleHourly")).toEqual({ bucketStart: { lt: new Date(NOW) } });
  });

  it("reads each entity's own tiers (cpuMem, hardware, process, perfSla, pathCheck)", async () => {
    h.retention = retention((r) => {
      r.cpuMem.detail = 1; r.hardware.detail = 2; r.process.detail = 4; r.perfSla.detail = 5; r.pathCheck.detail = 6;
    });
    await runRetentionPrune();
    expect(droppedAt("asset_telemetry_samples")).toEqual([NOW - 1 * DAY]);
    expect(droppedAt("asset_hardware_sensor_samples")).toEqual([NOW - 2 * DAY]);
    expect(droppedAt("asset_process_samples")).toEqual([NOW - 4 * DAY]);
    expect(droppedAt("asset_perf_sla_samples")).toEqual([NOW - 5 * DAY]);
    expect(droppedAt("asset_path_check_samples")).toEqual([NOW - 6 * DAY]);
  });

  it("prunes the standalone hypertables on their umbrella windows", async () => {
    h.retention = retention((r) => { r.interfaces.detail = 3; r.process.detail = 2; });
    await runRetentionPrune();
    expect(droppedAt("asset_custom_widget_samples")).toEqual([NOW - 3 * DAY]);
    expect(droppedAt("asset_state_samples")).toEqual([NOW - 3 * DAY]);
    expect(droppedAt("asset_process_log_samples")).toEqual([NOW - 2 * DAY]);
    expect(droppedAt("asset_service_log_samples")).toEqual([NOW - 2 * DAY]);
  });
});

describe("selection-aware detail (interfaces / storage / ipsec)", () => {
  it("drops chunks at the selected window and trims slow + legacy-NULL rows to 24 h, bounded at the frontier", async () => {
    h.compress = { asset_storage_samples: 2 };
    await runRetentionPrune();
    expect(droppedAt("asset_storage_samples")).toEqual([NOW - 7 * DAY]);
    const slow = del("assetStorageSample").mock.calls
      .map((c) => (c[0] as { where: Record<string, unknown> }).where)
      .find((w) => "OR" in w);
    expect(slow).toEqual({
      OR: [{ cadence: null }, { cadence: { not: "fast" } }],
      timestamp: { gte: new Date(NOW - 2 * DAY), lt: new Date(NOW - 24 * HOUR) },
    });
  });

  it("leaves the slow trim unbounded below when the frontier is not older than 24 h", async () => {
    h.compress = { asset_ipsec_tunnel_samples: 1 };
    await runRetentionPrune();
    const slow = del("assetIpsecTunnelSample").mock.calls
      .map((c) => (c[0] as { where: Record<string, unknown> }).where)
      .find((w) => "OR" in w);
    expect(slow?.timestamp).toEqual({ lt: new Date(NOW - 24 * HOUR) });
  });

  it("keeps selected rows forever on FOREVER (no drop, no fast delete) but still trims slow rows", async () => {
    h.retention = retention((r) => { r.interfaces.detail = FOREVER; });
    await runRetentionPrune();
    expect(droppedAt("asset_interface_samples")).toEqual([]);
    const wheres = del("assetInterfaceSample").mock.calls.map((c) => (c[0] as { where: Record<string, unknown> }).where);
    expect(wheres).toHaveLength(1);
    expect(wheres[0]).toHaveProperty("OR");
  });

  it("sums the fast and slow deletes", async () => {
    del("assetInterfaceSample").mockResolvedValueOnce({ count: 4 }).mockResolvedValueOnce({ count: 6 });
    const r = await runRetentionPrune();
    expect(r.systemInfo).toBeGreaterThanOrEqual(10);
  });

  it("deletes fast rows older than the selected window (uncompressed table)", async () => {
    await runRetentionPrune();
    const fast = del("assetInterfaceSample").mock.calls
      .map((c) => (c[0] as { where: Record<string, unknown> }).where)
      .find((w) => w.cadence === "fast");
    expect(fast).toEqual({ cadence: "fast", timestamp: { lt: new Date(NOW - 7 * DAY) } });
  });

  // Was a bug until 2026-11-14: business rule / tiered-sample-retention invariant "NO tier prune —
  // detail OR rollup — may row-DELETE inside a compressed chunk". The SLOW arm
  // of pruneSelectionAwareDetail is bounded at the frontier, but the FAST
  // (selected) arm is a blanket `{ cadence: "fast", timestamp: { lt: sel } }`.
  // Input: interfaces detail = 7 days, compress-after = 2 days (the floor for
  // selection-aware tables). drop_chunks removes the chunks wholly older than
  // 7 days; the 1-day chunk straddling the 7-day cutoff is compressed, and the
  // fast deleteMany matches its rows below the cutoff → TimescaleDB
  // decompresses the chunk (the 2026-06-08 / 06-17 mechanism). Wrong: a fast
  // delete with `lt: now-7d` and no lower bound. Right: route the fast arm
  // through tieredPruneWindow — skip the row-DELETE when the cutoff is past
  // the frontier (leave the residue to drop_chunks), or bound it at the frontier.
  it("never row-deletes selected rows past the compression frontier", async () => {
    h.compress = { asset_interface_samples: 2 };
    await runRetentionPrune();
    const frontier = NOW - 2 * DAY;
    const fast = del("assetInterfaceSample").mock.calls
      .map((c) => (c[0] as { where: { cadence?: unknown; timestamp: { gte?: Date; lt: Date } } }).where)
      .filter((w) => w.cadence === "fast");
    for (const w of fast) {
      expect(w.timestamp.gte).toBeDefined();
      expect(w.timestamp.gte!.getTime()).toBeGreaterThanOrEqual(frontier);
    }
  });

  it("prunes every selected row up to now when detail is 0 (off)", async () => {
    h.retention = retention((r) => { r.storage.detail = 0; });
    await runRetentionPrune();
    expect(droppedAt("asset_storage_samples")).toEqual([NOW]);
    const fast = del("assetStorageSample").mock.calls
      .map((c) => (c[0] as { where: Record<string, unknown> }).where)
      .find((w) => w.cadence === "fast");
    expect(fast).toEqual({ cadence: "fast", timestamp: { lt: new Date(NOW) } });
  });
});

describe("current-state tables (LLDP, ARP, Application Map connections)", () => {
  it("prunes LLDP neighbours on lastSeen by the interfaces detail window", async () => {
    h.retention = retention((r) => { r.interfaces.detail = 5; });
    await runRetentionPrune();
    expect(whereOf("assetLldpNeighbor")).toEqual({ lastSeen: { lt: new Date(NOW - 5 * DAY) } });
  });

  it("prunes ARP and connection rows on lastSeen by their flat windows", async () => {
    h.retention = retention((r) => { r.arpEntries.days = 9; r.appMapConnections.days = 11; });
    await runRetentionPrune();
    expect(whereOf("assetArpEntry")).toEqual({ lastSeen: { lt: new Date(NOW - 9 * DAY) } });
    expect(whereOf("assetProcessConnection")).toEqual({ lastSeen: { lt: new Date(NOW - 11 * DAY) } });
  });

  it("skips each on FOREVER", async () => {
    h.retention = retention((r) => { r.interfaces.detail = FOREVER; r.arpEntries.days = FOREVER; r.appMapConnections.days = FOREVER; });
    await runRetentionPrune();
    expect(del("assetLldpNeighbor")).not.toHaveBeenCalled();
    expect(del("assetArpEntry")).not.toHaveBeenCalled();
    expect(del("assetProcessConnection")).not.toHaveBeenCalled();
  });

  it("prunes everything up to now on 0", async () => {
    h.retention = retention((r) => { r.interfaces.detail = 0; r.arpEntries.days = 0; r.appMapConnections.days = 0; });
    await runRetentionPrune();
    expect(whereOf("assetLldpNeighbor")).toEqual({ lastSeen: { lt: new Date(NOW) } });
    expect(whereOf("assetArpEntry")).toEqual({ lastSeen: { lt: new Date(NOW) } });
    expect(whereOf("assetProcessConnection")).toEqual({ lastSeen: { lt: new Date(NOW) } });
  });

  it("never calls drop_chunks for the plain current-state tables", async () => {
    await runRetentionPrune();
    const tables = new Set(dropped().map(([t]) => t));
    expect(tables.has("asset_lldp_neighbors")).toBe(false);
    expect(tables.has("asset_arp_entries")).toBe(false);
    expect(tables.has("asset_process_connections")).toBe(false);
  });
});

describe("hypertable coverage", () => {
  it("calls drop_chunks once for each tiered and standalone hypertable at default retention", async () => {
    await runRetentionPrune();
    const tables = dropped().map(([t]) => t).sort();
    expect(tables).toEqual([
      "asset_custom_widget_samples",
      "asset_hardware_sensor_samples", "asset_hardware_sensor_samples_daily", "asset_hardware_sensor_samples_hourly",
      "asset_interface_samples", "asset_interface_samples_daily", "asset_interface_samples_hourly",
      "asset_ipsec_tunnel_samples", "asset_ipsec_tunnel_samples_daily", "asset_ipsec_tunnel_samples_hourly",
      "asset_monitor_samples", "asset_monitor_samples_daily", "asset_monitor_samples_hourly",
      "asset_path_check_samples", "asset_path_check_samples_daily", "asset_path_check_samples_hourly",
      "asset_path_check_traceroutes",
      "asset_perf_sla_samples", "asset_perf_sla_samples_daily", "asset_perf_sla_samples_hourly",
      "asset_process_log_samples",
      "asset_process_samples", "asset_process_samples_daily", "asset_process_samples_hourly",
      "asset_service_log_samples",
      "asset_state_samples",
      "asset_storage_samples", "asset_storage_samples_daily", "asset_storage_samples_hourly",
      "asset_telemetry_samples", "asset_telemetry_samples_daily", "asset_telemetry_samples_hourly",
    ]);
  });
});
