/**
 * src/api/middleware/permissions.ts — Dynamic-role permission resolver
 *
 * Replaces the prior hardcoded-role guards (requireAdmin / requireNetworkAdmin /
 * requireAssetsAdmin / requireUserOrAbove / isNetworkAdminOrAbove). The session
 * carries a denormalized snapshot of the user's Role (id, name, permissions,
 * updatedAt). Each request checks `permissions[functionKey]` against the
 * required access level; the snapshot is auto-refreshed when the role has
 * been edited since the snapshot was taken.
 *
 * Bearer-token callers (ApiToken) resolve through the SAME gate: each token
 * is bound to a Role at mint time, and requirePermission resolves the token's
 * role matrix (in-process cache, invalidated by bumpRoleVersion) exactly like
 * a session snapshot. The prior parallel scope-string system
 * (requireSessionOrTokenPermission + KNOWN_SCOPES) was retired in the
 * api-tokens role cutover (migration 20260706000000).
 *
 * What this module owns:
 *   - The function-key catalogue (exported as FUNCTION_KEYS).
 *   - The access-level ordering (none < read < write < fullwrite).
 *   - requirePermission / hasPermission / requireOwnership middleware factories.
 *   - The snapshot refresh path for sessions (Map<roleId, updatedAt> cache +
 *     Prisma fetch) and tokens (Map<roleId, snapshot> cache, same version map).
 *   - bumpRoleVersion(roleId, updatedAt) — called by roleService after every write.
 *
 * Cache semantics:
 *   - In-process Map<roleId, isoString>. Empty at boot; lazily populated on first
 *     request per role. Subsequent requests are O(1) until the role is edited.
 *   - bumpRoleVersion bumps the entry. Any request whose session snapshot has an
 *     older updatedAt triggers one Prisma fetch + req.session.save() to persist
 *     the fresh snapshot. Token snapshots refetch on the same version mismatch.
 *   - Changing a USER's roleId takes effect on next login (we don't iterate the
 *     session store). Changing a ROLE's permissions takes effect on next request
 *     for every session or token that holds that roleId. The latter is the
 *     common case.
 */

import { Request, Response, NextFunction } from "express";
import { AppError } from "../../utils/errors.js";
import { prisma } from "../../db.js";

// ─── Function-key catalogue ────────────────────────────────────────────
//
// One row per top-level functional area an operator can grant/revoke.
// Order is the order the UI matrix renders. Adding a key requires a
// migration to seed it on every existing Role + a corresponding guard
// on whatever routes the key covers.

export type AccessLevel = "none" | "read" | "write" | "fullwrite";

export const ACCESS_LEVELS: readonly AccessLevel[] = ["none", "read", "write", "fullwrite"] as const;

const ACCESS_RANK: Record<AccessLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  fullwrite: 3,
};

export interface FunctionKeyDef {
  key: string;
  label: string;
  description: string;
  // Functions where the "write" level applies an ownership filter
  // (createdBy === username) and "fullwrite" bypasses it — subnets,
  // reservations, address-book contacts, and credentials.
  hasOwnershipDimension?: boolean;
  // The access levels this key can actually hold. Omitted = the full
  // ladder (none < read < write < fullwrite). A key declares a SHORTER
  // ladder when the levels above the top one it supports would be
  // indistinguishable from it: `assetsProbe` is read-only by nature (a
  // probe dials the device and writes nothing in Polaris), so offering
  // Read-Write / Full Read-Write put two dead radio buttons in the matrix
  // and let an operator grant a level no route ever asks for. Enforced in
  // three places that must not drift: `normalizePermissions` clamps a
  // stored or incoming value DOWN into the ladder, the `requirePermission`
  // factory throws at module load if a route asks for a level the key
  // cannot hold, and the roles matrix renders only the supported cells
  // (the frontend reads this off GET /roles/functions).
  levels?: readonly AccessLevel[];
}

