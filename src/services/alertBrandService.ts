/**
 * src/services/alertBrandService.ts — the install's identity, in the corner of
 * the alert email.
 *
 * An alert lands in an inbox next to mail from every other system a site runs,
 * and the body's own severity bar says nothing about WHO sent it. This puts the
 * install's logo, application name and subtitle in the top-right of the card,
 * opposite the headline — the masthead position, so it reads as letterhead
 * rather than as content.
 *
 * Three things it deliberately reuses rather than re-decides:
 *
 *  - **It is a DEFERRED token** (`{brand.header}`, see isDeferredToken), filled
 *    at delivery like `{chart.*}` and `{interface.lldp}` — for the same two
 *    reasons: the logo is an inline CID attachment (no remote images in email,
 *    and a data: URI is dropped by Gmail and Outlook alike), which one context
 *    string can't carry, and its HTML and plain-text forms are different markup.
 *    A fire-time context key would also freeze the branding into every
 *    escalation email sent hours later.
 *
 *  - **Which artwork** follows business rule 27 rather than picking a file: the
 *    shipped art is theme-paired, and the email card is white, so the LIGHT
 *    variant (near-black ink) is the only one that doesn't disappear. The
 *    horizontal wordmark is the shipped choice because it already spells the
 *    product name — which is exactly why the name is NOT printed beside it
 *    (rule 27's showName=false: the picture already says it). An operator's own
 *    logo has no wordmark we know of, so it gets the name as its caption, and
 *    the accent composite when they enabled one.
 *
 *  - **The subtitle renders either way** — it is the operator's own line of
 *    copy, not a caption for the mark.
 *
 * Nothing here throws and nothing here is required: every failure rung drops
 * the logo, then the whole block, and the email sends without it. Letterhead
 * must never be the reason an alert doesn't arrive.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getBranding, displayAppName } from "./brandingService.js";
import { renderAccentedLogo } from "./brandLogoService.js";
import { resolveBrandingLogoFile } from "./appIconService.js";
import { detectImageMagic } from "../utils/imageMagic.js";
import { imageSize, type ImageSize } from "../utils/imageSize.js";
import { escapeHtml } from "../utils/notificationTemplate.js";
import { PUBLIC_DIR } from "../utils/paths.js";
import { logger } from "../utils/logger.js";
import type { InlineAttachment } from "./notificationChannels/emailChannel.js";

/** The branding tokens, resolved at delivery like `{chart.*}`. */
const BRAND_TOKENS = ["brand.header"] as const;
export type BrandToken = (typeof BRAND_TOKENS)[number];

/** Content-id the HTML references. One image per message, so a fixed id is fine. */
export const BRAND_LOGO_CID = "polaris-brand-logo";

/**
 * The white email card wants the light-inked wordmark; see the file header.
 * The horizontal lockup, because the block is wider than it is tall.
 */
const EMAIL_LOGO_PATH: string = join(PUBLIC_DIR, "img", "brand", "polaris-horiz-light.png");

/**
 * Display box for the mark. Small on purpose: this is letterhead beside a
 * 19px headline, and an operator's upload can be any size at all — a 900px
 * banner scaled by the client would push the headline into a two-word column.
 *
 * MAX_LOGO_WIDTH is paired with the letterhead cell's declared width in
 * DEFAULT_ALERT_HTML (that cell is this plus its gutter): a cell narrower than
 * the image inside it is a width the mail client overrides, which is how a
 * wide logo eats the headline's column. Move them together.
 */
export const MAX_LOGO_WIDTH = 150;
export const MAX_LOGO_HEIGHT = 46;

export interface BrandLogoImage {
  width: number;
  height: number;
  alt: string;
  attachment: InlineAttachment;
}

export interface AlertBrandBlock {
  /** Right-aligned cell contents, or "" when there is nothing to say. */
  html: string;
  /** "Polaris — Network Management Tool", or "". */
  text: string;
  /** Attached only when the HTML actually references it. */
  attachment: InlineAttachment | null;
}

/** Do any of these templates reference a `{brand.*}` token? */
export function brandTokensIn(...templates: Array<string | null | undefined>): Set<BrandToken> {
  const found = new Set<BrandToken>();
  for (const t of templates) {
    if (!t) continue;
    for (const token of BRAND_TOKENS) {
      if (t.includes(`{${token}}`)) found.add(token);
    }
  }
  return found;
}

const BRAND_TOKEN_RE = /\{brand\.header\}/g;

/**
 * Fill `{brand.header}` with the rendered block. An empty block removes the
 * token outright — the same contract the chart and interface tokens use.
 *
 * Nothing to escape here: `renderBrandBlock` has already escaped the two
 * operator-supplied strings it puts in its HTML form.
 */
export function substituteBrandTokens(body: string, block: string): string {
  if (!body) return body;
  return body.replace(BRAND_TOKEN_RE, block);
}

/**
 * Scale an image into the display box, preserving aspect ratio. Both dimensions
 * are emitted as HTML attributes because Outlook sizes from those, not CSS.
 */
