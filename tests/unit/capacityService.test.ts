/**
 * tests/unit/capacityService.test.ts — the capacity snapshot itself (CQ-T010).
 *
 * Complements, does not repeat:
 *   - capacitySteadyState.test.ts — the pure projection helpers
 *     (projectSteadyStateSize, effectiveRetentionDays, measuredRateUsable,
 *     prunesExpiredRows, footprintDaysAt, peakCombinedBytes, isStaleVacuumTable)
 *   - capacityTransition.test.ts — recordCapacityTransition + the hold (rule 105)
 *   - rootHelpersHeld.test.ts — parsePendingRootHelpers (rule 117(g))
 *   - securityPhase8.test.ts — databaseUsesPublicDefaultPassword
 *   - timescaleTables.test.ts — SAMPLE_TABLES covers every managed hypertable
 *
 * What was unreached: getCapacitySnapshot and getCapacitySnapshotWithAdvisor —
 * the volume scan (dedupe by stat.dev, lowest-free first, the ancestor marker),
 * the workload counts read for the projection, the connection-pool figures,
 * and every reason computeReasons can raise with the family collapse that
 * keeps one row per concern, plus the "Safe" side-reasons that must never
 * take the snapshot down with them. Everything external is a mock; the
 * clock is fixed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  statfs: vi.fn(),
  pickFirst: vi.fn(),
  dbIsLocal: vi.fn(),
  ctx: vi.fn(),
  detectFping: vi.fn(),
  healthToken: vi.fn(),
  metricsToken: vi.fn(),
  isTimescaleAvailable: vi.fn(),
  isHypertable: vi.fn(),
  getTableSizes: vi.fn(),
  getDatabaseSizeBreakdown: vi.fn(),
  isPgbossInstalled: vi.fn(),
  getBootTimeMode: vi.fn(),
  getQueueMode: vi.fn(),
  totalmem: vi.fn(),
  freemem: vi.fn(),
  getPlatformLifecycle: vi.fn(),
  lifecycleCapacityReasons: vi.fn(),
  listRolesNeedingGrantReview: vi.fn(),
  countUnusableStoredPatterns: vi.fn(),
  changedCertPins: vi.fn(),
  getHaConfig: vi.fn(),
  refreshPatroniScheme: vi.fn(),
  recomputeAdvisorFromSnapshot: vi.fn(),
  summarizeAdvisorGaps: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

vi.mock("node:os", async (orig) => {
  const real = await orig<typeof import("node:os")>();
  return { ...real, default: { ...real, totalmem: h.totalmem, freemem: h.freemem }, totalmem: h.totalmem, freemem: h.freemem };
});
vi.mock("../../src/utils/startupDiskCheck.js", async (orig) => ({
  ...(await orig<object>()),
  statfsWithAncestorFallback: h.statfs,
  pickFirstExistingPath: h.pickFirst,
}));
vi.mock("../../src/utils/deploymentContext.js", async (orig) => ({
  ...(await orig<object>()),
  dbIsLocal: h.dbIsLocal,
  getDeploymentContext: h.ctx,
}));
vi.mock("../../src/utils/burstPing.js", async (orig) => ({ ...(await orig<object>()), detectFping: h.detectFping }));
vi.mock("../../src/utils/endpointTokens.js", async (orig) => ({
  ...(await orig<object>()),
  healthToken: h.healthToken,
  metricsToken: h.metricsToken,
}));
vi.mock("../../src/services/timescaleService.js", async (orig) => ({
  ...(await orig<object>()),
  isTimescaleAvailable: h.isTimescaleAvailable,
  isHypertable: h.isHypertable,
}));
vi.mock("../../src/services/dbSizeService.js", async (orig) => ({
  ...(await orig<object>()),
  getTableSizes: h.getTableSizes,
  getDatabaseSizeBreakdown: h.getDatabaseSizeBreakdown,
}));
vi.mock("../../src/services/queueService.js", async (orig) => ({
  ...(await orig<object>()),
  isPgbossInstalled: h.isPgbossInstalled,
  getBootTimeMode: h.getBootTimeMode,
  getQueueMode: h.getQueueMode,
}));
vi.mock("../../src/services/platformLifecycleService.js", async (orig) => ({
  ...(await orig<object>()),
  getPlatformLifecycle: h.getPlatformLifecycle,
  lifecycleCapacityReasons: h.lifecycleCapacityReasons,
}));
vi.mock("../../src/services/roleService.js", async (orig) => ({
  ...(await orig<object>()),
  listRolesNeedingGrantReview: h.listRolesNeedingGrantReview,
}));
vi.mock("../../src/services/storedRegexAuditService.js", async (orig) => ({
  ...(await orig<object>()),
  countUnusableStoredPatterns: h.countUnusableStoredPatterns,
}));
vi.mock("../../src/services/tlsCertPinService.js", async (orig) => ({
  ...(await orig<object>()),
  changedCertPins: h.changedCertPins,
}));
vi.mock("../../src/services/haService.js", async (orig) => ({
  ...(await orig<object>()),
  getHaConfig: h.getHaConfig,
  refreshPatroniScheme: h.refreshPatroniScheme,
}));
vi.mock("../../src/services/capacityAdvisorService.js", async (orig) => ({
  ...(await orig<object>()),
  recomputeAdvisorFromSnapshot: h.recomputeAdvisorFromSnapshot,
  summarizeAdvisorGaps: h.summarizeAdvisorGaps,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { resetEventLogStub } from "./_eventLogStub.js";
import { getCapacitySnapshot, getCapacitySnapshotWithAdvisor } from "../../src/services/capacityService.js";
import { invalidateSampleRetentionCache } from "../../src/services/sampleRetentionService.js";
import { BACKUP_DIR } from "../../src/utils/paths.js";

const GB = 1024 ** 3;
const NOW = new Date("2026-06-15T12:00:00Z");
const DATA_DIR = "/var/lib/pgsql/data";

/** Per-path statfs answers; anything unnamed (the app dir) shares dev 1. */
let volumes: Record<string, { dev: number; free: number; total: number; degraded?: string }>;
let raw: {
  telemetry: number; systemInfo: number;
  pins: { interfaces: number; ipsec: number; storage: number };
  conn: { in_use: number; max: number };
  showDataDir: string | Error;
};
let sampleTables: Array<{ name: string; rows: number; deadRows: number; bytes: number; lastAutovacuum: Date | null }>;
let dbTotalBytes: number;
let monitoredCount: number;

