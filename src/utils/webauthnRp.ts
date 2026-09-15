/**
 * src/utils/webauthnRp.ts — deciding which Relying Party a WebAuthn ceremony
 * belongs to, from the request that started it.
 *
 * A passkey is bound to an RP ID (a bare domain, no scheme, no port) and every
 * assertion is checked against both that ID and the full origin the page was
 * served from. Polaris cannot know either one from configuration: the
 * deployment posture is that TLS terminates anywhere, `POLARIS_PUBLIC_URL` may
 * be unset, and the same install is legitimately reached at more than one name.
 * So the RP is derived from the request — the Host header the browser itself
 * sent — with an operator override for the one case derivation cannot serve.
 *
 * Deriving from a client-controlled header is safe HERE, and only because the
 * browser is the real enforcer: it refuses to run a ceremony whose rpId is not
 * a registrable suffix of the page's own origin. A forged Host can therefore
 * produce a ceremony that fails in the browser, or — for a caller who is
 * already authenticated and forging their own requests — a credential bound to
 * a domain they control, which lets them into nothing they did not already
 * have. What it can never do is let a credential minted for one origin verify
 * against another, because the origin is pinned into the ceremony at issue time
 * (see utils/webauthnChallenge.ts).
 *
 * The override exists for the multi-name install: users who reach Polaris at
 * both `polaris` and `polaris.corp.example.com` would otherwise register a
 * credential the other name cannot see. Setting the RP ID to the shared parent
 * domain makes one passkey work at both — at the cost of scoping the credential
 * to that whole domain, which is why it is an explicit operator choice and not
 * a default.
 *
 * WHY A "not available here" RESULT AND NOT AN EXCEPTION. WebAuthn requires a
 * secure context, and an IP address cannot be an RP ID. A lab VM on plain HTTP
 * at 10.0.0.5 is a supported Polaris deployment that simply cannot have
 * passkeys — the UI needs to SAY that, with the reason, rather than show a
 * button that fails in a browser dialog.
 */

export interface RelyingParty {
  /** Bare domain — what the credential is scoped to. */
  rpId: string;
  /** Full origin including scheme and any non-default port. */
  origin: string;
}

export type RelyingPartyResult =
  | { ok: true; rp: RelyingParty }
  | { ok: false; reason: string };

/** Strip the port from a Host header value, keeping IPv6 literals intact. */
export function hostnameFromHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/** localhost is a secure context in every browser that implements WebAuthn. */
export function isLocalhostHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
}

/** An RP ID must be a domain name. Bare IPv4/IPv6 literals are not eligible. */
export function isIpLiteral(hostname: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname.includes(":"); // an un-bracketed IPv6 literal by this point
}

/**
 * Resolve the RP for a request.
 *
 * @param host      the request's Host header (with port, as sent)
 * @param protocol  Express's `req.protocol` — already X-Forwarded-Proto aware
 *                  when `trust proxy` is set for the deployment's hop count
 * @param overrideRpId  operator-set RP ID, or "" to derive
 */
export function resolveRelyingParty(
  host: string | undefined,
  protocol: string,
  overrideRpId: string,
): RelyingPartyResult {
  if (!host || !host.trim()) {
    return { ok: false, reason: "The request carried no Host header, so Polaris cannot tell which domain a passkey would belong to." };
  }
  const hostname = hostnameFromHost(host);
  const secure = protocol === "https" || isLocalhostHostname(hostname);
  if (!secure) {
    return {
      ok: false,
      reason:
        `Passkeys need a secure context. This page was served over HTTP from "${hostname}", and browsers only allow WebAuthn over HTTPS ` +
        "(or from localhost). Put Polaris behind TLS — directly or at a proxy — to use passkeys.",
    };
  }
  if (isIpLiteral(hostname)) {
    return {
      ok: false,
      reason:
        `Passkeys are bound to a domain name, and this install was reached at the IP address "${hostname}". ` +
        "Browse to Polaris by hostname (and register the passkey there) to use them.",
    };
  }

  const origin = `${protocol}://${host.trim().toLowerCase()}`;

  const override = overrideRpId.trim().toLowerCase();
  if (!override) return { ok: true, rp: { rpId: hostname, origin } };

  // The browser enforces this too, but failing here names the mismatch instead
  // of surfacing an opaque SecurityError in a credential dialog.
  if (hostname !== override && !hostname.endsWith(`.${override}`)) {
    return {
      ok: false,
      reason:
        `The configured passkey domain "${override}" does not cover the address this page was reached at ("${hostname}"). ` +
        "A passkey domain must be the host itself or a parent of it.",
    };
  }
  return { ok: true, rp: { rpId: override, origin } };
}
