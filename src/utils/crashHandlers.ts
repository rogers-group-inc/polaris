/**
 * src/utils/crashHandlers.ts — process-level last-resort crash handlers
 *
 * Node 20+ defaults to `--unhandled-rejections=throw`, and the units run a
 * bare `node dist/index.js`, so any promise rejection that escapes its own
 * handling terminates the process. The codebase is disciplined about this
 * (logEvent swallows internally, every job tick is wrapped, the fire-and-forget
 * prisma writes carry `.catch`) — but "disciplined in 322 files" is not a
 * guarantee, and without a handler the only artifact of a crash is Node's raw
 * stack trace on stderr: no pino line, no role label, no metric. systemd's
 * `Restart=on-failure` then brings the process straight back, so a repeating
 * crash is invisible outside journald.
 *
 * These handlers do NOT keep the process alive. Continuing after an unhandled
 * rejection means running with unknown invariants (a half-applied transaction,
 * a monitor worker that lost its lease), which is worse than a restart. They
 * exist to make the crash *legible*: one structured fatal log naming the role
 * and the origin, one counter increment so Grafana can show a restart loop,
 * then exit non-zero so systemd / the container orchestrator does its job.
 *
 * Idempotent: installCrashHandlers() is safe to call more than once (the setup
 * wizard path and the app path both boot through src/index.ts).
 */

import { logger } from "./logger.js";
import { recordProcessCrash, type CrashKind } from "../metrics.js";

let installed = false;

/**
 * Exit code for a crash-induced exit. Distinct from the `1` used by the
 * boot-time configuration guards in index.ts so journald / an orchestrator's
 * exit-code history can tell "misconfigured, will never start" apart from
 * "was running, then died".
 */
export const CRASH_EXIT_CODE = 70;

function onCrash(kind: CrashKind, err: unknown): void {
  const role = process.env.POLARIS_ROLE || "all";
  try {
    recordProcessCrash(role, kind);
  } catch {
    /* metrics must never mask the crash we are trying to report */
  }
  try {
    logger.fatal(
      { err, role, kind, pid: process.pid },
      kind === "unhandled_rejection"
        ? "unhandled promise rejection — exiting so the supervisor restarts this role"
        : "uncaught exception — exiting so the supervisor restarts this role",
    );
  } catch {
    // Logger itself is broken (transport gone, EPIPE on stdout). Fall back to
    // the one channel that is always there, so the crash is never silent.
    try {
      console.error(`[polaris] FATAL ${kind} (role=${role}):`, err);
    } catch {
      /* nothing left to try */
    }
  }
  // Give pino's async transport a tick to flush, then hard-exit. process.exit
  // inside the same tick can truncate the fatal line we just wrote.
  setTimeout(() => process.exit(CRASH_EXIT_CODE), 100).unref();
}

export function installCrashHandlers(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason) => {
    onCrash("unhandled_rejection", reason);
  });

  process.on("uncaughtException", (err) => {
    onCrash("uncaught_exception", err);
  });
}

/**
 * Test seam — resets the install guard so a test can assert the handlers are
 * registered without leaking listeners across files. Not used at runtime.
 */
export function _resetForTests(): void {
  installed = false;
  process.removeAllListeners("unhandledRejection");
  process.removeAllListeners("uncaughtException");
}
