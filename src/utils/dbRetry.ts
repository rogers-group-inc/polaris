/**
 * src/utils/dbRetry.ts
 *
 * Postgres-deadlock retry helper. Postgres reports SQLSTATE 40P01 when it
 * breaks a deadlock cycle by aborting one participant; the abort is
 * intrinsic to the protocol, not a bug in our code. Re-running the same
 * statement after the contender finishes almost always succeeds.
 *
 * Up to 3 retries with a small jittered backoff so simultaneous deadlock
 * losers don't all retry in lockstep. Surfaces the error untouched on the
 * 4th failure so callers can record it exactly as before.
 *
 * Originally lived inline in src/utils/macAddresses.ts (the bulk MAC
 * reconcile path); factored out here so the sample-write buffer can
 * reuse the same retry shape without duplicating the SQLSTATE-extraction
 * code that has to be defensive about Prisma adapter shapes.
 */

import { sleep } from "./sleep.js";

export async function retryOnDeadlock<T>(op: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await op();
    } catch (err: unknown) {
      const code = extractPgCode(err);
      if (code !== "40P01") throw err;
      lastErr = err;
      const backoffMs = 25 + Math.floor(Math.random() * 75);
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

function extractPgCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  // Prisma surfaces driver errors with the original SQLSTATE under a few
  // possible paths depending on the adapter version. Be defensive about
  // the shape so we don't accidentally swallow non-deadlock errors.
  const e = err as Record<string, unknown>;
  const direct = typeof e.code === "string" ? e.code : null;
  if (direct === "40P01") return "40P01";
  const meta = e.meta as Record<string, unknown> | undefined;
  if (meta) {
    const adapterErr = meta.driverAdapterError as Record<string, unknown> | undefined;
    const cause = adapterErr?.cause as Record<string, unknown> | undefined;
    const originalCode = cause?.originalCode as string | undefined;
    if (originalCode === "40P01") return "40P01";
    const causeCode = cause?.code as string | undefined;
    if (causeCode === "40P01") return "40P01";
  }
  // Last-resort fallback — error messages mention "deadlock detected" too.
  const msg = typeof e.message === "string" ? e.message : "";
  if (msg.includes("deadlock detected")) return "40P01";
  return null;
}