export const FUNCTION_KEYS: readonly FunctionKeyDef[] = [
  { key: "ipBlocks", label: "IP Blocks", description: "Top-level CIDR blocks. Read = list/view; write = create/edit/delete." },
  { key: "subnets", label: "Subnets", description: "Child subnets. Read-Write = create + edit/delete own only; Full Read-Write = create + edit/delete any.", hasOwnershipDimension: true },
  { key: "reservations", label: "Reservations", description: "IP reservations (incl. DHCP push to FortiGate). Read-Write = create + edit/delete own only; Full Read-Write = create + edit/delete any.", hasOwnershipDimension: true },
  { key: "allocationTemplates", label: "Allocation Templates", description: "Saved multi-subnet allocation templates used by the bulk-allocate modal." },
  { key: "assets", label: "Assets", description: "Asset inventory CRUD + PDF/CSV export." },
  { key: "assetsQuarantine", label: "Asset Quarantine", description: "Push MAC quarantine to FortiGates + release + verify." },
  // Read-only by nature: a probe dials the device and writes nothing in
  // Polaris, so `read` IS the grant and there is no higher level to offer.
  // The outage SIMULATION that used to sit here (POST/DELETE
  // /assets/:id/dependency-test) does write — and can mask a real outage —
  // so it moved to `assetMonitorSettings=fullwrite`, which is the
  // admin-only level its own code comment always claimed for it.
  { key: "assetsProbe", label: "Asset Probes", description: "Manual probe-now, SNMP walk, forward/reverse DNS lookup on a specific asset. Read-only — a probe reads the device and changes nothing in Polaris, so Read is the whole grant.", levels: ["none", "read"] },
  { key: "networkScan", label: "Network Discovery", description: "Active scan of operator-supplied IP ranges: create / edit / run a Discovery and adopt what answers. Its own key rather than part of `assetsProbe` (probe-now / SNMP walk on ONE existing asset) — an unannounced sweep is IDS-visible. Read = browse the Discoveries you can see (your own, plus every SHARED one) + watch a run; Read-Write = create / run / edit + delete your own; Full Read-Write = edit + delete anyone's. PUBLISHING a Discovery for other operators needs only Read-Write — sharing is what the feature is for. Adopting the responders as assets additionally requires `assets` Read-Write, chained at the route.", hasOwnershipDimension: true },
  { key: "assetMonitorSettings", label: "Asset Monitor Settings", description: "Per-asset / class / integration / manual monitor cadence + retention overrides." },
  { key: "processControl", label: "Process Control", description: "Start / stop / restart a service-backed process on a host via the Polaris Agent. Operator-initiated, confirmed, and audited; the agent never self-acts." },
  { key: "mibDatabase", label: "MIB Database", description: "Upload / browse / walk SNMP MIB modules." },
  { key: "manufacturerProfiles", label: "Manufacturer Profiles", description: "Per-vendor telemetry profile (CPU/memory/temperature OIDs + custom widgets)." },
  { key: "manufacturerAliases", label: "Manufacturer Aliases", description: "Vendor-name normalization map." },
  { key: "credentials", label: "Credentials", description: "Stored SNMP / WinRM / SSH / REST / HTTP credentials for monitoring probes. Read = list (secrets masked) + see where each is wired; Read-Write = add + edit/delete/test own only; Full Read-Write = edit/delete/test any.", hasOwnershipDimension: true },
  { key: "integrations", label: "Integrations", description: "FortiManager / FortiGate / Windows Server / Entra ID / Active Directory integration CRUD + discovery." },
  { key: "discoveryConflicts", label: "Discovery Conflicts", description: "Accept / reject / merge reservation + asset conflicts raised by discovery." },
  { key: "deviceMap", label: "Device Map", description: "Geographic map of FortiGates + topology graphs." },
  { key: "applicationMap", label: "Application Map", description: "Application-connectivity topology built from mapped-process connections. Read = view the map; Read-Write = save/reset the shared layout." },
  { key: "mapRegions", label: "Map Regions", description: "Draw / edit / delete polygons that auto-tag enclosed FortiGates." },
  { key: "deviceIcons", label: "Device Icons", description: "Operator-uploaded icons overlaid on the topology graph." },
  { key: "events", label: "Events / Audit Log", description: "Audit log + syslog/SFTP archival settings + event retention." },
  { key: "alerts", label: "Alerts", description: "Triggered automation instances (Alerts tab). Read = view; Read-Write = acknowledge; Full Read-Write = clear." },
  { key: "automationManagement", label: "Automations", description: "Create / edit / delete automations + delivery channels. Full Read-Write = automation CRUD." },
  { key: "automationScripts", label: "Automation Scripts", description: "Script registry CRUD + attaching script actions to automations. Full Read-Write is remote-code-execution as the service account on the Polaris host and on agent-managed assets — grant only to admins." },
  { key: "maintenanceManagement", label: "Maintenance Schedules", description: "Maintenance windows that pause monitoring + notifications on matched assets, including the per-asset \"enter maintenance mode\" action. Read = view schedules + the calendar; Full Read-Write = schedule CRUD (Read-Write grants nothing beyond Read)." },
  { key: "contacts", label: "Address Book", description: "Named email addresses alerts can route to, each optionally owning a set of devices. Read = browse; Read-Write = add + edit/delete own only; Full Read-Write = edit/delete any.", hasOwnershipDimension: true },
  { key: "staleReservations", label: "Stale Reservations", description: "Snooze / ignore / un-ignore stale DHCP reservation alerts + the threshold setting." },
  { key: "apiTokens", label: "API Tokens", description: "Long-lived bearer tokens for external callers (SIEM quarantine, etc.)." },
  { key: "users", label: "Users", description: "User CRUD + role assignment + TOTP reset." },
  { key: "roles", label: "Roles", description: "Manage this permission matrix itself. Granting Full Read-Write effectively grants admin-equivalent control." },
  { key: "savedDashboards", label: "Saved Dashboards", description: "Named dashboard layouts saved on the server. Read = load a published dashboard + keep private ones of your own (the same thing the ungated per-user dashboard already allows); Read-Write = publish a PUBLIC dashboard, which reaches every operator and the unauthenticated Dash wallboard; Full Read-Write = delete anyone's." },
  { key: "serverSettingsSystem", label: "Server Settings — System", description: "HTTPS / branding / DNS / NTP / certificates / capacity advisor." },
  { key: "serverSettingsData", label: "Server Settings — Data", description: "Database backup / restore, queue mode, security tokens, in-app updates." },
] as const;

