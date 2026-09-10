/**
 * src/utils/tlsDispatcher.ts
 *
 * Per-request TLS-verification control for callers that talk to devices with
 * self-signed certificates (FortiGate / FortiManager with `verifySsl: false`).
 *
 * The original approach — flipping `process.env.NODE_TLS_REJECT_UNAUTHORIZED`
 * around each request and restoring it in `finally` — mutated PROCESS-GLOBAL
 * state: with parallel request chains (fortigateService fires seven per
 * discovery device) the set/restore interleaves, and any unrelated in-flight
 * TLS connection in the same process (Graph, vCenter, SMTP...) could run
 * unverified during the window. An undici dispatcher scopes the relaxation to
 * exactly the connections that opted in, the way dnsService/winrm already
 * pass `rejectUnauthorized` per socket.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `tlsFetch` EXISTS AND WHY NOTHING MAY CALL THE GLOBAL `fetch` WITH THIS
 * DISPATCHER.
 *
 * A dispatcher is only valid to the undici copy that CREATED it. Node's global
 * `fetch` is served by the undici BUNDLED INTO NODE (`process.versions.undici`
 * — 7.24.4 on Node 24.14.1), while `import ... from "undici"` is the userland
 * dependency in package.json (8.x). undici 8 rewrote the dispatcher handler
 * interface (`onRequestStart`/`onResponseStart` replaced
 * `onConnect`/`onHeaders`), so a v8 Agent handed to the v7 fetch REJECTS the
 * handler that fetch gives it:
 *
 *     TypeError: fetch failed
 *       cause: UND_ERR_INVALID_ARG — invalid onRequestStart method
 *
 * That is what shipped on 2026-09-09: `chore(deps): undici 8` moved the
 * userland range 6 -> 8 while Node kept bundling 7, and every FortiManager and
 * standalone-FortiGate request with `verifySsl: false` — the connection test,
 * discovery, DHCP/quarantine push, response-time probes — failed at the
 * transport with a code no operator can act on. It reached production because
 * the pairing was only ever exercised against a STUBBED global fetch, so the
 * Agent was never actually dispatched in a test. Integrations that don't relax
 * TLS were unaffected, which made it look integration-specific rather than
 * dependency-level.
 *
 * So the fetch and the Agent are taken from ONE undici here, and callers get
 * `tlsFetch` instead of assembling the pair themselves. Do NOT reintroduce
 * `globalThis.fetch(url, { dispatcher: insecureTlsDispatcher() })` — it is a
 * bug whenever the userland undici major differs from Node's bundled one, and
 * nothing in `npm test`, `npm run typecheck` or `npm audit` reports it.
 * `tests/unit/tlsDispatcher.test.ts` dispatches through a real local server so
 * the next such skew fails a test instead of a device.
 *
 * The insecure agent is a lazily-created singleton so opted-in hosts still
 * get connection pooling/keep-alive across requests.
 */

import { Agent, fetch as undiciFetch, type Dispatcher, type RequestInit, type Response } from "undici";

let insecureAgent: Agent | null = null;

/**
 * Dispatcher that skips TLS certificate verification.
 *
 * Exported for tests only. Production callers use `tlsFetch` — see the header:
 * this Agent is valid ONLY to the userland undici's `fetch`, never the global.
 */
export function insecureTlsDispatcher(): Dispatcher {
  if (!insecureAgent) {
    insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return insecureAgent;
}

/**
 * `fetch` for device transports that may need TLS verification relaxed.
 *
 * Always undici's own `fetch`, so the dispatcher below is guaranteed to come
 * from the same undici that will dispatch it. `verifySsl === false` opts this
 * ONE connection out of certificate verification; anything else (true or
 * undefined) verifies normally on undici's default global dispatcher.
 */
export function tlsFetch(
  url: string,
  init: RequestInit,
  verifySsl: boolean | undefined,
): Promise<Response> {
  return undiciFetch(url, {
    ...init,
    ...(verifySsl === false ? { dispatcher: insecureTlsDispatcher() } : {}),
  });
}
