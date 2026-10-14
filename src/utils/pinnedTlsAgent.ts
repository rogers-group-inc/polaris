/**
 * src/utils/pinnedTlsAgent.ts — business rule 113: an HTTPS agent that
 * decides whether to trust the server AFTER the TLS handshake and BEFORE the
 * request is written.
 *
 * Node's `checkServerIdentity` cannot do this job: it is skipped whenever the
 * chain itself fails to verify (every self-signed certificate), and it is
 * synchronous while a pin lookup is a database read. So the agent opens the
 * TLS socket itself in `createConnection`, waits for `secureConnect`, hands the
 * leaf certificate to an async `check`, and only then gives the socket to the
 * request — which is when the request's headers (the Basic-auth password, the
 * bearer token, the login form) are first written. A refused check destroys
 * the socket and fails the request with a `CertPinRefusedError`; nothing was
 * sent.
 *
 * TLS session resumption is disabled (`maxCachedSessions: 0`) so every
 * connection presents a full certificate to check, and sockets are not kept
 * alive, so each request is checked. Chain verification is OFF on this agent
 * by design: the pin replaces it. A caller that verifies the CA chain
 * (`verifyTls: true`) uses an ordinary request instead.
 */

import { Agent as HttpsAgent, type AgentOptions } from "node:https";
import { connect as tlsConnect, type PeerCertificate, type ConnectionOptions } from "node:tls";
import type { Duplex } from "node:stream";

export type CertCheckVerdict = { ok: true } | { ok: false; reason: string };
export type CertCheck = (cert: PeerCertificate) => Promise<CertCheckVerdict>;

/** The request failed because the server's certificate was refused — no credential was sent. */
export class CertPinRefusedError extends Error {
  readonly code = "CERT_PIN_REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "CertPinRefusedError";
  }
}

export class PinnedTlsAgent extends HttpsAgent {
  private readonly check: CertCheck;

  constructor(check: CertCheck, opts: AgentOptions = {}) {
    super({ ...opts, keepAlive: false, maxCachedSessions: 0 });
    this.check = check;
  }

  createConnection(options: ConnectionOptions, callback?: (err: Error | null, stream: Duplex) => void): Duplex | undefined {
    let settled = false;
    const done = (err: Error | null, socket: Duplex): void => {
      if (settled) return;
      settled = true;
      callback?.(err, socket);
    };
    const socket = tlsConnect({ ...options, rejectUnauthorized: false, session: undefined });
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate(false);
      if (!cert || !cert.fingerprint256) {
        socket.destroy();
        done(new CertPinRefusedError("The server presented no certificate"), socket);
        return;
      }
      this.check(cert).then(
        (v) => {
          if (v.ok) { done(null, socket); return; }
          socket.destroy();
          done(new CertPinRefusedError(v.reason), socket);
        },
        (err: unknown) => {
          // Fail closed: an internal error never yields an unchecked connection.
          socket.destroy();
          done(new CertPinRefusedError(`Could not check the server certificate: ${err instanceof Error ? err.message : String(err)}`), socket);
        },
      );
    });
    socket.once("error", (err) => done(err, socket));
    // Returning undefined tells the http Agent to wait for the callback.
    return undefined;
  }
}

/**
 * The standard check: trust-on-first-use against tlsCertPinService for the
 * dialed host:port, optionally after a caller-specific `precheck` (the
 * firmware engines' Fortinet serial test). The service import is dynamic to
 * keep this util free of a static service edge, like remoteExec's host-key
 * verifier.
 */
export function pinnedAgentFor(
  host: string,
  port: number,
  opts: { precheck?: (cert: PeerCertificate) => CertCheckVerdict; agentOptions?: AgentOptions } = {},
): PinnedTlsAgent {
  return new PinnedTlsAgent(async (cert) => {
    const pre = opts.precheck?.(cert);
    if (pre && !pre.ok) return pre;
    const { verifyOrPinCert } = await import("../services/tlsCertPinService.js");
    const subject = typeof cert.subject?.CN === "string" ? cert.subject.CN : Array.isArray(cert.subject?.CN) ? cert.subject.CN.join(",") : "";
    const verdict = await verifyOrPinCert(host, port, cert.fingerprint256, subject);
    return verdict.ok
      ? { ok: true }
      : { ok: false, reason: `The TLS certificate of ${host}:${port} changed since it was pinned — refused before sending any credential. Compare and trust the new certificate under Server Settings → Web Server → Pinned server identities if it was re-issued.` };
  }, opts.agentOptions);
}
