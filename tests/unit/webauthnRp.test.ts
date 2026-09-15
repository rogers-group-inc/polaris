/**
 * tests/unit/webauthnRp.test.ts — src/utils/webauthnRp.ts
 *
 * Which Relying Party a passkey ceremony belongs to, derived from the request.
 *
 * The deployment posture is what makes this worth pinning: Polaris installs on
 * RHEL behind nginx, in a container behind a corporate load balancer, and on a
 * lab VM over plain HTTP at an IP address. The last of those CANNOT have
 * passkeys — WebAuthn needs a secure context and an RP ID must be a domain —
 * and the whole point of returning a reason rather than throwing is that the
 * UI can say which of those two it hit instead of surfacing a browser
 * SecurityError nobody can act on.
 *
 * The third shape is the one that looks like the lab VM and is not: TLS
 * terminated at a proxy Polaris was never told to trust. It stays a refusal —
 * a forwarded header cannot grant a secure context — but the sentence it
 * produces has to name TRUST_PROXY, because "put Polaris behind TLS" is advice
 * that operator has already taken.
 */

import { describe, it, expect } from "vitest";
import {
  resolveRelyingParty,
  forwardedProtoClaim,
  hostnameFromHost,
  isLocalhostHostname,
  isIpLiteral,
} from "../../src/utils/webauthnRp.js";

describe("hostnameFromHost", () => {
  it("drops the port", () => {
    expect(hostnameFromHost("polaris.example.com:8443")).toBe("polaris.example.com");
  });

  it("keeps a bare host unchanged", () => {
    expect(hostnameFromHost("polaris.example.com")).toBe("polaris.example.com");
  });

  it("lowercases, since a Host header may arrive in any case", () => {
    expect(hostnameFromHost("Polaris.Example.COM")).toBe("polaris.example.com");
  });

  it("unwraps a bracketed IPv6 literal without eating its colons", () => {
    expect(hostnameFromHost("[::1]:3000")).toBe("::1");
    expect(hostnameFromHost("[2001:db8::5]")).toBe("2001:db8::5");
  });
});

describe("isLocalhostHostname", () => {
  it.each(["localhost", "127.0.0.1", "::1", "polaris.localhost"])("accepts %s", (host) => {
    expect(isLocalhostHostname(host)).toBe(true);
  });

  it("does not accept a name that merely contains localhost", () => {
    expect(isLocalhostHostname("notlocalhost")).toBe(false);
    expect(isLocalhostHostname("localhost.evil.com")).toBe(false);
  });
});

describe("isIpLiteral", () => {
  it("spots IPv4", () => {
    expect(isIpLiteral("10.0.0.5")).toBe(true);
  });

  it("spots IPv6 (already unbracketed by hostnameFromHost)", () => {
    expect(isIpLiteral("2001:db8::5")).toBe(true);
  });

  it("does not mistake a domain for an address", () => {
    expect(isIpLiteral("polaris.example.com")).toBe(false);
  });
});

describe("resolveRelyingParty", () => {
  it("derives the RP ID and origin from an HTTPS request", () => {
    const result = resolveRelyingParty("polaris.example.com", "https", "");
    expect(result).toEqual({ ok: true, rp: { rpId: "polaris.example.com", origin: "https://polaris.example.com" } });
  });

  it("keeps a non-default port in the origin but not in the RP ID", () => {
    // The origin is compared byte-for-byte against what the browser reports;
    // the RP ID is a bare domain and a port in it would never match.
    const result = resolveRelyingParty("polaris.example.com:8443", "https", "");
    expect(result).toEqual({
      ok: true,
      rp: { rpId: "polaris.example.com", origin: "https://polaris.example.com:8443" },
    });
  });

  it("allows plain HTTP on localhost — the dev stack is a secure context", () => {
    const result = resolveRelyingParty("localhost:3000", "http", "");
    expect(result).toEqual({ ok: true, rp: { rpId: "localhost", origin: "http://localhost:3000" } });
  });

  it("refuses plain HTTP anywhere else, and says why", () => {
    const result = resolveRelyingParty("polaris.example.com", "http", "");
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/HTTPS/);
  });

  it("refuses an IP-address install, and says why", () => {
    // A supported Polaris deployment that simply cannot have passkeys.
    const result = resolveRelyingParty("10.0.0.5", "https", "");
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/domain name/);
  });

  it("refuses a request with no Host header", () => {
    expect(resolveRelyingParty(undefined, "https", "").ok).toBe(false);
    expect(resolveRelyingParty("   ", "https", "").ok).toBe(false);
  });

  it("uses an operator override that covers the requested host", () => {
    const result = resolveRelyingParty("polaris.example.com", "https", "example.com");
    expect(result).toEqual({ ok: true, rp: { rpId: "example.com", origin: "https://polaris.example.com" } });
  });

  it("accepts an override equal to the host", () => {
    const result = resolveRelyingParty("polaris.example.com", "https", "polaris.example.com");
    expect((result as { rp: { rpId: string } }).rp.rpId).toBe("polaris.example.com");
  });

  it("refuses an override that does not cover the host, naming both", () => {
    // The browser would refuse this too, with an opaque SecurityError. Failing
    // here is what turns "passkeys don't work" into an actionable message.
    const result = resolveRelyingParty("polaris.example.com", "https", "other.example.net");
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/other\.example\.net/);
    expect((result as { reason: string }).reason).toMatch(/polaris\.example\.com/);
  });

  it("refuses a suffix that is not a domain boundary", () => {
    // "evilexample.com".endsWith("example.com") is true as a string and false
    // as a domain relationship.
    expect(resolveRelyingParty("evilexample.com", "https", "example.com").ok).toBe(false);
  });

  it("is case-insensitive about both the host and the override", () => {
    const result = resolveRelyingParty("Polaris.Example.COM", "https", "EXAMPLE.com");
    expect((result as { rp: { rpId: string } }).rp.rpId).toBe("example.com");
  });
});

