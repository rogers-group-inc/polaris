/**
 * src/utils/fetchOr502.ts — `fetch` for an outbound delivery call whose
 * network failure must reach the caller as a 502 `AppError` with the reason,
 * not as a raw TypeError the error handler turns into a bare 500 "Internal
 * server error" (the channel Test buttons, 2026-11-14).
 *
 * A response of any status is returned untouched — the caller still reads
 * `res.ok` and words its own HTTP failure. Only a request that never got a
 * response (DNS, refused, reset, TLS, abort) is converted.
 */
import { AppError } from "./errors.js";

export async function fetchOr502(label: string, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err instanceof AppError) throw err;
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const reason = e?.name === "AbortError"
      ? "timed out"
      : e?.cause?.code || e?.cause?.message || e?.message || "network error";
    throw new AppError(502, `${label} failed: ${String(reason).split(/\r?\n/)[0]}`);
  }
}
