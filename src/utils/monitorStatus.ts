/**
 * src/utils/monitorStatus.ts
 *
 * The monitor state vocabulary and the pure predicates that read it. Lives in
 * utils (like probeLossAnchor) so the state machine, the probe-patch buffer,
 * the two due-set builders and the tests can all share ONE definition — the
 * union used to be spelled out in three places, which is how a sixth state gets
 * added to two of them.
 *
 * The six states:
 *
 *   up          — no missed polls outstanding: the bucket has drained to zero
 *   warning     — a MISSED poll with the bucket still below the threshold.
 *                 Operator-facing label is "Missed" (MONITOR_STATUS_LABELS) —
 *                 "Warning" collided with the alert severity of the same name,
 *                 so a pill reading Warning looked like a fired alert rather
 *                 than a missed poll. The stored value is unchanged.
 *   down        — a MISSED poll with the bucket at or above `missedPolls`, per
 *                 the covering automation. The bucket LOCKS at its cap here, so
 *                 recovery costs what the operator asked for rather than what
 *                 the outage's length happened to accrue (`nextFailureBucket`).
 *   recovering  — an ANSWERED poll with misses still outstanding. Reachable
 *                 straight out of `down` as well as out of `warning`: it means
 *                 "climbing back", not "was down".
 *   unknown     — nothing measured yet
 *   passive     — NOT a probe outcome. No down-detection automation covers this
 *                 device, so Polaris renders no verdict about it. It is still
 *                 polled and still charted; the counters still advance. See
 *                 downDetectionService.
 */

export type MonitorStatus = "up" | "warning" | "recovering" | "down" | "unknown" | "passive";

/** The states reachable by probing — i.e. everything except the config state. */
export const PROBE_MONITOR_STATUSES: readonly MonitorStatus[] = ["up", "warning", "recovering", "down", "unknown"];

/**
 * Operator-facing label for each state. ONE map so the assets pill, the search
 * hit pill, the alert-email trigger summary and the dashboard status tiles can
 * never disagree about what a state is called.
 *
 * `warning` reads "Missed" and `unknown` reads "Pending": both names describe
 * what the device did rather than the enum value, and "Warning" in particular
 * had to go — it is also an alert severity, so operators read the pill as
 * "an alert fired" when it only ever meant "a poll was missed".
 */
export const MONITOR_STATUS_LABELS: Record<MonitorStatus, string> = {
  up: "Up",
  warning: "Missed",
  recovering: "Recovering",
  down: "Down",
  unknown: "Pending",
  passive: "Passive",
};

