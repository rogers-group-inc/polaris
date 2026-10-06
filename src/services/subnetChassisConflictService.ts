/**
 * src/services/subnetChassisConflictService.ts — the `chassis-replaced`
 * Conflict flavour: the FortiGate serving a subnet is not the one that used to
 * (business rule 41).
 *
 * The first `entityType="subnet"` Conflict variant. See the header of
 * conflictResolutionService.ts for the full variant table.
 *
 * WHAT IT REPORTS
 * A discovered subnet stores the chassis SERIAL of the gate that serves it
 * (`Subnet.fortigateSerial`). When a run answers with a serial that is neither
 * the stored one nor any member of that device's HA cluster, the physical box
 * was swapped. Two very different things used to look identical here, because
 * the only stored identity was the gate's NAME:
 *
 *   • NEW NAME, new serial — the gate left FMG's roster, so the subnet was
 *     deprecated and (before the archive) its CIDR could never be re-created.
 *     Discovery skipped the replacement's identical subnets on every run.
 *   • SAME NAME, new serial — an RMA or warranty swap, which normally reuses
 *     the name. Nothing fired at all: the CIDR matched, the name matched the
 *     roster, and the new chassis silently inherited every reservation row of
 *     the old one, `pushStatus: "synced"` included, with each pushed row's
 *     `pushedScopeId` / `pushedEntryId` still addressing a DHCP entry inside a
 *     scope on a box that no longer exists. Nothing looked wrong, which is what
 *     made it worse than the first case.
 *
 * Serial identity is also what finally separates a RENAME from a REPLACEMENT —
 * the ambiguity underneath both failures. Same serial + new name is a rename
 * and re-points silently; a new serial raises this.
 *
 * RAISING IS ADDITIVE; MIGRATING IS THE EXPLICIT ACT
 * Raising COPIES the old chassis's subnet + reservations into the archive
 * (`snapshotSubnet`) and leaves the live rows exactly as they are. Nothing is
 * deleted, released or re-pushed on the strength of an automatic detection, so
 * the worst a false positive can cost is one card and one archive row.
 * `migrateArchivedReservations` is the operator-driven half that WRITES — see
 * its block comment for why every migrated row lands `manual` and why the push
 * is queued rather than sent inline.
 *
 * LIFECYCLE
 *   raise      — one pending Conflict per SUBNET, keyed on the (old, new)
 *                serial pair. Stamps a `conflict.detected` Event.
 *   refresh    — a later run re-stamps the same pending row rather than
 *                stacking duplicates (the duplicateIpConflictService pattern).
 *   accept     — `acceptChassisReplacement`: yes, the box was replaced. Stamps
 *                the new serial onto the subnet, so the next run reads `same`
 *                and nothing re-raises. The conflict's own status is stamped by
 *                conflictResolutionService's dispatcher, as for every other
 *                variant.
 *   reject     — dismiss. The rejected row is the dedup marker: the SAME serial
 *                pair never re-raises, a different one does.
 *   migrate    — `migrateArchivedReservations`: carry chosen addresses' OLD
 *                reservations onto the live subnet. Independent of accept, and
 *                deliberately does NOT close the conflict — an operator can
 *                migrate a few lines, look again, and migrate more, so the diff
 *                has to stay reachable until they adopt the chassis.
 *
 * The stored serial is deliberately NOT re-pointed at raise time. While the
 * conflict is pending, `Subnet.fortigateSerial` still names the chassis Polaris
 * last agreed served this space, which is what keeps the detection derivable
 * from the subnet row itself rather than dependent on the conflict row
 * surviving. Accept is what moves it.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { normalizeSerial } from "../utils/chassisIdentity.js";
import { DEVICE_OWNED_SOURCE_TYPES } from "./reservationService.js";
import { integrationPushEnabled } from "./reservationPushService.js";
import { chunkArray } from "../utils/chunk.js";
import { getArchivedSubnet } from "./subnetArchiveService.js";
import { mergeAssets } from "./assetMergeService.js";

export const CHASSIS_REPLACED_COLLISION_REASON = "chassis-replaced";

/** Prisma filter matching this feature's conflicts. */
const CHASSIS_CONFLICT_WHERE = {
  entityType: "subnet",
  proposedSubnetFields: {
    path: ["collisionReason"],
    equals: CHASSIS_REPLACED_COLLISION_REASON,
  },
} as const;