const ENV_KEYS = ["NODE_ENV", "DATABASE_URL", "POLARIS_SECRET_KEY", "DATABASE_POOL_SIZE", "POLARIS_PGBOSS_POOL_SIZE"] as const;
const savedEnv: Record<string, string | undefined> = {};

function codes(reasons: Array<{ code: string }>): string[] {
  return reasons.map((r) => r.code);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetDbStub();
  resetEventLogStub();
  invalidateSampleRetentionCache();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.NODE_ENV = "test";
  process.env.POLARIS_SECRET_KEY = "k".repeat(64);
  delete process.env.DATABASE_POOL_SIZE;
  delete process.env.POLARIS_PGBOSS_POOL_SIZE;

  volumes = {};
  raw = {
    telemetry: 0, systemInfo: 0,
    pins: { interfaces: 0, ipsec: 0, storage: 0 },
    conn: { in_use: 3, max: 100 },
    showDataDir: DATA_DIR,
  };
  sampleTables = [];
  dbTotalBytes = 100 * 1024 * 1024;
  monitoredCount = 0;

  h.statfs.mockImplementation(async (path: string) => {
    const v = volumes[path] ?? { dev: 1, free: 80, total: 100 };
    return {
      dev: v.dev, freeBytes: v.free, totalBytes: v.total,
      measuredPath: v.degraded ?? path, degraded: !!v.degraded,
    };
  });
  h.pickFirst.mockResolvedValue("/fallback/pgdata");
  h.dbIsLocal.mockReturnValue(true);
  h.ctx.mockReturnValue({ dbIsLocal: true, runtimeIsContainer: false });
  h.detectFping.mockResolvedValue(true);
  h.healthToken.mockReturnValue("h");
  h.metricsToken.mockReturnValue("m");
  h.isTimescaleAvailable.mockReturnValue(true);
  h.isHypertable.mockReturnValue(false);
  h.getTableSizes.mockImplementation(async () => ({ tables: sampleTables }));
  h.getDatabaseSizeBreakdown.mockImplementation(async () => ({
    totalBytes: dbTotalBytes, polarisBytes: dbTotalBytes, pgbossBytes: 0, catalogBytes: 0, otherBytes: 0,
    neverAnalyzedRelations: [],
  }));
  h.isPgbossInstalled.mockReturnValue(true);
  h.getBootTimeMode.mockReturnValue("pgboss");
  h.getQueueMode.mockResolvedValue("pgboss");
  h.totalmem.mockReturnValue(1024 * GB);
  h.freemem.mockReturnValue(512 * GB);
  h.getPlatformLifecycle.mockResolvedValue({});
  h.lifecycleCapacityReasons.mockReturnValue([]);
  h.listRolesNeedingGrantReview.mockResolvedValue([]);
  h.countUnusableStoredPatterns.mockResolvedValue(0);
  h.changedCertPins.mockResolvedValue([]);
  h.getHaConfig.mockResolvedValue({ enabled: false });
  h.refreshPatroniScheme.mockResolvedValue(false);

  stubbed(prisma.$queryRawUnsafe).mockImplementation(async (sql: string) => {
    if (sql.includes("SHOW data_directory")) {
      if (raw.showDataDir instanceof Error) throw raw.showDataDir;
      return [{ data_directory: raw.showDataDir }];
    }
    if (sql.includes('"cpuMemoryPolling"')) return [{ count: BigInt(raw.telemetry) }];
    if (sql.includes('"interfacesPolling"')) return [{ count: BigInt(raw.systemInfo) }];
    if (sql.includes('"monitoredInterfaces"')) {
      return [{ interfaces: BigInt(raw.pins.interfaces), ipsec: BigInt(raw.pins.ipsec), storage: BigInt(raw.pins.storage) }];
    }
    if (sql.includes("pg_stat_activity")) return [raw.conn];
    if (sql.includes("pg_stat_database")) return [];
    return [];
  });
  stubbed(prisma.asset.count).mockImplementation(async () => monitoredCount);
  // fleetCadences reads the monitored fleet's configurations; none → the floor cadences.
  stubbed(prisma.asset.findMany).mockResolvedValue([]);
  stubbed(prisma.managedAgent.count).mockResolvedValue(0);
  stubbed(prisma.setting.findUnique).mockImplementation(async ({ where }: { where: { key: string } }) => {
    if (where.key === "sampleRollup.hourly.lastSuccess") return { key: where.key, value: { at: new Date(NOW.getTime() - 3600_000).toISOString() } };
    if (where.key === "sampleRollup.daily.lastSuccess") return { key: where.key, value: { at: new Date(NOW.getTime() - 20 * 3600_000).toISOString() } };
    return null;
  });
  stubbed(prisma.integration.findMany).mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("getCapacitySnapshot — a healthy install", () => {
  it("grades ok with no reasons when nothing is wrong", async () => {
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.reasons).toEqual([]);
    expect(snap.severity).toBe("ok");
    expect(snap.computedAt).toBe(NOW.toISOString());
  });

  it("reports the workload it read: monitored, pinned interfaces (+ IPsec) and storage, agents", async () => {
    monitoredCount = 7;
    raw.telemetry = 5;
    raw.systemInfo = 6;
    raw.pins = { interfaces: 10, ipsec: 2, storage: 4 };
    stubbed(prisma.managedAgent.count).mockResolvedValue(3);
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.workload.monitoredAssetCount).toBe(7);
    // IPsec tunnels fold into the interface count — they are interfaces to the operator.
    expect(snap.workload.monitoredInterfaceCount).toBe(12);
    expect(snap.workload.monitoredStorageCount).toBe(4);
    expect(snap.workload.agentCount).toBe(3);
    // Only MONITORED assets are counted.
    expect(prisma.asset.count).toHaveBeenCalledWith({ where: { monitored: true } });
  });

  it("names the rollup tiers' last success from their Settings, null when never stamped", async () => {
    let snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.database.rollupLastSuccess.hourly).toBe(new Date(NOW.getTime() - 3600_000).toISOString());
    stubbed(prisma.setting.findUnique).mockResolvedValue(null);
    snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.database.rollupLastSuccess).toEqual({ hourly: null, daily: null });
  });

  it("reports the pool sizes: env when set, 25 / 20 defaults, no pg-boss pool outside pg-boss mode", async () => {
    let snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.database.connectionPool).toMatchObject({ prismaPoolSize: 25, pgbossPoolSize: 20, maxConnections: 100 });

    process.env.DATABASE_POOL_SIZE = "40";
    process.env.POLARIS_PGBOSS_POOL_SIZE = "nonsense";
    snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.database.connectionPool).toMatchObject({ prismaPoolSize: 40, pgbossPoolSize: 20 });

    h.getBootTimeMode.mockReturnValue("legacy");
    snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.database.connectionPool.pgbossPoolSize).toBeNull();
    expect(snap.database.queue.active).toBe("legacy");
  });

  it("keeps the highest connection count it has seen as the peak", async () => {
    raw.conn = { in_use: 900, max: 1000 };
    await getCapacitySnapshot({ pgTuningNeeded: false });
    raw.conn = { in_use: 2, max: 1000 };
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.database.connectionPool.currentInUse).toBe(2);
    expect(snap.database.connectionPool.peakObserved).toBeGreaterThanOrEqual(900);
  });

  it("an unreadable pg_stat_activity reads as zero rather than failing the snapshot", async () => {
    const impl = stubbed(prisma.$queryRawUnsafe).getMockImplementation()!;
    stubbed(prisma.$queryRawUnsafe).mockImplementation(async (sql: string, ...a: unknown[]) => {
      if (sql.includes("pg_stat_activity")) throw new Error("permission denied");
      return impl(sql, ...a);
    });
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.database.connectionPool).toMatchObject({ currentInUse: 0, maxConnections: 0 });
  });

  it("projects the current size unchanged when nothing is monitored", async () => {
    dbTotalBytes = 123_456_789;
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.workload.steadyStateSizeBytes).toBe(123_456_789);
  });

  it("returns one row per sample table even before any of them has a row", async () => {
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.database.sampleTables.length).toBeGreaterThan(10);
    const monitor = snap.database.sampleTables.find((t) => t.name === "asset_monitor_samples")!;
    expect(monitor).toMatchObject({ rows: 0, bytes: 0, deadTupRatio: 0, lastAutovacuum: null });
    expect(monitor.avgBytesPerRow).toBeGreaterThan(0); // the calibrated default, not 0/0
  });

  it("divides bytes by live + dead rows, so a bloated table does not read as megabytes per row", async () => {
    sampleTables = [{ name: "asset_monitor_samples", rows: 8, deadRows: 79_992, bytes: 160_000_000, lastAutovacuum: new Date(NOW) }];
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    const t = snap.database.sampleTables.find((x) => x.name === "asset_monitor_samples")!;
    expect(t.avgBytesPerRow).toBe(2000);
    expect(t.deadTupRatio).toBeCloseTo(0.9999, 4);
    expect(t.lastAutovacuum).toBe(NOW.toISOString());
  });
});

