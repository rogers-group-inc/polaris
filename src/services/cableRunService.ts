/**
 * src/services/cableRunService.ts — device connections routed through ArcGIS
 * lines on a Device Map site's Topology views (business rule 188(a)).
 *
 * The lines themselves live in ArcGIS and are only read (rule 188,
 * arcgisLayerService). What Polaris keeps is which lines each connection
 * rides: `CableRunLink` rows, one per (site, link path key), whose `runIds`
 * are ordered feature references `<layerId>/<featureId>` — the configured
 * layer's id and the value of its identity field (GlobalID where the layer
 * has one, so an edit in ArcGIS keeps the reference).
 *
 * A reference to a layer no longer configured is dropped on save; a feature
 * that vanished from ArcGIS is not checked here (that would be a round trip
 * per save) — the canvas draws that connection straight and says so.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEventsBatch } from "./eventLogService.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { ArcgisLayersConfig } from "./arcgisLayerService.js";

/** A link's Topology path key: `<kind>|<source>|<target>` plus an optional `#n`. */
const PATH_KEY_RE = /^[^|\x00-\x1f]{1,80}\|[^|\x00-\x1f]{1,200}\|[^|\x00-\x1f]{1,200}$/;
/** A feature reference: `<layer uuid>/<identity value>`. */
export const FEATURE_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^\s/|\x00-\x1f]{1,80}$/i;
const MAX_LINK_CHANGES = 500;
/** How many lines one link may ride. */
export const MAX_RUNS_PER_LINK = 20;

async function assertSite(siteId: string): Promise<string> {
  const site = await prisma.asset.findUnique({ where: { id: siteId }, select: { assetType: true, hostname: true } });
  if (!site || site.assetType !== "firewall") throw new AppError(404, "Site not found");
  return site.hostname ?? siteId;
}

/** The ids of every ArcGIS line layer configured on an enabled integration. */
async function lineLayerIds(): Promise<Set<string>> {
  const rows = await prisma.integration.findMany({ where: { type: "arcgis", enabled: true }, select: { config: true } });
  const out = new Set<string>();
  for (const r of rows) {
    for (const l of ((r.config ?? {}) as ArcgisLayersConfig).layers ?? []) if (l.geometry === "line") out.add(l.id.toLowerCase());
  }
  return out;
}

/** The site's routed links: path key → ordered feature references. */
export async function listRunLinks(siteId: string): Promise<Record<string, string[]>> {
  const rows = await prisma.cableRunLink.findMany({ where: { siteId }, select: { pathKey: true, runIds: true } });
  const out: Record<string, string[]> = {};
  for (const r of rows) if (r.runIds.length) out[r.pathKey] = r.runIds;
  return out;
}

/**
 * Set which ArcGIS lines some links ride: `{ pathKey: refs }`, an empty list
 * making the link straight again. A malformed key or reference is refused
 * (400); a reference to a layer that is not a configured line layer is
 * dropped. One Event for the batch.
 */
export async function applyRunLinkEdits(
  siteId: string,
  changes: Record<string, string[]>,
  actor: string,
): Promise<Record<string, string[]>> {
  const siteName = await assertSite(siteId);
  const keys = Object.keys(changes);
  if (keys.length > MAX_LINK_CHANGES) throw new AppError(400, `At most ${MAX_LINK_CHANGES} link changes at once`);
  if (keys.length === 0) return listRunLinks(siteId);
  for (const k of keys) {
    if (!PATH_KEY_RE.test(k)) throw new AppError(400, `Not a link key: ${k.slice(0, 60)}`);
    if (!Array.isArray(changes[k]) || changes[k].length > MAX_RUNS_PER_LINK) {
      throw new AppError(400, `A link rides at most ${MAX_RUNS_PER_LINK} lines`);
    }
    for (const ref of changes[k]) {
      if (typeof ref !== "string" || !FEATURE_REF_RE.test(ref)) throw new AppError(400, `Not an ArcGIS line reference: ${String(ref).slice(0, 60)}`);
    }
  }
  const layers = await lineLayerIds();

  const before = await prisma.cableRunLink.findMany({
    where: { siteId, pathKey: { in: keys } }, select: { pathKey: true, runIds: true },
  });
  const prev = new Map(before.map((b) => [b.pathKey, b.runIds]));
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  const routed: string[] = [];
  const straightened: string[] = [];
  for (const k of keys) {
    const refs = Array.from(new Set(changes[k])).filter((ref) => layers.has(ref.slice(0, ref.indexOf("/")).toLowerCase()));
    const old = prev.get(k) ?? [];
    if (JSON.stringify(old) === JSON.stringify(refs)) continue;
    if (refs.length) {
      ops.push(prisma.cableRunLink.upsert({
        where: { siteId_pathKey: { siteId, pathKey: k } },
        create: { siteId, pathKey: k, runIds: refs, updatedBy: actor },
        update: { runIds: refs, updatedBy: actor },
      }));
      routed.push(k);
    } else if (prev.has(k)) {
      ops.push(prisma.cableRunLink.delete({ where: { siteId_pathKey: { siteId, pathKey: k } } }));
      straightened.push(k);
    }
  }
  if (ops.length) {
    await prisma.$transaction(ops);
    await logEventsBatch([{
      action: "cable_run_link.updated", resourceType: "asset", resourceId: siteId, resourceName: siteName, actor,
      message: `Connections routed through ArcGIS lines at ${siteName}: ${routed.length} routed, ${straightened.length} made straight`,
      details: { routed, straightened },
    }]);
  }
  return listRunLinks(siteId);
}