export function fitLogo(size: ImageSize): { width: number; height: number } {
  const scale = Math.min(MAX_LOGO_WIDTH / size.width, MAX_LOGO_HEIGHT / size.height, 1);
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/**
 * Render the block for one body. Pure — the caller supplies what it read, so
 * the layout is unit-testable without a database or a filesystem.
 *
 * `name` is already the resolved decision (empty = don't print it, because the
 * mark carries the wordmark), not the raw branding field.
 */
export function renderBrandBlock(
  parts: { name: string; subtitle: string; logo: BrandLogoImage | null },
  opts: { html: boolean },
): string {
  const name = parts.name.trim();
  const subtitle = parts.subtitle.trim();
  if (!opts.html) {
    // No image in a text body, so the name is the only thing that can identify
    // the sender — printed even where the HTML leaves it to the wordmark.
    return [parts.logo ? parts.logo.alt : name, subtitle].filter((s) => s.length > 0).join(" — ");
  }
  if (!parts.logo && !name && !subtitle) return "";
  const rows: string[] = [];
  if (parts.logo) {
    rows.push(
      `<img src="cid:${BRAND_LOGO_CID}" width="${parts.logo.width}" height="${parts.logo.height}" ` +
        `alt="${escapeHtml(parts.logo.alt)}" ` +
        // display:inline-block (not block + margin-left:auto) so the cell's own
        // text-align:right positions it — Outlook honours the alignment, not
        // the auto margin.
        `style="display:inline-block;border:0;outline:none;text-decoration:none;width:${parts.logo.width}px;height:${parts.logo.height}px">`,
    );
  }
  if (name) {
    rows.push(`<div style="font-size:14px;font-weight:600;color:#1f2430;margin-top:6px">${escapeHtml(name)}</div>`);
  }
  if (subtitle) {
    rows.push(`<div style="font-size:11px;color:#6b7280;margin-top:2px">${escapeHtml(subtitle)}</div>`);
  }
  return rows.join("");
}

const warned = new Set<string>();
function warnOnce(key: string, msg: string, detail?: Record<string, unknown>): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn({ ...detail }, msg);
}

interface LoadedLogo {
  content: Buffer;
  contentType: string;
  filename: string;
  size: ImageSize;
}

/**
 * The bytes for the mark. Accepts PNG/JPEG only — a WebP upload has no accent
 * path either (resvg can't decode it), and mail clients are unreliable with it,
 * so such an install gets the name-and-subtitle block with no image.
 */
async function loadLogo(path: string): Promise<LoadedLogo | null> {
  try {
    const buf = await readFile(path);
    return describeLogo(buf, path);
  } catch (err) {
    warnOnce(`read:${path}`, "alertBrand: could not read logo for the alert email", { path, err: (err as Error)?.message });
    return null;
  }
}

function describeLogo(buf: Buffer, what: string): LoadedLogo | null {
  const ext = detectImageMagic(buf);
  if (ext !== ".png" && ext !== ".jpg") {
    warnOnce(`format:${what}`, "alertBrand: logo format unusable in email (PNG/JPEG required)", { what, detected: ext ?? "unknown" });
    return null;
  }
  const size = imageSize(buf);
  if (!size) {
    warnOnce(`dims:${what}`, "alertBrand: could not read logo dimensions", { what });
    return null;
  }
  return {
    content: buf,
    contentType: ext === ".png" ? "image/png" : "image/jpeg",
    filename: ext === ".png" ? "logo.png" : "logo.jpg",
    size,
  };
}

/**
 * Memoized for a minute. The drain sends up to BATCH_SIZE emails per tick and
 * every one of them wants the same block; branding changes on an operator's
 * click, so a minute of staleness in a letterhead costs nothing.
 */
const CACHE_TTL_MS = 60_000;
let cached: { at: number; block: AlertBrandBlock } | null = null;

/** The whole delivery-time step: read branding + the mark once, render both bodies. */
export async function buildAlertBrandBlock(): Promise<AlertBrandBlock> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.block;
  const block = await composeAlertBrandBlock();
  cached = { at: now, block };
  return block;
}

async function composeAlertBrandBlock(): Promise<AlertBrandBlock> {
  const branding = await getBranding().catch((err) => {
    warnOnce("branding", "alertBrand: could not read branding, sending without letterhead", { err: (err as Error)?.message });
    return null;
  });
  if (!branding) return { html: "", text: "", attachment: null };

  const custom = branding.customLogo;
  // Rule 27: the shipped wordmark already says the product name, so printing it
  // beside the mark says it twice. An operator's logo gets the name as caption
  // — unless they deliberately blanked the field, which is how they ask for no
  // text at all.
  const name = custom ? (branding.appName || "").trim() : "";
  const subtitle = (branding.subtitle || "").trim();

  let logo: LoadedLogo | null = null;
  if (custom) {
    // The accent composite when the operator enabled one, so the email shows
    // the same mark as the login page rather than a second arrangement of it.
    const accented = branding.logoAccent ? await renderAccentedLogo("light").catch(() => null) : null;
    if (accented) logo = describeLogo(accented.buf, "accented logo");
    if (!logo) {
      const resolved = resolveBrandingLogoFile(branding.logoUrl);
      logo = resolved.ok ? await loadLogo(resolved.path) : null;
    }
  }
  // Both the shipped-branding case and any failure above land on the wordmark.
  if (!logo) logo = await loadLogo(EMAIL_LOGO_PATH);

  const image: BrandLogoImage | null = logo
    ? {
        ...fitLogo(logo.size),
        // The alt text has to identify the sender when images are blocked, so
        // it prints the name even where the layout leaves it to the wordmark.
        alt: displayAppName(branding),
        attachment: { cid: BRAND_LOGO_CID, filename: logo.filename, contentType: logo.contentType, content: logo.content },
      }
    : null;

  const parts = { name, subtitle, logo: image };
  return {
    html: renderBrandBlock(parts, { html: true }),
    text: renderBrandBlock(parts, { html: false }),
    attachment: image?.attachment ?? null,
  };
}