describe("getCapacitySnapshot — volumes", () => {
  it("collapses paths on one filesystem into one volume carrying every role", async () => {
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.appHost.volumes).toHaveLength(1);
    expect(snap.appHost.volumes[0].roles.sort()).toEqual(["app", "backups", "db", "state"]);
    expect(snap.database.dataDirectory).toBe(DATA_DIR);
  });

  it("lists separate filesystems lowest-free first", async () => {
    volumes[DATA_DIR] = { dev: 2, free: 40, total: 100 };
    volumes[BACKUP_DIR] = { dev: 3, free: 90, total: 100 };
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.appHost.volumes.map((v) => v.roles)).toEqual([["db"], expect.arrayContaining(["app", "state"]), ["backups"]]);
  });

  it("marks a volume measured through an ancestor, naming both paths", async () => {
    volumes[DATA_DIR] = { dev: 2, free: 50, total: 100, degraded: "/var/lib/pgsql" };
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    const db = snap.appHost.volumes.find((v) => v.roles.includes("db"))!;
    expect(db.measuredVia).toEqual({ requestedPath: DATA_DIR, measuredPath: "/var/lib/pgsql" });
  });

  it("a remote database has no data directory and no DB volume, and SHOW is never asked", async () => {
    h.dbIsLocal.mockReturnValue(false);
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.database.dataDirectory).toBeNull();
    expect(snap.appHost.volumes.some((v) => v.roles.includes("db"))).toBe(false);
    expect(snap.appHost.dbColocated).toBe(false);
    const asked = stubbed(prisma.$queryRawUnsafe).mock.calls.some((c) => String(c[0]).includes("SHOW data_directory"));
    expect(asked).toBe(false);
  });

  it("falls back to the conventional PGDATA paths when SHOW data_directory is refused", async () => {
    raw.showDataDir = new Error("must be superuser or have pg_read_all_settings");
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.database.dataDirectory).toBe("/fallback/pgdata");
    expect(h.pickFirst).toHaveBeenCalled();
  });

  it("drops a path nothing up its chain can measure", async () => {
    h.statfs.mockImplementation(async (path: string) =>
      path === BACKUP_DIR ? null : { dev: 1, freeBytes: 80, totalBytes: 100, measuredPath: path, degraded: false });
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.appHost.volumes[0].roles).not.toContain("backups");
  });
});

