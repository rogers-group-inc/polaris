/**
 * src/services/ldapClient.ts — Shared ldapts connection helpers
 *
 * Single TLS / bind / unbind code path used by BOTH on-prem AD discovery
 * (activeDirectoryService) and LDAP user authentication (ldapAuthService).
 * Extracted so there is exactly one place that decides rejectUnauthorized,
 * timeouts, and the bind/unbind lifecycle.
 *
 * Also holds the LDAP filter-injection escape (RFC 4515) — every value
 * interpolated into a search filter from user input MUST pass through
 * escapeLdapFilterValue or the search can be subverted.
 */

import { Client } from "ldapts";

export interface LdapConnectionConfig {
  host: string;
  port?: number;
  useLdaps?: boolean; // default true
  verifyTls?: boolean;
  bindDn: string;
  bindPassword: string;
}

function buildLdapUrl(config: { host: string; port?: number; useLdaps?: boolean }): string {
  const useLdaps = config.useLdaps !== false;
  const defaultPort = useLdaps ? 636 : 389;
  const port = config.port && config.port > 0 ? config.port : defaultPort;
  const scheme = useLdaps ? "ldaps" : "ldap";
  return `${scheme}://${config.host}:${port}`;
}

function newLdapClient(config: { host: string; port?: number; useLdaps?: boolean; verifyTls?: boolean }): Client {
  const useLdaps = config.useLdaps !== false;
  return new Client({
    url: buildLdapUrl(config),
    timeout: 30_000,
    connectTimeout: 15_000,
    tlsOptions: useLdaps ? { rejectUnauthorized: !!config.verifyTls } : undefined,
  });
}

/**
 * Bind with the supplied DN/password, run `fn`, always unbind. Aborting the
 * signal unbinds early. ldapts does not chase referrals by default, so a
 * referral response surfaces as a non-result rather than a follow-on bind to
 * an attacker-influenced server.
 */
export async function withBoundLdapClient<T>(
  config: LdapConnectionConfig,
  signal: AbortSignal | undefined,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = newLdapClient(config);
  const onAbort = () => { void client.unbind().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await client.bind(config.bindDn, config.bindPassword);
    return await fn(client);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { await client.unbind(); } catch { /* ignore */ }
  }
}

/**
 * RFC 4515 special-character escaping for a value interpolated into an LDAP
 * search filter. Without this, a username like `*)(uid=*` would subvert the
 * search. Order matters: escape the backslash first.
 */
export function escapeLdapFilterValue(value: string): string {
  return String(value)
    .replace(/\\/g, "\\5c")
    .replace(/\*/g, "\\2a")
    .replace(/\(/g, "\\28")
    .replace(/\)/g, "\\29")
    .replace(/\0/g, "\\00");
}

/** AD objectGUID is a 16-byte binary value → stable lowercase hex string. */
export function decodeObjectGuid(buf: Buffer): string {
  if (buf.length !== 16) return "";
  return buf.toString("hex").toLowerCase();
}

/** Map an ldapts/network error to a short operator-facing message. */
export function formatLdapError(err: any): string {
  const name = err?.name || "";
  const msg = err?.message || "Unknown error";
  if (name === "InvalidCredentialsError") return "Invalid bind DN or password";
  if (name === "NoSuchObjectError")       return "Base DN not found";
  if (name === "InsufficientAccessError") return "Bind account has insufficient access to the base DN";
  if (err?.code === "ENOTFOUND")          return "Host not found — check DNS/hostname";
  if (err?.code === "ECONNREFUSED")       return "Connection refused — check port and firewall";
  if (err?.code === "ETIMEDOUT")          return "Connection timed out";
  if (err?.code === "DEPTH_ZERO_SELF_SIGNED_CERT" || err?.code === "SELF_SIGNED_CERT_IN_CHAIN" || err?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return "TLS certificate verification failed — uncheck \"Verify TLS\" or install the CA certificate";
  }
  return msg.split(/\r?\n/)[0];
}
