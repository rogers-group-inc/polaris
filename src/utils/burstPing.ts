/**
 * src/utils/burstPing.ts — BATCHED ICMP burst measurement: the thing that
 * makes packet loss a real measurement rather than a side effect of how often
 * the status poll happened to fail.
 *
 * WHY A BURST AT ALL. Loss derived from status-poll outcomes can only read in
 * steps of 1/N over the window's N polls — a 15-minute window at a 60s cadence
 * is 15 samples, so 6.7% steps, and it lags by up to the whole window. Worse,
 * that stream is the SAME one down detection reads, so an outage and a lossy
 * link are the same evidence and no amount of arithmetic separates them
 * (business rule 29's whole history is that separation being attempted inside
 * the ratio, and failing). Every other NMS solves it the same way — LibreNMS,
 * Zabbix, PRTG, Nagios and SmokePing all send N packets per interval and report
 * lost/N for THAT interval — so loss becomes its own measurement over its own
 * transport, and down detection keeps the operator's configured poll.
 *
 * WHY BATCHED. The packets are free; the PROCESS SPAWNS are not. Polaris's
 * `pingHost` spawns the system ping once per asset per interval, so a
 * 2000-asset fleet already forks ~2000 times a minute for ONE echo each.
 * Bursting per host the same way would keep that spawn count AND multiply the
 * wall-clock (a 5-packet ping cannot finish faster than its own pacing), which
 * is what made the previous per-asset sampler unaffordable at fleet scale.
 * fping interleaves every target in one process: a 500-host chunk at 5 packets
 * costs ONE spawn and finishes in about count x period, near enough
 * independent of how many hosts are in it.
 *
 * WHY fping IS OPTIONAL. Two supported install targets cannot have it — RHEL
 * ships it only via EPEL, which an enterprise install may not enable, and
 * Windows Server has no build at all. So this module is an ABSTRACTION with two
 * backends and the caller never learns which ran: fping when it is on PATH, a
 * bounded-concurrency fan-out of per-host bursts when it is not. The fallback
 * is genuinely slower and forks per host; it exists so a Polaris install is
 * never WRONG about loss, not because it is a good idea at 2000 assets.
 * deploy/setup-*.sh install fping best-effort for that reason.
 *
 * WHAT IT DELIBERATELY IS NOT. It decides nothing about an asset. It takes
 * targets and returns packet counts. The monitor state machine, the probeKind
 * split, and the answering/ceiling gates that decide whether loss may ALERT all
 * live elsewhere — ICMP still does not authenticate the device it reaches, so a
 * burst can inform a ratio and must never move monitorStatus.
 */

import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { burstPingHost, type BurstPingResult } from "./icmpPing.js";
import { logger } from "./logger.js";

export type { BurstPingResult } from "./icmpPing.js";

/**
 * Echoes per target per sweep. Five is the industry-common burst (PRTG and
 * Nagios both default here; LibreNMS and Zabbix use three) and it is the knee
 * of the curve: it buys 20% resolution on a single sweep and, because the ratio
 * SUMS packets across the window rather than averaging per-sweep percentages,
 * ~1.3% resolution over a 15-minute window — an order of magnitude better than
 * the 6.7% the poll-outcome ratio could reach.
 */
export const BURST_COUNT = 5;

/**
 * How long ONE host costs on the fallback path, measured rather than guessed:
 * a 3-packet burst against localhost took 3.27s on Windows, because Windows
 * `ping` paces at a fixed ~1s per echo and has no interval flag to lower it
 * (POSIX `ping -i 0.2` gets the same burst in ~0.8s). At FALLBACK_CONCURRENCY
 * that puts a 2000-asset fleet at roughly 100s per sweep on Windows against
 * ~26s on Linux — so a Windows install without fping CANNOT hold a 60s loss
 * cadence and must not be given one. The sweep scheduler reads
 * `suggestedSweepIntervalSec` for its floor rather than assuming 60.
 */
export const FALLBACK_SECS_PER_HOST_POSIX = 1.0;
export const FALLBACK_SECS_PER_HOST_WINDOWS = 3.3;

/**
 * The shortest sweep interval this host can actually sustain for `assetCount`
 * targets, in seconds. fping is effectively constant-time in the fleet size
 * (one spawn per 500-host chunk, each bounded by count x period), so it always
 * fits a 60s cadence; the fallback is linear in hosts over its concurrency and
 * has to be told the truth about that. Rounded up to the next 30s so the number
 * an operator sees is a cadence rather than a measurement.
 */
