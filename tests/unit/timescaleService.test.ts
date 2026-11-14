/**
 * tests/unit/timescaleService.test.ts — CQ-T010: TimescaleDB detection, the
 * drop_chunks fast path, the compress-after window and the boot-time
 * hypertable / compression migration (business rule 52: the extension is
 * required; its absence is a loud, degraded state, never a crash).
 *
 * timescaleTables.test.ts pins WHICH tables are managed. This file pins what
 * the service DOES with them. Every raw SQL call is a stub
 * (`$queryRawUnsafe` / `$executeRawUnsafe` on the shared db stub), routed by
 * the catalog it reads — no database is touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/utils/logger.js", () => {
  const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
  logger.child = () => logger;
  return { logger };
});

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { logger } from "../../src/utils/logger.js";
import {
  SAMPLE_TABLES,
  ROLLUP_TABLES,
  STANDALONE_SAMPLE_TABLES,
  ALL_HYPERTABLE_CANDIDATES,
  detectTimescale,
  isTimescaleAvailable,
  isHypertable,
  getDetectionState,
  dropChunks,
  getEffectiveCompressAfterDays,
  migrateToHypertables,
} from "../../src/services/timescaleService.js";

// ─── A fake catalog ─────────────────────────────────────────────────────────

interface Catalog {
  ext: Array<{ extname: string; extversion: string | null }> | Error;
  hypertables: Array<{ hypertable_name: string }> | Error;
  /** table → rows the compression-policy introspection returns. */
  policy: (table: string, days: string) => Array<{ matches: boolean }> | Error;
  /** table → eligible uncompressed chunks. */
  chunks: (table: string, cutoffIso: string) => Array<{ qualified: string }> | Error;
}

let cat: Catalog;
const query = () => stubbed(prisma.$queryRawUnsafe);
const exec = () => stubbed(prisma.$executeRawUnsafe);

function answer<T>(v: T | Error): T {
  if (v instanceof Error) throw v;
  return v;
}

function installCatalog(): void {
  query().mockImplementation(async (sql: string, ...params: unknown[]) => {
    if (sql.includes("FROM pg_extension")) return answer(cat.ext);
    if (sql.includes("timescaledb_information.hypertables")) return answer(cat.hypertables);
    if (sql.includes("timescaledb_information.jobs")) return answer(cat.policy(params[0] as string, params[1] as string));
    if (sql.includes("timescaledb_information.chunks")) return answer(cat.chunks(params[0] as string, params[1] as string));
    throw new Error(`unexpected SQL: ${sql}`);
  });
  exec().mockImplementation(async () => 0);
}

/** Every executeRaw call as [sql, ...params]. */
const execCalls = () => exec().mock.calls as Array<[string, ...unknown[]]>;
const execFor = (table: string) => execCalls().filter(([sql, p]) => p === table || sql.includes(`"${table}"`));

const ORIGINAL_COMPRESS_ENV = process.env.TIMESCALE_COMPRESS_AFTER_DAYS;

beforeEach(async () => {
  resetDbStub();
  delete process.env.TIMESCALE_COMPRESS_AFTER_DAYS;
  cat = {
    ext: [{ extname: "timescaledb", extversion: "2.17.2" }],
    hypertables: [],
    policy: () => [],
    chunks: () => [],
  };
  installCatalog();
  for (const fn of Object.values(logger) as unknown[]) {
    if (typeof fn === "function" && "mockClear" in fn) (fn as { mockClear: () => void }).mockClear();
  }
});

afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_COMPRESS_ENV === undefined) delete process.env.TIMESCALE_COMPRESS_AFTER_DAYS;
  else process.env.TIMESCALE_COMPRESS_AFTER_DAYS = ORIGINAL_COMPRESS_ENV;
});

// ─── Table lists ────────────────────────────────────────────────────────────

