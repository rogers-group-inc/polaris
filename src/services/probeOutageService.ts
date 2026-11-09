/**
 * src/services/probeOutageService.ts
 *
 * "When was this device unreachable?", answered from the response-time probe
 * stream — for the charts of streams that have no failure record of their own.
 *
 * The heavy cadences (telemetry / hardware sensors / interfaces / storage /
 * processes) do not run while an asset is down: `runsHeavyCadences` gates them
 * on `up`, so a skipped poll leaves no row at all and there is nothing in those
 * tables to mark. The response-time probe DOES keep running in every state — it
 * is what decides whether the device is down in the first place — and it writes
 * a real `success:false` row every interval. So the authoritative record of an
 * outage already exists, in the one stream that was still measuring; the other
 * charts borrow it rather than storing a second copy.
 *
 * This replaces the 2.5x-median-cadence gap heuristic the charts used to infer
 * failures with (see UI-GUIDE section 15). That guess could not tell an outage
 * apart from a mount that was unmounted, a metric that simply isn't collected
 * on this device, or an operator widening the cadence — and it drew a red dive
 * straight through maintenance windows, which is backwards: a band means the
 * gap is explained, a dive means it isn't. Reading the probe stream gets all of
 * those right without a special case, because polling stops entirely during
 * maintenance, so a maintenance gap contains no failed probes and yields no
 * outage.
 *
 * Windows are CLASSIFIED, not merely found: a stretch whose every failure was
 * taken while the asset was dependency-suppressed comes back as
 * kind="dependency" and is drawn grey, because Polaris knows exactly why those
 * probes missed — the upstream was dark. Red is reserved for the outage nobody
 * can account for. The evidence is per-sample (AssetMonitorSample
 * .dependencyDown) rather than reconstructed from the suppression history,
 * which no table keeps.
 *
 * Deliberately NOT a write path. An earlier design wrote synthetic failure rows
 * into the telemetry/storage/interface tables so those streams would carry
 * their own flag. Rejected: those tables are read raw by the alert engine, the
 * hourly/daily rollups and the vanished-state sweep, none of which can tell a
 * real reading from a marker, and the rows would have had to invent a
 * `mountPath` / `ifName` for a poll that never ran.
 */

import { prisma } from "../db.js";
import { pickSampleTierForAsset, type SampleTier } from "./sampleQueryRouter.js";
import { MAX_MISSED_POLL_BUCKET } from "../utils/monitorStatus.js";

/**
 * Why the probes in a window failed.
 *
 *   "outage"     — nothing explains it. The device stopped answering and
 *                  Polaris does not know why. Charts draw the red dive.
 *   "dependency" — the asset was dependency-suppressed for every failure in
 *                  the window: its parent was dark, so the miss is expected.
 *                  Charts draw the same shape in grey, because the claim is
 *                  "we could not reach it THROUGH the outage upstream", not
 *                  "this device broke".
 *   "missed"     — the probes failed but the count has NOT yet reached the
 *                  covering automation's `missedPolls` (business rule 36), so
 *                  Polaris has not called the device down. Charts draw the same
 *                  shape in amber — the Last-30-min strip's "Missed" cell — and
 *                  the run turns red at the probe that crosses the threshold.
 *
 * A window is only "dependency" when EVERY failure in it was suppressed. A run
 * that starts before the parent goes down splits into an "outage" window and a
 * "dependency" one at the boundary, which is the honest reading: the first
 * misses were unexplained at the time they happened. A run that crosses the
 * missed-poll threshold splits the same way and for the same reason: the early
 * misses were not a verdict when they happened.
 *
 * Only a caller that KNOWS the threshold can produce "missed" — `readProbeOutages`
 * never does, because the charts it feeds (CPU, memory, storage, interfaces) are
 * about a reading rather than a verdict and draw one red dive either way. It
 * reaches the response-time chart through `alertChartService.failSpansFrom`,
 * which is handed the count.
 */
export type OutageKind = "outage" | "dependency" | "missed";

/** One contiguous stretch during which every response-time probe failed. */
export interface OutageWindow {
  from: Date;
  to: Date;
  kind: OutageKind;
}

/** A probe reading reduced to the only thing this module cares about. */
export interface ProbeVerdict {
  timestamp: Date;
  failed: boolean;
  /** Failure taken while the parent was dark (AssetMonitorSample.dependencyDown). */
  dependency?: boolean;
  /**
   * Failure taken while the missed-poll count was still SHORT of the covering
   * automation's threshold — a miss, not yet a verdict. Set only by callers
   * that resolved the threshold; left undefined everywhere else, which keeps
   * the window plain "outage" exactly as before.
   *
   * `dependency` outranks it: a miss the upstream explains is not being counted
   * against this device at all, so its shade of "how bad" does not apply.
   */
  belowThreshold?: boolean;
}