export function suggestedSweepIntervalSec(assetCount: number, hasFping: boolean): number {
  if (hasFping || assetCount <= 0) return 60;
  const perHost = process.platform === "win32"
    ? FALLBACK_SECS_PER_HOST_WINDOWS
    : FALLBACK_SECS_PER_HOST_POSIX;
  // x1.5 headroom: the sweep shares its worker pool with every other cadence,
  // and a loss sweep that never finishes before the next one is due is how a
  // queue grows without bound.
  const needed = (assetCount / FALLBACK_CONCURRENCY) * perHost * 1.5;
  return Math.max(60, Math.ceil(needed / 30) * 30);
}

/** Interval between packets to the SAME target. With a fixed count this paces
 *  the whole run: a sweep takes about BURST_COUNT x this, whatever the chunk
 *  size. */
export const BURST_PERIOD_MS = 500;

/** Interval between packets to DIFFERENT targets — fping's own pacing knob. At
 *  1ms a 500-host round takes 500ms, which fits inside BURST_PERIOD_MS, so the
 *  period above stays the thing that bounds the sweep. */
export const BURST_SPACING_MS = 1;

/** Per-echo timeout. Generous versus any LAN/WAN round trip; the point is to
 *  distinguish "no reply" from "slow reply", not to measure latency. */
export const BURST_TIMEOUT_MS = 1000;

/**
 * Targets per fping process. Chosen so one round of the inter-target pacing
 * (chunk x BURST_SPACING_MS) fits inside BURST_PERIOD_MS — past that fping
 * stretches the run and the sweep stops being bounded by the period. It also
 * keeps argv well under ARG_MAX (500 addresses is ~8 KB against a ~2 MB limit),
 * which is why targets ride argv rather than stdin: no plumbing, and no
 * dependency on which stdin spelling the installed fping accepts.
 */
export const BURST_CHUNK = 500;

/** How many per-host ping processes the FALLBACK may have in flight. Bounded
 *  because that path forks per host and a fleet-wide sweep would otherwise try
 *  to spawn thousands of processes at once. */
export const FALLBACK_CONCURRENCY = 64;

export interface BurstPingOptions {
  count?: number;
  periodMs?: number;
  timeoutMs?: number;
  /** Test seam: force a backend instead of probing for fping. */
  backend?: "fping" | "ping";
}

// ── fping capability ────────────────────────────────────────────────────────
// Probed once per process and cached. A negative result is cached too: fping
// does not appear on PATH mid-run, and re-probing per sweep would add a spawn
// to the very path that exists to remove them.
let fpingAvailable: Promise<boolean> | null = null;

