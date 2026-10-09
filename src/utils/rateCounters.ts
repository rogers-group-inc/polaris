/**
 * src/utils/rateCounters.ts
 *
 * Integrates per-second RATES into cumulative COUNTERS, for platforms that
 * report traffic as a rate (TrueNAS `reporting.realtime` / `app.stats`, a
 * Proxmox node's RRD `netin` / `netout`) while the interface pipeline charts
 * counters, the way SNMP octets arrive. No imports: shared by the workload
 * services without coupling one to another.
 */

/** Past this gap a counter restarts at 0 rather than invent the traffic in between. */
export const RATE_COUNTER_MAX_GAP_MS = 5 * 60_000;

/**
 * Running counters, per key. A gap longer than RATE_COUNTER_MAX_GAP_MS (the
 * monitor was down, the workload was stopped) restarts the counter at 0,
 * which the interface pipeline reads as a counter reset — a missing point,
 * never a spike.
 */
export class RateCounters {
  private readonly state = new Map<string, { total: number; at: number }>();

  advance(key: string, ratePerSec: number | null, nowMs: number): number | null {
    if (ratePerSec === null || ratePerSec < 0) return null;
    const prev = this.state.get(key);
    const elapsed = prev ? nowMs - prev.at : 0;
    const total = prev && elapsed > 0 && elapsed <= RATE_COUNTER_MAX_GAP_MS
      ? prev.total + Math.round(ratePerSec * (elapsed / 1000))
      : 0;
    this.state.set(key, { total, at: nowMs });
    return total;
  }

  /** Forget keys not advanced since `cutoffMs` (workloads that went away). */
  prune(cutoffMs: number): void {
    for (const [k, v] of this.state) if (v.at < cutoffMs) this.state.delete(k);
  }
}