const FUNCTION_KEY_SET = new Set(FUNCTION_KEYS.map(f => f.key));

export function isValidFunctionKey(key: string): boolean {
  return FUNCTION_KEY_SET.has(key);
}

// ─── Per-key access ladders ────────────────────────────────────────────
//
// Most keys hold the full ladder. A key that declares `levels` holds only
// those — see the field's note on FunctionKeyDef. Unknown keys answer the
// full ladder so callers never have to special-case a legacy alias.

const FUNCTION_LEVELS = new Map<string, readonly AccessLevel[]>(
  FUNCTION_KEYS.filter(f => f.levels).map(f => [f.key, f.levels as readonly AccessLevel[]]),
);

/** The access levels `functionKey` can hold, in ladder order. */
export function levelsFor(functionKey: string): readonly AccessLevel[] {
  return FUNCTION_LEVELS.get(functionKey) ?? ACCESS_LEVELS;
}

/** Can `functionKey` hold `level` at all? */
export function keySupportsLevel(functionKey: string, level: AccessLevel): boolean {
  return levelsFor(functionKey).includes(level);
}

/**
 * Clamp `level` DOWN into `functionKey`'s ladder: the highest supported
 * level that is no higher than the one asked for. Always downward, never
 * up — a matrix that stored (or a client that posts) `fullwrite` on a
 * read-only key means "as much as possible", and rounding UP would be a
 * silent grant. Every supported ladder contains "none", so this always
 * resolves.
 */
export function clampLevelToKey(functionKey: string, level: AccessLevel): AccessLevel {
  const allowed = levelsFor(functionKey);
  if (allowed.includes(level)) return level;
  let best: AccessLevel = "none";
  for (const candidate of allowed) {
    if (ACCESS_RANK[candidate] <= ACCESS_RANK[level] && ACCESS_RANK[candidate] >= ACCESS_RANK[best]) {
      best = candidate;
    }
  }
  return best;
}

// ─── Legacy key aliases (Automations rename, 2026-07) ──────────────────
//
// The Automations redesign renamed two function keys. Stored Role matrices
// are rewritten by migration 20260721000000_automations_rbac_rename, but
// two caller populations still hold the OLD names after deploy:
//   - persisted session snapshots stamped before the deploy (the cold
//     roleVersionMap deliberately trusts the snapshot at boot, so without
//     a reverse lookup every live session would 403 on alerts until
//     re-login), and
//   - external clients POSTing role matrices with the old key names.
// LEGACY_KEY_ALIASES handles both: normalizePermissions folds legacy keys
// on write, and permissionOf falls back through the reverse map on read.

