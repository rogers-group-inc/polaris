/**
 * src/services/azureAuthService.ts — Azure AD SSO via SAML 2.0
 *
 * IdP configuration (Entity ID, Login/Logout URLs, Certificate) is stored
 * in the Setting table (key "sso") and managed through the Users page
 * Settings modal.
 */

import { SAML, type SamlConfig, type Profile, ValidateInResponseTo } from "@node-saml/node-saml";
import { createSettingStore } from "./settingsStore.js";
import { provisionExternalUser } from "./ssoProvisioning.js";
import { AppError } from "../utils/errors.js";

// ─── SSO Settings (stored in Setting table) ─────────────────────────────────

export interface SsoSettings {
  enabled: boolean;
  spEntityId: string;
  idpEntityId: string;
  idpLoginUrl: string;
  idpLogoutUrl: string;
  idpCertificate: string;
  wantResponseSigned: boolean;
  skipLoginPage: boolean;
  autoLogoutMinutes: number;
}

const SSO_DEFAULTS: SsoSettings = {
  enabled: false,
  spEntityId: "",
  idpEntityId: "",
  idpLoginUrl: "",
  idpLogoutUrl: "",
  idpCertificate: "",
  wantResponseSigned: false,
  skipLoginPage: false,
  autoLogoutMinutes: 0,
};

// Simple in-memory cache to avoid DB reads on every request
const ssoStore = createSettingStore<SsoSettings>({
  key: "sso",
  ttlMs: 30000,
  parse: (raw) => (raw ? { ...SSO_DEFAULTS, ...(raw as Record<string, any>) } : { ...SSO_DEFAULTS }),
});

export async function getSsoSettings(): Promise<SsoSettings> {
  return ssoStore.get();
}

