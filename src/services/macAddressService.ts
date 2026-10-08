/**
 * src/services/macAddressService.ts — AssetMacAddress side-table writers.
 *
 * The two reconcilers moved here from utils/macAddresses (2026-08 audit):
 * utils are pure helpers, services own DB writes. The pure MAC surface
 * (shapeMacRows, foldMacsToRanges, expandMacRange, buildMacRowsForCreate,
 * MAC_ROW_SELECT, the MacJsonEntry/MacRow shapes) stays in utils/macAddresses
 * — see that header for the table's ownership model.
 */

import { prisma } from "../db.js";
import { retryOnDeadlock } from "../utils/dbRetry.js";
import { isAllZeroMac } from "../utils/mac.js";
import {
  INTERFACE_MAC_SOURCE,
  foldMacsToRanges,
  macToInt,
  intToMac,
  type MacJsonEntry,
  type MacRangeEntry,
} from "../utils/macAddresses.js";

/**
 * Sync an in-memory MAC list (the legacy JSON shape) back to the side
 * table for one asset. Used at end of any flow that previously did
 * `data.macAddresses = macList` on an asset.update.
 *
 *   - Rows in the side table that are NOT in `macs` get deleted
 *   - Each entry in `macs` is upserted (insert if missing, update metadata
 *     if present) via a single bulk INSERT ... ON CONFLICT statement
 *
 * Two round-trips total per call (delete + bulk upsert). The original
 * implementation wrapped a deleteMany + N per-row upserts in a
 * `$transaction` — for an asset with 50 MACs that meant 51 sequential
 * statements inside one transaction, easily exceeding Prisma's 5-second
 * default timeout once batchSettled was running ~50 reconciles in
 * parallel and the connection pool started backing up. The bulk SQL form
 * collapses N upserts into one statement; no transaction overhead, no
 * pool contention.
 *
 * Trade-off: there's a brief window between the delete and the upsert
 * where a concurrent reader could see a partial set. Acceptable for
 * monitor-source MAC data — discovery doesn't read its own write mid-
 * pass, and external readers (asset details panel, quarantine push) are
 * not running during a discovery sync.
 */
export async function reconcileMacAddresses(
  assetId: string,
  macs: readonly MacJsonEntry[],
): Promise<void> {
  // Interface-fold rows (source="monitor-interface", the only rows that can
  // carry a macEnd range) are owned by `reconcileInterfaceMacs` — drop them
  // from the input (discovery hydrates them into its in-memory list) and
  // scope every delete below away from them, so a discovery reconcile can
  // neither churn a range row through its single-MAC upsert nor delete one.
  //
  // Sort by mac asc so concurrent reconciles for different assets acquire
  // index-page locks in a deterministic order — significantly cuts the
  // deadlock rate Postgres reports on the secondary `mac` index pages
  // when batchSettled runs ~50 reconciles in parallel during a discovery
  // sync. Sort is in-place safe because we built the array from a copy.
  //
  // The all-zero MAC is dropped like an empty one: it is "no MAC", and since
  // the delete below removes every row not in the new set, a zero row stored
  // before this filter existed is cleaned up on the asset's next reconcile.
  const newMacs = macs
    .filter((m) => !!m.mac && !isAllZeroMac(m.mac) && m.source !== INTERFACE_MAC_SOURCE)
    .slice()
    .sort((a, b) => (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0));

  // Empty list = wipe all non-interface-fold MAC rows for this asset.
  if (newMacs.length === 0) {
    await retryOnDeadlock(() =>
      prisma.assetMacAddress.deleteMany({
        where: { assetId, source: { not: INTERFACE_MAC_SOURCE } },
      }),
    );
    return;
  }

  // Delete any existing rows whose mac isn't in the new set. One statement
  // regardless of row count.
  await retryOnDeadlock(() =>
    prisma.assetMacAddress.deleteMany({
      where: {
        assetId,
        source: { not: INTERFACE_MAC_SOURCE },
        mac: { notIn: newMacs.map((m) => m.mac) },
      },
    }),
  );

  // Bulk upsert via INSERT ... ON CONFLICT. Build a flat parameter list and
  // parallel VALUES tuples; the (assetId, mac) unique index drives the
  // upsert path. id uses gen_random_uuid() (Postgres 13+ built-in) so we
  // don't have to round-trip per row to generate UUIDs in JS.
  const params: unknown[] = [];
  const tuples: string[] = [];
  let p = 1;
  for (const m of newMacs) {
    const lastSeen = m.lastSeen ? new Date(m.lastSeen).toISOString() : new Date().toISOString();
    tuples.push(
      `(gen_random_uuid()::text, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::timestamp, $${p++}::timestamp)`,
    );
    params.push(
      assetId,
      m.mac,
      m.source || "unknown",
      m.device ?? null,
      m.subnetCidr ?? null,
      m.subnetName ?? null,
      lastSeen,
      lastSeen,
    );
  }
  // On conflict, "macEnd" = NULL: discovery rows are always single-MAC. The
  // only way this fires against a range row is a discovery sighting of the
  // range's start MAC — the range coherently collapses to that single MAC
  // under the discovery source, and the next interface scrape re-adds the
  // remainder of the range starting one past it (see reconcileInterfaceMacs'
  // occupied-key adjustment).
  const sql =
    `INSERT INTO "asset_mac_addresses" ("id", "assetId", "mac", "source", "device", "subnetCidr", "subnetName", "lastSeen", "firstSeen") ` +
    `VALUES ${tuples.join(", ")} ` +
    `ON CONFLICT ("assetId", "mac") DO UPDATE SET ` +
    `  "macEnd" = NULL, ` +
    `  "source" = EXCLUDED."source", ` +
    `  "device" = EXCLUDED."device", ` +
    `  "subnetCidr" = EXCLUDED."subnetCidr", ` +
    `  "subnetName" = EXCLUDED."subnetName", ` +
    `  "lastSeen" = EXCLUDED."lastSeen"`;
  await retryOnDeadlock(() => prisma.$executeRawUnsafe(sql, ...params));
}