export const LEGACY_KEY_ALIASES: Record<string, string> = {
  notifications: "alerts",
  notificationManagement: "automationManagement",
};

const MODERN_TO_LEGACY: Record<string, string> = Object.fromEntries(
  Object.entries(LEGACY_KEY_ALIASES).map(([legacy, modern]) => [modern, legacy]),
);

/**
 * Resolve a function key's access level from a permissions matrix,
 * falling back to the key's pre-rename alias when the modern key is
 * absent (pre-deploy session snapshots). Never throws.
 */
export function permissionOf(
  permissions: Record<string, AccessLevel | undefined>,
  functionKey: string,
): AccessLevel {
  const direct = permissions[functionKey];
  if (typeof direct === "string" && isValidAccessLevel(direct)) {
    return clampLevelToKey(functionKey, direct);
  }
  const legacy = MODERN_TO_LEGACY[functionKey];
  if (legacy) {
    const v = permissions[legacy];
    if (typeof v === "string" && isValidAccessLevel(v)) return clampLevelToKey(functionKey, v);
  }
  return "none";
}

export function isValidAccessLevel(level: string): level is AccessLevel {
  return level === "none" || level === "read" || level === "write" || level === "fullwrite";
}

/**
 * Sanitize an incoming permissions object: drop unknown keys, drop bad
 * values, default every function-key to "none" when missing. Returns a
 * fully-populated matrix ready to persist.
 */
export function normalizePermissions(input: unknown): Record<string, AccessLevel> {
  const out: Record<string, AccessLevel> = {};
  const raw = { ...(input && typeof input === "object" ? (input as Record<string, unknown>) : {}) };
  // Fold pre-rename keys onto their modern names when the modern key is
  // absent, so matrices written by stale UI clients / imported role JSON
  // survive the Automations rename. Modern key present always wins.
  for (const [legacy, modern] of Object.entries(LEGACY_KEY_ALIASES)) {
    const modernV = raw[modern];
    const legacyV = raw[legacy];
    const modernValid = typeof modernV === "string" && isValidAccessLevel(modernV);
    if (!modernValid && typeof legacyV === "string" && isValidAccessLevel(legacyV)) {
      raw[modern] = legacyV;
    }
  }
  for (const def of FUNCTION_KEYS) {
    const v = raw[def.key];
    const level = typeof v === "string" && isValidAccessLevel(v) ? v : "none";
    // Clamp into the key's own ladder, so a read-only key can never hold
    // a level no route asks for — whether the value came from an older
    // stored matrix, an imported role JSON, or a stale UI client.
    out[def.key] = clampLevelToKey(def.key, level);
  }
  return out;
}

// ─── Privilege ranking (group-mapping "highest privilege wins") ─────────
//
// When a user belongs to multiple mapped IdP groups, the highest-privilege
// matched role is applied. "Privilege" is ranked as:
//   1. Admin-equivalent (users=fullwrite AND roles=fullwrite) outranks any
//      non-admin role — reuses the same predicate as roleService's
//      lastAdminEquivalent guard so the two notions can't drift.
//   2. Otherwise the weighted sum of every function key's access level
//      (none0 / read1 / write2 / fullwrite3).
// Ties (genuinely equal-privilege roles) break deterministically by role id.

export function isAdminEquivalentPermissions(perms: Record<string, AccessLevel>): boolean {
  return perms.users === "fullwrite" && perms.roles === "fullwrite";
}

/**
 * True when the CALLER's own role is admin-equivalent. Reads the snapshot the
 * request already carries (bearer token first, then session), so it is only
 * meaningful after requirePermission / ensureRoleSnapshot has run.
 */
export function callerIsAdminEquivalent(req: Request): boolean {
  const snap = req.roleSnapshot ?? req.session?.roleSnapshot;
  if (!snap) return false;
  return isAdminEquivalentPermissions(normalizePermissions(snap.permissions));
}

/**
 * Business rule 48 — nobody may hand out authority they do not hold.
 *
 * `users:write` and `roles:write` are both a rung BELOW admin-equivalent
 * (users=fullwrite AND roles=fullwrite), and both used to be enough to
 * manufacture an admin: `users:write` could create an account on an
 * admin-equivalent role, or promote an existing one into it; `roles:write`
 * could simply add the two fullwrite grants to a role the holder already had.
 * Either route turned a delegated permission into full control of the install,
 * so the write/fullwrite distinction on those two keys meant nothing.
 *
 * The existing lastAdminEquivalent guard is the mirror of this one and does
 * not overlap: it stops the last admin being DEMOTED, this stops a non-admin
 * PROMOTING. Both must stay.
 *
 * Callers that already hold admin-equivalence are unaffected — this is not a
 * four-eyes rule, only a no-escalation one.
 */
