/**
 * src/utils/endpointTokens.ts — the bearer gates on /health, /health/ready and
 * /metrics (HEALTH_TOKEN / METRICS_TOKEN).
 *
 * THE readers of both variables and THE comparison every gate uses (the web
 * role's three routes in app.ts and the per-role metrics-only listener).
 * Before 2026-11-06 (CQ-B042) each gate read the raw variable and compared with
 * `===`, while the Capacity Advisor trimmed before deciding "unset":
 *
 *  - a whitespace-only token read as UNSET to the advisor ("endpoint open")
 *    while the gates demanded it verbatim, refusing every real client;
 *  - a token with surrounding spaces (a quoted .env value, a systemd
 *    Environment= line) matched no client sending the token itself;
 *  - `===` returns at the first differing byte, so response timing leaked how
 *    much of a guess was right.
 *
 * Now: trimmed, blank = unset (the endpoint is open, and the advisor says so),
 * compared in constant time. dotenv already trims unquoted values, so a plain
 * `.env` line reads exactly as before.
 *
 * Read on every call, never cached: Server Settings → "Generate token" sets
 * the variable at runtime and the web role's gate takes it on the next request.
 */

import { createHash, timingSafeEqual } from "node:crypto";

function readToken(name: "HEALTH_TOKEN" | "METRICS_TOKEN"): string | null {
  const v = (process.env[name] ?? "").trim();
  return v || null;
}

/** HEALTH_TOKEN, trimmed; null = unset or blank (/health and /health/ready are open). */
export function healthToken(): string | null {
  return readToken("HEALTH_TOKEN");
}

/** METRICS_TOKEN, trimmed; null = unset or blank (/metrics is open). */
export function metricsToken(): string | null {
  return readToken("METRICS_TOKEN");
}

/**
 * Does an `Authorization` header satisfy the gate? No expected token = open
 * (true). Otherwise the header must be `Bearer <token>` with the token equal
 * in constant time. Both sides are hashed first so the comparison runs over
 * equal-length buffers whatever was supplied (timingSafeEqual throws on a
 * length mismatch, and an early length check would leak the length).
 */
export function bearerSatisfies(authorization: string | undefined | null, expected: string | null): boolean {
  if (!expected) return true;
  const auth = authorization || "";
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = createHash("sha256").update(supplied, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
