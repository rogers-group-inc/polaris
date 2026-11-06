/**
 * src/services/certInfo.ts — single source of truth for the leaf cert that
 * agents pin against. Reads the PEM nginx serves from POLARIS_PROXY_CERT_PATH.
 *
 * Layered cache + last-known-good fallback survives cert-rotation atomic-
 * rename windows (certbot-style renew).
 *
 * Design review notes folded in:
 *   §5 (layered cache): hash file bytes as the cache key, only re-parse on
 *       content change. parseFromBytes is the expensive step.
 *   §6 (zero-byte / atomic-rename): return last-known-good immediately and
 *       refresh the cache asynchronously (100ms unref'd timer — replaced the
 *       synchronous spin-wait 2026-08); suppress repeat warnings while the
 *       failure persists.
 */

import { readFileSync } from "node:fs";
import { createHash, X509Certificate } from "node:crypto";
import { logger } from "../utils/logger.js";
import { proxyCertPath } from "../utils/proxyMode.js";

interface CachedCert {
  /** SHA-256 of the raw file bytes — cache key for "do I need to re-parse?". */
  sha256: string;
  /** sha256:<hex> of the cert's DER bytes — what agents pin against. */
  fingerprint: string;
  cn: string | null;
  dnsSans: string[];
  ipSans: string[];
  /** ISO 8601 expiry date, or null if unparseable. */
  expiresAt: string | null;
  parsedAt: number;
}

// ─── Cache ──────────────────────────────────────────────────────────────────

let lastGood: CachedCert | null = null;
// Suppress repeated warn logs while a failure persists. Reset on next success.
let warnSuppressed = false;

/**
 * Read + parse the active cert (whichever mode), returning a fresh
 * CachedCert OR `lastGood` on transient failures. Never throws.
 */
function readActiveCert(): CachedCert | null {
  const bytes = readPemBytes();
  if (!bytes || bytes.length === 0) {
    return lastGood;
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (lastGood && lastGood.sha256 === sha256) {
    return lastGood; // unchanged — no re-parse
  }

  const parsed = parseFromBytes(bytes, sha256);
  if (parsed) {
    lastGood = parsed;
    if (warnSuppressed) {
      logger.info("Cert read+parse succeeded after prior failure — clearing warn suppression");
      warnSuppressed = false;
    }
    return parsed;
  }

  return lastGood; // parse failed; return previous good (may be null on first read)
}

/**
 * Read the raw PEM bytes from POLARIS_PROXY_CERT_PATH. On ENOENT /
 * zero-byte / read error (a certbot-style atomic-rename window), return
 * null NOW — the accessor serves last-known-good — and schedule one
 * asynchronous re-read so the cache refreshes shortly after the window
 * closes. Replaced the 100ms event-loop spin-wait (the accessors are
 * reachable from HTTP handlers, and blocking every in-flight request for
 * the rotation window was worse than one stale read).
 */
function readPemBytes(): Buffer | null {
  const path = proxyCertPath();
  if (!path) return null;
  const first = tryReadFile(path);
  if (first && first.length > 0) return first;
  scheduleAsyncRefresh(path);
  if (!warnSuppressed) {
    logger.warn({ path }, "Cert file unreadable or empty — returning last-known-good (may be null) and refreshing asynchronously");
    warnSuppressed = true;
  }
  return null;
}

function tryReadFile(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

// One in-flight refresh timer at most; unref'd so it never holds the
// process open. If the file is still unreadable when it fires, the next
// accessor call schedules the next attempt — no self-perpetuating loop.
let refreshTimer: NodeJS.Timeout | null = null;
function scheduleAsyncRefresh(path: string): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const bytes = tryReadFile(path);
    if (!bytes || bytes.length === 0) return;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (lastGood && lastGood.sha256 === sha256) return;
    const parsed = parseFromBytes(bytes, sha256);
    if (parsed) {
      lastGood = parsed;
      if (warnSuppressed) {
        logger.info("Cert read+parse succeeded on async refresh — clearing warn suppression");
        warnSuppressed = false;
      }
    }
  }, 100);
  refreshTimer.unref?.();
}
function parseFromBytes(bytes: Buffer, sha256: string): CachedCert | null {
  try {
    const x509 = new X509Certificate(bytes);
    const fingerprint = `sha256:${createHash("sha256").update(x509.raw).digest("hex")}`;
    const { cn, dnsSans, ipSans } = extractSubjectAndSans(x509);
    const expiresAt = parseValidTo(x509.validTo);
    return {
      sha256,
      fingerprint,
      cn,
      dnsSans,
      ipSans,
      expiresAt,
      parsedAt: Date.now(),
    };
  } catch (err) {
    if (!warnSuppressed) {
      logger.warn({ err: (err as Error).message }, "Cert PEM parse failed — returning last-known-good (may be null)");
      warnSuppressed = true;
    }
    return null;
  }
}

