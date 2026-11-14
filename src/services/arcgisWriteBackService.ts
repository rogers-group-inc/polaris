/**
 * src/services/arcgisWriteBackService.ts — cable runs written one way to an
 * ArcGIS feature layer (business rule 185).
 *
 * An `arcgis` integration with write-back on names ONE polyline feature layer:
 * an existing layer with a field map (Polaris attribute → layer field, plus a
 * value map onto coded-value domains), or a layer Polaris created with its own
 * fields. Runs drawn, edited or deleted in Polaris are pushed there; nothing
 * is ever read back, and an edit made in ArcGIS is overwritten by the next
 * change in Polaris. Only one integration writes runs at a time.
 *
 * The queue is the `cable_runs` table itself (rule 184's sync columns):
 *   - write-back on → every live run still `off` becomes `pending`;
 *   - a run edited after it was sent is `pending` again (cableRunService);
 *   - a run deleted after it was sent is a tombstone (`deletedAt`), deleted
 *     from the layer here and then from the table.
 * `syncWriteBack` drains it in batches of ≤ 100 `applyEdits` operations. An add
 * is preceded by a query on the Polaris-ID field, so a run whose add succeeded
 * but whose answer was lost is UPDATED next time rather than added twice. A
 * per-feature error (a field too long, a value outside a domain) marks that run
 * `failed` with ArcGIS's message; a transport or server error leaves the batch
 * `pending` for the next tick. A run edited while its push was in flight keeps
 * `pending` (its `version` moved). Only one process pushes at a time (a
 * session advisory lock on a side connection).
 *
 * Geometry goes out as WGS84 (`spatialReference: 4326`) paths, with z when the
 * layer is z-enabled (the elevation a survey import carries), without it
 * otherwise.
 */

import pg from "pg";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { isBlockedOutboundHost } from "../utils/netGuard.js";
import { getDirectDatabaseUrl } from "../utils/dbConnections.js";
import { logEvent } from "./eventLogService.js";
import { ArcgisError, arcgisRequest, clearArcgisTokenCache, getArcgisToken, portalBase, type ArcgisConfig } from "./arcgisService.js";
import { CABLE_MEDIA, CABLE_PLACEMENTS, type CablePoint } from "./cableRunService.js";

// ─── Configuration ───────────────────────────────────────────────────────

export const WRITE_BACK_MODES = ["existing", "polaris"] as const;
/** The Polaris attributes a field map can send, in the order the form lists them. */
export const WRITE_BACK_ATTRS = ["polarisId", "name", "medium", "placement", "site", "notes", "lengthM", "updatedAt"] as const;
type WriteBackAttr = (typeof WRITE_BACK_ATTRS)[number];

/** The write-back keys of an `arcgis` integration's config (flat, like the basemap's). */
export interface WriteBackConfig extends ArcgisConfig {
  writeBackEnabled?: boolean;
  writeBackMode?: (typeof WRITE_BACK_MODES)[number];
  featureLayerUrl?: string;
  fieldMap?: Partial<Record<WriteBackAttr, string>>;
  valueMap?: { medium?: Record<string, string | number>; placement?: Record<string, string | number> };
}

/** The fields of a layer Polaris creates, and the field map that goes with it. */
const POLARIS_FIELDS: Array<{ attr: WriteBackAttr; name: string; type: string; alias: string; length?: number }> = [
  { attr: "polarisId", name: "POLARIS_ID", type: "esriFieldTypeString", alias: "Polaris ID", length: 64 },
  { attr: "name",      name: "NAME",       type: "esriFieldTypeString", alias: "Name", length: 120 },
  { attr: "medium",    name: "MEDIUM",     type: "esriFieldTypeString", alias: "Medium", length: 16 },
  { attr: "placement", name: "PLACEMENT",  type: "esriFieldTypeString", alias: "Placement", length: 32 },
  { attr: "site",      name: "SITE",       type: "esriFieldTypeString", alias: "Site", length: 255 },
  { attr: "notes",     name: "NOTES",      type: "esriFieldTypeString", alias: "Notes", length: 2000 },
  { attr: "lengthM",   name: "LENGTH_M",   type: "esriFieldTypeDouble", alias: "Length (m)" },
  { attr: "updatedAt", name: "UPDATED_AT", type: "esriFieldTypeDate",   alias: "Updated in Polaris", length: 8 },
];
export const POLARIS_FIELD_MAP: Record<WriteBackAttr, string> =
  Object.fromEntries(POLARIS_FIELDS.map((f) => [f.attr, f.name])) as Record<WriteBackAttr, string>;

