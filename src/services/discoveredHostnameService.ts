/**
 * src/services/discoveredHostnameService.ts
 *
 * "What hostname would this asset have if the operator pin were cleared?"
 *
 * `Asset.hostnameOverride` makes the pinned value THE hostname: the assets PUT
 * handler writes both columns and the Prisma extension in src/db.ts re-asserts
 * the pin over every later projection write (see polaris-domain-model -> assets-core.md
 * "three operator pins"). So the discovered name is not stored anywhere on the
 * Asset row — it only exists inside the `AssetSource.observed` blobs, which is
 * where the pin-clear path in assets.ts already goes to recover it
 * (`loadProjection().projected.hostname`).
 *
 * This service is that same read, batched, so a list page can render the
 * discovered name UNDER the pinned one. Computing it rather than stashing a
 * column at write time keeps it LIVE (it tracks what discovery says today, not
 * what it said the moment the operator typed the pin) and retroactive (assets
 * pinned before this existed render immediately, with no migration and no
 * backfill job).
 *
 * Cost: callers pass only the ids that actually carry a pin, so the extra query
 * disappears on a page with no overrides — one indexed `assetId IN (...)` scan
 * of `asset_sources` otherwise. Deliberately uncapped: the id set is bounded by
 * how many hostnames an operator has hand-pinned, which is a per-device manual
 * act, and truncating it would silently blank the sub-line on some rows.
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import {
  projectAssetFromSources,
  type AssetSourceForProjection,
} from "../utils/assetProjection.js";

/** One AssetSource row, as read for this projection. */
export interface HostnameSourceRow extends AssetSourceForProjection {
  assetId: string;
}

/**
 * Pure core: group source rows by asset and run the hostname projection over
 * each group. An asset whose sources have no hostname opinion (a manually
 * created asset, or one whose only sources are `inferred` phase-1 skeletons)
 * maps to null — there IS no original to show, which the caller renders as
 * nothing rather than as an empty line.
 */
export function projectHostnamesFromSourceRows(
  rows: HostnameSourceRow[],
): Map<string, string | null> {
  const byAsset = new Map<string, AssetSourceForProjection[]>();
  for (const r of rows) {
    const list = byAsset.get(r.assetId);
    const entry: AssetSourceForProjection = {
      sourceKind: r.sourceKind,
      inferred: r.inferred,
      observed: r.observed,
      lastSeen: r.lastSeen,
    };
    if (list) list.push(entry);
    else byAsset.set(r.assetId, [entry]);
  }
  const out = new Map<string, string | null>();
  for (const [assetId, sources] of byAsset) {
    out.set(assetId, projectAssetFromSources(sources).projected.hostname);
  }
  return out;
}

/**
 * The discovery-projected hostname for each of `assetIds`. Ids with no sources
 * are simply absent from the map (same meaning as a null value: nothing to
 * show).
 */
export async function getDiscoveredHostnames(
  assetIds: string[],
): Promise<Map<string, string | null>> {
  if (assetIds.length === 0) return new Map();
  const rows = await prisma.assetSource.findMany({
    where: { assetId: { in: assetIds } },
    select: { assetId: true, sourceKind: true, inferred: true, observed: true, lastSeen: true },
  });
  return projectHostnamesFromSourceRows(
    rows.map((r) => ({
      assetId: r.assetId,
      sourceKind: r.sourceKind,
      inferred: r.inferred,
      observed: r.observed as Record<string, unknown> | null,
      lastSeen: r.lastSeen,
    })),
  );
}

/** Single-asset convenience for the asset-details GET. */
export async function getDiscoveredHostname(assetId: string): Promise<string | null> {
  return (await getDiscoveredHostnames([assetId])).get(assetId) ?? null;
}

