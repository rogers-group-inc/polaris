/**
 * src/services/trustedCaService.ts — the CAs uploaded under Server Settings →
 * Trusted Certificate Authorities, made part of THIS process's default TLS
 * trust store (business rule 188).
 *
 * `tls.setDefaultCACertificates()` replaces the store every TLS connection
 * uses when it names no `ca` of its own — node:https, tls.connect, undici's
 * fetch, ldapts — so one call covers every integration that verifies its
 * server (FortiManager / FortiGate, vCenter, Proxmox, TrueNAS, Unraid, LDAPS,
 * the Generic API, the AI integration, SMTP, OIDC …) without threading a `ca`
 * through each transport. The store set is always the process's ORIGINAL
 * default (Node's bundled roots plus NODE_EXTRA_CA_CERTS) plus the uploads:
 * an upload only ever ADDS trust, and a connection with verification switched
 * off is unaffected either way.
 *
 * Every role applies it at boot and re-reads it every TRUSTED_CA_REFRESH_MS,
 * like the timezone override (rule 170), so an upload on the web role reaches
 * monitor / discovery / dash within half a minute; the web role applies an
 * upload or delete at once. Connections already open keep the trust they were
 * opened with until they reconnect.
 *
 * SSH (the SFTP / SCP event archive) does not use CAs at all — an SSH server is
 * trusted by its pinned host key, so this has nothing to give it.
 */
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { logger } from "../utils/logger.js";

export const TRUSTED_CA_REFRESH_MS = 30_000;

/** The process's default store before any upload was added — captured once. */
let baseline: string[] | null = null;
/** Signature of the uploads last applied, so an unchanged list is not re-applied. */
let appliedSignature: string | null = null;
let warnedUnsupported = false;

type TlsWithCaApi = typeof tls & {
  setDefaultCACertificates?: (certs: string[]) => void;
  getCACertificates?: (type?: "default" | "system" | "bundled" | "extra") => string[];
};

/** True when this Node can replace the default trust store (Node ≥ 22.19 / 24.5). */
export function trustedCaSupported(): boolean {
  const t = tls as TlsWithCaApi;
  return typeof t.setDefaultCACertificates === "function" && typeof t.getCACertificates === "function";
}

/**
 * The uploads that parse as X.509 certificates, deduplicated, in upload order.
 * A malformed PEM is skipped (and named), never allowed to fail the whole set.
 */
export function usableCaPems(pems: readonly string[]): { usable: string[]; skipped: number } {
  const seen = new Set<string>();
  const usable: string[] = [];
  let skipped = 0;
  for (const pem of pems) {
    try {
      const fp = new X509Certificate(pem).fingerprint256;
      if (seen.has(fp)) continue;
      seen.add(fp);
      usable.push(pem.trim() + "\n");
    } catch {
      skipped++;
    }
  }
  return { usable, skipped };
}

/**
 * Make `pems` part of this process's default trust store (on top of the
 * original default). Returns how many were added, or null when this Node has
 * no API for it. Idempotent: the same list is applied once.
 */
export function applyTrustedCas(pems: readonly string[]): { added: number; skipped: number } | null {
  if (!trustedCaSupported()) {
    if (!warnedUnsupported && pems.length) {
      warnedUnsupported = true;
      logger.warn(
        { node: process.version },
        "Trusted CAs uploaded in Server Settings need Node 22.19+ / 24.5+ to reach integrations; this Node cannot apply them (set NODE_EXTRA_CA_CERTS instead)",
      );
    }
    return null;
  }
  const t = tls as Required<Pick<TlsWithCaApi, "setDefaultCACertificates" | "getCACertificates">>;
  baseline ??= t.getCACertificates("default");
  const { usable, skipped } = usableCaPems(pems);
  const signature = usable.join("");
  if (signature === appliedSignature) return { added: usable.length, skipped };
  t.setDefaultCACertificates([...baseline, ...usable]);
  appliedSignature = signature;
  logger.info({ added: usable.length, skipped }, "Trusted CAs applied to this process's TLS trust store");
  return { added: usable.length, skipped };
}

/** Read the uploaded CAs and apply them. Never throws: an outage keeps the store in force. */
export async function refreshTrustedCas(): Promise<void> {
  try {
    const { listCertificates } = await import("./serverSettingsService.js");
    const { trustedCAs } = await listCertificates();
    applyTrustedCas(trustedCAs.filter((c) => c.type === "cert" && c.pem).map((c) => c.pem));
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "trusted CA refresh failed; keeping the trust store in force");
  }
}

/** Test seam: forget the captured baseline and applied state. */
export function _resetTrustedCasForTests(): void {
  baseline = null;
  appliedSignature = null;
  warnedUnsupported = false;
}
