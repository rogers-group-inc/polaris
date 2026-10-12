/**
 * src/services/proxyConfigService.ts
 *
 * Operator-settable proxyConfig persistence + validation. Mirrors the
 * sampleRetentionService pattern (single Setting row, JSON blob, in-process
 * cache with short TTL + explicit invalidate). Phase 3 of the in-app nginx
 * GUI; consumed by nginxApplyService + the /api/server-settings/proxy routes.
 *
 * Persisted shape lives in src/types/proxyConfig.ts. Validation rules:
 *   - httpsPort: integer 1..65535
 *   - hsts.maxAgeSeconds: non-negative integer
 *   - tlsProtocols: non-empty subset of {"TLSv1.2","TLSv1.3"}; when
 *     http3Enabled is true, must include "TLSv1.3" (QUIC mandates 1.3)
 *   - prometheusAllowIps: each entry must parse as IPv4 or IPv6
 *   - managedMode: boolean
 */

import { prisma } from "../db.js";
import { isIP } from "node:net";
import {
  defaultProxyConfig,
  type ProxyConfig,
  type TlsProtocol,
} from "../types/proxyConfig.js";
import { AppError } from "../utils/errors.js";

export const SETTING_KEY = "proxyConfig";

const CACHE_TTL_MS = 5000;
let cache: { value: ProxyConfig; fetchedAt: number } | null = null;

export function invalidateProxyConfigCache(): void {
  cache = null;
}

export async function getProxyConfig(): Promise<ProxyConfig> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const value = parseProxyConfig(row?.value);
  cache = { value, fetchedAt: now };
  return value;
}

/**
 * Returns true iff a proxyConfig Setting row already exists. Used by the
 * one-shot bootstrap to decide whether to seed from the live nginx config.
 */
export async function proxyConfigRowExists(): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  return row !== null;
}

export async function saveProxyConfig(input: Partial<ProxyConfig>): Promise<ProxyConfig> {
  const current = await getProxyConfig();
  const merged = mergeProxyConfig(current, input);
  validateProxyConfig(merged);
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: merged as any },
    create: { key: SETTING_KEY, value: merged as any },
  });
  invalidateProxyConfigCache();
  return merged;
}

// ─── parsing / merging / validation ────────────────────────────────────────

function parseProxyConfig(raw: unknown): ProxyConfig {
  const fallback = defaultProxyConfig();
  if (raw == null || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  return {
    httpsPort: toPort(r.httpsPort, fallback.httpsPort),
    hsts: parseHsts(r.hsts, fallback.hsts),
    tlsProtocols: parseTlsProtocols(r.tlsProtocols, fallback.tlsProtocols),
    http3Enabled: typeof r.http3Enabled === "boolean" ? r.http3Enabled : fallback.http3Enabled,
    prometheusAllowIps: parseAllowIps(r.prometheusAllowIps, fallback.prometheusAllowIps),
    managedMode: typeof r.managedMode === "boolean" ? r.managedMode : fallback.managedMode,
    lastAppliedAt: typeof r.lastAppliedAt === "string" ? r.lastAppliedAt : fallback.lastAppliedAt,
    lastAppliedHash: typeof r.lastAppliedHash === "string" ? r.lastAppliedHash : fallback.lastAppliedHash,
  };
}

function parseHsts(raw: unknown, fb: ProxyConfig["hsts"]): ProxyConfig["hsts"] {
  if (raw == null || typeof raw !== "object") return { ...fb };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : fb.enabled,
    maxAgeSeconds: toNonNegInt(r.maxAgeSeconds, fb.maxAgeSeconds),
    includeSubDomains: typeof r.includeSubDomains === "boolean" ? r.includeSubDomains : fb.includeSubDomains,
    preload: typeof r.preload === "boolean" ? r.preload : fb.preload,
  };
}

function parseTlsProtocols(raw: unknown, fb: TlsProtocol[]): TlsProtocol[] {
  if (!Array.isArray(raw)) return [...fb];
  const out: TlsProtocol[] = [];
  for (const v of raw) {
    if (v === "TLSv1.2" || v === "TLSv1.3") out.push(v);
  }
  return out.length > 0 ? out : [...fb];
}

function parseAllowIps(raw: unknown, fb: string[]): string[] {
  if (!Array.isArray(raw)) return [...fb];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && isIP(v) !== 0) out.push(v);
  }
  return out;
}

function toPort(v: unknown, fb: number): number {
  if (v == null) return fb;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fb;
  return n;
}

function toNonNegInt(v: unknown, fb: number): number {
  if (v == null) return fb;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fb;
  return Math.floor(n);
}

function mergeProxyConfig(current: ProxyConfig, input: Partial<ProxyConfig>): ProxyConfig {
  return {
    httpsPort: input.httpsPort ?? current.httpsPort,
    hsts: input.hsts ? { ...current.hsts, ...input.hsts } : current.hsts,
    tlsProtocols: input.tlsProtocols ?? current.tlsProtocols,
    http3Enabled: input.http3Enabled ?? current.http3Enabled,
    prometheusAllowIps: input.prometheusAllowIps ?? current.prometheusAllowIps,
    managedMode: input.managedMode ?? current.managedMode,
    lastAppliedAt: input.lastAppliedAt !== undefined ? input.lastAppliedAt : current.lastAppliedAt,
    lastAppliedHash: input.lastAppliedHash !== undefined ? input.lastAppliedHash : current.lastAppliedHash,
  };
}

function validateProxyConfig(cfg: ProxyConfig): void {
  if (!Number.isInteger(cfg.httpsPort) || cfg.httpsPort < 1 || cfg.httpsPort > 65535) {
    throw new AppError(400, `httpsPort must be an integer between 1 and 65535 (got ${cfg.httpsPort})`);
  }
  if (cfg.hsts.maxAgeSeconds < 0 || !Number.isInteger(cfg.hsts.maxAgeSeconds)) {
    throw new AppError(400, `hsts.maxAgeSeconds must be a non-negative integer (got ${cfg.hsts.maxAgeSeconds})`);
  }
  // The protocols are written into `ssl_protocols` unquoted, so each element is
  // checked against the allowlist HERE, not just counted. `saveProxyConfig`
  // merges the request body without going through `parseProxyConfig`, so a
  // string such as "TLSv1.3; include /etc/..." would otherwise reach the nginx
  // template intact. Anything that is not exactly TLSv1.2 or TLSv1.3 is refused.
  if (!Array.isArray(cfg.tlsProtocols)) {
    throw new AppError(400, "tlsProtocols must be an array");
  }
  for (const proto of cfg.tlsProtocols as unknown[]) {
    if (proto !== "TLSv1.2" && proto !== "TLSv1.3") {
      throw new AppError(400, "tlsProtocols may only contain TLSv1.2 and TLSv1.3");
    }
  }
  if (cfg.tlsProtocols.length === 0) {
    throw new AppError(400, "tlsProtocols must include at least one of TLSv1.2, TLSv1.3");
  }
  if (!Array.isArray(cfg.prometheusAllowIps)) {
    throw new AppError(400, "prometheusAllowIps must be an array of IP addresses");
  }
  if (cfg.http3Enabled && !cfg.tlsProtocols.includes("TLSv1.3")) {
    throw new AppError(400, "tlsProtocols must include TLSv1.3 when HTTP/3 is enabled (QUIC mandates TLS 1.3)");
  }
  for (const ip of cfg.prometheusAllowIps) {
    if (isIP(ip) === 0) {
      throw new AppError(400, `Invalid Prometheus allow IP: ${ip}`);
    }
  }
}
