/**
 * src/services/settingsStore.ts — TTL-cached JSON-blob Setting accessor.
 *
 * The "JSON blob in a Setting row" pattern (findUnique → parse-with-defaults →
 * upsert, fronted by a module-level TTL cache) is hand-rolled across many
 * services. createSettingStore() owns that ceremony: the caller keeps its
 * parse (defaults merge / validation) and its write-side merge rules; the
 * store owns the read cache, the row I/O, and the cache refresh on save.
 *
 * Multi-process note: the cache is per-process (exactly like every hand-rolled
 * copy it replaces) — cross-role propagation of a write is bounded by ttlMs.
 *
 * Adopters so far: azureAuthService (sso), entraProxyAuthService (entraProxy),
 * dashSettingsService (dashConfig), loginAccessService (loginAccessConfig),
 * apiDocsAccessService (apiDocsConfig), passwordPolicyService
 * (passwordPolicyConfig), passkeyService (passkeyConfig). Remaining
 * hand-rolled sites migrate incrementally as they're touched.
 *
 * Note what the last two do NOT share: each wraps get() in its own try/catch
 * answering a different fallback — the password policy answers the DEFAULT
 * rules (a settings outage must not lower the bar), the passkey policy answers
 * "off" (a settings outage must not be what decides a credential may sign
 * someone in). The store deliberately has no opinion: a fallback is a policy
 * question, and the two right answers here are opposites.
 */

import { prisma } from "../db.js";

export interface SettingStore<T> {
  /** TTL-cached read. parse() runs on each cache miss; a missing row parses `undefined`. */
  get(): Promise<T>;
  /** Synchronous view of the live cached value — null when empty or expired. */
  peek(): T | null;
  /** Upsert the value and prime the cache with it. Validate/merge BEFORE calling. */
  save(value: T): Promise<T>;
  /** Drop the cache so the next get() hits the DB (tests / cross-service writes). */
  invalidate(): void;
}

export function createSettingStore<T>(opts: {
  key: string;
  ttlMs: number;
  parse: (raw: unknown) => T;
}): SettingStore<T> {
  const { key, ttlMs, parse } = opts;
  let cache: { value: T; expiry: number } | null = null;
  return {
    async get(): Promise<T> {
      if (cache && Date.now() < cache.expiry) return cache.value;
      const row = await prisma.setting.findUnique({ where: { key } });
      const value = parse(row?.value ?? undefined);
      cache = { value, expiry: Date.now() + ttlMs };
      return value;
    },
    peek(): T | null {
      return cache && Date.now() < cache.expiry ? cache.value : null;
    },
    async save(value: T): Promise<T> {
      await prisma.setting.upsert({
        where:  { key },
        update: { value: value as never },
        create: { key, value: value as never },
      });
      cache = { value, expiry: Date.now() + ttlMs };
      return value;
    },
    invalidate(): void {
      cache = null;
    },
  };
}