const BATCH = 100;
const MAX_PER_TICK = 1000;
const MAX_ERROR = 500;

/**
 * Why a feature-layer URL cannot be used, or null: https, ending in
 * `/FeatureServer/<layer id>`, no credentials / query / fragment, outside the
 * blocked ranges. A rule-111 destination key: moving it needs the secret again.
 */
export function featureLayerUrlProblem(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return "Enter the feature layer's URL";
  let u: URL;
  try { u = new URL(s); } catch { return "The feature layer URL is not a valid URL"; }
  if (u.protocol !== "https:") return "The feature layer URL must use https";
  if (u.username || u.password) return "Put credentials in the sign-in fields, not in the URL";
  if (u.search || u.hash) return "The feature layer URL takes no query string or fragment";
  if (!/\/FeatureServer\/\d+\/?$/i.test(u.pathname)) return "Give one layer of a feature service, ending in /FeatureServer/<layer number>";
  if (isBlockedOutboundHost(u.hostname)) return "That address is in a blocked range (loopback, link-local or metadata)";
  return null;
}

/** Why a write-back config cannot run, or null (checked at save and before each push). */
export function writeBackConfigProblem(cfg: WriteBackConfig): string | null {
  if (!cfg.writeBackEnabled) return null;
  if ((cfg.authMode ?? "apiKey") === "none") return "Writing to ArcGIS needs a sign-in";
  const urlProblem = featureLayerUrlProblem(cfg.featureLayerUrl ?? "");
  if (urlProblem) return urlProblem;
  if (!cfg.fieldMap?.polarisId) return "Map the Polaris ID to a layer field — it is how Polaris finds its features again";
  return null;
}

// ─── The layer ───────────────────────────────────────────────────────────

interface LayerField {
  name: string;
  type: string;
  alias: string;
  length: number | null;
  editable: boolean;
  codedValues: Array<{ code: string | number; name: string }> | null;
}
export interface LayerInfo {
  name: string;
  geometryType: string;
  hasZ: boolean;
  wkid: number | null;
  objectIdField: string;
  capabilities: string[];
  fields: LayerField[];
}

interface RawLayer {
  name?: string;
  type?: string;
  geometryType?: string;
  hasZ?: boolean;
  objectIdField?: string;
  capabilities?: string;
  extent?: { spatialReference?: { wkid?: number; latestWkid?: number } };
  sourceSpatialReference?: { wkid?: number; latestWkid?: number };
  fields?: Array<{ name?: string; type?: string; alias?: string; length?: number; editable?: boolean; domain?: { type?: string; codedValues?: Array<{ code: string | number; name: string }> } }>;
}

function trimUrl(u: string): string { return u.trim().replace(/\/+$/, ""); }

/** Read a feature layer's description: its geometry, fields, domains and edit capabilities. */
export async function readLayer(cfg: WriteBackConfig): Promise<LayerInfo> {
  const url = trimUrl(cfg.featureLayerUrl ?? "");
  const problem = featureLayerUrlProblem(url);
  if (problem) throw new AppError(400, problem);
  const token = await getArcgisToken(cfg);
  const raw = await arcgisRequest<RawLayer>(cfg, url, { token });
  const fields = (raw.fields ?? []).filter((f) => f.name).map((f) => ({
    name: String(f.name),
    type: String(f.type ?? ""),
    alias: String(f.alias ?? f.name),
    length: typeof f.length === "number" ? f.length : null,
    editable: f.editable !== false && f.type !== "esriFieldTypeOID" && f.type !== "esriFieldTypeGlobalID",
    codedValues: f.domain?.type === "codedValue" && Array.isArray(f.domain.codedValues) ? f.domain.codedValues : null,
  }));
  const oid = raw.objectIdField || fields.find((f) => f.type === "esriFieldTypeOID")?.name || "OBJECTID";
  const sr = raw.sourceSpatialReference ?? raw.extent?.spatialReference;
  return {
    name: String(raw.name ?? ""),
    geometryType: String(raw.geometryType ?? ""),
    hasZ: raw.hasZ === true,
    wkid: sr?.latestWkid ?? sr?.wkid ?? null,
    objectIdField: oid,
    capabilities: String(raw.capabilities ?? "").split(",").map((c) => c.trim()).filter(Boolean),
    fields,
  };
}