/**
 * Fold an ascending run of probe verdicts into contiguous failure intervals.
 *
 * `from` and `to` are the first and last FAILED probe in the run — not the
 * surrounding good samples. The chart plots a marker at each end, so a run of
 * one failure collapses to a single point (from === to) and renders as a lone
 * red dot, which is what a single missed poll is.
 *
 * `bucketSeconds` > 0 means the verdicts are rollup buckets rather than
 * individual probes, in which case the run extends to the END of its last
 * bucket — a fully-failed daily bucket describes the whole day, not the
 * instant its bucketStart names.
 *
 * `openToMs` extends a run that is STILL FAILING at the newest verdict out to
 * the end of the window, because a device that is down as the chart is drawn is
 * down up to the right edge, not up to its last poll. Only the final run
 * qualifies — a run closed by a later success ends where it ended.
 *
 * Pure and exported for the tests; the readers below and
 * alertChartService.failSpansFrom are the production callers.
 */
export function foldProbeOutages(verdicts: ProbeVerdict[], bucketSeconds = 0, openToMs?: number): OutageWindow[] {
  const windows: OutageWindow[] = [];
  let from: Date | null = null;
  let to: Date | null = null;
  let kind: OutageKind = "outage";

  const close = (stillOpen = false) => {
    if (!from || !to) return;
    let endMs = bucketSeconds > 0 ? to.getTime() + bucketSeconds * 1000 : to.getTime();
    if (stillOpen && openToMs != null) endMs = Math.max(endMs, openToMs);
    windows.push({ from, to: new Date(endMs), kind });
    from = null;
    to = null;
  };

  for (const v of verdicts) {
    if (v.failed) {
      const vKind: OutageKind = v.dependency ? "dependency" : v.belowThreshold ? "missed" : "outage";
      // A change of kind mid-run ends the window and starts a new one — the
      // parent going dark part-way through does not retroactively explain the
      // misses that came before it, and its recovery does not leave the ones
      // after it explained.
      if (from && vKind !== kind) close();
      if (!from) { from = v.timestamp; kind = vKind; }
      to = v.timestamp;
    } else {
      close();
    }
  }
  close(true);
  return windows;
}

/** One contiguous stretch of ANSWERED probes taken while missed polls were
 *  still outstanding — the climb back out of an outage. */
export interface RecoveryWindow {
  from: Date;
  to: Date;
}

/** What the Status pill would have read at each probe. The same four names the
 *  Last-30-min strip paints, and therefore the same four colours the charts
 *  draw: up green, warning amber, down red, recovering purple. */
export type ProbeDisplayState = "up" | "warning" | "down" | "recovering";

/**
 * Replay the monitor state machine over an ascending run of probe verdicts,
 * returning one display state per verdict.
 *
 * This is the leaky bucket of business rule 30 plus the recovery confirmation
 * run of business rule 36, and it is a deliberate mirror of
 * `_intermittencyStates` in `public/js/assets.js` — the browser copy the
 * Last-30-min strip and the response-time chart share. The two exist because
 * one runs on stored samples in the delivery path and one on the payload in a
 * browser; if they ever disagree, an alert email and the device page describe
 * the same probe differently, which is precisely the confusion the shared
 * vocabulary exists to prevent.
 *
 * The rules, in the order they decide:
 *
 *   cf = 0                             up
 *   this probe ANSWERED                recovering  (climbing back, misses left)
 *   missed, cf >= threshold            down        (the verdict)
 *   missed, cf <  threshold            warning     (a miss, not yet a verdict)
 *
 * THE LEVEL DECIDES WHAT A MISS MEANS; the outcome decides everything else.
 * `threshold === null` is the PASSIVE device — no automation defines down for
 * it, so nothing may ever read `down` — spelled `Infinity` rather than a second
 * loop.
 *
 * The bucket LOCKS at max(threshold, recoveryPolls) once the outage is
 * declared, which is what makes an answered probe during an outage unambiguously
 * `recovering` rather than a still-`down` reading the charts had no colour for.
 * Unbounded, an overnight outage left the bucket hundreds deep and the climb out
 * spent its first hundreds of answered probes still reading `down`.
 *
 * The bucket starts at zero: a window that opens mid-outage counts only the
 * misses it can actually see rather than inventing a debt it has no samples for.
 * Same assumption as the browser copy.
 *
 * MIRROR of `nextFailureBucket` + `monitorStatusFor` in utils/monitorStatus.ts
 * (the probe path) and of `replay` in public/js/monitor-states.js (the browser
 * charts). Nothing crosses those boundaries — this file is kept deliberately
 * dependency-free and that one is a no-build-step browser file — so a parity
 * test pins the three instead.
 */
export function replayProbeStates(
  verdicts: ProbeVerdict[],
  threshold: number | null,
  recoveryPolls = 0,
): ProbeDisplayState[] {
  const thr = threshold === null
    ? Infinity
    : Number.isFinite(threshold) && threshold >= 1 ? Math.floor(threshold) : 3;
  const rec = Number.isFinite(recoveryPolls) && recoveryPolls > 0 ? Math.floor(recoveryPolls) : 0;
  const cap = thr === Infinity ? MAX_MISSED_POLL_BUCKET : Math.min(MAX_MISSED_POLL_BUCKET, Math.max(thr, rec));
  let cf = 0;
  return verdicts.map((v) => {
    if (v.failed) {
      const raised = Math.min(cap, cf + 1);
      cf = thr !== Infinity && raised >= thr ? cap : raised;
    } else {
      cf = Math.max(0, Math.min(cap, cf) - 1);
    }
    if (cf === 0) return "up";
    if (!v.failed) return "recovering";
    return cf >= thr ? "down" : "warning";
  });
}