export function detectFping(): Promise<boolean> {
  if (fpingAvailable) return fpingAvailable;
  fpingAvailable = new Promise<boolean>((resolve) => {
    // `spawn` can fail SYNCHRONOUSLY, not only through the "error" event. A
    // binary carrying file capabilities the process cannot be granted — Debian
    // ships `fping` and `ping` as cap_net_raw=ep, and a container or a hardened
    // systemd unit whose CapabilityBoundingSet omits CAP_NET_RAW cannot execve
    // them — fails with EPERM, which Node throws from the spawn call itself.
    //
    // Uncaught inside this executor that REJECTS the promise, and because the
    // answer is memoized below the rejection is cached for the life of the
    // process: every later `await detectFping()` rejects, so runMonitorPass
    // dies on EVERY tick instead of falling back to per-host ping. Monitoring
    // stops altogether rather than degrading. So treat a synchronous failure as
    // exactly what the "error" event means — no usable fping.
    let child: ChildProcess;
    try {
      child = spawn("fping", ["-v"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      resolve(false);
    }, 5_000);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
  return fpingAvailable;
}

/** Test-only: forget the cached probe so a test can re-resolve. */
export function __resetFpingDetectionForTests(): void {
  fpingAvailable = null;
}

/**
 * One fping summary line per target, from either stream:
 *
 *   10.0.0.1  : xmt/rcv/%loss = 5/5/0%, min/avg/max = 0.10/0.15/0.20
 *   10.0.0.9  : xmt/rcv/%loss = 5/0/100%
 *
 * A host fping could not resolve produces no summary line at all (just a
 * name-resolution complaint on stderr) and is therefore ABSENT from the
 * returned map rather than present at 100% — the caller has to be able to tell
 * "we asked and heard nothing" from "we never asked", because only the first is
 * packet loss. Exported for tests: this parse is the part that rots silently
 * when a distro changes fping's wording, and a wrong parse reads as a fleet
 * that suddenly has no loss.
 */
export function parseFpingOutput(out: string): Map<string, BurstPingResult> {
  const map = new Map<string, BurstPingResult>();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+)\s*:\s*xmt\/rcv\/%loss\s*=\s*(\d+)\/(\d+)\//);
    if (!m) continue;
    const sent = Number(m[2]);
    const received = Number(m[3]);
    if (!Number.isFinite(sent) || sent <= 0) continue;
    const rtt = line.match(/min\/avg\/max\s*=\s*[\d.]+\/([\d.]+)\/[\d.]+/);
    const recv = Number.isFinite(received) ? Math.min(Math.max(received, 0), sent) : 0;
    map.set(m[1]!, {
      sent,
      received: recv,
      avgRttMs: recv > 0 && rtt ? Number(rtt[1]) : null,
    });
  }
  return map;
}

/** Split an array into fixed-size chunks. */
function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

async function runFpingChunk(
  targets: string[],
  opts: Required<Pick<BurstPingOptions, "count" | "periodMs" | "timeoutMs">>,
): Promise<Map<string, BurstPingResult>> {
  const args = [
    "-q",                             // summary only, no per-packet lines
    "-c", String(opts.count),
    "-p", String(opts.periodMs),      // spacing between packets to one target
    "-i", String(BURST_SPACING_MS),   // spacing between different targets
    "-t", String(opts.timeoutMs),
    "-B", "1",                        // no timeout backoff — keep the run bounded
    "-r", "0",                        // no retries; a retry would forge a reply
    ...targets,
  ];
  // fping writes its per-count summary to stderr; read both streams so a build
  // that sends it to stdout parses identically.
  const hardLimitMs = opts.count * opts.periodMs + opts.timeoutMs + 15_000;
  return await new Promise<Map<string, BurstPingResult>>((resolve) => {
    // Synchronous spawn failure (EPERM on a cap_net_raw binary) is not loss,
    // the same as the "error" event below: hand back an empty map so the caller
    // falls back instead of recording a fleet-wide outage. See detectFping.
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn("fping", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(new Map());
      return;
    }
    let out = "";
    let done = false;
    const finish = (m: Map<string, BurstPingResult>): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(m);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      // Partial output still parses — the hosts fping reached are real readings.
      finish(parseFpingOutput(out));
    }, hardLimitMs);
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    // Spawn failure is NOT loss: hand back an empty map so the caller falls back
    // rather than recording a fleet-wide outage.
    child.on("error", () => finish(new Map()));
    // Exit code ignored on purpose — fping exits non-zero whenever ANY target
    // was unreachable, which is the normal case for a real fleet.
    child.on("close", () => finish(parseFpingOutput(out)));
  });
}

/** Bounded-concurrency fan-out of per-host bursts — the no-fping fallback. */
async function runPingFallback(
  targets: string[],
  opts: Required<Pick<BurstPingOptions, "count" | "periodMs" | "timeoutMs">>,
): Promise<Map<string, BurstPingResult>> {
  const map = new Map<string, BurstPingResult>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= targets.length) return;
      const t = targets[i]!;
      const r = await burstPingHost(t, {
        count: opts.count,
        intervalMs: opts.periodMs,
        timeoutMs: opts.timeoutMs,
      });
      // sent === 0 means we never reached the network (no ping binary) — absent
      // from the map, exactly as an unresolvable fping target is.
      if (r.sent > 0) map.set(t, r);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FALLBACK_CONCURRENCY, targets.length) }, worker),
  );
  return map;
}

/**
 * Burst-ping every target and report per-target packet counts.
 *
 * Targets are de-duplicated (two assets can share an address, and pinging it
 * twice would double the traffic and give the two assets different readings of
 * the same link). The returned map is keyed by target string exactly as passed
 * in; a target absent from it was never successfully attempted and must NOT be
 * counted as loss.
 *
 * Never throws — a sweep that cannot run reports an empty map, which the caller
 * records as "no reading this cycle" rather than as an outage.
 */
