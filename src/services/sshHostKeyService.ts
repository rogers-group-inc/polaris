/**
 * src/services/sshHostKeyService.ts — trust-on-first-use pinning for SSH
 * SERVER host keys.
 *
 * THE GAP THIS CLOSES. Polaris passed no `hostVerifier` to ssh2, so every SSH
 * connection accepted whatever host key was presented — the server was never
 * authenticated to the client. That affects three paths equally: agent
 * install/upgrade/uninstall (which SFTPs a script and runs it as root),
 * agentless process collection, and the SSH monitor probe. Anyone able to
 * answer on the target's address could impersonate it and, in the install
 * case, be handed a credential.
 *
 * WHY A TABLE AND NOT Credential.config. Host keys are per-HOST; a credential
 * spans a fleet. One `ssh` credential legitimately reaches thousands of
 * machines, each with its own key.
 *
 * OPT-IN, MIRRORING `verifyTls`. Enabling this globally would break every
 * install whose hosts have never been pinned, so it rides
 * `SshConfig.verifyHostKey`, default OFF, default ON for newly created
 * credentials — exactly the shape the WinRM `verifyTls` remediation used
 * (2026-06-03 review, H1).
 *
 * TOFU IS ONLY AS GOOD AS THE MOMENT YOU PIN. Turning this on against a
 * running fleet pins whatever currently answers; it detects a key CHANGING,
 * not a host that was already impersonated. It is genuinely strong for a
 * greenfield rollout (pin at deploy time, when the host is known-good) and
 * worth saying plainly in the UI rather than implying more than it delivers.
 *
 * HOT PATH. `withSshClient` runs on the per-minute agentless-processes cadence
 * across the fleet, so the lookup is served from a module-level Map and only
 * misses hit Postgres. Same shape as the role-snapshot cache in
 * permissions.ts.
 */

import { createHash } from "node:crypto";

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { logger } from "../utils/logger.js";

export interface SshHostKeyRecord {
  id: string;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  firstSeen: Date;
  lastSeen: Date;
}

export type HostKeyVerdict =
  | { ok: true; outcome: "pinned" | "matched" }
  | { ok: false; outcome: "mismatch"; expected: string; actual: string };

/**
 * OpenSSH-style fingerprint of a raw host-key blob: SHA-256 over the wire
 * bytes, base64, padding stripped. Byte-for-byte what `ssh-keygen -lf` prints,
 * so an operator can compare the two by eye during an investigation.
 */
