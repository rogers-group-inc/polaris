/**
 * src/services/brandLogoService.ts — the operator's logo with the Polaris
 * symbol accented onto its corner.
 *
 * Server-side compositing rather than a CSS overlay per surface, because the
 * accented mark has to look identical on the desktop login, the sidebar, the
 * mobile login and anything that later embeds it — four places that would
 * otherwise each need their own absolutely-positioned overlay and their own
 * 35%-of-what arithmetic. One rendered PNG, one URL, no per-surface drift.
 *
 * Mechanics mirror appIconService: an SVG canvas embeds both bitmaps as data:
 * URIs and @resvg/resvg-js rasterizes it, memoized in-process on the source
 * file's mtime (the upload route writes a FIXED filename, so mtime is the only
 * invalidation signal there is). Derived artifacts stay out of UPLOADS_DIR,
 * which is backed-up operator state.
 *
 * Nothing here throws: every failure rung returns null and the caller serves
 * the plain logo. An accent is decoration; it must never be the reason a login
 * page renders without a mark.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getBranding, hasCustomLogo } from "./brandingService.js";
import { resolveBrandingLogoFile } from "./appIconService.js";
import { detectImageMagic } from "../utils/imageMagic.js";
import { imageSize, type ImageSize } from "../utils/imageSize.js";
import { PUBLIC_DIR } from "../utils/paths.js";
import { logger } from "../utils/logger.js";

/** Which app surface the composite will sit on. */
export type BrandTheme = "dark" | "light";

/**
 * The overlay art, per theme — the symbol is theme-paired like the wordmarks.
 * The dark variant's wedges are white and disappear on a light background; the
 * light variant's are navy and disappear on a dark one. Neither is a safe
 * default for both, which is why the render takes a theme rather than baking
 * one in.
 */
export const ACCENT_SYMBOL_PATHS: Record<BrandTheme, string> = {
  dark: join(PUBLIC_DIR, "img", "brand", "polaris-symbol-dark.png"),
  light: join(PUBLIC_DIR, "img", "brand", "polaris-symbol-light.png"),
};

/** Narrow a query-string theme; anything unrecognized renders for dark. */
export function normalizeBrandTheme(value: unknown): BrandTheme {
  return String(value ?? "").trim().toLowerCase() === "light" ? "light" : "dark";
}

/** Operator-facing promise: the accent is "roughly 50% the size of the logo". */
const ACCENT_FRACTION = 0.5;

/**
 * Longest side of the rendered composite. A logo is displayed at ~70–220 CSS
 * px; anything past this is only a bigger resvg canvas to allocate on a route
 * an unauthenticated login page can call.
 */
export const MAX_RENDER_PX = 1024;

export interface AccentGeometry {
  /** Canvas size (the logo, scaled down if it exceeded MAX_RENDER_PX). */
  width: number;
  height: number;
  /** Side of the square box the symbol is fitted into. */
  accent: number;
  accentX: number;
  accentY: number;
}

/**
 * Where the symbol lands. The fraction is measured on the logo's LONGEST side,
 * which is what reads as "half the size of the logo" for the square-ish logos
 * operators actually upload — but on a wide banner that would be several times
 * the logo's height, so it's clamped to half the shortest side. Flush to the
 * bottom-right corner: the symbol art carries its own internal padding, so an
 * extra inset just floats it.
 */
export function accentGeometry(base: ImageSize): AccentGeometry {
  const longest = Math.max(base.width, base.height);
  const scale = longest > MAX_RENDER_PX ? MAX_RENDER_PX / longest : 1;
  const width = Math.max(1, Math.round(base.width * scale));
  const height = Math.max(1, Math.round(base.height * scale));

  const accent = Math.max(
    1,
    Math.round(Math.min(ACCENT_FRACTION * Math.max(width, height), 0.5 * Math.min(width, height))),
  );
  return { width, height, accent, accentX: width - accent, accentY: height - accent };
}

// ─── Cache ───────────────────────────────────────────────────────────────

interface RenderedLogo {
  buf: Buffer;
  /** Strong ETag value (unquoted) — identity of the inputs, not of the bytes. */
  etag: string;
}

