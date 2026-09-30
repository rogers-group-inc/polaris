/**
 * src/services/duplicateSerialConflictService.ts — serial-number conflicts
 *
 * Business rule 83. Two flavours, both `entityType="asset"` Conflict rows
 * alongside the address flavours in duplicateIpConflictService (same sweep
 * shape, same raise/refresh/auto-close lifecycle, same dedup-on-dismissal
 * convention — see that file's header for the variant table):
 *
 *   • `serial-two-controllers` — ONE managed device (FortiSwitch / FortiAP)
 *     whose serial is on the managed roster of TWO controller FortiGates at
 *     once. Evidence comes from `AssetControllerClaim`, which discovery
 *     re-asserts per gate per pass.
 *
 *   • `duplicate-serial` — TWO Asset rows carrying the same serial number,
 *     whatever discovered them. One device recorded twice; the answer is a
 *     merge, and the card offers exactly that.
 *
 * WHY THE FIRST ONE WAS INVISIBLE
 * `AssetSource` is unique on `(sourceKind, externalId)` and externalId for a
 * fortiswitch/fortiap IS the serial, so one managed device has exactly one
 * source row however many gates report it. The discovery switch/AP loops then
 * write `fortinetTopology` (controllerFortigate + controllerSerial) and
 * `discoveredByIntegrationId` unconditionally, so a second claiming gate did
 * not collide with anything — it overwrote, and the record flipped back on the
 * next pass of the first integration. Last-writer-wins with no record of the
 * loser, every pass, silently: the parent resolution behind dependency
 * suppression, Device Map membership, region tagging, description-sync
 * targeting and interface auto-monitor all followed the flapping stamp.
 * `AssetControllerClaim` is the missing evidence — one row per (device serial,
 * claiming controller) rather than one row per device.
 *
 * REPORT-ONLY (the deliberate scope, business rule 83)
 * Detecting the collision does not resolve it, and this service does not try:
 * discovery keeps its existing behaviour, nothing is frozen or pinned, and the
 * card's job is to put a human in front of the disagreement. Two reasons.
 * A genuine move (a stack rehomed onto another gate) and a stale roster entry
 * (the old gate never had the switch removed from its config) are the same
 * observation for as long as both gates keep answering — only a person knows
 * which one happened. And freezing the incumbent would invent a state an
 * operator has to clear before a legitimate move could land, which is a worse
 * failure than a flapping stamp because it is silent in the other direction.
 *
 * A CLAIM THAT STOPS BEING RE-ASSERTED AGES OUT
 * `CLAIM_FRESH_DAYS` is what makes the report-only stance self-cleaning: when
 * the losing gate stops listing the device, its claim goes stale, the group
 * drops below two controllers and the reconcile auto-closes the card. A
 * completed move therefore closes its own conflict without anybody clicking
 * anything; a stale roster entry keeps being re-asserted, and keeps the card.
 *
 * HA IS ONE GATE, NOT TWO
 * An HA cluster's members are separate serials, and FMG publishes a managed
 * roster per device, so a cluster would otherwise report every switch it owns
 * as contested. Claimants are folded to the FIREWALL ASSET they resolve to
 * before the count: every member serial of a cluster maps to the same Asset
 * through its `fortigate-firewall` AssetSource rows (discovery writes one per
 * member — see upsertFortigateFirewallAssetSource), so a cluster collapses to
 * one claimant. Resolution reuses `resolveInfraParentAsset` rather than
 * matching names, for the reason in utils/fortinetParentKey.ts: the stamped
 * controller name is FortiManager's device name and is under no obligation to
 * equal the gate's hostname.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { mergeAssets } from "./assetMergeService.js";
import { reconcileDuplicateIpForAddresses, repointDuplicateIpConflicts } from "./duplicateIpConflictService.js";
import { isUsableSerial } from "../utils/serialNumber.js";
import {
  buildInfraParentIndex,
  resolveInfraParentAsset,
  normalizeSerialKey,
  normalizeNameKey,
} from "../utils/fortinetParentKey.js";

export const SERIAL_CLAIM_COLLISION_REASON = "serial-two-controllers";
export const DUPLICATE_SERIAL_COLLISION_REASON = "duplicate-serial";

/** Prisma JSON filters matching each flavour's conflicts. */
const SERIAL_CLAIM_CONFLICT_WHERE = {
  entityType: "asset",
  proposedAssetFields: { path: ["collisionReason"], equals: SERIAL_CLAIM_COLLISION_REASON },
};
const DUPLICATE_SERIAL_CONFLICT_WHERE = {
  entityType: "asset",
  proposedAssetFields: { path: ["collisionReason"], equals: DUPLICATE_SERIAL_COLLISION_REASON },
};

/**
 * How long a controller's claim on a device stays current.
 *
 * Shorter than duplicate-IP's seven days on purpose, and the reasoning is the
 * opposite way round: an address claim ages because a DEVICE may have moved,
 * so generosity avoids false negatives; a controller claim is re-asserted by
 * every discovery pass of the integration that owns the gate, so a claim that
 * is two days old means ~48 hourly passes have gone by without that gate
 * listing the device. Long enough to survive an integration outage or a
 * weekend of failed runs, short enough that a completed rehome clears its card
 * within a working day rather than a week.
 */
export const CLAIM_FRESH_DAYS = 2;

/** Claims nothing has re-asserted in this long are deleted outright — the
 *  freshness cutoff already ignores them; this just keeps the table bounded. */
export const CLAIM_PRUNE_DAYS = 30;

/**
 * Statuses whose devices are not worth reporting a contested claim about.
 *
 * Deliberately NARROWER than `UNMONITORABLE_STATUSES` (business rule 10), which
 * is what the duplicate-IP sweep uses. That list answers "can this device be on
 * the network", which is the right question for an address collision. The
 * question here is "does the record have an owner", and a switch sitting in
 * `storage` (what discovery stamps for an Unauthorized FortiSwitch) or
 * `quarantined` still appears on the Device Map, still carries region tags and
 * still flaps between gates — so it still deserves the card. Only a device an
 * operator has written off (`decommissioned`) or switched off (`disabled`)
 * drops out.
 */
export const CLAIM_EXCLUDED_STATUSES = ["decommissioned", "disabled"] as const;

/**
 * How many assets may share one serial before the serial itself is the suspect
 * rather than the assets. Nine identical "serials" is a vendor default this
 * code has not met yet, not nine records of one device — and raising a card
 * naming nine unrelated machines teaches an operator to ignore the queue.
 */
