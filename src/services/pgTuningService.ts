/**
 * src/services/pgTuningService.ts — the PostgreSQL tuning check.
 *
 * Reads pg_settings and compares shared_buffers / work_mem /
 * effective_cache_size / random_page_cost against recommendations sized from
 * host RAM. Its `pgTuningNeeded` flag feeds the capacity snapshot's
 * `pg_tuning_needed` reason, and its rows feed the Capacity Advisor.
 *
 * Lives in a service (it used to sit in serverSettings.ts) so the capacityWatch
 * job grades capacity with the SAME inputs the Maintenance tab does: the job is
 * the one evaluator that records capacity transitions, and a job that left this
 * check out would disagree with the page about the host's severity.
 */

import { totalmem } from "node:os";
import { prisma } from "../db.js";
import type { PgTuningExternal } from "./capacityAdvisorService.js";

export const PG_TUNING_THRESHOLDS = {
  assets: 160,        // 80% of 200
  subnets: 1600,      // 80% of 2,000
  reservations: 160000, // 80% of 200,000
};

export function buildPgRecommended(): Record<string, { min: number; unit: string; display: string }> {
  const ram = totalmem();
  const MB = 1024 * 1024;
  const GB = 1024 * MB;

  // Round to clean multiples of 8 so the recommended values sit on the same
  // boundaries operators are used to seeing in postgresql.conf (8/16/24/32 GB,
  // 8/16/24 MB). Postgres accepts any MB-resolution value, but recommending
  // "15 GB" or "46 GB" reads as an arbitrary fraction of host RAM — bumping
  // those to the nearest 8 GB (16 GB / 48 GB) makes the recommendation
  // actionable without a "...why that specific number?" pause.
  const roundToMultipleOf = (b: number, unit: number) => Math.round(b / unit) * unit;
  const EIGHT_MB = 8 * MB;
  const EIGHT_GB = 8 * GB;

  // For shared_buffers / effective_cache_size: round to 8 GB on hosts where
  // the natural value lands ≥4 GB (so it rounds up cleanly), and fall back to
  // 8 MB rounding on tiny-RAM hosts where 8-GB rounding would collapse to 0.
  const sharedBuffers = Math.max(
    128 * MB,
    roundToMultipleOf(ram * 0.25, EIGHT_GB) || roundToMultipleOf(ram * 0.25, EIGHT_MB),
  );
  const effectiveCache = Math.max(
    256 * MB,
    roundToMultipleOf(ram * 0.75, EIGHT_GB) || roundToMultipleOf(ram * 0.75, EIGHT_MB),
  );
  // work_mem: RAM/128, rounded to nearest 8 MB, capped at 256 MB, min 32 MB.
  const workMem = Math.max(32 * MB, Math.min(256 * MB, roundToMultipleOf(ram / 128, EIGHT_MB)));

  const fmt = (b: number) =>
    b >= GB ? (b / GB) + "GB"
    : (b / MB) + "MB";

  return {
    shared_buffers:      { min: sharedBuffers,  unit: "bytes", display: fmt(sharedBuffers) },
    work_mem:            { min: workMem,        unit: "bytes", display: fmt(workMem) },
    effective_cache_size:{ min: effectiveCache, unit: "bytes", display: fmt(effectiveCache) },
    random_page_cost:    { min: -1,             unit: "cost",  display: "1.1" },
  };
}

export function parsePgBytes(val: string): number {
  const s = val.trim();
  // PostgreSQL reports in 8kB pages for shared_buffers, or kB/MB/GB suffixes
  const m = s.match(/^(\d+)\s*(kB|MB|GB|TB)?$/i);
  if (!m) return parseInt(s, 10) || 0;
  const n = parseInt(m[1], 10);
  switch ((m[2] || "").toUpperCase()) {
    case "KB": return n * 1024;
    case "MB": return n * 1024 * 1024;
    case "GB": return n * 1024 * 1024 * 1024;
    case "TB": return n * 1024 * 1024 * 1024 * 1024;
    default:   return n; // unit-less = 8kB pages for shared_buffers
  }
}

/**
 * Compute the pg-tuning data: per-setting current vs recommended pairs, the
 * pg_settings config-file path, plus the `pgTuningNeeded` flag consumed by
 * capacityService.
 *
 * Extracted into a helper so both `/pg-tuning` and `/capacity-advisor` can
 * reuse it without duplicating the PG_SETTINGS query. Returns null when no
 * threshold is crossed (small install — no tuning advice yet).
 */
export interface PgTuningRow {
  name: string;
  current: string;
  recommended: string;
  ok: boolean;
  /** True when the current value was set explicitly via ALTER SYSTEM
   *  (postgresql.auto.conf). Such a value is a deliberate operator choice, so
   *  the advisor treats it as OK even when below its heuristic recommendation —
   *  otherwise an operator who intentionally lowered work_mem (e.g. to stop
   *  swapping) gets a permanent false "Stage" nag, and staging would write to
   *  postgresql.conf which auto.conf overrides anyway. */
  operatorOverride: boolean;
}

