/**
 * src/services/tlsCertPinService.ts — business rule 113: trust-on-first-use
 * pinning of the TLS certificate a server presents, for HTTPS connections
 * that carry a secret without verifying a CA chain.
 *
 * WHO USES IT. WinRM over HTTPS (Basic auth with a Windows password, and the
 * agent enrollment token the installer embeds), the firmware engines
 * (FortiGate / FortiSwitch / FortiAP device logins and FortiOS API tokens),
 * and since 2026-10-14 (rule 113(e), re-scan F6/F7/F10/F66) every FortiOS and
 * FortiManager request with `verifySsl` off (`utils/tlsDispatcher`), the
 * per-asset REST API credential and HTTP-check credentials.
 *
 * RE-TRUST (rule 113(f)/(g)). A refused certificate is remembered on the pin
 * (`pendingFingerprint` / `pendingSubject` / `pendingSeenAt`) so an
 * administrator can compare it and trust exactly that certificate
 * (`trustPendingCert`) instead of deleting the pin and trusting whatever
 * answers next. The mismatch Event is written once per NEW certificate, not on
 * every refused poll. Polaris opens a short `repinUntil` window itself after
 * it completes a firmware upgrade of the device (`allowRepin`), since an
 * upgrade may regenerate the certificate.
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
  pendingFingerprint: string | null;
  pendingSubject: string | null;
  pendingSeenAt: Date | null;
  repinUntil: Date | null;
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

/** Drop one endpoint from this process's cache (business rule 123's archive / reinstate). */
export function forgetCachedCertPin(host: string, port: number): void {
  const ck = endpointKey(host, port);
  pinCache.delete(ck);
  lastSeenWrites.delete(ck);
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

  if (row.fingerprint !== actual) {
    // Rule 113(g): Polaris just upgraded this device's firmware, which may
    // have regenerated its certificate. EVERY change inside the window is
    // re-pinned, and the window stays open until it expires: a FortiGate 601E
    // presented two new certificates within minutes of its post-upgrade boot
    // (2026-10-22), and a window that closed on the first left the device
    // refused by every collector until someone trusted the second by hand.
    if (row.repinUntil && row.repinUntil.getTime() > Date.now()) {
      await prisma.tlsCertPin.update({
        where: { id: row.id },
        data: {
          fingerprint: actual, subject: subject.slice(0, 500), lastSeen: new Date(),
          pendingFingerprint: null, pendingSubject: null, pendingSeenAt: null,
        },
      });
      pinCache.set(ck, actual);
      await logEvent({
        action: "tls.cert.repinned",
        resourceType: "tls-cert-pin",
        resourceId: row.id,
        resourceName: ck,
        actor: "system:tls",
        level: "info",
        message: `Re-pinned the TLS certificate of ${ck} after the firmware upgrade Polaris ran on it${subject ? ` (${subject})` : ""}`,
        details: { host, port, previousFingerprint: row.fingerprint, fingerprint: actual, subject },
      });
      return { ok: true, outcome: "pinned" };
    }
    pinCache.set(ck, row.fingerprint);
    // Rule 113(f): remember what was presented, and report it ONCE per new
    // certificate — a refused gate is polled every few seconds.
    if (row.pendingFingerprint !== actual) {
      await prisma.tlsCertPin.update({
        where: { id: row.id },
        data: { pendingFingerprint: actual, pendingSubject: subject.slice(0, 500), pendingSeenAt: new Date() },
      }).catch((err) => logger.debug({ err, host, port }, "tls cert pin pending write failed"));
      await reportMismatch(host, port, row.fingerprint, actual, subject);
    }
    return { ok: false, outcome: "mismatch", expected: row.fingerprint, actual };
  }
  pinCache.set(ck, row.fingerprint);
  if (row.pendingFingerprint) {
    // The pinned certificate is back; the other one is no longer pending.
    await prisma.tlsCertPin.update({ where: { id: row.id }, data: { pendingFingerprint: null, pendingSubject: null, pendingSeenAt: null } }).catch(() => {});
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
      `If the certificate was legitimately re-issued, compare the fingerprints under Server Settings → Web Server → Pinned server identities and choose "Trust new certificate".`,
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
  // Changed certificates first: they are what an administrator came here for.
  const rows = await prisma.tlsCertPin.findMany({ orderBy: [{ host: "asc" }, { port: "asc" }] });
  return [...rows.filter((r) => r.pendingFingerprint), ...rows.filter((r) => !r.pendingFingerprint)];
}

export interface CertPinUser {
  assets: Array<{ id: string; hostname: string | null; ipAddress: string | null }>;
  integrations: Array<{ id: string; name: string; type: string }>;
}

/**
 * Every pin with what it belongs to (the Pinned server identities slide-over):
 * the assets whose address or hostname is the pinned host, and the
 * integrations whose configured host it is. A pin records the host:port Polaris
 * DIALED, not an asset, so this is a lookup, not a relation — a FortiManager
 * with no asset of its own lists only its integration, and a host nobody
 * models lists nothing. Bounded: two indexed queries whatever the fleet size,
 * and only id / name / address columns (never an integration's config secrets).
 */
export async function listCertPinsWithUsers(): Promise<Array<TlsCertPinRecord & CertPinUser>> {
  const pins = await listCertPins();
  if (!pins.length) return [];
  const hosts = [...new Set(pins.map((p) => p.host))];
  const [assets, integrations] = await Promise.all([
    prisma.asset.findMany({
      where: { OR: [{ ipAddress: { in: hosts } }, { hostname: { in: hosts, mode: "insensitive" } }] },
      select: { id: true, hostname: true, ipAddress: true },
      orderBy: { hostname: "asc" },
      take: 500,
    }),
    prisma.integration.findMany({ select: { id: true, name: true, type: true, config: true } }),
  ]);
  return pins.map((p) => {
    const host = p.host.toLowerCase();
    return {
      ...p,
      assets: assets.filter((a) => a.ipAddress === p.host || (a.hostname ?? "").toLowerCase() === host),
      integrations: integrations
        .filter((i) => {
          const cfgHost = (i.config as Record<string, unknown> | null)?.host;
          return typeof cfgHost === "string" && cfgHost.trim().toLowerCase() === host;
        })
        .map((i) => ({ id: i.id, name: i.name, type: i.type })),
    };
  });
}

/** The pins for specific endpoints (an asset's Sources tab). Missing endpoints are simply absent. */
export async function pinsForEndpoints(endpoints: Array<{ host: string; port: number }>): Promise<TlsCertPinRecord[]> {
  if (!endpoints.length) return [];
  return prisma.tlsCertPin.findMany({ where: { OR: endpoints.map((e) => ({ host: e.host, port: e.port })) } });
}

/** Endpoints whose server currently presents a certificate other than the pinned one (capacity card). */
export async function changedCertPins(): Promise<Array<{ host: string; port: number; pendingSeenAt: Date | null }>> {
  return prisma.tlsCertPin.findMany({
    where: { pendingFingerprint: { not: null } },
    select: { host: true, port: true, pendingSeenAt: true },
    orderBy: { pendingSeenAt: "asc" },
  });
}

/**
 * Rule 113(f): trust EXACTLY the certificate the administrator inspected. The
 * caller passes the pending fingerprint it showed them; if the server has
 * since presented yet another one, nothing is trusted (409) — the page is
 * stale and must be looked at again.
 */
export async function trustPendingCert(id: string, fingerprint: string, actor: string): Promise<TlsCertPinRecord> {
  const row = await prisma.tlsCertPin.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "TLS certificate pin not found");
  if (!row.pendingFingerprint) throw new AppError(409, "This server has not presented a changed certificate");
  if (normalizeFingerprint(fingerprint) !== normalizeFingerprint(row.pendingFingerprint)) {
    throw new AppError(409, "The server has presented a different certificate since this page loaded — reload and compare again");
  }
  const updated = await prisma.tlsCertPin.update({
    where: { id },
    data: {
      fingerprint: row.pendingFingerprint, subject: row.pendingSubject ?? "", lastSeen: new Date(),
      pendingFingerprint: null, pendingSubject: null, pendingSeenAt: null, repinUntil: null,
    },
  });
  const ck = endpointKey(row.host, row.port);
  pinCache.set(ck, row.pendingFingerprint);
  await logEvent({
    action: "tls.cert.trusted",
    resourceType: "tls-cert-pin",
    resourceId: id,
    resourceName: ck,
    actor,
    level: "warning",
    message: `Trusted the new TLS certificate of ${ck}${row.pendingSubject ? ` (${row.pendingSubject})` : ""} in place of the pinned one`,
    details: { host: row.host, port: row.port, previousFingerprint: row.fingerprint, fingerprint: row.pendingFingerprint, subject: row.pendingSubject },
  });
  return updated;
}

