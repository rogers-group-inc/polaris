/**
 * src/services/discoveryCancelWatchdog.ts — force-exit backstop for discovery
 * cancellation.
 *
 * The X (abort) on a running discovery sets `cancelRequested` on the
 * DiscoveryRun row; the worker polls it and fires its local AbortController.
 * Every HTTP transport under discovery observes that signal (fgRequest,
 * FMG rpc, geocoder), but non-HTTP awaits — most notably the per-device DB
 * sync — can wedge indefinitely on something the signal can't reach (e.g. a
 * Prisma query blocked on a Postgres lock has no statement timeout and never
 * looks at the signal). A wedged run keeps heartbeating (the 60s liveness
 * timer runs on the event loop, which is healthy), so the stale-run reaper
 * never clears it either: prod incident 2026-07-20, one FortiGate held a run
 * "running" for 5+ hours with cancel requested.
 *
 * This watchdog is the escalation path: armed when the run's abort signal
 * fires, disarmed when runDiscovery reaches its finally block. If the run
 * has not unwound within the grace period, the process is not going to
 * recover on its own — so the watchdog:
 *
 *   1. logs which devices were still in-flight and for how long (the
 *      diagnostics to pin the wedge point post-mortem),
 *   2. finalizes the DiscoveryRun row as `aborted` (so the UI clears
 *      immediately instead of waiting for the reaper),
 *   3. writes an `integration.discover.force_exit` Event,
 *   4. exits the process with code 1.
 *
 * systemd (`Restart=on-failure`, polaris-discovery.service) restarts
 * the process within seconds — the same exit-and-let-the-service-manager-
 * cycle-us pattern the operator /restart endpoint and the agent cert-pin
 * reload already use. If pg-boss redelivers the interrupted job, runDiscovery
 * sees `cancelRequested` still set at startup and aborts cleanly.
 *
 * Because the wedge may BE the database, the pre-exit bookkeeping writes are
 * each raced against a short timeout — the exit must not be blocked by the
 * same hang it exists to break.
 *
 * Single-process note: under POLARIS_ROLE=all (or a web-hosted cursor-mode
 * fallback run) the exit takes down the whole app, not just discovery. That
 * matches the operator /restart endpoint's semantics, and the operator has
 * already asked for the run to die (cancel + grace elapsed).
 */

import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { finishRun } from "./discoveryRunState.js";

/** How long after abort the run gets to unwind on its own. */
export const CANCEL_FORCE_EXIT_GRACE_MS = 2 * 60 * 1000;

/** Cap on each pre-exit bookkeeping write (the DB may be the wedge). */
export const FORCE_EXIT_CLEANUP_TIMEOUT_MS = 5_000;

export interface ActiveDeviceSnapshot {
  name: string;
  /** Epoch ms the device's discovery started. */
  startedAtMs: number;
}

export interface CancelWatchdogOptions {
  integrationId: string;
  integrationName: string;
  actor: string;
  /** The run's abort signal — arming trigger. */
  signal: AbortSignal;
  /** Live view of the run's in-flight devices (for the wedge diagnostics). */
  getActiveDevices: () => ActiveDeviceSnapshot[];
  graceMs?: number;
  // ── Test seams (default to the real implementations) ────────────────────
  finalizeRun?: typeof finishRun;
  writeEvent?: typeof logEvent;
  exit?: (code: number) => void;
}

/** Render the in-flight device list as "NAME (in flight 312.4 min)". */
export function formatStuckDevices(devices: ActiveDeviceSnapshot[], nowMs: number): string {
  if (devices.length === 0) return "(no devices in flight — wedged outside the per-device loop)";
  return devices
    .map((d) => `${d.name} (in flight ${((nowMs - d.startedAtMs) / 60_000).toFixed(1)} min)`)
    .join(", ");
}

/** Resolve after `promise` settles or `ms` elapses, whichever comes first. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise.catch(() => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Arm the watchdog for one discovery run. Returns the disarm function —
 * runDiscovery MUST call it in its finally block; a disarmed watchdog never
 * fires. Arming is lazy: the grace timer only starts when (and if) the abort
 * signal fires.
 */
export function armDiscoveryCancelWatchdog(opts: CancelWatchdogOptions): () => void {
  const graceMs = opts.graceMs ?? CANCEL_FORCE_EXIT_GRACE_MS;
  const finalizeRun = opts.finalizeRun ?? finishRun;
  const writeEvent = opts.writeEvent ?? logEvent;
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  let graceTimer: NodeJS.Timeout | undefined;
  let disarmed = false;

  const escalate = async (): Promise<void> => {
    if (disarmed) return;
    const stuck = formatStuckDevices(opts.getActiveDevices(), Date.now());
    logger.error(
      {
        integrationId: opts.integrationId,
        integrationName: opts.integrationName,
        graceMs,
        activeDevices: opts.getActiveDevices(),
      },
      `Discovery cancel not honored within ${Math.round(graceMs / 1000)}s — run is wedged on an await the abort signal cannot reach (likely a blocked DB query). Stuck: ${stuck}. Force-exiting so the service manager restarts the process.`,
    );
    await settleWithin(
      writeEvent({
        action: "integration.discover.force_exit",
        resourceType: "integration",
        resourceId: opts.integrationId,
        resourceName: opts.integrationName,
        actor: opts.actor,
        level: "error",
        message: `[${opts.integrationName}] Cancel was not honored within ${Math.round(graceMs / 1000)}s — force-restarting the discovery process. Stuck: ${stuck}`,
      }),
      FORCE_EXIT_CLEANUP_TIMEOUT_MS,
    );
    await settleWithin(finalizeRun(opts.integrationId, "aborted"), FORCE_EXIT_CLEANUP_TIMEOUT_MS);
    exit(1);
  };

  const onAbort = () => {
    if (disarmed || graceTimer) return;
    graceTimer = setTimeout(() => { void escalate(); }, graceMs);
  };

  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener("abort", onAbort, { once: true });

  return () => {
    disarmed = true;
    if (graceTimer) clearTimeout(graceTimer);
    opts.signal.removeEventListener("abort", onAbort);
  };
}
