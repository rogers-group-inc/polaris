/**
 * src/api/routes/conflicts.ts — Discovery conflict review and resolution
 *
 * Thin route layer: role-based visibility + resolve gating live here; the
 * resolution engine (accept/reject/merge for both entityType variants,
 * including the ip-override flavour and the ghost-absorb transaction) lives
 * in src/services/conflictResolutionService.ts — see its header for the
 * conflict-variant semantics. The duplicate-IP flavour's two verbs delegate to
 * src/services/duplicateIpConflictService.ts: `/:id/reassign-ip` (move one of
 * the assets to a different address), `/:id/clear-ip` (blank an offline one's
 * address until discovery reports a new one) and `/:id/merge` (same route as
 * the per-field asset merge, different body — the records are one device).
 *
 * Access rides the discoveryConflicts permission alone: read = list both
 * entity types, write = resolve both — with exceptions, `/:id/reassign-ip`,
 * `/:id/clear-ip` and `/:id/merge` on a duplicate-IP conflict, which additionally require
 * `assets:write` because they edit (and, for merge, delete) inventory, and
 * `/:id/keep-reservation` on a duplicate-reservation conflict (business rule
 * 139, src/services/duplicateReservationConflictService.ts), which takes the
 * reservation release gate because it releases the others.
 * (The historical networkadmin↔
 * reservation / assetsadmin↔asset role-NAME partition was dropped 2026-08 —
 * it silently stopped applying when the seeded roles were renamed and never
 * applied to bearer-token callers.)
 */

import { intQuery } from "../../utils/queryParams.js";
import { Router, type Request } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import { requireAuth, requestActor } from "../middleware/auth.js";
import { hasPermission, ensureRoleSnapshot } from "../middleware/permissions.js";
import { prisma } from "../../db.js";
import { resolveWriteScope, inWriteScope, assertInWriteScope, assertFleetWide, reservationScopeRecord, type ScopeRecord } from "../../services/writeScopeService.js";
import {
  listConflicts,
  countPendingConflicts,
  loadPendingConflict,
  acceptConflict,
  mergeAssetConflict,
  rejectConflict,
  type ConflictEntityType,
} from "../../services/conflictResolutionService.js";
import {
  buildChassisDiff,
  migrateArchivedReservations,
  adoptChassisSwap,
  rejectChassisSwap,
} from "../../services/subnetChassisConflictService.js";
import {
  reassignDuplicateIpAsset,
  clearDuplicateIpAsset,
  mergeDuplicateIpAssets,
  DUPLICATE_IP_COLLISION_REASON,
} from "../../services/duplicateIpConflictService.js";
import {
  mergeDuplicateSerialAssets,
  DUPLICATE_SERIAL_COLLISION_REASON,
} from "../../services/duplicateSerialConflictService.js";
import { DECOMMISSIONED_AGENT_COLLISION_REASON } from "../../services/agentHostPinService.js";
import {
  keepOneReservation,
  releaseOneReservation,
  DUPLICATE_RESERVATION_COLLISION_REASON,
} from "../../services/duplicateReservationConflictService.js";

const KeepReservationSchema = z.object({ reservationId: z.string().min(1) });

// One FortiGate swap = one decision across every subnet it raised (rule 41(a)).
const ChassisSwapSchema = z.object({
  oldSerial: z.string().trim().min(1).max(64),
  newSerial: z.string().trim().min(1).max(64),
  mergeOldAsset: z.boolean().optional(),
});

const router = Router();
router.use(requireAuth);
// `hasPermission` is synchronous and reads the snapshot already on the request;
// it is only valid after something has refreshed it. Nothing on this router did,
// so a session read the role matrix it was issued with and a role edit never
// reached a caller who used only these routes (scan finding F239; business rule
// 108), and a bearer-token caller resolved no role at all and was always denied.
// The handlers keep their filter-don't-403 behaviour; they now decide on a
// current snapshot.
router.use(async (req, _res, next) => {
  try {
    await ensureRoleSnapshot(req);
    next();
  } catch (err) {
    next(err);
  }
});

function visibleEntityTypes(req: Request): ConflictEntityType[] {
  if (!hasPermission(req, "discoveryConflicts", "read")) return [];
  // "subnet" arrived with business rule 41's chassis-replacement variant. It
  // rides the same `discoveryConflicts` gate as the other two: it IS a
  // discovery conflict, and gating it separately would leave a replaced gate
  // reported to nobody who can act on it.
  return ["reservation", "asset", "subnet"];
}

