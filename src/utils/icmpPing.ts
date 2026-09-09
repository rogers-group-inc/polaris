/**
 * src/utils/icmpPing.ts — single-echo ICMP reachability check via the system
 * `ping` binary. Extracted from monitoringService's probeIcmp so non-monitor
 * callers (the AD/Entra presence-verification pass) can ping a host without
 * pulling in the monitoring service. monitoringService.probeIcmp delegates
 * here and adapts the result to its ProbeResult shape.
 */

import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export interface IcmpPingResult {
  success: boolean;
  /** Short human-readable reason on failure; absent on success. */
  error?: string;
}

export async function pingHost(host: string, timeoutMs: number): Promise<IcmpPingResult> {
  return await new Promise<IcmpPingResult>((resolve) => {
    const isWindows = process.platform === "win32";
    const args = isWindows
      ? ["-n", "1", "-w", String(timeoutMs), host]
      : ["-c", "1", "-W", String(Math.ceil(timeoutMs / 1000)), host];
    // A synchronous spawn throw is the same failure as the "error" event: on
    // Debian `ping` is cap_net_raw=ep, so a process without CAP_NET_RAW cannot
    // execve it and Node throws EPERM from the spawn call. Report it the way an
    // async spawn error is reported rather than letting it escape this executor
    // and reject the promise. See burstPing.detectFping for the full story.
    let child: ChildProcess;
    try {
      child = spawn("ping", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ success: false, error: (err as Error).message });
      return;
    }
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch { /* already exited */ }
      resolve({ success: false, error: "ping timed out" });
    }, timeoutMs + 2_000);
    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ success: false, error: err.message });
    });
    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code === 0) resolve({ success: true });
      else resolve({ success: false, error: `ping exit ${code}` });
    });
  });
}

/**
 * Result of a BURST of echoes at one host — the input to a real packet-loss
 * ratio, as distinct from `pingHost`'s single reachability yes/no.
 *
 * `sent` is what we asked for, not what the OS admits to having put on the
 * wire: a `ping` that dies before its summary line reports nothing, and
 * treating that as "0 sent" would silently drop the host out of the ratio's
 * denominator rather than counting it as lost. The parsers below only ever
 * lower `sent` when the tool states a smaller figure itself.
 */
export interface BurstPingResult {
  /** Echoes requested. Never 0 — a host we could not attempt at all is absent
   *  from the result map instead, so callers can tell "lost" from "not tried". */
  sent: number;
  /** Echo replies received. 0 is a legitimate reading (a dark host). */
  received: number;
  /** Mean RTT in ms over the replies, when the tool reported one. Null on a
   *  total loss, and null from the fallback path when the summary omitted it. */
  avgRttMs: number | null;
}

/**
 * `N packets transmitted, M received` (iputils) and
 * `Packets: Sent = N, Received = M` (Windows), plus the optional RTT summary
 * line from either. Exported for tests — the parse is the part that silently
 * rots when a distro changes its wording, and a wrong parse reads as a fleet
 * that suddenly has no packet loss.
 */
export function parsePingSummary(out: string, requested: number): BurstPingResult {
  let sent = requested;
  let received = 0;
  // iputils: "5 packets transmitted, 5 received, 0% packet loss, time 802ms"
  const nix = out.match(/(\d+)\s+packets transmitted,\s*(\d+)\s+(?:packets\s+)?received/i);
  if (nix) {
    sent = Number(nix[1]);
    received = Number(nix[2]);
  } else {
    // Windows: "Packets: Sent = 5, Received = 5, Lost = 0 (0% loss),"
    const win = out.match(/Sent\s*=\s*(\d+),\s*Received\s*=\s*(\d+)/i);
    if (win) {
      sent = Number(win[1]);
      received = Number(win[2]);
    }
  }
  // A tool that reported nothing usable leaves `sent` at the requested count
  // and `received` at 0 — a total loss, which is the honest reading of "we
  // asked and heard nothing back".
  let avgRttMs: number | null = null;
  // iputils: "rtt min/avg/max/mdev = 0.108/0.155/0.201/0.038 ms"
  const nixRtt = out.match(/=\s*[\d.]+\/([\d.]+)\/[\d.]+/);
  // Windows: "Minimum = 0ms, Maximum = 1ms, Average = 0ms"
  const winRtt = out.match(/Average\s*=\s*(\d+)\s*ms/i);
  if (nixRtt) avgRttMs = Number(nixRtt[1]);
  else if (winRtt) avgRttMs = Number(winRtt[1]);
  if (avgRttMs !== null && !Number.isFinite(avgRttMs)) avgRttMs = null;
  // Guard the arithmetic the callers do with these: a malformed line must not
  // produce a ratio above 100% or below 0%.
  if (!Number.isFinite(sent) || sent <= 0) sent = requested;
  if (!Number.isFinite(received) || received < 0) received = 0;
  if (received > sent) received = sent;
  return { sent, received, avgRttMs: received > 0 ? avgRttMs : null };
}

/**
 * A burst of `count` echoes at ONE host via the system `ping`, returning
 * sent/received rather than a boolean. The per-host fallback behind
 * `utils/burstPing.ts` when fping isn't installed — see that file for why the
 * batched path is strongly preferred at fleet scale (this one costs a process
 * spawn per host per sweep; fping costs one per CHUNK).
 *
 * `intervalMs` is honoured on POSIX only: Windows `ping` has no inter-packet
 * interval flag and paces itself at ~1s, which is why a Windows install's
 * sweep is slower per host and wants a smaller `count`.
 */
export async function burstPingHost(
  host: string,
  opts: { count: number; intervalMs: number; timeoutMs: number },
): Promise<BurstPingResult> {
  const { count, intervalMs, timeoutMs } = opts;
  const isWindows = process.platform === "win32";
  const args = isWindows
    ? ["-n", String(count), "-w", String(timeoutMs), host]
    : ["-c", String(count), "-i", String(Math.max(0.2, intervalMs / 1000)),
       "-W", String(Math.ceil(timeoutMs / 1000)), "-q", host];
  // Wall-clock ceiling: the pacing between packets, plus one timeout for the
  // last one, plus slack for spawn. Windows paces at a fixed ~1s regardless of
  // what we asked for, so its ceiling is computed from that instead.
  const paceMs = isWindows ? 1000 : Math.max(200, intervalMs);
  const hardLimitMs = count * paceMs + timeoutMs + 3_000;
  return await new Promise<BurstPingResult>((resolve) => {
    // Synchronous spawn failure means we never reached the network, exactly as
    // the "error" event below: nothing sent, so the caller drops the host from
    // the ratio instead of inventing 100% loss for every asset at once.
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn("ping", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ sent: 0, received: 0, avgRttMs: null });
      return;
    }
    let out = "";
    let done = false;
    const finish = (r: BurstPingResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      // Whatever it printed before we killed it still parses; a truly silent
      // child yields the all-lost reading, which is what a wedged ping means.
      finish(parsePingSummary(out, count));
    }, hardLimitMs);
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    // A spawn failure (no `ping` on PATH) is NOT loss — we never reached the
    // network. Report it as nothing sent so the caller can drop the host from
    // the ratio instead of inventing a 100% reading for every asset at once.
    child.on("error", () => finish({ sent: 0, received: 0, avgRttMs: null }));
    // Exit code is deliberately ignored: `ping` exits 1 on partial loss and on
    // total loss alike, and the summary line is the actual measurement.
    child.on("close", () => finish(parsePingSummary(out, count)));
  });
}
