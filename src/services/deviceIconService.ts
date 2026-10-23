/**
 * src/services/deviceIconService.ts — operator-uploaded device icons
 *
 * Used by the Device Map's topology graph to overlay vendor-specific
 * imagery on each node's colored status circle. Every icon is keyed
 * to a manufacturer plus either a specific model or an asset type —
 * standalone "just a type" / "just a model" / "just a manufacturer"
 * uploads are intentionally not supported (a logo for "firewall"
 * across every vendor would be meaningless). Resolution at render
 * time is most-specific-wins:
 *
 *   1. scope="manufacturer-model" key="<manufacturer>/<model>"     — specific chassis
 *   2. scope="manufacturer-type"  key="<manufacturer>/<assetType>" — vendor + role
 *   3. no row → null (frontend leaves the node as a plain status circle)
 *
 * The topology renderer overlays the resolved icon at ~70% of the node
 * size so the operator sees BOTH the asset status (color of the ring)
 * AND the vendor logo (inset image) at a glance.
 *
 * Manufacturer keys are canonicalized through the same alias map as
 * Asset.manufacturer (Fortinet, Inc. → Fortinet) so the picker and the
 * resolver agree.
 *
 * Storage is bytes-in-DB (image data column on the row) plus a dedicated
 * /api/v1/device-icons/:id/image route that serves the raw bytes with
 * Content-Type + Cache-Control headers. Browser caches via standard HTTP
 * cache so a topology re-render doesn't re-fetch the image.
 *
 * Validation at upload time:
 *   - mimeType in the allowed set (PNG / JPEG / WebP / SVG).
 *   - Raster size cap MAX_ICON_BYTES; SVG cap MAX_SVG_BYTES (lower —
 *     operator icons should be tiny and parser work scales with size).
 *   - Magic-byte check on the first few bytes for raster formats.
 *   - SVG: text decode + pattern-based reject of script / DOCTYPE /
 *     ENTITY / foreignObject / event handlers / javascript: URLs /
 *     external href refs / iframe/object/embed / xml-stylesheet PI /
 *     @import in <style>. Reject (not sanitize) so the operator sees
 *     the rejection and re-exports from their tool rather than us
 *     silently rewriting stored content.
 */

import { Resvg } from "@resvg/resvg-js";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { AppError } from "../utils/errors.js";
import { normalizeManufacturer } from "../utils/manufacturerNormalize.js";
import { isKnownAssetType } from "../utils/assetTypes.js";

// Target pixel dimensions for SVG rasterization. 512px is comfortably
// above any topology zoom we render at (typical FortiGate node is 64
// model px ≈ ~256 render px at 4× zoom). Cytoscape's image pipeline
// can't scale a bitmap past its natural pixel size, so we render
// large up-front and let the renderer downsize. PNG is the output
// because it preserves the SVG's transparency cleanly.
const SVG_RASTER_SIZE = 512;

const MAX_ICON_BYTES = 256 * 1024; // 256 KB — plenty for a raster node icon.
const MAX_SVG_BYTES = 32 * 1024;   // 32 KB — SVGs are text and parser work scales with size; node icons are simple.

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
]);