export const MAX_PLAUSIBLE_DUPLICATES = 8;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Re-exported so this service stays the place rule 83 reads about serial
 * usability, while the rule itself lives in utils/serialNumber.ts — the
 * projection and the agent ingest path apply the SAME test at write time, so
 * a placeholder never becomes an Asset.serialNumber for this sweep to find.
 */
export { isUsableSerial } from "../utils/serialNumber.js";

/**
 * The dedupe key for ONE claiming controller.
 *
 * The serial is the identity (business rule 41: a name cannot tell a rename
 * from a replacement), so it wins whenever the gate published one. The
 * `name:`-prefixed fallback exists because a gate reported through some
 * transports publishes no serial at all, and a claim nobody can key is a claim
 * that would raise a fresh conflict every pass.
 */
export function controllerKeyFor(claim: {
  controllerSerial?: string | null;
  controllerDevice?: string | null;
}): string {
  const serial = normalizeSerialKey(claim.controllerSerial);
  if (serial) return serial;
  const name = normalizeNameKey(claim.controllerDevice);
  return name ? `name:${name}` : "";
}

export interface ControllerClaimRow {
  id: string;
  assetId: string;
  deviceSerial: string;
  sourceKind: string;
  controllerSerial: string | null;
  controllerDevice: string;
  controllerKey: string;
  integrationId: string | null;
  firstSeen: Date;
  lastSeen: Date;
  integrationName?: string | null;
  asset?: {
    id: string;
    hostname: string | null;
    assetType: string;
    status: string;
    fortinetTopology?: unknown;
  } | null;
}

export interface StoredClaimant {
  controllerKey: string;
  controllerDevice: string;
  controllerSerial: string | null;
  /** The firewall Asset this controller resolved to, when one exists — the
   *  card links it, and it is what folded HA members into one claimant. */
  controllerAssetId: string | null;
  integrationId: string | null;
  integrationName: string | null;
  firstSeen: string;
  lastSeen: string;
}

export interface ContestedSerialGroup {
  deviceSerial: string;
  assetId: string;
  hostname: string | null;
  assetType: string;
  sourceKind: string;
  claimants: StoredClaimant[];
}

/** Resolution context: which firewall Asset each controller key belongs to. */
export interface ControllerContext {
  assetIdByControllerKey: Map<string, string>;
  nameByAssetId: Map<string, string | null>;
  integrationNameById: Map<string, string>;
}

export const EMPTY_CONTROLLER_CONTEXT: ControllerContext = {
  assetIdByControllerKey: new Map(),
  nameByAssetId: new Map(),
  integrationNameById: new Map(),
};

/**
 * Fold one claim onto the identity that decides whether it is a DISTINCT
 * controller: the firewall Asset when the claim resolves to one (so every
 * member serial of an HA cluster collapses onto the cluster's asset), else the
 * claim's own key.
 */
export function claimFoldKey(claim: ControllerClaimRow, ctx: ControllerContext): string {
  const assetId = ctx.assetIdByControllerKey.get(claim.controllerKey);
  return assetId ? `asset:${assetId}` : claim.controllerKey;
}

function toStoredClaimant(claim: ControllerClaimRow, ctx: ControllerContext): StoredClaimant {
  const controllerAssetId = ctx.assetIdByControllerKey.get(claim.controllerKey) ?? null;
  return {
    controllerKey: claim.controllerKey,
    controllerDevice: claim.controllerDevice,
    controllerSerial: claim.controllerSerial,
    controllerAssetId,
    integrationId: claim.integrationId,
    integrationName: claim.integrationId
      ? ctx.integrationNameById.get(claim.integrationId) ?? claim.integrationName ?? null
      : claim.integrationName ?? null,
    firstSeen: claim.firstSeen.toISOString(),
    lastSeen: claim.lastSeen.toISOString(),
  };
}

/**
 * Group fresh claims into the serials that TWO OR MORE distinct controllers
 * hold at once.
 *
 * Pure so the folding rules are testable without a database — the caller
 * supplies the freshness cutoff and the resolution context.
 */
export function groupContestedSerials(
  claims: ControllerClaimRow[],
  cutoff: Date,
  ctx: ControllerContext = EMPTY_CONTROLLER_CONTEXT,
): ContestedSerialGroup[] {
  const bySerial = new Map<string, ControllerClaimRow[]>();
  for (const claim of claims) {
    if (claim.lastSeen < cutoff) continue;
    if (!isUsableSerial(claim.deviceSerial)) continue;
    const status = claim.asset?.status;
    if (status && (CLAIM_EXCLUDED_STATUSES as readonly string[]).includes(status)) continue;
    const key = normalizeSerialKey(claim.deviceSerial);
    if (!key) continue;
    const list = bySerial.get(key);
    if (list) list.push(claim);
    else bySerial.set(key, [claim]);
  }

  const groups: ContestedSerialGroup[] = [];
  for (const [serial, rows] of bySerial) {
    // One claim per distinct controller, keeping the most recently re-asserted
    // (a gate re-registered under a new FMG device entry publishes the same
    // chassis serial twice; that is one gate, and the newer row is the live one).
    const byFold = new Map<string, ControllerClaimRow>();
    for (const row of rows) {
      const fold = claimFoldKey(row, ctx);
      if (!fold) continue;
      const seen = byFold.get(fold);
      if (!seen || row.lastSeen > seen.lastSeen) byFold.set(fold, row);
    }
    if (byFold.size < 2) continue;

    // Newest claim first — the card leads with whichever gate spoke last,
    // because that is the one whose stamp the asset is currently carrying.
    const claimRows = [...byFold.values()].sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
    const primary = claimRows[0];
    groups.push({
      deviceSerial: serial,
      assetId: primary.assetId,
      hostname: primary.asset?.hostname ?? null,
      assetType: primary.asset?.assetType ?? "switch",
      sourceKind: primary.sourceKind,
      claimants: claimRows.map((c) => toStoredClaimant(c, ctx)),
    });
  }
  // Deterministic order so a test (and a log) reads the same twice.
  return groups.sort((a, b) => a.deviceSerial.localeCompare(b.deviceSerial));
}

/**
 * The claimant set, as a stable key. A dismissed conflict suppresses a re-raise
 * only while the SAME gates are arguing — a third gate joining, or one of the
 * two being replaced, is a new disagreement and raises again.
 */
export function claimantSetKey(claimants: Array<{ controllerKey: string }>): string {
  return claimants
    .map((c) => c.controllerKey)
    .filter(Boolean)
    .map((k) => k.toUpperCase())
    .sort()
    .join("|");
}