describe("getCapacitySnapshot — disk reasons", () => {
  it.each([
    [5, "disk_critical", "critical"],
    [15, "disk_low", "warning"],
    [25, "disk_watch", "watch"],
  ] as const)("%i%% free on a volume raises %s", async (freePct, code, severity) => {
    volumes[BACKUP_DIR] = { dev: 3, free: freePct, total: 100 };
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.reasons).toEqual([expect.objectContaining({ code, severity, family: "disk:backups" })]);
    expect(snap.reasons[0].message).toContain("Backups volume");
    expect(snap.severity).toBe(severity);
  });

  it("30% free and above raises nothing", async () => {
    volumes[BACKUP_DIR] = { dev: 3, free: 30, total: 100 };
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.reasons).toEqual([]);
  });

  it("a critically full DB volume tells the operator PostgreSQL will refuse writes", async () => {
    volumes[DATA_DIR] = { dev: 2, free: 5, total: 100 };
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.reasons[0]).toMatchObject({ code: "disk_critical", family: "disk:db" });
    expect(snap.reasons[0].suggestion).toContain("PostgreSQL refuses new writes");
  });

  it("a zero-sized volume is skipped rather than divided by", async () => {
    volumes[BACKUP_DIR] = { dev: 3, free: 0, total: 0 };
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.reasons).toEqual([]);
  });

  it("growth past the DB volume's free space is critical and absorbs the volume's own disk reason", async () => {
    monitoredCount = 2000;
    raw.telemetry = 2000;
    raw.systemInfo = 2000;
    // 25% free (disk_watch) but far too little for the projected growth.
    volumes[DATA_DIR] = { dev: 2, free: 25 * 1024 * 1024, total: 100 * 1024 * 1024 };
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    const db = snap.reasons.filter((r) => r.family === "disk:db");
    expect(db).toHaveLength(1);
    expect(db[0]).toMatchObject({ code: "projected_exceeds_disk", severity: "critical" });
    // The absorbed watch row's advice is kept, appended once.
    expect(db[0].suggestion).toContain("Also: Watch the trend");
    expect(snap.severity).toBe("critical");
  });

  it("growth that would use more than 75% (but not all) of the free space is a warning", async () => {
    monitoredCount = 2000;
    raw.telemetry = 2000;
    raw.systemInfo = 2000;
    const first = await getCapacitySnapshot({ pgTuningNeeded: false });
    const growth = first.workload.steadyStateSizeBytes - dbTotalBytes;
    expect(growth).toBeGreaterThan(0);
    // free = growth / 0.9 → growth is 90% of free; total keeps the volume itself healthy.
    const free = Math.ceil(growth / 0.9);
    volumes[DATA_DIR] = { dev: 2, free, total: free * 2 };
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(codes(snap.reasons)).toContain("projected_approaches_disk");
    expect(codes(snap.reasons)).not.toContain("projected_exceeds_disk");
  });
});