function extractSubjectAndSans(x509: X509Certificate): { cn: string | null; dnsSans: string[]; ipSans: string[] } {
  let cn: string | null = null;
  for (const line of (x509.subject ?? "").split(/[\r\n]+/)) {
    const m = line.match(/^CN=(.+)$/);
    if (m) { cn = m[1].trim(); break; }
  }
  const dnsSans: string[] = [];
  const ipSans: string[] = [];
  for (const raw of (x509.subjectAltName ?? "").split(",")) {
    const piece = raw.trim();
    if (!piece) continue;
    const dnsMatch = piece.match(/^DNS:(.+)$/);
    if (dnsMatch) { dnsSans.push(dnsMatch[1].trim()); continue; }
    const ipMatch = piece.match(/^IP(?:\s+Address)?:(.+)$/);
    if (ipMatch) { ipSans.push(ipMatch[1].trim()); continue; }
  }
  return { cn, dnsSans, ipSans };
}

function parseValidTo(validTo: string): string | null {
  // X509Certificate.validTo is the cert's notAfter as a UTC string —
  // "Nov 17 12:00:00 2027 GMT" shape. Date can parse it.
  const t = Date.parse(validTo);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * SHA-256 fingerprint of the active leaf cert as `sha256:<lowercase-hex>`.
 * Baked into each Polaris Agent's `agent.conf` at install time so the
 * agent's Go TLS client can pin Polaris's cert and skip the system CA
 * trust chain entirely (defends against CA-compromise / MITM scenarios).
 *
 * Returns null when the cert file is unreadable AND no previous good
 * fingerprint is cached (e.g. very first boot, mid-rotation).
 */
export function getServerCertFingerprint(): string | null {
  return readActiveCert()?.fingerprint ?? null;
}

/**
 * Hostnames the active leaf cert is valid for: CN + DNS SANs + IP SANs.
 * Used by agentInstallService.inferOwnServerUrl() to derive a default
 * server_url for agent.conf when neither POLARIS_PUBLIC_URL nor the
 * operator override Setting is set.
 */
export function getServerCertHostnames(): { cn: string | null; dnsSans: string[]; ipSans: string[] } | null {
  const c = readActiveCert();
  if (!c) return null;
  return { cn: c.cn, dnsSans: c.dnsSans, ipSans: c.ipSans };
}

/**
 * ISO 8601 expiry date of the active leaf cert, or null if no cert or
 * the notAfter field is unparseable. Surfaced in the Server Settings →
 * Identification informational pane so operators see when nginx's cert
 * is about to expire even though Polaris doesn't manage it.
 */
export function getServerCertExpiry(): string | null {
  return readActiveCert()?.expiresAt ?? null;
}

/**
 * Drop the cached cert metadata so the next accessor re-reads from disk.
 * The sha256-keyed cache already auto-invalidates on file-content change,
 * but cert rotation via nginxApplyService calls this explicitly so the
 * fingerprint surfaced to the GUI reflects the new cert on the very next
 * read instead of after the next file-hash divergence is detected.
 */
export function invalidateCache(): void {
  lastGood = null;
  warnSuppressed = false;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
}

/**
 * Test-only: drop the cache. Vitest test isolation needs to flip env vars
 * between tests, which means the cached fingerprint from a prior test
 * would otherwise leak. Don't call from production code.
 */
export function __resetCertInfoCacheForTests(): void {
  lastGood = null;
  warnSuppressed = false;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
}