export interface DuplicateSerialMember {
  assetId: string;
  hostname: string | null;
  assetType: string;
  status: string;
  ipAddress: string | null;
  macAddress: string | null;
  lastSeen: string | null;
  discoveredByIntegrationId: string | null;
}

export interface DuplicateSerialGroup {
  serialNumber: string;
  members: DuplicateSerialMember[];
}

export interface DuplicateSerialAssetRow {
  id: string;
  hostname: string | null;
  serialNumber: string | null;
  assetType: string;
  status: string;
  ipAddress: string | null;
  macAddress: string | null;
  lastSeen: Date | null;
  discoveredByIntegrationId: string | null;
}

/**
 * Group asset rows into the serials TWO OR MORE of them carry.
 *
 * Unlike a shared address, a shared serial has exactly one innocent
 * explanation — the serial is not really a serial — so the filtering is all in
 * `isUsableSerial` and `MAX_PLAUSIBLE_DUPLICATES` rather than in claim
 * freshness or asset type. Anything that survives both is one device recorded
 * twice, which is why the card's only action is a merge.
 */
export function groupDuplicateSerialAssets(rows: DuplicateSerialAssetRow[]): DuplicateSerialGroup[] {
  const bySerial = new Map<string, DuplicateSerialAssetRow[]>();
  for (const row of rows) {
    if (!isUsableSerial(row.serialNumber)) continue;
    if ((CLAIM_EXCLUDED_STATUSES as readonly string[]).includes(row.status)) continue;
    const key = normalizeSerialKey(row.serialNumber);
    if (!key) continue;
    const list = bySerial.get(key);
    if (list) list.push(row);
    else bySerial.set(key, [row]);
  }

  const groups: DuplicateSerialGroup[] = [];
  for (const [serial, members] of bySerial) {
    if (members.length < 2) continue;
    if (members.length > MAX_PLAUSIBLE_DUPLICATES) {
      logger.debug(
        { serial, count: members.length },
        "duplicate-serial: ignoring a serial shared by more assets than any one device could be — treating it as a vendor default",
      );
      continue;
    }
    // Oldest record first: the survivor a merge should default to is the row
    // that has been carrying the device's history.
    const sorted = [...members].sort((a, b) => a.id.localeCompare(b.id));
    groups.push({
      serialNumber: serial,
      members: sorted.map((m) => ({
        assetId: m.id,
        hostname: m.hostname,
        assetType: m.assetType,
        status: m.status,
        ipAddress: m.ipAddress,
        macAddress: m.macAddress,
        lastSeen: m.lastSeen ? m.lastSeen.toISOString() : null,
        discoveredByIntegrationId: m.discoveredByIntegrationId,
      })),
    });
  }
  return groups.sort((a, b) => a.serialNumber.localeCompare(b.serialNumber));
}

/** The member a merge defaults to keeping, and the conflict's stable FK. */
export function pickPrimaryMemberId(members: Array<{ assetId: string }>): string | null {
  const ids = members.map((m) => m.assetId).filter(Boolean).sort();
  return ids[0] ?? null;
}

/**
 * Which members a merge absorbs. An explicit list is honoured (minus the
 * survivor); an empty one means "every other member", which is what the card's
 * single-click Merge sends.
 */
export function resolveMergeTargets(
  members: Array<{ assetId: string }>,
  survivorId: string,
  rawAbsorbIds: string[],
): string[] {
  const memberIds = new Set(members.map((m) => m.assetId).filter(Boolean));
  if (!memberIds.has(survivorId)) {
    throw new AppError(400, "The asset to keep is not one of the assets sharing this serial number");
  }
  const requested = rawAbsorbIds.filter(Boolean);
  const targets = (requested.length ? requested : [...memberIds]).filter((id) => id !== survivorId);
  for (const id of targets) {
    if (!memberIds.has(id)) {
      throw new AppError(400, `Asset ${id} is not one of the assets sharing this serial number`);
    }
  }
  if (!targets.length) {
    throw new AppError(400, "Nothing to merge — name at least one asset to absorb");
  }
  return [...new Set(targets)];
}

export function freshnessCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - CLAIM_FRESH_DAYS * 24 * 60 * 60 * 1000);
}

function conflictProposed(conflict: { proposedAssetFields: unknown }): Record<string, unknown> {
  return (conflict.proposedAssetFields || {}) as Record<string, unknown>;
}

export function conflictSerialOf(conflict: { proposedAssetFields: unknown }): string | null {
  const p = conflictProposed(conflict);
  const v = p.deviceSerial ?? p.serialNumber;
  return typeof v === "string" && v ? v : null;
}

export function conflictClaimantsOf(conflict: { proposedAssetFields: unknown }): StoredClaimant[] {
  const p = conflictProposed(conflict);
  return Array.isArray(p.claimants) ? (p.claimants as StoredClaimant[]) : [];
}

export function conflictMembersOf(conflict: { proposedAssetFields: unknown }): DuplicateSerialMember[] {
  const p = conflictProposed(conflict);
  return Array.isArray(p.members) ? (p.members as DuplicateSerialMember[]) : [];
}

// ─── Recording a claim (the discovery write path) ────────────────────────────

export interface ControllerClaimInput {
  assetId: string;
  deviceSerial: string;
  sourceKind: "fortiswitch" | "fortiap";
  controllerSerial: string | null;
  controllerDevice: string;
  integrationId: string | null;
}

/**
 * Persist one discovery pass's worth of controller claims.
 *
 * Called ONCE per integration sync with everything that pass saw, not once per
 * device: at 2000 managed devices a per-device round trip inside the switch/AP
 * loops would add 2000 sequential awaits to a run that already has plenty.
 * Writes go out in chunks inside a transaction, which is the
 * `for…of rows { await update }` anti-pattern's standard remedy (CLAUDE.md's
 * scale-check convention).
 *
 * Best-effort by design — a failure here costs the NEXT sweep some evidence,
 * and must never fail the discovery run that was only reporting inventory.
 */
