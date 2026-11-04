/**
 * src/services/arpPrimeService.ts — ARP-priming presence sweep.
 *
 * Fire-and-forget UDP datagrams at a list of IPv4 addresses. The point is
 * NOT the datagram itself (nothing listens for a reply): delivering any
 * packet to an IP on a FortiGate-attached subnet forces the FortiGate to
 * ARP-resolve the target on its directly-connected segment. Any live IP
 * stack answers ARP — including hosts that firewall ICMP echo — so a
 * subsequent read of the gate's ARP table (`/api/v2/monitor/network/arp`,
 * discovery Step 3d.55 / 3e.55) captures a fresh MAC↔IP binding for every
 * reachable device. The discovery sync turns matching bindings into
 * `Reservation.lastSeenArp` stamps for stale-reservation detection.
 *
 * Timing matters: FortiOS neighbor-cache entries go STALE within ~15–45s of
 * traffic and an unreferenced entry can be garbage-collected in as little as
 * ~60–90s, so callers sweep, settle briefly (ARP_SETTLE_MS), and pull the
 * table immediately — never schedule other work in between.
 *
 * Reachability is best-effort by design: the datagram only forces an ARP if
 * Polaris can route to the target subnet AND FortiGate policy permits the
 * flow. Where it can't, nothing happens — absence of an ARP entry is never
 * treated as evidence of absence (the stale service only consumes positive
 * signals). Opt-in per integration (`config.arpPresenceSweep`, default off)
 * because an unannounced sweep of every reserved IP is exactly what IDS
 * dashboards flag.
 *
 * Scale: one UDP socket per sweep, one ~1-byte datagram per IP, paced in
 * batches — 2000 targets complete in well under a second of send time. Send
 * errors (unreachable, buffer pressure) are swallowed per-datagram; the
 * sweep never throws.
 */

import { chunkArray } from "../utils/chunk.js";
import dgram from "node:dgram";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/sleep.js";

/**
 * Destination port for sweep datagrams. Deliberately in the traceroute
 * "unlikely to be listening" range — a live target at worst answers with an
 * ICMP port-unreachable (which itself confirms the ARP resolution we wanted);
 * a dead one silently drops. Nothing on the wire carries payload.
 */
const ARP_SWEEP_PORT = 33434;

/** Datagrams per pacing batch. */
export const ARP_SWEEP_BATCH_SIZE = 256;

/** Pause between pacing batches (ms). */
const ARP_SWEEP_BATCH_PAUSE_MS = 25;

/**
 * Hard cap on targets per sweep — a runaway-input backstop far above any
 * real per-FortiGate reservation count. Overflow is logged, never silent.
 */
export const ARP_SWEEP_MAX_TARGETS = 4096;

/**
 * How long callers should wait between the sweep and the ARP-table read.
 * ARP resolution on a directly-attached segment is single-digit
 * milliseconds; 2s absorbs FortiGate forwarding + slow-to-wake endpoints
 * while staying far inside the neighbor-cache GC window.
 */
export const ARP_SETTLE_MS = 2000;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPlausibleIpv4(ip: string): boolean {
  const m = IPV4_RE.exec(ip);
  if (!m) return false;
  return m.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Pure planning half of the sweep, split out for unit testing: dedupe,
 * drop non-IPv4 / malformed entries, cap at `maxTargets`, and chunk into
 * pacing batches. `dropped` counts only the over-cap overflow (malformed
 * entries are skipped silently — they were never sweepable).
 */
export function planSweepBatches(
  ips: string[],
  batchSize = ARP_SWEEP_BATCH_SIZE,
  maxTargets = ARP_SWEEP_MAX_TARGETS,
): { batches: string[][]; targets: number; dropped: number } {
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const raw of ips) {
    const ip = typeof raw === "string" ? raw.trim() : "";
    if (!ip || seen.has(ip) || !isPlausibleIpv4(ip)) continue;
    seen.add(ip);
    valid.push(ip);
  }
  const dropped = Math.max(0, valid.length - maxTargets);
  const capped = valid.slice(0, maxTargets);
  const batches = chunkArray(capped, batchSize);
  return { batches, targets: capped.length, dropped };
}


/**
 * Fire one UDP datagram at each target IP, paced, fire-and-forget. Resolves
 * once every datagram has been handed to the socket (NOT when replies
 * arrive — none are expected). Never throws; a socket-level failure logs a
 * warning and returns whatever was sent before it.
 */
export async function primeArpCache(ips: string[]): Promise<{ sent: number; dropped: number }> {
  const { batches, targets, dropped } = planSweepBatches(ips);
  if (dropped > 0) {
    logger.warn({ dropped, cap: ARP_SWEEP_MAX_TARGETS }, "ARP presence sweep target list exceeded cap — overflow skipped");
  }
  if (targets === 0) return { sent: 0, dropped };

  let sent = 0;
  const payload = Buffer.from([0]);
  const socket = dgram.createSocket("udp4");
  // Never hold the process open for a sweep.
  socket.unref();
  try {
    // A dgram socket can emit 'error' asynchronously (e.g. EADDRNOTAVAIL);
    // without a listener that crashes the process.
    socket.on("error", (err) => {
      logger.warn({ err: err.message }, "ARP presence sweep socket error (sweep is best-effort; continuing)");
    });
    for (let b = 0; b < batches.length; b++) {
      if (b > 0) await sleep(ARP_SWEEP_BATCH_PAUSE_MS);
      // Await each batch's send callbacks before closing/continuing: send()
      // queues behind the socket's implicit bind, and close() drops anything
      // still queued. The callback fires on success AND error — per-datagram
      // errors (host unreachable, buffer pressure) are swallowed by design,
      // the sweep is one-way.
      await Promise.all(batches[b].map((ip) =>
        new Promise<void>((resolve) => {
          socket.send(payload, ARP_SWEEP_PORT, ip, () => {
            sent++;
            resolve();
          });
        })
      ));
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, "ARP presence sweep aborted mid-send (best-effort; partial sweep still primes)");
  } finally {
    try {
      socket.close();
    } catch {
      // already closed — fine
    }
  }
  return { sent, dropped };
}
