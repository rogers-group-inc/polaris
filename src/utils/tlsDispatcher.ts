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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `verifySsl: false` IS NOT "TRUST ANYTHING" (business rule 113(e), 2026-10-14,
 * re-scan F10/F66). Every FortiOS and FortiManager request carries a bearer
 * token — for a FortiManager in direct mode, the FLEET-WIDE FortiGate token —
 * and with verification off it used to go to whatever answered. `tlsFetch`
 * now dispatches those requests through `pinnedTlsDispatcher`: its connector
 * completes the TLS handshake without a CA check, hands the leaf certificate
 * to the trust-on-first-use pin (`services/tlsCertPinService.verifyOrPinCert`,
 * keyed on the dialed host:port) and gives undici the socket only when the pin
 * agrees — so a refused certificate fails the request before a header is
 * written. Pooled sockets were checked when they connected, so keep-alive
 * still works; each NEW connection is checked. `insecureTlsDispatcher` stays
 * for tests only.
 */

import { Agent, buildConnector, fetch as undiciFetch, type Dispatcher, type RequestInit, type Response } from "undici";
import type { TLSSocket } from "node:tls";
import { CertPinRefusedError } from "./pinnedTlsAgent.js";

let insecureAgent: Agent | null = null;
let pinnedAgent: Agent | null = null;

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

/** The leaf certificate's subject CN, for the pin's display. */
function subjectOf(cert: { subject?: Record<string, unknown> } | null | undefined): string {
  const cn = cert?.subject?.CN;
  return typeof cn === "string" ? cn : Array.isArray(cn) ? cn.join(",") : "";
}

/**
 * Dispatcher that skips CA verification but PINS the certificate (rule
 * 113(e)): trust on first use per host:port, refuse a changed certificate
 * before anything is sent. Same undici copy as `tlsFetch` (see the header).
 */
export function pinnedTlsDispatcher(): Dispatcher {
  if (!pinnedAgent) {
    // No TLS session resumption: a resumed session presents no certificate to
    // check (getPeerCertificate is empty), the same reason PinnedTlsAgent sets
    // maxCachedSessions: 0. Every NEW connection is a full handshake.
    const raw = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 });
    pinnedAgent = new Agent({
      connect: (opts, callback) => {
        raw(opts, (err, socket) => {
          if (err || !socket) { callback(err ?? new Error("TLS connection failed"), null); return; }
          // A plain-http URL has no certificate to pin (and no CA check was
          // skipped); only an https connection is the pin's business.
          if (opts.protocol !== "https:") { callback(null, socket); return; }
          const tlsSocket = socket as unknown as TLSSocket;
          const cert = typeof tlsSocket.getPeerCertificate === "function" ? tlsSocket.getPeerCertificate(false) : null;
          if (!cert || !cert.fingerprint256) {
            socket.destroy();
            callback(new CertPinRefusedError("The server presented no certificate"), null);
            return;
          }
          const host = String(opts.hostname ?? "");
          const port = Number(opts.port) || 443;
          import("../services/tlsCertPinService.js")
            .then(({ verifyOrPinCert }) => verifyOrPinCert(host, port, cert.fingerprint256, subjectOf(cert as never)))
            .then(
              (v) => {
                if (v.ok) { callback(null, socket); return; }
                socket.destroy();
                callback(new CertPinRefusedError(
                  `The TLS certificate of ${host}:${port} changed since it was pinned — refused before sending the API token. Compare and trust the new certificate under Server Settings → Web Server → Pinned server identities if it was re-issued.`,
                ), null);
              },
              (e: unknown) => {
                // Fail closed: an internal error never yields an unchecked connection.
                socket.destroy();
                callback(new CertPinRefusedError(`Could not check the server certificate: ${e instanceof Error ? e.message : String(e)}`), null);
              },
            );
        });
      },
    });
  }
  return pinnedAgent;
}

/**
 * `fetch` for device transports that may need TLS verification relaxed.
 *
 * Always undici's own `fetch`, so the dispatcher below is guaranteed to come
 * from the same undici that will dispatch it. `verifySsl === false` replaces
 * CA verification with the certificate PIN for this connection (rule 113(e));
 * anything else (true or undefined) verifies the CA chain normally on undici's
 * default global dispatcher.
 */
export function tlsFetch(
  url: string,
  init: RequestInit,
  verifySsl: boolean | undefined,
): Promise<Response> {
  return undiciFetch(url, {
    ...init,
    ...(verifySsl === false ? { dispatcher: pinnedTlsDispatcher() } : {}),
  });
}