/** The identity facts stored on the Conflict row. */
export interface ChassisReplacedPayload {
  collisionReason: typeof CHASSIS_REPLACED_COLLISION_REASON;
  cidr: string;
  blockId: string;
  oldSerial: string;
  newSerial: string;
  oldDeviceName: string | null;
  newDeviceName: string | null;
  /** ArchivedSubnet row holding the old chassis's subnet + reservations. */
  archivedSubnetId: string;
}

// ─── The per-address diff ────────────────────────────────────────────────────
//
// Computed ON READ rather than snapshotted into the Conflict row, because of
// discovery's phase order: Phase 1 syncs subnets and Phases 3–5 write
// reservations, so at detection time the live rows are still the OLD chassis's
// and a payload built then would compare old against old. Reading it live also
// means the card can never show a diff that has since gone stale.

/** One reservation as either side of the diff reports it. */
export interface DiffSide {
  ipAddress: string | null;
  hostname: string | null;
  macAddress: string | null;
  owner: string | null;
  sourceType: string;
  status: string;
  notes: string | null;
  projectRef: string | null;
}

export type LineVerdict = "only-old" | "only-new" | "differs" | "same";

export interface ChassisDiffLine {
  /** Address, or null for a full-subnet reservation. */
  ip: string | null;
  verdict: LineVerdict;
  old: DiffSide | null;
  new: DiffSide | null;
  /**
   * Whether an operator may carry the OLD line onto the new gate. False when
   * there is no old line, and false for every source type that is not a
   * DELIBERATE assignment the new box is missing — see MIGRATABLE_SOURCE_TYPES.
   */
  migratable: boolean;
  /** Present when `migratable` is false and an old line exists. */
  notMigratableReason?: NotMigratableReason;
}

export type NotMigratableReason = "device-owned" | "observed" | "device-managed";

/**
 * The only two source types worth carrying onto a replacement chassis.
 *
 * Migration answers "the new box does not know about an assignment somebody
 * MADE". That is exactly `manual` (an operator reserved it) and
 * `dhcp_reservation` (a MAC→IP binding configured on the old gate). Everything
 * else is excluded for a reason of its own, and each reason matters:
 *
 *   • `vip` / `interface_ip` — DEVICE-OWNED. Read-only in Polaris everywhere
 *     else, and the new gate's own config states them. Migrating one would
 *     write Polaris's memory of a dead box over a live device's truth.
 *   • `dhcp_lease` / `dns_resolved` — OBSERVED, not assigned. A lease is a
 *     sighting of a client that may not even be there any more, and a
 *     dns_resolved row is a fallback marker. The new gate will observe its own;
 *     turning an old observation into a reservation would invent an assignment
 *     nobody made.
 *   • `fortiswitch` / `fortinap` / `fortimanager` / `fortigate` — DEVICE-MANAGED
 *     infrastructure addresses. Those devices are still on the wire and the new
 *     gate re-discovers them within a cycle, so migrating is at best a no-op
 *     and at worst fights rule 23's give-the-address-back lifecycle.
 */
export const MIGRATABLE_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "manual",
  "dhcp_reservation",
]);

const OBSERVED_SOURCE_TYPES: ReadonlySet<string> = new Set(["dhcp_lease", "dns_resolved"]);

/** Why this old line cannot be carried forward, or null when it can. */
export function notMigratableReasonFor(sourceType: string): NotMigratableReason | null {
  if (MIGRATABLE_SOURCE_TYPES.has(sourceType)) return null;
  if (DEVICE_OWNED_SOURCE_TYPES.has(sourceType)) return "device-owned";
  if (OBSERVED_SOURCE_TYPES.has(sourceType)) return "observed";
  return "device-managed";
}

/** Fields whose disagreement makes a line `differs` rather than `same`. */
const COMPARED_FIELDS: Array<keyof DiffSide> = [
  "hostname",
  "macAddress",
  "owner",
  "sourceType",
  "notes",
  "projectRef",
];

