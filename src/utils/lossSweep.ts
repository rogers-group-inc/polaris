/**
 * src/utils/lossSweep.ts — who gets burst-pinged, and how often. The pure
 * decision layer behind the ICMP loss sweep; the measurement itself is
 * `utils/burstPing.ts` and the wiring is monitorAssets + monitoringService.
 *
 * THIS REPLACES utils/lossSampler.ts, and the difference is the whole point.
 * The old sampler ran ONLY while an asset was `warning` or `recovering` — a
 * 10s side-probe during a run, per asset, to give the ratio more samples than
 * the poll cadence could. It was disabled a day after it shipped (business
 * rule 29d) because that window IS a sampling bias: it sampled precisely when
 * probes were already failing, so failure periods were oversampled and the
 * alert's reading diverged visibly from the wall-clock average its own chart
 * drew. There is no way to correct that bias after the fact; the only fix is
 * to stop creating it.
 *
 * So the sweep is UNIFORM: every eligible asset, every cycle, the same burst,
 * whatever state it is in. A ratio over uniformly-spaced bursts means what an
 * operator thinks it means. That is affordable now only because the pinger is
 * batched — 2000 assets cost 4 fping spawns, where the old per-asset design
 * cost 2000 and could not have run fleet-wide at any cadence.
 *
 * ELIGIBILITY, and why each exclusion is narrow:
 *
 *   - `monitored` must be true. Business rule 10 already forces it false for
 *     the four unmonitorable statuses, so this one test covers them.
 *   - `maintenance` is excluded explicitly, because it is the one status that
 *     KEEPS `monitored` true while all server-driven polling stops (rule 16).
 *   - `responseTimePolling === "disabled"` is excluded: that is the operator
 *     saying do not reach out to this device, and rule 30 already honours it
 *     as a skip rather than a miss. Nothing else about the polling METHOD is
 *     consulted — an agent-monitored host still sits on a network whose packet
 *     loss is a real fact, and letting "I use the agent for status" silently
 *     disable loss measurement would be a surprise.
 *
 * AND TWO THINGS THE OLD SAMPLER EXCLUDED THAT THIS ONE DELIBERATELY KEEPS:
 *
 *   - `down` assets. The old exclusion was a corroboration argument: with every
 *     poll failing, an ICMP reply is the only evidence, and a host that had
 *     taken over the address would drag a dead device's loss down to something
 *     reading like congestion. That reasoning was load-bearing when loss shared
 *     a stream with down detection. It no longer does — the sweep NEVER calls
 *     recordProbeResult, so nothing here can move monitorStatus, and the
 *     engine's own answering gate keeps a down device from raising a loss
 *     alert at all (business rule 29a). Excluding them would just punch a hole
 *     in the series at the exact moment an operator wants to read it.
 *   - Dependency-suppressed assets. Excluding them was a COST argument — a site
 *     outage would have put every asset behind a dead gate into a 10s ping loop
 *     at the busiest possible moment. Batched, that same outage costs five
 *     extra packets per asset inside a sweep that was already running. The
 *     failures are still marked explained: the sweep stamps
 *     AssetMonitorSample.dependencyDown exactly as the probe path does, so the
 *     charts draw them grey rather than as an accusation (business rule 38b).
 */

import { suggestedSweepIntervalSec } from "./burstPing.js";
import { assetDialAddress } from "./assetDialAddress.js";

/**
 * Master switch. Unlike the sampler this replaces, the sweep ships ENABLED:
 * packet loss is measurably wrong without it (a device flapping to `down` each
 * cycle reports ~0% loss forever), and a fix that ships switched off is a fix
 * nobody gets. The operator-facing control is a monitor setting; this constant
 * is the floor beneath it.
 */
export const LOSS_SWEEP_ENABLED = true;

/** Default seconds between sweeps. The scheduler raises it when this host
 *  cannot sustain it — see `resolveSweepIntervalSec`. */
export const LOSS_SWEEP_DEFAULT_INTERVAL_SEC = 60;

/**
 * The operator's configured sweep interval, from POLARIS_LOSS_SWEEP_INTERVAL_SEC.
 *
 * An env var rather than a Setting because this is a host-capacity knob, not a
 * monitoring policy: the reason to change it is that this host forks a process
 * per asset without fping, which is a property of the box rather than of any
 * asset. It sits with the worker-pool sizes for that reason.
 *
 * RAISING it is the cheap answer to a fleet the fallback pinger cannot serve at
 * 60s: LibreNMS polls loss every 5 minutes for exactly this reason, and at 300s
 * a 2000-asset fleet costs a fifth of the processes. The ratio itself does not
 * get coarser — it still sums packets over the automation's own History window
 * — only how quickly it reacts.
 *
 * Invalid or absent falls back to the default rather than to 0: a 0 here would
 * disable loss measurement fleet-wide through a typo.
 */