function canResolve(req: Request): boolean {
  return hasPermission(req, "discoveryConflicts", "write");
}

/**
 * Business rule 141 (e): a Read-Write resolver reaches a conflict when ANY
 * member record is one they own or that carries one of their tags — the
 * conflicted asset, the conflicted reservation (its creator, its network's
 * tags), the chassis-swap subnet's tags, every member of a duplicate-IP /
 * duplicate-serial group, every binding of a duplicate-reservation group.
 * A conflict with no member record at all is Full Read-Write only. Loads only
 * the owner / tag columns, in one read per member kind.
 */
async function assertConflictInScope(req: Request, conflict: any, verb: string): Promise<void> {
  const scope = await resolveWriteScope(req, "discoveryConflicts");
  if (scope.kind === "all") return;
  const fields = (conflict.proposedAssetFields || {}) as Record<string, unknown>;
  const candidates: ScopeRecord[] = [];
  if (conflict.asset) candidates.push({ createdBy: conflict.asset.createdBy ?? null, tags: conflict.asset.tags ?? [] });
  if (conflict.reservation) {
    const subnet = conflict.reservation.subnetId
      ? await prisma.subnet.findUnique({ where: { id: conflict.reservation.subnetId }, select: { tags: true } })
      : null;
    candidates.push(reservationScopeRecord({ createdBy: conflict.reservation.createdBy ?? null, subnet }, conflict.asset));
  }
  if (conflict.subnetId) {
    const subnet = await prisma.subnet.findUnique({ where: { id: conflict.subnetId }, select: { createdBy: true, tags: true } });
    if (subnet) candidates.push(subnet);
  }
  const memberIds = Array.isArray(fields.members)
    ? (fields.members as { assetId?: unknown }[]).map((m) => (m && typeof m.assetId === "string" ? m.assetId : "")).filter(Boolean)
    : [];
  if (memberIds.length) {
    const assets = await prisma.asset.findMany({ where: { id: { in: memberIds } }, select: { createdBy: true, tags: true } });
    candidates.push(...assets);
  }
  const bindingIds = Array.isArray(fields.reservations)
    ? (fields.reservations as { reservationId?: unknown }[]).map((r) => (r && typeof r.reservationId === "string" ? r.reservationId : "")).filter(Boolean)
    : [];
  if (bindingIds.length) {
    const rows = await prisma.reservation.findMany({ where: { id: { in: bindingIds } }, select: { createdBy: true, subnet: { select: { tags: true } } } });
    candidates.push(...rows.map((r) => reservationScopeRecord(r, conflict.asset)));
  }
  if (candidates.length === 0) assertFleetWide(scope, `${verb} a conflict that names no record`);
  if (!candidates.some((c) => inWriteScope(scope, c))) {
    throw new AppError(403, `Forbidden — you can only ${verb} conflicts with a member you created or that carries one of your tags`);
  }
}

/**
 * Rule 141 (e) / (f) for the LIST: `canResolve` per conflict and, on a
 * duplicate-reservation card, `inScope` per binding — so the page offers only
 * the verbs that will succeed. Batched: three reads over the page's member
 * assets, bindings and subnets (the list allows 5000 rows), then in-memory
 * set lookups. Full Read-Write callers — most — skip all of it.
 */