export async function recordControllerClaims(inputs: ControllerClaimInput[]): Promise<number> {
  const seen = new Set<string>();
  const rows: Array<ControllerClaimInput & { controllerKey: string }> = [];
  for (const input of inputs) {
    const deviceSerial = normalizeSerialKey(input.deviceSerial);
    if (!isUsableSerial(deviceSerial)) continue;
    const controllerKey = controllerKeyFor(input);
    if (!controllerKey) continue;
    const dedupe = `${deviceSerial}|${controllerKey}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    rows.push({ ...input, deviceSerial, controllerKey });
  }
  if (!rows.length) return 0;

  const now = new Date();
  const CHUNK = 200;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    try {
      await prisma.$transaction(
        chunk.map((row) =>
          prisma.assetControllerClaim.upsert({
            where: {
              deviceSerial_controllerKey: {
                deviceSerial: row.deviceSerial,
                controllerKey: row.controllerKey,
              },
            },
            create: {
              assetId: row.assetId,
              deviceSerial: row.deviceSerial,
              sourceKind: row.sourceKind,
              controllerSerial: row.controllerSerial,
              controllerDevice: row.controllerDevice,
              controllerKey: row.controllerKey,
              integrationId: row.integrationId,
              firstSeen: now,
              lastSeen: now,
            },
            update: {
              // assetId moves with the device: a claim is about a SERIAL, and
              // the asset carrying that serial can change when records merge.
              assetId: row.assetId,
              sourceKind: row.sourceKind,
              controllerSerial: row.controllerSerial,
              controllerDevice: row.controllerDevice,
              integrationId: row.integrationId,
              lastSeen: now,
            },
          }),
        ),
      );
      written += chunk.length;
    } catch (err: any) {
      logger.warn(
        { err: err?.message || String(err), chunk: chunk.length },
        "failed to record controller claims for this discovery pass (conflict detection will use the previous pass's evidence)",
      );
    }
  }
  return written;
}

/** Drop claims nothing has re-asserted in `CLAIM_PRUNE_DAYS`. */
export async function pruneStaleControllerClaims(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CLAIM_PRUNE_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.assetControllerClaim.deleteMany({
    where: { lastSeen: { lt: cutoff } },
  });
  return count;
}

// ─── Loads ───────────────────────────────────────────────────────────────────

export async function loadFreshControllerClaims(cutoff: Date): Promise<ControllerClaimRow[]> {
  const rows = await prisma.assetControllerClaim.findMany({
    where: { lastSeen: { gte: cutoff } },
    select: {
      id: true,
      assetId: true,
      deviceSerial: true,
      sourceKind: true,
      controllerSerial: true,
      controllerDevice: true,
      controllerKey: true,
      integrationId: true,
      firstSeen: true,
      lastSeen: true,
      asset: {
        select: { id: true, hostname: true, assetType: true, status: true },
      },
    },
  });
  return rows as ControllerClaimRow[];
}

/**
 * Resolve every claiming controller to a firewall Asset.
 *
 * Two lookups, in the order utils/fortinetParentKey.ts documents:
 *   1. the `fortigate-firewall` AssetSource rows, whose externalId is a gate
 *      serial — this is the one that folds an HA cluster, because discovery
 *      writes one row per MEMBER serial against the cluster's single asset;
 *   2. `resolveInfraParentAsset` over the firewall assets, which covers a gate
 *      whose claim carries only a name (FMG device name first, hostname next).
 */
export async function loadControllerContext(claims: ControllerClaimRow[]): Promise<ControllerContext> {
  const assetIdByControllerKey = new Map<string, string>();
  const nameByAssetId = new Map<string, string | null>();
  const integrationNameById = new Map<string, string>();
  if (!claims.length) return { assetIdByControllerKey, nameByAssetId, integrationNameById };

  const serials = new Set(claims.map((c) => normalizeSerialKey(c.controllerSerial)).filter(Boolean));
  if (serials.size) {
    // Every firewall source row, not an `externalId: { in: [...] }` filter:
    // the claim's key is normalized (upper-cased) and the stored externalId is
    // whatever the transport reported, so an `in` comparison is
    // case-SENSITIVE and silently resolves nothing on any install whose gates
    // report a lower-case serial — which reads as "these are two gates" and
    // raises a conflict for every switch behind an HA cluster. The read is
    // bounded by the fleet's firewall count (one row per cluster MEMBER), not
    // by asset count, so normalizing in memory costs nothing at 2000 assets.
    const sources = await prisma.assetSource.findMany({
      where: { sourceKind: "fortigate-firewall" },
      select: { externalId: true, assetId: true },
    });
    for (const s of sources) {
      const key = normalizeSerialKey(s.externalId);
      if (key && serials.has(key)) assetIdByControllerKey.set(key, s.assetId);
    }
  }

  // Anything still unresolved is name-keyed (or a serial no source row knows).
  const unresolved = claims.filter((c) => !assetIdByControllerKey.has(c.controllerKey));
  if (unresolved.length) {
    const firewalls = await prisma.asset.findMany({
      where: { assetType: "firewall" },
      select: { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true },
    });
    const index = buildInfraParentIndex(firewalls);
    for (const claim of unresolved) {
      const hit = resolveInfraParentAsset(
        index,
        { serial: claim.controllerSerial, name: claim.controllerDevice },
        "firewall",
      );
      if (hit) assetIdByControllerKey.set(claim.controllerKey, hit.id);
    }
    for (const fw of firewalls) nameByAssetId.set(fw.id, fw.hostname);
  }

  const integrationIds = [...new Set(claims.map((c) => c.integrationId).filter(Boolean) as string[])];
  if (integrationIds.length) {
    const integrations = await prisma.integration.findMany({
      where: { id: { in: integrationIds } },
      select: { id: true, name: true },
    });
    for (const i of integrations) integrationNameById.set(i.id, i.name);
  }

  return { assetIdByControllerKey, nameByAssetId, integrationNameById };
}

/**
 * Every asset sharing a serial with another asset.
 *
 * Raw SQL for the grouping only: the `upper(btrim())` normalization has to
 * happen in the database to make the "at least two" prefilter meaningful, and
 * `groupDuplicateSerialAssets` (which knows about placeholders and fleet
 * defaults) makes every actual decision on the rows that come back. Reads only
 * — no writes here, so the db.ts extensions this bypasses do not matter.
 */
export async function loadDuplicateSerialAssets(): Promise<DuplicateSerialAssetRow[]> {
  const excluded = [...CLAIM_EXCLUDED_STATUSES];
  const rows = await prisma.$queryRaw<DuplicateSerialAssetRow[]>`
    SELECT a."id", a."hostname", a."serialNumber", a."assetType",
           a."status"::text AS status,
           a."ipAddress", a."macAddress", a."lastSeen", a."discoveredByIntegrationId"
    FROM "assets" a
    WHERE a."serialNumber" IS NOT NULL
      AND btrim(a."serialNumber") <> ''
      AND a."status"::text <> ALL(${excluded}::text[])
      AND upper(btrim(a."serialNumber")) IN (
        SELECT upper(btrim(b."serialNumber"))
        FROM "assets" b
        WHERE b."serialNumber" IS NOT NULL
          AND btrim(b."serialNumber") <> ''
          AND b."status"::text <> ALL(${excluded}::text[])
        GROUP BY upper(btrim(b."serialNumber"))
        HAVING count(*) > 1
      )
  `;
  return rows;
}

// ─── Reconcile ───────────────────────────────────────────────────────────────

export interface SerialReconcileResult {
  contestedSerials: number;
  duplicateSerials: number;
  raised: number;
  refreshed: number;
  closed: number;
  suppressed: number;
  pruned: number;
}

async function loadPending(where: Record<string, unknown>) {
  return prisma.conflict.findMany({
    where: { ...where, status: "pending" },
    orderBy: { createdAt: "asc" },
    select: { id: true, assetId: true, proposedAssetFields: true },
  });
}

async function loadLastResolved(where: Record<string, unknown>) {
  return prisma.conflict.findMany({
    where: { ...where, status: { not: "pending" } },
    orderBy: { resolvedAt: "desc" },
    select: { status: true, proposedAssetFields: true },
    take: 500,
  });
}

async function autoClose(id: string): Promise<void> {
  await prisma.conflict.update({
    where: { id },
    data: { status: "rejected", resolvedBy: "system:auto-resolved", resolvedAt: new Date() },
  });
}

/**
 * The sweep. Both flavours in one pass so a job tick is one entry point, and
 * because a duplicate RECORD and a contested CLAIM are the two things a serial
 * can be wrong about — an operator meets them in the same queue.
 *
 * Idempotent: a fleet with no serial trouble issues zero writes.
 */
export async function reconcileSerialConflicts(now: Date = new Date()): Promise<SerialReconcileResult> {
  const result: SerialReconcileResult = {
    contestedSerials: 0,
    duplicateSerials: 0,
    raised: 0,
    refreshed: 0,
    closed: 0,
    suppressed: 0,
    pruned: 0,
  };

  // ── Flavour 1: one device, two controllers ─────────────────────────────────
  const claims = await loadFreshControllerClaims(freshnessCutoff(now));
  const ctx = await loadControllerContext(claims);
  const contested = groupContestedSerials(claims, freshnessCutoff(now), ctx);
  result.contestedSerials = contested.length;

  const pendingClaims = await loadPending(SERIAL_CLAIM_CONFLICT_WHERE);
  const pendingBySerial = new Map<string, (typeof pendingClaims)[number]>();
  const strandedIds: string[] = [];
  for (const row of pendingClaims) {
    const serial = conflictSerialOf(row);
    if (!serial) continue;
    if (pendingBySerial.has(serial)) strandedIds.push(row.id);
    else pendingBySerial.set(serial, row);
  }
  if (strandedIds.length) {
    const stranded = await prisma.conflict.updateMany({
      where: { id: { in: strandedIds }, status: "pending" },
      data: { status: "rejected", resolvedBy: "system:auto-resolved", resolvedAt: new Date() },
    });
    result.closed += stranded.count;
  }

  const resolvedClaims = contested.length ? await loadLastResolved(SERIAL_CLAIM_CONFLICT_WHERE) : [];
  const lastResolvedBySerial = new Map<string, (typeof resolvedClaims)[number]>();
  for (const row of resolvedClaims) {
    const serial = conflictSerialOf(row);
    if (serial && !lastResolvedBySerial.has(serial)) lastResolvedBySerial.set(serial, row);
  }

  for (const group of contested) {
    const proposedAssetFields = {
      collisionReason: SERIAL_CLAIM_COLLISION_REASON,
      deviceSerial: group.deviceSerial,
      // The conflict-queue widget's subtitle reads `hostname`.
      hostname: group.hostname,
      assetType: group.assetType,
      sourceKind: group.sourceKind,
      claimants: group.claimants,
    } as any;
    const existingAssetSnapshot = {
      serialNumber: group.deviceSerial,
      hostname: group.hostname,
      claimants: group.claimants,
    } as any;

    const open = pendingBySerial.get(group.deviceSerial);
    if (open) {
      await prisma.conflict.update({
        where: { id: open.id },
        data: {
          proposedAssetFields,
          existingAssetSnapshot,
          // The device's asset can change under a merge; follow it so the
          // card keeps linking something that exists.
          ...(open.assetId === group.assetId ? {} : { assetId: group.assetId }),
        },
      });
      result.refreshed++;
      continue;
    }

    const lastResolved = lastResolvedBySerial.get(group.deviceSerial);
    const dismissedSameSet =
      lastResolved?.status === "rejected" &&
      claimantSetKey(conflictClaimantsOf(lastResolved)) === claimantSetKey(group.claimants);
    if (dismissedSameSet) {
      result.suppressed++;
      continue;
    }

    const created = await prisma.conflict.create({
      data: {
        entityType: "asset",
        assetId: group.assetId,
        conflictFields: ["fortinetTopology"],
        proposedAssetFields,
        existingAssetSnapshot,
      },
      select: { id: true },
    });
    result.raised++;
    const gates = group.claimants.map((c) => c.controllerDevice || c.controllerSerial || "unknown").join(" and ");
    const label = group.hostname || group.deviceSerial;
    logEvent({
      action: "conflict.detected",
      resourceType: "asset",
      resourceId: group.assetId,
      resourceName: label,
      actor: "system",
      message:
        `Serial ${group.deviceSerial} ("${label}") is on the managed roster of ${group.claimants.length} FortiGates: ${gates} — ` +
        `whichever ran discovery last owns the record`,
      details: {
        collisionReason: SERIAL_CLAIM_COLLISION_REASON,
        conflictId: created.id,
        deviceSerial: group.deviceSerial,
        assetId: group.assetId,
        controllers: group.claimants.map((c) => ({
          device: c.controllerDevice,
          serial: c.controllerSerial,
          integrationId: c.integrationId,
          lastSeen: c.lastSeen,
        })),
      },
    });
  }

  const liveSerials = new Set(contested.map((g) => g.deviceSerial));
  for (const [serial, row] of pendingBySerial) {
    if (liveSerials.has(serial)) continue;
    await autoClose(row.id);
    result.closed++;
    logEvent({
      action: "conflict.rejected",
      resourceType: "asset",
      resourceId: row.assetId ?? undefined,
      resourceName: serial,
      actor: "system",
      message:
        `Serial ${serial} is no longer claimed by two FortiGates — conflict auto-resolved ` +
        `(one controller stopped reporting the device, which is what a completed move looks like)`,
      details: { collisionReason: SERIAL_CLAIM_COLLISION_REASON, deviceSerial: serial },
    });
  }

  // ── Flavour 2: two records, one serial ─────────────────────────────────────
  const assetRows = await loadDuplicateSerialAssets();
  const duplicates = groupDuplicateSerialAssets(assetRows);
  result.duplicateSerials = duplicates.length;

  const pendingDupes = await loadPending(DUPLICATE_SERIAL_CONFLICT_WHERE);
  const pendingByDupeSerial = new Map<string, (typeof pendingDupes)[number]>();
  const strandedDupeIds: string[] = [];
  for (const row of pendingDupes) {
    const serial = conflictSerialOf(row);
    if (!serial) continue;
    if (pendingByDupeSerial.has(serial)) strandedDupeIds.push(row.id);
    else pendingByDupeSerial.set(serial, row);
  }
  if (strandedDupeIds.length) {
    const stranded = await prisma.conflict.updateMany({
      where: { id: { in: strandedDupeIds }, status: "pending" },
      data: { status: "rejected", resolvedBy: "system:auto-resolved", resolvedAt: new Date() },
    });
    result.closed += stranded.count;
  }

  const resolvedDupes = duplicates.length ? await loadLastResolved(DUPLICATE_SERIAL_CONFLICT_WHERE) : [];
  const lastResolvedDupeBySerial = new Map<string, (typeof resolvedDupes)[number]>();
  for (const row of resolvedDupes) {
    const serial = conflictSerialOf(row);
    if (serial && !lastResolvedDupeBySerial.has(serial)) lastResolvedDupeBySerial.set(serial, row);
  }

  for (const group of duplicates) {
    const proposedAssetFields = {
      collisionReason: DUPLICATE_SERIAL_COLLISION_REASON,
      serialNumber: group.serialNumber,
      hostname: group.members[0]?.hostname ?? null,
      members: group.members,
    } as any;
    const existingAssetSnapshot = { serialNumber: group.serialNumber, members: group.members } as any;
    const primaryId = pickPrimaryMemberId(group.members);
    if (!primaryId) continue;

    const open = pendingByDupeSerial.get(group.serialNumber);
    if (open) {
      const stillAMember = group.members.some((m) => m.assetId === open.assetId);
      await prisma.conflict.update({
        where: { id: open.id },
        data: {
          proposedAssetFields,
          existingAssetSnapshot,
          ...(stillAMember ? {} : { assetId: primaryId }),
        },
      });
      result.refreshed++;
      continue;
    }

    const lastResolved = lastResolvedDupeBySerial.get(group.serialNumber);
    const dismissedSameSet =
      lastResolved?.status === "rejected" &&
      memberSetKey(conflictMembersOf(lastResolved)) === memberSetKey(group.members);
    if (dismissedSameSet) {
      result.suppressed++;
      continue;
    }

    const created = await prisma.conflict.create({
      data: {
        entityType: "asset",
        assetId: primaryId,
        conflictFields: ["serialNumber"],
        proposedAssetFields,
        existingAssetSnapshot,
      },
      select: { id: true },
    });
    result.raised++;
    const names = group.members.map((m) => m.hostname || m.assetId).join(", ");
    logEvent({
      action: "conflict.detected",
      resourceType: "asset",
      resourceId: primaryId,
      resourceName: group.members[0]?.hostname || group.serialNumber,
      actor: "system",
      message: `Serial ${group.serialNumber} is recorded on ${group.members.length} assets: ${names} — one device recorded more than once`,
      details: {
        collisionReason: DUPLICATE_SERIAL_COLLISION_REASON,
        conflictId: created.id,
        serialNumber: group.serialNumber,
        assetIds: group.members.map((m) => m.assetId),
        hostnames: group.members.map((m) => m.hostname ?? null),
      },
    });
  }

  const liveDupeSerials = new Set(duplicates.map((g) => g.serialNumber));
  for (const [serial, row] of pendingByDupeSerial) {
    if (liveDupeSerials.has(serial)) continue;
    await autoClose(row.id);
    result.closed++;
    logEvent({
      action: "conflict.rejected",
      resourceType: "asset",
      resourceId: row.assetId ?? undefined,
      resourceName: serial,
      actor: "system",
      message: `Serial ${serial} is no longer carried by two assets — conflict auto-resolved`,
      details: { collisionReason: DUPLICATE_SERIAL_COLLISION_REASON, serialNumber: serial },
    });
  }

  result.pruned = await pruneStaleControllerClaims(now);
  return result;
}

/** Stable key for a duplicate-record member set (the re-raise suppressor). */
export function memberSetKey(members: Array<{ assetId: string }>): string {
  return members
    .map((m) => m.assetId)
    .filter(Boolean)
    .sort()
    .join("|");
}

// ─── Resolution: the records are one device ──────────────────────────────────

export interface MergeDuplicateSerialOutcome {
  serialNumber: string;
  survivorAssetId: string;
  absorbedAssetIds: string[];
  movedSources: number;
  resolved: boolean;
  remaining: number;
}

/**
 * Absorb the duplicate records into one, through the operator merge engine
 * (`mergeAssets`) — the same path the asset page's Merge modal and the
 * duplicate-IP card use, so provenance, MACs, IP history, sightings, the agent
 * enrolment, dependency edges and monitoring all carry identically.
 *
 * No field winners, for the reason duplicate-IP's merge gives: blank-fill is
 * what every automatic absorb uses and per-field control belongs on the asset's
 * Sources tab.
 *
 * `Conflict.assetId` is re-pointed at the survivor BEFORE the first merge —
 * deleting an absorbed asset cascades to conflicts pointing at it, which would
 * destroy this row (and its audit trail) mid-operation.
 */
export async function mergeDuplicateSerialAssets(
  conflict: { id: string; assetId: string | null; proposedAssetFields: unknown },
  survivorAssetId: string,
  rawAbsorbIds: string[],
  actor?: string,
): Promise<MergeDuplicateSerialOutcome> {
  const proposed = conflictProposed(conflict);
  if (proposed.collisionReason !== DUPLICATE_SERIAL_COLLISION_REASON) {
    throw new AppError(400, "This conflict is not a duplicate serial number conflict");
  }
  const serial = conflictSerialOf(conflict);
  if (!serial) throw new AppError(500, "Duplicate serial conflict is missing its serial number");

  const members = conflictMembersOf(conflict);
  const absorbIds = resolveMergeTargets(members, survivorAssetId, rawAbsorbIds);
  const labelOf = (id: string) => members.find((m) => m.assetId === id)?.hostname || id;
  const survivorLabel = labelOf(survivorAssetId);

  if (conflict.assetId !== survivorAssetId) {
    await prisma.conflict.update({
      where: { id: conflict.id },
      data: { assetId: survivorAssetId },
    });
  }

  let movedSources = 0;
  const absorbed: string[] = [];
  for (const ghostId of absorbIds) {
    const ghostLabel = labelOf(ghostId);
    const merged = await mergeAssets({ canonicalId: survivorAssetId, ghostId });
    movedSources += merged.movedSources;
    absorbed.push(merged.absorbedId);
    logEvent({
      action: "asset.merged",
      resourceType: "asset",
      resourceId: merged.survivorId,
      resourceName: survivorLabel,
      actor,
      level: "info",
      message:
        `Merged asset ${ghostLabel} into ${survivorLabel} — resolving duplicate serial ${serial}; ` +
        `moved ${merged.movedSources} source(s)` +
        (merged.carriedMonitoring ? "; monitoring carried over from the absorbed asset" : "") +
        (merged.movedDependents > 0 ? `; re-pointed ${merged.movedDependents} dependent device(s)` : "") +
        (merged.movedDependencyParents > 0 ? `; carried ${merged.movedDependencyParents} dependency parent link(s)` : ""),
      details: {
        survivorId: merged.survivorId,
        absorbedId: merged.absorbedId,
        duplicateSerial: serial,
        collisionReason: DUPLICATE_SERIAL_COLLISION_REASON,
        carriedMonitoring: merged.carriedMonitoring,
        movedSources: merged.movedSources,
        movedMacs: merged.movedMacs,
        movedIps: merged.movedIps,
        movedIpHistory: merged.movedIpHistory,
        movedSightings: merged.movedSightings,
        movedManagedAgent: merged.movedManagedAgent,
        movedDependencyParents: merged.movedDependencyParents,
        movedDependents: merged.movedDependents,
        appliedFields: merged.appliedFields,
      },
    });
  }

  const { resolved, remaining } = await settleDuplicateSerialConflict(conflict.id, serial, {
    survivorAssetId,
    survivorLabel,
    absorbedAssetIds: absorbed,
    actor,
  });
  return { serialNumber: serial, survivorAssetId, absorbedAssetIds: absorbed, movedSources, resolved, remaining };
}

/**
 * Re-evaluate one duplicate-serial conflict after a merge: close it as
 * `accepted` (the merge WAS the resolution, so it carries the operator's name,
 * not `system:auto-resolved`) when the serial no longer groups, or refresh its
 * member snapshot when a 3+ duplicate still has records standing — the card
 * renders that snapshot, so leaving it stale lists an asset that is gone.
 */
async function settleDuplicateSerialConflict(
  conflictId: string,
  serial: string,
  merge: { survivorAssetId: string; survivorLabel: string; absorbedAssetIds: string[]; actor?: string },
): Promise<{ resolved: boolean; remaining: number }> {
  const remainingRows = (await loadDuplicateSerialAssets()).filter(
    (r) => normalizeSerialKey(r.serialNumber) === serial,
  );
  const stillGrouped = groupDuplicateSerialAssets(remainingRows)[0] ?? null;

  if (!stillGrouped) {
    await prisma.conflict.update({
      where: { id: conflictId },
      data: { status: "accepted", resolvedBy: merge.actor ?? null, resolvedAt: new Date() },
    });
    logEvent({
      action: "conflict.accepted",
      resourceType: "asset",
      resourceId: merge.survivorAssetId,
      resourceName: serial,
      actor: merge.actor,
      message:
        `Duplicate serial ${serial} resolved by merge — ${merge.absorbedAssetIds.length} duplicate record(s) ` +
        `absorbed into "${merge.survivorLabel}"`,
      details: {
        collisionReason: DUPLICATE_SERIAL_COLLISION_REASON,
        serialNumber: serial,
        survivorAssetId: merge.survivorAssetId,
        absorbedAssetIds: merge.absorbedAssetIds,
      },
    });
    return { resolved: true, remaining: 0 };
  }

  await prisma.conflict.update({
    where: { id: conflictId },
    data: {
      assetId: stillGrouped.members.some((m) => m.assetId === merge.survivorAssetId)
        ? merge.survivorAssetId
        : pickPrimaryMemberId(stillGrouped.members),
      proposedAssetFields: {
        collisionReason: DUPLICATE_SERIAL_COLLISION_REASON,
        serialNumber: serial,
        hostname: stillGrouped.members[0]?.hostname ?? null,
        members: stillGrouped.members,
      } as any,
      existingAssetSnapshot: { serialNumber: serial, members: stillGrouped.members } as any,
    },
  });
  return { resolved: false, remaining: stillGrouped.members.length };
}

// ─── The automatic merge (the mergeDuplicateHostnameAssets serial pass) ─────

export interface DuplicateSerialAbsorbResult {
  absorbedIds: string[];
  movedSources: number;
  movedManagedAgent: boolean;
}

/**
 * Absorb every `ghost` into `canonical` for the automatic serial merge. The
 * job decides WHICH groups and which survivor (`decideDuplicateSerialGroup`);
 * this is the executor, kept here so it is testable without importing a
 * self-scheduling job module.
 *
 * Merges through the OPERATOR engine (`mergeAssets`), never the hostname
 * pass's `mergeDuplicateHostnameGhost`. That executor was written for
 * placeholder ghosts and lets the delete cascade take the ghost's AssetSource
 * rows and its ManagedAgent. A duplicate-serial group is usually two
 * AUTHORITATIVE records — Entra/Intune beside a Polaris Agent — so cascading
 * would silently strip a directory identity off the device and unenrol its
 * agent. `mergeAssets` re-binds the sources, moves the agent enrolment when the
 * survivor has none, and carries dependency edges and monitoring: the same
 * absorb an operator clicking "Merge into this" gets.
 *
 * Conflict cards: a duplicate-serial or duplicate-ip card filed on a ghost is
 * re-pointed at the survivor before that ghost's delete (the cascade would drop
 * it unaudited), and both flavours are settled after the group — best-effort,
 * because the merges have committed and the sweeps are the backstop.
 *
 * A merge failure throws after the ghosts already absorbed; the caller logs and
 * the next cycle re-groups whatever is left.
 */
export async function absorbDuplicateSerialGroup(
  canonical: { id: string; hostname: string | null },
  ghosts: Array<{ id: string; ipAddress: string | null }>,
  actor: string,
): Promise<DuplicateSerialAbsorbResult> {
  const out: DuplicateSerialAbsorbResult = { absorbedIds: [], movedSources: 0, movedManagedAgent: false };
  const survivorLabel = canonical.hostname || canonical.id;

  for (const ghost of ghosts) {
    await repointDuplicateSerialConflicts(ghost.id, canonical.id);
    await repointDuplicateIpConflicts(ghost.id, canonical.id);
    const merged = await mergeAssets({ canonicalId: canonical.id, ghostId: ghost.id });
    out.absorbedIds.push(merged.absorbedId);
    out.movedSources += merged.movedSources;
    out.movedManagedAgent = out.movedManagedAgent || merged.movedManagedAgent;
  }

  try {
    for (const absorbedAssetId of out.absorbedIds) {
      await settleDuplicateSerialConflictsAfterMerge({
        survivorAssetId: canonical.id,
        absorbedAssetId,
        survivorLabel,
        actor,
      });
    }
    const survivorAfter = await prisma.asset.findUnique({
      where: { id: canonical.id },
      select: { ipAddress: true },
    });
    await reconcileDuplicateIpForAddresses([survivorAfter?.ipAddress, ...ghosts.map((g) => g.ipAddress)]);
  } catch (err) {
    logger.warn({ err, canonicalId: canonical.id }, "Duplicate-serial merge: conflict settle failed");
  }
  return out;
}

// ─── A merge made somewhere other than the card ─────────────────────────────
//
// The asset page's Merge modal — and the card's own "Review & merge...", which
// opens that modal — merges through `POST /assets/:id/merge`, not through
// `mergeDuplicateSerialAssets`. Without these two hooks the card it resolved
// stayed listed, showing both records, until the sweep's next 30-minute pass
// closed it as `system:auto-resolved`. The route calls the first before
// `mergeAssets` and the second after, mirroring what the card's own verb does.

/**
 * Move every pending duplicate-serial conflict filed on `fromAssetId` onto
 * `toAssetId`. Must run BEFORE the merge: deleting the absorbed asset cascades
 * to conflicts pointing at it, which would drop the card and its audit trail
 * silently rather than resolve it.
 */
export async function repointDuplicateSerialConflicts(fromAssetId: string, toAssetId: string): Promise<number> {
  const moved = await prisma.conflict.updateMany({
    where: { ...DUPLICATE_SERIAL_CONFLICT_WHERE, status: "pending", assetId: fromAssetId },
    data: { assetId: toAssetId },
  });
  return moved.count;
}

/**
 * Settle every pending duplicate-serial conflict that names either side of a
 * merge that just completed. Pending duplicate-serial rows are few (one per
 * duplicated serial), so they are read whole and matched on their stored
 * members in memory rather than through a JSON-array query.
 */
export async function settleDuplicateSerialConflictsAfterMerge(merge: {
  survivorAssetId: string;
  absorbedAssetId: string;
  survivorLabel: string;
  actor?: string;
}): Promise<{ resolved: number; refreshed: number }> {
  const out = { resolved: 0, refreshed: 0 };
  const involved = new Set([merge.survivorAssetId, merge.absorbedAssetId]);
  const pending = await loadPending(DUPLICATE_SERIAL_CONFLICT_WHERE);
  for (const row of pending) {
    if (!conflictMembersOf(row).some((m) => involved.has(m.assetId))) continue;
    const serial = conflictSerialOf(row);
    if (!serial) continue;
    const { resolved } = await settleDuplicateSerialConflict(row.id, serial, {
      survivorAssetId: merge.survivorAssetId,
      survivorLabel: merge.survivorLabel,
      absorbedAssetIds: [merge.absorbedAssetId],
      actor: merge.actor,
    });
    if (resolved) out.resolved++;
    else out.refreshed++;
  }
  return out;
}

// ─── Dismissal copy (the resolution engine marks the row itself) ─────────────

export function serialClaimRejectMessage(conflict: { proposedAssetFields: unknown }): string {
  const serial = conflictSerialOf(conflict) ?? "unknown";
  const gates = conflictClaimantsOf(conflict)
    .map((c) => c.controllerDevice || c.controllerSerial || "unknown")
    .join(", ");
  return (
    `Contested serial ${serial} dismissed — ${gates || "the FortiGates involved"} both keep the device on their roster ` +
    `(the same pair won't re-raise; a third gate, or a different one, will)`
  );
}

export function duplicateSerialRejectMessage(conflict: { proposedAssetFields: unknown }): string {
  const serial = conflictSerialOf(conflict) ?? "unknown";
  const names = conflictMembersOf(conflict)
    .map((m) => m.hostname || m.assetId)
    .join(", ");
  return `Duplicate serial ${serial} dismissed — ${names || "the assets involved"} stay separate records (the same set won't re-raise)`;
}

export function logSerialClaimDismissal(
  conflict: { id: string; assetId: string | null; proposedAssetFields: unknown },
  actor?: string,
): void {
  logEvent({
    action: "conflict.rejected",
    resourceType: "asset",
    resourceId: conflict.assetId ?? undefined,
    resourceName: conflictSerialOf(conflict) ?? undefined,
    actor,
    message: serialClaimRejectMessage(conflict),
    details: {
      collisionReason: SERIAL_CLAIM_COLLISION_REASON,
      deviceSerial: conflictSerialOf(conflict),
    },
  });
}

export function logDuplicateSerialDismissal(
  conflict: { id: string; assetId: string | null; proposedAssetFields: unknown },
  actor?: string,
): void {
  logEvent({
    action: "conflict.rejected",
    resourceType: "asset",
    resourceId: conflict.assetId ?? undefined,
    resourceName: conflictSerialOf(conflict) ?? undefined,
    actor,
    message: duplicateSerialRejectMessage(conflict),
    details: {
      collisionReason: DUPLICATE_SERIAL_COLLISION_REASON,
      serialNumber: conflictSerialOf(conflict),
    },
  });
}

/** Used by the job wrapper so a scan failure logs once with context. */
export function logScanFailure(err: unknown): void {
  logger.warn(
    { err: err instanceof Error ? err.message : String(err) },
    "serial conflict reconcile failed (will retry next cycle)",
  );
}
