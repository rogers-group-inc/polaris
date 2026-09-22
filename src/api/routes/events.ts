/**
 * src/api/routes/events.ts — Event log read endpoints + shared logger
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import { requirePermission } from "../middleware/permissions.js";
import { SECRET_MASK, isMaskedSecret } from "../../utils/secretMask.js";
import { csvParam } from "../../utils/text.js";
import { buildPrismaTextFilter } from "../../utils/prismaTextFilter.js";
import { queryEventsPage, listEventResourceTypes } from "../../services/eventLogService.js";
import {
  getArchiveSettings,
  updateArchiveSettings,
  testConnection,
  getSyslogSettings,
  updateSyslogSettings,
  testSyslogConnection,
  getRetentionSettings,
  updateRetentionSettings,
  getAssetDecommissionSettings,
  updateAssetDecommissionSettings,
} from "../../services/eventArchiveService.js";

// Sort whitelist — Prisma orderBy must never accept user-supplied strings
// unvalidated. `level` is mapped onto `levelRank` so severity sort matches
// operator expectations (info < warning < error) rather than alphabetical.
const SORT_WHITELIST = new Set([
  "timestamp", "level", "action", "resourceType", "resourceName", "actor", "message",
]);

// Text-filter operators accepted from the TableSF text-column operator
// dropdown. `contains` is the default and the only form pre-this-change.

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  // Multi-value enum filters: CSV. Single-value back-compat is preserved
  // by treating a 1-element split as { equals: v } downstream.
  level: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  // Text filters + their per-field operator. Operator defaults to `contains`
  // when omitted, matching pre-this-change behavior.
  action: z.string().optional(),
  actionOp: z.string().optional(),
  resourceName: z.string().optional(),
  resourceNameOp: z.string().optional(),
  actor: z.string().optional(),
  actorOp: z.string().optional(),
  message: z.string().optional(),
  messageOp: z.string().optional(),
  // Date range on `timestamp`. The retention cutoff is the floor regardless
  // of what `since` says.
  since: z.string().optional(),
  until: z.string().optional(),
  // Sort whitelist; validated below.
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

/**
 * Translate a text-filter op + value into a Prisma `where`-level fragment for
 * `field`, or undefined when the filter is a no-op. Fragments are where-level
 * (`{ field: ... }` / `{ OR: [...] }`) rather than field-level because
 * empty / is_not_empty need OR / AND composition, which Prisma only accepts at
 * the where level; the call site ANDs the fragments together. `actor` is the
 * one nullable column — its blank checks carry a null arm, while non-nullable
 * action / message compare against "" only (Prisma rejects `equals: null` on a
 * non-nullable field).
 */
function buildTextFilter(
  field: "action" | "actor" | "message" | "resourceName",
  value: string | undefined,
  op: string | undefined,
): Record<string, unknown> | undefined {
  // `actor` and `resourceName` are the nullable Event text columns;
  // action/message compare against "" only. Shared builder:
  // utils/prismaTextFilter.
  const nullable = field === "actor" || field === "resourceName";
  return buildPrismaTextFilter(field, value, op, { nullable });
}

/** CSV → string[]; empty entries dropped; returns undefined for no value. */
const csvToArray = csvParam;

const router = Router();