export async function updateSsoSettings(updates: Partial<SsoSettings>): Promise<SsoSettings> {
  const current = await getSsoSettings();
  const merged: SsoSettings = {
    enabled: updates.enabled !== undefined ? updates.enabled : current.enabled,
    spEntityId: updates.spEntityId !== undefined ? updates.spEntityId.trim() : current.spEntityId,
    idpEntityId: updates.idpEntityId !== undefined ? updates.idpEntityId.trim() : current.idpEntityId,
    idpLoginUrl: updates.idpLoginUrl !== undefined ? updates.idpLoginUrl.trim() : current.idpLoginUrl,
    idpLogoutUrl: updates.idpLogoutUrl !== undefined ? updates.idpLogoutUrl.trim() : current.idpLogoutUrl,
    idpCertificate: updates.idpCertificate !== undefined ? updates.idpCertificate.trim() : current.idpCertificate,
    wantResponseSigned: updates.wantResponseSigned !== undefined ? updates.wantResponseSigned : current.wantResponseSigned,
    skipLoginPage: updates.skipLoginPage !== undefined ? updates.skipLoginPage : current.skipLoginPage,
    autoLogoutMinutes:
      updates.autoLogoutMinutes !== undefined
        ? Math.max(0, Math.min(1440, updates.autoLogoutMinutes))
        : current.autoLogoutMinutes,
  };
  await ssoStore.save(merged);

  // Invalidate cached SAML client so it gets rebuilt with new config
  _samlClient = null;

  return merged;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export function isAzureSsoConfigured(): boolean {
  const s = ssoStore.peek();
  return !!(s && s.enabled && s.idpEntityId && s.idpLoginUrl && s.idpCertificate);
}

export async function isAzureSsoConfiguredAsync(): Promise<boolean> {
  const s = await getSsoSettings();
  return !!(s.enabled && s.idpEntityId && s.idpLoginUrl && s.idpCertificate);
}

// ─── SAML Client ─────────────────────────────────────────────────────────────

let _samlClient: SAML | null = null;

async function getSamlClient(): Promise<SAML> {
  if (_samlClient) return _samlClient;

  const settings = await getSsoSettings();
  if (!settings.idpEntityId || !settings.idpLoginUrl || !settings.idpCertificate) {
    throw new AppError(400, "SAML SSO is not configured");
  }
  if (!settings.spEntityId) {
    throw new AppError(400, "SAML SSO requires an Application URL — set it in Authentication Settings");
  }

  // Trim trailing slashes without a `/\/+$/` regex (polynomial backtracking
  // on adversarial input — CodeQL js/polynomial-redos).
  let baseUrl = settings.spEntityId;
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  const config: SamlConfig = {
    idpCert: settings.idpCertificate,
    issuer: baseUrl,
    callbackUrl: `${baseUrl}/api/v1/auth/azure/callback`,
    entryPoint: settings.idpLoginUrl,
    logoutUrl: settings.idpLogoutUrl || settings.idpLoginUrl,
    idpIssuer: settings.idpEntityId,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: settings.wantResponseSigned,
    disableRequestedAuthnContext: true,
    validateInResponseTo: ValidateInResponseTo.never,
  };

  _samlClient = new SAML(config);
  return _samlClient;
}

// ─── SAML Auth Flow ──────────────────────────────────────────────────────────

export async function getSamlLoginUrl(relayState: string): Promise<string> {
  const client = await getSamlClient();
  return client.getAuthorizeUrlAsync(relayState, undefined, {});
}

export async function validateSamlResponse(body: Record<string, string>): Promise<Profile> {
  const client = await getSamlClient();
  const { profile } = await client.validatePostResponseAsync(body);
  if (!profile) throw new AppError(401, "SAML assertion validation failed — no profile returned");
  return profile;
}

export async function getSamlLogoutUrl(nameID: string, sessionIndex: string, relayState: string): Promise<string> {
  const client = await getSamlClient();
  const user: Profile = {
    issuer: "",
    nameID,
    nameIDFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    sessionIndex,
  };
  return client.getLogoutUrlAsync(user, relayState, {});
}

// ─── User Provisioning ───────────────────────────────────────────────────────

/**
 * SAML claim extraction + delegation to the shared find-or-provision path
 * (2026-08 fold — this used to be a parallel re-implementation that lacked
 * group-mapping handling). Provider "azure" reproduces the historical SAML
 * username derivation exactly (email local-part, "-azure" collision suffix,
 * "azure-<oid>" fallbacks), while group mappings resolve under the "saml"
 * provider key the Group Mappings UI offers. Azure AD emits the groups claim
 * as group object-ID GUIDs (when the app is configured to send it) — map
 * those GUIDs unless the IdP is set to emit names.
 */
export async function findOrProvisionSamlUser(profile: Profile) {
  // SAML profile attributes — Azure AD typically sends these
  const nameID: string = profile.nameID || "";
  const email: string =
    (profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"] as string) ||
    (profile.email as string) ||
    (profile.mail as string) ||
    nameID;
  const displayName: string =
    (profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"] as string) ||
    (profile["http://schemas.microsoft.com/identity/claims/displayname"] as string) ||
    (profile.displayName as string) ||
    "";
  const oid: string =
    (profile["http://schemas.microsoft.com/identity/claims/objectidentifier"] as string) ||
    (profile.nameID as string) ||
    "";

  if (!oid) throw new AppError(502, "SAML assertion missing user identifier");

  // Azure AD's SAML groups claim. A single group arrives as a bare string,
  // several as an array; absent (app not configured to emit groups, or the
  // >150-group omission) yields [] — group resolution then returns empty and
  // an existing user's role is left untouched.
  const groupsRaw = profile["http://schemas.microsoft.com/ws/2008/06/identity/claims/groups"];
  const groups: string[] = Array.isArray(groupsRaw)
    ? groupsRaw.filter((g): g is string => typeof g === "string")
    : typeof groupsRaw === "string" && groupsRaw
      ? [groupsRaw]
      : [];

  return provisionExternalUser({
    provider: "azure",
    externalIdField: "azureOid",
    externalId: oid,
    usernameHint: email,
    displayName: displayName || null,
    email: email || null,
    groups,
  });
}
