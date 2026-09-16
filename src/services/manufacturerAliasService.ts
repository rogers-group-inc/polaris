/**
 * src/services/manufacturerAliasService.ts
 *
 * CRUD + caching for the ManufacturerAlias table. The actual sync normalizer
 * lives in src/utils/manufacturerNormalize.ts so that the Prisma extension in
 * db.ts can import it without creating a cycle through this service.
 *
 * Lifecycle:
 *   1. On app startup, seedDefaultAliases() inserts a baseline of common
 *      IEEE-registered → marketing-name mappings (idempotent — safe to call
 *      on every boot; existing rows are not overwritten).
 *   2. refreshAliasCache() loads all rows into the in-memory map exposed by
 *      the normalize util. Called once at startup and after every mutation.
 *   3. applyAliasesToExistingRows() walks Asset.manufacturer and
 *      MibFile.manufacturer, rewriting any value the cache canonicalizes to
 *      something different. Run once at startup and after each CRUD mutation
 *      so admin edits to the alias map propagate to existing data.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { setAliasMap, normalizeManufacturer } from "../utils/manufacturerNormalize.js";
import { logger } from "../utils/logger.js";

export interface ManufacturerAliasRow {
  id: string;
  alias: string;
  canonical: string;
  createdAt: Date;
  updatedAt: Date;
}

// Seed list — common IEEE legal names → marketing names. Admins can add to or
// override this list at runtime; the seed only fills in the gap for fresh
// installs and never overwrites existing rows.
export const DEFAULT_ALIASES: ReadonlyArray<{ alias: string; canonical: string }> = [
  // Fortinet
  { alias: "Fortinet, Inc.",                          canonical: "Fortinet" },
  { alias: "Fortinet Inc.",                           canonical: "Fortinet" },
  { alias: "Fortinet Inc",                            canonical: "Fortinet" },
  // Cisco
  { alias: "Cisco Systems, Inc.",                     canonical: "Cisco" },
  { alias: "Cisco Systems Inc",                       canonical: "Cisco" },
  { alias: "Cisco Systems",                           canonical: "Cisco" },
  { alias: "Cisco Meraki",                            canonical: "Cisco" },
  // Juniper
  { alias: "Juniper Networks, Inc.",                  canonical: "Juniper" },
  { alias: "Juniper Networks Inc",                    canonical: "Juniper" },
  { alias: "Juniper Networks",                        canonical: "Juniper" },
  // HPE / HP / Aruba
  { alias: "Hewlett Packard Enterprise",              canonical: "HPE" },
  { alias: "HPE",                                     canonical: "HPE" },
  { alias: "Hewlett-Packard Company",                 canonical: "HP" },
  { alias: "Hewlett Packard",                         canonical: "HP" },
  { alias: "HP Inc.",                                 canonical: "HP" },
  { alias: "HP Inc",                                  canonical: "HP" },
  { alias: "Aruba, a Hewlett Packard Enterprise company", canonical: "Aruba" },
  { alias: "Aruba Networks",                          canonical: "Aruba" },
  // Mikrotik
  { alias: "MikroTikls SIA",                          canonical: "MikroTik" },
  { alias: "Mikrotikls SIA",                          canonical: "MikroTik" },
  { alias: "Mikrotik",                                canonical: "MikroTik" },
  // Microsoft
  { alias: "Microsoft Corporation",                   canonical: "Microsoft" },
  { alias: "Microsoft Corp.",                         canonical: "Microsoft" },
  // Dell
  { alias: "Dell Inc.",                               canonical: "Dell" },
  { alias: "Dell Inc",                                canonical: "Dell" },
  { alias: "Dell Computer Corp.",                     canonical: "Dell" },
  { alias: "Dell Technologies, Inc.",                 canonical: "Dell" },
  { alias: "Dell EMC",                                canonical: "Dell" },
  // Palo Alto
  { alias: "Palo Alto Networks",                      canonical: "Palo Alto" },
  { alias: "Palo Alto Networks, Inc.",                canonical: "Palo Alto" },
  // Arista
  { alias: "Arista Networks, Inc.",                   canonical: "Arista" },
  { alias: "Arista Networks",                         canonical: "Arista" },
  // VMware
  { alias: "VMware, Inc.",                            canonical: "VMware" },
  { alias: "VMware Inc",                              canonical: "VMware" },
  // Apple
  { alias: "Apple, Inc.",                             canonical: "Apple" },
  { alias: "Apple Inc.",                              canonical: "Apple" },
  // Lenovo
  { alias: "Lenovo Group Ltd.",                       canonical: "Lenovo" },
  { alias: "LENOVO",                                  canonical: "Lenovo" },
  // Ubiquiti
  { alias: "Ubiquiti Networks Inc.",                  canonical: "Ubiquiti" },
  { alias: "Ubiquiti Networks",                       canonical: "Ubiquiti" },
  { alias: "Ubiquiti Inc.",                           canonical: "Ubiquiti" },
  // Netgear
  { alias: "NETGEAR",                                 canonical: "Netgear" },
  { alias: "Netgear, Inc.",                           canonical: "Netgear" },
  // Brocade / Extreme / Ruckus
  { alias: "Brocade Communications Systems, Inc.",    canonical: "Brocade" },
  { alias: "Extreme Networks, Inc.",                  canonical: "Extreme Networks" },
  { alias: "Ruckus Wireless",                         canonical: "Ruckus" },
  { alias: "Ruckus Networks",                         canonical: "Ruckus" },
];

// ─── CRUD ──────────────────────────────────────────────────────────────────

export async function listAliases(): Promise<ManufacturerAliasRow[]> {
  return prisma.manufacturerAlias.findMany({
    orderBy: [{ canonical: "asc" }, { alias: "asc" }],
  });
}

export async function createAlias(input: {
  alias: string;
  canonical: string;
}): Promise<ManufacturerAliasRow> {
  const alias = input.alias.trim().toLowerCase();
  const canonical = input.canonical.trim();
  if (!alias) throw new AppError(400, "alias is required");
  if (!canonical) throw new AppError(400, "canonical is required");
  if (alias === canonical.toLowerCase()) {
    throw new AppError(400, "alias and canonical cannot be the same string");
  }
  const existing = await prisma.manufacturerAlias.findUnique({ where: { alias } });
  if (existing) {
    throw new AppError(409, `An alias for "${input.alias}" already exists`);
  }
  const row = await prisma.manufacturerAlias.create({ data: { alias, canonical } });
  await refreshAliasCache();
  applyAliasesToExistingRows().catch((err) =>
    logger.error({ err }, "manufacturerAlias backfill failed after create"),
  );
  return row;
}

export async function updateAlias(
  id: string,
  input: { alias?: string; canonical?: string },
): Promise<ManufacturerAliasRow> {
  const data: { alias?: string; canonical?: string } = {};
  if (typeof input.alias === "string") {
    const trimmed = input.alias.trim().toLowerCase();
    if (!trimmed) throw new AppError(400, "alias cannot be empty");
    data.alias = trimmed;
  }
  if (typeof input.canonical === "string") {
    const trimmed = input.canonical.trim();
    if (!trimmed) throw new AppError(400, "canonical cannot be empty");
    data.canonical = trimmed;
  }
  if (data.alias && data.canonical && data.alias === data.canonical.toLowerCase()) {
    throw new AppError(400, "alias and canonical cannot be the same string");
  }
  let row: ManufacturerAliasRow;
  try {
    row = await prisma.manufacturerAlias.update({ where: { id }, data });
  } catch {
    throw new AppError(404, "Alias not found");
  }
  await refreshAliasCache();
  applyAliasesToExistingRows().catch((err) =>
    logger.error({ err }, "manufacturerAlias backfill failed after update"),
  );
  return row;
}

export async function deleteAlias(id: string): Promise<void> {
  try {
    await prisma.manufacturerAlias.delete({ where: { id } });
  } catch {
    throw new AppError(404, "Alias not found");
  }
  await refreshAliasCache();
  // No backfill on delete — removing an alias does not change the canonical
  // form of any existing row (the row already holds the canonical value).
}

// ─── Cache + lifecycle ─────────────────────────────────────────────────────

export async function refreshAliasCache(): Promise<void> {
  const rows = await prisma.manufacturerAlias.findMany({
    select: { alias: true, canonical: true },
  });
  setAliasMap(rows.map((r) => [r.alias, r.canonical] as [string, string]));
}

export async function seedDefaultAliases(): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const entry of DEFAULT_ALIASES) {
    const alias = entry.alias.trim().toLowerCase();
    const canonical = entry.canonical.trim();
    if (!alias || !canonical) continue;
    try {
      const existing = await prisma.manufacturerAlias.findUnique({ where: { alias } });
      if (existing) continue;
      await prisma.manufacturerAlias.create({ data: { alias, canonical } });
      inserted++;
    } catch (err) {
      logger.warn({ err, alias }, "Failed to seed manufacturer alias");
    }
  }
  return { inserted };
}

/**
 * Walk Asset.manufacturer and MibFile.manufacturer, rewriting any value that
 * the alias map canonicalizes to something different. Idempotent: rows already
 * matching their normalized form are left alone. Returns counts of rewritten
 * rows for logging.
 */
