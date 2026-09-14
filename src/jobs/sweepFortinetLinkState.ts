/**
 * src/jobs/sweepFortinetLinkState.ts
 *
 * Periodic controller-link sweep for FortiGate-managed FortiSwitches and
 * FortiAPs (business rule 58): asks each controller FortiGate whether it still
 * has a FortiLink session / CAPWAP tunnel to each device it manages, and
 * projects the answer onto `Asset.fortilinkStatus`. The whole decision set —
 * the three refusals, the normalization, the batched writes — lives in
 * services/fortinetLinkStateService.ts.
 *
 * Why a job and not part of the monitor loop: the monitor loop asks the
 * DEVICE, on the transport the operator chose. That is structurally unable to
 * see this fault, because a switch with a dead FortiLink session answers ICMP
 * and SNMP perfectly well. Only the controller knows, and the controller is a
 * different target on a different cadence with a different failure mode — so
 * it gets its own tick rather than a fifth cadence inside `monitorAssets`.
 *
 * Cadence: 60s, matching the default probe interval so the link column and the
 * monitor column describe the same minute. Cost is bounded by CONTROLLER
 * count, not fleet size — at most two calls per controller per tick (switches
 * + APs), whether it manages 3 devices or 300. Where the REST probe path is
 * already reading the same controller the two coalesce through
 * monitoringService's shared 30s inventory cache, but only when their
 * independent 60s timers land in the same window: budget ~1.5 calls per minute
 * per kind on those controllers, not 1.
 *
 * `POLARIS_FORTILINK_SWEEP_SEC` raises the interval for installs where that
 * rate is too much for the transport. The case to watch is FMG PROXY mode,
 * which serializes at concurrency 1: a 50-gate fleet is 100 proxied calls per
 * minute there, against ~650ms each. Direct mode (useProxy=false) and
 * standalone FortiGate integrations talk to each gate independently and do not
 * have this ceiling. Floor of 30s so an operator cannot set a cadence below
 * the inventory cache's own TTL, which would just miss the cache.
 *
 * Scheduler role only — one sweep for the fleet, not one per monitor replica.
 * A second replica sweeping would double the upstream rate against exactly the
 * controllers this is designed not to overrun.
 */

import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import { sweepFortinetLinkState } from "../services/fortinetLinkStateService.js";

const DEFAULT_INTERVAL_SEC = 60;
const MIN_INTERVAL_SEC = 30;

function resolveIntervalMs(): number {
  const raw = Number(process.env.POLARIS_FORTILINK_SWEEP_SEC);
  const sec = Number.isFinite(raw) && raw > 0 ? Math.max(MIN_INTERVAL_SEC, raw) : DEFAULT_INTERVAL_SEC;
  return sec * 1000;
}

// Delayed first run: discovery stamps `fortinetTopology.controllerFortigate`,
// which is how the sweep learns which controller to ask, and at boot a fresh
// install has not run discovery yet. A pass before then simply finds no groups
// and does nothing — the delay just keeps the startup log quiet.
const FIRST_RUN_DELAY_MS = 45_000;

async function tick(): Promise<void> {
  try {
    await runInstrumentedJob("sweepFortinetLinkState", async () => {
      await sweepFortinetLinkState();
    });
  } catch (err) {
    logger.error({ err }, "fortinet controller link sweep failed");
  }
}

setTimeout(tick, FIRST_RUN_DELAY_MS);
setInterval(tick, resolveIntervalMs());