describe("getCapacitySnapshot — database reasons", () => {
  it("a database past 8x RAM is critical and absorbs the 4x warning family", async () => {
    h.totalmem.mockReturnValue(1 * GB);
    dbTotalBytes = 9 * GB;
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    const ram = snap.reasons.filter((r) => r.family === "db_ram");
    expect(ram).toEqual([expect.objectContaining({ code: "projected_db_huge", severity: "critical" })]);
  });

  it("between 4x and 8x RAM is a warning", async () => {
    h.totalmem.mockReturnValue(1 * GB);
    dbTotalBytes = 5 * GB;
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.reasons.find((r) => r.family === "db_ram")).toMatchObject({ code: "projected_db_large", severity: "warning" });
  });

  it("a database larger than RAM with track_io_timing off asks for the setting instead of guessing", async () => {
    h.totalmem.mockReturnValue(1 * GB);
    dbTotalBytes = 2 * GB;
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.reasons.find((r) => r.code === "track_io_timing_off")).toMatchObject({ severity: "watch", family: "pg_io_timing" });
    expect(snap.database.io.measured).toBe(false);
  });

  it("a bloated, long-unvacuumed plain sample table is critical and swallows the lag warning", async () => {
    h.isHypertable.mockReturnValue(false);
    sampleTables = [{
      name: "asset_monitor_samples_hourly", rows: 5000, deadRows: 5000, bytes: 1000,
      lastAutovacuum: new Date(NOW.getTime() - 8 * 86400_000),
    }];
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    const av = snap.reasons.filter((r) => r.family === "autovacuum");
    expect(av).toHaveLength(1);
    expect(av[0]).toMatchObject({ code: "autovacuum_stale", severity: "critical" });
    expect(av[0].message).toContain("asset_monitor_samples_hourly");
    expect(av[0].suggestion).toContain("Also: Lower autovacuum_vacuum_scale_factor");
  });

  it("several lagging tables share one warning that names each with its dead-tuple share", async () => {
    sampleTables = [
      { name: "asset_monitor_samples", rows: 2000, deadRows: 1000, bytes: 1, lastAutovacuum: new Date(NOW) },
      { name: "asset_telemetry_samples", rows: 3000, deadRows: 3000, bytes: 1, lastAutovacuum: new Date(NOW) },
      { name: "asset_storage_samples", rows: 500, deadRows: 500, bytes: 1, lastAutovacuum: new Date(NOW) },
    ];
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    const lag = snap.reasons.find((r) => r.code === "autovacuum_lag")!;
    expect(lag.severity).toBe("warning");
    expect(lag.message).toContain("2 sample tables");
    expect(lag.message).toContain("asset_monitor_samples 33%");
    expect(lag.message).toContain("asset_telemetry_samples 50%");
    expect(lag.message).not.toContain("asset_storage_samples"); // 500 rows is not populated
  });

  it("pgTuningNeeded raises the tuning warning", async () => {
    const snap = await getCapacitySnapshot({ pgTuningNeeded: true });
    expect(snap.reasons).toEqual([expect.objectContaining({ code: "pg_tuning_needed", severity: "warning" })]);
    expect(snap.severity).toBe("warning");
  });
});

