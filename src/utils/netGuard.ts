/**
 * src/utils/netGuard.ts — SSRF guard for operator-supplied outbound hosts.
 *
 * Integrations (FortiManager, FortiGate, Active Directory, Windows Server) take
 * an operator-entered `host`, and Polaris then issues authenticated outbound
 * requests to it — including the FMG proxy path, which relays arbitrary FortiOS
 * API calls. Without a guard, a caller with `integrations:write` can aim Polaris
 * at internal-only targets (the cloud metadata endpoint, the loopback DB, a
 * link-local address) and use the server as a request relay / port scanner.
 *
 * The guard is deliberately a *blocklist of dangerous ranges*, NOT an allowlist
 * of public IPs: every real Polaris deployment talks to devices on RFC1918 LANs
 * (10/8, 172.16/12, 192.168/16) and ULA IPv6 — those MUST stay allowed. What we
 * reject is the set of addresses that only make sense as an SSRF target:
 *
 *   - loopback            127.0.0.0/8, ::1          (reach Polaris's own host)
 *   - link-local          169.254.0.0/16, fe80::/10 (incl. 169.254.169.254 —
 *                                                     AWS/GCP/Azure metadata)
 *   - unspecified         0.0.0.0, ::
 *   - multicast           224.0.0.0/4, ff00::/8
 *   - "localhost" literal
 *
 * This validates the literal host (IP or the localhost hostname). A hostname
 * that resolves to a blocked range via DNS is a residual DNS-rebinding risk not
 * covered here — see the 2026-06-03 security review (M4) for the follow-up note.
 */

import { isValidIpAddress, ipInCidr } from "./cidr.js";

/** IPv4 ranges that are only meaningful as an SSRF target. */
const BLOCKED_V4_CIDRS = [
  "127.0.0.0/8",     // loopback
  "169.254.0.0/16",  // link-local (includes 169.254.169.254 cloud metadata)
  "0.0.0.0/8",       // "this host" / unspecified
  "224.0.0.0/4",     // multicast
];

/** Strip an optional zone id (e.g. fe80::1%eth0) and surrounding brackets. */
function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const pct = h.indexOf("%");
  if (pct !== -1) h = h.slice(0, pct);
  return h;
}

function isBlockedV6(ip: string): boolean {
  // IPv6 ranges are matched textually — the address is already a valid IPv6
  // literal at this point (isValidIpAddress passed) and these prefixes are
  // unambiguous without full expansion.
  if (ip === "::1" || ip === "::") return true;          // loopback / unspecified
  if (ip.startsWith("fe8") || ip.startsWith("fe9") ||
      ip.startsWith("fea") || ip.startsWith("feb")) return true; // fe80::/10 link-local
  if (ip.startsWith("ff")) return true;                   // ff00::/8 multicast
  // IPv4-mapped (::ffff:1.2.3.4) is handled in isBlockedOutboundHost before the
  // validity gate, since its embedded dots fail the v6 literal check.
  return false;
}

function isBlockedV4(ip: string): boolean {
  return BLOCKED_V4_CIDRS.some((cidr) => ipInCidr(ip, cidr));
}

/**
 * Returns true when `host` is a literal address (or "localhost") in a range that
 * only makes sense as an SSRF target. RFC1918/ULA private LAN ranges and public
 * addresses return false (allowed). Hostnames other than "localhost" are treated
 * as allowed here — see the module note on DNS rebinding.
 */
export function isBlockedOutboundHost(host: string): boolean {
  const h = normalizeHost(host);
  if (!h) return false; // empty handled by the caller's own required-field check
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) carries embedded dots that isValidIpAddress
  // rejects as a v6 literal — check the mapped v4 explicitly so it can't bypass.
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isValidIpAddress(mapped[1]) && isBlockedV4(mapped[1]);
  if (!isValidIpAddress(h)) return false; // a real hostname — not our literal check
  return h.includes(":") ? isBlockedV6(h) : isBlockedV4(h);
}

/**
 * Throws `{ code: "BLOCKED_HOST" }` when the host is in a blocked range, with a
 * message naming the category. Callers convert this into a 400 (the route layer
 * already maps thrown validation errors). No-op for allowed hosts and for empty
 * input (the schema's own required check owns emptiness).
 */
export function assertOutboundHostAllowed(host: string): void {
  if (isBlockedOutboundHost(host)) {
    throw Object.assign(
      new Error(
        `Host "${host.trim()}" is in a blocked range (loopback / link-local / ` +
        `metadata / multicast) and cannot be used as an integration target. ` +
        `Use the device's routable LAN address.`
      ),
      { code: "BLOCKED_HOST" },
    );
  }
}

/**
 * True for the loopback subset of the blocklist only: "localhost" (and
 * *.localhost), 127.0.0.0/8, ::1 and ::ffff:127.x. Link-local, metadata,
 * unspecified and multicast are NOT loopback and stay blocked.
 */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const ip = mapped ? mapped[1] : h;
  if (!isValidIpAddress(ip)) return false;
  return ip.includes(":") ? ip === "::1" : ipInCidr(ip, "127.0.0.0/8");
}

/**
 * The `llm` integration's variant of the guard. A local model server very
 * often listens on the Polaris host itself (Ollama's default is
 * localhost:11434), so an operator may tick "Allow loopback" — which lifts the
 * block for loopback ONLY. Everything else in the blocklist (link-local and
 * the cloud metadata address, unspecified, multicast) is refused regardless.
 * Business rule 95(g).
 */
export function isBlockedLlmHost(host: string, allowLoopback: boolean): boolean {
  if (!isBlockedOutboundHost(host)) return false;
  return !(allowLoopback && isLoopbackHost(host));
}