/**
 * What stops runs reaching this layer, and what only warns. Problems: not a
 * polyline layer, no Create / Update / Delete, a mapped field the layer lacks
 * or cannot edit. Warnings: no z (elevation dropped), a mapped coded field
 * with a Polaris value left unmapped.
 */
export function layerProblems(info: LayerInfo, cfg: WriteBackConfig): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (info.geometryType !== "esriGeometryPolyline") problems.push(`"${info.name}" holds ${info.geometryType || "no geometry"}, not lines`);
  for (const cap of ["Create", "Update", "Delete"]) {
    if (!info.capabilities.includes(cap) && !info.capabilities.includes("Editing")) problems.push(`The layer does not allow ${cap}`);
  }
  const byName = new Map(info.fields.map((f) => [f.name.toLowerCase(), f]));
  for (const attr of WRITE_BACK_ATTRS) {
    const field = cfg.fieldMap?.[attr];
    if (!field) continue;
    const f = byName.get(field.toLowerCase());
    if (!f) problems.push(`The layer has no field "${field}"`);
    else if (!f.editable) problems.push(`The field "${field}" cannot be edited`);
    else if ((attr === "medium" || attr === "placement") && f.codedValues) {
      const values: readonly string[] = attr === "medium" ? CABLE_MEDIA : CABLE_PLACEMENTS;
      const map = cfg.valueMap?.[attr] ?? {};
      const codes = new Set(f.codedValues.map((c) => String(c.code)));
      const missing = values.filter((v) => !codes.has(String(map[v] ?? v)));
      if (missing.length) warnings.push(`"${field}" has no code for ${missing.join(", ")} — pick one in its value map, or ArcGIS will refuse those runs`);
    }
  }
  if (!info.hasZ) warnings.push("The layer has no z values: elevation from surveyed trenches will not be written");
  if (info.wkid !== null && info.wkid !== 4326) warnings.push(`The layer is in wkid ${info.wkid}; Polaris sends WGS84 (4326) and ArcGIS projects it`);
  return { problems, warnings };
}

// ─── Creating a Polaris layer ────────────────────────────────────────────

/**
 * Create a hosted feature service with one z-enabled polyline layer in the
 * signed-in user's content, with Polaris's own fields. Returns the layer URL
 * and the field map that goes with it. Needs a sign-in allowed to create
 * content (a named user, or an API key whose owner may).
 */
