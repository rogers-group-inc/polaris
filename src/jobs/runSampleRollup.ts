/**
 * src/jobs/runSampleRollup.ts
 *
 * Two ticking loops with independent `running` guards. Phase 2 of the
 * tiered sample-retention work — populates the hourly + daily rollup
 * tables created in phase 1 by calling into sampleRollupService.
 *
 * Cadences:
 *   - Hourly: every 30 minutes (also fires once 60s after boot to catch
 *     any backlog accumulated while the process was down). Lookback 2
 *     hours covers late-arriving samples from sampleWriteBuffer's 2s
 *     flush window across an hour rollover.
 *   - Daily:  once per day at 02:30 UTC (deliberately off-peak), plus a
 *     boot-time tick 90s after boot to catch up after restarts. Lookback
 *     2 days for the same late-arrival reason at a coarser cadence.
 *
 * Per-tick the job:
 *   1. Runs the rollup INSERTs (idempotent — ON CONFLICT DO UPDATE).
 *   2. Stamps `Setting("sampleRollup.<tier>.lastSuccess")` with the ISO
 *      timestamp + per-table row counts so the capacity-watch hook (phase 6)
 *      can fire `sample_rollup_lagging` when the last success exceeds the
 *      "this should have run by now" threshold.
 *   3. Logs result counts at info level for fleet-wide visibility.
 *
 * Independent `running` guards so a slow hourly tick can't double-fire
 * if the fleet ever grows large enough that one pass exceeds 30 minutes.
 * Best-effort — failures are logged but don't crash the process.
 *
 * Import this module from src/app.ts to activate.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { rollupHourly, rollupDaily, type RollupResult } from "../services/sampleRollupService.js";
import { defineJob } from "./_defineJob.js";

const HOURLY_INTERVAL_MS = 30 * 60 * 1000;
const HOURLY_BOOT_DELAY_MS = 60 * 1000;
const DAILY_BOOT_DELAY_MS = 90 * 1000;

async function runHourly(): Promise<void> {
    const results = await rollupHourly();
    await stampLastSuccess("hourly", results);
    logResults("hourly", results);
}

async function runDaily(): Promise<void> {
    const results = await rollupDaily();
    await stampLastSuccess("daily", results);
    logResults("daily", results);
}

async function stampLastSuccess(tier: "hourly" | "daily", results: RollupResult[]): Promise<void> {
  const key = `sampleRollup.${tier}.lastSuccess`;
  const value = {
    at: new Date().toISOString(),
    perTable: Object.fromEntries(
      results.map((r) => [r.source, { rowsTouched: r.rowsTouched, durationMs: r.durationMs }]),
    ),
  };
  await prisma.setting.upsert({
    where:  { key },
    update: { value: value as any },
    create: { key, value: value as any },
  });
}

function logResults(tier: "hourly" | "daily", results: RollupResult[]): void {
  const totalRows = results.reduce((s, r) => s + r.rowsTouched, 0);
  const totalMs   = results.reduce((s, r) => s + r.durationMs, 0);
  if (totalRows === 0) return; // quiet boot ticks on empty installs
  logger.info(
    {
      tier,
      totalRows,
      totalMs,
      perTable: Object.fromEntries(results.map((r) => [r.source, r.rowsTouched])),
    },
    `Sample rollup (${tier}) complete`,
  );
}

/**
 * Milliseconds until the next occurrence of HH:MM UTC from now (always strictly future).
 */
function msUntilNextUtc(hourUtc: number, minuteUtc: number): number {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hourUtc,
    minuteUtc,
    0,
    0,
  ));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

// ── Schedule ─────────────────────────────────────────────────────────────────
defineJob({
  name: "sampleRollup.hourly",
  intervalMs: HOURLY_INTERVAL_MS,
  firstRunDelayMs: HOURLY_BOOT_DELAY_MS,
  run: runHourly,
});

// Daily tier: anchored at 02:30 UTC, then every 24 h from there — plus one
// catch-up pass shortly after boot. The boot pass goes through the same
// handle, so it shares the overlap skip with the anchored schedule.
const daily = defineJob({
  name: "sampleRollup.daily",
  intervalMs: 24 * 3600 * 1000,
  firstRunDelayMs: msUntilNextUtc(2, 30),
  intervalAfterFirstRun: true,
  run: runDaily,
});
setTimeout(() => void daily.tick(), DAILY_BOOT_DELAY_MS);