describe("table lists", () => {
  it("ALL_HYPERTABLE_CANDIDATES is source + rollup + standalone, with no duplicates", () => {
    expect([...ALL_HYPERTABLE_CANDIDATES]).toEqual([...SAMPLE_TABLES, ...ROLLUP_TABLES, ...STANDALONE_SAMPLE_TABLES]);
    expect(new Set(ALL_HYPERTABLE_CANDIDATES).size).toBe(ALL_HYPERTABLE_CANDIDATES.length);
  });

  it("every source table has exactly an _hourly and a _daily rollup", () => {
    const expected = SAMPLE_TABLES.flatMap((t) => [`${t}_hourly`, `${t}_daily`]);
    expect([...ROLLUP_TABLES].sort()).toEqual(expected.sort());
  });
});

// ─── detectTimescale ────────────────────────────────────────────────────────

describe("detectTimescale", () => {
  it("absent extension: not available, no version, no hypertables, logged at ERROR (rule 52)", async () => {
    cat.ext = [];
    const s = await detectTimescale();
    expect(s).toMatchObject({ extensionInstalled: false, extensionVersion: null });
    expect(s.hypertables.size).toBe(0);
    expect(isTimescaleAvailable()).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(logger.error).mock.calls[0][1])).toContain("CREATE EXTENSION timescaledb");
    // The hypertable inventory is not even asked for.
    expect(query().mock.calls.some(([sql]) => String(sql).includes("hypertables"))).toBe(false);
  });

  it("installed: records the version and only OUR tables among the hypertables", async () => {
    cat.hypertables = [
      { hypertable_name: "asset_monitor_samples" },
      { hypertable_name: "asset_monitor_samples_daily" },
      { hypertable_name: "asset_state_samples" },
      { hypertable_name: "someone_elses_metrics" },
    ];
    const s = await detectTimescale();
    expect(s.extensionInstalled).toBe(true);
    expect(s.extensionVersion).toBe("2.17.2");
    expect([...s.hypertables].sort()).toEqual(["asset_monitor_samples", "asset_monitor_samples_daily", "asset_state_samples"]);
    expect(isHypertable("asset_monitor_samples")).toBe(true);
    expect(isHypertable("asset_telemetry_samples")).toBe(false);
    expect(isHypertable("someone_elses_metrics")).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ installed: true, extensionVersion: "2.17.2" }), "TimescaleDB detection complete");
  });

  it("a null extversion reads as null", async () => {
    cat.ext = [{ extname: "timescaledb", extversion: null }];
    expect((await detectTimescale()).extensionVersion).toBeNull();
  });

  it("an unreadable information schema still counts the extension as installed, with every table plain", async () => {
    cat.hypertables = new Error('relation "timescaledb_information.hypertables" does not exist');
    const s = await detectTimescale();
    expect(s.extensionInstalled).toBe(true);
    expect(s.hypertables.size).toBe(0);
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("a failed probe is non-fatal: it resets to 'not available' even after an earlier success", async () => {
    cat.hypertables = [{ hypertable_name: "asset_monitor_samples" }];
    await detectTimescale();
    expect(isHypertable("asset_monitor_samples")).toBe(true);
    cat.ext = new Error("connection reset");
    const s = await detectTimescale();
    expect(s).toMatchObject({ extensionInstalled: false, extensionVersion: null });
    expect(isHypertable("asset_monitor_samples")).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), "TimescaleDB detection failed; treating as not available");
  });

  it("each run replaces the inventory — a table no longer listed stops being a hypertable", async () => {
    cat.hypertables = [{ hypertable_name: "asset_storage_samples" }];
    await detectTimescale();
    cat.hypertables = [];
    await detectTimescale();
    expect(isHypertable("asset_storage_samples")).toBe(false);
  });

  it("stamps detectedAt with the probe time and exposes the same state through getDetectionState", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));
    const s = await detectTimescale();
    expect(s.detectedAt).toBe(Date.parse("2026-11-13T12:00:00Z"));
    expect(getDetectionState()).toBe(s);
  });
});

// ─── dropChunks ─────────────────────────────────────────────────────────────

