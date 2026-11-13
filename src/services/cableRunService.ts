/**
 * src/services/cableRunService.ts — cable runs at a Device Map site
 * (business rule 184).
 *
 * A cable run is a physical fiber or ethernet route: along electric or
 * telephone poles (drawn by hand on a Topology view) or in a trench (imported
 * from a survey file — the importer lands in a later batch, so a trench cannot
 * be drawn). Runs belong to the SITE (the FortiGate asset), not to a view:
 * every Topology view of the site shows them, and a view's mode reset (rule
 * 149) never touches them.
 *
 * Geometry is WGS84 `[[lng, lat, z?], ...]` — the Topology canvas's layer-0
 * order and GeoJSON's. Elevation (z) is kept for the ArcGIS write-back but
 * Polaris draws and measures in 2D (`lengthM` is the ground distance).
 *
 * Edits arrive as ONE batch from the Topology edit session (tick = commit,
 * close = discard) and are applied in one transaction, with an Event per
 * create / update / delete. The sync columns are the one-way ArcGIS
 * write-back state (rule 184): a run is "off" until a write-back is
 * configured; once a run has been sent (`pending` / `synced` / `failed`), an
 * edit makes it `pending` again and a delete leaves a tombstone (`deletedAt`)
 * for the write-back to remove the ArcGIS feature before the row goes.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { buildChanges, logEventsBatch } from "./eventLogService.js";
import type { Prisma } from "../generated/prisma/client.js";

export const CABLE_MEDIA = ["fiber", "ethernet"] as const;
export const CABLE_PLACEMENTS = ["trench", "electric_pole", "telephone_pole"] as const;
type CableMedium = (typeof CABLE_MEDIA)[number];
type CablePlacement = (typeof CABLE_PLACEMENTS)[number];

/** A drawn run's point cap; a surveyed trench may carry more. */
export const MAX_DRAWN_POINTS = 1000;
const MAX_EDITS = 500;
const MAX_NAME = 120;
const MAX_NOTES = 2000;

export type CablePoint = [number, number] | [number, number, number];

export interface CableRunView {
  id: string;
  name: string;
  medium: CableMedium;
  placement: CablePlacement;
  points: CablePoint[];
  source: "drawn" | "crd";
  sourceFile: string | null;
  notes: string;
  lengthM: number;
  syncStatus: string;
  syncError: string | null;
  syncedAt: string | null;
  arcgisObjectId: number | null;
  createdBy: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

/** One run as the edit session sends it. No id = a new run. */
interface CableRunInput {
  id?: string;
  name?: string;
  medium: string;
  placement: string;
  points: unknown;
  notes?: string;
}

// ─── Pure helpers ────────────────────────────────────────────────────────

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Validate and normalise a run's points: 2..`max` points, each `[lng, lat]`
 * or `[lng, lat, z]` in range. Coordinates are rounded to 1e-7° (≈1 cm),
 * elevation to 1 mm. Throws AppError(400) naming the first bad point.
 */
export function normalizePoints(raw: unknown, max = MAX_DRAWN_POINTS): CablePoint[] {
  if (!Array.isArray(raw)) throw new AppError(400, "A cable run needs a list of points");
  if (raw.length < 2) throw new AppError(400, "A cable run needs at least two points");
  if (raw.length > max) throw new AppError(400, `A cable run may have at most ${max} points`);
  return raw.map((p, i) => {
    if (!Array.isArray(p) || (p.length !== 2 && p.length !== 3) || !p.every(isNum)) {
      throw new AppError(400, `Point ${i + 1} must be [longitude, latitude] or [longitude, latitude, elevation]`);
    }
    const [lng, lat, z] = p as number[];
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      throw new AppError(400, `Point ${i + 1} is not a latitude / longitude (${lat}, ${lng})`);
    }
    const r7 = (v: number) => Math.round(v * 1e7) / 1e7;
    return z === undefined ? [r7(lng), r7(lat)] : [r7(lng), r7(lat), Math.round(z * 1000) / 1000];
  });
}

