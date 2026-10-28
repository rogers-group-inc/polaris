/**
 * src/services/interfaceTagService.ts
 *
 * Tags on individual interfaces (business rule 133) — the READ that decorates
 * the Interfaces table and the interface slide-over, and the operator's WRITE
 * of the hand-applied set on one port.
 *
 * Storage is AssetInterfaceTag, keyed (assetId, ifName, tag) rather than hung
 * off an AssetInterface row, because that table is delete-replaced on every full
 * scrape. Two writers share it, told apart by `source`:
 *   - "manual" — this service. The operator's set for one port.
 *   - "auto"   — tagAssignmentService, for a tag whose auto-assign filter
 *                asserts a native VLAN. Never written here, except that a
 *                manual save naming a tag the engine applied converts that row
 *                to manual, so the operator's choice survives the filter.
 *   - "network" — networkTagInheritanceService (business rule 137), a tag on a
 *                network the port carries. Read-only and converted the same way.
 *
 * A manual save replaces the MANUAL set only. Auto rows are shown read-only
 * beside it: the way to take an auto tag off a port is the tag's filter, the
 * same as for a device.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { isAzureTag, normalizeTags, REGION_TAG_PREFIX } from "../utils/tagNormalize.js";
import { logEvent } from "./eventLogService.js";

/** One tag as an interface row carries it to the browser. */
export interface InterfaceTagView {
  name: string;
  /** The registry colour, or null for a name with no registry row. */
  color: string | null;
  /** Applied by Polaris, not by hand (read-only in the editor). */
  auto: boolean;
  /** Who applied an auto tag: a tag's auto-assign filter (rule 133), or a
   *  network this port carries (rule 137). Absent on a manual tag. */
  via?: "filter" | "network";
}

/**
 * Every tag on every interface of one asset, keyed by ifName, each list sorted
 * manual-first then by name. Two indexed reads: the asset's rows, then the
 * registry colours for just the names they use.
 */
export async function listInterfaceTags(assetId: string): Promise<Map<string, InterfaceTagView[]>> {
  const rows = await prisma.assetInterfaceTag.findMany({
    where: { assetId },
    select: { ifName: true, tag: true, source: true },
  });
  const out = new Map<string, InterfaceTagView[]>();
  if (rows.length === 0) return out;
  const names = [...new Set(rows.map((r) => r.tag))];
  const registry = await prisma.tag.findMany({
    where: { name: { in: names } },
    select: { name: true, color: true },
  });
  const colorOf = new Map(registry.map((t) => [t.name, t.color]));
  for (const r of rows) {
    const list = out.get(r.ifName) ?? [];
    const via = r.source === "network" ? "network" : r.source === "auto" ? "filter" : undefined;
    list.push({ name: r.tag, color: colorOf.get(r.tag) ?? null, auto: via !== undefined, ...(via ? { via } : {}) });
    out.set(r.ifName, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => (a.auto === b.auto ? a.name.localeCompare(b.name) : a.auto ? 1 : -1));
  }
  return out;
}

/**
 * The names an operator may hand-apply to a port. `region:` and `azure:` are
 * owned by the Device Map and the Azure Arc sync, which tag DEVICES; neither
 * means anything on a port, and neither engine would ever remove one there.
 */
export function normalizeInterfaceTags(input: unknown): string[] {
  const tags = normalizeTags(input, "interface tag");
  for (const t of tags) {
    if (t.toLowerCase().startsWith(REGION_TAG_PREFIX) || isAzureTag(t)) {
      throw new AppError(400, `"${t}" belongs to a system-managed tag namespace and cannot be applied to an interface`);
    }
  }
  return tags;
}

/**
 * Replace the hand-applied tags on one port. Returns the port's full list
 * afterwards (manual + auto), in the read's shape.
 *
 * Diffed, not delete-all-then-insert: a manual row the save keeps keeps its
 * createdAt, and an AUTO row is only ever touched when the operator names its
 * tag, which converts it to manual (the filter no longer owns it).
 */
export async function setInterfaceTags(
  assetId: string,
  ifName: string,
  input: unknown,
  actor: string | undefined,
): Promise<InterfaceTagView[]> {
  const wanted = normalizeInterfaceTags(input);
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { id: true, hostname: true, ipAddress: true },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  const port = await prisma.assetInterface.findUnique({
    where: { assetId_ifName: { assetId, ifName } },
    select: { ifName: true },
  });
  const existing = await prisma.assetInterfaceTag.findMany({
    where: { assetId, ifName },
    select: { tag: true, source: true },
  });
  // A port that has dropped out of the inventory may still hold tags (that is
  // the point of keying by name), so an edit is refused only for a port that
  // is neither listed nor tagged — a typo in the path, not a real interface.
  if (!port && existing.length === 0) throw new AppError(404, "Interface not found");

  const wantedSet = new Set(wanted);
  const manual = existing.filter((r) => r.source === "manual").map((r) => r.tag);
  // A filter's row or a network's (rule 137): naming either keeps it by hand.
  const autoNames = new Set(existing.filter((r) => r.source !== "manual").map((r) => r.tag));
  const toRemove = manual.filter((t) => !wantedSet.has(t));
  const toConvert = wanted.filter((t) => autoNames.has(t));
  const toCreate = wanted.filter((t) => !autoNames.has(t) && !manual.includes(t));

  if (toRemove.length || toConvert.length || toCreate.length) {
    await prisma.$transaction([
      prisma.assetInterfaceTag.deleteMany({ where: { assetId, ifName, source: "manual", tag: { in: toRemove } } }),
      prisma.assetInterfaceTag.updateMany({
        where: { assetId, ifName, tag: { in: toConvert } },
        data: { source: "manual", tagId: null },
      }),
      prisma.assetInterfaceTag.createMany({
        data: toCreate.map((tag) => ({ assetId, ifName, tag, source: "manual" })),
        skipDuplicates: true,
      }),
    ]);
    const label = asset.hostname || asset.ipAddress || assetId;
    await logEvent({
      action: "asset.interface.tags_updated",
      resourceType: "asset",
      resourceId: assetId,
      resourceName: label,
      actor,
      level: "info",
      message: `Updated interface tags on ${label} / ${ifName}`,
      details: { ifName, added: [...toCreate, ...toConvert], removed: toRemove },
    });
  }

  return (await listInterfaceTags(assetId)).get(ifName) ?? [];
}