export async function burstPing(
  targets: string[],
  opts: BurstPingOptions = {},
): Promise<Map<string, BurstPingResult>> {
  const uniq = Array.from(new Set(targets.filter((t) => !!t && t.trim() !== "")));
  if (uniq.length === 0) return new Map();
  const resolved = {
    count: opts.count ?? BURST_COUNT,
    periodMs: opts.periodMs ?? BURST_PERIOD_MS,
    timeoutMs: opts.timeoutMs ?? BURST_TIMEOUT_MS,
  };
  const backend = opts.backend ?? ((await detectFping()) ? "fping" : "ping");

  if (backend === "ping") return await runPingFallback(uniq, resolved);

  const out = new Map<string, BurstPingResult>();
  for (const c of chunk(uniq, BURST_CHUNK)) {
    const got = await runFpingChunk(c, resolved);
    // A chunk that produced NOTHING while it had targets means fping ran but we
    // could not use it — an unsupported flag on an old build, a permissions
    // refusal, a wording change this parser does not know. Fall back for that
    // chunk rather than silently reporting no data, and say so once: a fleet
    // quietly losing its loss measurement is exactly the failure this module
    // exists to make visible.
    if (got.size === 0) {
      logger.warn(
        { targets: c.length },
        "fping produced no parseable summaries — falling back to per-host ping for this chunk",
      );
      for (const [k, v] of await runPingFallback(c, resolved)) out.set(k, v);
      continue;
    }
    for (const [k, v] of got) out.set(k, v);
  }
  return out;
}

// ─── Per-target timeouts ─────────────────────────────────────────────────────

/** One host to reach, with the timeout THAT host is entitled to. */
export interface PingTarget {
  target: string;
  /** The asset's resolved probeTimeoutMs. */
  timeoutMs: number;
}

/**
 * Group targets that share a timeout. Exported for tests and for the caller's
 * own logging — how many buckets a due-set produces is the whole cost model of
 * `pingTargets`, and it is worth being able to assert on.
 *
 * Buckets come back in ASCENDING timeout order, so the fast majority of a fleet
 * is measured and recorded before one slow-timeout outlier holds a worker.
 * Targets keep their relative order inside a bucket, and a duplicate target
 * inside one bucket is collapsed.
 */
export function bucketByTimeout(targets: PingTarget[]): Array<{ timeoutMs: number; targets: string[] }> {
  const byTimeout = new Map<number, string[]>();
  const seen = new Map<number, Set<string>>();
  for (const t of targets) {
    if (!t.target || t.target.trim() === "") continue;
    const ms = Number.isFinite(t.timeoutMs) && t.timeoutMs > 0 ? Math.round(t.timeoutMs) : BURST_TIMEOUT_MS;
    let list = byTimeout.get(ms);
    let dedup = seen.get(ms);
    if (!list || !dedup) {
      list = [];
      dedup = new Set<string>();
      byTimeout.set(ms, list);
      seen.set(ms, dedup);
    }
    if (dedup.has(t.target)) continue;
    dedup.add(t.target);
    list.push(t.target);
  }
  return Array.from(byTimeout.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([timeoutMs, list]) => ({ timeoutMs, targets: list }));
}

/**
 * Ping many hosts that do NOT share a timeout — the status-probe shape, as
 * distinct from `burstPing`'s uniform loss sweep.
 *
 * WHY BUCKETING RATHER THAN ONE INVOCATION. fping's `-t` is per invocation, not
 * per target, but `probeTimeoutMs` is a per-asset setting an operator chose.
 * Running everything at the batch maximum would work — each result could then
 * be judged against its own asset's timeout using the reported RTT — but it
 * makes the whole batch wait out its slowest member, so one asset configured at
 * 30s would hold up the fleet's verdict every cycle. One invocation per
 * DISTINCT timeout keeps each group bounded by its own number, and real fleets
 * carry two or three distinct values, so this is a handful of processes rather
 * than one per host.
 *
 * `count` defaults to **1**: this replaces a single-echo status probe, and down
 * detection is defined in missed POLLS (business rule 30). Sending more echoes
 * here would quietly redefine what one missed poll means, which is not this
 * function's decision to make — the loss sweep is where bursts belong.
 *
 * Same contract as `burstPing`: a target ABSENT from the returned map was never
 * successfully attempted and must NOT be recorded as a failed probe.
 */
export async function pingTargets(
  targets: PingTarget[],
  opts: { count?: number } = {},
): Promise<Map<string, BurstPingResult>> {
  const buckets = bucketByTimeout(targets);
  if (buckets.length === 0) return new Map();
  const count = opts.count ?? 1;
  const out = new Map<string, BurstPingResult>();
  for (const b of buckets) {
    const got = await burstPing(b.targets, {
      count,
      timeoutMs: b.timeoutMs,
      // One echo needs no spacing; the period only matters for a real burst.
      periodMs: count > 1 ? BURST_PERIOD_MS : BURST_TIMEOUT_MS,
    });
    for (const [k, v] of got) out.set(k, v);
  }
  return out;
}