export function assertNoPrivilegeEscalation(req: Request, targetPermissions: unknown, subject: string): void {
  if (!isAdminEquivalentPermissions(normalizePermissions(targetPermissions))) return;
  if (callerIsAdminEquivalent(req)) return;
  throw new AppError(
    403,
    `Forbidden — ${subject} carries admin-equivalent control (Full RW on both users and roles), `
    + "which your own role does not hold. Ask an administrator to make this change.",
  );
}

/** Numeric privilege rank for a permissions matrix. Higher = more privilege. */
export function rankRole(permissions: unknown): number {
  const perms = normalizePermissions(permissions);
  if (isAdminEquivalentPermissions(perms)) return Number.MAX_SAFE_INTEGER;
  let sum = 0;
  for (const def of FUNCTION_KEYS) {
    sum += ACCESS_RANK[perms[def.key] ?? "none"];
  }
  return sum;
}

/**
 * Pick the highest-privilege role id from a candidate list. Ties break by the
 * lexicographically-smallest id so the result is deterministic regardless of
 * input order. Returns null for an empty list.
 */
export function pickHighestPrivilegeRoleId(
  roles: readonly { id: string; permissions: unknown }[],
): string | null {
  let best: { id: string; rank: number } | null = null;
  for (const r of roles) {
    const rank = rankRole(r.permissions);
    if (best === null || rank > best.rank || (rank === best.rank && r.id < best.id)) {
      best = { id: r.id, rank };
    }
  }
  return best ? best.id : null;
}

// ─── Session snapshot shape ────────────────────────────────────────────

export interface SessionRoleSnapshot {
  id: string;
  name: string;
  isProtected: boolean;
  permissions: Record<string, AccessLevel>;
  updatedAt: string; // ISO; compared against the cached Map to trigger refresh
}

// ─── Role-version cache ────────────────────────────────────────────────

// Lazily populated. Empty Map at boot → first request per role triggers a
// Prisma fetch (the session snapshot's updatedAt will not match nothing,
// but our compare path treats a missing cache entry as "trust the snapshot"
// to avoid stampeding the DB on cold start; the entry is filled in by the
// snapshot loader's read).
const roleVersionMap = new Map<string, string>();

/**
 * Called by roleService.update / roleService.delete (and the initial seed
 * on first boot) to stamp the in-process cache with the freshest updatedAt.
 * Stale session snapshots that hold this roleId will refresh on next request.
 */
export function bumpRoleVersion(roleId: string, updatedAt: Date | string): void {
  const iso = typeof updatedAt === "string" ? updatedAt : updatedAt.toISOString();
  roleVersionMap.set(roleId, iso);
}

// Internal: load a Role from DB + stamp the version cache + project to
// the snapshot shape. Throws AppError(401) if the role no longer exists
// (covers admin-deleted-the-user's-role edge case — should be prevented
// by FK Restrict, but defense-in-depth).
async function loadRoleSnapshot(roleId: string): Promise<SessionRoleSnapshot> {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) {
    throw new AppError(401, "Your role no longer exists — please log in again.");
  }
  const updatedAtIso = role.updatedAt.toISOString();
  roleVersionMap.set(role.id, updatedAtIso);
  return {
    id: role.id,
    name: role.name,
    isProtected: role.isProtected,
    permissions: normalizePermissions(role.permissions),
    updatedAt: updatedAtIso,
  };
}

/**
 * Build a fresh snapshot from a Role row. Used by login + role-assign
 * paths that already have the Role in hand and want to stamp the session
 * without a second DB roundtrip.
 */
export function snapshotFromRole(role: {
  id: string;
  name: string;
  isProtected: boolean;
  permissions: unknown;
  updatedAt: Date;
}): SessionRoleSnapshot {
  const iso = role.updatedAt.toISOString();
  roleVersionMap.set(role.id, iso);
  return {
    id: role.id,
    name: role.name,
    isProtected: role.isProtected,
    permissions: normalizePermissions(role.permissions),
    updatedAt: iso,
  };
}

