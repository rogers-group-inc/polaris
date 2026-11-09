/**
 * src/utils/concurrency.ts — the ONE bounded-concurrency mapper (2026-08
 * dedup: fortinetManagementAccessService's queue-shift worker, the two
 * agentInstallService cursor pools, and discoveryEngine's chunked
 * batchSettled each hand-rolled their own). NOT for producer-fed pools —
 * fortimanagerService's discovery dispatch semaphore stays custom because
 * two concurrent producers feed it dynamically; there is no items list to
 * map over.
 */

/**
 * Run `fn` over `items` with at most `limit` in flight. Results come back in
 * input order. FAIL-FAST: rejects on the first `fn` rejection (like
 * Promise.all) and starts no further items after it — calls already in
 * flight run to completion (there is no way to cancel them; pass an
 * AbortSignal into `fn` for that) but their outcome is discarded. Callers
 * that must not fail the whole map should catch inside `fn`, or use
 * mapSettledWithConcurrency (settle-all).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/**
 * Settled variant: never rejects; every item yields a PromiseSettledResult in
 * input order. A rolling window of `limit` in flight (no chunk barrier — a
 * slow item never stalls the items behind it beyond the window).
 */
export async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return mapWithConcurrency(items, limit, async (item, i): Promise<PromiseSettledResult<R>> => {
    try {
      return { status: "fulfilled", value: await fn(item, i) };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  });
}
