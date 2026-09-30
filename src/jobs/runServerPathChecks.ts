/**
 * src/jobs/runServerPathChecks.ts
 *
 * Runs every path check whose Sources include THIS POLARIS SERVER
 * (PathCheck.runOnServer) from the server itself, on each check's own
 * interval, and writes the result through the agent's ingest under the
 * reserved subject POLARIS_SERVER_SUBJECT.
 *
 * SCHEDULER ROLE ONLY (web / all). "The Polaris server" must be ONE vantage
 * point: a monitor replica per host would multiply the traffic and interleave
 * several hosts' paths into one series that then "changes path" every run. The
 * scheduler role is the single-instance one (activeInstanceHeartbeat), and it
 * runs the write buffers the samples flush through.
 *
 * CADENCE. A 15 s tick checks what is due — the agent's due / traceroute rules
 * (cmd/polaris-agent/path_check.go), mirrored as pure helpers in
 * pathCheckServerRunner (serverCheckDue / serverTraceMode / pruneServerStates): a
 * check runs when its interval has elapsed (5 s slack), the first run under a
 * definition traces (the baseline), then every Nth, and a run after a PASS
 * traces if it fails (the pass→fail transition). State is in memory; a restart
 * re-baselines, as an agent restart does.
 *
 * Runs are launched without awaiting the tick, at most MAX_IN_FLIGHT at once,
 * one per check, so a 30 s traceroute never delays another check's run.
 *
 * A check with a credential authenticates from here and ONLY from here — it
 * has no agent sources (pathCheckService), so the secret never leaves the
 * server.
 *
 * At the fleet-wide cap of 50 enabled checks that is ≤ 1 definition query per
 * tick plus 1–2 small ingest statements per run — independent of fleet size.
 *
 * Import this module from src/app.ts to activate.
 */

import { logger } from "../utils/logger.js";
import { serverCheckDefinitions, loadServerCheckAuth, POLARIS_SERVER_SUBJECT, type ServerCheckDef } from "../services/pathCheckService.js";
import { ingestPathCheckSamples, ingestPathCheckTraceroutes } from "../services/pathCheckIngestService.js";
import {
  runServerCheck,
  serverCheckDue,
  serverTraceMode,
  pruneServerStates,
  type ServerCheckState,
  type TraceMode,
} from "../services/pathCheckServerRunner.js";
import { runInstrumentedJob } from "./_metrics.js";

const TICK_MS = 15 * 1000;
const BOOT_DELAY_MS = 60 * 1000;
/** Runs in flight at once (the agent's worker count). */
const MAX_IN_FLIGHT = 4;

let states = new Map<string, ServerCheckState>();
const inFlight = new Set<string>();
let ticking = false;

async function runOne(def: ServerCheckDef, st: ServerCheckState, mode: TraceMode): Promise<void> {
  try {
    // Opened per run, never cached: a rotated password takes effect on the
    // next run, and the plaintext lives only for the length of one request.
    const auth = await loadServerCheckAuth(def.credentialId);
    const { sample, trace } = await runServerCheck(def, mode, undefined, undefined, auth);
    st.lastOk = sample.ok;
    await ingestPathCheckSamples(POLARIS_SERVER_SUBJECT, [sample], new Date());
    if (trace) await ingestPathCheckTraceroutes(POLARIS_SERVER_SUBJECT, [trace], new Date());
  } catch (err: any) {
    logger.warn({ err: err?.message ?? String(err), checkId: def.id }, "server path check run failed (non-fatal)");
  } finally {
    inFlight.delete(def.id);
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await runInstrumentedJob("pathCheck.serverRun", async () => {
      const defs = await serverCheckDefinitions();
      states = pruneServerStates(states, defs);
      const now = Date.now();
      const due = defs
        .filter((d) => !inFlight.has(d.id) && serverCheckDue(states.get(d.id), d, now))
        .sort((a, b) => (states.get(a.id)?.lastRunAt ?? 0) - (states.get(b.id)?.lastRunAt ?? 0));
      for (const def of due) {
        if (inFlight.size >= MAX_IN_FLIGHT) break;
        const st = states.get(def.id)!;
        const mode = serverTraceMode(st, def);
        // Stamped at START so due-ness never drifts with how long a run took.
        st.lastRunAt = now;
        st.runCount++;
        inFlight.add(def.id);
        void runOne(def, st, mode);
      }
    });
  } catch (err: any) {
    logger.error({ err: err?.message ?? String(err) }, "pathCheck.serverRun tick failed (non-fatal)");
  } finally {
    ticking = false;
  }
}

setTimeout(tick, BOOT_DELAY_MS);
setInterval(tick, TICK_MS);
