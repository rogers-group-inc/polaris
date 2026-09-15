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
 *
 * AND THE THIRD SHAPE, WHICH IS NOT A REFUSAL BUT A MISCONFIGURATION. The
 * protocol handed in is Express's `req.protocol`, which only reads "https"
 * behind a TLS-terminating proxy when `trust proxy` is set for the deployment's
 * hop count (utils/trustProxy.ts). An install fronted by nginx / Caddy /
 * Traefik / Nginx Proxy Manager / an ALB with `TRUST_PROXY` unset therefore
 * looks exactly like the lab VM from in here — and "put Polaris behind TLS" is
 * advice that operator has already taken. So when the request carries a proxy's
 * own claim that the browser hop was HTTPS, the reason names THAT header and
 * the variable to set. The claim is never believed: a spoofable header must not
 * grant what `req.secure` withheld, and the trust setting it asks for is the
 * same one that decides whose IP the login rate limiter counts. It is read to
 * write a better sentence, nothing else.
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

/**
 * The scheme a reverse proxy claims the BROWSER hop used, read straight off the
 * request headers, or null when no proxy said anything.
 *
 * Express itself honors only `X-Forwarded-Proto`, and only under `trust proxy`.
 * This reads wider — `Forwarded` (RFC 7239), `X-Forwarded-Scheme` (Nginx Proxy
 * Manager), `X-Forwarded-Ssl` (Apache mod_proxy) — because it is not deciding
 * anything: its whole job is to recognize "there IS a proxy in front of this
 * and it thinks it terminated TLS", so the operator gets told about
 * `TRUST_PROXY` rather than told to do what they already did.
 *
 * A comma-separated value is a chain; the FIRST entry is the hop nearest the
 * browser, which is the one whose scheme the page was actually served over.
 */
export function forwardedProtoClaim(headers: Record<string, unknown> | undefined): string | null {
  const read = (name: string): string | undefined => {
    const raw = headers?.[name];
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
    return undefined;
  };
  const firstHop = (value: string): string => (value.split(",")[0] ?? "").trim().toLowerCase();

  const proto = read("x-forwarded-proto") ?? read("x-forwarded-scheme");
  if (proto && firstHop(proto)) return firstHop(proto);

  const forwarded = read("forwarded");
  if (forwarded) {
    const match = /proto\s*=\s*"?([a-z]+)"?/i.exec(firstHop(forwarded));
    if (match?.[1]) return match[1].toLowerCase();
  }

  const ssl = read("x-forwarded-ssl");
  if (ssl && firstHop(ssl) === "on") return "https";

  return null;
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
 * @param forwardedProto  the scheme a proxy CLAIMED for the browser hop
 *                  (`forwardedProtoClaim`), used only to sharpen the reason
 *                  when `protocol` is not https — never to grant a secure
 *                  context Express did not see
 */
export function resolveRelyingParty(
  host: string | undefined,
  protocol: string,
  overrideRpId: string,
  forwardedProto?: string | null,
): RelyingPartyResult {
  if (!host || !host.trim()) {
    return { ok: false, reason: "The request carried no Host header, so Polaris cannot tell which domain a passkey would belong to." };
  }
  const hostname = hostnameFromHost(host);
  const secure = protocol === "https" || isLocalhostHostname(hostname);
  if (!secure) {
    if ((forwardedProto ?? "").trim().toLowerCase() === "https") {
      return {
        ok: false,
        reason:
          `A reverse proxy in front of "${hostname}" reported that the browser reached it over HTTPS, but Polaris is not configured to ` +
          "believe forwarded headers, so it still treats this request as plain HTTP — and passkeys need a secure context. Set " +
          "TRUST_PROXY in Polaris's environment (TRUST_PROXY=1 trusts the nearest hop; use the number of proxies in front of it) and " +
          "restart. The same setting is what lets session cookies go out Secure and makes the login rate limiter count the real client IP.",
      };
    }
    return {
      ok: false,
      reason:
        `Passkeys need a secure context. This page was served over HTTP from "${hostname}", and browsers only allow WebAuthn over HTTPS ` +
        "(or from localhost). Put Polaris behind TLS — directly or at a proxy. If it is already behind one, have the proxy send " +
        "X-Forwarded-Proto: https and set TRUST_PROXY so Polaris believes it.",
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
