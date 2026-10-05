/**
 * src/services/brandingService.ts — operator-customizable app identity.
 *
 * Owns the `branding` Setting row: app name, subtitle, and logo URL. Extracted
 * from src/api/routes/serverSettings.ts so non-route consumers can read it
 * without importing a route module (appIconService renders the PWA icon set
 * from the logo; the pwa route builds the web manifest from all three).
 *
 * Writers still live in the serverSettings routes (PUT /branding,
 * POST|DELETE /branding/logo) — they re-export this module's helpers so the
 * route surface is unchanged.
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { prisma } from "../db.js";
import { getAppVersion } from "../utils/version.js";

/**
 * Display unit for hardware-sensor temperatures. **Presentation only** — samples
 * are always collected, stored, rolled up, and compared by the automation engine
 * in Celsius (`SENSOR_CLASS_UNITS.temperature`), so flipping this can never move
 * an alert threshold or fork a sensor's history. The frontends convert at render
 * (`public/js/temp-unit.js`).
 *
 * It rides the branding Setting because branding is the one presentation channel
 * every surface already has: `GET /server-settings/branding` is unauthenticated,
 * app.js caches it in localStorage (so the sync string-building renderers can
 * read it without an await), and the Dash wallboard — which has no user identity
 * at all, so a per-user preference could never reach it — serves the same route.
 */
export type TemperatureUnit = "c" | "f";

export interface BrandingSettings {
  /**
   * May be EMPTY. An operator whose uploaded logo already carries their
   * wordmark wants no text beside it, and blanking this field is how they say
   * so — so unlike pre-2026-08 behavior an empty value is preserved rather
   * than snapped back to "Polaris". Every consumer that must print a name
   * (page titles, the PWA manifest, the acknowledge page) goes through
   * `displayAppName`.
   */
  appName: string;
  subtitle: string;
  logoUrl: string;
  /**
   * Overlay the Polaris symbol on the bottom-right corner of the operator's
   * logo. Composited server-side (brandLogoService) so one rendering feeds
   * every surface — login, sidebar, mobile. Ignored without a custom logo.
   */
  logoAccent: boolean;
  /** Show the custom logo on the login page (else the Polaris wordmark art). */
  logoOnLogin: boolean;
  /** Show the custom logo in the sidebar after login (else the Polaris art). */
  logoOnSidebar: boolean;
  temperatureUnit: TemperatureUnit;
}

/**
 * Shipped-default logo URLs — the current one FIRST, followed by every
 * historical one.
 *
 * This is not tidiness: an install seeded before the themed brand marks has
 * `logoUrl: "/logo.png"` written into its `branding` Setting row, and
 * `/logo.png` no longer exists. If `hasCustomLogo` judged that row by the
 * current default alone it would answer TRUE, every surface would treat the
 * stored value as an operator upload, and the sidebar + login page of every
 * pre-existing install would paint a 404. Recognising the legacy value keeps
 * those installs on the shipped art with no migration.
 */
const DEFAULT_LOGO_URLS = [
  "/img/brand/polaris-symbol-dark.png",
  "/logo.png", // retired 2026-08; still stored by installs seeded before then
] as const;

export const DEFAULT_LOGO_URL: string = DEFAULT_LOGO_URLS[0];

export const BRANDING_DEFAULTS: BrandingSettings = {
  appName: "Polaris",
  subtitle: "Network Management Tool",
  // The light-inked symbol: this value's only rendered consumer is the PWA icon
  // rasterizer, whose canvas is ICON_BG (#111418) and which iOS composites onto
  // black. Every in-app surface paints the theme-aware art from brand-logo.js
  // instead whenever no custom logo is set.
  logoUrl: DEFAULT_LOGO_URL,
  logoAccent: false,
  // An operator who bothered to upload a logo wants it in both places; the
  // checkboxes exist to take it back out of one of them.
  logoOnLogin: true,
  logoOnSidebar: true,
  temperatureUnit: "c",
};

/** Narrow an operator-supplied value to a unit code; anything else = Celsius. */
export function normalizeTemperatureUnit(value: unknown): TemperatureUnit {
  return String(value ?? "").trim().toLowerCase() === "f" ? "f" : "c";
}

/**
 * Read a stored/posted boolean flag, defaulting when it isn't present. Only
 * `undefined`/`null` mean "not stored" — a stored `false` must survive, which
 * a plain `value || fallback` would silently flip back on.
 */
export function normalizeBrandingFlag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value !== "false" && value !== "0" && value !== "";
  return Boolean(value);
}

