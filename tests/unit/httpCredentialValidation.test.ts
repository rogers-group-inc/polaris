/**
 * tests/unit/httpCredentialValidation.test.ts
 *
 * Save-time validation of the `http` credential and of the HTTP CHECK
 * DEFINITION, which since 2026-08 are two separate things: the credential
 * carries authentication only, and the check (path / expected status / expected
 * body / TLS) lives on a manufacturer custom widget, with the Test Connection
 * flow supplying one ad hoc.
 *
 * The point of validating either at all is WHEN the operator finds out: a check
 * is exercised by a background pass once per asset per interval, so anything
 * not caught in the form is discovered from an error column hours later, on
 * every asset at once. The regex compile is the clearest case of that.
 */

import { describe, it, expect } from "vitest";
import { validateConfig, validateHttpCheckDefinition } from "../../src/services/credentialService.js";

/** Both validators mutate their argument (canonicalization) — hand over a copy. */
function cred(cfg: Record<string, unknown>) {
  const c = { ...cfg };
  validateConfig("http", c);
  return c;
}
function check(cfg: Record<string, unknown>) {
  const c = { ...cfg };
  validateHttpCheckDefinition(c);
  return c;
}

describe("http CREDENTIAL — authentication only", () => {
  it("accepts bearer with a token", () => {
    const c = cred({ authMode: "bearer", apiToken: "t0ken" });
    expect(c.authMode).toBe("bearer");
    expect(c.apiToken).toBe("t0ken");
  });
  it("accepts basic with both halves", () => {
    const c = cred({ authMode: "basic", username: "monitor", password: "s3cret" });
    expect(c.username).toBe("monitor");
    expect(c.password).toBe("s3cret");
  });
  it("accepts digest with both halves", () => {
    expect(cred({ authMode: "digest", username: "root", password: "pass" }).authMode).toBe("digest");
  });

  // "form" is a device admin login for the firmware repository (business
  // rule 87): the same two carriers, kept, and the token dropped.
  it("accepts form (a device admin login) with both halves and drops a stray token", () => {
    const c = cred({ authMode: "form", username: "admin", password: "pw", apiToken: "left over" });
    expect(c).toEqual({ authMode: "form", username: "admin", password: "pw" });
  });
  it("rejects form with a half missing, naming it a login rather than an auth scheme", () => {
    expect(() => cred({ authMode: "form", username: "admin" })).toThrow(/form login needs both a username and a password/);
    expect(() => cred({ authMode: "form", password: "pw" })).toThrow(/form login needs/);
  });

  // "none" is gone deliberately: a credential exists to authenticate, and an
  // unauthenticated check is a widget with no credential attached.
  it("rejects the none mode", () => {
    expect(() => cred({ authMode: "none" })).toThrow(/auth type must be one of/);
  });
  it("rejects a missing auth type rather than defaulting to one", () => {
    expect(() => cred({})).toThrow(/requires an authentication type/);
    expect(() => cred({ username: "u", password: "p" })).toThrow(/requires an authentication type/);
  });
  it("rejects an unknown mode", () => {
    expect(() => cred({ authMode: "ntlm" })).toThrow(/auth type must be one of/);
  });
  it("rejects bearer with no token", () => {
    expect(() => cred({ authMode: "bearer" })).toThrow(/bearer auth needs an API token/);
  });
  it("rejects digest with no password — naming digest, not basic", () => {
    expect(() => cred({ authMode: "digest", username: "root" }))
      .toThrow(/digest auth needs both a username and a password/);
  });
  it("rejects basic with no username", () => {
    expect(() => cred({ authMode: "basic", password: "p" }))
      .toThrow(/basic auth needs both a username and a password/);
  });

  // The strip runs on the MERGED config, so it is the only thing that can
  // actually remove a stored secret — blanking a field in the request body
  // means "keep the stored value" to mergeConfigPreservingSecrets.
  it("strips the bearer token when the mode is digest", () => {
    expect(cred({ authMode: "digest", username: "u", password: "p", apiToken: "stale" }).apiToken).toBeUndefined();
  });
  it("strips the username/password pair when the mode is bearer", () => {
    const c = cred({ authMode: "bearer", apiToken: "t", username: "u", password: "p" });
    expect(c.username).toBeUndefined();
    expect(c.password).toBeUndefined();
  });

  // Pre-split credentials carried the whole check. Those fields are dropped
  // rather than migrated — a credential names no manufacturer or model, so
  // there is nothing to attribute a widget to without inventing it.
  it("strips every leftover check-definition field", () => {
    const c = cred({
      authMode: "basic", username: "u", password: "p",
      useHttps: true, port: 8443, path: "/healthz", expectStatus: 204,
      expectBody: "OK", matchMode: "regex", caseSensitive: true,
      failOnMismatch: false, verifyTls: true,
    });
    for (const stale of ["useHttps", "port", "path", "expectStatus", "expectBody",
                         "matchMode", "caseSensitive", "failOnMismatch", "verifyTls"]) {
      expect(c[stale], stale).toBeUndefined();
    }
    expect(c.username).toBe("u");
  });
});