// ─── Reverse lookup: find the assets whose DISCOVERED hostname matches ───────
//
// The forward read above answers "what would this asset be called?"; search and
// the assets-list Hostname filter need the inverse — "which assets would be
// called X?" — because a pinned asset shows TWO names to the operator (the pin,
// plus the discovered name as a second line) and typing either one must find
// the row. `Asset.hostname` only carries the pin, so the discovered half is
// invisible to every column filter.
//
// Two steps, and both matter:
//   1. Narrow in SQL. `observed::text ILIKE` rides the GIN trigram index added
//      in 20260507200000_search_json_trgm_indexes (the same predicate the
//      global search's JSON arm uses), and the join to `hostnameOverride IS NOT
//      NULL` cuts the candidate set to hand-pinned assets only. A whole-blob
//      match is deliberately loose here: which key holds the hostname depends
//      on the source kind (`hostname` / `guestHostname` / `deviceName` /
//      `displayName` / `dnsHostName` / `switchId` / `name` — see HOSTNAME_RULES
//      in utils/assetProjection.ts), so keying on one column would miss most
//      sources.
//   2. Confirm against the projection. Step 1 also matches a serial or a UPN
//      that happens to contain the term; only the projected hostname — the
//      exact string the UI prints under the pin — is allowed to decide the
//      match. That keeps "hostname contains X" honest: every row it returns
//      shows an X in one of its two names.
//
// Multi-term queries AND per blob, which costs nothing in correctness: the
// projected hostname is one string from one source, so if every term is in the
// name, every term is in that blob.

/**
 * Defensive cap on the step-1 candidate id list. The real bound is how many
 * hostnames an operator has hand-pinned (a per-device manual act), so this only
 * ever bites a pathological one-character term against a heavily pinned fleet —
 * where the answer is "refine the filter", not "seq-scan the source blobs".
 */
const DISCOVERED_CANDIDATE_CAP = 2000;

/**
 * Asset ids whose discovery-projected hostname matches every term (substring,
 * case-insensitive), restricted to assets carrying a hostname pin — an
 * unpinned asset's discovered name IS `Asset.hostname`, which the caller's
 * ordinary column filter already covers.
 *
 * Returns id → projected hostname so a caller can say WHY the row matched
 * (the global search puts it in the hit subtitle).
 */
export async function findAssetIdsByDiscoveredHostname(
  terms: string[],
): Promise<Map<string, string>> {
  const cleaned = terms.map((t) => t.trim()).filter(Boolean);
  if (cleaned.length === 0) return new Map();

  const blobWhere = Prisma.join(
    cleaned.map((t) => Prisma.sql`s.observed::text ILIKE ${`%${t}%`}`),
    " AND ",
  );
  const candidates = await prisma.$queryRaw<{ assetId: string }[]>`
    SELECT DISTINCT s."assetId"
    FROM asset_sources s
    JOIN assets a ON a.id = s."assetId"
    WHERE a."hostnameOverride" IS NOT NULL AND ${blobWhere}
    LIMIT ${DISCOVERED_CANDIDATE_CAP}
  `;
  if (candidates.length === 0) return new Map();

  const projected = await getDiscoveredHostnames(candidates.map((c) => c.assetId));
  return matchProjectedHostnames(projected, cleaned);
}

/**
 * Pure core of step 2: keep the ids whose projected hostname contains every
 * term (case-insensitive substring), dropping the ids the SQL narrow matched on
 * some other field of the blob. A null projection is never a match — there is
 * no discovered name to have matched.
 */
export function matchProjectedHostnames(
  projected: Map<string, string | null>,
  terms: string[],
): Map<string, string> {
  const needles = terms.map((t) => t.trim().toLowerCase()).filter(Boolean);
  const out = new Map<string, string>();
  if (needles.length === 0) return out;
  for (const [assetId, hostname] of projected) {
    if (!hostname) continue;
    const hay = hostname.toLowerCase();
    if (needles.every((n) => hay.includes(n))) out.set(assetId, hostname);
  }
  return out;
}
