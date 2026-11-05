/**
 * src/jobs/_defineJob.ts — the one shape of a periodic background job (CQ-B041).
 *
 *   defineJob({
 *     name: "detectDuplicateIpAssets",   // metric label + log field
 *     intervalMs: 10 * 60 * 1000,
 *     firstRunDelayMs: 45_000,           // 0 = run at import; omit = first run after one interval
 *     run: async () => { ... },
 *   });
 *
 * Before this every periodic job hand-rolled the same five things — a
 * setTimeout for the first run, a setInterval, a try/catch, a
 * runInstrumentedJob wrapper, and (in about a third of them) a `running` flag —
 * and logged a failed tick in six different payload shapes, a third of which
 * kept only `err.message` and so lost the stack. defineJob owns all of it:
 *
 *   - schedule: optional first-run delay, then a fixed interval;
 *   - metrics: `polaris_job_duration_seconds{job}` + `polaris_job_total{job,outcome}`
 *     through runInstrumentedJob, exactly as before;
 *   - overlap: a tick still running when the next fires is SKIPPED, never run
 *     twice concurrently (a slow pass on a big fleet used to stack up in the
 *     jobs that had no guard);
 *   - errors: a failed tick is logged once, at ERROR, as `{ err, job }` (pino
 *     keeps the stack) and the next tick runs as normal — one level and one
 *     shape for every job (operator decision 2026-11-05). `onError` replaces
 *     that for a job whose failure needs its own handling.
 *
 * Role gating is unchanged: src/app.ts imports a job module only in the role
 * that should run it, and the module's top-level defineJob call starts it.
 *
 * NOT for one-shot boot jobs (the migrate* / seed* / backfill* / clamp*
 * family): those run once and use _runOnce.ts.
 */

import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";

interface JobSpec {
  /** Metric label and log field; the job's file name by convention. */
  name: string;
  /** Fixed cadence between tick starts. */
  intervalMs: number;
  /** First tick after this many ms; 0 runs it at import; omitted waits one interval. */
  firstRunDelayMs?: number;
  /**
   * Start the interval when the first run fires, so ticks land at
   * delay + n × interval (the discovery scheduler: 5 min, then every 15 min
   * from THERE). Default false: the interval starts at definition, independent
   * of the first-run delay. Needs firstRunDelayMs.
   */
  intervalAfterFirstRun?: boolean;
  /** One tick. Throwing is fine — it is logged and the next tick runs. */
  run: () => Promise<void>;
  /** Replaces the default failure log for a job that needs its own handling. */
  onError?: (err: unknown) => void;
}

interface JobHandle {
  /** Run one tick now (skipped if one is in flight). For tests and manual triggers. */
  tick: () => Promise<void>;
  /** Cancel the schedule. A tick already running finishes. */
  stop: () => void;
}

export function defineJob(spec: JobSpec): JobHandle {
  let running = false;
  const onError = spec.onError ?? ((err: unknown) => {
    logger.error({ err, job: spec.name }, `${spec.name} tick failed`);
  });

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      await runInstrumentedJob(spec.name, spec.run);
    } catch (err) {
      onError(err);
    } finally {
      running = false;
    }
  }

  let first: NodeJS.Timeout | null = null;
  let interval: NodeJS.Timeout | null = null;
  const startInterval = () => { interval = setInterval(tick, spec.intervalMs); };
  if (spec.intervalAfterFirstRun && spec.firstRunDelayMs !== undefined) {
    first = setTimeout(() => { first = null; startInterval(); void tick(); }, spec.firstRunDelayMs);
  } else {
    if (spec.firstRunDelayMs === 0) void tick();
    else if (spec.firstRunDelayMs !== undefined) first = setTimeout(tick, spec.firstRunDelayMs);
    startInterval();
  }

  return {
    tick,
    stop() {
      if (first) clearTimeout(first);
      if (interval) clearInterval(interval);
    },
  };
}
