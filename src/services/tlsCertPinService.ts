/**
 * src/services/tlsCertPinService.ts — business rule 113: trust-on-first-use
 * pinning of the TLS certificate a server presents, for HTTPS connections
 * that carry a secret without verifying a CA chain.
 *
 * WHO USES IT. WinRM over HTTPS (Basic auth with a Windows password, and the
 * agent enrollment token the installer embeds) and the firmware engines
 * (FortiGate / FortiSwitch / FortiAP device logins and FortiOS API tokens).
 * Their servers almost always present self-signed certificates, so CA
 * verification (`verifyTls: true`) is the exception; before this rule the
 * default was to accept ANY certificate and send the secret to whoever
 * answered.
 *
 * WHAT IT DECIDES. The first connection to host:port pins the leaf
 * certificate's SHA-256 fingerprint; later connections must present the same
 * certificate or are refused, with a warning Event naming both fingerprints.
 * The decision is made in `utils/pinnedTlsAgent.ts`, after the TLS handshake
 * and BEFORE the request carrying the secret is written. Deleting a pin is the
 * recovery for a legitimately re-issued certificate (it re-opens first-use
 * trust, so it is audited).
 *
 * TOFU IS ONLY AS GOOD AS THE MOMENT YOU PIN — the same caveat as
 * sshHostKeyService: this detects a certificate CHANGING, not a server that
 * was already impersonated when it was first pinned.
 *
 * Same shape as sshHostKeyService on purpose (per-process cache, hourly
 * lastSeen throttle, race-safe first pin); the two lists are shown together as
 * "Pinned server identities".
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { logger } from "../utils/logger.js";

export interface TlsCertPinRecord {
  id: string;
  host: string;
  port: number;
  fingerprint: string;
  subject: string;
  firstSeen: Date;
  lastSeen: Date;
}

export type CertPinVerdict =
  | { ok: true; outcome: "pinned" | "matched" }
  | { ok: false; outcome: "mismatch"; expected: string; actual: string };

function endpointKey(host: string, port: number): string {
  return `${host}:${port}`;
}

/** host:port → fingerprint. Populated on miss, invalidated on every write. */
const pinCache = new Map<string, string>();
const LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000;
const lastSeenWrites = new Map<string, number>();

export function _resetCaches(): void {
  pinCache.clear();
  lastSeenWrites.clear();
}

/** Fingerprints compare case- and separator-insensitively ("AA:BB" ≡ "aabb"). */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/[^0-9a-f]/gi, "").toUpperCase();
}

/**
 * The verification decision for one presented certificate.
 *
 * - no pin  → store it and accept (trust on first use)
 * - match   → accept, refresh lastSeen at most hourly
 * - differ  → REJECT, warning Event with both fingerprints
 */
export async function verifyOrPinCert(host: string, port: number, fingerprint256: string, subject = ""): Promise<CertPinVerdict> {
  const actual = normalizeFingerprint(fingerprint256);
  const ck = endpointKey(host, port);

  const cached = pinCache.get(ck);
  if (cached === actual) {
    void touchLastSeen(host, port, ck);
    return { ok: true, outcome: "matched" };
  }
  // A cached mismatch falls through to a DB read: an operator may have just
  // deleted the pin to re-trust a re-issued certificate.

  const row = await prisma.tlsCertPin.findUnique({ where: { host_port: { host, port } } });
  if (!row) {
    try {
      await prisma.tlsCertPin.create({ data: { host, port, fingerprint: actual, subject: subject.slice(0, 500) } });
    } catch {
      // Concurrent first connects race on the unique index; whoever won still
      // has to agree with us, or this is a genuine mismatch.
      const raced = await prisma.tlsCertPin.findUnique({ where: { host_port: { host, port } } });
      if (raced && raced.fingerprint !== actual) {
        pinCache.set(ck, raced.fingerprint);
        await reportMismatch(host, port, raced.fingerprint, actual, subject);
        return { ok: false, outcome: "mismatch", expected: raced.fingerprint, actual };
      }
    }
    pinCache.set(ck, actual);
    await logEvent({
      action: "tls.cert.pinned",
      resourceType: "tls-cert-pin",
      resourceName: ck,
      actor: "system:tls",
      level: "info",
      message: `Pinned the TLS certificate of ${ck}${subject ? ` (${subject})` : ""}`,
      details: { host, port, fingerprint: actual, subject },
    });
    return { ok: true, outcome: "pinned" };
  }

  pinCache.set(ck, row.fingerprint);
  if (row.fingerprint !== actual) {
    await reportMismatch(host, port, row.fingerprint, actual, subject);
    return { ok: false, outcome: "mismatch", expected: row.fingerprint, actual };
  }
  void touchLastSeen(host, port, ck);
  return { ok: true, outcome: "matched" };
}

async function reportMismatch(host: string, port: number, expected: string, actual: string, subject: string): Promise<void> {
  await logEvent({
    action: "tls.cert.mismatch",
    resourceType: "tls-cert-pin",
    resourceName: endpointKey(host, port),
    actor: "system:tls",
    level: "warning",
    message:
      `The TLS certificate of ${endpointKey(host, port)} does not match the pinned certificate — refused the connection before sending any credential. ` +
      `If the certificate was legitimately re-issued, delete its pin to trust the new one.`,
    details: { host, port, expectedFingerprint: expected, actualFingerprint: actual, subject },
  }).catch(() => {});
}

async function touchLastSeen(host: string, port: number, ck: string): Promise<void> {
  const now = Date.now();
  if (now - (lastSeenWrites.get(ck) ?? 0) < LAST_SEEN_THROTTLE_MS) return;
  lastSeenWrites.set(ck, now);
  try {
    await prisma.tlsCertPin.update({ where: { host_port: { host, port } }, data: { lastSeen: new Date() } });
  } catch (err) {
    logger.debug({ err, host, port }, "tls cert pin lastSeen refresh failed");
  }
}

export async function listCertPins(): Promise<TlsCertPinRecord[]> {
  return prisma.tlsCertPin.findMany({ orderBy: [{ host: "asc" }, { port: "asc" }] });
}

/**
 * Forget a pin so the next connection re-pins whatever answers — the recovery
 * for a re-issued certificate, audited because it re-opens first-use trust.
 */
export async function deleteCertPin(id: string, actor: string): Promise<void> {
  const row = await prisma.tlsCertPin.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "TLS certificate pin not found");
  await prisma.tlsCertPin.delete({ where: { id } });
  const ck = endpointKey(row.host, row.port);
  pinCache.delete(ck);
  lastSeenWrites.delete(ck);
  await logEvent({
    action: "tls.cert.deleted",
    resourceType: "tls-cert-pin",
    resourceId: id,
    resourceName: ck,
    actor,
    level: "warning",
    message: `Deleted the pinned TLS certificate for ${ck} — the next connection will trust and pin whatever answers`,
    details: { host: row.host, port: row.port, fingerprint: row.fingerprint, subject: row.subject },
  });
}
