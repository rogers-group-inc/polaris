/**
 * src/utils/pathCheckStale.ts — when a path-check source's latest result has
 * stopped speaking for the present (business rule 85(a)).
 *
 * A source row keeps `lastOk` from its last run forever. Once the host stops
 * running the check — its agent is offline, or no run has landed for a while
 * (agent stopped, check paused, the server job not running) — that verdict is
 * history, and every surface shows it as Stale instead of OK / Fail.
 *
 * Agents push their path-check batch every 60 s tick, so a source that is
 * running is never more than one interval behind; three intervals plus a
 * two-minute grace absorbs a skipped tick and a slow push.
 */

/** Is the agent live right now? A WS session is the strong signal; a recent
 *  bearer call is the fallback when the WS is blocked by a proxy. */
export function agentOnline(a: { wsConnectedAt: Date | null; wsDisconnectedAt: Date | null; lastSeenAt: Date | null }, now = Date.now()): boolean {
  if (a.wsConnectedAt && (!a.wsDisconnectedAt || a.wsConnectedAt > a.wsDisconnectedAt)) return true;
  return !!a.lastSeenAt && now - a.lastSeenAt.getTime() < 10 * 60_000;
}

export const STALE_AFTER_INTERVALS = 3;
export const STALE_GRACE_MS = 2 * 60_000;

/** Why a result is stale: the agent host is offline, or no run has landed in time. */
export type PathResultStaleReason = "offline" | "late";

/** The newest `lastSampleAt` a source on a check of this interval may have and still be current. */
export function pathResultStaleCutoff(intervalSec: number, now: number = Date.now()): Date {
  const sec = Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : 60;
  return new Date(now - (STALE_AFTER_INTERVALS * sec * 1000 + STALE_GRACE_MS));
}

/**
 * Null when the latest result is current (or there is none yet — "no result
 * yet" is its own state); otherwise why it is stale. `online` is the agent's
 * liveness; the Polaris server source passes `true`, so only its age counts.
 */
export function pathResultStaleReason(
  source: { lastSampleAt: Date | string | null | undefined; online: boolean },
  intervalSec: number,
  now: number = Date.now(),
): PathResultStaleReason | null {
  if (!source.lastSampleAt) return null;
  if (!source.online) return "offline";
  const at = new Date(source.lastSampleAt).getTime();
  if (!Number.isFinite(at)) return null;
  return at < pathResultStaleCutoff(intervalSec, now).getTime() ? "late" : null;
}