describe("http CHECK DEFINITION — accepted shapes", () => {
  it("accepts an entirely empty definition: GET / expecting any 2xx is a valid check", () => {
    expect(check({}).path).toBe("/");
  });
  it("canonicalizes the path so the stored value equals the request line", () => {
    expect(check({ path: "healthz" }).path).toBe("/healthz");
    expect(check({ path: "  /healthz \n" }).path).toBe("/healthz");
  });
  it("stores a blank path as / — this IS the definition, so it must name a path", () => {
    // Deliberately unlike Asset.httpCheckPath, where blank means "no override".
    expect(check({ path: "" }).path).toBe("/");
  });
  it("coerces port and expectStatus to numbers so the stored JSON is typed", () => {
    const c = check({ port: "8443", expectStatus: "204" });
    expect(c.port).toBe(8443);
    expect(c.expectStatus).toBe(204);
  });
  it("accepts a valid regex", () => {
    expect(() => check({ expectBody: '"state"\\s*:\\s*"up"', matchMode: "regex" })).not.toThrow();
  });
  it("tolerates a lone caseSensitive toggle with no expectBody", () => {
    // Harmless, and rejecting it would 400 a form mid-edit.
    expect(() => check({ caseSensitive: true })).not.toThrow();
  });
  it("strips a leftover failOnMismatch rather than rejecting it", () => {
    // Dropped, not 400'd, so a widget stored while the toggle existed re-saves
    // cleanly instead of failing on a field the form no longer sends.
    expect(check({ failOnMismatch: false }).failOnMismatch).toBeUndefined();
  });
  it("keeps a query string on the path — legitimate on a health endpoint", () => {
    expect(check({ path: "/axis-cgi/param.cgi?action=list" }).path)
      .toBe("/axis-cgi/param.cgi?action=list");
  });
});

describe("http CHECK DEFINITION — rejected shapes", () => {
  it("rejects an invalid regex at SAVE time, not once per probe forever", () => {
    expect(() => check({ expectBody: "([unclosed", matchMode: "regex" })).toThrow(/regex is invalid/i);
  });
  it("does not compile the pattern in contains mode — a bare bracket is legitimate text", () => {
    expect(() => check({ expectBody: "([unclosed" })).not.toThrow();
  });
  it("rejects an out-of-range port", () => {
    expect(() => check({ port: 0 })).toThrow(/between 1 and 65535/);
    expect(() => check({ port: 70000 })).toThrow(/between 1 and 65535/);
  });
  it("rejects a status code that isn't one", () => {
    expect(() => check({ expectStatus: 99 })).toThrow(/status code/i);
    expect(() => check({ expectStatus: 600 })).toThrow(/status code/i);
  });
  it("rejects an unknown match mode", () => {
    expect(() => check({ matchMode: "glob" })).toThrow(/contains/);
  });
  it("rejects non-boolean flags", () => {
    expect(() => check({ verifyTls: "yes" })).toThrow(/must be a boolean/);
    expect(() => check({ useHttps: 1 })).toThrow(/must be a boolean/);
  });
});