async function decorateConflictScope(req: Request, rows: any[]): Promise<any[]> {
  const resolveScope = await resolveWriteScope(req, "discoveryConflicts");
  const reservationsScope = await resolveWriteScope(req, "reservations");
  const mayRelease = hasPermission(req, "reservations", "write");
  if (resolveScope.kind === "all" && reservationsScope.kind === "all") {
    return rows.map((c) => ({ ...c, canResolve: true, canRelease: mayRelease }));
  }
  const assetIds = new Set<string>();
  const bindingIds = new Set<string>();
  const subnetIds = new Set<string>();
  for (const c of rows) {
    const f = (c.proposedAssetFields || {}) as Record<string, unknown>;
    if (Array.isArray(f.members)) for (const m of f.members as { assetId?: unknown }[]) if (m && typeof m.assetId === "string") assetIds.add(m.assetId);
    if (Array.isArray(f.reservations)) for (const r of f.reservations as { reservationId?: unknown }[]) if (r && typeof r.reservationId === "string") bindingIds.add(r.reservationId);
    if (c.subnetId) subnetIds.add(c.subnetId);
    if (c.reservation?.subnetId && !c.reservation?.subnet) subnetIds.add(c.reservation.subnetId);
  }
  const [assets, bindings, subnets] = await Promise.all([
    assetIds.size ? prisma.asset.findMany({ where: { id: { in: [...assetIds] } }, select: { id: true, createdBy: true, tags: true } }) : [],
    bindingIds.size ? prisma.reservation.findMany({ where: { id: { in: [...bindingIds] } }, select: { id: true, createdBy: true, subnet: { select: { tags: true } } } }) : [],
    subnetIds.size ? prisma.subnet.findMany({ where: { id: { in: [...subnetIds] } }, select: { id: true, createdBy: true, tags: true } }) : [],
  ]);
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const bindingById = new Map(bindings.map((b) => [b.id, b]));
  const subnetById = new Map(subnets.map((s) => [s.id, s]));
  return rows.map((c) => {
    const f = (c.proposedAssetFields || {}) as Record<string, unknown>;
    const assetRec: ScopeRecord | null = c.asset ? { createdBy: c.asset.createdBy ?? null, tags: c.asset.tags ?? [] } : null;
    const candidates: ScopeRecord[] = [];
    if (assetRec) candidates.push(assetRec);
    if (c.reservation) candidates.push(reservationScopeRecord({ createdBy: c.reservation.createdBy ?? null, subnet: c.reservation.subnet ?? subnetById.get(c.reservation.subnetId) ?? null }, assetRec));
    if (c.subnetId) { const s = subnetById.get(c.subnetId); if (s) candidates.push(s); }
    if (Array.isArray(f.members)) for (const m of f.members as { assetId?: unknown }[]) { const a = typeof m?.assetId === "string" ? assetById.get(m.assetId) : null; if (a) candidates.push(a); }
    let bindingsOut: unknown = f.reservations;
    let anyBinding = false;
    if (Array.isArray(f.reservations)) {
      bindingsOut = (f.reservations as { reservationId?: unknown }[]).map((r) => {
        const b = typeof r?.reservationId === "string" ? bindingById.get(r.reservationId) : null;
        const rec = b ? reservationScopeRecord(b, assetRec) : null;
        const ok = reservationsScope.kind === "all" || (!!rec && inWriteScope(reservationsScope, rec)) || (!!assetRec && inWriteScope(reservationsScope, assetRec));
        if (ok) anyBinding = true;
        if (rec) candidates.push(rec);
        return { ...(r as object), inScope: ok };
      });
    }
    const canResolve = resolveScope.kind === "all" || (candidates.length > 0 && candidates.some((r) => inWriteScope(resolveScope, r)));
    const isDhcp = f.collisionReason === DUPLICATE_RESERVATION_COLLISION_REASON;
    return {
      ...c,
      proposedAssetFields: isDhcp ? { ...f, reservations: bindingsOut } : c.proposedAssetFields,
      canResolve,
      // The DHCP flavour is resolved at reservations:write with a binding in scope (rule 141 (f)).
      canRelease: isDhcp ? mayRelease && anyBinding : mayRelease,
    };
  });
}

/** The asset a duplicate-IP verb NAMES in its body — judged itself, not "any member". */
async function assertNamedAssetInScope(req: Request, assetId: string): Promise<void> {
  const scope = await resolveWriteScope(req, "assets");
  if (scope.kind === "all") return;
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { createdBy: true, tags: true } });
  if (asset) assertInWriteScope(scope, asset, "change the address of devices");
}

// Business rule 123: accepting a decommissioned-agent check-in changes the
// asset's status, so it also takes what the asset edit form takes — and, per
// rule 141 (e), the asset itself must be in the caller's write scope.
async function assertCanReactivate(req: Request, conflict: { proposedAssetFields?: unknown; asset?: { createdBy?: string | null; tags?: string[] } | null }): Promise<void> {
  const kind = (conflict.proposedAssetFields || {}) as Record<string, unknown>;
  if (kind.collisionReason !== DECOMMISSIONED_AGENT_COLLISION_REASON) return;
  if (!hasPermission(req, "assets", "write")) {
    throw new AppError(403, "Reactivating a decommissioned asset requires read-write on Assets");
  }
  if (conflict.asset) {
    assertInWriteScope(await resolveWriteScope(req, "assets"), { createdBy: conflict.asset.createdBy ?? null, tags: conflict.asset.tags ?? [] }, "reactivate devices");
  }
}

