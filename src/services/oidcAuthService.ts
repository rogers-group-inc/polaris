/**
 * src/services/oidcAuthService.ts — OpenID Connect (Authorization Code + PKCE)
 *
 * Real OIDC login built on `openid-client` v6 (functional API). Discovery,
 * JWKS, PKCE-S256, and ID-token signature/iss/aud/exp/nonce validation are all
 * handled by the library — we own only config storage, the redirect URI, and
 * group→role provisioning.
 *
 * Settings live in the `oidc` Setting row. clientSecret is masked "********" on
 * read and preserved-on-unchanged on write (same as SAML/LDAP secrets).
 *
 * SECURITY: state (CSRF), nonce (ID-token replay), and the PKCE code_verifier
 * are stored in the (PG-backed) session between /oidc/login and /oidc/callback.
 * The callback is a top-level GET navigation, so SameSite=Lax cookies ARE sent
 * (unlike the SAML cross-site POST) and the session checks work normally. The
 * callback never honors a caller-supplied return path — it always redirects to
 * "/" — so there is no open-redirect surface.
 */

import { trimTrailing } from "../utils/trimTrailing.js";
import * as client from "openid-client";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { provisionExternalUser } from "./ssoProvisioning.js";
import { SECRET_MASK, LEGACY_ASTERISK_MASK, isMaskedSecret } from "../utils/secretMask.js";

export interface OidcSettings {
  enabled: boolean;
  discoveryUrl: string; // issuer or full .well-known URL
  clientId: string;
  clientSecret: string;
  scopes: string; // space-separated, must include "openid"
  groupsClaim: string;
  usernameClaim: string;
  emailClaim: string;
  displayNameClaim: string;
}

const OIDC_DEFAULTS: OidcSettings = {
  enabled: false,
  discoveryUrl: "",
  clientId: "",
  clientSecret: "",
  scopes: "openid profile email",
  groupsClaim: "groups",
  usernameClaim: "preferred_username",
  emailClaim: "email",
  displayNameClaim: "name",
};

// Emits the shared bullet mask; the merge below additionally accepts the
// pre-consolidation asterisk mask so an in-flight settings form from a
// pre-upgrade page still round-trips without clobbering the stored secret.
const MASK = SECRET_MASK;
const CALLBACK_PATH = "/api/v1/auth/oidc/callback";

let _cache: { value: OidcSettings; expiry: number } | null = null;
let _config: client.Configuration | null = null;

export async function getOidcSettings(): Promise<OidcSettings> {
  if (_cache && Date.now() < _cache.expiry) return _cache.value;
  const row = await prisma.setting.findUnique({ where: { key: "oidc" } });
  const value = row?.value
    ? { ...OIDC_DEFAULTS, ...(row.value as Record<string, any>) }
    : { ...OIDC_DEFAULTS };
  _cache = { value, expiry: Date.now() + 30000 };
  return value;
}

/**
 * Derived OIDC redirect URI. Requires POLARIS_PUBLIC_URL (the externally-
 * reachable base behind nginx). Throws when unset so login/test fail with a
 * clear message rather than sending the IdP a bad redirect_uri.
 */
export function getRedirectUri(): string {
  const base = trimTrailing((process.env.POLARIS_PUBLIC_URL || "").trim(), "/");
  if (!base) {
    throw new AppError(400, "POLARIS_PUBLIC_URL must be set for OIDC login (it derives the redirect URI).");
  }
  return `${base}${CALLBACK_PATH}`;
}

/** Settings for the admin UI — secret masked + the derived redirect URI. */
export async function getOidcSettingsForUi(): Promise<OidcSettings & { redirectUri: string }> {
  const s = await getOidcSettings();
  let redirectUri = "";
  try {
    redirectUri = getRedirectUri();
  } catch {
    redirectUri = "(set POLARIS_PUBLIC_URL to derive)";
  }
  return { ...s, clientSecret: s.clientSecret ? MASK : "", redirectUri };
}

export async function updateOidcSettings(input: Record<string, any>): Promise<OidcSettings> {
  const cur = await getOidcSettings();
  const value: OidcSettings = {
    enabled: !!input.enabled,
    discoveryUrl: (input.discoveryUrl ?? cur.discoveryUrl ?? "").trim(),
    clientId: (input.clientId ?? cur.clientId ?? "").trim(),
    clientSecret: isMaskedSecret(input.clientSecret) || input.clientSecret === LEGACY_ASTERISK_MASK
      ? cur.clientSecret
      : (input.clientSecret ?? "").trim(),
    scopes: (input.scopes ?? cur.scopes ?? OIDC_DEFAULTS.scopes).trim() || OIDC_DEFAULTS.scopes,
    groupsClaim: (input.groupsClaim ?? cur.groupsClaim ?? OIDC_DEFAULTS.groupsClaim).trim(),
    usernameClaim: (input.usernameClaim ?? cur.usernameClaim ?? OIDC_DEFAULTS.usernameClaim).trim(),
    emailClaim: (input.emailClaim ?? cur.emailClaim ?? OIDC_DEFAULTS.emailClaim).trim(),
    displayNameClaim: (input.displayNameClaim ?? cur.displayNameClaim ?? OIDC_DEFAULTS.displayNameClaim).trim(),
  };
  await prisma.setting.upsert({
    where: { key: "oidc" },
    update: { value: value as any },
    create: { key: "oidc", value: value as any },
  });
  _cache = { value, expiry: Date.now() + 30000 };
  _config = null; // rebuild discovery on next use
  return value;
}

