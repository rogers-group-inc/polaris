/**
 * src/services/writeScopeService.ts — what a Read-Write caller may CHANGE
 * (business rule 141 (e), 2026-11-04).
 *
 * On a tag-scoped key (`tagScoped` on FunctionKeyDef — assets, quarantine,
 * alerts, maintenance, conflicts, stale reservations, Device Map layouts,
 * plus subnets and reservations, which already had the owner half):
 *
 *   Full Read-Write          → every record.
 *   Read-Write, no tags      → only records the caller OWNS: `createdBy`
 *                              equals the actor (a username, or `api:<token>`
 *                              for a bearer token — tokens own what they
 *                              create; name-keyed, so renaming a token orphans
 *                              its rows).
 *   Read-Write, with tags    → owned records PLUS any record carrying one of
 *                              the caller's tags.
 *
 * Tags only widen. A record with no owner and no tags (everything integration
 * discovery brings in) is Full Read-Write only. The caller's tags are
 * `union(user, group-derived)` per dimension (`regionScopeService`; a role
 * carries none since rule 141 (c)), and a bearer token therefore has none.
 *
 * The two dimensions are compared SEPARATELY, as the alert router does for
 * region-only routing and the recipient index's own comment warns: a record
 * tag `region:<r>` matches the caller's REGION `r`, any other record tag
 * matches a caller OTHER tag. Pooling them would let an other-tag "Atlanta"
 * reach `region:Atlanta`. Case-insensitive, trimmed.
 *
 * Owner-only mode (`ownerOnly: true`) ignores tags; it is how `assertOwnership`
 * keeps contacts / credentials / networkScan at "rows you created" (rule 43(c)).
 *
 * A request with no actor (the Dash wallboard, an unauthenticated read) is
 * `kind: "none"`: flags come back false and nothing throws — the gates in
 * front of such a request already refused writes.
 *
 * Scale: one user lookup per request per key (memoised on `req`), then pure
 * set lookups per record. Bulk verbs load their rows with one `findMany` and
 * check EVERY row before any write (`assertAllInWriteScope`), so a selection
 * with one out-of-scope row changes nothing.
 */

import type { Request } from "express";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { requestActor } from "../api/middleware/auth.js";
import { hasPermission } from "../api/middleware/permissions.js";
import { REGION_TAG_PREFIX, stripRegionPrefix } from "../utils/tagNormalize.js";
import { resolveTagScopesForUser } from "./regionScopeService.js";

export type WriteScope =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "scoped"; actor: string; regions: ReadonlySet<string>; tags: ReadonlySet<string> };

/** The two columns a record is judged on. `tags` may be absent (a reservation). */
export interface ScopeRecord {
  createdBy: string | null | undefined;
  tags?: readonly string[] | null;
}

const norm = (s: string): string => String(s ?? "").trim().toLowerCase();

interface ScopedRequest extends Request {
  _writeScopeByKey?: Map<string, WriteScope>;
}

/**
 * The caller's write scope for `key`. Memoised per request + key.
 * `ownerOnly` keys (contacts, credentials, networkScan) get empty tag sets so
 * the tag half can never widen them.
 */
export async function resolveWriteScope(req: Request, key: string, opts: { ownerOnly?: boolean } = {}): Promise<WriteScope> {
  const r = req as ScopedRequest;
  const cacheKey = `${key}:${opts.ownerOnly ? "owner" : "tags"}`;
  const cached = r._writeScopeByKey?.get(cacheKey);
  if (cached) return cached;

  let scope: WriteScope;
  if (hasPermission(req, key, "fullwrite")) {
    scope = { kind: "all" };
  } else {
    const actor = requestActor(req);
    if (!actor) {
      scope = { kind: "none" };
    } else {
      let regions = new Set<string>();
      let tags = new Set<string>();
      if (!opts.ownerOnly && req.session?.userId) {
        const u = await prisma.user.findUnique({
          where: { id: req.session.userId },
          select: { regionTags: true, otherTags: true, ssoGroups: true, authProvider: true },
        });
        if (u) {
          const scopes = await resolveTagScopesForUser(u);
          regions = new Set(scopes.regionTags.effective.map(norm));
          tags = new Set(scopes.otherTags.effective.map(norm));
        }
      }
      scope = { kind: "scoped", actor, regions, tags };
    }
  }
  if (!r._writeScopeByKey) r._writeScopeByKey = new Map();
  r._writeScopeByKey.set(cacheKey, scope);
  return scope;
}

