/**
 * src/services/assetTagListService.ts — the Assets list's Tags column.
 *
 * `Asset.tags` is a String[], and Prisma can neither substring-match inside a
 * scalar list (`has` / `hasSome` are exact) nor order by one. The column still
 * has to behave like every other TableSF text column — contains / does not
 * contain / is empty / is not empty, and a header click that sorts — so:
 *
 *   - filter: `contains` / `not_contains` resolve the matching asset ids with
 *     ONE raw query (any element ILIKE the term), and the route folds them in
 *     as `id IN` / `id NOT IN`; the blank ops use Prisma's `isEmpty` directly.
 *   - sort: the rows matching the active filters are read with a two-column
 *     select (id, tags), ordered in memory by `tagSortKey`, and the requested
 *     page is sliced out of that order. At 2000 assets that is one narrow scan
 *     per page load — the same scan GET /assets/tags already does.
 *
 * Matching is case-insensitive and on each tag separately, so "prod" matches
 * the tag "Production" but a term cannot straddle two tags.
 */

import { prisma } from "../db.js";

/** Escape LIKE wildcards so a typed `%` or `_` is matched literally. */
function likeEscape(term: string): string {
  return term.replace(/[\\%_]/g, (c) => "\\" + c);
}

/**
 * Ids of the assets carrying at least one tag that contains `term`
 * (case-insensitive). Blank term → empty list.
 */
export async function findAssetIdsByTagSubstring(term: string): Promise<string[]> {
  const t = term.trim();
  if (!t) return [];
  const pattern = `%${likeEscape(t)}%`;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT a.id
    FROM assets a
    WHERE EXISTS (SELECT 1 FROM unnest(a.tags) AS tag WHERE tag ILIKE ${pattern})
  `;
  return rows.map((r) => r.id);
}

/**
 * Translate the Tags column filter into a where fragment. `matchingIds` is the
 * `findAssetIdsByTagSubstring` result for the term (only consulted by the two
 * term-bearing ops). Returns undefined for a no-op filter.
 */
export function buildTagFilter(
  value: string | undefined,
  op: string | undefined,
  matchingIds: string[],
): Record<string, unknown> | undefined {
  if (op === "empty") return { tags: { isEmpty: true } };
  if (op === "is_not_empty") return { NOT: { tags: { isEmpty: true } } };
  if (!(value || "").trim()) return undefined;
  if (op === "not_contains") return matchingIds.length ? { id: { notIn: matchingIds } } : undefined;
  return { id: { in: matchingIds } };
}

/** True when the filter needs `findAssetIdsByTagSubstring` resolved first. */
export function tagFilterNeedsLookup(value: string | undefined, op: string | undefined): boolean {
  if (op === "empty" || op === "is_not_empty") return false;
  return !!(value || "").trim();
}

/**
 * Sort key for one row's tags: the tags lowercased, alphabetised and joined,
 * so a row sorts by its alphabetically-first tag, then its next. Null for an
 * untagged row.
 */
export function tagSortKey(tags: string[] | null | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  return tags.map((t) => t.toLowerCase()).sort().join("\u0000");
}

/**
 * Order rows by their tags. Untagged rows go last in BOTH directions — an
 * operator sorting by Tags is looking for tagged rows, and a descending sort
 * that opened on a page of blanks would hide them. Ties fall back to id so the
 * order is stable across page loads. When `favoriteIds` is given, starred rows
 * float ahead of everything else (the list's favorites-first contract), each
 * bucket sorted the same way.
 */
export function sortIdsByTags(
  rows: Array<{ id: string; tags: string[] }>,
  dir: "asc" | "desc",
  favoriteIds?: Set<string>,
): string[] {
  const sign = dir === "desc" ? -1 : 1;
  const decorated = rows.map((r) => ({
    id: r.id,
    key: tagSortKey(r.tags),
    fav: favoriteIds ? favoriteIds.has(r.id) : false,
  }));
  decorated.sort((a, b) => {
    if (a.fav !== b.fav) return a.fav ? -1 : 1;
    if (a.key === null || b.key === null) {
      if (a.key === b.key) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      return a.key === null ? 1 : -1;
    }
    if (a.key !== b.key) return (a.key < b.key ? -1 : 1) * sign;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return decorated.map((d) => d.id);
}

/**
 * One page of asset ids ordered by tags, plus the total. `where` is the list
 * endpoint's filter; the caller fetches the full rows for the returned ids and
 * restores this order.
 */
export async function pageAssetIdsByTags(
  where: Record<string, unknown>,
  dir: "asc" | "desc",
  offset: number,
  limit: number,
  favoriteIds?: string[],
): Promise<{ ids: string[]; total: number }> {
  const rows = await prisma.asset.findMany({ where, select: { id: true, tags: true } });
  const favs = favoriteIds && favoriteIds.length ? new Set(favoriteIds) : undefined;
  const ordered = sortIdsByTags(rows, dir, favs);
  return { ids: ordered.slice(offset, offset + limit), total: ordered.length };
}
