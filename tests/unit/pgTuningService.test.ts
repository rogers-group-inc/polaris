/**
 * tests/unit/pgTuningService.test.ts — the PostgreSQL tuning check.
 *
 * Extracted from serverSettings.ts so the capacityWatch job grades capacity
 * with the same `pg_tuning_needed` input the Maintenance tab does (business
 * rule 105). These pin the pieces the job and both routes now share.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const counts = { asset: 0, subnet: 0, reservation: 0 };
let pgSettingsRows: any[] = [];

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: { count: vi.fn(async () => counts.asset) },
    subnet: { count: vi.fn(async () => counts.subnet) },
    reservation: { count: vi.fn(async () => counts.reservation) },
    $queryRawUnsafe: vi.fn(async () => pgSettingsRows),
  },
}));

import {
  PG_TUNING_THRESHOLDS,
  buildPgRecommended,
  parsePgBytes,
  isAutoConfOverride,
  computePgTuning,
  pgTuningToAdvisorShape,
} from "../../src/services/pgTuningService.js";

const GB = 1024 * 1024 * 1024;

beforeEach(() => {
  counts.asset = 0;
  counts.subnet = 0;
  counts.reservation = 0;
  pgSettingsRows = [];
});

describe("parsePgBytes", () => {
  it("reads the unit suffixes pg_settings uses, and a bare number as-is", () => {
    expect(parsePgBytes("64kB")).toBe(64 * 1024);
    expect(parsePgBytes("4MB")).toBe(4 * 1024 * 1024);
    expect(parsePgBytes("2GB")).toBe(2 * GB);
    expect(parsePgBytes("1TB")).toBe(1024 * GB);
    expect(parsePgBytes("16384")).toBe(16384);
  });
});

describe("isAutoConfOverride", () => {
  it("is true only for a value set by ALTER SYSTEM, on either path separator", () => {
    expect(isAutoConfOverride({ sourcefile: "/var/lib/pgsql/data/postgresql.auto.conf" })).toBe(true);
    expect(isAutoConfOverride({ sourcefile: "C:\\pg\\data\\postgresql.auto.conf" })).toBe(true);
    expect(isAutoConfOverride({ sourcefile: "/var/lib/pgsql/data/postgresql.conf" })).toBe(false);
    expect(isAutoConfOverride({ sourcefile: null })).toBe(false);
  });
});

describe("buildPgRecommended", () => {
  it("recommends every setting the check reads, with floors", () => {
    const rec = buildPgRecommended();
    for (const k of ["shared_buffers", "work_mem", "effective_cache_size", "random_page_cost"]) {
      expect(rec[k]).toBeDefined();
    }
    expect(rec.shared_buffers.min).toBeGreaterThanOrEqual(128 * 1024 * 1024);
    expect(rec.work_mem.min).toBeGreaterThanOrEqual(32 * 1024 * 1024);
    expect(rec.work_mem.min).toBeLessThanOrEqual(256 * 1024 * 1024);
    expect(rec.random_page_cost.display).toBe("1.1");
  });
});

describe("computePgTuning", () => {
  it("returns null below every threshold — a small install gets no tuning advice", async () => {
    counts.asset = PG_TUNING_THRESHOLDS.assets - 1;
    expect(await computePgTuning()).toBeNull();
  });

  it("flags a setting below its recommendation, and honours an ALTER SYSTEM override", async () => {
    counts.asset = PG_TUNING_THRESHOLDS.assets;
    pgSettingsRows = [
      { name: "shared_buffers", setting: "16", unit: "8kB", sourcefile: "/d/postgresql.conf" },
      { name: "random_page_cost", setting: "4", unit: null, sourcefile: "/d/postgresql.auto.conf" },
      { name: "config_file", setting: "/d/postgresql.conf", unit: null, sourcefile: null },
    ];
    const t = await computePgTuning();
    expect(t).not.toBeNull();
    expect(t!.pgConfigFile).toBe("/d/postgresql.conf");
    expect(t!.pgTuningNeeded).toBe(true);
    const sb = t!.settings.find((s) => s.name === "shared_buffers")!;
    expect(sb).toMatchObject({ ok: false, current: "128kB", operatorOverride: false });
    const rp = t!.settings.find((s) => s.name === "random_page_cost")!;
    expect(rp).toMatchObject({ ok: true, operatorOverride: true });
  });

  it("is satisfied when every setting meets its recommendation", async () => {
    counts.reservation = PG_TUNING_THRESHOLDS.reservations;
    pgSettingsRows = [
      { name: "random_page_cost", setting: "1.1", unit: null, sourcefile: null },
    ];
    const t = await computePgTuning();
    expect(t!.pgTuningNeeded).toBe(false);
  });
});

describe("pgTuningToAdvisorShape", () => {
  it("projects the rows the advisor reads, falling back to the recommendation when absent", () => {
    const shape = pgTuningToAdvisorShape({
      settings: [{ name: "work_mem", current: "4MB", recommended: "32MB", ok: false, operatorOverride: false }],
      pgConfigFile: null,
      pgTuningNeeded: true,
    });
    expect(shape.workMem).toMatchObject({ current: "4MB", recommended: "32MB", changeRequired: true });
    expect(shape.sharedBuffers).toMatchObject({ current: null, changeRequired: false });
    expect(shape.sharedBuffers.recommended).toBe(buildPgRecommended().shared_buffers.display);
  });

  it("accepts a null check (small install) without throwing", () => {
    const shape = pgTuningToAdvisorShape(null);
    expect(shape.randomPageCost).toMatchObject({ current: null, changeRequired: false });
  });
});