// GET /api/v1/conflicts — list conflicts visible to the current role
router.get("/", async (req, res, next) => {
  try {
    const status = (req.query.status as string) || "pending";
    const limit = intQuery(req.query.limit, { fallback: 100, max: 5000 })!;
    const offset = intQuery(req.query.offset, { fallback: 0 })!;

    const entityTypes = visibleEntityTypes(req);
    if (entityTypes.length === 0) {
      res.json({ conflicts: [], total: 0, limit, offset });
      return;
    }

    const { conflicts, total } = await listConflicts(entityTypes, status, limit, offset);
    res.json({ conflicts: await decorateConflictScope(req, conflicts as any[]), total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/conflicts/count — pending count for nav badge, scoped to role
router.get("/count", async (req, res, next) => {
  try {
    const entityTypes = visibleEntityTypes(req);
    if (entityTypes.length === 0) {
      res.json({ count: 0 });
      return;
    }
    const count = await countPendingConflicts(entityTypes);
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/conflicts/:id/chassis-diff — the per-address diff behind a
// `chassis-replaced` subnet conflict (business rule 41): what the archived old
// chassis served against what the live subnet holds now.
//
// A separate read rather than a field on the conflict row: discovery syncs
// subnets in Phase 1 and reservations in Phases 3–5, so a payload built at
// detection time would compare the old chassis against itself. Reading it live
// also means the card can never show a diff that has since gone stale.
router.get("/:id/chassis-diff", async (req, res, next) => {
  try {
    // Same read gate the list and count carry — requireAuth alone would let any
    // authenticated session enumerate a subnet's whole reservation history.
    if (!visibleEntityTypes(req).includes("subnet")) {
      throw new AppError(403, "You do not have permission to view discovery conflicts");
    }
    const conflict = await loadPendingConflict(req.params.id);
    if (conflict.entityType !== "subnet") {
      throw new AppError(400, "This conflict is not a subnet chassis replacement");
    }
    res.json(await buildChassisDiff(conflict));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/migrate-reservations — subnet chassis conflicts
// only. Body: `{ ips: [...], adopt?: boolean }`.
//
// Carries the named addresses' OLD (archived) reservations onto the live
// subnet: `only-old` lines are created, `same`/`differs` lines update the live
// row in place. Every migrated row lands `sourceType: "manual"` with
// `dhcpBinding: null` and, where the integration's DHCP push is on, queued
// (`pushStatus: "pending"`) for `retryQueuedReservationPushes` to send — never
// pushed inline, because a brand-new gate is exactly the device most likely to
// be briefly unreachable and an operator's migrate must not fail on that.
//
// CHAINED gate — `discoveryConflicts:write` AND `reservations:write` (the
// /reassign-ip precedent): resolving conflict queue entries and creating
// reservations are separable grants, and this verb needs both.
//
// `adopt: true` additionally runs the normal accept, closing the conflict and
// stamping the new serial. Omitted, the conflict stays open on purpose — an
// operator may migrate a few lines, look again, and migrate more.
router.post("/:id/migrate-reservations", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    if (conflict.entityType !== "subnet") {
      throw new AppError(400, "Reservation migration is only supported for subnet chassis conflicts");
    }
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }
    await assertConflictInScope(req, conflict, "resolve");
    if (!hasPermission(req, "reservations", "write")) {
      throw new AppError(403, "You do not have permission to create reservations");
    }
    const ips = Array.isArray(req.body?.ips)
      ? req.body.ips.filter((v: unknown): v is string => typeof v === "string")
      : [];
    if (ips.length === 0) throw new AppError(400, "ips must be a non-empty array of addresses");

    const actor = requestActor(req);
    const outcome = await migrateArchivedReservations(conflict, ips, { actor });
    if (req.body?.adopt === true) await acceptConflict(conflict, actor);

    res.json({ ok: true, ...outcome, adopted: req.body?.adopt === true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/chassis-swap/adopt — adopt the new chassis for every
// pending subnet of one (oldSerial, newSerial) swap (business rule 41(a)).
// Body: { oldSerial, newSerial, mergeOldAsset? }. mergeOldAsset folds the old
// gate's asset into the new gate's, which deletes an asset row, so it takes the
// same chained `assetMerge` gate as every other merge verb here.
router.post("/chassis-swap/adopt", async (req, res, next) => {
  try {
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }
    assertFleetWide(await resolveWriteScope(req, "discoveryConflicts"), "adopting a replacement FortiGate");
    const parsed = ChassisSwapSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError(400, "oldSerial and newSerial are required");
    const { oldSerial, newSerial, mergeOldAsset } = parsed.data;
    if (mergeOldAsset && !hasPermission(req, "assetMerge", "write")) {
      throw new AppError(403, "Merging assets requires the Merge Assets permission");
    }
    const outcome = await adoptChassisSwap(oldSerial, newSerial, {
      mergeOldAsset: mergeOldAsset === true,
      actor: requestActor(req),
      canManageIntegrations: hasPermission(req, "integrations", "write"),
    });
    res.json({ ok: true, ...outcome });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/chassis-swap/reject — dismiss every pending subnet of
// one swap. Body: { oldSerial, newSerial }.
router.post("/chassis-swap/reject", async (req, res, next) => {
  try {
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }
    assertFleetWide(await resolveWriteScope(req, "discoveryConflicts"), "rejecting a FortiGate replacement");
    const parsed = ChassisSwapSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError(400, "oldSerial and newSerial are required");
    const outcome = await rejectChassisSwap(parsed.data.oldSerial, parsed.data.newSerial, requestActor(req));
    res.json({ ok: true, ...outcome });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/accept
router.post("/:id/accept", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }
    await assertConflictInScope(req, conflict, "resolve");

    await assertCanReactivate(req, conflict);
    await acceptConflict(conflict, requestActor(req));

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/merge — asset conflicts only. TWO bodies, chosen
// by the conflict's flavour:
//   • duplicate-IP      → { survivorAssetId, absorbAssetIds: [...] } — the
//     records are one device; absorb the duplicates into the survivor via the
//     operator merge engine. Needs `assets:fullwrite` on top of
//     discoveryConflicts:write.
//   • duplicate-serial  → the same body, the same gate, the same engine
//     (business rule 83). The contested-serial flavour has NO merge: it is one
//     asset and two gates, not two assets.
//   • everything else → per-field winner selection, below.
// Body: { fieldWinners: { hostname: "existing"|"proposed", ... } }.
// Fields not present in fieldWinners fall back to the default accept logic
// (today's behavior — blank-fill for most, always-overwrite for os/osVersion,
// NetBIOS upgrade for hostname). Resolves the conflict the same way Accept
// does: stamps the AssetSource row, absorbs ghost assets, marks status accepted.
router.post("/:id/merge", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    if (conflict.entityType !== "asset") {
      throw new AppError(400, "Merge with per-field selection is only supported for asset conflicts");
    }
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }

    // Duplicate-IP conflicts share the verb but not the body: there is no
    // proposed side to pick fields from, so the operator names a SURVIVOR and
    // the records to absorb into it ("these are one device recorded twice").
    // Same chained gate as /reassign-ip — it deletes asset rows.
    const proposedKind = (conflict.proposedAssetFields || {}) as Record<string, unknown>;
    if (proposedKind.collisionReason === DUPLICATE_IP_COLLISION_REASON) {
      // Merging is editing one asset AND deleting another, so it takes the
      // assets key's destructive tier — the same level `POST /assets/:id/merge`
      // requires, and the level the merge modal is gated on client-side. The
      // reassign verb below stays at `write`: it edits, it deletes nothing.
      if (!hasPermission(req, "assetMerge", "write")) {
        throw new AppError(403, "Merging assets requires the Merge Assets permission");
      }
      const survivorAssetId =
        typeof req.body?.survivorAssetId === "string" ? req.body.survivorAssetId : "";
      if (!survivorAssetId) throw new AppError(400, "survivorAssetId is required");
      const absorbAssetIds = Array.isArray(req.body?.absorbAssetIds)
        ? req.body.absorbAssetIds.filter((v: unknown): v is string => typeof v === "string")
        : [];

      const outcome = await mergeDuplicateIpAssets(
        conflict,
        survivorAssetId,
        absorbAssetIds,
        requestActor(req),
        { canManageIntegrations: hasPermission(req, "integrations", "write") },
      );

      res.json({ ok: true, ...outcome });
      return;
    }

    // Duplicate-serial conflicts take the same body for the same reason: one
    // device recorded twice, and the operator names which record survives.
    // Same chained `assetMerge` gate — it deletes asset rows.
    if (proposedKind.collisionReason === DUPLICATE_SERIAL_COLLISION_REASON) {
      if (!hasPermission(req, "assetMerge", "write")) {
        throw new AppError(403, "Merging assets requires the Merge Assets permission");
      }
      const survivorAssetId =
        typeof req.body?.survivorAssetId === "string" ? req.body.survivorAssetId : "";
      if (!survivorAssetId) throw new AppError(400, "survivorAssetId is required");
      const absorbAssetIds = Array.isArray(req.body?.absorbAssetIds)
        ? req.body.absorbAssetIds.filter((v: unknown): v is string => typeof v === "string")
        : [];

      const outcome = await mergeDuplicateSerialAssets(
        conflict,
        survivorAssetId,
        absorbAssetIds,
        requestActor(req),
        { canManageIntegrations: hasPermission(req, "integrations", "write") },
      );

      res.json({ ok: true, ...outcome });
      return;
    }

    await assertCanReactivate(req, conflict);
    const raw = (req.body && req.body.fieldWinners) || {};
    const fieldWinners: Record<string, "existing" | "proposed"> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === "existing" || v === "proposed") fieldWinners[k] = v;
    }

    await mergeAssetConflict(conflict, requestActor(req), fieldWinners);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/reassign-ip — duplicate-IP conflicts only.
// Body: { assetId, ipAddress }. Gives ONE of the assets sharing the address a
// new one (operator-pin semantics, like editing IP Address on the asset form)
// and closes the conflict once fewer than two current claims remain.
//
// CHAINED gate — discoveryConflicts:write AND assets:write (the
// /network-scans/:id/adopt precedent): resolving conflict queue entries and
// editing device inventory are separable grants, and this verb needs both.
router.post("/:id/reassign-ip", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }
    await assertConflictInScope(req, conflict, "resolve");
    if (!hasPermission(req, "assets", "write")) {
      throw new AppError(403, "You do not have permission to change an asset's IP address");
    }
    const assetId = typeof req.body?.assetId === "string" ? req.body.assetId : "";
    const ipAddress = typeof req.body?.ipAddress === "string" ? req.body.ipAddress : "";
    if (!assetId) throw new AppError(400, "assetId is required");
    await assertNamedAssetInScope(req, assetId);

    const outcome = await reassignDuplicateIpAsset(
      conflict,
      assetId,
      ipAddress,
      requestActor(req),
      { canManageIntegrations: hasPermission(req, "integrations", "write") },
    );

    res.json({ ok: true, ...outcome });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/keep-reservation — duplicate-reservation
// conflicts only (business rule 139). Body: { reservationId }. Keeps that
// reservation and releases every other one in the set — off the gate when
// DHCP writeback is on, and off the asset (rule 102(b)). Releasing is what
// DELETE /reservations/:id does, so it takes the same gate: reservations
// write, and below Full RW only the rows the caller created — every row is
// checked before any is released.
router.post("/:id/keep-reservation", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    // Rule 141 (e) / (f): this flavour is a reservations task — Read on
    // Discovery Conflicts to see it, Read-Write on Reservations (with a binding
    // in scope) to resolve it; discoveryConflicts:write is not required.
    if (!hasPermission(req, "discoveryConflicts", "read")) {
      throw new AppError(403, "You do not have permission to view discovery conflicts");
    }
    assertDuplicateReservationRelease(req, conflict);
    await assertDhcpBindingInScope(req, conflict);
    const parsed = KeepReservationSchema.parse(req.body ?? {});
    const outcome = await keepOneReservation(conflict, parsed.reservationId, requestActor(req), () => {});
    res.json({ ok: true, resolved: outcome.failed.length === 0, ...outcome });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/release-reservation — duplicate-reservation
// conflicts only (business rule 139). Body: { reservationId }. Releases that
// ONE binding — a reservation, or a lease (revoked on the gate when DHCP
// writeback is on) — through releaseReservation. The conflict resolves once
// what is left no longer holds two bindings with a reservation among them.
// Same gate as /keep-reservation.
router.post("/:id/release-reservation", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    // Rule 141 (e) / (f): this flavour is a reservations task — Read on
    // Discovery Conflicts to see it, Read-Write on Reservations (with a binding
    // in scope) to resolve it; discoveryConflicts:write is not required.
    if (!hasPermission(req, "discoveryConflicts", "read")) {
      throw new AppError(403, "You do not have permission to view discovery conflicts");
    }
    assertDuplicateReservationRelease(req, conflict);
    await assertDhcpBindingInScope(req, conflict);
    const parsed = KeepReservationSchema.parse(req.body ?? {});
    const outcome = await releaseOneReservation(conflict, parsed.reservationId, requestActor(req), () => {});
    res.json({ ok: true, ...outcome });
  } catch (err) {
    next(err);
  }
});

// Both duplicate-reservation verbs release reservations, so they take what
// DELETE /reservations/:id takes: reservations write. Below Full RW the
// conflict must hold at least one binding in the caller's scope (rule 141
// (f)); once it does, EVERY binding in it may be released — including on a
// gate in another region — which is why the per-row ownership callback the
// services accept is a no-op here.
function assertDuplicateReservationRelease(req: Request, conflict: { proposedAssetFields?: unknown }): void {
  const kind = (conflict.proposedAssetFields || {}) as Record<string, unknown>;
  if (kind.collisionReason !== DUPLICATE_RESERVATION_COLLISION_REASON) {
    throw new AppError(400, "Only a duplicate DHCP reservation conflict is resolved by keeping or releasing a reservation");
  }
  if (!hasPermission(req, "reservations", "write")) {
    throw new AppError(403, "Releasing reservations requires read-write on Reservations");
  }
}

/**
 * Rule 141 (f): at least one binding of the duplicate-reservation group is in
 * the caller's reservations write scope — the reservation is theirs, or its
 * network or the conflicted device carries one of their tags.
 */
async function assertDhcpBindingInScope(req: Request, conflict: any): Promise<void> {
  const scope = await resolveWriteScope(req, "reservations");
  if (scope.kind === "all") return;
  const fields = (conflict.proposedAssetFields || {}) as Record<string, unknown>;
  const ids = Array.isArray(fields.reservations)
    ? (fields.reservations as { reservationId?: unknown }[]).map((r) => (r && typeof r.reservationId === "string" ? r.reservationId : "")).filter(Boolean)
    : [];
  const rows = ids.length
    ? await prisma.reservation.findMany({ where: { id: { in: ids } }, select: { createdBy: true, subnet: { select: { tags: true } } } })
    : [];
  const records = rows.map((r) => reservationScopeRecord(r, conflict.asset));
  if (conflict.asset) records.push({ createdBy: conflict.asset.createdBy ?? null, tags: conflict.asset.tags ?? [] });
  if (!records.some((r) => inWriteScope(scope, r))) {
    throw new AppError(403, "Forbidden — you can only resolve a duplicate-reservation conflict that holds a reservation you created or a network / device carrying one of your tags");
  }
}

// POST /api/v1/conflicts/:id/clear-ip — duplicate-IP conflicts only.
// Body: { assetId }. Blanks ONE member's address — the device is offline, so
// there is no new address to type (business rule 40(j)). The next discovery
// write staging a different address fills the blank. Same chained gate and
// close-when-fewer-than-two semantics as /reassign-ip.
router.post("/:id/clear-ip", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }
    await assertConflictInScope(req, conflict, "resolve");
    if (!hasPermission(req, "assets", "write")) {
      throw new AppError(403, "You do not have permission to change an asset's IP address");
    }
    const assetId = typeof req.body?.assetId === "string" ? req.body.assetId : "";
    if (!assetId) throw new AppError(400, "assetId is required");
    await assertNamedAssetInScope(req, assetId);

    const outcome = await clearDuplicateIpAsset(conflict, assetId, requestActor(req));

    res.json({ ok: true, ...outcome });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/reject
router.post("/:id/reject", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }
    await assertConflictInScope(req, conflict, "resolve");

    await rejectConflict(conflict, requestActor(req));

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