describe("dropChunks", () => {
  it("is a no-op on a table that is not a hypertable", async () => {
    await detectTimescale();
    await dropChunks("asset_monitor_samples", new Date());
    expect(exec()).not.toHaveBeenCalled();
  });

  it("drops with a regclass + timestamp-without-zone cutoff passed as the UTC ISO string", async () => {
    cat.hypertables = [{ hypertable_name: "asset_monitor_samples" }];
    await detectTimescale();
    const cutoff = new Date("2026-10-01T00:00:00.000Z");
    await dropChunks("asset_monitor_samples", cutoff);
    expect(exec()).toHaveBeenCalledWith(
      "SELECT drop_chunks($1::regclass, $2::timestamp)",
      "asset_monitor_samples",
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("a failing drop_chunks is swallowed with a warning — the deleteMany path still runs", async () => {
    cat.hypertables = [{ hypertable_name: "asset_monitor_samples" }];
    await detectTimescale();
    exec().mockRejectedValueOnce(new Error("invalid time argument type"));
    await expect(dropChunks("asset_monitor_samples", new Date())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ table: "asset_monitor_samples" }), "drop_chunks failed; falling back to deleteMany");
  });

  it("is a no-op when the extension is missing altogether", async () => {
    cat.ext = [];
    await detectTimescale();
    await dropChunks("asset_monitor_samples", new Date());
    expect(exec()).not.toHaveBeenCalled();
  });
});

// ─── getEffectiveCompressAfterDays ─────────────────────────────────────────

describe("getEffectiveCompressAfterDays", () => {
  it("defaults to 7 days for every table", () => {
    expect(getEffectiveCompressAfterDays("asset_monitor_samples")).toBe(7);
    expect(getEffectiveCompressAfterDays("asset_interface_samples")).toBe(7);
  });

  it("honours the operator's window", () => {
    process.env.TIMESCALE_COMPRESS_AFTER_DAYS = "3";
    expect(getEffectiveCompressAfterDays("asset_monitor_samples")).toBe(3);
    expect(getEffectiveCompressAfterDays("asset_interface_samples")).toBe(3);
  });

  it("floors the selection-aware tables (interface / storage / ipsec) at 2 days", () => {
    process.env.TIMESCALE_COMPRESS_AFTER_DAYS = "1";
    expect(getEffectiveCompressAfterDays("asset_interface_samples")).toBe(2);
    expect(getEffectiveCompressAfterDays("asset_storage_samples")).toBe(2);
    expect(getEffectiveCompressAfterDays("asset_ipsec_tunnel_samples")).toBe(2);
    expect(getEffectiveCompressAfterDays("asset_monitor_samples")).toBe(1);
    // The rollups of a selection-aware source are not themselves selection-aware.
    expect(getEffectiveCompressAfterDays("asset_interface_samples_hourly")).toBe(1);
  });

  it("0 disables compression everywhere — the floor does not resurrect it", () => {
    process.env.TIMESCALE_COMPRESS_AFTER_DAYS = "0";
    expect(getEffectiveCompressAfterDays("asset_interface_samples")).toBe(0);
    expect(getEffectiveCompressAfterDays("asset_monitor_samples")).toBe(0);
  });

  it.each(["", "-1", "abc"])("an unusable value (%j) falls back to 7", (raw) => {
    process.env.TIMESCALE_COMPRESS_AFTER_DAYS = raw;
    expect(getEffectiveCompressAfterDays("asset_monitor_samples")).toBe(7);
  });

  it("parses leniently as an integer: '2.9' is 2, '5days' is 5", () => {
    process.env.TIMESCALE_COMPRESS_AFTER_DAYS = "2.9";
    expect(getEffectiveCompressAfterDays("asset_monitor_samples")).toBe(2);
    process.env.TIMESCALE_COMPRESS_AFTER_DAYS = "5days";
    expect(getEffectiveCompressAfterDays("asset_monitor_samples")).toBe(5);
  });

  it("is read per call, so a changed env takes effect without a restart of the module", () => {
    process.env.TIMESCALE_COMPRESS_AFTER_DAYS = "10";
    expect(getEffectiveCompressAfterDays("asset_monitor_samples")).toBe(10);
    process.env.TIMESCALE_COMPRESS_AFTER_DAYS = "4";
    expect(getEffectiveCompressAfterDays("asset_monitor_samples")).toBe(4);
  });
});

// ─── migrateToHypertables ───────────────────────────────────────────────────

describe("migrateToHypertables — gating and conversion", () => {
  it("does nothing at all without the extension", async () => {
    cat.ext = [];
    await detectTimescale();
    query().mockClear();
    await migrateToHypertables();
    expect(exec()).not.toHaveBeenCalled();
    expect(query()).not.toHaveBeenCalled();
  });

  it("converts every managed table that is not yet a hypertable", async () => {
    await detectTimescale();
    await migrateToHypertables();
    const creates = execCalls().filter(([sql]) => sql.includes("create_hypertable"));
    expect(creates.map(([, t]) => t)).toEqual([...ALL_HYPERTABLE_CANDIDATES]);
  });

  it("partitions source and standalone tables by timestamp and rollups by bucketStart", async () => {
    await detectTimescale();
    await migrateToHypertables();
    const createFor = (t: string) => execCalls().find(([sql, p]) => sql.includes("create_hypertable") && p === t)?.[0];
    expect(createFor("asset_monitor_samples")).toContain("by_range('timestamp')");
    expect(createFor("asset_state_samples")).toContain("by_range('timestamp')");
    expect(createFor("asset_monitor_samples_hourly")).toContain("by_range('bucketStart')");
    expect(createFor("asset_monitor_samples")).toContain("if_not_exists => TRUE, migrate_data => TRUE");
  });

  it("skips create_hypertable for a table that already is one, but still refreshes its compression", async () => {
    cat.hypertables = [{ hypertable_name: "asset_monitor_samples" }];
    await detectTimescale();
    await migrateToHypertables();
    const calls = execFor("asset_monitor_samples");
    expect(calls.some(([sql]) => sql.includes("create_hypertable"))).toBe(false);
    expect(calls.some(([sql]) => sql.includes("timescaledb.compress = on"))).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ table: "asset_monitor_samples" }), "Refreshed compression on asset_monitor_samples");
  });

  it("enables compression segmented by assetId and ordered by the partition column", async () => {
    await detectTimescale();
    await migrateToHypertables();
    const alter = (t: string) => execCalls().find(([sql]) => sql.startsWith(`ALTER TABLE "${t}"`))?.[0];
    expect(alter("asset_monitor_samples")).toContain(`timescaledb.compress_segmentby = '"assetId"'`);
    expect(alter("asset_monitor_samples")).toContain(`timescaledb.compress_orderby = '"timestamp" DESC'`);
    expect(alter("asset_monitor_samples_daily")).toContain(`timescaledb.compress_orderby = '"bucketStart" DESC'`);
  });

  it("gives only the selection-aware source tables a 1-day chunk interval", async () => {
    await detectTimescale();
    await migrateToHypertables();
    const intervals = execCalls().filter(([sql]) => sql.includes("set_chunk_time_interval"));
    expect(intervals.map(([, t]) => t).sort()).toEqual(["asset_interface_samples", "asset_ipsec_tunnel_samples", "asset_storage_samples"]);
    expect(intervals[0][0]).toContain("INTERVAL '1 day'");
  });

  it("a failure on one table is logged and the loop carries on to the next", async () => {
    await detectTimescale();
    exec().mockImplementation(async (sql: string, table?: unknown) => {
      if (sql.includes("create_hypertable") && table === "asset_telemetry_samples") throw new Error("lock timeout");
      return 0;
    });
    await migrateToHypertables();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ table: "asset_telemetry_samples", partitionColumn: "timestamp" }),
      "Hypertable migration failed for this table; falling back to plain-table prune path",
    );
    // Nothing else on the failed table ran; the next table still converted.
    expect(execCalls().some(([sql]) => sql.startsWith(`ALTER TABLE "asset_telemetry_samples"`))).toBe(false);
    expect(execCalls().some(([sql, t]) => sql.includes("create_hypertable") && t === "asset_hardware_sensor_samples")).toBe(true);
  });

  it("re-detects after the loop so isHypertable reflects the converted tables", async () => {
    await detectTimescale();
    expect(isHypertable("asset_monitor_samples")).toBe(false);
    cat.hypertables = [{ hypertable_name: "asset_monitor_samples" }];
    await migrateToHypertables();
    expect(isHypertable("asset_monitor_samples")).toBe(true);
  });
});