export function fingerprintKeyBlob(key: Buffer): string {
  return "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

/**
 * Key algorithm from the blob. SSH wire format leads with a length-prefixed
 * string naming the type ("ssh-ed25519", "ecdsa-sha2-nistp256", ...). Purely
 * for display — the fingerprint is what's compared — so a malformed blob
 * degrades to "unknown" rather than failing the connection.
 */
export function keyTypeFromBlob(key: Buffer): string {
  try {
    if (key.length < 4) return "unknown";
    const len = key.readUInt32BE(0);
    // Sanity-bound the declared length before slicing: a hostile or corrupt
    // blob must not drive a huge allocation or read past the buffer.
    if (len <= 0 || len > 64 || key.length < 4 + len) return "unknown";
    const type = key.subarray(4, 4 + len).toString("ascii");
    return /^[\x20-\x7e]+$/.test(type) ? type : "unknown";
  } catch {
    return "unknown";
  }
}

/** Cache key for one dialed endpoint. */
function endpointKey(host: string, port: number): string {
  return `${host}:${port}`;
}

/**
 * host:port → fingerprint. Populated on miss, invalidated on every write.
 * Per-process (like every other cache here); a pin deleted on the web role
 * propagates to a monitor role on its next miss, which is acceptable because
 * deleting a pin only ever RE-OPENS trust for one host.
 */
const pinCache = new Map<string, string>();

/** Throttle `lastSeen` writes — a matched pin otherwise writes on every connect. */
const LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000;
const lastSeenWrites = new Map<string, number>();

export function _resetCaches(): void {
  pinCache.clear();
  lastSeenWrites.clear();
}

/**
 * Drop one endpoint from this process's cache after a pin row was removed or
 * written by another service (business rule 123's archive / reinstate), so the
 * next connection reads the table instead of a fingerprint that is gone.
 */
export function forgetCachedHostKey(host: string, port: number): void {
  const ck = endpointKey(host, port);
  pinCache.delete(ck);
  lastSeenWrites.delete(ck);
}

/**
 * The verification decision. Returns a verdict rather than throwing so the
 * caller (a ssh2 hostVerifier callback) can reject the handshake cleanly.
 *
 * - no pin  → store it and accept  (trust on first use)
 * - match   → accept, refresh lastSeen at most hourly
 * - differ  → REJECT, warn-level Event with both fingerprints
 */
export async function verifyOrPin(host: string, port: number, key: Buffer): Promise<HostKeyVerdict> {
  const actual = fingerprintKeyBlob(key);
  const ck = endpointKey(host, port);

  const cached = pinCache.get(ck);
  if (cached) {
    if (cached === actual) {
      void touchLastSeen(host, port, ck);
      return { ok: true, outcome: "matched" };
    }
    // Fall through to a DB read rather than rejecting straight off the cache:
    // an operator may have just deleted the pin to re-trust a rebuilt host,
    // and this process's cache would not know yet.
  }

  const row = await prisma.sshHostKey.findUnique({ where: { host_port: { host, port } } });

  if (!row) {
    const keyType = keyTypeFromBlob(key);
    try {
      await prisma.sshHostKey.create({ data: { host, port, keyType, fingerprint: actual } });
    } catch {
      // Concurrent first-connects race on the unique index. Re-read: whoever
      // won still has to agree with us, or this is a genuine mismatch.
      const raced = await prisma.sshHostKey.findUnique({ where: { host_port: { host, port } } });
      if (raced && raced.fingerprint !== actual) {
        pinCache.set(ck, raced.fingerprint);
        await reportMismatch(host, port, raced.fingerprint, actual);
        return { ok: false, outcome: "mismatch", expected: raced.fingerprint, actual };
      }
    }
    pinCache.set(ck, actual);
    await logEvent({
      action: "ssh.host_key.pinned",
      resourceType: "ssh-host-key",
      resourceName: ck,
      actor: "system:ssh",
      level: "info",
      message: `Pinned SSH host key for ${ck} (${keyType})`,
      details: { host, port, keyType, fingerprint: actual },
    });
    return { ok: true, outcome: "pinned" };
  }

  pinCache.set(ck, row.fingerprint);

  if (row.fingerprint !== actual) {
    await reportMismatch(host, port, row.fingerprint, actual);
    return { ok: false, outcome: "mismatch", expected: row.fingerprint, actual };
  }

  void touchLastSeen(host, port, ck);
  return { ok: true, outcome: "matched" };
}

async function reportMismatch(host: string, port: number, expected: string, actual: string): Promise<void> {
  await logEvent({
    action: "ssh.host_key.mismatch",
    resourceType: "ssh-host-key",
    resourceName: endpointKey(host, port),
    actor: "system:ssh",
    level: "warning",
    message:
      `SSH host key for ${endpointKey(host, port)} does not match the pinned key — refused the connection. ` +
      `If the host was legitimately rebuilt or re-keyed, delete its pin to trust the new key.`,
    details: { host, port, expectedFingerprint: expected, actualFingerprint: actual },
  }).catch(() => {});
}

/**
 * Refresh `lastSeen`, at most hourly per endpoint. Fire-and-forget: this is
 * bookkeeping for the operator list, and a failed write must never fail a
 * connection that already verified.
 */
async function touchLastSeen(host: string, port: number, ck: string): Promise<void> {
  const now = Date.now();
  const last = lastSeenWrites.get(ck) ?? 0;
  if (now - last < LAST_SEEN_THROTTLE_MS) return;
  lastSeenWrites.set(ck, now);
  try {
    await prisma.sshHostKey.update({
      where: { host_port: { host, port } },
      data: { lastSeen: new Date() },
    });
  } catch (err) {
    logger.debug({ err, host, port }, "ssh host-key lastSeen refresh failed");
  }
}

export async function listHostKeys(): Promise<SshHostKeyRecord[]> {
  const rows = await prisma.sshHostKey.findMany({ orderBy: [{ host: "asc" }, { port: "asc" }] });
  return rows as unknown as SshHostKeyRecord[];
}

/**
 * Forget a pin so the next connection re-pins whatever answers. This is the
 * documented recovery for a legitimately rebuilt or re-keyed host — and the
 * reason it is audited: it deliberately re-opens first-use trust.
 */
export async function deleteHostKey(id: string, actor: string): Promise<void> {
  const row = await prisma.sshHostKey.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "SSH host key pin not found");
  await prisma.sshHostKey.delete({ where: { id } });
  const ck = endpointKey(row.host, row.port);
  pinCache.delete(ck);
  lastSeenWrites.delete(ck);
  await logEvent({
    action: "ssh.host_key.deleted",
    resourceType: "ssh-host-key",
    resourceId: id,
    resourceName: ck,
    actor,
    level: "warning",
    message: `Deleted the pinned SSH host key for ${ck} — the next connection will trust and pin whatever answers`,
    details: { host: row.host, port: row.port, fingerprint: row.fingerprint },
  });
}
