/**
 * src/utils/guardedFetch.ts — business rule 110 for `fetch`: a request whose
 * host an operator chose (webhook / api_call delivery channels) is judged by
 * the address the CONNECTION resolves, not by a lookup done earlier.
 *
 * `resolveAllowedHost` is a check, not a pin: a name that answers a public
 * address to the check and 127.0.0.1 / 169.254.169.254 to the global
 * `fetch`'s own lookup got past the blocklist (2026-10-13 re-scan F82, DNS
 * rebinding). This dispatches through an undici Agent whose connect `lookup`
 * is `netGuard.guardedLookup`, so the refusal happens on the socket. The fetch
 * and the Agent come from ONE undici copy for the reason in tlsDispatcher.ts:
 * a userland Agent handed to Node's global fetch breaks on a major skew.
 *
 * Redirects are the caller's business (the channels pass `redirect: "manual"`).
 */

import { Agent, fetch as undiciFetch, type Dispatcher, type RequestInit, type Response } from "undici";
import { guardedLookup } from "./netGuard.js";

let agent: Agent | null = null;

/** The guarded dispatcher (exported for tests). */
export function guardedDispatcher(): Dispatcher {
  if (!agent) agent = new Agent({ connect: { lookup: guardedLookup() } });
  return agent;
}

/** `fetch`, with every connection's address checked by netGuard when it is made. */
export function guardedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return undiciFetch(url, { ...init, dispatcher: guardedDispatcher() });
}
