/**
 * src/utils/workerSlotPool.ts
 *
 * Stable per-cadence slot identifiers for monitor workers. pg-boss spawns
 * N concurrent handler invocations per cadence (via `localConcurrency`)
 * but doesn't expose which "slot" is currently active. To give operators
 * a human-readable name they can trace through journalctl, we maintain
 * our own per-pool occupancy table.
 *
 * The slot id format is `<prefix>-<W|F><NN>` — `probe-W07`, `floating-F03`.
 * Width is 2 digits since the largest default pool (telemetry/systemInfo)
 * is 24 workers and the floating pool defaults to 32; both fit. Pools
 * configured beyond 99 workers fall through to 3-digit suffixes.
 *
 * Slots are reused: when worker `probe-W07` finishes a job, the slot is
 * returned to the pool and the next free job picks it up. That lets an
 * operator trace one slot's lifecycle across multiple jobs to look for
 * stuck or slow workers.
 *
 * On a full pool (shouldn't happen in practice since pg-boss caps
 * concurrency at the same N), `acquire()` returns a fallback id with the
 * `-?` suffix so the logging path never throws.
 */

export type WorkerSlotPrefix = "probe" | "fast" | "telemetry" | "sysinfo" | "lldp" | "storage" | "processes" | "eventlog" | "sdwan" | "losssample" | "floating";

export interface WorkerSlotPool {
  prefix: WorkerSlotPrefix;
  /** `W` for dedicated cadence workers, `F` for the floating pool — purely
   *  cosmetic so operators can tell at a glance which kind they're looking at. */
  letter: "W" | "F";
  /** One entry per slot; `true` when in use. Length matches the pool's
   *  `localConcurrency` (or for the floating pool, its ceiling). */
  busy: boolean[];
}

export function createWorkerSlotPool(
  prefix: WorkerSlotPrefix,
  size: number,
): WorkerSlotPool {
  return {
    prefix,
    letter: prefix === "floating" ? "F" : "W",
    busy: new Array(Math.max(1, size)).fill(false),
  };
}

/**
 * Reserve the first free slot in the pool and return its identifier. If
 * the pool is unexpectedly full (the caller exceeded the configured
 * concurrency), returns `<prefix>-<letter>?` as a safe fallback so the
 * logging path doesn't throw.
 */
export function acquireWorkerSlot(pool: WorkerSlotPool): string {
  for (let i = 0; i < pool.busy.length; i++) {
    if (!pool.busy[i]) {
      pool.busy[i] = true;
      return formatSlotId(pool, i + 1);
    }
  }
  return `${pool.prefix}-${pool.letter}?`;
}

/**
 * Return the slot to the pool. Tolerant of the fallback id and ids that
 * don't parse cleanly — releasing those is a no-op.
 */
export function releaseWorkerSlot(pool: WorkerSlotPool, slotId: string): void {
  const idx = parseSlotIndex(pool, slotId);
  if (idx < 0 || idx >= pool.busy.length) return;
  pool.busy[idx] = false;
}

function formatSlotId(pool: WorkerSlotPool, oneBasedIndex: number): string {
  // Use 2-digit padding for the common case (pools up to 99). Pools
  // beyond that get the natural width — still readable, just longer.
  const width = pool.busy.length > 99 ? 3 : 2;
  return `${pool.prefix}-${pool.letter}${String(oneBasedIndex).padStart(width, "0")}`;
}

function parseSlotIndex(pool: WorkerSlotPool, slotId: string): number {
  const prefix = `${pool.prefix}-${pool.letter}`;
  if (!slotId.startsWith(prefix)) return -1;
  const tail = slotId.slice(prefix.length);
  if (tail === "?") return -1;
  const n = Number.parseInt(tail, 10);
  if (!Number.isFinite(n) || n < 1) return -1;
  return n - 1;
}