export async function applyAliasesToExistingRows(): Promise<{
  assets: number;
  mibs: number;
}> {
  let assetCount = 0;
  let mibCount = 0;

  // Assets — fetch only rows with a non-null manufacturer, group by raw value
  // so we issue one updateMany per (raw → canonical) bucket.
  const assetRaws = await prisma.asset.findMany({
    where: { manufacturer: { not: null } },
    select: { manufacturer: true },
    distinct: ["manufacturer"],
  });
  for (const r of assetRaws) {
    if (!r.manufacturer) continue;
    const canonical = normalizeManufacturer(r.manufacturer);
    if (canonical && canonical !== r.manufacturer) {
      const result = await prisma.asset.updateMany({
        where: { manufacturer: r.manufacturer },
        data: { manufacturer: canonical },
      });
      assetCount += result.count;
    }
  }

  // MibFiles — same pattern. Watch out for the unique constraint on
  // (manufacturer, model, moduleName): if two existing rows would collapse
  // to the same canonical form we can't blindly updateMany. Update rows one
  // at a time and skip duplicates with a warning.
  const mibRaws = await prisma.mibFile.findMany({
    where: { manufacturer: { not: null } },
    select: { id: true, manufacturer: true, model: true, moduleName: true },
  });
  for (const r of mibRaws) {
    if (!r.manufacturer) continue;
    const canonical = normalizeManufacturer(r.manufacturer);
    if (!canonical || canonical === r.manufacturer) continue;
    try {
      await prisma.mibFile.update({
        where: { id: r.id },
        data: { manufacturer: canonical },
      });
      mibCount++;
    } catch (err) {
      logger.warn(
        { err, mibId: r.id, from: r.manufacturer, to: canonical, model: r.model, moduleName: r.moduleName },
        "Could not normalize MIB manufacturer (likely duplicate after collapse — delete one row by hand)",
      );
    }
  }

  return { assets: assetCount, mibs: mibCount };
}