export async function createPolarisLayer(cfg: WriteBackConfig, serviceName: string): Promise<{ featureLayerUrl: string; itemId: string | null; fieldMap: Record<WriteBackAttr, string> }> {
  const name = serviceName.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{2,59}$/.test(name)) {
    throw new AppError(400, "A service name starts with a letter and uses only letters, digits and underscores (3–60)");
  }
  const token = await getArcgisToken(cfg);
  if (!token) throw new AppError(400, "Creating a layer needs a sign-in");
  const sharing = `${portalBase(cfg)}/sharing/rest`;
  const self = await arcgisRequest<{ user?: { username?: string } }>(cfg, `${sharing}/portals/self`, { token });
  const user = self.user?.username;
  if (!user) throw new AppError(400, "This sign-in has no user to own the new layer — use a named user, or an API key whose owner may create content");

  const created = await arcgisRequest<{ serviceurl?: string; encodedServiceURL?: string; itemId?: string; success?: boolean }>(
    cfg, `${sharing}/content/users/${encodeURIComponent(user)}/createService`, {
      method: "POST", token,
      params: {
        outputType: "featureService",
        createParameters: JSON.stringify({
          name, serviceDescription: "Cable runs written by Polaris", hasStaticData: false, maxRecordCount: 2000,
          supportedQueryFormats: "JSON", capabilities: "Create,Delete,Query,Update,Editing",
          spatialReference: { wkid: 4326 }, allowGeometryUpdates: true, units: "esriDecimalDegrees",
        }),
      },
    });
  const serviceUrl = created.encodedServiceURL || created.serviceurl;
  if (!serviceUrl || !/\/rest\/services\//.test(serviceUrl)) throw new ArcgisError("The portal did not return the new service's address");
  const adminUrl = serviceUrl.replace("/rest/services/", "/rest/admin/services/") + "/addToDefinition";
  await arcgisRequest(cfg, adminUrl, {
    method: "POST", token,
    params: {
      addToDefinition: JSON.stringify({
        layers: [{
          id: 0, name: "Cable runs", type: "Feature Layer", geometryType: "esriGeometryPolyline",
          hasZ: true, hasM: false, objectIdField: "OBJECTID", displayField: "NAME",
          capabilities: "Create,Delete,Query,Update,Editing", supportedQueryFormats: "JSON", maxRecordCount: 2000,
          hasAttachments: false, htmlPopupType: "esriServerHTMLPopupTypeNone",
          extent: { xmin: -180, ymin: -90, xmax: 180, ymax: 90, spatialReference: { wkid: 4326 } },
          fields: [
            { name: "OBJECTID", type: "esriFieldTypeOID", alias: "OBJECTID", nullable: false, editable: false },
            ...POLARIS_FIELDS.map((f) => ({ name: f.name, type: f.type, alias: f.alias, nullable: true, editable: true, ...(f.length ? { length: f.length } : {}) })),
          ],
        }],
      }),
    },
  });
  return { featureLayerUrl: `${trimUrl(serviceUrl)}/0`, itemId: created.itemId ?? null, fieldMap: { ...POLARIS_FIELD_MAP } };
}

// ─── Features ────────────────────────────────────────────────────────────

interface RunForPush {
  id: string;
  name: string;
  medium: string;
  placement: string;
  points: unknown;
  notes: string;
  lengthM: number;
  updatedAt: Date;
  version: number;
  arcgisObjectId: number | null;
  deletedAt: Date | null;
  site: { hostname: string | null } | null;
}

/** One run as an ArcGIS feature (attributes by the field map; no object id). */
export function featureFor(run: RunForPush, cfg: WriteBackConfig, info: Pick<LayerInfo, "hasZ">): { attributes: Record<string, unknown>; geometry: Record<string, unknown> } {
  const map = cfg.fieldMap ?? {};
  const value: Record<WriteBackAttr, unknown> = {
    polarisId: run.id,
    name: run.name,
    medium: cfg.valueMap?.medium?.[run.medium] ?? run.medium,
    placement: cfg.valueMap?.placement?.[run.placement] ?? run.placement,
    site: run.site?.hostname ?? null,
    notes: run.notes,
    lengthM: Math.round(run.lengthM * 100) / 100,
    updatedAt: run.updatedAt.getTime(),
  };
  const attributes: Record<string, unknown> = {};
  for (const attr of WRITE_BACK_ATTRS) {
    const field = map[attr];
    if (field) attributes[field] = value[attr];
  }
  const pts = (Array.isArray(run.points) ? run.points : []) as CablePoint[];
  const path = pts.map((p) => (info.hasZ ? [p[0], p[1], typeof p[2] === "number" ? p[2] : 0] : [p[0], p[1]]));
  return {
    attributes,
    geometry: { paths: [path], spatialReference: { wkid: 4326 }, ...(info.hasZ ? { hasZ: true } : {}) },
  };
}

// ─── The integration that writes ─────────────────────────────────────────

/** The one enabled ArcGIS integration with write-back on, if any. */
export async function writeBackIntegration(excludeId?: string): Promise<{ id: string; name: string; config: WriteBackConfig } | null> {
  const rows = await prisma.integration.findMany({
    where: { type: "arcgis", enabled: true, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, name: true, config: true },
  });
  const row = rows.find((r) => (r.config as WriteBackConfig | null)?.writeBackEnabled === true);
  return row ? { id: row.id, name: row.name, config: row.config as WriteBackConfig } : null;
}

