/**
 * src/services/notificationChannels/apiCallChannel.ts
 *
 * Outbound HTTP dispatch for the `api_call` automation action. Unlike the
 * channel senders around it, there is no NotificationChannel row — the whole
 * request spec (method/url/headers/body) rides on the NotificationDelivery
 * row's meta, rendered at fire time by automationActionService.
 *
 * SSRF guard: the URL host is re-checked against netGuard's blocked-range
 * list at send time (it was also checked at rule save — the re-check covers
 * rules edited around the guard, e.g. restored backups). Throws on a non-2xx
 * response so the delivery drain records `failed` + retries (≤3).
 *
 * SECURITY: headers are operator-typed secrets — sealed at rest on the rule,
 * group and delivery row and masked in API responses (business rule 114(h));
 * they arrive here already opened by the read pass. Response bodies are
 * never stored; failures keep only the status line (error text capped by the
 * drain).
 */

import { AppError } from "../../utils/errors.js";
import { assertOutboundHostAllowed, resolveAllowedHost } from "../../utils/netGuard.js";
import { guardedFetch } from "../../utils/guardedFetch.js";

export interface ApiCallSpec {
  method: string; // GET | POST | PUT | PATCH | DELETE (validated at save)
  url: string;
  headers?: Record<string, string>;
  body?: string; // pre-rendered at fire time; absent for body-less calls
  timeoutSec?: number; // 1–60; default 15
}

const DEFAULT_TIMEOUT_SEC = 15;
const MAX_TIMEOUT_SEC = 60;

export async function sendApiCall(spec: ApiCallSpec): Promise<{ status: number }> {
  let host: string;
  try {
    host = new URL(spec.url).hostname;
  } catch {
    throw new AppError(400, `Invalid api_call URL: ${spec.url}`);
  }
  assertOutboundHostAllowed(host); // throws BLOCKED_HOST for internal/metadata ranges
  await resolveAllowedHost(host); // ...and for a name that resolves into one (rule 110)

  const method = (spec.method || "POST").toUpperCase();
  const timeoutMs = Math.min(Math.max(spec.timeoutSec ?? DEFAULT_TIMEOUT_SEC, 1), MAX_TIMEOUT_SEC) * 1000;

  const headers: Record<string, string> = { ...(spec.headers ?? {}) };
  const hasBody = spec.body !== undefined && method !== "GET";
  if (hasBody && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // guardedFetch: the address is checked again on the connection itself
    // (rule 110, re-scan F82) — the lookup above is only the early, readable refusal.
    const res = await guardedFetch(spec.url, {
      method,
      headers,
      ...(hasBody ? { body: spec.body } : {}),
      // A redirect would carry the request to a host the guard never saw.
      redirect: "manual",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new AppError(502, `api_call ${method} failed: HTTP ${res.status}`);
    }
    return { status: res.status };
  } finally {
    clearTimeout(timeout);
  }
}