describe("getCapacitySnapshot — TimescaleDB missing (rule 52)", () => {
  beforeEach(() => {
    h.isTimescaleAvailable.mockReturnValue(false);
  });

  it("says so at watch while the sample tables are small, with the bare-metal install hint", async () => {
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    const r = snap.reasons.find((x) => x.code === "timescale_recommended")!;
    expect(r.severity).toBe("watch");
    expect(r.suggestion).toContain("docs/INSTALL.md");
    expect(snap.database.timescale.extensionInstalled).toBe(false);
  });

  it("raises it to a warning past 1 GB of sample tables", async () => {
    sampleTables = [{ name: "asset_monitor_samples", rows: 0, deadRows: 0, bytes: 2 * GB, lastAutovacuum: null }];
    // rows 0 keeps the rollup-lag reason out of the way.
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.reasons.find((x) => x.code === "timescale_recommended")).toMatchObject({ severity: "warning" });
  });

  it("tailors the hint: a remote DB goes to the DBA, a container to the timescale image", async () => {
    h.ctx.mockReturnValue({ dbIsLocal: false, runtimeIsContainer: false });
    let snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.reasons.find((x) => x.code === "timescale_recommended")!.suggestion).toContain("database administrator");
    h.ctx.mockReturnValue({ dbIsLocal: true, runtimeIsContainer: true });
    snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.reasons.find((x) => x.code === "timescale_recommended")!.suggestion).toContain("timescale/timescaledb");
  });
});

describe("getCapacitySnapshot — rollup lag", () => {
  const withRows = () => {
    sampleTables = [{ name: "asset_monitor_samples", rows: 10, deadRows: 0, bytes: 10, lastAutovacuum: null }];
  };

  it("an install with no sample rows never reports a missing rollup", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValue(null);
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(codes(snap.reasons)).not.toContain("sample_rollup_lagging");
  });

  it("with rows and no stamp at all, both tiers are named as never run", async () => {
    withRows();
    stubbed(prisma.setting.findUnique).mockResolvedValue(null);
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    const r = snap.reasons.find((x) => x.code === "sample_rollup_lagging")!;
    expect(r.severity).toBe("watch");
    expect(r.message).toContain("hourly tier has never produced a successful run");
    expect(r.message).toContain("daily tier has never produced a successful run");
  });

  it("hourly is stale past 6 h and daily past 36 h, each reported by its age", async () => {
    withRows();
    stubbed(prisma.setting.findUnique).mockImplementation(async ({ where }: { where: { key: string } }) => {
      if (where.key.includes("hourly")) return { value: { at: new Date(NOW.getTime() - 7 * 3600_000).toISOString() } };
      return { value: { at: new Date(NOW.getTime() - 35 * 3600_000).toISOString() } };
    });
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    const r = snap.reasons.find((x) => x.code === "sample_rollup_lagging")!;
    expect(r.message).toContain("last hourly run 7h ago");
    expect(r.message).not.toContain("daily");
  });

  it("fresh stamps on both tiers raise nothing", async () => {
    withRows();
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(codes(snap.reasons)).not.toContain("sample_rollup_lagging");
  });
});

