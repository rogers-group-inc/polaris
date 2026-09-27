/**
 * src/utils/trailingThrottle.ts
 *
 * Rate-limits a side-effecting async write (a progress flush) WITHOUT losing
 * the final state. A plain leading-edge throttle drops every call inside the
 * window, so when the last event of a burst lands there, nothing ever writes
 * it — whatever the previous write saw stays on record indefinitely. That is
 * how a discovery run's last FortiGates stayed "active" on the DiscoveryRun
 * row through the minutes-long finalize pass and were flagged slow every run.
 *
 * Guarantees:
 *  - a call inside the window schedules ONE trailing run at the window's end;
 *  - `force` runs now (and absorbs any pending trailing run);
 *  - runs are serialized, so a slow write can never land after a newer one;
 *  - `stop()` cancels the pending run, refuses later calls and resolves once
 *    the in-flight write has settled — await it before a terminal write that
 *    a late progress write must not follow.
 *
 * `fn` should read live state when it runs rather than capture it at call
 * time; a coalesced run then writes the newest state, not a stale one.
 */

export interface TrailingThrottle {
  call(force?: boolean): void;
  stop(): Promise<void>;
}

export function createTrailingThrottle(fn: () => Promise<void>, intervalMs: number): TrailingThrottle {
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();

  const run = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    last = Date.now();
    chain = chain.then(fn).catch(() => {});
  };

  return {
    call(force = false) {
      if (stopped) return;
      const wait = intervalMs - (Date.now() - last);
      if (force || wait <= 0) {
        run();
        return;
      }
      if (!timer) timer = setTimeout(run, wait);
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await chain;
    },
  };
}