// ─── Snapshot resolution for a request ─────────────────────────────────

/**
 * Returns the up-to-date role snapshot for the current request — from the
 * bearer token's bound role when the caller presented one, otherwise from
 * the session (refreshing from DB when the cached role version is newer).
 * Returns null only for unauthenticated callers. The resolved snapshot is
 * memoized on req.roleSnapshot so later inline checks (hasPermission) are
 * synchronous.
 */
async function resolveSnapshot(req: Request): Promise<SessionRoleSnapshot | null> {
  if (req.roleSnapshot) return req.roleSnapshot;
  const snap = req.apiToken
    ? await resolveTokenSnapshot(req.apiToken.roleId)
    : await resolveSessionSnapshot(req);
  if (snap) req.roleSnapshot = snap;
  return snap;
}

// Token callers have no session to persist a snapshot into, so resolved
// snapshots live in an in-process Map keyed by roleId, invalidated through
// the same roleVersionMap that session snapshots use (bumpRoleVersion on
// every role write). Bounded by the number of distinct roles bound to live
// tokens — a handful of entries in practice.
const tokenSnapshotCache = new Map<string, SessionRoleSnapshot>();

async function resolveTokenSnapshot(roleId: string): Promise<SessionRoleSnapshot> {
  const cached = tokenSnapshotCache.get(roleId);
  if (cached) {
    const ver = roleVersionMap.get(roleId);
    if (!ver) {
      // Cold version cache: trust the snapshot and warm the cache (same
      // anti-stampede reasoning as the session path below).
      roleVersionMap.set(roleId, cached.updatedAt);
      return cached;
    }
    if (ver === cached.updatedAt) return cached;
  }
  const fresh = await loadRoleSnapshot(roleId);
  tokenSnapshotCache.set(roleId, fresh);
  return fresh;
}

/**
 * Session path: refreshes the session snapshot from DB when the cached role
 * version is newer. Returns null when there is no logged-in session.
 *
 * Persists session writes via session.save() so the refresh is durable
 * across the response cycle.
 */
async function resolveSessionSnapshot(req: Request): Promise<SessionRoleSnapshot | null> {
  if (!req.session?.userId) return null;
  // Old-session self-heal: a session issued before the dynamic-roles
  // cutover (`829b80a`) carries `req.session.userId` + a string
  // `req.session.role` but no `roleId` / `roleSnapshot`. Without this
  // fallback, the operator's existing session 403s on every guarded
  // route until they log out and back in — including the page-level
  // redirect in app.ts, which silently bounces them home. Look up
  // the user, stamp the new fields, and continue. One DB hit per
  // surviving old session; subsequent requests use the snapshot.
  if (!req.session.roleId) {
    const u = await prisma.user.findUnique({
      where: { id: req.session.userId },
      include: { role: true },
    });
    if (!u) return null;
    const fresh = snapshotFromRole(u.role);
    req.session.roleId = u.roleId;
    req.session.roleSnapshot = fresh;
    req.session.role = u.role.name;
    await new Promise<void>((resolve, reject) => {
      req.session.save(err => (err ? reject(err) : resolve()));
    });
    return fresh;
  }
  const snap = req.session.roleSnapshot;
  if (snap && snap.id === req.session.roleId) {
    const cached = roleVersionMap.get(snap.id);
    if (cached && cached === snap.updatedAt) {
      // Hot path: same role, same version. No DB hit.
      return snap;
    }
    if (!cached) {
      // Cold cache + we have a snapshot: trust the snapshot and warm the cache.
      // Avoids a stampede right after process start where every concurrent
      // request would otherwise issue its own findUnique.
      roleVersionMap.set(snap.id, snap.updatedAt);
      return snap;
    }
    // Cached version is newer (an admin edited the role). Fall through to refetch.
  }
  const fresh = await loadRoleSnapshot(req.session.roleId);
  req.session.roleSnapshot = fresh;
  // Keep the legacy flat fields in sync so any straggler reads see the new name.
  req.session.role = fresh.name;
  await new Promise<void>((resolve, reject) => {
    req.session.save(err => (err ? reject(err) : resolve()));
  });
  return fresh;
}