/**
 * Write-back stopped (turned off, the layer moved, or the integration was
 * deleted): every run goes back to `off` and forgets its object id (a new
 * layer is a new set of features — the Polaris-ID query finds them again if it
 * is the same one), and tombstones are dropped, leaving their features in the
 * old layer. One Event says how many.
 */
export async function writeBackStopped(reason: string, actor: string): Promise<void> {
  const tombstones = await prisma.cableRun.findMany({ where: { deletedAt: { not: null } }, select: { arcgisObjectId: true } });
  const [reset] = await prisma.$transaction([
    prisma.cableRun.updateMany({
      where: { deletedAt: null, OR: [{ syncStatus: { not: "off" } }, { arcgisObjectId: { not: null } }] },
      data: { syncStatus: "off", syncError: null, arcgisObjectId: null },
    }),
    prisma.cableRun.deleteMany({ where: { deletedAt: { not: null } } }),
  ]);
  if (reset.count || tombstones.length) {
    await logEvent({
      action: "cable_run.write_back_stopped", resourceType: "integration", actor,
      message: `Cable-run write-back stopped (${reason}): ${reset.count} run(s) will be sent again when it restarts` +
        (tombstones.length ? `; ${tombstones.length} deleted run(s) were never removed from the old layer` : ""),
      details: { reason, reset: reset.count, orphanedObjectIds: tombstones.map((t) => t.arcgisObjectId).filter((v) => v !== null).slice(0, 200) },
    });
  }
}

/** Runs by sync state, for the integration's Write-back tab. */
export async function writeBackStatus(): Promise<{ counts: Record<string, number>; lastError: string | null }> {
  const [groups, failed] = await Promise.all([
    prisma.cableRun.groupBy({ by: ["syncStatus"], _count: { _all: true } }),
    prisma.cableRun.findFirst({ where: { syncStatus: "failed" }, orderBy: { updatedAt: "desc" }, select: { syncError: true } }),
  ]);
  const counts: Record<string, number> = { off: 0, pending: 0, synced: 0, failed: 0 };
  for (const g of groups) counts[g.syncStatus] = g._count._all;
  return { counts, lastError: failed?.syncError ?? null };
}

/** Send every failed run again. Returns how many. */
export async function retryFailed(actor: string): Promise<number> {
  const r = await prisma.cableRun.updateMany({ where: { syncStatus: "failed" }, data: { syncStatus: "pending", syncError: null } });
  if (r.count) {
    await logEvent({
      action: "cable_run.write_back_retry", resourceType: "integration", actor,
      message: `${r.count} cable run(s) that ArcGIS refused queued to be sent again`,
    });
  }
  return r.count;
}

// ─── The push ────────────────────────────────────────────────────────────

const LOCK_CLASSID = 0x504c4157; // "PLAW"
const LOCK_OBJID = 1;

/** Run `fn` holding the write-back lock on a side connection; null when another process holds it. */
async function withWriteBackLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const url = getDirectDatabaseUrl();
  if (!url) return fn();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [LOCK_CLASSID, LOCK_OBJID]);
    if (!res.rows[0]?.locked) return null;
    try { return await fn(); } finally {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [LOCK_CLASSID, LOCK_OBJID]);
    }
  } finally {
    await client.end();
  }
}

/** A transport / server / token failure: try again next tick, nothing is wrong with the run. */
function isTransient(err: unknown): boolean {
  if (!(err instanceof ArcgisError)) return true;
  if (err.code === undefined) return true;
  return err.code >= 500 || err.code === 498 || err.code === 499 || err.code === 429;
}

interface EditResult { objectId?: number; success?: boolean; error?: { code?: number; description?: string } | null }

export interface SyncSummary { sent: number; deleted: number; failed: number; skipped?: "off" | "locked" }

const RUN_SELECT = {
  id: true, name: true, medium: true, placement: true, points: true, notes: true, lengthM: true,
  updatedAt: true, version: true, arcgisObjectId: true, deletedAt: true,
  site: { select: { hostname: true } },
} as const;