/**
 * The stretches where the device was answering but had not yet been handed back
 * its Up — every contiguous run of `recovering` from the replay above.
 *
 * That is more than the bucket's drain whenever the covering automation's reset
 * asks for more answered polls than misses accrued: "down after 3 missed, up
 * after 5 received" keeps the climb purple for all five (business rule 36), and
 * a chart that stopped at three would say the device was Up two polls before
 * Polaris said so.
 */
export function foldProbeRecoveries(
  verdicts: ProbeVerdict[],
  threshold: number | null = null,
  recoveryPolls = 0,
): RecoveryWindow[] {
  const states = replayProbeStates(verdicts, threshold, recoveryPolls);
  const windows: RecoveryWindow[] = [];
  let open: RecoveryWindow | null = null;
  states.forEach((state, i) => {
    if (state !== "recovering") { open = null; return; }
    const at = verdicts[i]!.timestamp;
    if (open) open.to = at;
    else { open = { from: at, to: at }; windows.push(open); }
  });
  return windows;
}

/**
 * Read the outage windows covering [since, until] for one asset.
 *
 * Tier is resolved against the `assets` retention entity (the probe stream's
 * own), independently of whichever entity the calling chart reads — a CPU chart
 * on a 30-day range may be on the daily telemetry tier while the probe stream
 * still has hourly buckets, and vice versa.
 *
 * Note the asymmetry that follows from that: `assets` and `cpuMem` retention
 * are configured separately, so an install keeping CPU history longer than
 * probe history loses outage shading at the far end of a wide range. The chart
 * degrades to an unmarked gap there, which is the honest answer — we no longer
 * have the evidence.
 *
 * On rollup tiers a PARTIAL-loss bucket is not an outage: it still plots its
 * average (section 15), so only `successCount === 0` counts.
 */
export async function readProbeOutages(
  assetId: string,
  since: Date,
  until: Date,
): Promise<OutageWindow[]> {
  const pick = await pickSampleTierForAsset(assetId, "assets", since);
  return readProbeOutagesAtTier(assetId, since, until, pick.tier, pick.bucketSeconds);
}

/** Tier-explicit variant — used by callers that already picked a probe tier. */
async function readProbeOutagesAtTier(
  assetId: string,
  since: Date,
  until: Date,
  tier: SampleTier,
  bucketSeconds: number,
): Promise<OutageWindow[]> {
  if (tier === "detail") {
    const rows = await prisma.assetMonitorSample.findMany({
      // Response-time poll only, matching readMonitorHistory: the ICMP loss
      // sampler is a different transport whose failures are not the same claim
      // (it never calls recordProbeResult and cannot move monitorStatus).
      where: {
        assetId,
        timestamp: { gte: since, lte: until },
        OR: [{ probeKind: null }, { probeKind: "primary" }],
      },
      orderBy: { timestamp: "asc" },
      select: { timestamp: true, success: true, dependencyDown: true },
    });
    return foldProbeOutages(
      rows.map((r) => ({ timestamp: r.timestamp, failed: !r.success, dependency: r.dependencyDown === true })),
      0,
      until.getTime(),
    );
  }

  const table = tier === "hourly" ? "asset_monitor_samples_hourly" : "asset_monitor_samples_daily";
  const rows = await prisma.$queryRawUnsafe<Array<{
    bucketStart: Date;
    sampleCount: number;
    successCount: number;
    failureCount: number;
    dependencyFailureCount: number | null;
  }>>(
    `SELECT "bucketStart", "sampleCount", "successCount", "failureCount", "dependencyFailureCount"
     FROM "${table}"
     WHERE "assetId" = $1 AND "bucketStart" >= $2 AND "bucketStart" <= $3
     ORDER BY "bucketStart" ASC`,
    assetId, since, until,
  );
  return foldProbeOutages(
    rows.map((r) => ({
      timestamp: r.bucketStart,
      // An empty bucket is not a failed one — it is a bucket the rollup had
      // nothing to summarise, which is a gap in the probe stream itself.
      failed: r.sampleCount > 0 && r.successCount === 0,
      // Grey only when the WHOLE bucket was explained. A bucket that mixes
      // suppressed and unexplained misses keeps the red treatment — some of
      // that hour is still an outage nobody accounted for. NULL is a bucket
      // rolled up before the column existed: read as zero, i.e. red.
      dependency: r.failureCount > 0 && (r.dependencyFailureCount ?? 0) >= r.failureCount,
    })),
    bucketSeconds,
    until.getTime(),
  );
}

/** Serialise for a chart endpoint payload. */
export function serializeOutages(windows: OutageWindow[]): Array<{ from: string; to: string; kind: OutageKind }> {
  return windows.map((w) => ({ from: w.from.toISOString(), to: w.to.toISOString(), kind: w.kind }));
}