/** Label for a raw status string; unrecognized values pass through unchanged. */
export function monitorStatusLabel(status: string | null | undefined): string {
  if (!status) return MONITOR_STATUS_LABELS.unknown;
  return (MONITOR_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

/**
 * Should the heavy cadences (telemetry / system info / interfaces / storage /
 * LLDP / processes) run for this asset?
 *
 * "up" is positive evidence the device is reachable, and that has always been
 * the gate. A PASSIVE device has no verdict to consult — but it is still being
 * polled, and its charts are supposed to keep filling, so falling back to the
 * raw signal we do have keeps the data flowing without pointing full SNMP walks
 * at a passive host that is currently dark.
 *
 * That raw signal is `consecutiveFailures === 0`, which since the leaky-bucket
 * change (business rule 30) reads "no missed polls outstanding" rather than
 * "the last probe succeeded" — a strictly stronger claim, and the right one
 * here: a device three misses deep that has answered once is still not somewhere
 * to point a full walk.
 *
 * Shared by the cursor pass (monitoringService.loadMonitorPassCandidates) and
 * the pg-boss publisher (jobs/monitorAssets) — two implementations that are
 * documented to stay in lockstep, which is exactly why this predicate is one
 * function rather than two copies of an `=== "up"` comparison.
 */
export function runsHeavyCadences(a: {
  monitorStatus: string | null;
  consecutiveFailures?: number | null;
  dependencySuppressed: boolean;
}): boolean {
  if (a.dependencySuppressed) return false;
  if (a.monitorStatus === "up") return true;
  // `recovering` always carries cf > 0 now that the automation's reset count is
  // served by the bucket's own drain rather than by a separate hold at cf 0
  // (the `owesRecoveryConfirmation` arrow this replaced). The test is kept
  // rather than collapsed to `false` because it states the actual rule — an
  // asset with misses outstanding is not somewhere to point a full SNMP walk —
  // and it stays correct if a later state ever reaches cf 0 while recovering.
  if (a.monitorStatus === "recovering") return (a.consecutiveFailures ?? 0) === 0;
  return a.monitorStatus === "passive" && (a.consecutiveFailures ?? 0) === 0;
}

/**
 * Is a probe that was published as DUE still due when a worker picks it up?
 *
 * The pg-boss publisher re-evaluates every 5 s, and the probe queue's stately
 * policy absorbs a duplicate only while the earlier job is still QUEUED. Once
 * that job is ACTIVE, a second one queues behind it. A batched ICMP chunk runs
 * as long as its slowest target (a single dead host holds it for the full
 * probe timeout), and `lastMonitorAt` is only stamped when the readings are
 * recorded, so the next tick still saw the whole chunk as due and queued it
 * again. The duplicate ran seconds later, which charted every reading twice and
 * counted every miss twice toward the covering automation's `missedPolls`
 * (business rules 30 and 36).
 *
 * The re-check at pickup is the publisher's own `isDue` arithmetic, run against
 * the freshest stamp we can see. `pendingLastMonitorAt` is the probe-patch
 * buffer's unflushed value: the queued duplicate activates within about a second
 * of the first job finishing, before the 2 s flush has reached the row.
 *
 * `intervalSec` absent means a job published before the interval rode the
 * payload, or a caller that is not the cadence (the operator's Probe Now). Both
 * mean "do not second-guess this job", so the answer is true.
 */
export function probeStillDue(
  lastMonitorAt: Date | null | undefined,
  intervalSec: number | null | undefined,
  now: Date,
  pendingLastMonitorAt?: Date | null,
): boolean {
  if (intervalSec == null || !Number.isFinite(intervalSec) || intervalSec <= 0) return true;
  let freshest: number | null = null;
  for (const d of [lastMonitorAt, pendingLastMonitorAt]) {
    if (d instanceof Date && !Number.isNaN(d.getTime()) && (freshest === null || d.getTime() > freshest)) {
      freshest = d.getTime();
    }
  }
  if (freshest === null) return true;
  return now.getTime() - freshest >= intervalSec * 1000;
}

/**
 * The ceiling the missed-poll bucket may ever reach.
 *
 * The bucket was UNBOUNDED until 2026-09-01, and that was the whole of the
 * recovery bug: a device dark overnight at a 60 s cadence reached cf ≈ 480, and
 * because a success only ever takes ONE back, it then had to answer 480 probes
 * — eight hours — before it read `up` again. Its down alert holds through
 * `down`/`recovering`/`warning` (DOWN_ALERT_HOLDING_STATES), so that alert kept
 * repeating and escalating for eight hours after the device demonstrably came
 * back. Recovery cost has to be bounded by what the operator ASKED for, never
 * by how long the outage happened to run.
 *
 * Covered assets cap at their own automation's number (see `bucketCapFor`);
 * this constant is the passive ceiling and the absolute ceiling behind it. It
 * matches the `missedPolls` / recovery-poll maximum in notificationTypes, so no
 * covered asset can ever be capped by this value rather than by its rule.
 */
export const MAX_MISSED_POLL_BUCKET = 100;

/**
 * The bucket level an asset sits at once it is DOWN — and therefore how many
 * answered polls it owes before it reads `up` again.
 *
 * `threshold` misses is what DECLARES the outage; `recoveryPolls` is what ENDS
 * it. Taking the max of the two makes the drain itself serve the operator's
 * reset count, which is why `owesRecoveryConfirmation` and the
 * `Asset.awaitingRecoveryConfirm` bit it read are no longer part of the state
 * machine — the ambiguity that stored bit existed to resolve (at cf 0, a
 * success run of N could be a drained bucket or a healthy device) cannot arise
 * when the bucket carries the whole debt.
 *
 * `null` threshold is the PASSIVE device: no automation defines down for it, so
 * there is no rule-supplied number and the ceiling is the constant. The bucket
 * still moves for a passive asset — it is an automatable `asset_state` field,
 * it is what lets a surface say "passive and dark" vs "passive and answering",
 * and keeping it warm means an asset that LATER gains coverage converges on its
 * next probe instead of restarting from zero.
 */
export function bucketCapFor(threshold: number | null, recoveryPolls: number): number {
  if (threshold === null) return MAX_MISSED_POLL_BUCKET;
  const rec = Number.isFinite(recoveryPolls) && recoveryPolls > 0 ? Math.floor(recoveryPolls) : 0;
  return Math.min(MAX_MISSED_POLL_BUCKET, Math.max(threshold, rec));
}

/**
 * The next bucket level after one probe.
 *
 * A miss adds one; an answer takes one back, floored at 0 — still the leaky
 * bucket of business rule 30, and still not a run length, because forgetting an
 * outage on one lucky packet is what let an alternating device never reach a
 * verdict in either direction.
 *
 * What is new is the LOCK. The moment a miss carries the level to the
 * threshold, the bucket jumps straight to the cap and stays there for every
 * further miss. Two things fall out of that, both of them the point:
 *
 *   • Recovery is bounded and deterministic. A device that has been down for
 *     four minutes and one that has been down for four days both owe exactly
 *     `cap` answered polls, which is the number the operator wrote down.
 *   • The reset count is served by the drain. `cap` is max(threshold,
 *     recoveryPolls), so "down after 3 missed, up after 5 received" jumps to 5
 *     on the third miss and drains 5→4→3→2→1→0 across five answers.
 *
 * Pure, and mirrored in public/js/monitor-states.js (browser) and
 * probeOutageService.replayProbeStates (server-side chart replay). Those two
 * cannot import this — one is a no-build-step browser file, the other is kept
 * deliberately dependency-free — so a parity test pins them instead.
 */
export function nextFailureBucket(
  consecutiveFailures: number,
  success: boolean,
  threshold: number | null,
  recoveryPolls: number,
): number {
  const cf = Math.max(0, consecutiveFailures || 0);
  const cap = bucketCapFor(threshold, recoveryPolls);
  if (success) return Math.max(0, Math.min(cap, cf) - 1);
  const raised = Math.min(cap, cf + 1);
  // The verdict miss and every miss after it sit at the cap: once an outage is
  // declared, further misses tell us nothing new about how long recovery should
  // take, and letting them accrue is what made an overnight outage unrecoverable.
  if (threshold !== null && raised >= threshold) return cap;
  return raised;
}

/**
 * The state one probe leaves the asset in, given the bucket level AFTER that
 * probe.
 *
 * THE LEVEL DECIDES WHAT A MISS MEANS; THE OUTCOME DECIDES EVERYTHING ELSE:
 *
 *   passive (no threshold)         → passive
 *   cf === 0                       → up
 *   this probe ANSWERED            → recovering
 *   this probe missed, cf >= thr   → down
 *   this probe missed, cf <  thr   → warning  (operator-facing "Missed")
 *
 * The answered branch is unconditional as of 2026-09-01. It used to sit BELOW
 * the threshold test, so an answered probe taken while the bucket was still at
 * or above the threshold read `down` — correct for a verdict, but it meant the
 * response-time chart drew those probes in the plain series green (its point
 * colouring has no way to paint an `ok` point red), so an outage read
 * red → green → blue → green and looked like the device had recovered twice.
 * With the bucket locked, every answered probe during an outage is genuinely
 * the device climbing back, and `recovering` is the word for that. It does not
 * clear the alert early: DOWN_ALERT_HOLDING_STATES holds a down alert through
 * `recovering` and `warning`, so the alert still ends only at `up`.
 */
export function monitorStatusFor(
  consecutiveFailures: number,
  success: boolean,
  threshold: number | null,
): MonitorStatus {
  if (threshold === null) return "passive";
  const cf = Math.max(0, consecutiveFailures || 0);
  if (cf === 0) return "up";
  if (success) return "recovering";
  return cf >= threshold ? "down" : "warning";
}

/**
 * Is entering or leaving this pair of states a CONFIGURATION edge rather than a
 * device edge? Passive is entered and left when an operator saves, rescopes or
 * deletes a down-detection automation — never because the device did anything.
 *
 * The distinction is load-bearing: one rule edit can move thousands of assets
 * across that line at once, and treating it as a device transition would burst
 * one `monitor.status_changed` Event and one dependency propagation per asset.
 * The rule-CRUD audit trail already records the cause.
 */
export function isConfigStatusEdge(previous: string | null, next: MonitorStatus): boolean {
  return previous === "passive" || next === "passive";
}