/**
 * Push every pending run (and tombstone) to the write-back layer. Safe to call
 * from any process at any time: one runs, the rest return `locked`.
 */
export async function syncWriteBack(): Promise<SyncSummary> {
  const intg = await writeBackIntegration();
  if (!intg) return { sent: 0, deleted: 0, failed: 0, skipped: "off" };
  const out = await withWriteBackLock(() => pushPending(intg.config));
  return out ?? { sent: 0, deleted: 0, failed: 0, skipped: "locked" };
}

async function pushPending(cfg: WriteBackConfig): Promise<SyncSummary> {
  const summary: SyncSummary = { sent: 0, deleted: 0, failed: 0 };
  // Every live run joins the queue once write-back is on (runs drawn before it,
  // and runs drawn since — cableRunService creates them `off`).
  await prisma.cableRun.updateMany({ where: { syncStatus: "off", deletedAt: null }, data: { syncStatus: "pending" } });
  const runs = await prisma.cableRun.findMany({
    where: { syncStatus: "pending" }, select: RUN_SELECT, orderBy: { updatedAt: "asc" }, take: MAX_PER_TICK,
  }) as RunForPush[];
  if (!runs.length) return summary;

  const configProblem = writeBackConfigProblem(cfg);
  let info: LayerInfo;
  try {
    if (configProblem) throw new AppError(400, configProblem);
    info = await readLayer(cfg);
    const { problems } = layerProblems(info, cfg);
    if (problems.length) throw new AppError(400, problems.join("; "));
  } catch (err) {
    if (isTransient(err) && !(err instanceof AppError)) { await markPendingError(runs, errText(err)); return summary; }
    // The layer itself refuses: every run says why, until the integration is fixed and retried.
    summary.failed += await markFailed(runs, errText(err));
    return summary;
  }

  const url = trimUrl(cfg.featureLayerUrl!);
  const pidField = cfg.fieldMap!.polarisId!;
  for (let i = 0; i < runs.length; i += BATCH) {
    const batch = runs.slice(i, i + BATCH);
    try {
      await pushBatch(cfg, url, pidField, info, batch, summary);
    } catch (err) {
      if (err instanceof ArcgisError && (err.code === 498 || err.code === 499)) clearArcgisTokenCache();
      if (isTransient(err)) { await markPendingError(batch, errText(err)); continue; }
      summary.failed += await markFailed(batch, errText(err));
    }
  }
  if (summary.sent || summary.deleted || summary.failed) logger.info(summary, "ArcGIS write-back: runs pushed");
  return summary;
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR);
}

async function markPendingError(runs: RunForPush[], message: string): Promise<void> {
  await prisma.cableRun.updateMany({ where: { id: { in: runs.map((r) => r.id) }, syncStatus: "pending" }, data: { syncError: message } });
}
async function markFailed(runs: RunForPush[], message: string): Promise<number> {
  const r = await prisma.cableRun.updateMany({ where: { id: { in: runs.map((r) => r.id) }, syncStatus: "pending" }, data: { syncStatus: "failed", syncError: message } });
  return r.count;
}