/** Pure: is this record reachable under this scope? */
export function inWriteScope(scope: WriteScope, rec: ScopeRecord): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "none") return false;
  if (rec.createdBy != null && rec.createdBy === scope.actor) return true;
  if (scope.regions.size === 0 && scope.tags.size === 0) return false;
  for (const raw of rec.tags ?? []) {
    const t = norm(raw);
    if (!t) continue;
    if (t.startsWith(REGION_TAG_PREFIX)) {
      if (scope.regions.has(norm(stripRegionPrefix(t)))) return true;
    } else if (scope.tags.has(t)) {
      return true;
    }
  }
  return false;
}

/**
 * 403 unless the record is in scope. `verb` reads as "you can only <verb>",
 * e.g. "edit assets", "acknowledge alerts". The message names both halves of
 * the rule so a tagless caller learns what would widen it.
 */
export function assertInWriteScope(scope: WriteScope, rec: ScopeRecord, verb: string): void {
  if (inWriteScope(scope, rec)) return;
  throw new AppError(403, `Forbidden — you can only ${verb} you created or that carry one of your tags`);
}

/**
 * Every record in scope, or 403 naming the first that is not — checked
 * before any write. `label(rec)` names the offender in the message.
 */
export function assertAllInWriteScope<T extends ScopeRecord>(
  scope: WriteScope,
  recs: readonly T[],
  verb: string,
  label?: (rec: T) => string,
): void {
  if (scope.kind === "all") return;
  for (const rec of recs) {
    if (inWriteScope(scope, rec)) continue;
    const who = label ? ` (${label(rec)})` : "";
    throw new AppError(403, `Forbidden — you can only ${verb} you created or that carry one of your tags${who}`);
  }
}

/**
 * Full Read-Write only: for a verb whose target is the whole fleet or a
 * fleet-wide setting, where "in scope" has no meaning.
 */
export function assertFleetWide(scope: WriteScope, what: string): void {
  if (scope.kind === "all") return;
  throw new AppError(403, `Forbidden — ${what} needs Full Read-Write`);
}

/**
 * The record a reservation is judged on: its own creator, and its network's
 * tags (a reservation carries none of its own). Optionally the asset it names,
 * so a device's tags reach its bindings too.
 */
export function reservationScopeRecord(
  r: { createdBy: string | null; subnet?: { tags?: readonly string[] | null } | null },
  asset?: { tags?: readonly string[] | null } | null,
): ScopeRecord {
  const tags = [...(r.subnet?.tags ?? []), ...(asset?.tags ?? [])];
  return { createdBy: r.createdBy, tags };
}

/** The four columns a maintenance window's scope is judged on. */
export interface ScheduleScopeRow {
  id: string;
  createdBy?: string | null;
  criteria?: unknown;
  assetIds?: readonly string[] | null;
  pathCheckIds?: readonly string[] | null;
}

/**
 * Rule 141 (e): whether the caller may edit / delete each maintenance window —
 * its creator, or (no device filter, no path checks) every explicit device in
 * scope; anything else is Full Read-Write. The verdict
 * `routes/maintenanceSchedules.ts → assertScheduleInScope` enforces, computed
 * with ONE asset read for the whole list.
 */
export async function scheduleCanEditMap(scope: WriteScope, rows: readonly ScheduleScopeRow[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (scope.kind !== "scoped") {
    for (const s of rows) out.set(s.id, scope.kind === "all");
    return out;
  }
  const ids = Array.from(new Set(rows.flatMap((s) => s.assetIds ?? [])));
  const assets = ids.length
    ? await prisma.asset.findMany({ where: { id: { in: ids } }, select: { id: true, createdBy: true, tags: true } })
    : [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  for (const s of rows) {
    const own = s.createdBy != null && s.createdBy === scope.actor;
    const hasCriteria = s.criteria != null && !(typeof s.criteria === "object" && Object.keys(s.criteria as object).length === 0);
    const targets = (s.assetIds ?? []).map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
    const explicitOk = !hasCriteria && (s.pathCheckIds ?? []).length === 0 && targets.length > 0 && targets.every((a) => inWriteScope(scope, a));
    out.set(s.id, own || explicitOk);
  }
  return out;
}

/** `scheduleCanEditMap` for windows named by id (an asset's covering schedules). */
export async function scheduleCanEditByIds(scope: WriteScope, scheduleIds: readonly string[]): Promise<Map<string, boolean>> {
  if (scheduleIds.length === 0 || scope.kind !== "scoped") return scheduleCanEditMap(scope, scheduleIds.map((id) => ({ id })));
  const rows = await prisma.maintenanceSchedule.findMany({
    where: { id: { in: [...scheduleIds] } },
    select: { id: true, createdBy: true, criteria: true, assetIds: true, pathCheckIds: true },
  });
  return scheduleCanEditMap(scope, rows);
}