/**
 * Rule 113(g): after Polaris completes a firmware upgrade of a device, accept
 * every changed certificate it presents within `minutes` (the latest one
 * stays pinned when the window expires). Only existing pins are touched (a
 * never-pinned endpoint pins on first use anyway).
 */
export async function allowRepin(host: string, ports: number[], minutes: number, actor: string): Promise<number> {
  if (!host || !ports.length) return 0;
  const until = new Date(Date.now() + minutes * 60_000);
  const res = await prisma.tlsCertPin.updateMany({ where: { host, port: { in: ports } }, data: { repinUntil: until } });
  if (res.count) {
    for (const port of ports) pinCache.delete(endpointKey(host, port));
    await logEvent({
      action: "tls.cert.repin_window",
      resourceType: "tls-cert-pin",
      resourceName: host,
      actor,
      level: "info",
      message: `A firmware upgrade finished on ${host}; any change to its TLS certificate within ${minutes} minutes will be re-pinned automatically`,
      details: { host, ports, until: until.toISOString() },
    }).catch(() => {});
  }
  return res.count;
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

export interface AssetTlsEndpoint {
  /** What this connection is, for the Sources tab ("FortiManager", "This FortiGate (direct)"...). */
  label: string;
  host: string;
  port: number;
  pin: TlsCertPinRecord | null;
}

/**
 * Which TLS endpoints Polaris dials with a token on behalf of this asset's
 * discovering integration (rule 113(e)), for the Sources tab. Pure.
 *  - FortiManager: the FortiManager itself; in direct mode (`useProxy: false`)
 *    a FortiGate is also dialed on its own management address, port 443.
 *  - FortiGate (standalone): the integration's gate; a managed device whose
 *    address differs is reached through it, a firewall at another address is
 *    dialed itself.
 */
export function tlsEndpointsForAsset(
  asset: { assetType: string; ipAddress: string | null },
  integration: { type: string; name: string; config: Record<string, unknown> } | null,
): Array<Omit<AssetTlsEndpoint, "pin">> {
  if (!integration) return [];
  const cfg = integration.config || {};
  const host = typeof cfg.host === "string" ? cfg.host.trim() : "";
  const port = Number(cfg.port) || 443;
  const out: Array<Omit<AssetTlsEndpoint, "pin">> = [];
  if (integration.type === "fortimanager") {
    if (host) out.push({ label: `FortiManager "${integration.name}"`, host, port });
    if (cfg.useProxy === false && asset.assetType === "firewall" && asset.ipAddress) {
      out.push({ label: "This FortiGate, direct (FortiManager proxy bypass)", host: asset.ipAddress, port: 443 });
    }
  } else if (integration.type === "fortigate") {
    if (host) out.push({ label: `FortiGate "${integration.name}"`, host, port });
    if (asset.assetType === "firewall" && asset.ipAddress && asset.ipAddress !== host) {
      out.push({ label: "This FortiGate", host: asset.ipAddress, port: 443 });
    }
  }
  return out;
}

/** The asset's endpoints with their pins (null = not contacted since pinning began, or CA-verified). */
export async function assetTlsEndpoints(
  asset: { assetType: string; ipAddress: string | null },
  integration: { type: string; name: string; config: Record<string, unknown> } | null,
): Promise<AssetTlsEndpoint[]> {
  const eps = tlsEndpointsForAsset(asset, integration);
  const pins = await pinsForEndpoints(eps);
  return eps.map((e) => ({ ...e, pin: pins.find((p) => p.host === e.host && p.port === e.port) ?? null }));
}
