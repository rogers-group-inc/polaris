/**
 * src/services/capacityDbIo.ts
 *
 * Pure disk-read-pressure rate math, split out from capacityService.ts so it
 * can be unit-tested without dragging in the service's heavy import graph
 * (prisma, queueService → pg-boss optional dep, etc.).
 *
 * The signal: PostgreSQL's `pg_stat_database.blk_read_time` is the cumulative
 * time spent inside read() syscalls. We sample it between successive capacity
 * snapshots and turn the delta into a rate. Measuring *time* (not block count)
 * is what makes this medium-aware for free — a cache miss costs ~5-10ms on a
 * spinning disk, ~0.02ms on NVMe, and ~0ms when the page is in the OS page
 * cache — so the signal is high only when reads are both frequent AND slow.
 *
 * blk_read_time is only populated when `track_io_timing = on`; callers handle
 * the off case separately (they can't measure, so they nudge the operator to
 * enable it rather than guessing).
 */

/** Raw cumulative-since-reset counters from pg_stat_database for the DB. */
export interface DbIoReading {
  /** Wall-clock ms (DB-side clock_timestamp) when the counters were read. */
  nowMs: number;
  blksRead: number;
  blksHit: number;
  /** Cumulative ms spent in read() syscalls (0 when track_io_timing is off). */
  blkReadTime: number;
  trackIoTiming: boolean;
}

/** Derived rate verdict computed from two readings. */
export interface DbIoVerdict {
  /** False on first call, too-short a window, or a stats reset — don't alarm. */
  measured: boolean;
  /** Δblk_read_time(ms) / Δelapsed(ms): avg connections continuously blocked
   *  on storage reads over the window. Null when not measured. */
  avgBackendsBlockedOnDisk: number | null;
  windowSeconds: number | null;
}

// Below this window the rate is too noisy to trust (cold start, or a Maintenance
// tab refresh moments after a capacityWatch tick).
export const MIN_IO_WINDOW_MS = 30_000;
// How long a measured verdict stays usable for sub-window calls (Maintenance
// tab refreshes between the 10-min capacityWatch ticks) before we treat the
// reading as stale and report unmeasured.
export const IO_VERDICT_STALE_MS = 20 * 60_000;
// Watch when, on average, at least half a connection was continuously blocked
// on storage reads across the window; warning at two. Tunable here only.
export const DB_IO_WATCH_BACKENDS = 0.5;
export const DB_IO_WARNING_BACKENDS = 2.0;
// A window that starts inside this much process uptime is discarded. The web
// role's boot path deliberately reads cold data — the compression self-heal
// compresses whole week-old backlog chunks (95 s on one prod chunk), and the
// hourly/daily rollups fire catch-up ticks at 60 s / 90 s — and the first
// window after a restart is also the shortest one, so it read as "add RAM"
// on a host with 37 GB available (prod 2026-10-15).
export const DB_IO_BOOT_GRACE_MS = 10 * 60_000;
// "Add RAM" is only advice when the DB host is actually short of it: below
// this fraction of total memory available (MemAvailable on Linux — page cache
// counts as available, since the kernel gives it back on demand).
export const DB_IO_LOW_AVAILABLE_RATIO = 0.15;

/**
 * True when a measured window began inside the boot grace — i.e. it overlaps
 * the web role's startup maintenance. Uses process uptime rather than the
 * DB-side clock so a remote DB's clock skew can't move the boundary.
 */
export function ioWindowInBootGrace(uptimeMs: number, windowSeconds: number): boolean {
  return uptimeMs - windowSeconds * 1000 < DB_IO_BOOT_GRACE_MS;
}

export interface DbIoAdviceInput {
  avgBackendsBlockedOnDisk: number;
  windowSeconds: number | null;
  databaseBytes: number;
  totalMemoryBytes: number;
  /** os.freemem() — MemAvailable on Linux, so it includes reclaimable page cache. */
  availableMemoryBytes: number;
  /** Is PostgreSQL on this host? When not, our memory figures say nothing about its cache. */
  dbColocated: boolean;
  formatBytes: (n: number) => string;
}