/**
 * Is this install running an operator-supplied logo rather than the shipped
 * default? The placement + accent flags only bite when it is — with no custom
 * logo every surface shows the Polaris brand art regardless.
 */
export function hasCustomLogo(logoUrl: string): boolean {
  return Boolean(logoUrl) && !isDefaultLogoUrl(logoUrl);
}

/** Is this one of the shipped defaults, current or retired? See DEFAULT_LOGO_URLS. */
export function isDefaultLogoUrl(logoUrl: string | null | undefined): boolean {
  return !!logoUrl && (DEFAULT_LOGO_URLS as readonly string[]).includes(logoUrl);
}

/** A non-empty name, for the surfaces that must print one. */
export function displayAppName(branding: { appName?: string | null }): string {
  return (branding.appName || "").trim() || BRANDING_DEFAULTS.appName;
}

const APP_VERSION: string = getAppVersion();

/**
 * A short version for the custom logo's URL (`?v=`), so the image can be
 * cached for good. The upload route writes a FIXED filename, which is why the
 * logo used to be served `no-cache`: the URL could not tell a new upload from
 * the old one, so every page load had to ask again — and the sidebar painted
 * with no logo while it did, popping it in on every page change. The file's
 * mtime and size change on every upload (the same signal appIconService and
 * brandLogoService key their caches on); the app version covers the Polaris
 * symbol the accent composite draws in, which changes only with Polaris.
 */
export function logoVersionStamp(mtimeMs: number, size: number, appVersion: string): string {
  return createHash("sha256").update(`${mtimeMs}|${size}|${appVersion}`).digest("hex").slice(0, 12);
}

/** The custom logo's version, or null with no custom logo or no readable file. */
export async function getLogoVersion(logoUrl: string): Promise<string | null> {
  if (!hasCustomLogo(logoUrl)) return null;
  try {
    // Lazy: appIconService imports this module, so a static import here would
    // be a cycle. resolveBrandingLogoFile is the one definition of "which file
    // is the logo", including the inside-UPLOADS_DIR check.
    const { resolveBrandingLogoFile } = await import("./appIconService.js");
    const resolved = resolveBrandingLogoFile(logoUrl);
    if (!resolved.ok) return null;
    const st = await stat(resolved.path);
    return logoVersionStamp(st.mtimeMs, st.size, APP_VERSION);
  } catch {
    return null;
  }
}

/**
 * Cache-Control for a logo response. Long-lived and immutable ONLY when the
 * request names the current version: that URL can never mean different bytes,
 * because a new upload changes the version and so the URL. Anything else — no
 * `v` (a payload cached before this field existed) or a stale one — keeps the
 * old revalidate-every-time behaviour, so a stale URL can never pin old bytes.
 */
export function logoCacheControl(requestedVersion: unknown, currentVersion: string | null): string {
  return typeof requestedVersion === "string" && currentVersion !== null && requestedVersion === currentVersion
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

export async function getBranding(): Promise<BrandingSettings & { version: string; customLogo: boolean; logoVersion: string | null }> {
  const row = await prisma.setting.findUnique({ where: { key: "branding" } });
  const saved = row ? (row.value as Record<string, unknown>) : {};
  const logoUrl = (saved.logoUrl as string) || BRANDING_DEFAULTS.logoUrl;
  return {
    // `!== undefined`, not `||`: an operator can deliberately blank the name.
    appName:  saved.appName  !== undefined ? (saved.appName as string)  : BRANDING_DEFAULTS.appName,
    subtitle: saved.subtitle !== undefined ? (saved.subtitle as string) : BRANDING_DEFAULTS.subtitle,
    logoUrl,
    logoAccent:    normalizeBrandingFlag(saved.logoAccent,    BRANDING_DEFAULTS.logoAccent),
    logoOnLogin:   normalizeBrandingFlag(saved.logoOnLogin,   BRANDING_DEFAULTS.logoOnLogin),
    logoOnSidebar: normalizeBrandingFlag(saved.logoOnSidebar, BRANDING_DEFAULTS.logoOnSidebar),
    temperatureUnit: normalizeTemperatureUnit(saved.temperatureUnit),
    // Derived, so the frontends never hardcode the default logo's path to
    // work out whether a custom one is in play.
    customLogo: hasCustomLogo(logoUrl),
    // Derived too: the frontends append it to the logo URL (brand-logo.js) so
    // the image routes can answer it as immutable. See logoVersionStamp.
    logoVersion: await getLogoVersion(logoUrl),
    version:  APP_VERSION,
  };
}