describe("migrateToHypertables — the compression policy", () => {
  it("leaves a policy whose window already matches alone, so its 12h schedule survives a reboot", async () => {
    cat.policy = () => [{ matches: true }];
    await detectTimescale();
    await migrateToHypertables();
    expect(execCalls().some(([sql]) => sql.includes("remove_compression_policy"))).toBe(false);
    expect(execCalls().some(([sql]) => sql.includes("add_compression_policy"))).toBe(false);
  });

  it("asks about the EFFECTIVE window for each table", async () => {
    process.env.TIMESCALE_COMPRESS_AFTER_DAYS = "1";
    const asked = new Map<string, string>();
    cat.policy = (t, d) => { asked.set(t, d); return [{ matches: true }]; };
    await detectTimescale();
    await migrateToHypertables();
    expect(asked.get("asset_interface_samples")).toBe("2");
    expect(asked.get("asset_monitor_samples")).toBe("1");
  });

  it("removes then re-adds the policy when the window changed", async () => {
    cat.policy = () => [{ matches: false }];
    await detectTimescale();
    await migrateToHypertables();
    const calls = execFor("asset_monitor_samples").map(([sql]) => sql);
    const rm = calls.findIndex((s) => s.includes("remove_compression_policy"));
    const add = calls.findIndex((s) => s.includes("add_compression_policy"));
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThan(rm);
    expect(calls[add]).toContain("INTERVAL '7 days'");
    expect(calls[rm]).toContain("if_exists => TRUE");
  });

  it("recreates when there is no policy yet", async () => {
    cat.policy = () => [];
    await detectTimescale();
    await migrateToHypertables();
    expect(execFor("asset_monitor_samples").some(([sql]) => sql.includes("add_compression_policy"))).toBe(true);
  });

  it("recreates when any of several policy rows disagrees", async () => {
    cat.policy = () => [{ matches: true }, { matches: false }];
    await detectTimescale();
    await migrateToHypertables();
    expect(execFor("asset_monitor_samples").some(([sql]) => sql.includes("add_compression_policy"))).toBe(true);
  });

  it("recreates when the jobs view cannot be read — always correct, just not idempotent", async () => {
    cat.policy = () => new Error("column config does not exist");
    await detectTimescale();
    await migrateToHypertables();
    expect(execFor("asset_monitor_samples").some(([sql]) => sql.includes("add_compression_policy"))).toBe(true);
  });

  it("re-adds selection-aware tables at their 2-day floor", async () => {
    process.env.TIMESCALE_COMPRESS_AFTER_DAYS = "1";
    await detectTimescale();
    await migrateToHypertables();
    const add = (t: string) => execFor(t).find(([sql]) => sql.includes("add_compression_policy"))?.[0];
    expect(add("asset_interface_samples")).toContain("INTERVAL '2 days'");
    expect(add("asset_monitor_samples")).toContain("INTERVAL '1 days'");
  });

  it("with compression disabled (0) removes any lingering policy, adds none, and never asks the jobs view", async () => {
    process.env.TIMESCALE_COMPRESS_AFTER_DAYS = "0";
    await detectTimescale();
    await migrateToHypertables();
    expect(execCalls().filter(([sql]) => sql.includes("remove_compression_policy"))).toHaveLength(ALL_HYPERTABLE_CANDIDATES.length);
    expect(execCalls().some(([sql]) => sql.includes("add_compression_policy"))).toBe(false);
    expect(query().mock.calls.some(([sql]) => String(sql).includes("timescaledb_information.jobs"))).toBe(false);
  });
});