/**
 * True when a pg_settings row's value comes from postgresql.auto.conf — i.e. it
 * was set by ALTER SYSTEM. Postgres reports such values with
 * source='configuration file' and a sourcefile ending in postgresql.auto.conf.
 */
export function isAutoConfOverride(s: { sourcefile: string | null }): boolean {
  return !!s.sourcefile && /postgresql\.auto\.conf$/.test(s.sourcefile.replace(/\\/g, "/"));
}
export interface PgTuningResult {
  settings: PgTuningRow[];
  pgConfigFile: string | null;
  pgTuningNeeded: boolean;
}
export async function computePgTuning(): Promise<PgTuningResult | null> {
  const [assetCount, subnetCount, reservationCount] = await Promise.all([
    prisma.asset.count(),
    prisma.subnet.count(),
    prisma.reservation.count(),
  ]);

  const triggered: string[] = [];
  if (assetCount >= PG_TUNING_THRESHOLDS.assets) triggered.push("assets");
  if (subnetCount >= PG_TUNING_THRESHOLDS.subnets) triggered.push("subnets");
  if (reservationCount >= PG_TUNING_THRESHOLDS.reservations) triggered.push("reservations");
  if (!triggered.length) return null;

  const pgSettings = await prisma.$queryRawUnsafe<{ name: string; setting: string; unit: string | null; sourcefile: string | null }[]>(
    `SELECT name, setting, unit, sourcefile FROM pg_settings WHERE name IN ('shared_buffers', 'work_mem', 'effective_cache_size', 'random_page_cost', 'config_file')`
  );
  const pgConfigFile = pgSettings.find((s) => s.name === "config_file")?.setting || null;

  const PG_RECOMMENDED = buildPgRecommended();
  const settings: PgTuningRow[] = pgSettings.map((s) => {
    if (s.name === "config_file") return null;
    const rec = PG_RECOMMENDED[s.name];
    if (!rec) return null;
    // An explicit ALTER SYSTEM override is a deliberate operator choice — never
    // flag it as needing change, regardless of the heuristic recommendation.
    const operatorOverride = isAutoConfOverride(s);
    let currentBytes: number;
    let ok: boolean;
    if (s.name === "random_page_cost") {
      const val = parseFloat(s.setting);
      ok = operatorOverride || val <= 1.1;
      return { name: s.name, current: String(val), recommended: rec.display, ok, operatorOverride };
    }
    if (s.unit === "8kB") {
      currentBytes = parseInt(s.setting, 10) * 8192;
    } else if (s.unit === "kB") {
      currentBytes = parseInt(s.setting, 10) * 1024;
    } else {
      currentBytes = parsePgBytes(s.setting);
    }
    ok = operatorOverride || currentBytes >= rec.min;
    let currentDisplay: string;
    if (currentBytes >= 1024 * 1024 * 1024) currentDisplay = (currentBytes / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "") + "GB";
    else if (currentBytes >= 1024 * 1024) currentDisplay = (currentBytes / (1024 * 1024)).toFixed(0) + "MB";
    else currentDisplay = (currentBytes / 1024).toFixed(0) + "kB";
    return { name: s.name, current: currentDisplay, recommended: rec.display, ok, operatorOverride };
  }).filter((s): s is PgTuningRow => s !== null);

  const allOk = settings.every((s) => s.ok);
  return { settings, pgConfigFile, pgTuningNeeded: !allOk };
}

/** Project the pg-tuning rows into the shape the Capacity Advisor consumes. */
export function pgTuningToAdvisorShape(t: PgTuningResult | null): PgTuningExternal {
  const find = (name: string): PgTuningRow | undefined =>
    t?.settings.find((s) => s.name === name);
  const sb = find("shared_buffers");
  const ec = find("effective_cache_size");
  const wm = find("work_mem");
  const rp = find("random_page_cost");
  const PG_DEFAULTS = buildPgRecommended();
  return {
    sharedBuffers: {
      current: sb?.current ?? null,
      recommended: sb?.recommended ?? PG_DEFAULTS.shared_buffers.display,
      changeRequired: sb ? !sb.ok : false,
      operatorOverride: sb?.operatorOverride ?? false,
    },
    effectiveCacheSize: {
      current: ec?.current ?? null,
      recommended: ec?.recommended ?? PG_DEFAULTS.effective_cache_size.display,
      changeRequired: ec ? !ec.ok : false,
      operatorOverride: ec?.operatorOverride ?? false,
    },
    workMem: {
      current: wm?.current ?? null,
      recommended: wm?.recommended ?? PG_DEFAULTS.work_mem.display,
      changeRequired: wm ? !wm.ok : false,
      operatorOverride: wm?.operatorOverride ?? false,
    },
    randomPageCost: {
      current: rp?.current ?? null,
      recommended: rp?.recommended ?? PG_DEFAULTS.random_page_cost.display,
      changeRequired: rp ? !rp.ok : false,
      operatorOverride: rp?.operatorOverride ?? false,
    },
  };
}