/**
 * Exported wrapper around `resolveSnapshot` for callers outside the
 * middleware factories that need the same old-session self-heal (and, for
 * bearer callers, the token role resolution) — the page-level static-HTML
 * redirect in `app.ts` and the dashboard's filter-don't-403 handlers.
 * Returns the snapshot or null for unauthenticated callers. After it
 * resolves, `hasPermission(req, ...)` works for sessions and tokens alike.
 */
export async function ensureRoleSnapshot(req: Request): Promise<SessionRoleSnapshot | null> {
  return resolveSnapshot(req);
}

/**
 * Does `actual` satisfy `required`? Exported because the ack-link and
 * recipient services answer "may this user acknowledge?" away from any
 * request — a role matrix, not a session — and must not re-derive the ladder.
 */
export function rankMeets(actual: AccessLevel, required: AccessLevel): boolean {
  return ACCESS_RANK[actual] >= ACCESS_RANK[required];
}

// ─── Public middleware factories ───────────────────────────────────────

/**
 * Express middleware factory. 403 unless the caller's role grants at
 * least `required` on `functionKey`. Applies to sessions AND bearer-token
 * callers alike — a token resolves the Role it was bound to at mint time.
 */
export function requirePermission(functionKey: string, required: AccessLevel) {
  if (!isValidFunctionKey(functionKey)) {
    throw new Error(`requirePermission: unknown functionKey "${functionKey}"`);
  }
  // A route asking for a level the key cannot hold would be permanently
  // unreachable (nothing can grant it), so this is a boot-time failure
  // rather than a 403 nobody can explain. Throws at module load —
  // tests/unit/routerBoots.test.ts is what turns it into a red build.
  if (!keySupportsLevel(functionKey, required)) {
    throw new Error(
      `requirePermission: "${functionKey}" cannot hold "${required}" ` +
      `(supported: ${levelsFor(functionKey).join(", ")})`,
    );
  }
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const snap = await resolveSnapshot(req);
      if (!snap) {
        return next(new AppError(403, "Forbidden — no role resolved for caller"));
      }
      const actual = permissionOf(snap.permissions, functionKey);
      if (!rankMeets(actual, required)) {
        return next(new AppError(403, `Forbidden — your role lacks ${required} access on ${functionKey}`));
      }
      req.permissionLevel = actual;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Boolean inline check for handlers that need conditional behavior
 * (e.g. "if FullRW, skip the ownership filter"). Returns true when the
 * caller has at least `required` on the functionKey. NEVER throws —
 * returns false when no snapshot has been resolved yet.
 *
 * Synchronous because it reads the snapshot already attached to the
 * request (token callers) or session. Use AFTER a `requirePermission(...)`
 * guard or `ensureRoleSnapshot(req)` has run, which guarantees the
 * snapshot is fresh.
 */
export function hasPermission(req: Request, functionKey: string, required: AccessLevel): boolean {
  const snap = req.roleSnapshot ?? req.session?.roleSnapshot;
  if (!snap) return false;
  return rankMeets(permissionOf(snap.permissions, functionKey), required);
}

/**
 * Composite guard for ownership-dimensioned functions (subnets / reservations).
 * Requires at least "write"; handler reads req.permissionLevel to decide
 * whether to apply the createdBy filter:
 *
 *   if (req.permissionLevel !== "fullwrite" && row.createdBy !== req.session.username) ...
 */
export function requireOwnership(functionKey: string) {
  return requirePermission(functionKey, "write");
}

/**
 * Ownership-dimension row check for `subnets` / `reservations` (see
 * polaris-api-rbac -> auth-rbac.md "Ownership model"): a `write`-level caller may only touch rows
 * whose createdBy matches their username; `fullwrite` bypasses the filter.
 * Call after loading the row, on routes behind requireOwnership (which
 * stamps req.permissionLevel). `action` reads as "you can only <action>
 * you created" — e.g. "edit networks", "release reservations". Previously
 * this predicate was hand-rolled at five call sites with drifting messages
 * (and one copy forgetting the fullwrite bypass was the standing risk).
 */
export function assertOwnership(req: Request, createdBy: string | null, action: string): void {
  if (req.permissionLevel === "fullwrite") return;
  if (createdBy !== null && createdBy === req.session?.username) return;
  throw new AppError(403, `Forbidden — you can only ${action} you created`);
}

// requireSessionOrTokenPermission retired in the api-tokens role cutover —
// bearer tokens are bound to a Role and pass the plain requirePermission
// gate; there is no parallel scope-string system anymore.
