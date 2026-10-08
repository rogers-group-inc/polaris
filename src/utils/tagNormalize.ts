/**
 * src/utils/tagNormalize.ts
 *
 * Shared normalization for the operator-typed tag dimensions carried by Role,
 * User, and GroupMapping: region tags and free-form ("other") tags. Trim, drop
 * empties, dedupe case-insensitively (first-seen casing wins), cap per-tag
 * length and total count. Extracted from roleService.normalizeRegionTags so
 * every tag writer (roleService, userService, groupMappingService) shares one
 * rule set.
 *
 * Neither dimension is FK'd to a registry: region names can be pre-assigned
 * before a map polygon is drawn, and "other" tags are intentionally free-form.
 */

import { AppError } from "./errors.js";

export const TAG_MAX_LEN = 64;
export const TAGS_MAX_COUNT = 64;

/**
 * The prefix an ASSET's region tag carries. `User`/`Role`/`GroupMapping`
 * `regionTags` store bare names, so anything comparing the two sides strips it
 * first.
 *
 * Lives in this leaf util rather than in `notificationService` (which still
 * re-exports it for its existing importers) because `regionHierarchyService`
 * needs it on the alert-routing path, and notificationService imports
 * notificationRuleService — importing it from there would have closed a
 * notificationRuleService → regionHierarchyService → notificationService →
 * notificationRuleService cycle.
 */
export const REGION_TAG_PREFIX = "region:";

/**
 * The prefix an asset tag mirrored from an Azure resource tag carries —
 * `azure:<key>=<value>`. Owned by the Azure Arc sync alone: each Arc run strips
 * every `azure:` tag off the assets it touches and re-adds the current set, so
 * no other writer (operator registry row, auto-assign filter) may mint one.
 */
export const AZURE_TAG_PREFIX = "azure:";

/** The Tag registry category the Arc sync files its mirrored `azure:` rows under. */
export const AZURE_TAG_CATEGORY = "Azure Tags";

/** True for an `azure:`-prefixed tag (case-insensitive). */
export function isAzureTag(tag: string): boolean {
  return tag.toLowerCase().startsWith(AZURE_TAG_PREFIX);
}

/**
 * The tag array an operator write leaves on an asset: the posted tags without
 * any `azure:` tag, plus the `azure:` tags the asset already carries. Arc owns
 * that namespace outright — the tag picker has no chip for them, so an edit
 * form saves a list without them (they must survive), and a tag hand-added
 * under the prefix would claim an Azure tag the resource does not have (it
 * must not land).
 */
export function withArcOwnedTags(existing: readonly string[], posted: readonly string[]): string[] {
  return [...existing.filter(isAzureTag), ...posted.filter((t) => !isAzureTag(t))];
}

/** Strip the `region:` prefix from a map-region tag (case-insensitive). */
export function stripRegionPrefix(tag: string): string {
  return tag.toLowerCase().startsWith(REGION_TAG_PREFIX)
    ? tag.slice(REGION_TAG_PREFIX.length)
    : tag;
}

/**
 * Validate + normalize a list of operator-typed tags. `label` only shapes the
 * error message (e.g. "region tag" → "Region tag ... exceeds 64 characters").
 */
export function normalizeTags(input: unknown, label = "tag"): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length > TAG_MAX_LEN) {
      const pretty = label.charAt(0).toUpperCase() + label.slice(1);
      throw new AppError(400, `${pretty} "${trimmed.slice(0, 32)}..." exceeds ${TAG_MAX_LEN} characters`);
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  if (out.length > TAGS_MAX_COUNT) {
    throw new AppError(400, `At most ${TAGS_MAX_COUNT} ${label}s allowed`);
  }
  return out;
}

/**
 * Union one or more tag lists into a single deduped, case-insensitively unique,
 * sorted list. Used to compute a session's effective scope from the
 * role / user / group-derived sources at GET /auth/me. First-seen casing wins.
 */
export function unionTags(...lists: (readonly string[] | null | undefined)[]): string[] {
  const seen = new Map<string, string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) seen.set(key, trimmed);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

/**
 * Replace one tag with another in a principal's tag list, case-insensitively.
 * Returns `null` when the list does not carry `from` — so a caller can update
 * only the rows that actually change.
 *
 * Exists for region RENAME. A map region's name is the ONLY thing tying a
 * `User`/`Role`/`GroupMapping` region tag to the region it means: the scope
 * columns are deliberately not FK'd to a registry (a region can be pre-assigned
 * before its polygon is drawn), so a rename that does not carry them silently
 * revokes the scope — the tag stays in the column, matches no region, and every
 * consumer that resolves by name (Device Map "My regions", the dashboard region
 * filter, `recipientDeviceRegion` and level-scoped alert routing) quietly
 * reaches nothing. Following the rename preserves what the operator said; the
 * alternative preserves only the string they typed.
 *
 * Position is kept (the picker renders in stored order) and the result is
 * deduped case-insensitively, because the principal may already hold the new
 * name — a rename must not be able to grow the list.
 */
export function renameTagInList(
  tags: readonly string[] | null | undefined,
  from: string,
  to: string,
): string[] | null {
  if (!Array.isArray(tags) || tags.length === 0) return null;
  const fromKey = String(from ?? "").trim().toLowerCase();
  const target = String(to ?? "").trim();
  if (!fromKey || !target) return null;

  let hit = false;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const matched = trimmed.toLowerCase() === fromKey;
    if (matched) hit = true;
    const value = matched ? target : trimmed;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return hit ? out : null;
}