export function configuredSweepIntervalSec(
  raw: string | undefined = process.env.POLARIS_LOSS_SWEEP_INTERVAL_SEC,
): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : LOSS_SWEEP_DEFAULT_INTERVAL_SEC;
}

/** Assets per queued chunk job. Matches burstPing's own fping chunk so one
 *  queued job is one fping process; a larger job would just re-chunk inside
 *  the worker and hold a worker slot for longer with no gain. */
export const LOSS_SWEEP_CHUNK = 500;

export interface LossSweepAsset {
  id: string;
  monitored?: boolean | null;
  /** Lifecycle status — `maintenance` is the one that must be tested here. */
  status?: string | null;
  ipAddress?: string | null;
  /** Primary IPv6 — dialled only when there is no IPv4 and IPv6 is on (rule 127). */
  ipv6Address?: string | null;
  dnsName?: string | null;
  hostname?: string | null;
}

export interface LossSweepSettings {
  /** Resolved response-time polling method; only `"disabled"` excludes. */
  responseTimePolling: string | null;
}

/**
 * The ICMP target for an asset, or null when there is nothing to ping.
 * Address first, then names — fping and ping both resolve a name perfectly
 * well, and directory-discovered hosts often carry only a DNS name. The
 * address is the IPv4, else (IPv6 on for the install) the primary IPv6.
 */
export function lossSweepTarget(a: LossSweepAsset, allowIpv6 = false): string | null {
  return assetDialAddress(a, allowIpv6) || a.dnsName || a.hostname || null;
}

/**
 * Is this asset in the sweep at all? Pure — the caller supplies resolved
 * settings. `enabled` defaults to the module switch so the due-set builder and
 * the worker's pickup re-check go quiet through the one predicate; tests pass
 * it explicitly to exercise the eligibility logic underneath.
 */
export function lossSweepIncludes(
  a: LossSweepAsset,
  eff: LossSweepSettings,
  enabled: boolean = LOSS_SWEEP_ENABLED,
  allowIpv6 = false,
): boolean {
  if (!enabled) return false;
  if (a.monitored !== true) return false;
  // The one status that keeps `monitored` true while polling stops (rule 16).
  if (String(a.status ?? "") === "maintenance") return false;
  if (eff.responseTimePolling === "disabled") return false;
  return lossSweepTarget(a, allowIpv6) !== null;
}

/** Cadence half, split out so the due-set builder reuses the same arithmetic
 *  it uses for every other stream. `intervalSec <= 0` disables. */
export function lossSweepIsDue(
  last: Date | null | undefined,
  now: Date,
  intervalSec: number = LOSS_SWEEP_DEFAULT_INTERVAL_SEC,
): boolean {
  if (intervalSec <= 0) return false;
  if (!last) return true;
  return now.getTime() - last.getTime() >= intervalSec * 1000;
}

/**
 * The cadence this host can actually hold for `assetCount` targets — the
 * operator's configured interval, floored by what the installed pinger can
 * finish. With fping that floor is always 60s; on the per-host fallback it
 * grows with the fleet, and a Windows install's `ping` cannot be paced below
 * ~1s per echo at all. Publishing sweeps faster than they drain would grow the
 * queue without bound, so the floor wins over the configured value rather than
 * the other way round.
 */
export function resolveSweepIntervalSec(
  configuredSec: number | null | undefined,
  assetCount: number,
  hasFping: boolean,
): number {
  const configured = typeof configuredSec === "number" && configuredSec > 0
    ? configuredSec
    : LOSS_SWEEP_DEFAULT_INTERVAL_SEC;
  return Math.max(configured, suggestedSweepIntervalSec(assetCount, hasFping));
}

/**
 * Split asset ids into sweep chunks. Order is preserved so a chunk index is
 * stable for a stable fleet, which is what lets the publisher use it as a
 * pg-boss singleton key: re-publishing chunk N while chunk N from the previous
 * cycle is still queued COALESCES rather than piling on. That is the
 * backpressure — a sweep that cannot keep up skips a cycle instead of growing
 * a queue.
 */
export function chunkForSweep(ids: string[], size: number = LOSS_SWEEP_CHUNK): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += Math.max(1, size)) {
    out.push(ids.slice(i, i + Math.max(1, size)));
  }
  return out;
}