/** Full-subnet reservations carry a null ipAddress; they still need a key. */
const FULL_SUBNET_KEY = "__full__";
const lineKey = (ip: string | null): string => ip ?? FULL_SUBNET_KEY;

/**
 * Pure per-address diff of two reservation sets. Exported for tests and so the
 * verdict rules live in exactly one place.
 */
export function diffReservationLines(
  oldRows: readonly DiffSide[],
  newRows: readonly DiffSide[],
): ChassisDiffLine[] {
  const oldByKey = new Map<string, DiffSide>();
  for (const r of oldRows) oldByKey.set(lineKey(r.ipAddress), r);
  const newByKey = new Map<string, DiffSide>();
  for (const r of newRows) newByKey.set(lineKey(r.ipAddress), r);

  const keys = Array.from(new Set([...oldByKey.keys(), ...newByKey.keys()])).sort();
  const out: ChassisDiffLine[] = [];

  for (const k of keys) {
    const o = oldByKey.get(k) ?? null;
    const n = newByKey.get(k) ?? null;
    const ip = (o?.ipAddress ?? n?.ipAddress) ?? null;

    let verdict: LineVerdict;
    if (o && !n) verdict = "only-old";
    else if (!o && n) verdict = "only-new";
    else if (o && n) {
      verdict = COMPARED_FIELDS.every((f) => (o[f] ?? null) === (n[f] ?? null)) ? "same" : "differs";
    } else continue; // unreachable — a key comes from one side or the other

    const refusal = o ? notMigratableReasonFor(o.sourceType) : null;
    out.push({
      ip,
      verdict,
      old: o,
      new: n,
      // No old line means nothing to carry forward — a different thing from
      // being refused, so it carries no reason.
      migratable: !!o && refusal === null,
      ...(refusal ? { notMigratableReason: refusal } : {}),
    });
  }
  return out;
}

const toDiffSide = (r: {
  ipAddress: string | null;
  hostname: string | null;
  macAddress: string | null;
  owner: string | null;
  sourceType: string;
  status: string;
  notes: string | null;
  projectRef: string | null;
}): DiffSide => ({
  ipAddress: r.ipAddress,
  hostname: r.hostname,
  macAddress: r.macAddress,
  owner: r.owner,
  sourceType: String(r.sourceType),
  status: String(r.status),
  notes: r.notes,
  projectRef: r.projectRef,
});

/**
 * The diff for one pending chassis conflict: the archived (old chassis) rows
 * against the live subnet's rows as they stand now.
 */
export async function buildChassisDiff(conflict: {
  subnetId: string | null;
  proposedSubnetFields: unknown;
}): Promise<{ payload: ChassisReplacedPayload; lines: ChassisDiffLine[] }> {
  const payload = conflict.proposedSubnetFields as ChassisReplacedPayload | null;
  if (!payload?.archivedSubnetId) {
    throw new AppError(409, "This conflict carries no archived chassis snapshot to compare against");
  }
  const archived = await getArchivedSubnet(payload.archivedSubnetId);

  // The live subnet may be gone (archived, or its block deleted) — an empty
  // "new" side is a legitimate answer, not an error.
  const live = conflict.subnetId
    ? await prisma.reservation.findMany({
        where: { subnetId: conflict.subnetId },
        select: {
          ipAddress: true, hostname: true, macAddress: true, owner: true,
          sourceType: true, status: true, notes: true, projectRef: true,
        },
      })
    : [];

  return {
    payload,
    lines: diffReservationLines(archived.reservations.map(toDiffSide), live.map(toDiffSide)),
  };
}

// ─── Raise / refresh ─────────────────────────────────────────────────────────

export interface RaiseChassisConflictInput {
  subnetId: string;
  cidr: string;
  blockId: string;
  oldSerial: string;
  newSerial: string;
  oldDeviceName?: string | null;
  newDeviceName?: string | null;
  archivedSubnetId: string;
  integrationId?: string | null;
  integrationName?: string | null;
  actor?: string | null;
}

export type RaiseOutcome = "raised" | "refreshed" | "suppressed";