describe("forwardedProtoClaim", () => {
  it("reads X-Forwarded-Proto", () => {
    expect(forwardedProtoClaim({ "x-forwarded-proto": "https" })).toBe("https");
  });

  it("takes the first hop of a chain — the one nearest the browser", () => {
    // Two proxies: TLS at the edge, plain HTTP between them. The page WAS
    // served over HTTPS, which is the only hop a secure context depends on.
    expect(forwardedProtoClaim({ "x-forwarded-proto": "https, http" })).toBe("https");
  });

  it("reads X-Forwarded-Scheme, which Nginx Proxy Manager sends", () => {
    expect(forwardedProtoClaim({ "x-forwarded-scheme": "https" })).toBe("https");
  });

  it("reads RFC 7239 Forwarded", () => {
    expect(forwardedProtoClaim({ forwarded: 'for=203.0.113.9;proto=https;by=203.0.113.1' })).toBe("https");
  });

  it("reads X-Forwarded-Ssl: on", () => {
    expect(forwardedProtoClaim({ "x-forwarded-ssl": "on" })).toBe("https");
    expect(forwardedProtoClaim({ "x-forwarded-ssl": "off" })).toBeNull();
  });

  it("takes the first element when Node hands it a repeated header", () => {
    expect(forwardedProtoClaim({ "x-forwarded-proto": ["https", "http"] })).toBe("https");
  });

  it("is null when no proxy said anything", () => {
    expect(forwardedProtoClaim({ host: "polaris.example.com" })).toBeNull();
    expect(forwardedProtoClaim(undefined)).toBeNull();
  });
});

describe("resolveRelyingParty behind a TLS-terminating proxy", () => {
  // The shape that reads as "no TLS" from inside Express but is a perfectly
  // ordinary HTTPS install: nginx/Caddy/Traefik/NPM in front, TRUST_PROXY unset.
  it("names TRUST_PROXY, not TLS, when the proxy claimed https and Express did not believe it", () => {
    const result = resolveRelyingParty("polaris.example.com", "http", "", "https");
    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).toMatch(/TRUST_PROXY/);
    // The advice the operator has already taken must NOT be what they are told.
    expect(reason).not.toMatch(/Put Polaris behind TLS/);
  });

  it("still refuses — a forwarded header never grants the secure context", () => {
    // Believing it would only produce a ceremony the browser then rejects, and
    // the header is spoofable by anyone who can reach the port.
    expect(resolveRelyingParty("polaris.example.com", "http", "", "https").ok).toBe(false);
  });

  it("gives the plain-HTTP reason when the proxy claimed http too", () => {
    const result = resolveRelyingParty("polaris.example.com", "http", "", "http");
    expect((result as { reason: string }).reason).toMatch(/Put Polaris behind TLS/);
  });

  it("mentions the proxy path in the plain-HTTP reason, for a proxy that forwards nothing", () => {
    const result = resolveRelyingParty("polaris.example.com", "http", "", null);
    expect((result as { reason: string }).reason).toMatch(/X-Forwarded-Proto/);
  });

  it("ignores the claim entirely once Express itself says https", () => {
    const result = resolveRelyingParty("polaris.example.com", "https", "", "http");
    expect(result).toEqual({ ok: true, rp: { rpId: "polaris.example.com", origin: "https://polaris.example.com" } });
  });
});
