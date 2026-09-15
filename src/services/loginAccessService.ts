/**
 * src/services/loginAccessService.ts
 *
 * Operator-settable source-IP restriction on LOCAL LOGIN, edited at Users →
 * Authentication → Settings → Trusted Networks for Login (Server Settings → Web
 * Server keeps a read-only summary that points there; two screens writing one
 * Setting row is how they drift into disagreeing about what is configured).
 * Single Setting row (`loginAccessConfig`), JSON blob, TTL-cached via
 * settingsStore — the dashSettingsService pattern.
 *
 * Why it exists: with "Skip login page" on, every unauthenticated visitor —
 * to a protected page AND to /login.html itself — is bounced straight to SSO,
 * but the form stays reachable as /login.html?local=1 (the anti-lockout path
 * for an IdP outage, named in the Settings tab's hint and deliberately
 * guessable), so the local password form stays reachable to anyone who types
 * that URL, and the password endpoints stay reachable to anyone who can POST.
 * That is the right default; this setting is for installs that want the
 * recovery path to exist only from inside the network.
 *
 * Shape mirrors dashConfig — { enabled, ipScope, allowedCidrs } — and resolves
 * through the same shared `ipInScope`, but the POLARITY IS INVERTED: `enabled`
 * false means "no restriction". A dash row defaults off because enabling
 * exposes a new unauthenticated surface; this defaults off because enabling
 * REFUSES logins, and an upgrade must never start doing that on its own.
 *
 * The gate covers the local password path AND the LDAP path — both authenticate
 * through POST /auth/login — so an install whose off-site users sign in with
 * LDAP should leave this off (or scope it to include their networks). SSO
 * (SAML / OIDC / App Proxy) is untouched by design: it is the path that is
 * supposed to keep working from anywhere.
 */

import { createSettingStore } from "./settingsStore.js";
import { normalizeAllowlistCidr } from "../utils/cidr.js";
import { ipInScope, isIpScope, type IpScope } from "../utils/ipScope.js";
import { AppError } from "../utils/errors.js";

export const LOGIN_ACCESS_SETTING_KEY = "loginAccessConfig";

export interface LoginAccessSettings {
  /** false (default) = no source-IP restriction on local login. */
  enabled: boolean;
  /** Which sources may reach the login form + password endpoints. */
  ipScope: IpScope;
  /** Canonical IPv4 CIDRs honored when ipScope === "custom". */
  allowedCidrs: string[];
}

export function defaultLoginAccessSettings(): LoginAccessSettings {
  return { enabled: false, ipScope: "rfc1918", allowedCidrs: [] };
}

const loginAccessStore = createSettingStore<LoginAccessSettings>({
  key: LOGIN_ACCESS_SETTING_KEY,
  ttlMs: 10_000,
  parse: parseLoginAccessSettings,
});

export function invalidateLoginAccessCache(): void {
  loginAccessStore.invalidate();
}

export async function getLoginAccessSettings(): Promise<LoginAccessSettings> {
  return loginAccessStore.get();
}

/**
 * Pure decision — exported for the route's anti-lockout guard, which has to
 * answer "would the admin's own address survive the scope they just posted?"
 * BEFORE the row is written.
 */
export function loginSourceAllowed(ip: string, settings: LoginAccessSettings): boolean {
  if (!settings.enabled) return true;
  return ipInScope(ip, settings.ipScope, settings.allowedCidrs);
}

/**
 * Gate helper for the request path. FAILS OPEN: a settings read that throws
 * must not make local login impossible — that would turn a transient DB blip
 * into the exact lockout this feature is built to avoid, and an attacker has
 * no way to induce it anyway. Same posture as app.ts's skipLoginPage read.
 */
export async function isLoginSourceAllowed(ip: string): Promise<boolean> {
  try {
    return loginSourceAllowed(ip, await getLoginAccessSettings());
  } catch {
    return true;
  }
}

export async function saveLoginAccessSettings(
  input: Partial<LoginAccessSettings>,
): Promise<LoginAccessSettings> {
  const current = await getLoginAccessSettings();

  const enabled = typeof input.enabled === "boolean" ? input.enabled : current.enabled;
  const ipScope: IpScope = isIpScope(input.ipScope) ? input.ipScope : current.ipScope;

  let allowedCidrs = current.allowedCidrs;
  if (input.allowedCidrs !== undefined) {
    if (!Array.isArray(input.allowedCidrs)) {
      throw new AppError(400, "allowedCidrs must be an array of IPv4 CIDR strings");
    }
    const normalized: string[] = [];
    for (const raw of input.allowedCidrs) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const n = normalizeAllowlistCidr(raw);
      if (!n) {
        throw new AppError(
          400,
          `Invalid network in the allow-list: "${raw}" — use IPv4 CIDR notation (e.g. 10.0.0.0/8) or a bare address (e.g. 203.0.113.5)`,
        );
      }
      if (!normalized.includes(n)) normalized.push(n);
    }
    allowedCidrs = normalized;
  }

  // An enabled custom scope with no networks would refuse every login from
  // everywhere — the lockout this feature must never cause. Reject it.
  if (enabled && ipScope === "custom" && allowedCidrs.length === 0) {
    throw new AppError(
      400,
      "Custom source-IP scope needs at least one network — an empty list would block local login from everywhere",
    );
  }

  return loginAccessStore.save({ enabled, ipScope, allowedCidrs });
}

function parseLoginAccessSettings(raw: unknown): LoginAccessSettings {
  const fallback = defaultLoginAccessSettings();
  if (raw == null || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;

  const enabled = typeof r.enabled === "boolean" ? r.enabled : fallback.enabled;
  const ipScope: IpScope = isIpScope(r.ipScope) ? r.ipScope : fallback.ipScope;

  const allowedCidrs: string[] = [];
  if (Array.isArray(r.allowedCidrs)) {
    for (const c of r.allowedCidrs) {
      if (typeof c !== "string") continue;
      const n = normalizeAllowlistCidr(c);
      if (n && !allowedCidrs.includes(n)) allowedCidrs.push(n);
    }
  }

  return { enabled, ipScope, allowedCidrs };
}
