/**
 * src/utils/fortinetConnectionError.ts
 *
 * What a FortiGate or FortiManager connection test says when the request
 * never got an answer. Both integrations' testConnection() used the same
 * mapping, copied (CQ-B034); each still owns what follows a null here —
 * FortiGate's AppError message, either one's last-resort err.message.
 */

const TLS_CERT_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * The operator-facing message for a fetch that failed to connect, or null
 * when `err` is not one (an HTTP error, an AppError, a parse failure — the
 * caller's own handling). `port` falls back to 443 in the message.
 */
export function fortinetConnectionErrorMessage(err: any, host: string, port: number | undefined): string | null {
  const code = err?.cause?.code;
  if (code === "ECONNREFUSED") return `Connection refused — ${host}:${port || 443}`;
  if (code === "ENOTFOUND") return `Host not found — ${host}`;
  if (code === "ETIMEDOUT" || err?.name === "TimeoutError") return `Connection timed out — ${host}:${port || 443}`;
  if (err?.message === "fetch failed" && err.cause) {
    if (TLS_CERT_CODES.has(code)) return `TLS certificate error (${code}) — try disabling SSL verification`;
    return err.cause?.message || err.message;
  }
  return null;
}