describe("getCapacitySnapshot — install hygiene reasons", () => {
  it("names each unauthenticated endpoint separately", async () => {
    h.metricsToken.mockReturnValue(null);
    h.healthToken.mockReturnValue(null);
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(codes(snap.reasons)).toEqual(["metrics_token_unset", "health_token_unset"]);
    expect(snap.severity).toBe("watch");
  });

  it("an unset or blank POLARIS_SECRET_KEY is a watch reason, never more", async () => {
    process.env.POLARIS_SECRET_KEY = "   ";
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.reasons).toEqual([expect.objectContaining({ code: "secrets_key_unset", severity: "watch" })]);
  });

  it("the old default DB password is flagged in production only (rule 117)", async () => {
    process.env.DATABASE_URL = "postgresql://polaris:polaris@localhost:5432/polaris";
    let snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(codes(snap.reasons)).not.toContain("db_default_password");
    process.env.NODE_ENV = "production";
    snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.reasons.find((r) => r.code === "db_default_password")).toMatchObject({ severity: "warning" });
  });

  it("fping's absence is only worth a line from 500 monitored assets up, and only at watch", async () => {
    h.detectFping.mockResolvedValue(false);
    monitoredCount = 499;
    let snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(codes(snap.reasons)).not.toContain("fping_absent");
    expect(snap.appHost.hasFping).toBe(false);
    monitoredCount = 500;
    // A huge RAM and volume keep the projection's own reasons out of the way.
    snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    const r = snap.reasons.find((x) => x.code === "fping_absent")!;
    expect(r.severity).toBe("watch");
    expect(r.message).toContain("across 500 monitored assets");
  });
});

describe("getCapacitySnapshot — advisor-driven reasons", () => {
  it("raises the pool, worker and handler-pressure watch rows from the gaps", async () => {
    const snap = await getCapacitySnapshot({
      pgTuningNeeded: false,
      advisor: {
        poolUndersized: true,
        workersUndersized: true,
        maxConnectionsUndersized: false,
        worstGap: "fast: 4 → 8",
        handlerTimeoutPressure: [{ cadence: "fast", p90Sec: 45.25, expireSec: 60, utilization: 0.754 } as never],
      },
    });
    expect(codes(snap.reasons)).toEqual(["pool_undersized", "monitor_workers_undersized", "monitor_handler_timeout_pressure"]);
    expect(snap.reasons[0].message).toContain("of 45 Polaris capacity"); // 25 + 20
    expect(snap.reasons[1].message).toContain("(worst gap: fast: 4 → 8)");
    expect(snap.reasons[2].message).toContain("fast p90=45.3s vs cap 60s (75%)");
    expect(snap.severity).toBe("watch");
  });

  it("max_connections needs a recommended value and a readable current one", async () => {
    const gaps = { poolUndersized: false, workersUndersized: false, maxConnectionsUndersized: true };
    let snap = await getCapacitySnapshot({ pgTuningNeeded: false, advisor: gaps });
    expect(codes(snap.reasons)).not.toContain("max_connections_undersized");

    snap = await getCapacitySnapshot({ pgTuningNeeded: false, advisor: { ...gaps, recommendedMaxConnections: 300 } });
    expect(snap.reasons.find((r) => r.code === "max_connections_undersized")).toMatchObject({ severity: "warning" });
    expect(snap.reasons[0].message).toContain("current 100, recommended 300");

    raw.conn = { in_use: 0, max: 0 };
    snap = await getCapacitySnapshot({ pgTuningNeeded: false, advisor: { ...gaps, recommendedMaxConnections: 300 } });
    expect(codes(snap.reasons)).not.toContain("max_connections_undersized");
  });
});

