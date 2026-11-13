/**
 * tests/unit/sampleRollupService.test.ts — the rollup orchestration and the
 * one-shot max-line backfill, against a mocked raw-SQL client (CQ-T010).
 *
 * Complements, does not repeat:
 *   - rollupBucketFloor.test.ts — bucketFloor
 *   - maxLineBackfillDays.test.ts — the pure day-window arithmetic
 *   - integration/sampleRollup + sampleRollupMaxLines + pathChecks — the SQL
 *     itself against a real database
 *
 * What was unreached in unit scope: rollupHourly / rollupDaily — one statement
 * per source table, all nine, with `since` floored to a bucket edge (the
 * mid-bucket overwrite the bucketFloor comment describes), the hourly tier
 * reading DETAIL tables and the daily tier reading HOURLY tables, and a
 * failed table being logged and skipped rather than ending the pass;
 * rollupRange — bounded ($2) statements, and a failure that THROWS; and
 * runMaxLineBackfillOnce — the marker short-circuit, every hourly slice
 * before any daily one, the marker written only after a clean pass, the
 * compressed-chunk bound read from TimescaleDB (and ignored when that read
 * fails or Timescale is absent).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

const h = vi.hoisted(() => ({
  stopTimer: vi.fn(),
  startSampleRollupTimer: vi.fn(),
  getSampleRetention: vi.fn(),
  getEffectiveCompressAfterDays: vi.fn((_t: string) => 7),
  isTimescaleAvailable: vi.fn(() => false),
}));
vi.mock("../../src/metrics.js", () => ({ startSampleRollupTimer: h.startSampleRollupTimer }));
vi.mock("../../src/services/sampleRetentionService.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/sampleRetentionService.js")>()),
  getSampleRetention: h.getSampleRetention,
}));
vi.mock("../../src/services/timescaleService.js", () => ({
  getEffectiveCompressAfterDays: h.getEffectiveCompressAfterDays,
  isTimescaleAvailable: h.isTimescaleAvailable,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  MAX_LINE_BACKFILL_MARKER,
  rollupDaily,
  rollupHourly,
  rollupRange,
  runMaxLineBackfillOnce,
} from "../../src/services/sampleRollupService.js";

const exec = () => stubbed(prisma.$executeRawUnsafe);
const NOW = new Date("2026-11-13T14:37:12.345Z");

const SOURCES = ["monitor", "telemetry", "hardware", "interface", "storage", "ipsec", "perfSla", "pathCheck", "process"];
const DETAIL = [
  "asset_monitor_samples", "asset_telemetry_samples", "asset_hardware_sensor_samples", "asset_interface_samples",
  "asset_storage_samples", "asset_ipsec_tunnel_samples", "asset_perf_sla_samples", "asset_path_check_samples", "asset_process_samples",
];

beforeEach(() => {
  resetDbStub();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.stopTimer.mockReset();
  h.startSampleRollupTimer.mockReset();
  h.startSampleRollupTimer.mockReturnValue(h.stopTimer);
  h.getEffectiveCompressAfterDays.mockReset();
  h.getEffectiveCompressAfterDays.mockReturnValue(7);
  h.isTimescaleAvailable.mockReset();
  h.isTimescaleAvailable.mockReturnValue(false);
  h.getSampleRetention.mockReset();
  h.getSampleRetention.mockResolvedValue({ cpuMem: { detail: 7 }, interfaces: { detail: 7 } });
  exec().mockResolvedValue(3);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rollupHourly", () => {
  it("one statement per source, all nine, from the floored hour two hours back", async () => {
    const results = await rollupHourly();
    expect(results.map((r) => r.source)).toEqual(SOURCES);
    expect(results.every((r) => r.tier === "hourly" && r.rowsTouched === 3)).toBe(true);
    expect(exec()).toHaveBeenCalledTimes(9);
    for (const call of exec().mock.calls) {
      expect(call).toHaveLength(2); // the SQL + $1 only — never an unreferenced $2
      expect(call[1]).toEqual(new Date("2026-11-13T12:00:00.000Z"));
    }
    expect(h.startSampleRollupTimer).toHaveBeenCalledWith("hourly", "monitor");
    expect(h.stopTimer).toHaveBeenCalledTimes(9);
  });

  it("each hourly statement reads its DETAIL table and upserts its hourly table", async () => {
    await rollupHourly(5);
    exec().mock.calls.forEach((call, i) => {
      const sql = String(call[0]);
      expect(sql).toContain(`INSERT INTO "${DETAIL[i]}_hourly"`);
      expect(sql).toContain(`FROM "${DETAIL[i]}"`);
      expect(sql).toContain("ON CONFLICT");
      expect(sql).toContain("$1");
      expect(sql).not.toContain("$2");
    });
    expect(exec().mock.calls[0]![1]).toEqual(new Date("2026-11-13T09:00:00.000Z"));
  });

  it("a failed table is logged and skipped: the pass continues and that table reports 0 rows", async () => {
    exec().mockImplementation(async (sql: string) => {
      if (sql.includes('"asset_interface_samples_hourly"')) throw new Error("deadlock");
      return 2;
    });
    const results = await rollupHourly();
    expect(results).toHaveLength(9);
    expect(results.find((r) => r.source === "interface")!.rowsTouched).toBe(0);
    expect(results.find((r) => r.source === "process")!.rowsTouched).toBe(2);
    expect(h.stopTimer).toHaveBeenCalledTimes(9);
  });
});

describe("rollupDaily", () => {
  it("reads the HOURLY tables into the daily ones, from the floored UTC day", async () => {
    const results = await rollupDaily();
    expect(results.every((r) => r.tier === "daily")).toBe(true);
    exec().mock.calls.forEach((call, i) => {
      const sql = String(call[0]);
      expect(sql).toContain(`INSERT INTO "${DETAIL[i]}_daily"`);
      expect(sql).toContain(`FROM "${DETAIL[i]}_hourly"`);
      expect(call[1]).toEqual(new Date("2026-11-11T00:00:00.000Z"));
    });
  });
});

describe("rollupRange", () => {
  const since = new Date("2026-11-10T00:00:00Z");
  const until = new Date("2026-11-11T00:00:00Z");

  it("binds the upper bound as $2 for the bounded sources", async () => {
    const r = await rollupRange("hourly", ["telemetry", "interface"], since, until);
    expect(r.map((x) => [x.source, x.tier, x.rowsTouched])).toEqual([["telemetry", "hourly", 3], ["interface", "hourly", 3]]);
    for (const call of exec().mock.calls) {
      expect(String(call[0])).toContain("$2");
      expect(call.slice(1)).toEqual([since, until]);
    }
    expect(String(exec().mock.calls[0]![0])).toContain('"asset_telemetry_samples_hourly"');
  });

  it("a failed statement THROWS, so a one-shot caller can retry", async () => {
    exec().mockRejectedValue(new Error("statement timeout"));
    await expect(rollupRange("daily", ["interface"], since, until)).rejects.toThrow("statement timeout");
    expect(h.stopTimer).toHaveBeenCalledTimes(1);
  });

  it("an empty source list runs nothing", async () => {
    await expect(rollupRange("hourly", [], since, until)).resolves.toEqual([]);
    expect(exec()).not.toHaveBeenCalled();
  });
});

describe("runMaxLineBackfillOnce", () => {
  it("does nothing once the marker exists", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValue({ key: MAX_LINE_BACKFILL_MARKER });
    await expect(runMaxLineBackfillOnce(NOW)).resolves.toEqual({ ran: false, days: [], hourlyRows: 0, dailyRows: 0, durationMs: 0 });
    expect(exec()).not.toHaveBeenCalled();
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });

  it("rebuilds every hourly slice before any daily one, then writes the marker with the tallies", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValue(null);
    const out = await runMaxLineBackfillOnce(NOW);
    // 7-day detail + 7-day compress-after → limit 6 days → first midnight at or after now-6d.
    expect(out.days).toEqual(["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
    expect(out.ran).toBe(true);
    const tiers = exec().mock.calls.map((c) => (String(c[0]).includes("_daily\"") ? "daily" : "hourly"));
    expect(tiers).toEqual([...Array(12).fill("hourly"), ...Array(12).fill("daily")]);
    expect(out.hourlyRows).toBe(36);
    expect(out.dailyRows).toBe(36);
    const firstHourly = exec().mock.calls[0]!;
    expect(firstHourly.slice(1)).toEqual([new Date("2026-11-08T00:00:00Z"), new Date("2026-11-09T00:00:00Z")]);
    expect(prisma.setting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: MAX_LINE_BACKFILL_MARKER },
      create: { key: MAX_LINE_BACKFILL_MARKER, value: expect.objectContaining({ days: out.days, hourlyRows: 36, dailyRows: 36 }) },
    }));
    expect(h.getEffectiveCompressAfterDays.mock.calls.map((c) => c[0])).toEqual([
      "asset_telemetry_samples_hourly", "asset_telemetry_samples_daily", "asset_interface_samples_hourly", "asset_interface_samples_daily",
    ]);
  });

  it("an empty window still sets the marker, so it never looks again", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValue(null);
    h.getSampleRetention.mockResolvedValue({ cpuMem: { detail: 0 }, interfaces: { detail: 0 } });
    const out = await runMaxLineBackfillOnce(NOW);
    expect(out).toMatchObject({ ran: true, days: [], hourlyRows: 0, dailyRows: 0 });
    expect(exec()).not.toHaveBeenCalled();
    expect(prisma.setting.upsert).toHaveBeenCalledTimes(1);
  });

  it("a failed slice throws and leaves the marker unset", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValue(null);
    exec().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("disk full"));
    await expect(runMaxLineBackfillOnce(NOW)).rejects.toThrow("disk full");
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });

  it("on TimescaleDB, starts a full day after the newest compressed chunk", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValue(null);
    h.isTimescaleAvailable.mockReturnValue(true);
    stubbed(prisma.$queryRawUnsafe).mockResolvedValue([{ m: new Date("2026-11-10T00:00:00Z") }]);
    const out = await runMaxLineBackfillOnce(NOW);
    expect(out.days).toEqual(["2026-11-11", "2026-11-12", "2026-11-13"]);
    const [sql, tables] = stubbed(prisma.$queryRawUnsafe).mock.calls[0]!;
    expect(String(sql)).toContain("timescaledb_information.chunks");
    expect(tables).toHaveLength(4);
  });

  it("a failed chunk introspection falls back to the compress-after window", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValue(null);
    h.isTimescaleAvailable.mockReturnValue(true);
    stubbed(prisma.$queryRawUnsafe).mockRejectedValue(new Error("permission denied"));
    const out = await runMaxLineBackfillOnce(NOW);
    expect(out.days).toHaveLength(6);
  });

  it("without TimescaleDB the catalog is never read", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValue(null);
    await runMaxLineBackfillOnce(NOW);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