// Magic-byte signatures for the raster formats. SVG is handled separately
// by validateSvg() because XML can start with an optional BOM + whitespace
// + either `<?xml` or `<svg`.
const MAGIC_BYTES: Array<{ mime: string; prefix: number[] }> = [
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  { mime: "image/png", prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // JPEG: FF D8 FF
  { mime: "image/jpeg", prefix: [0xff, 0xd8, 0xff] },
  // WebP: RIFF....WEBP
  { mime: "image/webp", prefix: [0x52, 0x49, 0x46, 0x46] },
];

// SVG reject patterns. Any match → refuse the upload. Case-insensitive;
// applied to the decoded UTF-8 text of the SVG. Conservative by design.
const SVG_REJECT_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "<script>",          re: /<\s*script\b/i },
  { name: "<foreignObject>",   re: /<\s*foreignObject\b/i },
  { name: "<iframe>",          re: /<\s*iframe\b/i },
  { name: "<object>",          re: /<\s*object\b/i },
  { name: "<embed>",           re: /<\s*embed\b/i },
  { name: "<!DOCTYPE>",        re: /<!\s*DOCTYPE/i },
  { name: "<!ENTITY>",         re: /<!\s*ENTITY/i },
  { name: "xml-stylesheet PI", re: /<\?\s*xml-stylesheet/i },
  // Inline event handlers (onclick, onload, onmouseover, ...).
  { name: "on*= event handler", re: /\s+on[a-z]+\s*=/i },
  // javascript: in any URL attribute. Allow leading whitespace + the
  // common "&#x6A;avascript:" entity-escape trick is also blocked because
  // we reject any `&#` entity reference in href/xlink:href below.
  { name: "javascript: URL", re: /\b(?:href|xlink:href|src|action|formaction)\s*=\s*["']?\s*(?:&#[xX]?[0-9a-fA-F]+;?\s*)*j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i },
  // External href / xlink:href / src — anything not starting with '#'
  // (in-document fragment). Disallows http://, https://, //, data:,
  // file://, etc. SVGs that need <use href="#foo"> are unaffected.
  { name: "external href", re: /\b(?:href|xlink:href|src)\s*=\s*["'](?!#)[^"']*["']/i },
  // CSS @import or url() pointing outside the document.
  { name: "@import in <style>", re: /@import\b/i },
  { name: "external url() in CSS", re: /url\s*\(\s*["']?(?!\s*#)(?:https?:|\/\/|data:|file:)/i },
];

export type IconScope = "manufacturer-type" | "manufacturer-model";

export interface UploadedIcon {
  scope: IconScope;
  // Caller-supplied raw inputs; the service builds the canonical key
  // by alias-normalizing manufacturer and joining with `/`. The route
  // layer collects these from separate form fields rather than asking
  // the operator to type the slash themselves.
  manufacturer: string;
  typeOrModel: string;
  filename: string;
  mimeType: string;
  data: Buffer;
  uploadedBy?: string;
}

export interface DeviceIconSummary {
  id: string;
  scope: string;
  key: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedBy: string | null;
  uploadedAt: Date;
}

function detectMagicMime(data: Buffer): string | null {
  for (const { mime, prefix } of MAGIC_BYTES) {
    if (data.length < prefix.length) continue;
    let ok = true;
    for (let i = 0; i < prefix.length; i++) {
      if (data[i] !== prefix[i]) { ok = false; break; }
    }
    if (ok) return mime;
  }
  return null;
}

function buildKey(scope: IconScope, manufacturer: string, typeOrModel: string): string {
  const manufCanonical = normalizeManufacturer(manufacturer.trim()) ?? manufacturer.trim();
  const tail = scope === "manufacturer-type" ? typeOrModel.trim().toLowerCase() : typeOrModel.trim();
  return `${manufCanonical}/${tail}`;
}

// Asset-type validation delegates to the live AssetTypeDef registry
// (utils/assetTypes.isKnownAssetType) — the previous frozen literal set
// predated the registry cutover and rejected uploads for the seeded
// `hypervisor` built-in and every operator-added custom type.

function validateSvg(data: Buffer): void {
  // Decode as UTF-8 with replacement so invalid sequences still surface
  // patterns rather than throw. Strip a leading BOM if present.
  let text = data.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const trimmedStart = text.trimStart();
  // Must start with <?xml or <svg. Anything else (HTML, plain text,
  // mis-extension binary that happens to decode) gets refused.
  if (!/^<\?xml\b/i.test(trimmedStart) && !/^<svg\b/i.test(trimmedStart)) {
    throw new AppError(400, "File doesn't look like an SVG (missing <?xml or <svg root element)");
  }
  // Confirm a <svg> element is present somewhere in the document. Guards
  // against an XML file that has the prolog but isn't actually an SVG.
  if (!/<\s*svg\b/i.test(text)) {
    throw new AppError(400, "SVG payload missing <svg> root element");
  }
  for (const { name, re } of SVG_REJECT_PATTERNS) {
    if (re.test(text)) {
      throw new AppError(400, `SVG rejected — contains ${name}. SVG uploads disallow scripts, external references, and other dynamic content.`);
    }
  }
}

/** Validate what an icon is keyed to and return its canonical key. Shared by
 *  upload and `updateIconKey`, so a re-keyed icon meets the same rules. */
function validateIconKey(scope: IconScope, manufacturer: string, typeOrModel: string): string {
  if (scope !== "manufacturer-type" && scope !== "manufacturer-model") {
    throw new AppError(400, `Invalid scope "${scope}" — must be "manufacturer-type" or "manufacturer-model"`);
  }
  if (!manufacturer || !manufacturer.trim()) {
    throw new AppError(400, "Manufacturer is required");
  }
  if (!typeOrModel || !typeOrModel.trim()) {
    throw new AppError(400, scope === "manufacturer-type" ? "Asset type is required" : "Model is required");
  }
  const key = buildKey(scope, manufacturer, typeOrModel);
  // After canonicalization the manufacturer half may have collapsed to
  // empty (e.g. the alias map mapped to ""). The tail check above
  // already covers an empty trailing segment.
  if (key.startsWith("/")) {
    throw new AppError(400, "Manufacturer is required");
  }
  if (scope === "manufacturer-type") {
    const typeKey = key.split("/").slice(1).join("/");
    if (!isKnownAssetType(typeKey)) {
      throw new AppError(400, `Invalid asset type "${typeKey}" — not in the asset-type registry (built-in or custom)`);
    }
  }
  return key;
}

export function validateUpload(input: UploadedIcon): void {
  validateIconKey(input.scope, input.manufacturer, input.typeOrModel);
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new AppError(400, `Unsupported image format "${input.mimeType}" — allowed: PNG, JPEG, WebP, SVG`);
  }
  if (!input.data || input.data.length === 0) {
    throw new AppError(400, "Empty file upload");
  }
  const isSvg = input.mimeType === "image/svg+xml";
  const cap = isSvg ? MAX_SVG_BYTES : MAX_ICON_BYTES;
  if (input.data.length > cap) {
    throw new AppError(400, `Icon too large (${input.data.length} bytes; max ${cap} for ${isSvg ? "SVG" : "raster"})`);
  }
  if (isSvg) {
    validateSvg(input.data);
    return;
  }
  // Magic-byte check — declared mimeType must match what's in the bytes.
  // Defends against mis-extension uploads.
  const detected = detectMagicMime(input.data);
  if (!detected) throw new AppError(400, "File doesn't look like a valid PNG / JPEG / WebP image");
  if (detected !== input.mimeType) {
    throw new AppError(400, `File contents are ${detected} but upload declared ${input.mimeType}`);
  }
}

// Render an SVG buffer to a 512×512 PNG using resvg. Throws AppError(400)
// with the operator-facing message if resvg can't parse the SVG (caller
// has already passed it through validateSvg's security gate, so failures
// here are almost always malformed XML rather than something hostile).
function rasterizeSvgToPng(svgData: Buffer): Buffer {
  let resvg: Resvg;
  try {
    resvg = new Resvg(svgData, {
      fitTo: { mode: "width", value: SVG_RASTER_SIZE },
      // background: undefined → transparent. Topology renderer fills
      // the node interior with white before painting the icon, so a
      // transparent PNG composites correctly over either basemap theme.
    });
  } catch (err) {
    throw new AppError(400, `SVG could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return Buffer.from(resvg.render().asPng());
}

export async function uploadIcon(input: UploadedIcon): Promise<DeviceIconSummary> {
  validateUpload(input);
  const key = buildKey(input.scope, input.manufacturer, input.typeOrModel);
  // SVG uploads are transparently converted to PNG before storage.
  // Cytoscape's bitmap pipeline doesn't scale SVGs past their browser-
  // assigned natural size (typically tiny when the SVG has only a
  // viewBox + no width/height — the Adobe Illustrator export default).
  // Rasterizing up-front at 512px sidesteps the whole class of bug —
  // stored bytes are PNG with intrinsic pixel dimensions, and the
  // serve path no longer needs SVG-specific handling.
  let storedMime = input.mimeType;
  let storedData = input.data;
  let storedFilename = input.filename;
  if (input.mimeType === "image/svg+xml") {
    storedData = rasterizeSvgToPng(input.data);
    storedMime = "image/png";
    storedFilename = input.filename.replace(/\.svg$/i, "") + ".png";
  }
  // Prisma 7 Bytes column wants Uint8Array<ArrayBuffer> strictly; the
  // Buffer type from multer is Buffer<ArrayBufferLike> (where ArrayBufferLike
  // includes SharedArrayBuffer). Copy into a fresh Uint8Array backed by a
  // dedicated ArrayBuffer so the type narrows correctly.
  const dataBytes = new Uint8Array(storedData.byteLength);
  dataBytes.set(storedData);
  const row = await prisma.deviceIcon.upsert({
    where: { scope_key: { scope: input.scope, key } },
    create: {
      scope: input.scope,
      key,
      filename: storedFilename,
      mimeType: storedMime,
      data: dataBytes,
      size: storedData.length,
      uploadedBy: input.uploadedBy ?? null,
    },
    update: {
      filename: storedFilename,
      mimeType: storedMime,
      data: dataBytes,
      size: storedData.length,
      uploadedBy: input.uploadedBy ?? null,
      uploadedAt: new Date(),
    },
  });
  return summarize(row);
}

// One-shot backfill: convert any DeviceIcon rows still stored as SVG
// into PNG using the same rasterizer the upload path uses. Idempotent
// via the mimeType filter — second-run finds zero rows. Best-effort
// per-row: a single malformed SVG doesn't abort the rest of the
// migration; failures are logged and the row is left alone.
export async function rasterizeStoredSvgIcons(): Promise<{ converted: number; failed: number }> {
  const rows = await prisma.deviceIcon.findMany({
    where: { mimeType: "image/svg+xml" },
    select: { id: true, filename: true, data: true },
  });
  let converted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const png = rasterizeSvgToPng(Buffer.from(row.data));
      const pngBytes = new Uint8Array(png.byteLength);
      pngBytes.set(png);
      await prisma.deviceIcon.update({
        where: { id: row.id },
        data: {
          mimeType: "image/png",
          filename: row.filename.replace(/\.svg$/i, "") + ".png",
          data: pngBytes,
          size: png.length,
        },
      });
      converted++;
    } catch (err) {
      failed++;
      logger.warn({ err, iconId: row.id }, "deviceIconService backfill: failed to rasterize SVG icon");
    }
  }
  return { converted, failed };
}

export async function listIcons(): Promise<DeviceIconSummary[]> {
  const rows = await prisma.deviceIcon.findMany({
    select: { id: true, scope: true, key: true, filename: true, mimeType: true, size: true, uploadedBy: true, uploadedAt: true },
    orderBy: [{ scope: "asc" }, { key: "asc" }],
  });
  return rows;
}

export async function getIconImage(id: string): Promise<{ mimeType: string; data: Buffer } | null> {
  const row = await prisma.deviceIcon.findUnique({
    where: { id },
    select: { mimeType: true, data: true },
  });
  if (!row) return null;
  return { mimeType: row.mimeType, data: Buffer.from(row.data) };
}

/**
 * Re-key an icon — change its manufacturer, its asset type or model, or which
 * of the two it matches by — keeping the image. Unlike upload (which upserts,
 * replacing whatever image held the key), a key already held by ANOTHER icon
 * is a 409: re-keying must never silently delete a different image.
 * Returns the updated icon and the key it had before, for the audit Event.
 */
export async function updateIconKey(
  id: string,
  input: { scope: IconScope; manufacturer: string; typeOrModel: string },
): Promise<{ icon: DeviceIconSummary; previous: { scope: string; key: string } }> {
  const key = validateIconKey(input.scope, input.manufacturer, input.typeOrModel);
  const existing = await prisma.deviceIcon.findUnique({ where: { id }, select: { scope: true, key: true } });
  if (!existing) throw new AppError(404, "Icon not found");
  const holder = await prisma.deviceIcon.findUnique({
    where: { scope_key: { scope: input.scope, key } },
    select: { id: true },
  });
  if (holder && holder.id !== id) {
    throw new AppError(409, `Another icon is already keyed to ${key} — delete it first`);
  }
  try {
    const row = await prisma.deviceIcon.update({
      where: { id },
      data: { scope: input.scope, key },
      select: { id: true, scope: true, key: true, filename: true, mimeType: true, size: true, uploadedBy: true, uploadedAt: true },
    });
    return { icon: summarize(row), previous: existing };
  } catch (err) {
    // Lost a race with a concurrent upload of the same key.
    if ((err as { code?: string }).code === "P2002") {
      throw new AppError(409, `Another icon is already keyed to ${key} — delete it first`);
    }
    throw err;
  }
}

export async function deleteIcon(id: string): Promise<boolean> {
  try {
    await prisma.deviceIcon.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}

// Resolve which icon (if any) applies to an asset. Returns the icon id
// the topology endpoint can reference as `iconUrl: /api/v1/device-icons/<id>/image`.
// Most-specific-wins; null when no icon matches.
//
// Caller passes a snapshot of the asset's relevant fields so this can run
// over an in-memory list without per-asset DB roundtrips.
export interface IconResolutionInput {
  manufacturer: string | null;
  model: string | null;
  assetType: string | null;
}

// (The per-asset async resolver that lived here was removed 2026-08 —
// superseded by the bulk cache path below, zero callers remained.)

// Bulk-resolution helper for renderers (e.g. topology endpoint) that need
// icons for many assets in one go. Pre-loads all icons once and returns
// a Map<scopeKey, iconId> for in-memory lookup.
export async function loadIconResolutionCache(): Promise<Map<string, string | null>> {
  const rows = await prisma.deviceIcon.findMany({
    select: { id: true, scope: true, key: true },
  });
  const cache = new Map<string, string | null>();
  for (const r of rows) {
    cache.set(`${r.scope}|${r.key}`, r.id);
  }
  return cache;
}

// Resolve an iconUrl for a single asset using a pre-loaded cache (sync).
// Returns the relative URL path or null.
export function resolveIconUrl(input: IconResolutionInput, cache: Map<string, string | null>): string | null {
  const candidates = buildResolutionCandidates(input).map((c) => `${c.scope}|${c.key}`);
  for (const c of candidates) {
    const id = cache.get(c);
    if (id) return `/api/v1/device-icons/${id}/image`;
  }
  return null;
}

// Build the ordered candidate list for resolution. Priority (per project
// decision, see polaris-domain-model -> platform.md "DeviceIcon"):
//   1. manufacturer-model: <manufacturer>/<model>     (specific chassis)
//   2. manufacturer-type:  <manufacturer>/<assetType> (vendor + role)
// Both require a manufacturer — there is no plain-type / plain-model
// fallback because a "firewall" logo across every vendor would be
// meaningless. Assets with no manufacturer resolve to null and fall
// back to the plain status circle in the renderer.
function buildResolutionCandidates(input: IconResolutionInput): Array<{ scope: string; key: string }> {
  const candidates: Array<{ scope: string; key: string }> = [];
  const manufacturerCanonical = input.manufacturer
    ? (normalizeManufacturer(input.manufacturer.trim()) ?? input.manufacturer.trim())
    : null;
  if (!manufacturerCanonical) return candidates;
  if (input.model) {
    candidates.push({ scope: "manufacturer-model", key: `${manufacturerCanonical}/${input.model.trim()}` });
  }
  if (input.assetType) {
    candidates.push({ scope: "manufacturer-type", key: `${manufacturerCanonical}/${input.assetType.trim().toLowerCase()}` });
  }
  return candidates;
}

function summarize(row: {
  id: string; scope: string; key: string; filename: string;
  mimeType: string; size: number; uploadedBy: string | null; uploadedAt: Date;
}): DeviceIconSummary {
  return {
    id: row.id,
    scope: row.scope,
    key: row.key,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    uploadedBy: row.uploadedBy,
    uploadedAt: row.uploadedAt,
  };
}