describe("getCapacitySnapshot — side reasons never fail the snapshot", () => {
  it("appends lifecycle, grant-review, regex, TLS-pin, WinRM and Patroni reasons", async () => {
    h.lifecycleCapacityReasons.mockReturnValue([{ severity: "warning", code: "platform_eol", family: "lifecycle", message: "m", suggestion: "s" }]);
    h.listRolesNeedingGrantReview.mockResolvedValue(["a", "b", "c", "d", "e", "f"]);
    h.countUnusableStoredPatterns.mockResolvedValue(2);
    h.changedCertPins.mockResolvedValue([{ host: "fg1", port: 443 }]);
    stubbed(prisma.integration.findMany).mockResolvedValue([
      { name: "dc1", config: { useSsl: false } },
      { name: "dc2", config: { useSsl: true } },
      { name: "dc3", config: null },
    ]);
    h.getHaConfig.mockResolvedValue({ enabled: true });
    h.refreshPatroniScheme.mockResolvedValue(true);

    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(codes(snap.reasons)).toEqual([
      "platform_eol", "role_grant_review", "regex_pattern_unusable",
      "tls_cert_changed", "winrm_cleartext_password", "ha_patroni_rest_cleartext",
    ]);
    const grant = snap.reasons.find((r) => r.code === "role_grant_review")!;
    expect(grant.message).toContain('"e" and 1 more');
    const winrm = snap.reasons.find((r) => r.code === "winrm_cleartext_password")!;
    // HTTPS ones are not named; a missing config is not HTTPS.
    expect(winrm.message).toContain('"dc1", "dc3"');
    expect(winrm.message).not.toContain("dc2");
    expect(prisma.integration.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { type: "windowsserver", enabled: true } }));
    expect(snap.reasons.find((r) => r.code === "tls_cert_changed")!.message).toContain("fg1:443");
  });

  it("an HA node already on HTTPS, or HA off, raises no Patroni reason", async () => {
    h.getHaConfig.mockResolvedValue({ enabled: true });
    h.refreshPatroniScheme.mockResolvedValue(false);
    let snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(codes(snap.reasons)).not.toContain("ha_patroni_rest_cleartext");
    h.getHaConfig.mockResolvedValue({ enabled: false });
    h.refreshPatroniScheme.mockResolvedValue(true);
    snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(codes(snap.reasons)).not.toContain("ha_patroni_rest_cleartext");
    expect(h.refreshPatroniScheme).toHaveBeenCalledTimes(1); // not probed while HA is off
  });

  it("every side source throwing still yields a snapshot", async () => {
    h.getPlatformLifecycle.mockRejectedValue(new Error("x"));
    h.listRolesNeedingGrantReview.mockRejectedValue(new Error("x"));
    h.countUnusableStoredPatterns.mockRejectedValue(new Error("x"));
    h.changedCertPins.mockRejectedValue(new Error("x"));
    stubbed(prisma.integration.findMany).mockRejectedValue(new Error("x"));
    h.getHaConfig.mockRejectedValue(new Error("x"));
    const snap = await getCapacitySnapshot({ pgTuningNeeded: false });
    expect(snap.severity).toBe("ok");
    expect(snap.reasons).toEqual([]);
  });
});

describe("getCapacitySnapshotWithAdvisor", () => {
  it("builds the snapshot once, then re-grades it with the advisor's gaps and recommended max_connections", async () => {
    const advisor = { recommendations: [{ key: "PG_MAX_CONNECTIONS", recommended: 250 }] };
    h.recomputeAdvisorFromSnapshot.mockResolvedValue(advisor);
    h.summarizeAdvisorGaps.mockReturnValue({ poolUndersized: false, workersUndersized: false, maxConnectionsUndersized: true });

    const out = await getCapacitySnapshotWithAdvisor({ pgTuningNeeded: false, pgTuning: {} as never });
    expect(out.advisor).toBe(advisor);
    expect(h.recomputeAdvisorFromSnapshot).toHaveBeenCalledWith(out.snapshot, {});
    expect(out.snapshot.reasons.find((r) => r.code === "max_connections_undersized")!.message).toContain("recommended 250");
    expect(out.snapshot.severity).toBe("warning");
    // One snapshot pass: the database-size breakdown is read once.
    expect(h.getDatabaseSizeBreakdown).toHaveBeenCalledTimes(1);
  });

  it("leaves the reason out when the advisor has no numeric max_connections recommendation", async () => {
    h.recomputeAdvisorFromSnapshot.mockResolvedValue({ recommendations: [{ key: "PG_MAX_CONNECTIONS", recommended: "n/a" }] });
    h.summarizeAdvisorGaps.mockReturnValue({ poolUndersized: false, workersUndersized: false, maxConnectionsUndersized: true });
    const out = await getCapacitySnapshotWithAdvisor({ pgTuningNeeded: true, pgTuning: {} as never });
    expect(codes(out.snapshot.reasons)).toEqual(["pg_tuning_needed"]);
  });
});
