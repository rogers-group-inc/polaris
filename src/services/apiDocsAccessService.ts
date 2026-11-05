/**
 * src/services/apiDocsAccessService.ts
 *
 * Operator-settable source-IP restriction on the API DOCUMENTATION page
 * (GET /api — Server Settings → API Tokens → API Documentation Access).
 * Single Setting row (`apiDocsConfig`), JSON blob, TTL-cached via
 * settingsStore — the dashSettingsService / loginAccessService pattern.
 *
 * Why it exists: /api serves developer docs with NO login (any developer on
 * the allowed network can read them), so the source-IP scope is the only
 * disclosure control over a page that enumerates the API surface. Three
 * postures — loopback / rfc1918 / custom — and deliberately NO "all": this
 * page is never offered to public networks, which is also why a custom entry
 * outside RFC1918 space is refused at save time (isRfc1918Cidr) AND filtered
 * back out on read (a hand-edited Setting row must not smuggle one in).
 *
 * Loopback is always allowed under every ENABLED scope — a scope that locks
 * the host itself out of its own docs serves nobody, and a loopback caller is
 * already on the box. `enabled: false` means off: the page is dropped for
 * everyone, loopback included, so the toggle can fully retire the surface.
 *
 * The app-level gate in src/app.ts is the authoritative enforcement on every
 * install type; on Linux proxy-mode managed installs the same posture is
 * additionally rendered into nginx as a `location = /api` allow/deny block
 * (deriveApiDocsNginxAllow → nginxRenderer), which is defense in depth only
 * and may lag this Setting until the next apply/update.
 */

import { createSettingStore } from "./settingsStore.js";
import { isLoopbackIp, isRfc1918Cidr, normalizeAllowlistCidr, RFC1918_RANGES } from "../utils/cidr.js";
import { ipInScope } from "../utils/ipScope.js";
import { AppError } from "../utils/errors.js";

export const API_DOCS_SETTING_KEY = "apiDocsConfig";

/**
 * The docs page's own scope union — a strict subset of the shared IpScope:
 * "all" is deliberately not offered, and isIpScope is deliberately NOT the
 * guard here (it would admit "all" from a hand-edited row).
 */
type ApiDocsIpScope = "loopback" | "rfc1918" | "custom";

function isApiDocsIpScope(v: unknown): v is ApiDocsIpScope {
  return v === "loopback" || v === "rfc1918" || v === "custom";
}

export interface ApiDocsSettings {
  /** true (default) = the /api docs page is served, subject to ipScope. */
  enabled: boolean;
  /** Which sources may read the docs. Loopback is always allowed when enabled. */
  ipScope: ApiDocsIpScope;
  /** Canonical IPv4 CIDRs, all inside RFC1918, honored when ipScope === "custom". */
  allowedCidrs: string[];
}

export function defaultApiDocsSettings(): ApiDocsSettings {
  return { enabled: true, ipScope: "rfc1918", allowedCidrs: [] };
}

const apiDocsStore = createSettingStore<ApiDocsSettings>({
  key: API_DOCS_SETTING_KEY,
  ttlMs: 10_000,
  parse: parseApiDocsSettings,
});

export function invalidateApiDocsSettingsCache(): void {
  apiDocsStore.invalidate();
}

export async function getApiDocsSettings(): Promise<ApiDocsSettings> {
  return apiDocsStore.get();
}

/**
 * Pure decision — exported for the route's "would your own address still see
 * the docs?" warning (warn-only: unlike login-access, being outside the docs
 * scope is not a lockout, so the PUT never refuses over it).
 */
export function docsSourceAllowed(ip: string, settings: ApiDocsSettings): boolean {
  if (!settings.enabled) return false;
  if (isLoopbackIp(ip)) return true;
  return ipInScope(ip, settings.ipScope, settings.allowedCidrs);
}