const EARTH_RADIUS_M = 6_371_008.8;

/** The ground length of a run in metres (great-circle, 2D). */
export function runLengthM(points: readonly CablePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const [lng1, lat1] = points[i - 1];
    const [lng2, lat2] = points[i];
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const dφ = φ2 - φ1;
    const dλ = ((lng2 - lng1) * Math.PI) / 180;
    const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    total += 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return Math.round(total * 100) / 100;
}

/**
 * The sync status after an edit: a run never sent stays "off" (no write-back
 * configured yet); one that has been sent must be sent again.
 */
export function syncStatusAfterEdit(current: string): string {
  return current === "off" ? "off" : "pending";
}

function cleanText(v: unknown, max: number, what: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length > max) throw new AppError(400, `${what} may be at most ${max} characters`);
  // Control characters (bar tab / newline in notes) would ride into ArcGIS attributes.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) throw new AppError(400, `${what} may not contain control characters`);
  return s;
}

function pick<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw new AppError(400, `${what} must be one of ${allowed.join(", ")}`);
}

// ─── Reads ───────────────────────────────────────────────────────────────

type RunRow = Prisma.CableRunGetPayload<Record<string, never>>;

function toView(r: RunRow): CableRunView {
  return {
    id: r.id,
    name: r.name,
    medium: r.medium as CableMedium,
    placement: r.placement as CablePlacement,
    points: r.points as CablePoint[],
    source: r.source === "crd" ? "crd" : "drawn",
    sourceFile: r.sourceFile,
    notes: r.notes,
    lengthM: r.lengthM,
    syncStatus: r.syncStatus,
    syncError: r.syncError,
    syncedAt: r.syncedAt ? r.syncedAt.toISOString() : null,
    arcgisObjectId: r.arcgisObjectId,
    createdBy: r.createdBy,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function assertSite(siteId: string): Promise<string> {
  const site = await prisma.asset.findUnique({ where: { id: siteId }, select: { assetType: true, hostname: true } });
  if (!site || site.assetType !== "firewall") throw new AppError(404, "Site not found");
  return site.hostname ?? siteId;
}

/** A site's runs (tombstones excluded), oldest first. */
export async function listRuns(siteId: string): Promise<CableRunView[]> {
  await assertSite(siteId);
  const rows = await prisma.cableRun.findMany({
    where: { siteId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toView);
}

// ─── Writes ──────────────────────────────────────────────────────────────

export interface CableRunEdits {
  upserts?: CableRunInput[];
  deletes?: string[];
}

/**
 * Apply one edit session's run changes to a site, all or nothing, and return
 * the site's runs after it. Ids that name another site's run, or a run already
 * deleted, are refused (404) — never silently ignored.
 */
export async function applyRunEdits(siteId: string, edits: CableRunEdits, actor: string): Promise<CableRunView[]> {
  const siteName = await assertSite(siteId);
  const upserts = edits.upserts ?? [];
  const deletes = Array.from(new Set(edits.deletes ?? []));
  if (upserts.length + deletes.length > MAX_EDITS) throw new AppError(400, `At most ${MAX_EDITS} cable-run changes at once`);
  if (upserts.length === 0 && deletes.length === 0) return listRuns(siteId);

  const ids = [...upserts.map((u) => u.id).filter((v): v is string => !!v), ...deletes];
  const existing = ids.length
    ? await prisma.cableRun.findMany({ where: { id: { in: ids }, siteId, deletedAt: null } })
    : [];
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const id of ids) if (!byId.has(id)) throw new AppError(404, `Cable run ${id} not found at this site`);
  if (upserts.some((u) => u.id && deletes.includes(u.id))) throw new AppError(400, "A cable run cannot be both edited and deleted");

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  const events: Parameters<typeof logEventsBatch>[0] = [];

  for (const u of upserts) {
    const prev = u.id ? byId.get(u.id)! : null;
    const medium = pick(u.medium, CABLE_MEDIA, "Medium");
    const placement = pick(u.placement, CABLE_PLACEMENTS, "Placement");
    const name = cleanText(u.name, MAX_NAME, "The name");
    const notes = cleanText(u.notes, MAX_NOTES, "The notes");
    const isSurveyed = prev?.source === "crd";
    // Rule 184: a trench comes from a survey file; it is never drawn by hand,
    // and a surveyed run's points are never moved on the map.
    if (placement === "trench" && !isSurveyed) {
      throw new AppError(400, "A trench is imported from a survey file, not drawn — draw pole runs by hand");
    }
    if (isSurveyed && placement !== "trench") {
      throw new AppError(400, "A surveyed trench stays a trench");
    }
    let points: CablePoint[];
    if (isSurveyed) {
      const sent = JSON.stringify(u.points ?? prev!.points);
      if (sent !== JSON.stringify(prev!.points)) {
        throw new AppError(400, "A surveyed trench's points cannot be moved on the map — import a revised survey file instead");
      }
      points = prev!.points as CablePoint[];
    } else {
      points = normalizePoints(u.points);
    }
    const lengthM = runLengthM(points);

    if (!prev) {
      const id = randomUUID();
      ops.push(prisma.cableRun.create({
        data: { id, siteId, name, medium, placement, points, notes, lengthM, source: "drawn", createdBy: actor, updatedBy: actor },
      }));
      events.push({
        action: "cable_run.created", resourceType: "cable_run", resourceId: id, resourceName: name || undefined, actor,
        message: `Cable run${name ? ` "${name}"` : ""} drawn at ${siteName} (${medium}, ${placement.replace("_", " ")}, ${Math.round(lengthM)} m)`,
        details: { siteId, medium, placement, points: points.length, lengthM },
      });
      continue;
    }
    const before = { name: prev.name, medium: prev.medium, placement: prev.placement, notes: prev.notes, points: prev.points };
    const after = { name, medium, placement, notes, points };
    const changes = buildChanges(before, after as Record<string, unknown>);
    if (!changes) continue;
    ops.push(prisma.cableRun.update({
      where: { id: prev.id },
      data: {
        name, medium, placement, notes, points, lengthM, updatedBy: actor,
        version: { increment: 1 },
        syncStatus: syncStatusAfterEdit(prev.syncStatus),
      },
    }));
    events.push({
      action: "cable_run.updated", resourceType: "cable_run", resourceId: prev.id, resourceName: name || undefined, actor,
      message: `Cable run${name ? ` "${name}"` : ""} at ${siteName} updated`,
      // Point lists can be long: the Event says that they moved, not every vertex.
      details: { siteId, changes: { ...changes, ...(changes.points ? { points: { from: (prev.points as unknown[]).length, to: points.length } } : {}) } },
    });
  }

  for (const id of deletes) {
    const prev = byId.get(id)!;
    // Sent to ArcGIS already: keep a tombstone until the write-back removes the feature.
    ops.push(prev.arcgisObjectId !== null
      ? prisma.cableRun.update({ where: { id }, data: { deletedAt: new Date(), syncStatus: "pending", updatedBy: actor } })
      : prisma.cableRun.delete({ where: { id } }));
    events.push({
      action: "cable_run.deleted", resourceType: "cable_run", resourceId: id, resourceName: prev.name || undefined, actor,
      message: `Cable run${prev.name ? ` "${prev.name}"` : ""} at ${siteName} deleted`,
      details: { siteId, placement: prev.placement, arcgisObjectId: prev.arcgisObjectId },
    });
  }

  if (ops.length) await prisma.$transaction(ops);
  await logEventsBatch(events);
  return listRuns(siteId);
}