async function pushBatch(cfg: WriteBackConfig, url: string, pidField: string, info: LayerInfo, batch: RunForPush[], summary: SyncSummary): Promise<void> {
  const token = await getArcgisToken(cfg);
  // A run with no object id may still have a feature (an add whose answer was
  // lost, or the same layer after a stop / start): find it by its Polaris ID.
  const unknown = batch.filter((r) => r.arcgisObjectId === null);
  const found = new Map<string, number>();
  if (unknown.length) {
    const q = await arcgisRequest<{ features?: Array<{ attributes?: Record<string, unknown> }> }>(cfg, `${url}/query`, {
      method: "POST", token,
      params: {
        where: `${pidField} IN (${unknown.map((r) => `'${r.id}'`).join(",")})`,
        outFields: `${info.objectIdField},${pidField}`,
        returnGeometry: "false",
      },
    });
    for (const f of q.features ?? []) {
      const pid = f.attributes?.[pidField];
      const oid = f.attributes?.[info.objectIdField];
      if (typeof pid === "string" && typeof oid === "number") found.set(pid, oid);
    }
  }

  const adds: RunForPush[] = [];
  const updates: Array<{ run: RunForPush; oid: number }> = [];
  const deletes: Array<{ run: RunForPush; oid: number }> = [];
  const goneAlready: RunForPush[] = [];
  for (const r of batch) {
    const oid = r.arcgisObjectId ?? found.get(r.id) ?? null;
    if (r.deletedAt) { if (oid === null) goneAlready.push(r); else deletes.push({ run: r, oid }); }
    else if (oid === null) adds.push(r);
    else updates.push({ run: r, oid });
  }
  if (goneAlready.length) {
    await prisma.cableRun.deleteMany({ where: { id: { in: goneAlready.map((r) => r.id) }, deletedAt: { not: null } } });
    summary.deleted += goneAlready.length;
  }
  if (!adds.length && !updates.length && !deletes.length) return;

  const res = await arcgisRequest<{ addResults?: EditResult[]; updateResults?: EditResult[]; deleteResults?: EditResult[] }>(cfg, `${url}/applyEdits`, {
    method: "POST", token,
    params: {
      adds: JSON.stringify(adds.map((r) => featureFor(r, cfg, info))),
      updates: JSON.stringify(updates.map(({ run, oid }) => {
        const f = featureFor(run, cfg, info);
        return { ...f, attributes: { ...f.attributes, [info.objectIdField]: oid } };
      })),
      deletes: deletes.map((d) => d.oid).join(","),
      rollbackOnFailure: "false",
    },
  });

  const now = new Date();
  const ops: Array<Promise<unknown>> = [];
  const settle = (run: RunForPush, result: EditResult | undefined, oid: number | null) => {
    if (result?.success) {
      // Only `synced` if the run was not edited while this push was in flight.
      ops.push(prisma.cableRun.updateMany({
        where: { id: run.id, version: run.version, deletedAt: null },
        data: { syncStatus: "synced", syncError: null, syncedAt: now, arcgisObjectId: oid ?? result.objectId ?? null },
      }));
      // Whatever the version, remember which feature is this run's.
      const known = oid ?? (typeof result.objectId === "number" ? result.objectId : null);
      if (run.arcgisObjectId === null && known !== null) {
        ops.push(prisma.cableRun.updateMany({ where: { id: run.id, arcgisObjectId: null }, data: { arcgisObjectId: known } }));
      }
      summary.sent++;
    } else {
      const why = result?.error?.description || "ArcGIS did not accept this run";
      ops.push(prisma.cableRun.updateMany({
        where: { id: run.id, version: run.version },
        data: { syncStatus: "failed", syncError: why.slice(0, MAX_ERROR), ...(oid !== null ? { arcgisObjectId: oid } : {}) },
      }));
      summary.failed++;
    }
  };
  adds.forEach((r, i) => settle(r, res.addResults?.[i], null));
  updates.forEach((u, i) => settle(u.run, res.updateResults?.[i], u.oid));
  deletes.forEach((d, i) => {
    const result = res.deleteResults?.[i];
    // A feature already gone from the layer is as good as deleted.
    if (result?.success || result?.error?.code === 1000 || /not found|does not exist/i.test(result?.error?.description ?? "")) {
      ops.push(prisma.cableRun.deleteMany({ where: { id: d.run.id, deletedAt: { not: null } } }));
      summary.deleted++;
    } else {
      ops.push(prisma.cableRun.updateMany({
        where: { id: d.run.id }, data: { syncStatus: "failed", syncError: (result?.error?.description || "ArcGIS did not delete this feature").slice(0, MAX_ERROR) },
      }));
      summary.failed++;
    }
  });
  await Promise.all(ops);
}

let kickPending = false;
/** Push soon (after an edit session saved runs); never throws, never waits. */
export function kickWriteBack(): void {
  if (kickPending) return;
  kickPending = true;
  setTimeout(() => {
    kickPending = false;
    syncWriteBack().catch((err) => logger.warn({ err }, "ArcGIS write-back after a save failed; the next tick retries"));
  }, 500).unref?.();
}
