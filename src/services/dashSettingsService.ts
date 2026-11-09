/**
 * src/services/dashSettingsService.ts
 *
 * Operator-settable Dash wallboard config (Server Settings → Web Server →
 * Dash Wallboard card). Single Setting row (`dashConfig`), JSON blob,
 * in-process cache with short TTL + explicit invalidate — the same pattern
 * as proxyConfigService.
 *
 * The TTL matters more here than for proxyConfig: the dash listener runs in
 * a SEPARATE process (POLARIS_ROLE=dash) from the web process that writes
 * the row, so the cache TTL is the cross-process propagation delay for the
 * on/off toggle and the IP-scope switch. ~10s keeps the hot path at roughly
 * one DB read per 10s while letting a toggle land without a restart.
 *
 * Shape: { enabled, ipScope, allowedCidrs }.
 *   - enabled defaults to FALSE: a brand-new unauthenticated surface must
 *     never silently appear on upgrade — the operator flips it on once.
 *   - ipScope defaults to "rfc1918": private-source-only until the operator
 *     explicitly widens it. "all" serves any source; "custom" serves only
 *     source IPs matching `allowedCidrs`.
 *   - allowedCidrs: canonical IPv4 CIDRs, consulted only when ipScope
 *     === "custom".
 *
 * Back-compat: rows written before the custom-scope feature carry a boolean
 * `rfc1918Only` instead of `ipScope`; parse migrates true→"rfc1918",
 * false→"all". The next save rewrites the row in the new shape.
 */

import { createSettingStore } from "./settingsStore.js";
import { normalizeAllowlistCidr } from "../utils/cidr.js";
import { AppError } from "../utils/errors.js";

export const DASH_SETTING_KEY = "dashConfig";

type DashIpScope = "rfc1918" | "all" | "custom";

export interface DashSettings {
  /** Master switch for the /dash wallboard surface. */
  enabled: boolean;
  /** Source-IP scope: RFC1918+loopback / any / a custom allow-list. */
  ipScope: DashIpScope;
  /** Canonical IPv4 CIDRs served when ipScope === "custom". */
  allowedCidrs: string[];
}

export function defaultDashSettings(): DashSettings {
  return { enabled: false, ipScope: "rfc1918", allowedCidrs: [] };
}

const dashStore = createSettingStore<DashSettings>({
  key: DASH_SETTING_KEY,
  ttlMs: 10_000,
  parse: parseDashSettings,
});

export function invalidateDashSettingsCache(): void {
  dashStore.invalidate();
}

/** TTL-cached read — the dash listener consults this on every request. */
export async function getDashSettings(): Promise<DashSettings> {
  return dashStore.get();
}

export async function saveDashSettings(input: Partial<DashSettings>): Promise<DashSettings> {
  const current = await getDashSettings();

  const enabled = typeof input.enabled === "boolean" ? input.enabled : current.enabled;
  const ipScope: DashIpScope = isDashIpScope(input.ipScope) ? input.ipScope : current.ipScope;

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

  // A custom scope with no networks would 403 every viewer — reject rather
  // than silently lock the wallboard out. (Disabling is the way to turn it
  // off; an empty custom list is almost always a mistake.)
  if (enabled && ipScope === "custom" && allowedCidrs.length === 0) {
    throw new AppError(
      400,
      "Custom source-IP scope needs at least one network — an empty list would block every viewer",
    );
  }

  const merged: DashSettings = { enabled, ipScope, allowedCidrs };
  return dashStore.save(merged);
}

function isDashIpScope(v: unknown): v is DashIpScope {
  return v === "rfc1918" || v === "all" || v === "custom";
}

function parseDashSettings(raw: unknown): DashSettings {
  const fallback = defaultDashSettings();
  if (raw == null || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;

  const enabled = typeof r.enabled === "boolean" ? r.enabled : fallback.enabled;

  let ipScope: DashIpScope;
  if (isDashIpScope(r.ipScope)) {
    ipScope = r.ipScope;
  } else if (typeof r.rfc1918Only === "boolean") {
    // Legacy pre-custom-scope row: migrate the boolean.
    ipScope = r.rfc1918Only ? "rfc1918" : "all";
  } else {
    ipScope = fallback.ipScope;
  }

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