describe("migrateToHypertables — the backlog self-heal", () => {
  const compressCalls = () => execCalls().filter(([sql]) => sql.includes("compress_chunk"));

  it("compresses eligible chunks in the order the view returns them (oldest first)", async () => {
    cat.chunks = (t) => (t === "asset_interface_samples"
      ? [{ qualified: "_timescaledb_internal._hyper_3_1_chunk" }, { qualified: "_timescaledb_internal._hyper_3_2_chunk" }]
      : []);
    await detectTimescale();
    await migrateToHypertables();
    expect(compressCalls().map(([, c]) => c)).toEqual(["_timescaledb_internal._hyper_3_1_chunk", "_timescaledb_internal._hyper_3_2_chunk"]);
    expect(compressCalls()[0][0]).toBe("SELECT compress_chunk($1::regclass)");
  });

  it("caps the pass at 8 chunks per table and logs how many remain", async () => {
    cat.chunks = (t) => (t === "asset_monitor_samples" ? Array.from({ length: 11 }, (_, i) => ({ qualified: `c${i}` })) : []);
    await detectTimescale();
    await migrateToHypertables();
    expect(compressCalls().map(([, c]) => c)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ table: "asset_monitor_samples", eligibleChunks: 11, compressed: 8, remaining: 3 }),
      expect.stringContaining("3 remain"),
    );
  });

  it("a failed compress_chunk is logged, not counted, and the pass continues", async () => {
    cat.chunks = (t) => (t === "asset_monitor_samples" ? [{ qualified: "bad" }, { qualified: "good" }] : []);
    await detectTimescale();
    exec().mockImplementation(async (sql: string, p?: unknown) => {
      if (sql.includes("compress_chunk") && p === "bad") throw new Error("chunk locked");
      return 0;
    });
    await migrateToHypertables();
    expect(compressCalls().map(([, c]) => c)).toEqual(["bad", "good"]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ chunk: "bad" }), "backlog compress_chunk failed");
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ table: "asset_monitor_samples", compressed: 1, remaining: 1 }), expect.any(String));
  });

  it("an unreadable chunks view skips the pass quietly", async () => {
    cat.chunks = () => new Error("view missing");
    await detectTimescale();
    await expect(migrateToHypertables()).resolves.toBeUndefined();
    expect(compressCalls()).toHaveLength(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("asks only for chunks wholly older than the table's effective window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T00:00:00.000Z"));
    process.env.TIMESCALE_COMPRESS_AFTER_DAYS = "1";
    const cutoffs = new Map<string, string>();
    cat.chunks = (t, c) => { cutoffs.set(t, c); return []; };
    await detectTimescale();
    await migrateToHypertables();
    expect(cutoffs.get("asset_monitor_samples")).toBe("2026-11-12T00:00:00.000Z");
    expect(cutoffs.get("asset_interface_samples")).toBe("2026-11-11T00:00:00.000Z");
  });

  it("runs only after every table's DDL is in place", async () => {
    await detectTimescale();
    await migrateToHypertables();
    const order = query().mock.calls.map(([sql]) => String(sql));
    const lastJobs = order.map((s) => s.includes("timescaledb_information.jobs")).lastIndexOf(true);
    const firstChunks = order.findIndex((s) => s.includes("timescaledb_information.chunks"));
    expect(firstChunks).toBeGreaterThan(lastJobs);
  });

  it("with compression disabled there is no backlog pass", async () => {
    process.env.TIMESCALE_COMPRESS_AFTER_DAYS = "0";
    await detectTimescale();
    await migrateToHypertables();
    expect(query().mock.calls.some(([sql]) => String(sql).includes("timescaledb_information.chunks"))).toBe(false);
  });
});
