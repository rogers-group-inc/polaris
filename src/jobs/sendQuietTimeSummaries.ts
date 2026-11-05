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

import { runQuietTimeSummaries } from "../services/quietTimeSummaryService.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 60 * 1000;
// Boot delay so the DB is ready; offset from the escalation tick. defineJob's
// overlap skip is what keeps an SMTP stall from stacking ticks.
defineJob({
  name: "sendQuietTimeSummaries",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 50_000,
  run: async () => {
    await runQuietTimeSummaries();
  },
});
