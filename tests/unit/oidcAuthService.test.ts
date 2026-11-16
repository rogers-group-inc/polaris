/**
 * tests/unit/oidcAuthService.test.ts — own unit suite for
 * src/services/oidcAuthService.ts (CQ-T010 batch 8c).
 *
 * openid-client is replaced wholesale — no discovery document, JWKS or token
 * endpoint is ever contacted. The service holds a settings cache and a
 * discovered Configuration at module level with no reset hook, so every test
 * re-imports it after vi.resetModules() (the mocks live in vi.hoisted state
 * and survive the reset). getRedirectUri also has oidcRedirect.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  const meta = {
    issuer: "https://idp.example",
    authorization_endpoint: "https://idp.example/authorize",
    token_endpoint: "https://idp.example/token",
    userinfo_endpoint: "https://idp.example/userinfo",
  };
  return {
    meta,
    prisma: { setting: { findUnique: vi.fn(), upsert: vi.fn() } },
    provisionExternalUser: vi.fn(),
    client: {
      discovery: vi.fn(),
      randomPKCECodeVerifier: vi.fn(() => "verifier-1"),
      calculatePKCECodeChallenge: vi.fn(async () => "challenge-1"),
      randomState: vi.fn(() => "state-1"),
      randomNonce: vi.fn(() => "nonce-1"),
      buildAuthorizationUrl: vi.fn(),
      authorizationCodeGrant: vi.fn(),
      fetchUserInfo: vi.fn(),
    },
  };
});

vi.mock("openid-client", () => h.client);
vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/ssoProvisioning.js", () => ({ provisionExternalUser: h.provisionExternalUser }));

type Svc = typeof import("../../src/services/oidcAuthService.js");
let svc: Svc;

const MASK = "••••••••";
const CONFIGURED = {
  enabled: true,
  discoveryUrl: "https://idp.example",
  clientId: "polaris",
  clientSecret: "s3cret",
};
const FAKE_CONFIG = { serverMetadata: () => h.meta };
const ORIGINAL_PUBLIC_URL = process.env.POLARIS_PUBLIC_URL;

function stored(value: Record<string, unknown> | null) {
  h.prisma.setting.findUnique.mockResolvedValue(value ? { key: "oidc", value } : null);
}

function tokens(claims: Record<string, unknown> | undefined, accessToken?: string) {
  return { claims: () => claims, access_token: accessToken };
}

beforeEach(async () => {
  process.env.POLARIS_PUBLIC_URL = "https://polaris.example/";
  h.prisma.setting.findUnique.mockReset();
  h.prisma.setting.upsert.mockReset().mockResolvedValue({});
  h.provisionExternalUser.mockReset();
  h.client.discovery.mockReset().mockResolvedValue(FAKE_CONFIG);
  h.client.buildAuthorizationUrl.mockReset().mockReturnValue(new URL("https://idp.example/authorize?x=1"));
  h.client.authorizationCodeGrant.mockReset();
  h.client.fetchUserInfo.mockReset();
  vi.resetModules();
  svc = await import("../../src/services/oidcAuthService.js");
});

afterEach(() => {
  if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.POLARIS_PUBLIC_URL;
  else process.env.POLARIS_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
});

describe("getRedirectUri", () => {
  it("derives the callback from POLARIS_PUBLIC_URL", () => {
    expect(svc.getRedirectUri()).toBe("https://polaris.example/api/v1/auth/oidc/callback");
  });

  it("400s when POLARIS_PUBLIC_URL is unset", () => {
    delete process.env.POLARIS_PUBLIC_URL;
    expect(() => svc.getRedirectUri()).toThrow(expect.objectContaining({ httpStatus: 400 }));
  });
});

describe("getOidcSettingsForUi", () => {
  it("returns defaults with a blank secret when nothing is stored", async () => {
    stored(null);
    const s = await svc.getOidcSettingsForUi();
    expect(s).toMatchObject({
      enabled: false,
      clientSecret: "",
      scopes: "openid profile email",
      groupsClaim: "groups",
      usernameClaim: "preferred_username",
      redirectUri: "https://polaris.example/api/v1/auth/oidc/callback",
    });
  });

  it("masks a stored secret", async () => {
    stored(CONFIGURED);
    expect((await svc.getOidcSettingsForUi()).clientSecret).toBe(MASK);
  });

  it("degrades the redirect URI to a hint (not a throw) when POLARIS_PUBLIC_URL is unset", async () => {
    delete process.env.POLARIS_PUBLIC_URL;
    stored(CONFIGURED);
    expect((await svc.getOidcSettingsForUi()).redirectUri).toBe("(set POLARIS_PUBLIC_URL to derive)");
  });
});

describe("keptOidcClientSecret (rule 111(a))", () => {
  const cur = { discoveryUrl: "https://idp.example", clientId: "polaris", clientSecret: "stored" };

  it("keeps the stored secret when clientSecret is omitted, under the same destination check", () => {
    expect(svc.keptOidcClientSecret(cur, {})).toBe("stored");
    expect(() => svc.keptOidcClientSecret(cur, { clientId: "other" })).toThrow(expect.objectContaining({ httpStatus: 400 }));
  });

  it("saves a typed secret exactly as typed, clears on blank", () => {
    // Was a bug until 2026-11-16: a typed secret was trimmed (" typed " saved as "typed").
    expect(svc.keptOidcClientSecret(cur, { clientSecret: " typed " })).toBe(" typed ");
    expect(svc.keptOidcClientSecret(cur, { clientSecret: "" })).toBe("");
    expect(svc.keptOidcClientSecret(cur, { clientSecret: "  " })).toBe("");
  });

  it("keeps the stored secret for an echoed mask while discovery URL + client id are unchanged", () => {
    expect(svc.keptOidcClientSecret(cur, { clientSecret: MASK })).toBe("stored");
    expect(svc.keptOidcClientSecret(cur, { clientSecret: "********", discoveryUrl: "https://idp.example", clientId: "polaris" })).toBe(
      "stored",
    );
  });

  it("returns '' for an echoed mask when nothing is stored", () => {
    expect(svc.keptOidcClientSecret({ ...cur, clientSecret: "" }, { clientSecret: MASK })).toBe("");
  });

  it("400s an echoed mask when the discovery URL moved", () => {
    expect(() => svc.keptOidcClientSecret(cur, { clientSecret: MASK, discoveryUrl: "https://evil.example" })).toThrow(
      expect.objectContaining({ httpStatus: 400, message: expect.stringContaining("discovery URL") }),
    );
  });

  it("400s an echoed mask when the client id changed", () => {
    expect(() => svc.keptOidcClientSecret(cur, { clientSecret: MASK, clientId: "other" })).toThrow(
      expect.objectContaining({ httpStatus: 400, message: expect.stringContaining("client ID") }),
    );
  });
});

describe("updateOidcSettings / isOidcEnabled", () => {
  it("trims, falls back to stored / default values, upserts and refreshes the cache", async () => {
    stored({ ...CONFIGURED, groupsClaim: "roles" });
    const out = await svc.updateOidcSettings({ enabled: true, clientSecret: MASK, scopes: "  ", clientId: " polaris " });
    expect(out).toMatchObject({
      enabled: true,
      discoveryUrl: "https://idp.example",
      clientId: "polaris",
      clientSecret: "s3cret",
      scopes: "openid profile email",
      groupsClaim: "roles",
    });
    expect(h.prisma.setting.upsert).toHaveBeenCalledWith({
      where: { key: "oidc" },
      update: { value: out },
      create: { key: "oidc", value: out },
    });
    expect(await svc.isOidcEnabled()).toBe(true);
    expect(h.prisma.setting.findUnique).toHaveBeenCalledTimes(1);
  });

  it("drops the discovered configuration so the next login rediscovers with the new settings", async () => {
    stored(CONFIGURED);
    await svc.buildAuthorizationUrl();
    await svc.buildAuthorizationUrl();
    expect(h.client.discovery).toHaveBeenCalledTimes(1);
    await svc.updateOidcSettings({ ...CONFIGURED, clientSecret: "rotated" });
    await svc.buildAuthorizationUrl();
    expect(h.client.discovery).toHaveBeenCalledTimes(2);
    expect(h.client.discovery.mock.calls[1][2]).toBe("rotated");
  });

  it("an omitted enabled / clientSecret keeps its stored value", async () => {
    // Was a bug until 2026-11-16: an omitted enabled turned OIDC off and an omitted clientSecret cleared the secret.
    stored(CONFIGURED);
    const out = await svc.updateOidcSettings({ scopes: "openid email" });
    expect(out.enabled).toBe(true);
    expect(out.clientSecret).toBe(CONFIGURED.clientSecret);
    expect(out.scopes).toBe("openid email");
  });

  it("an omitted clientSecret still refuses to follow a moved discovery URL (rule 111(a))", async () => {
    stored(CONFIGURED);
    await expect(svc.updateOidcSettings({ discoveryUrl: "https://evil.example" })).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.prisma.setting.upsert).not.toHaveBeenCalled();
  });

  it("an explicit false / blank still turns OIDC off and clears the secret", async () => {
    stored(CONFIGURED);
    const out = await svc.updateOidcSettings({ enabled: false, clientSecret: "" });
    expect(out.enabled).toBe(false);
    expect(out.clientSecret).toBe("");
  });

  it("rediscovers when another process changed the settings (the cached discovery is keyed by them)", async () => {
    // Was a bug until 2026-11-16: discovery was cached until updateOidcSettings ran in THIS process, so other web processes kept the old issuer.
    vi.useFakeTimers();
    try {
      stored(CONFIGURED);
      await svc.buildAuthorizationUrl();
      stored({ ...CONFIGURED, discoveryUrl: "https://idp2.example" });
      vi.advanceTimersByTime(31_000); // settings cache expires
      await svc.buildAuthorizationUrl();
      expect(h.client.discovery).toHaveBeenCalledTimes(2);
      expect(String(h.client.discovery.mock.calls[1][0])).toContain("idp2.example");
      await svc.buildAuthorizationUrl();
      expect(h.client.discovery).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [CONFIGURED, true],
    [{ ...CONFIGURED, enabled: false }, false],
    [{ ...CONFIGURED, discoveryUrl: "" }, false],
    [{ ...CONFIGURED, clientId: "" }, false],
    [{ ...CONFIGURED, clientSecret: "" }, false],
  ])("isOidcEnabled(%o) → %s", async (value, expected) => {
    stored(value);
    expect(await svc.isOidcEnabled()).toBe(expected);
  });
});

describe("buildAuthorizationUrl", () => {
  it("400s when OIDC is not configured, without discovery", async () => {
    stored({ ...CONFIGURED, clientSecret: "" });
    await expect(svc.buildAuthorizationUrl()).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.client.discovery).not.toHaveBeenCalled();
  });

  it("strips a .well-known suffix from the discovery URL to get the issuer", async () => {
    stored({ ...CONFIGURED, discoveryUrl: " https://idp.example/tenant/.well-known/openid-configuration/ " });
    await svc.buildAuthorizationUrl();
    const [issuer, clientId, secret] = h.client.discovery.mock.calls[0];
    expect(String(issuer)).toBe("https://idp.example/tenant");
    expect(clientId).toBe("polaris");
    expect(secret).toBe("s3cret");
  });

  it("builds a PKCE-S256 URL with state, nonce, scopes and the derived redirect URI", async () => {
    stored({ ...CONFIGURED, scopes: "openid groups" });
    const out = await svc.buildAuthorizationUrl();
    expect(h.client.buildAuthorizationUrl).toHaveBeenCalledWith(FAKE_CONFIG, {
      redirect_uri: "https://polaris.example/api/v1/auth/oidc/callback",
      scope: "openid groups",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
      state: "state-1",
      nonce: "nonce-1",
    });
    expect(h.client.calculatePKCECodeChallenge).toHaveBeenCalledWith("verifier-1");
    expect(out).toEqual({ url: "https://idp.example/authorize?x=1", state: "state-1", nonce: "nonce-1", codeVerifier: "verifier-1" });
  });

  it("does not cache a failed discovery", async () => {
    stored(CONFIGURED);
    h.client.discovery.mockRejectedValueOnce(new Error("unreachable"));
    await expect(svc.buildAuthorizationUrl()).rejects.toThrow("unreachable");
    await svc.buildAuthorizationUrl();
    expect(h.client.discovery).toHaveBeenCalledTimes(2);
  });
});

describe("handleCallback", () => {
  const checks = { state: "state-1", nonce: "nonce-1", codeVerifier: "verifier-1" };
  const CALLBACK = "https://polaris.example/api/v1/auth/oidc/callback?code=abc&state=state-1";

  it("passes the session checks to the code grant and requires an ID token", async () => {
    stored(CONFIGURED);
    h.client.authorizationCodeGrant.mockResolvedValue(tokens({ sub: "u-1" }));
    await svc.handleCallback(CALLBACK, checks);
    const [config, url, opts] = h.client.authorizationCodeGrant.mock.calls[0];
    expect(config).toBe(FAKE_CONFIG);
    expect(String(url)).toBe(CALLBACK);
    expect(opts).toEqual({ expectedState: "state-1", expectedNonce: "nonce-1", pkceCodeVerifier: "verifier-1", idTokenExpected: true });
  });

  it("502s when the ID token has no sub", async () => {
    stored(CONFIGURED);
    h.client.authorizationCodeGrant.mockResolvedValue(tokens(undefined));
    await expect(svc.handleCallback(CALLBACK, checks)).rejects.toMatchObject({ httpStatus: 502 });
  });

  it("maps the configured claims from the ID token alone when there is no access token", async () => {
    stored({ ...CONFIGURED, usernameClaim: "upn", groupsClaim: "roles", displayNameClaim: "given_name", emailClaim: "mail" });
    h.client.authorizationCodeGrant.mockResolvedValue(
      tokens({ sub: "u-1", upn: "alice@corp", roles: [" ops ", "", "noc"], given_name: "Alice", mail: "a@corp" }),
    );
    const out = await svc.handleCallback(CALLBACK, checks);
    expect(out).toEqual({ sub: "u-1", username: "alice@corp", displayName: "Alice", email: "a@corp", groups: ["ops", "noc"] });
    expect(h.client.fetchUserInfo).not.toHaveBeenCalled();
  });

  it("merges userinfo over the ID-token claims, keeping the validated sub", async () => {
    stored(CONFIGURED);
    h.client.authorizationCodeGrant.mockResolvedValue(tokens({ sub: "u-1", name: "Old" }, "at-1"));
    h.client.fetchUserInfo.mockResolvedValue({ sub: "u-1", name: "New", groups: "single-group", preferred_username: "alice" });
    const out = await svc.handleCallback(CALLBACK, checks);
    expect(h.client.fetchUserInfo).toHaveBeenCalledWith(FAKE_CONFIG, "at-1", "u-1");
    expect(out).toEqual({ sub: "u-1", username: "alice", displayName: "New", email: "", groups: ["single-group"] });
  });

  it("a failing userinfo call is best-effort", async () => {
    stored(CONFIGURED);
    h.client.authorizationCodeGrant.mockResolvedValue(tokens({ sub: "u-1", preferred_username: "alice" }, "at-1"));
    h.client.fetchUserInfo.mockRejectedValue(new Error("userinfo 500"));
    expect((await svc.handleCallback(CALLBACK, checks)).username).toBe("alice");
  });

  it("falls back from the username claim to email, then to sub", async () => {
    stored(CONFIGURED);
    h.client.authorizationCodeGrant.mockResolvedValueOnce(tokens({ sub: "u-1", email: "a@x" }));
    expect((await svc.handleCallback(CALLBACK, checks)).username).toBe("a@x");
    h.client.authorizationCodeGrant.mockResolvedValueOnce(tokens({ sub: "u-2" }));
    const out = await svc.handleCallback(CALLBACK, checks);
    expect(out.username).toBe("u-2");
    expect(out.groups).toEqual([]);
  });

  it("the username fallback uses the configured email claim, not a literal `email`", async () => {
    // Was a bug until 2026-11-16: the fallback read merged.email regardless of emailClaim.
    stored({ ...CONFIGURED, emailClaim: "mail" });
    h.client.authorizationCodeGrant.mockResolvedValueOnce(tokens({ sub: "u-1", mail: "m@x", email: "e@x" }));
    expect((await svc.handleCallback(CALLBACK, checks)).username).toBe("m@x");
  });

  it("propagates a rejected code grant (state / nonce / PKCE mismatch)", async () => {
    stored(CONFIGURED);
    h.client.authorizationCodeGrant.mockRejectedValue(new Error("state mismatch"));
    await expect(svc.handleCallback(CALLBACK, checks)).rejects.toThrow("state mismatch");
  });
});

describe("findOrProvisionOidcUser", () => {
  it("provisions under oidc / oidcSubject, empty profile fields as null", async () => {
    h.provisionExternalUser.mockResolvedValue({ id: "u" });
    await svc.findOrProvisionOidcUser({ sub: "s-1", username: "alice", displayName: "", email: "a@x", groups: ["g"] });
    expect(h.provisionExternalUser).toHaveBeenCalledWith({
      provider: "oidc",
      externalIdField: "oidcSubject",
      externalId: "s-1",
      usernameHint: "alice",
      displayName: null,
      email: "a@x",
      groups: ["g"],
    });
  });
});

describe("testOidcConnection", () => {
  it.each([
    [{ ...CONFIGURED, discoveryUrl: "" }, "Discovery URL is required"],
    [{ ...CONFIGURED, clientId: "" }, "Client ID is required"],
    [{ ...CONFIGURED, clientSecret: "" }, "Client secret is required"],
  ])("refuses an incomplete config (%#)", async (value, message) => {
    stored(value);
    expect(await svc.testOidcConnection()).toEqual({ ok: false, message });
    expect(h.client.discovery).not.toHaveBeenCalled();
  });

  it("refuses without POLARIS_PUBLIC_URL", async () => {
    delete process.env.POLARIS_PUBLIC_URL;
    stored(CONFIGURED);
    const out = await svc.testOidcConnection();
    expect(out.ok).toBe(false);
    expect(out.message).toContain("POLARIS_PUBLIC_URL");
  });

  it("forces a fresh discovery and reports the issuer + endpoints", async () => {
    stored(CONFIGURED);
    await svc.buildAuthorizationUrl();
    const out = await svc.testOidcConnection();
    expect(h.client.discovery).toHaveBeenCalledTimes(2);
    expect(out).toEqual({
      ok: true,
      message: "Discovery succeeded — issuer https://idp.example",
      details: { ...h.meta, redirectUri: "https://polaris.example/api/v1/auth/oidc/callback" },
    });
  });

  it("reports a discovery failure", async () => {
    stored(CONFIGURED);
    h.client.discovery.mockRejectedValue(new Error("ENOTFOUND idp.example"));
    expect(await svc.testOidcConnection()).toEqual({ ok: false, message: "Discovery failed: ENOTFOUND idp.example" });
  });
});
