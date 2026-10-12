/**
 * tests/unit/samlReplay.test.ts
 *
 * A SAML assertion signs one person in, once (scan finding F242; business rule
 * 108), and the client binds a response to its request whenever the response
 * says it answers one.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { validatePost, ctor } = vi.hoisted(() => ({ validatePost: vi.fn(), ctor: vi.fn() }));

vi.mock("@node-saml/node-saml", () => ({
  ValidateInResponseTo: { never: "never", ifPresent: "ifPresent", always: "always" },
  SAML: class {
    constructor(cfg: unknown) {
      ctor(cfg);
    }
    validatePostResponseAsync = validatePost;
    getAuthorizeUrlAsync = vi.fn();
  },
}));
vi.mock("../../src/services/settingsStore.js", () => ({
  createSettingStore: () => ({
    get: async () => ({
      enabled: true,
      idpEntityId: "https://idp.example.com/entity",
      idpLoginUrl: "https://idp.example.com/login",
      idpLogoutUrl: "",
      idpCertificate: "CERT",
      spEntityId: "https://polaris.example.com",
      wantResponseSigned: true,
    }),
    invalidate: () => {},
  }),
}));
vi.mock("../../src/services/ssoProvisioning.js", () => ({ provisionExternalUser: vi.fn() }));
vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { validateSamlResponse } from "../../src/services/azureAuthService.js";
import { claimSamlAssertion, clearSamlReplayCache, SAML_REPLAY_TTL_MS } from "../../src/utils/samlReplayCache.js";

describe("claimSamlAssertion", () => {
  beforeEach(() => clearSamlReplayCache());

  it("accepts an assertion once and refuses a repeat", () => {
    expect(claimSamlAssertion("_abc")).toBe(true);
    expect(claimSamlAssertion("_abc")).toBe(false);
    expect(claimSamlAssertion("_def")).toBe(true);
  });

  it("refuses an assertion with no ID rather than leaving it unprotected", () => {
    expect(claimSamlAssertion(undefined)).toBe(false);
    expect(claimSamlAssertion("")).toBe(false);
    expect(claimSamlAssertion(null)).toBe(false);
  });

  it("forgets an assertion after the window", () => {
    const t0 = 1_000_000;
    expect(claimSamlAssertion("_old", t0)).toBe(true);
    expect(claimSamlAssertion("_old", t0 + SAML_REPLAY_TTL_MS - 1)).toBe(false);
    expect(claimSamlAssertion("_old", t0 + SAML_REPLAY_TTL_MS + 1)).toBe(true);
  });

  it("stays bounded under a burst of distinct assertions", () => {
    for (let i = 0; i < 6000; i++) claimSamlAssertion(`_id${i}`, 1_000_000 + i);
    // The earliest were evicted to stay under the cap; the latest are still tracked.
    expect(claimSamlAssertion("_id5999", 1_000_000 + 6000)).toBe(false);
    expect(claimSamlAssertion("_id0", 1_000_000 + 6000)).toBe(true);
  });
});

describe("validateSamlResponse", () => {
  beforeEach(() => {
    clearSamlReplayCache();
    validatePost.mockReset();
  });

  it("builds the client with request binding on when a response names its request", async () => {
    validatePost.mockResolvedValue({ profile: { ID: "_one", nameID: "a@example.com", issuer: "idp" } });
    await validateSamlResponse({ SAMLResponse: "x" });
    expect(ctor).toHaveBeenCalled();
    expect(ctor.mock.calls[0][0].validateInResponseTo).toBe("ifPresent");
  });

  it("accepts a response once and refuses the same assertion presented again", async () => {
    validatePost.mockResolvedValue({ profile: { ID: "_replayed", nameID: "a@example.com", issuer: "idp" } });
    await expect(validateSamlResponse({ SAMLResponse: "x" })).resolves.toMatchObject({ ID: "_replayed" });
    await expect(validateSamlResponse({ SAMLResponse: "x" })).rejects.toMatchObject({ httpStatus: 401 });
  });

  it("accepts two different assertions", async () => {
    validatePost.mockResolvedValueOnce({ profile: { ID: "_a", nameID: "a@example.com", issuer: "idp" } });
    validatePost.mockResolvedValueOnce({ profile: { ID: "_b", nameID: "a@example.com", issuer: "idp" } });
    await expect(validateSamlResponse({ SAMLResponse: "1" })).resolves.toBeTruthy();
    await expect(validateSamlResponse({ SAMLResponse: "2" })).resolves.toBeTruthy();
  });

  it("falls back to a hash of the assertion XML when the library surfaces no ID", async () => {
    const profile = { nameID: "a@example.com", issuer: "idp", getAssertionXml: () => "<Assertion>unique</Assertion>" };
    validatePost.mockResolvedValue({ profile });
    await expect(validateSamlResponse({ SAMLResponse: "x" })).resolves.toBeTruthy();
    await expect(validateSamlResponse({ SAMLResponse: "x" })).rejects.toMatchObject({ httpStatus: 401 });
  });

  it("refuses a profile with neither an ID nor assertion XML", async () => {
    validatePost.mockResolvedValue({ profile: { nameID: "a@example.com", issuer: "idp" } });
    await expect(validateSamlResponse({ SAMLResponse: "x" })).rejects.toMatchObject({ httpStatus: 401 });
  });
});