/**
 * Reconcile the asset's interface-derived MAC rows (source =
 * "monitor-interface") to the given scraped interface MAC list, folding
 * contiguous MACs into range rows. Full-replace scoped to that source only —
 * rows owned by discovery / agent / manual writers are never touched, and
 * `reconcileMacAddresses` symmetrically never touches ours.
 *
 * Cross-source overlap policy: when another source already holds a row at a
 * would-be range's start key (common — a DHCP-discovered primary MAC is
 * usually the first interface MAC), the range is written starting one past
 * the occupied key instead of fighting over the row. The occupied row keeps
 * its richer discovery metadata and still represents that MAC; search finds
 * it either way. Interior/end overlaps don't collide (the unique key is the
 * range START) and are left as harmless duplicates.
 *
 * Callers pass the FULL interface MAC list each scrape (both collection
 * paths — the system-info scrape and the agent interfaces push — report the
 * complete table), so interfaces that disappear age out via the scoped
 * delete. Three statements per call (read + delete + bulk upsert); no-op
 * write when the scrape has no valid MACs and no stale rows exist.
 */
export async function reconcileInterfaceMacs(
  assetId: string,
  macs: ReadonlyArray<string | null | undefined>,
  now: Date = new Date(),
): Promise<void> {
  const folded = foldMacsToRanges(macs);

  if (folded.length === 0) {
    await retryOnDeadlock(() =>
      prisma.assetMacAddress.deleteMany({
        where: { assetId, source: INTERFACE_MAC_SOURCE },
      }),
    );
    return;
  }

  const existing = await prisma.assetMacAddress.findMany({
    where: { assetId },
    select: { mac: true, source: true },
  });
  const occupied = new Set(
    existing.filter((r) => r.source !== INTERFACE_MAC_SOURCE).map((r) => r.mac),
  );

  // Slide each entry's start past keys held by other sources (see overlap
  // policy above). An entry fully covered by other-source rows is dropped.
  const desired: MacRangeEntry[] = [];
  for (const entry of folded) {
    let s = macToInt(entry.mac);
    const e = entry.macEnd ? macToInt(entry.macEnd) : s;
    while (s <= e && occupied.has(intToMac(s))) s++;
    if (s > e) continue;
    desired.push({ mac: intToMac(s), macEnd: s === e ? null : intToMac(e) });
  }

  if (desired.length === 0) {
    await retryOnDeadlock(() =>
      prisma.assetMacAddress.deleteMany({
        where: { assetId, source: INTERFACE_MAC_SOURCE },
      }),
    );
    return;
  }

  await retryOnDeadlock(() =>
    prisma.assetMacAddress.deleteMany({
      where: {
        assetId,
        source: INTERFACE_MAC_SOURCE,
        mac: { notIn: desired.map((d) => d.mac) },
      },
    }),
  );

  const nowIso = now.toISOString();
  const params: unknown[] = [];
  const tuples: string[] = [];
  let p = 1;
  for (const d of desired) {
    tuples.push(
      `(gen_random_uuid()::text, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::timestamp, $${p++}::timestamp)`,
    );
    params.push(assetId, d.mac, d.macEnd, INTERFACE_MAC_SOURCE, nowIso, nowIso);
  }
  // Conflicts only hit our own rows (other-source keys were slid past above,
  // modulo a benign race with a concurrent discovery insert); firstSeen is
  // not in the SET list so it survives across scrapes.
  const sql =
    `INSERT INTO "asset_mac_addresses" ("id", "assetId", "mac", "macEnd", "source", "lastSeen", "firstSeen") ` +
    `VALUES ${tuples.join(", ")} ` +
    `ON CONFLICT ("assetId", "mac") DO UPDATE SET ` +
    `  "macEnd" = EXCLUDED."macEnd", ` +
    `  "source" = EXCLUDED."source", ` +
    `  "lastSeen" = EXCLUDED."lastSeen"`;
  await retryOnDeadlock(() => prisma.$executeRawUnsafe(sql, ...params));
}