/**
 * Create or refresh the pending conflict for one replaced chassis.
 *
 * Dedup is keyed on the (oldSerial, newSerial) pair, not just the subnet: a
 * pending row for the same pair is refreshed, a REJECTED row for the same pair
 * suppresses re-raise (the operator dismissed exactly this transition), and a
 * different pair — the box was swapped twice — raises anew.
 */
export async function raiseChassisReplacedConflict(
  input: RaiseChassisConflictInput,
): Promise<RaiseOutcome> {
  const oldSerial = normalizeSerial(input.oldSerial);
  const newSerial = normalizeSerial(input.newSerial);
  if (!oldSerial || !newSerial || oldSerial === newSerial) return "suppressed";

  const existing = await prisma.conflict.findMany({
    where: {
      ...CHASSIS_CONFLICT_WHERE,
      subnetId: input.subnetId,
      status: { in: ["pending", "rejected"] },
    },
    select: { id: true, status: true, proposedSubnetFields: true },
  });

  const samePair = existing.filter((c) => {
    const p = c.proposedSubnetFields as ChassisReplacedPayload | null;
    return normalizeSerial(p?.oldSerial) === oldSerial && normalizeSerial(p?.newSerial) === newSerial;
  });

  if (samePair.some((c) => c.status === "rejected")) return "suppressed";

  const payload: ChassisReplacedPayload = {
    collisionReason: CHASSIS_REPLACED_COLLISION_REASON,
    cidr: input.cidr,
    blockId: input.blockId,
    oldSerial,
    newSerial,
    oldDeviceName: input.oldDeviceName ?? null,
    newDeviceName: input.newDeviceName ?? null,
    archivedSubnetId: input.archivedSubnetId,
  };

  const pending = samePair.find((c) => c.status === "pending");
  if (pending) {
    await prisma.conflict.update({
      where: { id: pending.id },
      data: { proposedSubnetFields: payload as any, integrationId: input.integrationId ?? undefined },
    });
    return "refreshed";
  }

  await prisma.conflict.create({
    data: {
      entityType: "subnet",
      subnetId: input.subnetId,
      integrationId: input.integrationId ?? undefined,
      conflictFields: ["fortigateSerial"],
      proposedSubnetFields: payload as any,
    },
  });

  void logEvent({
    level: "warning",
    action: "conflict.detected",
    resourceType: "subnet",
    resourceId: input.subnetId,
    resourceName: input.cidr,
    actor: input.actor ?? "system",
    message:
      `Subnet ${input.cidr} is now served by a different FortiGate chassis — ` +
      `serial ${oldSerial} replaced by ${newSerial}` +
      (input.newDeviceName ? ` (device "${input.newDeviceName}")` : "") +
      `. Its previous reservations are archived for review.`,
    details: { ...payload, integrationName: input.integrationName ?? null },
  });

  return "raised";
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Accept the replacement: stamp the new chassis serial onto the live subnet and
 * close the conflict. The next discovery pass then reads `same` and nothing
 * re-raises. Reservation migration is a separate, explicit action.
 */
export async function acceptChassisReplacement(conflict: any, actor?: string): Promise<void> {
  const payload = conflict.proposedSubnetFields as ChassisReplacedPayload | null;
  if (!payload) throw new AppError(409, "This conflict carries no chassis payload");
  if (!conflict.subnetId) throw new AppError(409, "This conflict's subnet no longer exists");

  await prisma.subnet.update({
    where: { id: conflict.subnetId },
    data: { fortigateSerial: payload.newSerial },
  });
  void logEvent({
    action: "subnet.chassis.adopted",
    resourceType: "subnet",
    resourceId: conflict.subnetId,
    resourceName: payload.cidr,
    actor,
    message:
      `Subnet ${payload.cidr} adopted FortiGate chassis ${payload.newSerial} ` +
      `(was ${payload.oldSerial})`,
    details: { ...payload },
  });
}

/**
 * Dismiss. The rejected row is the dedup marker for this exact serial pair, so
 * the same transition never re-raises while a later, different swap still does.
 */
export async function rejectChassisReplacement(conflict: any, actor?: string): Promise<void> {
  const payload = conflict.proposedSubnetFields as ChassisReplacedPayload | null;
  void logEvent({
    action: "subnet.chassis.dismissed",
    resourceType: "subnet",
    resourceId: conflict.subnetId ?? undefined,
    resourceName: payload?.cidr,
    actor,
    message: payload
      ? `Chassis-replacement conflict for ${payload.cidr} dismissed (${payload.oldSerial} → ${payload.newSerial})`
      : "Chassis-replacement conflict dismissed",
    details: payload ? { ...payload } : undefined,
  });
}

// ─── Migration: carry chosen old lines onto the new chassis ─────────────────
//
// The part that WRITES, and the reason raising is additive: an automatic
// detection archives a copy and stops, and this is the explicit operator act
// that changes live data.
//
// Every migrated row lands as `sourceType: "manual"` with `dhcpBinding: null`,
// whatever the archived row was. Two reasons, and they agree:
//   • Only a `manual` row is pushable at all — `pushReservations` pushes manual
//     rows, and discovery flips one to `dhcp_reservation` when it later sees it
//     on the device. Landing as `dhcp_reservation` would produce a row claiming
//     the gate serves an address the gate has never heard of.
//   • With push DISABLED the claim is Polaris's alone, which `manual` +
//     `dhcpBinding: null` states exactly (business rule 23's split: sourceType
//     is who owns it, dhcpBinding is how the gate hands it out — and no gate is
//     handing this out).
//
// Pushing is DEFERRED, never inline: the row is queued (`pushStatus: "pending"`
// + `pushQueuedAt`) and `retryQueuedReservationPushes` drains it. A brand-new
// gate is exactly the device most likely to be unreachable for a few minutes,
// and an operator's migrate must not fail on that.

export interface MigrateOutcome {
  created: number;
  updated: number;
  queuedForPush: number;
  skipped: Array<{ ip: string; reason: string }>;
}

/**
 * Carry the named addresses' OLD reservations onto the live (new-chassis)
 * subnet.
 *
 * `only-old` lines are CREATED; `same` / `differs` lines UPDATE the live row in
 * place — which is what the unique index on (subnetId, ipAddress, status)
 * requires, and what "overwrite from the old subnet to the new one" means.
 */
export async function migrateArchivedReservations(
  conflict: { id: string; subnetId: string | null; proposedSubnetFields: unknown },
  ips: readonly string[],
  opts: { actor?: string | null } = {},
): Promise<MigrateOutcome> {
  const payload = conflict.proposedSubnetFields as ChassisReplacedPayload | null;
  if (!payload?.archivedSubnetId) {
    throw new AppError(409, "This conflict carries no archived chassis snapshot to migrate from");
  }
  if (!conflict.subnetId) {
    throw new AppError(409, "This conflict's subnet no longer exists, so there is nothing to migrate onto");
  }

  const subnet = await prisma.subnet.findUnique({
    where: { id: conflict.subnetId },
    include: { integration: { select: { type: true, config: true } } },
  });
  if (!subnet) throw new AppError(409, "This conflict's subnet no longer exists");

  const archived = await getArchivedSubnet(payload.archivedSubnetId);
  const archivedByIp = new Map(
    archived.reservations.filter((r) => r.ipAddress).map((r) => [r.ipAddress as string, r]),
  );

  const requested = Array.from(new Set(ips.map((ip) => ip.trim()).filter(Boolean)));
  if (requested.length === 0) throw new AppError(400, "No addresses were selected to migrate");

  const liveRows = await prisma.reservation.findMany({
    where: { subnetId: subnet.id, ipAddress: { in: requested }, status: "active" },
    select: { id: true, ipAddress: true },
  });
  const liveByIp = new Map(liveRows.map((r) => [r.ipAddress as string, r]));

  // Push eligibility is a property of the SUBNET's integration, resolved once.
  const pushEligible =
    integrationPushEnabled(subnet.integration) && !!subnet.fortigateDevice;
  const pushFields = pushEligible
    ? {
        pushedToId: subnet.discoveredBy,
        pushStatus: "pending",
        pushQueuedAt: new Date(),
        pushAttempts: 0,
        pushLastAttemptAt: null,
        pushError: null,
        // The old chassis's pointers are never carried (they aren't even
        // archived) — an entry id on a box that no longer exists.
        pushedScopeId: null,
        pushedEntryId: null,
        pushedAt: null,
      }
    : {
        pushedToId: null,
        pushStatus: null,
        pushQueuedAt: null,
        pushAttempts: 0,
        pushLastAttemptAt: null,
        pushError: null,
        pushedScopeId: null,
        pushedEntryId: null,
        pushedAt: null,
      };

  const out: MigrateOutcome = { created: 0, updated: 0, queuedForPush: 0, skipped: [] };
  const ops: any[] = [];
  const migratedIps: string[] = [];

  for (const ip of requested) {
    const old = archivedByIp.get(ip);
    if (!old) {
      out.skipped.push({ ip, reason: "not-in-archive" });
      continue;
    }
    const refusal = notMigratableReasonFor(String(old.sourceType));
    if (refusal) {
      out.skipped.push({ ip, reason: refusal });
      continue;
    }

    const carried = {
      hostname: old.hostname,
      owner: old.owner,
      projectRef: old.projectRef,
      notes: old.notes,
      macAddress: old.macAddress,
      expiresAt: old.expiresAt,
      // See the block comment above: always manual, never a binding claim.
      sourceType: "manual" as const,
      dhcpBinding: null,
      status: "active" as const,
      ...pushFields,
    };

    const live = liveByIp.get(ip);
    if (live) {
      ops.push(prisma.reservation.update({ where: { id: live.id }, data: carried }));
      out.updated += 1;
    } else {
      ops.push(
        prisma.reservation.create({
          data: {
            subnetId: subnet.id,
            ipAddress: ip,
            createdBy: old.createdBy ?? opts.actor ?? null,
            ...carried,
          },
        }),
      );
      out.created += 1;
    }
    migratedIps.push(ip);
    if (pushEligible) out.queuedForPush += 1;
  }

  // Chunked so a whole-/24 migration doesn't build one enormous statement list.
  for (const batch of chunkArray(ops, 100)) {
    await prisma.$transaction(batch);
  }

  if (migratedIps.length > 0) {
    void logEvent({
      action: "subnet.chassis.reservations_migrated",
      resourceType: "subnet",
      resourceId: subnet.id,
      resourceName: payload.cidr,
      actor: opts.actor ?? undefined,
      message:
        `Migrated ${migratedIps.length} reservation(s) from FortiGate chassis ${payload.oldSerial} ` +
        `onto ${payload.newSerial} for ${payload.cidr}` +
        (pushEligible
          ? ` — queued for push to "${subnet.fortigateDevice}"`
          : " — Polaris-only (DHCP push is off for this integration)"),
      details: {
        ...payload,
        conflictId: conflict.id,
        created: out.created,
        updated: out.updated,
        queuedForPush: out.queuedForPush,
        // One Event for the batch (the subnet.bulk-allocated convention), but
        // it names every address so the audit trail is specific.
        ips: migratedIps,
        skipped: out.skipped,
      },
    });
  }

  return out;
}

/** Pending chassis conflicts, newest first — for the review surface. */
export async function listChassisConflicts(limit = 50) {
  return prisma.conflict.findMany({
    where: { ...CHASSIS_CONFLICT_WHERE, status: "pending" },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    include: { subnet: { select: { id: true, cidr: true, name: true, fortigateDevice: true } } },
  });
}

// ─── One swap, one decision (rule 41(a)) ────────────────────────────────────
//
// A FortiGate serves many subnets, so one physical swap raised one card PER
// SUBNET — ten interfaces, ten cards, all saying the same "A was replaced by
// B" (prod 2026-10-05). The per-subnet rows stay, because the per-subnet
// reservation diff and the per-subnet dedup marker are real; what changes is
// that the DECISION is taken once per serial pair. The Events page groups the
// rows by `chassisSwapKey`, and these two verbs act on every pending row of
// the pair at once.

/** The grouping key the UI and the bulk verbs agree on. */
export function chassisSwapKey(oldSerial: string | null | undefined, newSerial: string | null | undefined): string {
  return `${normalizeSerial(oldSerial) ?? ""}>${normalizeSerial(newSerial) ?? ""}`;
}

async function loadPendingSwapConflicts(oldSerial: string, newSerial: string) {
  const old = normalizeSerial(oldSerial);
  const next = normalizeSerial(newSerial);
  if (!old || !next || old === next) throw new AppError(400, "oldSerial and newSerial must be two different serials");
  const rows = await prisma.conflict.findMany({
    where: { ...CHASSIS_CONFLICT_WHERE, status: "pending" },
    select: { id: true, subnetId: true, proposedSubnetFields: true },
  });
  const matches = rows.filter((c) => {
    const p = c.proposedSubnetFields as ChassisReplacedPayload | null;
    return normalizeSerial(p?.oldSerial) === old && normalizeSerial(p?.newSerial) === next;
  });
  return { old, next, matches };
}

/**
 * The firewall Asset each chassis lives on. The `fortigate-firewall` source
 * (externalId = chassis serial) first, then `Asset.serialNumber`. Compared
 * normalized in memory: the stored externalId is whatever the transport
 * reported, and an `in:` filter is case-sensitive (the loadControllerContext
 * trap). Bounded by the fleet's firewall count.
 */
export async function findChassisAssets(oldSerial: string, newSerial: string): Promise<{
  oldAssetId: string | null;
  newAssetId: string | null;
}> {
  const old = normalizeSerial(oldSerial);
  const next = normalizeSerial(newSerial);
  const out = { oldAssetId: null as string | null, newAssetId: null as string | null };
  const sources = await prisma.assetSource.findMany({
    where: { sourceKind: "fortigate-firewall" },
    select: { externalId: true, assetId: true },
  });
  for (const s of sources) {
    const key = normalizeSerial(s.externalId);
    if (key && key === old && !out.oldAssetId) out.oldAssetId = s.assetId;
    if (key && key === next && !out.newAssetId) out.newAssetId = s.assetId;
  }
  if (!out.oldAssetId || !out.newAssetId) {
    const firewalls = await prisma.asset.findMany({
      where: { assetType: "firewall", serialNumber: { not: null } },
      select: { id: true, serialNumber: true },
    });
    for (const f of firewalls) {
      const key = normalizeSerial(f.serialNumber);
      if (!out.oldAssetId && key === old) out.oldAssetId = f.id;
      if (!out.newAssetId && key === next) out.newAssetId = f.id;
    }
  }
  return out;
}

export interface AdoptSwapOutcome {
  adopted: number;
  cidrs: string[];
  /** Set when the old gate's record was merged into the new gate's. */
  mergedAssetId: string | null;
  /** Why a requested merge did not happen — the card says so instead of failing the adopt. */
  mergeSkipped: "old-asset-not-found" | "new-asset-not-found" | "same-asset" | null;
  removedClaims: number;
}

/**
 * Adopt the new chassis for every pending subnet of one swap.
 *
 * `mergeOldAsset` also folds the old gate's Asset into the new gate's through
 * the operator merge engine (`mergeAssets`): notes, location, monitoring
 * settings, dependency children and maintenance carry across, so the site
 * keeps one record rather than a decommissioned twin. Two things the merge
 * would carry are WRONG for new hardware and are dropped after it: the old
 * chassis's `fortigate-firewall` source (a dead serial that would otherwise
 * feed the projection) and the MAC rows that came from the old box.
 *
 * Either way the old chassis's controller claims are deleted — that box will
 * never re-assert them, and until they aged out they read as a second gate
 * claiming every switch and AP the new one manages (rule 83(c)).
 */
export async function adoptChassisSwap(
  oldSerial: string,
  newSerial: string,
  opts: { mergeOldAsset?: boolean; actor?: string } = {},
): Promise<AdoptSwapOutcome> {
  const { old, next, matches } = await loadPendingSwapConflicts(oldSerial, newSerial);
  if (matches.length === 0) throw new AppError(404, "No pending chassis conflicts for that serial pair");

  const subnetIds = matches.map((c) => c.subnetId).filter((id): id is string => !!id);
  const now = new Date();
  await prisma.$transaction([
    prisma.subnet.updateMany({ where: { id: { in: subnetIds } }, data: { fortigateSerial: next } }),
    prisma.conflict.updateMany({
      where: { id: { in: matches.map((c) => c.id) }, status: "pending" },
      data: { status: "accepted", resolvedBy: opts.actor ?? null, resolvedAt: now },
    }),
  ]);

  const cidrs: string[] = [];
  for (const c of matches) {
    const p = c.proposedSubnetFields as unknown as ChassisReplacedPayload;
    cidrs.push(p.cidr);
    void logEvent({
      action: "subnet.chassis.adopted",
      resourceType: "subnet",
      resourceId: c.subnetId ?? undefined,
      resourceName: p.cidr,
      actor: opts.actor,
      message: `Subnet ${p.cidr} adopted FortiGate chassis ${next} (was ${old})`,
      details: { ...p, bulk: true },
    });
  }

  const outcome: AdoptSwapOutcome = { adopted: matches.length, cidrs, mergedAssetId: null, mergeSkipped: null, removedClaims: 0 };

  if (opts.mergeOldAsset) {
    const { oldAssetId, newAssetId } = await findChassisAssets(old, next);
    if (!oldAssetId) outcome.mergeSkipped = "old-asset-not-found";
    else if (!newAssetId) outcome.mergeSkipped = "new-asset-not-found";
    else if (oldAssetId === newAssetId) outcome.mergeSkipped = "same-asset";
    else {
      const oldMacRows = await prisma.assetMacAddress.findMany({ where: { assetId: oldAssetId }, select: { id: true } });
      const result = await mergeAssets({ canonicalId: newAssetId, ghostId: oldAssetId });
      // Dead hardware's identity must not ride along on the survivor.
      const deadSources = await prisma.assetSource.findMany({
        where: { assetId: newAssetId, sourceKind: "fortigate-firewall" },
        select: { id: true, externalId: true },
      });
      const deadIds = deadSources.filter((s) => normalizeSerial(s.externalId) === old).map((s) => s.id);
      await prisma.$transaction([
        prisma.assetSource.deleteMany({ where: { id: { in: deadIds } } }),
        prisma.assetMacAddress.deleteMany({ where: { id: { in: oldMacRows.map((r) => r.id) }, assetId: newAssetId } }),
      ]);
      outcome.mergedAssetId = result.survivorId;
      void logEvent({
        action: "asset.merged",
        resourceType: "asset",
        resourceId: newAssetId,
        actor: opts.actor,
        message: `Replaced FortiGate chassis ${old} merged into its replacement ${next}`,
        details: { reason: "chassis-replaced", oldSerial: old, newSerial: next, absorbedAssetId: oldAssetId, ...result },
      });
    }
  }

  const { count } = await prisma.assetControllerClaim.deleteMany({ where: { controllerKey: old } });
  outcome.removedClaims = count;

  void logEvent({
    action: "subnet.chassis.swap_adopted",
    resourceType: "subnet",
    resourceName: `${old} → ${next}`,
    actor: opts.actor,
    message:
      `FortiGate chassis ${old} replaced by ${next}: adopted for ${matches.length} network(s)` +
      (outcome.mergedAssetId ? ", old gate merged into the new one" : ""),
    details: { oldSerial: old, newSerial: next, ...outcome },
  });
  return outcome;
}

/**
 * Dismiss every pending subnet of one swap. Each rejected row stays the dedup
 * marker for its subnet, exactly as a one-at-a-time dismiss.
 */
export async function rejectChassisSwap(
  oldSerial: string,
  newSerial: string,
  actor?: string,
): Promise<{ rejected: number }> {
  const { old, next, matches } = await loadPendingSwapConflicts(oldSerial, newSerial);
  if (matches.length === 0) throw new AppError(404, "No pending chassis conflicts for that serial pair");
  await prisma.conflict.updateMany({
    where: { id: { in: matches.map((c) => c.id) }, status: "pending" },
    data: { status: "rejected", resolvedBy: actor ?? null, resolvedAt: new Date() },
  });
  void logEvent({
    action: "subnet.chassis.dismissed",
    resourceType: "subnet",
    resourceName: `${old} → ${next}`,
    actor,
    message: `Chassis-replacement conflicts dismissed for ${matches.length} network(s) (${old} → ${next})`,
    details: {
      oldSerial: old,
      newSerial: next,
      cidrs: matches.map((c) => (c.proposedSubnetFields as unknown as ChassisReplacedPayload).cidr),
    },
  });
  return { rejected: matches.length };
}
