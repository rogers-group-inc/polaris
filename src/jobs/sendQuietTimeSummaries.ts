/**
 * src/jobs/sendQuietTimeSummaries.ts
 *
 * Every 60 s: create the quiet-time summaries that have come due (a quiet
 * window ended, its send time arrived) and email the pending ones
 * (business rule 92). Web/all role only (imported under runsSchedulers), like
 * the three notification jobs it sits beside — the summaries are the other
 * half of a hold the engine took on this same role. Best-effort: a failed
 * tick logs and retries next interval; per-recipient failures are retried by
 * the service itself (≤ SUMMARY_MAX_ATTEMPTS).
 *
 * Import this module from src/app.ts (startBackgroundJobs) to activate it.
 */

import { logger } from "../utils/logger.js";
import { runQuietTimeSummaries } from "../services/quietTimeSummaryService.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 60 * 1000;
let running = false;

async function tick(): Promise<void> {
  if (running) return; // an SMTP stall must not stack ticks
  running = true;
  try {
    await runInstrumentedJob("sendQuietTimeSummaries", async () => {
      await runQuietTimeSummaries();
    });
  } catch (err: any) {
    logger.warn({ err: err?.message }, "sendQuietTimeSummaries job failed (non-fatal)");
  } finally {
    running = false;
  }
}

// Boot delay so the DB is ready; offset from the escalation tick.
setTimeout(tick, 50_000);
setInterval(tick, INTERVAL_MS);