export async function isOidcEnabled(): Promise<boolean> {
  const s = await getOidcSettings();
  return !!(s.enabled && s.discoveryUrl && s.clientId && s.clientSecret);
}

// Accept either the issuer URL or a full .well-known URL in the settings field.
function issuerUrl(discoveryUrl: string): URL {
  const trimmed = discoveryUrl.trim().replace(/\/\.well-known\/openid-configuration\/?$/i, "");
  return new URL(trimmed);
}

async function getConfig(): Promise<client.Configuration> {
  if (_config) return _config;
  const s = await getOidcSettings();
  if (!s.discoveryUrl || !s.clientId || !s.clientSecret) {
    throw new AppError(400, "OIDC is not configured");
  }
  _config = await client.discovery(issuerUrl(s.discoveryUrl), s.clientId, s.clientSecret);
  return _config;
}

export interface OidcAuthStart {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export async function buildAuthorizationUrl(): Promise<OidcAuthStart> {
  const s = await getOidcSettings();
  const config = await getConfig();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: getRedirectUri(),
    scope: s.scopes || "openid profile email",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return { url: url.href, state, nonce, codeVerifier };
}

export interface OidcClaims {
  sub: string;
  username: string;
  displayName: string;
  email: string;
  groups: string[];
}

function toStringArray(val: unknown): string[] {
  if (val == null) return [];
  if (Array.isArray(val)) return val.map((v) => String(v).trim()).filter(Boolean);
  return [String(val).trim()].filter(Boolean);
}

/**
 * Exchange the authorization code and validate the ID token. `currentUrl` is
 * the full callback URL (incl. query). The session-stored checks bind the
 * response to this login attempt.
 */
export async function handleCallback(
  currentUrl: string,
  checks: { state: string; nonce: string; codeVerifier: string },
): Promise<OidcClaims> {
  const s = await getOidcSettings();
  const config = await getConfig();
  const tokens = await client.authorizationCodeGrant(config, new URL(currentUrl), {
    expectedState: checks.state,
    expectedNonce: checks.nonce,
    pkceCodeVerifier: checks.codeVerifier,
    idTokenExpected: true,
  });

  const idClaims = (tokens.claims() ?? {}) as Record<string, unknown>;
  const sub = String(idClaims.sub || "");
  if (!sub) throw new AppError(502, "OIDC ID token missing `sub` claim");

  // Groups + profile claims may live in userinfo rather than the ID token.
  // Merge userinfo when an access token is present (best-effort).
  let merged: Record<string, unknown> = { ...idClaims };
  if (tokens.access_token) {
    try {
      const ui = await client.fetchUserInfo(config, tokens.access_token, sub);
      merged = { ...merged, ...(ui as Record<string, unknown>) };
    } catch {
      /* userinfo optional — ID token claims already validated */
    }
  }

  const username = String(merged[s.usernameClaim] || merged.email || sub);
  return {
    sub,
    username,
    displayName: String(merged[s.displayNameClaim] || ""),
    email: String(merged[s.emailClaim] || ""),
    groups: toStringArray(merged[s.groupsClaim]),
  };
}

export async function findOrProvisionOidcUser(claims: OidcClaims) {
  return provisionExternalUser({
    provider: "oidc",
    externalIdField: "oidcSubject",
    externalId: claims.sub,
    usernameHint: claims.username,
    displayName: claims.displayName || null,
    email: claims.email || null,
    groups: claims.groups,
  });
}

/** Admin "Test" button — run discovery + report the issuer/endpoints. */
export async function testOidcConnection(): Promise<{ ok: boolean; message: string; details?: Record<string, unknown> }> {
  const s = await getOidcSettings();
  if (!s.discoveryUrl) return { ok: false, message: "Discovery URL is required" };
  if (!s.clientId) return { ok: false, message: "Client ID is required" };
  if (!s.clientSecret) return { ok: false, message: "Client secret is required" };
  let redirectUri = "";
  try {
    redirectUri = getRedirectUri();
  } catch (err: any) {
    return { ok: false, message: err.message };
  }
  try {
    _config = null; // force fresh discovery for the test
    const config = await getConfig();
    const meta = config.serverMetadata();
    return {
      ok: true,
      message: `Discovery succeeded — issuer ${meta.issuer}`,
      details: {
        issuer: meta.issuer,
        authorization_endpoint: meta.authorization_endpoint,
        token_endpoint: meta.token_endpoint,
        userinfo_endpoint: meta.userinfo_endpoint,
        redirectUri,
      },
    };
  } catch (err: any) {
    return { ok: false, message: `Discovery failed: ${err?.message || err}` };
  }
}
