/**
 * src/utils/timeout.ts — the ONE promise-deadline wrapper (CQ-B029: the
 * pathCheckServerRunner and serverTraceroute copies, and the ad-hoc
 * Promise.race timeouts in applicationMapService, automationTestService and
 * readinessCheck, each hand-rolled their own; two never cleared their timer).
 *
 * Contract:
 *   - resolves / rejects with `p` when it settles first;
 *   - rejects with a TimeoutError (`<what> timed out after <ms> ms`) when the
 *     deadline passes first;
 *   - ALWAYS clears its timer once the race is decided, and unrefs it, so a
 *     pending deadline never holds the event loop open;
 *   - does NOT cancel the underlying work: `p` keeps running after a timeout.
 *     Work that must stop needs an AbortSignal of its own.
 *
 * Callers that want a sentinel instead of a rejection test
 * `err instanceof TimeoutError` in their catch.
 *
 * NOT for sites whose timer kills a child process or destroys a socket
 * (remoteExec, eventArchiveService, deviceHttp, pathCheckServerRunner's TCP
 * probe) — those time out the work itself, not a promise.
 */

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number, what = "operation"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