/** Keyed by source mtimes + theme — at most one entry per theme in practice. */
const cached = new Map<string, RenderedLogo>();
const MAX_CACHE_ENTRIES = 4;
const warned = new Set<string>();

function warnOnce(key: string, msg: string, detail?: Record<string, unknown>): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn({ ...detail }, msg);
}

/** Test seam. */
export function __resetBrandLogoCacheForTests(): void {
  cached.clear();
  warned.clear();
}

// ─── Rendering ───────────────────────────────────────────────────────────

interface Source {
  buf: Buffer;
  mime: string;
  size: ImageSize;
  stamp: string;
}

async function loadImage(path: string, what: string): Promise<Source | null> {
  try {
    const [buf, st] = await Promise.all([readFile(path), stat(path)]);
    const ext = detectImageMagic(buf);
    // resvg cannot decode WebP inside an <image>, so a WebP logo has no accent
    // path — the plain upload still renders everywhere, unaccented.
    if (ext === null || ext === ".webp") {
      warnOnce(`format:${path}`, `brandLogo: ${what} format unusable for compositing (PNG/JPEG required)`, { path, detected: ext ?? "unknown" });
      return null;
    }
    const size = imageSize(buf);
    if (!size) {
      warnOnce(`dims:${path}`, `brandLogo: could not read ${what} dimensions`, { path });
      return null;
    }
    return {
      buf,
      mime: ext === ".png" ? "image/png" : "image/jpeg",
      size,
      stamp: `${path}|${st.mtimeMs}|${buf.length}`,
    };
  } catch (err) {
    warnOnce(`read:${path}`, `brandLogo: could not read ${what}`, { path, err: (err as Error)?.message });
    return null;
  }
}

function buildSvg(logo: Source, symbol: Source, geo: AccentGeometry): string {
  const href = (s: Source) => `data:${s.mime};base64,${s.buf.toString("base64")}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${geo.width}" height="${geo.height}" viewBox="0 0 ${geo.width} ${geo.height}">` +
    `<image href="${href(logo)}" x="0" y="0" width="${geo.width}" height="${geo.height}" preserveAspectRatio="none"/>` +
    `<image href="${href(symbol)}" x="${geo.accentX}" y="${geo.accentY}" width="${geo.accent}" height="${geo.accent}" preserveAspectRatio="xMidYMid meet"/>` +
    `</svg>`
  );
}

/**
 * The accented custom logo for one theme, or null when there's nothing to
 * accent (default logo, accent switched off) or the composite can't be built.
 */
export async function renderAccentedLogo(theme: BrandTheme = "dark"): Promise<RenderedLogo | null> {
  const branding = await getBranding().catch(() => null);
  if (!branding || !branding.logoAccent || !hasCustomLogo(branding.logoUrl)) return null;

  const resolved = resolveBrandingLogoFile(branding.logoUrl);
  if (!resolved.ok) return null;

  const [logo, symbol] = await Promise.all([
    loadImage(resolved.path, "logo"),
    loadImage(ACCENT_SYMBOL_PATHS[theme], "accent symbol"),
  ]);
  if (!logo || !symbol) return null;

  const key = `${logo.stamp}|${symbol.stamp}|${theme}`;
  const hit = cached.get(key);
  if (hit) return hit;

  try {
    const { Resvg } = await import("@resvg/resvg-js");
    const geo = accentGeometry(logo.size);
    const png = new Resvg(buildSvg(logo, symbol, geo), { fitTo: { mode: "width", value: geo.width } })
      .render()
      .asPng();
    const rendered: RenderedLogo = {
      buf: Buffer.from(png),
      // Key includes the theme, so the two variants can never share an ETag
      // and revalidate into each other.
      etag: createHash("sha256").update(key).digest("hex").slice(0, 16),
    };
    if (cached.size >= MAX_CACHE_ENTRIES) {
      const oldest = cached.keys().next().value;
      if (oldest !== undefined) cached.delete(oldest);
    }
    cached.set(key, rendered);
    return rendered;
  } catch (err) {
    warnOnce("resvg-failed", "brandLogo: accent compositing failed, serving the plain logo", { err: (err as Error)?.message });
    return null;
  }
}