// GET /api/v1/events — list events (newest first by default, paginated).
//
// Supports multi-value enum filters on `level` and `resourceType` (CSV),
// operator-aware text filters on `action` / `resourceName` / `actor` /
// `message` (each takes
// an optional `<field>Op` of contains | not_contains | empty | is_not_empty,
// defaulting to contains), and a sort whitelist (timestamp | level | action |
// resourceType | resourceName | actor | message) honored via `sortBy` +
// `sortDir`. `sortBy=level` dispatches to `orderBy: { levelRank }` so the
// operator sees severity order rather than alphabetical (error < info <
// warning).
//
// Pre-this-change single-value callers (`?level=info`) continue to work
// unchanged — the multi-value path is opted into by passing a CSV.
router.get("/", requirePermission("events", "read"), async (req, res, next) => {
  try {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query: " + parsed.error.issues[0].message);
    }
    const q = parsed.data;
    const limit = Math.min(q.limit ?? 50, 200);
    const offset = q.offset ?? 0;

    const { retentionDays } = await getRetentionSettings();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    // Caller-supplied since narrows the window; the retention cutoff is the
    // floor regardless. until is optional and unbounded by default.
    const tsFilter: Record<string, Date> = { gte: cutoff };
    if (q.since) {
      const sinceD = new Date(q.since);
      if (!isNaN(+sinceD) && +sinceD > +cutoff) tsFilter.gte = sinceD;
    }
    if (q.until) {
      const untilD = new Date(q.until);
      if (!isNaN(+untilD)) tsFilter.lte = untilD;
    }
    const where: Record<string, unknown> = { timestamp: tsFilter };

    // Multi-value enum filters. CSV with >1 entry → Prisma { in: [...] };
    // exactly 1 entry → { equals: v } so the back-compat single-value path
    // serializes identically to pre-this-change.
    const levels = csvToArray(q.level);
    if (levels) where.level = levels.length === 1 ? levels[0] : { in: levels };

    const resourceTypes = csvToArray(q.resourceType);
    if (resourceTypes) where.resourceType = resourceTypes.length === 1 ? resourceTypes[0] : { in: resourceTypes };

    if (q.resourceId) where.resourceId = q.resourceId;

    // Operator-aware text filters. `action`, `actor`, `message` each take an
    // optional <field>Op param; missing op → contains (default). The actor
    // filter was silently dropped pre-this-change (frontend already sent it,
    // backend schema didn't define it) — adding it here is a drive-by fix.
    const textFilters = [
      buildTextFilter("action", q.action, q.actionOp),
      buildTextFilter("resourceName", q.resourceName, q.resourceNameOp),
      buildTextFilter("actor", q.actor, q.actorOp),
      buildTextFilter("message", q.message, q.messageOp),
    ].filter((f): f is Record<string, unknown> => f !== undefined);
    if (textFilters.length) where.AND = textFilters;

    // Sort whitelist. Reject anything outside the catalogue with a 400 —
    // Prisma orderBy must never accept user-supplied strings unvalidated.
    let sortBy: string = "timestamp";
    if (q.sortBy) {
      if (!SORT_WHITELIST.has(q.sortBy)) {
        throw new AppError(400, `Invalid sortBy: ${q.sortBy}`);
      }
      sortBy = q.sortBy;
    }
    const sortDir: "asc" | "desc" = q.sortDir ?? "desc";
    // sortBy=level → orderBy on the numeric severity column so operators see
    // info < warning < error rather than the alphabetical accident.
    const orderColumn = sortBy === "level" ? "levelRank" : sortBy;
    const orderBy = { [orderColumn]: sortDir };

    const { events, total } = await queryEventsPage({ where, orderBy, skip: offset, take: limit });

    res.json({ events, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/events/resource-types — distinct resourceType values across the
// whole (retention-window) event table. Feeds the Resource-column multi-select
// filter on the Events page so every option is selectable even when it isn't
// present on the current page of rows. Low cardinality (a handful of entity
// kinds), so groupBy over the retention window is cheap; called once per page
// load. Bounded by the same retention floor as the list endpoint.
router.get("/resource-types", requirePermission("events", "read"), async (_req, res, next) => {
  try {
    const { retentionDays } = await getRetentionSettings();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    res.json({ resourceTypes: await listEventResourceTypes(cutoff) });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/events/archive-settings — get archive export settings
// Reveals SSH host/username/path; admin-only even with password masked.
router.get("/archive-settings", requirePermission("events", "write"), async (_req, res, next) => {
  try {
    const settings = await getArchiveSettings();
    // Strip password from response
    const safe = { ...settings };
    if (safe.password) safe.password = SECRET_MASK;
    res.json(safe);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/events/archive-settings — update archive export settings
router.put("/archive-settings", requirePermission("events", "write"), async (req, res, next) => {
  try {
    const body = req.body;
    // Don't overwrite password if placeholder was sent back
    if (isMaskedSecret(body.password)) delete body.password;
    const updated = await updateArchiveSettings(body);
    const safe = { ...updated };
    if (safe.password) safe.password = SECRET_MASK;
    res.json(safe);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/events/archive-test — test SFTP/SCP connection
router.post("/archive-test", requirePermission("events", "write"), async (req, res, next) => {
  try {
    const settings = req.body;
    // If password is placeholder, fetch the real one
    if (isMaskedSecret(settings.password)) {
      const current = await getArchiveSettings();
      settings.password = current.password;
    }
    const result = await testConnection(settings);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/events/syslog-settings — get syslog forwarding settings
// Reveals host/port/TLS paths; admin-only.
router.get("/syslog-settings", requirePermission("events", "write"), async (_req, res, next) => {
  try {
    const settings = await getSyslogSettings();
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/events/syslog-settings — update syslog forwarding settings
router.put("/syslog-settings", requirePermission("events", "write"), async (req, res, next) => {
  try {
    const updated = await updateSyslogSettings(req.body);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/events/syslog-test — test syslog connection
router.post("/syslog-test", requirePermission("events", "write"), async (req, res, next) => {
  try {
    const result = await testSyslogConnection(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/events/retention-settings
router.get("/retention-settings", requirePermission("events", "read"), async (_req, res, next) => {
  try {
    res.json(await getRetentionSettings());
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/events/retention-settings
router.put("/retention-settings", requirePermission("events", "write"), async (req, res, next) => {
  try {
    res.json(await updateRetentionSettings(req.body));
  } catch (err) {
    next(err);
  }
});

// Auto-decommission settings decide when an asset that has stopped appearing
// in vCenter / AD / Entra is retired from the inventory. They are gated on
// assetMonitorSettings rather than on `events`, for two reasons that agree:
// the `events` key gates the audit LOG and where it is archived to, and
// somebody trusted to configure syslog export is not thereby trusted to
// change when devices leave the inventory; and the only UI that reads or
// writes these is the Asset Monitoring Settings modal
// (`openMonitoringSettingsModal` in public/js/assets.js), every other call in
// which already rides assetMonitorSettings. The path stays under /events for
// URL compatibility — it is the GATE that was wrong, not the mount.
// GET /api/v1/events/asset-decommission-settings
router.get("/asset-decommission-settings", requirePermission("assetMonitorSettings", "read"), async (_req, res, next) => {
  try {
    res.json(await getAssetDecommissionSettings());
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/events/asset-decommission-settings
router.put("/asset-decommission-settings", requirePermission("assetMonitorSettings", "write"), async (req, res, next) => {
  try {
    res.json(await updateAssetDecommissionSettings(req.body));
  } catch (err) {
    next(err);
  }
});

export default router;

// ─── Shared Event Logger (moved) ─────────────────────────────────────────────
//
// logEvent / buildChanges / LogEventInput live in
// src/services/eventLogService.ts now — services must not import from the
// route layer to write audit rows. Re-exported here so the ~42 existing
// importers keep working; new code should import from the service directly.

export {
  logEvent,
  buildChanges,
  snapshotMaterialAssetFields,
  logDiscoveryAssetCreated,
  logDiscoveryAssetUpdated,
} from "../../services/eventLogService.js";
export type { LogEventInput, DiscoveryAuditContext } from "../../services/eventLogService.js";
