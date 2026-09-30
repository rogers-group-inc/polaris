/**
 * src/services/assetBulkTagService.ts
 *
 * Bulk tag edit for the Assets page bulk bar: one set of tags applied to many
 * assets in one of three modes.
 *
 *   - add     — union the tags onto each asset; nothing it already carries is
 *               touched. The default, because a selection is usually a mix of
 *               assets whose existing tags differ.
 *   - remove  — strip the tags from each asset that carries them; assets that
 *               don't are left alone.
 *   - replace — each asset ends up with exactly the chosen tags, EXCEPT the
 *               system-managed namespaces in REPLACE_PRESERVED_PREFIXES, which
 *               survive. A single-asset edit may drop a `region:` tag by hand;
 *               a bulk replace doing it silently would pull hundreds of assets
 *               out of every region-scoped user's and alert rule's view, and
 *               the `prev-entra:` / `prev-ad:` breadcrumbs are discovery's
 *               "preserve forever" markers. Remove still strips a region tag
 *               the operator names explicitly.
 *
 * Server-side rather than a per-asset PUT fan-out from the browser: the
 * selection spans pages, so the client never holds the current tags of most of
 * the rows it is editing, and add/remove against a stale copy would clobber a
 * concurrent write. Reads the selected rows once (`select: { id, tags }`),
 * writes only the rows whose tags actually change, in batched transactions
 * through the extended client so the db.ts asset-source shadow write still
 * fires — applyDelta's shape in tagAssignmentService.
 */

import { prisma } from "../db.js";
import { chunkArray } from "../utils/chunk.js";
import { AppError } from "../utils/errors.js";
import { assertAddedRegionTagsNameARegion } from "./mapRegionService.js";

export type BulkTagMode = "add" | "remove" | "replace";

/** Tag namespaces a bulk REPLACE keeps on every asset. Compared case-insensitively. */
export const REPLACE_PRESERVED_PREFIXES = ["region:", "prev-entra:", "prev-ad:"] as const;

const BATCH = 50;

function isPreservedOnReplace(tag: string): boolean {
  const k = tag.toLowerCase();
  return REPLACE_PRESERVED_PREFIXES.some((p) => k.startsWith(p));
}

/** Trim, drop empties, dedupe (exact match — asset tags are case-sensitive). */
export function normalizeBulkTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The tag array one asset ends up with. Pure; `tags` is already normalized. */
export function computeBulkTags(mode: BulkTagMode, existing: readonly string[], tags: readonly string[]): string[] {
  if (mode === "add") {
    return [...existing, ...tags.filter((t) => !existing.includes(t))];
  }
  if (mode === "remove") {
    return existing.filter((t) => !tags.includes(t));
  }
  const kept = existing.filter((t) => isPreservedOnReplace(t) && !tags.includes(t));
  return [...kept, ...tags];
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

export interface BulkTagResult {
  /** Assets whose tag array changed. */
  updated: number;
  /** Assets found but already in the requested state. */
  unchanged: number;
  /** Requested ids with no asset row. */
  notFound: string[];
  /** The normalized tag list that was applied. */
  tags: string[];
}

export async function bulkEditAssetTags(input: {
  ids: readonly string[];
  mode: BulkTagMode;
  tags: readonly string[];
}): Promise<BulkTagResult> {
  const ids = Array.from(new Set(input.ids));
  const tags = normalizeBulkTags(input.tags);
  // Replace with nothing selected is legal (clear every non-managed tag);
  // add/remove with nothing selected is a no-op the UI should never send.
  if (tags.length === 0 && input.mode !== "replace") {
    throw new AppError(400, "Select at least one tag");
  }
  // A `region:` tag being added must name a live region — the PUT's guard,
  // asked once for the whole batch rather than per asset.
  if (input.mode !== "remove") await assertAddedRegionTagsNameARegion([], tags);

  const rows = await prisma.asset.findMany({
    where: { id: { in: ids } },
    select: { id: true, tags: true },
  });
  const found = new Set(rows.map((r) => r.id));
  const notFound = ids.filter((id) => !found.has(id));

  const updates: { id: string; tags: string[] }[] = [];
  for (const row of rows) {
    const existing = Array.isArray(row.tags) ? row.tags : [];
    const next = computeBulkTags(input.mode, existing, tags);
    if (!sameTags(existing, next)) updates.push({ id: row.id, tags: next });
  }
  for (const chunk of chunkArray(updates, BATCH)) {
    await prisma.$transaction(
      chunk.map((u) => prisma.asset.update({ where: { id: u.id }, data: { tags: u.tags } })),
    );
  }

  return { updated: updates.length, unchanged: rows.length - updates.length, notFound, tags };
}