/**
 * Gate helper for the request path. FAILS CLOSED — the opposite posture from
 * isLoginSourceAllowed, deliberately: login fails open because a DB blip must
 * not become the lockout that feature exists to prevent, while this gate
 * fronts an UNAUTHENTICATED disclosure surface, where briefly hiding the docs
 * during a blip costs nothing and briefly exposing them is the one failure
 * that matters.
 */
export async function isApiDocsSourceAllowed(ip: string): Promise<boolean> {
  try {
    return docsSourceAllowed(ip, await getApiDocsSettings());
  } catch {
    return false;
  }
}

export async function saveApiDocsSettings(input: Partial<ApiDocsSettings>): Promise<ApiDocsSettings> {
  const current = await getApiDocsSettings();

  const enabled = typeof input.enabled === "boolean" ? input.enabled : current.enabled;
  const ipScope: ApiDocsIpScope = isApiDocsIpScope(input.ipScope) ? input.ipScope : current.ipScope;

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
          `Invalid network in the allow-list: "${raw}" — use IPv4 CIDR notation (e.g. 10.0.0.0/8) or a bare address (e.g. 10.20.30.40)`,
        );
      }
      if (!isRfc1918Cidr(n)) {
        throw new AppError(
          400,
          `Network "${raw}" is outside RFC1918 private space (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) — ` +
            "the API documentation page can only be scoped to private networks. " +
            "Loopback is always allowed and does not need an entry.",
        );
      }
      if (!normalized.includes(n)) normalized.push(n);
    }
    allowedCidrs = normalized;
  }

  // An enabled custom scope with no networks would serve the docs to loopback
  // only while READING as "custom" — almost certainly a half-built form.
  // Refuse it; "loopback only" is an explicit scope of its own.
  if (enabled && ipScope === "custom" && allowedCidrs.length === 0) {
    throw new AppError(
      400,
      "Custom source-IP scope needs at least one network — pick 'Loopback only' if that is the intent",
    );
  }

  return apiDocsStore.save({ enabled, ipScope, allowedCidrs });
}

/**
 * The nginx allow-lines this posture implies, for the managed proxy config's
 * `location = /api` block (defense in depth beside the app gate). Pure, so
 * the renderer stays deterministic. Loopback pair first, always, mirroring
 * docsSourceAllowed's loopback-always-allowed rule; disabled → no allows,
 * i.e. the rendered block is `deny all;` alone (off means off).
 */
export function deriveApiDocsNginxAllow(settings: ApiDocsSettings): { enabled: boolean; allow: string[] } {
  if (!settings.enabled) return { enabled: false, allow: [] };
  const loopback = ["127.0.0.0/8", "::1"];
  if (settings.ipScope === "loopback") return { enabled: true, allow: loopback };
  if (settings.ipScope === "rfc1918") return { enabled: true, allow: [...loopback, ...RFC1918_RANGES] };
  return { enabled: true, allow: [...loopback, ...settings.allowedCidrs] };
}

function parseApiDocsSettings(raw: unknown): ApiDocsSettings {
  const fallback = defaultApiDocsSettings();
  if (raw == null || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;

  const enabled = typeof r.enabled === "boolean" ? r.enabled : fallback.enabled;
  const ipScope: ApiDocsIpScope = isApiDocsIpScope(r.ipScope) ? r.ipScope : fallback.ipScope;

  // Re-filter on read: normalizeAllowlistCidr AND isRfc1918Cidr again, so a
  // hand-edited row cannot smuggle a public CIDR past the save-time check.
  const allowedCidrs: string[] = [];
  if (Array.isArray(r.allowedCidrs)) {
    for (const c of r.allowedCidrs) {
      if (typeof c !== "string") continue;
      const n = normalizeAllowlistCidr(c);
      if (n && isRfc1918Cidr(n) && !allowedCidrs.includes(n)) allowedCidrs.push(n);
    }
  }

  return { enabled, ipScope, allowedCidrs };
}