/**
 * Message + suggestion for the `db_io_pressure` reason. Pure. Measured read
 * wait proves reads are slow, not that RAM is short: with plenty of memory
 * available the page cache already has room, so the reads are of data that
 * was never cached (old chunks, long-range history) and more RAM wouldn't
 * have held it. Only a low-available co-located host gets the RAM advice.
 */
export function dbIoPressureAdvice(i: DbIoAdviceInput): { message: string; suggestion: string } {
  const mins = i.windowSeconds ? Math.round(i.windowSeconds / 60) : null;
  const windowText = mins && mins >= 1 ? ` over the last ${mins} min` : "";
  const fb = i.formatBytes;
  const ramText = i.dbColocated
    ? `host RAM ${fb(i.totalMemoryBytes)}, ${fb(i.availableMemoryBytes)} available`
    : `database on a separate host`;
  const message =
    `Disk I/O is high — PostgreSQL is spending significant time reading from storage rather than serving from cache ` +
    `(avg ${i.avgBackendsBlockedOnDisk.toFixed(1)} connection(s) blocked on disk${windowText}; ${ramText}, database ${fb(i.databaseBytes)}).`;
  const levers =
    "Narrowing the monitored-interface selection (each integration's Monitoring tab) is often the biggest lever — only pinned interfaces keep a time-series, so fewer pins means fewer rows written AND a smaller working set competing for cache. Faster storage (NVMe) or lower sample retention also reduce disk reads; the Capacity Advisor card surfaces the retention and cadence levers.";

  if (!i.dbColocated) {
    return {
      message,
      suggestion:
        "Polaris can't see the database host's memory from here. Check its available memory first: if it is low, more RAM keeps more of the working set cached; if plenty is available, the reads are of data that was never cached and RAM won't help. " +
        levers,
    };
  }
  const lowAvailable =
    i.totalMemoryBytes > 0 && i.availableMemoryBytes / i.totalMemoryBytes < DB_IO_LOW_AVAILABLE_RATIO;
  if (lowAvailable) {
    return { message, suggestion: "Consider adding RAM so more of the working set stays cached. " + levers };
  }
  return {
    message,
    suggestion:
      `RAM isn't the constraint — ${fb(i.availableMemoryBytes)} of ${fb(i.totalMemoryBytes)} is available, and the OS page cache already uses it to hold the database. ` +
      "Reads this slow with memory to spare are of data that was never cached: long-range history queries, a backup, or compression and rollup catching up. If it persists, look at what is reading — pg_stat_activity rows with wait_event_type = 'IO'. " +
      levers,
  };
}

/**
 * Pure rate computation. Returns measured:false (so callers won't alarm) on the
 * first reading, a too-short window, or a counter reset (current < prev, i.e.
 * `pg_stat_reset` / crash recovery), in which case the caller rebases its
 * previous reading to the current one.
 */
export function deriveDbIoVerdict(prev: DbIoReading | null, current: DbIoReading): DbIoVerdict {
  const unmeasured: DbIoVerdict = { measured: false, avgBackendsBlockedOnDisk: null, windowSeconds: null };
  if (!prev) return unmeasured;
  const elapsedMs = current.nowMs - prev.nowMs;
  if (elapsedMs < MIN_IO_WINDOW_MS) return unmeasured;
  // Stats reset / counter rollback — any going backwards invalidates the delta.
  if (
    current.blkReadTime < prev.blkReadTime ||
    current.blksRead < prev.blksRead ||
    current.blksHit < prev.blksHit
  ) {
    return unmeasured;
  }
  const deltaReadTimeMs = current.blkReadTime - prev.blkReadTime;
  return {
    measured: true,
    avgBackendsBlockedOnDisk: deltaReadTimeMs / elapsedMs,
    windowSeconds: elapsedMs / 1000,
  };
}
