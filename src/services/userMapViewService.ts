/**
 * src/services/userMapViewService.ts
 *
 * The map regions an account has hidden (User.hiddenMapRegionIds) — the
 * Device Map Regions panel's eyes. Stored on the User rather than per browser
 * so the desktop page and the phone's Map tab hide the same regions and the
 * same FortiGates.
 *
 * A view preference only, in the UserTableTabs mould: strictly per-caller, no
 * Event audit, nothing an administrator manages. It narrows what a client
 * DRAWS, never what the account may read — search still finds a gate in a
 * hidden region and opens its topology.
 *
 * Ids are not checked against MapRegion: a region deleted after being hidden
 * leaves an id that matches nothing, which every client already ignores, and
 * validating would turn a stale id into a 400 that loses the rest of the list.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";

/** Far above any real region count; bounds the column a client can grow. */
export const MAX_HIDDEN_MAP_REGIONS = 500;
const MAX_ID_LENGTH = 128;

/**
 * Trim, drop non-strings / empties / over-long values, de-duplicate (first
 * occurrence wins) and cap. Lenient on purpose — used on read too, where a
 * malformed stored value must degrade to "nothing hidden" rather than fail
 * the map.
 */
export function normalizeHiddenMapRegionIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || id.length > MAX_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_HIDDEN_MAP_REGIONS) break;
  }
  return out;
}

export async function getHiddenMapRegionIds(userId: string): Promise<string[]> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { hiddenMapRegionIds: true },
  });
  if (!row) throw new AppError(404, "User not found");
  return normalizeHiddenMapRegionIds(row.hiddenMapRegionIds);
}

export async function setHiddenMapRegionIds(userId: string, ids: unknown): Promise<string[]> {
  const hiddenMapRegionIds = normalizeHiddenMapRegionIds(ids);
  const row = await prisma.user
    .update({ where: { id: userId }, data: { hiddenMapRegionIds }, select: { hiddenMapRegionIds: true } })
    .catch((err: unknown) => {
      if ((err as { code?: string })?.code === "P2025") throw new AppError(404, "User not found");
      throw err;
    });
  return normalizeHiddenMapRegionIds(row.hiddenMapRegionIds);
}
