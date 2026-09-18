/**
 * src/services/reservationService.ts
 */

import type { ReservationStatus } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { ipInCidr, isValidIpAddress, enumerateSubnetIps, detectIpVersion } from "../utils/cidr.js";
import {
  isLeaseBackedInfraRow,
  shouldReleaseInfraReservation,
  classifyOrphanInfraRow,
} from "../utils/infraDhcpBinding.js";
import { mapSettledWithConcurrency } from "../utils/concurrency.js";
import { selectAvailableIps } from "../utils/ipAllocation.js";
import { logger } from "../utils/logger.js";
import {
  pushReservation,
  unpushReservation,
  updatePushedReservation,
  releaseDhcpLease,
  normalizeMac,
  classifyPushError,
  integrationPushEnabled,
  assertReservationDescriptionFits,
  type PushReservationResult,
} from "./reservationPushService.js";
import { logEvent, buildChanges } from "./eventLogService.js";
import { releaseDnsResolvedAt } from "./dnsResolvedReservationService.js";

export interface CreateReservationInput {
  subnetId: string;
  ipAddress?: string;
  hostname?: string;
  owner?: string;
  projectRef?: string;
  expiresAt?: Date;
  notes?: string;
  createdBy?: string;
  // MAC address for the reservation. Required when the target subnet was
  // discovered by an FMG integration that has pushReservations=true — DHCP
  // reservations on the FortiGate are MAC→IP, so a missing MAC aborts the
  // create. Optional for everything else.
  macAddress?: string;
  /** Discriminates the audit message — nextAvailableReservation sets "auto-allocate". */
  via?: "auto-allocate";
}

export interface UpdateReservationInput {
  hostname?: string;
  owner?: string;
  projectRef?: string;
  expiresAt?: Date;
  notes?: string;
  // Optional MAC update. When the subnet is push-eligible (FMG/FortiGate
  // integration with pushReservations=true) and the MAC value changes, the
  // service pushes the new MAC to the FortiGate (PUT + verify) before
  // committing the Polaris write. On device failure the whole update is
  // aborted so Polaris doesn't drift from the device. Empty string clears
  // the stored MAC; only allowed when the subnet is not push-eligible.
  macAddress?: string;
}

export interface ListReservationsFilter {
  subnetId?: string;
  owner?: string;
  projectRef?: string;
  status?: ReservationStatus;
  limit?: number;
  offset?: number;
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listReservations(filter: ListReservationsFilter = {}) {
  const limit = Math.min(filter.limit || 50, 200);
  const offset = filter.offset || 0;

  const where: Record<string, unknown> = {};
  if (filter.subnetId) where.subnetId = filter.subnetId;
  if (filter.owner) where.owner = filter.owner;
  if (filter.projectRef) where.projectRef = filter.projectRef;
  if (filter.status) where.status = filter.status;

  const [reservations, total] = await Promise.all([
    prisma.reservation.findMany({
      where,
      include: {
        subnet: {
          select: {
            cidr: true,
            name: true,
            fortigateDevice: true,
            integration: { select: { type: true, config: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
    }),
    prisma.reservation.count({ where }),
  ]);

  const decorated = reservations.map((r) => {
    const s = r.subnet as { integration: { type: string; config: unknown } | null } | null;
    const integration = s?.integration ?? null;
    const pushEligible = !!(r.ipAddress && integrationPushEnabled(integration));
    // Strip the integration blob from the response — callers only need the
    // computed flag, and config can carry credentials.
    const { integration: _omit, ...subnetOut } = (r.subnet ?? {}) as Record<string, unknown>;
    return { ...r, subnet: r.subnet ? subnetOut : r.subnet, pushEligible };
  });

  return { reservations: decorated, total, limit, offset };
}

// ─── Get ──────────────────────────────────────────────────────────────────────

export async function getReservation(id: string) {
  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: {
      subnet: {
        include: { block: { select: { id: true, name: true, cidr: true } } },
      },
    },
  });

  if (!reservation) throw new AppError(404, `Reservation ${id} not found`);
  return reservation;
}

// ─── Create ───────────────────────────────────────────────────────────────────

/**
 * Push eligibility for a reservation. Only manual per-IP reservations on
 * subnets discovered by an FMG or standalone FortiGate integration with
 * pushReservations=true are pushed. Full-subnet reservations (ipAddress=null)
 * and subnets without a discovering integration are unaffected.
 */
function resolvePushEligibility(
  subnet: { discoveredBy: string | null; fortigateDevice: string | null; cidr: string },
  integration: { id: string; type: string; config: unknown } | null,
  ipAddress: string | null,
): { eligible: boolean; integration: { id: string; type: string; config: unknown } | null; deviceName: string } {
  if (!ipAddress) return { eligible: false, integration: null, deviceName: "" };
  if (!integration || !integrationPushEnabled(integration)) {
    return { eligible: false, integration: null, deviceName: "" };
  }
  const deviceName = subnet.fortigateDevice || "";
  return { eligible: true, integration, deviceName };
}

export async function createReservation(input: CreateReservationInput) {
  const reservation = await createReservationFlow(input);
  // ONE reservation.created audit row, after the full create(+push) flow
  // resolves so the message can report the final push outcome. The flow's
  // own push-lifecycle events (push.queued / push.failed / ...) are separate
  // detail rows and unchanged.
  const pushedSuffix = reservation.pushStatus === "synced"
    ? ` and pushed to FortiGate`
    : reservation.pushStatus === "pending"
      ? ` — queued for push (FortiGate unreachable; will retry automatically)`
      : "";
  void logEvent({
    action: "reservation.created",
    resourceType: "reservation",
    resourceId: reservation.id,
    resourceName: input.via === "auto-allocate"
      ? (reservation.hostname || reservation.ipAddress || undefined)
      : (input.hostname || input.ipAddress),
    actor: input.createdBy,
    message: input.via === "auto-allocate"
      ? `Reservation auto-allocated for ${reservation.ipAddress} (${reservation.owner || "no owner"})${pushedSuffix}`
      : `Reservation created for ${input.ipAddress || "subnet"} (${reservation.owner || "no owner"})${pushedSuffix}`,
  });
  return reservation;
}

/**
 * Supersede an observed dhcp_lease at (subnetId, ipAddress) when a manual
 * reservation is being created over it. A dhcp_lease is observed device
 * presence, not a user-owned reservation — claiming the IP is a normal create,
 * so this runs as part of createReservation rather than a separate
 * ownership-gated DELETE.
 *
 * Delegates to releaseReservation so the behavior is identical to the old
 * client-driven `api.reservations.release(leaseId)` step it replaces: on
 * push-enabled subnets it expires the lease on the FortiGate (releaseDhcpLease),
 * on read-only subnets it's a pure DB release, and the released-slot collision
 * + audit Event are handled there. The only thing dropped is the route-level
 * ownership gate — which is correct, because superseding an observed lease is
 * part of a create the caller is already authorized to make.
 */
async function releaseSupersededDhcpLeaseAt(
  subnetId: string,
  ipAddress: string,
  actor: string | null,
): Promise<void> {
  const row = await prisma.reservation.findFirst({
    where: {
      subnetId,
      ipAddress,
      status: "active",
      OR: [
        { sourceType: "dhcp_lease" as any },
        // Lease-backed managed FortiSwitch/FortiAP rows are superseded the same
        // way. Note what releaseReservation does NOT do for one of these: it has
        // no push pointers and its sourceType isn't dhcp_reservation, so neither
        // unpush branch fires, and the gate-side lease-expiry branch keys on
        // dhcp_lease so that doesn't either. The release is therefore a pure DB
        // release + audit Event — which is the semantic we want. Expiring the
        // AP's lease here would bounce its management address, whereas the
        // operator's intent in reserving it is "same address, now bound".
        { sourceType: { in: ["fortiswitch", "fortinap"] as any }, dhcpBinding: "lease" },
      ],
    },
    select: { id: true },
  });
  if (!row) return;
  await releaseReservation(row.id, actor ?? undefined);
}

/**
 * Is an active row at the target IP something a create may silently take over?
 *
 * The observational set: `dns_resolved` fallback markers, observed `dhcp_lease`
 * rows, and — added with `Reservation.dhcpBinding` — a managed
 * FortiSwitch/FortiAP row the gate only LEASES. That last case is what made a
 * FortiLink-addressed AP unreservable: Phase 3 records every managed device's
 * address as an authoritative fortiswitch/fortinap row even when the address came
 * out of the lease table, so the row asserted ownership while the FortiGate
 * reported "Not Reserved" and this check refused the create.
 *
 * An infra row whose dhcpBinding is `"reservation"` (a real MAC→IP binding
 * exists) or NULL (never observed in DHCP — a static address, or not currently
 * leasing) still 409s. Guessing "free" from an absence of evidence would hand an
 * operator an address a device is actively using.
 *
 * Single source of truth for both halves of the takeover: this predicate gates
 * the 409, and releaseSupersededDhcpLeaseAt releases whatever it admits.
 */
function isSupersedableByCreate(row: {
  sourceType: string;
  dhcpBinding?: string | null;
}): boolean {
  if (row.sourceType === "dns_resolved" || row.sourceType === "dhcp_lease") return true;
  return isLeaseBackedInfraRow(row);
}

/**
 * Source types whose row is owned by the DEVICE's own config, not by anything
 * Polaris granted: a FortiGate virtual IP and a statically-configured
 * router/firewall interface address. Polaris reports them and offers no
 * Reserve / Release / Edit.
 *
 * Lives here rather than in the route that first needed it because it is a
 * domain fact about a source type, and a second consumer arrived with business
 * rule 41: a chassis-replacement diff must not offer to migrate these lines to
 * the new gate — the new gate's OWN config states them, so "migrating" one
 * would mean writing Polaris's memory of a dead box over a live device's truth.
 */
export const DEVICE_OWNED_SOURCE_TYPES: ReadonlySet<string> = new Set(["vip", "interface_ip"]);

/** True when this row is device-owned and therefore read-only in Polaris. */
export function isDeviceOwnedRow(row: { sourceType: string }): boolean {
  return DEVICE_OWNED_SOURCE_TYPES.has(row.sourceType);
}

// Phase 2 of the create flow: validate the requested target and 409 on
// collision. See isSupersedableByCreate above for which rows a create may take
// over silently — they're excluded from the collision check here and released
// inline by the persist phase before the transaction commits. dhcp_reservation /
// vip / interface / manual rows, and infra rows that aren't lease-backed, are
// authoritative and still 409.
async function assertReservationTargetAvailable(
  input: CreateReservationInput,
  subnet: { cidr: string },
): Promise<void> {
  if (input.ipAddress) {
    if (!isValidIpAddress(input.ipAddress))
      throw new AppError(400, `Invalid IP address: ${input.ipAddress}`);

    if (!ipInCidr(input.ipAddress, subnet.cidr))
      throw new AppError(
        400,
        `IP ${input.ipAddress} is not within subnet ${subnet.cidr}`
      );

    // Fetched WITHOUT a sourceType filter and judged in code: the takeover set
    // is no longer expressible as one `NOT in` list, because whether a
    // fortiswitch/fortinap row is claimable depends on its dhcpBinding.
    const existing = await prisma.reservation.findFirst({
      where: {
        subnetId: input.subnetId,
        ipAddress: input.ipAddress,
        status: "active",
      },
      select: { id: true, sourceType: true, dhcpBinding: true },
    });
    if (existing && !isSupersedableByCreate(existing))
      throw new AppError(
        409,
        `IP ${input.ipAddress} is already actively reserved (reservation: ${existing.id})`
      );
  } else {
    // Full-subnet reservation — check no active full-subnet reservation exists
    const existing = await prisma.reservation.findFirst({
      where: { subnetId: input.subnetId, ipAddress: null, status: "active" },
    });
    if (existing)
      throw new AppError(
        409,
        `Subnet ${subnet.cidr} is already fully reserved (reservation: ${existing.id})`
      );
  }
}

// Phase 4: release any superseded observational rows at the target, then
// create the row (+ flip the subnet to reserved for a full-subnet claim) in
// one transaction. Releasing the dns_resolved fallback / observed dhcp_lease
// FIRST is required — the manual create is the authoritative claim and the
// unique-on-active constraint won't let both coexist. The lease supersede
// delegates to releaseReservation, so on push-enabled subnets the device
// lease is expired exactly as the old client release+create flow did.
// Per-IP only; full-subnet reservations don't collide with the per-IP rows.
async function persistReservationRow(
  input: CreateReservationInput,
  macClean: string | null,
  resolvedOwner: string | null,
) {
  if (input.ipAddress) {
    await releaseDnsResolvedAt(input.subnetId, input.ipAddress);
    await releaseSupersededDhcpLeaseAt(input.subnetId, input.ipAddress, input.createdBy ?? null);
  }
  return prisma.$transaction(async (tx) => {
    const res = await tx.reservation.create({
      data: {
        subnetId: input.subnetId,
        ipAddress: input.ipAddress ?? null,
        hostname: input.hostname,
        owner: resolvedOwner,
        projectRef: input.projectRef || null,
        expiresAt: input.expiresAt,
        notes: input.notes,
        status: "active",
        createdBy: input.createdBy ?? null,
        macAddress: macClean,
      } as any,
    });

    if (!input.ipAddress) {
      await tx.subnet.update({
        where: { id: input.subnetId },
        data: { status: "reserved" },
      });
    }

    return res;
  });
}

async function createReservationFlow(input: CreateReservationInput) {
  // 1. Load the target subnet (with integration for push eligibility)
  const subnet = await prisma.subnet.findUnique({
    where: { id: input.subnetId },
    include: { integration: true },
  });
  if (!subnet) throw new AppError(404, `Subnet ${input.subnetId} not found`);
  if (subnet.status === "deprecated")
    throw new AppError(409, `Subnet ${subnet.cidr} is deprecated and cannot accept new reservations`);

  // 2. Validate the requested IP / full-subnet target and 409 on collision.
  await assertReservationTargetAvailable(input, subnet);

  // 3. Resolve push eligibility BEFORE creating the row so we can fail fast
  //    on missing MAC without leaving a half-created reservation behind.
  const push = resolvePushEligibility(
    subnet,
    subnet.integration,
    input.ipAddress ?? null,
  );
  if (push.eligible) {
    if (!input.macAddress || !input.macAddress.trim()) {
      throw new AppError(
        400,
        "MAC address is required — this subnet's integration is configured to push reservations to the FortiGate, and DHCP reservations are MAC→IP",
      );
    }
    if (!push.deviceName) {
      throw new AppError(
        409,
        `Subnet ${subnet.cidr} has no fortigateDevice — the integration discovered the subnet without a device name, so push cannot resolve a target FortiGate`,
      );
    }
    // The device-side `description` is composed from creator + notes +
    // hostname and FortiOS holds 255 characters of it (business rule 74).
    // Refuse here, before the row exists, rather than shipping a comment the
    // gate will truncate.
    assertReservationDescriptionFits({
      hostname: input.hostname ?? null,
      createdBy: input.createdBy ?? null,
      ip: input.ipAddress!,
      notes: input.notes ?? null,
    });
  }

  // 4. Create the reservation (+ mark subnet reserved if full-subnet) —
  // superseded observational rows released first inside persistReservationRow.
  const macClean = input.macAddress ? normalizeMac(input.macAddress) : null;
  // Auto-stamp owner with the creator's username when they didn't type one —
  // mirrors updateReservation's actor auto-stamp so a freshly created row
  // shows who claimed the IP instead of an empty Owner cell.
  const resolvedOwner = input.owner || input.createdBy || null;
  const reservation = await persistReservationRow(input, macClean, resolvedOwner);

  // 5. If push isn't eligible, we're done.
  if (!push.eligible || !push.integration || !input.ipAddress || !macClean) {
    return reservation;
  }

  // 6. Push to FortiGate. (The guard above narrowed push.integration and
  // input.ipAddress non-null — restate that for the helper's param types.)
  return pushNewReservation(
    reservation,
    input,
    subnet,
    { integration: push.integration, deviceName: push.deviceName },
    input.ipAddress,
    macClean,
  );
}

// Phase 6 of the create flow: push the freshly created reservation to its
// FortiGate. Three outcomes:
//   - Success: stamp pushed pointers + flip sourceType to dhcp_reservation.
//   - Permanent failure (4xx, verify mismatch, auth fail): roll back the
//     Polaris row so the create reads as atomic from the operator's
//     perspective and they see the underlying error.
//   - Transient failure (FortiGate offline, FMG unreachable, timeout):
//     KEEP the Polaris row, stamp pushStatus="pending" + queue cols, and
//     let the retry job push it when the gate comes back. Operator's
//     claim on the IP survives the outage.
//
// Pre-flight: if the originating FortiGate's firewall Asset is monitored
// and currently down, skip the transport attempt entirely — we already
// know it will fail, and the 15s+ transport timeout is wasted UI latency
// on the create critical path.
async function pushNewReservation(
  reservation: { id: string },
  input: CreateReservationInput,
  subnet: { cidr: string; discoveredBy: string | null },
  push: { integration: { id: string; type: string; config: unknown }; deviceName: string },
  ip: string,
  macClean: string,
) {
  let firewallKnownDown = false;
  try {
    const firewallAsset = await prisma.asset.findFirst({
      where: {
        hostname: push.deviceName,
        assetType: "firewall",
        discoveredByIntegrationId: push.integration.id,
      },
      select: { monitored: true, monitorStatus: true },
    });
    firewallKnownDown =
      !!firewallAsset?.monitored && firewallAsset.monitorStatus === "down";
  } catch {
    // Best-effort. If the asset lookup fails, fall through to the normal push
    // attempt — the transport will surface the real error.
  }

  if (firewallKnownDown) {
    const stamped = await prisma.reservation.update({
      where: { id: reservation.id },
      data: {
        // Keep sourceType="manual" until the push actually lands. pushedToId
        // is stamped now as the target identity so the retry tick + queue UI
        // can render it before the first device write.
        pushedToId: subnet.discoveredBy,
        pushStatus: "pending",
        pushQueuedAt: new Date(),
        pushAttempts: 0,
        pushLastAttemptAt: null,
        pushError: `FortiGate "${push.deviceName}" is currently down — queued without attempting transport`,
      },
    });
    void logEvent({
      action: "reservation.push.queued",
      level: "info",
      resourceType: "reservation",
      resourceId: stamped.id,
      resourceName: stamped.hostname || stamped.ipAddress || undefined,
      actor: input.createdBy ?? undefined,
      message: `Reservation queued for push to FortiGate "${push.deviceName}" — gate is down, will retry when it recovers`,
      details: {
        deviceName: push.deviceName,
        ip,
        mac: macClean,
        reason: "firewall_down",
      },
    });
    return stamped;
  }

  try {
    const pushed: PushReservationResult = await pushReservation({
      reservationId: reservation.id,
      subnetCidr: subnet.cidr,
      ip,
      mac: macClean,
      hostname: input.hostname ?? null,
      notes: input.notes ?? null,
      createdBy: input.createdBy ?? null,
      integration: push.integration,
      deviceName: push.deviceName,
    });

    const stamped = await prisma.reservation.update({
      where: { id: reservation.id },
      data: {
        // Once the entry is on the device, it really is a DHCP reservation —
        // flip the source type so the UI badges it accordingly AND so the
        // next discovery run sees a matching dhcp_reservation row (not a
        // manual one) and doesn't raise a spurious conflict against our
        // own echo. pushedToId remains the audit trail of "Polaris pushed
        // this," which is the source-of-truth answer to the origin question.
        sourceType: "dhcp_reservation",
        pushedToId: subnet.discoveredBy,
        pushedScopeId: pushed.scopeId,
        pushedEntryId: pushed.entryId,
        pushStatus: "synced",
        pushedAt: new Date(),
        pushError: null,
        // Clear any stale queue cols (relevant when the retry tick is the
        // caller — see retryPendingReservations / retryReservationNow).
        pushQueuedAt: null,
        pushAttempts: 0,
        pushLastAttemptAt: null,
      },
    });

    void logEvent({
      action: "reservation.push.succeeded",
      level: "info",
      resourceType: "reservation",
      resourceId: stamped.id,
      resourceName: stamped.hostname || stamped.ipAddress || undefined,
      actor: input.createdBy ?? undefined,
      message: `Reservation pushed to FortiGate "${push.deviceName}" (scope ${pushed.scopeId}, entry ${pushed.entryId})`,
      details: {
        deviceName: push.deviceName,
        scopeId: pushed.scopeId,
        entryId: pushed.entryId,
        serverInterface: pushed.serverInterface,
        ip,
        mac: macClean,
      },
    });

    return stamped;
  } catch (err: any) {
    const kind = classifyPushError(err);
    if (kind === "transient") {
      // Persist the Polaris row in pending state. Retry job will push when
      // the gate is reachable. sourceType stays "manual" because nothing is
      // on the device yet.
      const stamped = await prisma.reservation.update({
        where: { id: reservation.id },
        data: {
          pushedToId: subnet.discoveredBy,
          pushStatus: "pending",
          pushQueuedAt: new Date(),
          pushAttempts: 1,
          pushLastAttemptAt: new Date(),
          pushError: err?.message || String(err),
        },
      });
      void logEvent({
        action: "reservation.push.queued",
        level: "info",
        resourceType: "reservation",
        resourceId: stamped.id,
        resourceName: stamped.hostname || stamped.ipAddress || undefined,
        actor: input.createdBy ?? undefined,
        message: `Reservation queued for push to FortiGate "${push.deviceName}" — ${err?.message || "transient transport failure"}; will retry automatically`,
        details: {
          deviceName: push.deviceName,
          ip,
          mac: macClean,
          error: err?.message || String(err),
        },
      });
      return stamped;
    }
    // Permanent failure: roll back. Don't leave a Polaris ghost.
    try {
      await prisma.reservation.delete({ where: { id: reservation.id } });
    } catch {
      // Swallow rollback failure — the original push error is more useful.
    }
    void logEvent({
      action: "reservation.push.failed",
      level: "warning",
      resourceType: "reservation",
      resourceName: input.hostname || input.ipAddress || undefined,
      actor: input.createdBy ?? undefined,
      message: `Reservation push to FortiGate "${push.deviceName}" failed — reservation aborted: ${err?.message || "Unknown error"}`,
      details: {
        deviceName: push.deviceName,
        ip,
        mac: macClean,
        error: err?.message || String(err),
      },
    });
    throw err;
  }
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateReservation(
  id: string,
  input: UpdateReservationInput,
  opts: { actor?: string | null } = {}
) {
  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: { subnet: { include: { integration: true } } },
  });
  if (!reservation) throw new AppError(404, `Reservation ${id} not found`);
  if (reservation.status !== "active")
    throw new AppError(409, `Cannot update a ${reservation.status} reservation`);

  // Auto-stamp owner with the caller's username when they didn't explicitly
  // type a different value. Pairs with the discovery sync's MAC-aware owner
  // preservation in Phase 6 of syncDhcpSubnets: as long as the device-side
  // MAC stays the same, this stamp survives across discovery cycles, so the
  // last operator to touch the row stays visible. When MAC changes (a
  // different physical device now uses the IP) discovery wins.
  const actor = (opts.actor || "").trim();
  const resolvedOwner = input.owner !== undefined ? input.owner : (actor || undefined);

  // Normalize incoming MAC for comparison. Empty string → caller wants to
  // clear the stored MAC; null/undefined → caller isn't touching the MAC.
  let normalizedNewMac: string | null | undefined;
  if (input.macAddress !== undefined) {
    const trimmed = input.macAddress.trim();
    if (trimmed === "") {
      normalizedNewMac = null;
    } else {
      normalizedNewMac = normalizeMac(trimmed);
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalizedNewMac)) {
        throw new AppError(400, `Invalid MAC address: ${input.macAddress}`);
      }
    }
  }
  const currentNormalizedMac = reservation.macAddress
    ? normalizeMac(reservation.macAddress)
    : null;
  const macChanged =
    normalizedNewMac !== undefined && normalizedNewMac !== currentNormalizedMac;

  // Push eligibility for THIS reservation's subnet.
  const integration = reservation.subnet.integration;
  const pushEligible =
    integrationPushEnabled(integration) &&
    !!reservation.subnet.fortigateDevice &&
    !!reservation.ipAddress;

  // Business rule 74.
  // The notes an edit stores are the device-side description's body — on the
  // next MAC push, on the retry tick, or on a later re-push — so they are held
  // to the FortiGate's 255-character budget even when this particular save
  // contacts no device. Hostname counts too: it rides inside the same 255.
  //
  // Judged only when the edit TOUCHES one of those two, and then against what
  // the update will actually store (`undefined` means "not changing that
  // field", so Prisma leaves the stored value in place). A row whose note was
  // written before this rule — or by discovery, which this never gates — must
  // stay editable: refusing every save on it would strand the row, and the
  // operator changing its expiry did not author the over-length description.
  // Those rows keep the truncating backstop in buildDescription.
  const descriptionTouched = input.hostname !== undefined || input.notes !== undefined;
  if (pushEligible && descriptionTouched) {
    assertReservationDescriptionFits({
      hostname: input.hostname !== undefined ? input.hostname : reservation.hostname,
      createdBy: reservation.createdBy,
      ip: reservation.ipAddress!,
      notes: input.notes !== undefined ? input.notes : reservation.notes,
    });
  }

  // Updating a push-eligible reservation's MAC must succeed on the device
  // before we touch Polaris — otherwise the two views diverge.
  let pushStateUpdates: {
    pushedToId: string;
    pushedScopeId: number;
    pushedEntryId: number;
    pushedAt: Date;
    pushStatus: string;
    pushError: null;
  } | null = null;

  // A "pending" row hasn't been written to the device yet, so updating it
  // doesn't need device-side coordination — just rewrite the queued payload
  // and the retry tick will use the new values on its next attempt. The
  // MAC-clear rule still applies on push-eligible subnets: clearing it would
  // lock the row in pending forever since DHCP reservations require a MAC.
  const isQueued = reservation.pushStatus === "pending";

  if (macChanged && pushEligible && isQueued) {
    if (!normalizedNewMac) {
      throw new AppError(
        400,
        "Cannot clear MAC on a queued push-eligible reservation — the FortiGate write will require it. Release the reservation instead.",
      );
    }
    // No device contact while queued; just stash the new MAC. The retry tick
    // will push with this value on its next attempt.
  } else if (macChanged && pushEligible) {
    if (!normalizedNewMac) {
      throw new AppError(
        400,
        "Cannot clear MAC on a reservation whose subnet pushes DHCP reservations to a FortiGate — DHCP reservations are MAC→IP and require a MAC. Release the reservation instead.",
      );
    }
    const macForPush: string = normalizedNewMac;
    try {
      const result = await updatePushedReservation({
        reservationId: id,
        subnetCidr: reservation.subnet.cidr,
        ip: reservation.ipAddress!,
        newMac: macForPush,
        hostname: input.hostname ?? reservation.hostname,
        notes: input.notes ?? reservation.notes,
        createdBy: reservation.createdBy,
        scopeId: reservation.pushedScopeId,
        entryId: reservation.pushedEntryId,
        integration: { id: integration!.id, type: integration!.type, config: integration!.config },
        deviceName: reservation.subnet.fortigateDevice!,
      });
      pushStateUpdates = {
        pushedToId: integration!.id,
        pushedScopeId: result.scopeId,
        pushedEntryId: result.entryId,
        pushedAt: new Date(),
        pushStatus: "synced",
        pushError: null,
      };
      void logEvent({
        action: "reservation.push.updated",
        level: "info",
        resourceType: "reservation",
        resourceId: id,
        resourceName: reservation.hostname || reservation.ipAddress || undefined,
        message: `Reservation MAC updated on FortiGate "${reservation.subnet.fortigateDevice}" (scope ${result.scopeId}, entry ${result.entryId}): ${currentNormalizedMac ?? "(none)"} → ${normalizedNewMac}`,
        details: {
          deviceName: reservation.subnet.fortigateDevice,
          scopeId: result.scopeId,
          entryId: result.entryId,
          previousMac: currentNormalizedMac,
          newMac: normalizedNewMac,
        },
      });
    } catch (err: any) {
      void logEvent({
        action: "reservation.push.update_failed",
        level: "warning",
        resourceType: "reservation",
        resourceId: id,
        resourceName: reservation.hostname || reservation.ipAddress || undefined,
        message: `Failed to push MAC update for ${reservation.ipAddress} to FortiGate "${reservation.subnet.fortigateDevice}": ${err?.message || "Unknown error"}`,
        details: {
          deviceName: reservation.subnet.fortigateDevice,
          previousMac: currentNormalizedMac,
          attemptedMac: normalizedNewMac,
          error: err?.message || String(err),
        },
      });
      throw err;
    }
  }

  const updated = await prisma.reservation.update({
    where: { id },
    data: {
      hostname: input.hostname,
      owner: resolvedOwner,
      projectRef: input.projectRef,
      expiresAt: input.expiresAt,
      notes: input.notes,
      ...(macChanged ? { macAddress: normalizedNewMac } : {}),
      ...(pushStateUpdates ?? {}),
    },
  });
  const changes = buildChanges(
    { hostname: reservation.hostname, owner: reservation.owner, macAddress: reservation.macAddress, projectRef: reservation.projectRef, expiresAt: reservation.expiresAt, notes: reservation.notes },
    { hostname: updated.hostname, owner: updated.owner, macAddress: updated.macAddress, projectRef: updated.projectRef, expiresAt: updated.expiresAt, notes: updated.notes },
  );
  void logEvent({
    action: "reservation.updated",
    resourceType: "reservation",
    resourceId: id,
    resourceName: input.hostname,
    actor: actor || undefined,
    message: `Reservation updated`,
    details: changes ? { changes } : undefined,
  });
  return updated;
}

// ─── Release ──────────────────────────────────────────────────────────────────

/**
 * Best-effort DHCP lease release on the owning FortiGate with the paired
 * lease_release succeeded/failed audit Events. Never throws — device-side
 * failure is recorded and the Polaris release proceeds. `failureContext`
 * names what already happened Polaris-side so the failure Event tells the
 * operator the local state.
 */
async function releaseLeaseBestEffort(opts: {
  integration: Parameters<typeof releaseDhcpLease>[0]["integration"];
  deviceName: string;
  ip: string;
  reservationId: string;
  reservationHostname: string | null;
  failureContext: string;
}): Promise<void> {
  const { integration, deviceName, ip } = opts;
  try {
    await releaseDhcpLease({ integration, deviceName, ip });
    void logEvent({
      action: "reservation.lease_release.succeeded",
      level: "info",
      resourceType: "reservation",
      resourceId: opts.reservationId,
      resourceName: opts.reservationHostname || ip,
      message: `DHCP lease for ${ip} released on FortiGate "${deviceName}"`,
      details: { deviceName, ip, integrationId: integration.id },
    });
  } catch (err: any) {
    void logEvent({
      action: "reservation.lease_release.failed",
      level: "warning",
      resourceType: "reservation",
      resourceId: opts.reservationId,
      resourceName: opts.reservationHostname || ip,
      message: `DHCP lease release for ${ip} on FortiGate "${deviceName}" failed — ${opts.failureContext}: ${err?.message || "Unknown error"}`,
      details: {
        deviceName,
        ip,
        integrationId: integration.id,
        error: err?.message || String(err),
      },
    });
  }
}

export async function releaseReservation(id: string, actor?: string) {
  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: {
      subnet: { include: { integration: true } },
      pushedTo: true,
    },
  });

  if (!reservation) throw new AppError(404, `Reservation ${id} not found`);
  if (reservation.status !== "active")
    throw new AppError(409, `Reservation is already ${reservation.status}`);

  // Queued rows haven't written anything to the device yet, so there's
  // nothing to unpush and no DHCP lease to release. Skip the device-contact
  // blocks entirely and emit a cleaner audit Event than the
  // unpush-fails-then-release path would.
  const isQueued = reservation.pushStatus === "pending";
  if (isQueued) {
    void logEvent({
      action: "reservation.push.queued.released",
      level: "info",
      resourceType: "reservation",
      resourceId: id,
      resourceName: reservation.hostname || reservation.ipAddress || undefined,
      message: `Queued reservation released without device contact — nothing was pushed yet${reservation.subnet.fortigateDevice ? ` (target was FortiGate "${reservation.subnet.fortigateDevice}")` : ""}`,
      details: {
        deviceName: reservation.subnet.fortigateDevice || null,
        ip: reservation.ipAddress,
        mac: reservation.macAddress,
        queuedAt: reservation.pushQueuedAt,
        attempts: reservation.pushAttempts,
      },
    });
  }

  // Best-effort unpush from the FortiGate before flipping Polaris state.
  // We tolerate device-side failures (offline, missing entry, etc.) so an
  // unreachable FortiGate doesn't block the operator from releasing — but
  // we surface the failure as a `reservation.unpush.failed` Event so the
  // orphan is auditable.
  //
  // A dhcp_reservation entry exists on the device in one of two ways:
  //   1. Polaris pushed it — pushedTo + pushedScopeId + pushedEntryId pinned;
  //      unpush deletes it by those ids (fires regardless of the current
  //      toggle, to clean up what Polaris created).
  //   2. Discovery learned it from the gate — sourceType "dhcp_reservation"
  //      with no push pointers. Releasing it should delete it on the device
  //      too, else the next discovery pass just re-creates the Polaris row.
  //      Gated on the integration's pushReservations (DHCP writeback) toggle
  //      so read-only-discovery installs never mutate device config; the scope
  //      is resolved by CIDR and the entry by IP inside unpushReservation.
  const integrationConfig =
    (reservation.subnet.integration?.config as { pushReservations?: boolean } | null) || null;
  const writebackEnabled = integrationConfig?.pushReservations === true;

  const pinnedUnpush = !!(
    reservation.pushedTo &&
    reservation.pushedScopeId !== null &&
    reservation.pushedEntryId !== null
  );
  const discoveredUnpush =
    !pinnedUnpush &&
    reservation.sourceType === "dhcp_reservation" &&
    !!reservation.ipAddress &&
    !!reservation.subnet.integration &&
    !!reservation.subnet.fortigateDevice &&
    writebackEnabled;

  if (!isQueued && (pinnedUnpush || discoveredUnpush)) {
    const integration = (pinnedUnpush ? reservation.pushedTo : reservation.subnet.integration)!;
    const deviceName = reservation.subnet.fortigateDevice || "";
    if (deviceName) {
      try {
        const result = await unpushReservation({
          reservationId: id,
          scopeId: reservation.pushedScopeId,
          entryId: reservation.pushedEntryId,
          subnetCidr: reservation.subnet.cidr,
          ip: reservation.ipAddress || undefined,
          integration,
          deviceName,
        });
        void logEvent({
          action: "reservation.unpush.succeeded",
          level: "info",
          resourceType: "reservation",
          resourceId: id,
          resourceName: reservation.hostname || reservation.ipAddress || undefined,
          message: result.alreadyAbsent
            ? `Reservation unpush — entry was already absent on FortiGate "${deviceName}"`
            : `Reservation unpushed from FortiGate "${deviceName}"${discoveredUnpush ? " (discovered reservation)" : ` (scope ${reservation.pushedScopeId}, entry ${reservation.pushedEntryId})`}`,
          details: {
            deviceName,
            scopeId: reservation.pushedScopeId,
            entryId: reservation.pushedEntryId,
            discovered: discoveredUnpush,
            alreadyAbsent: result.alreadyAbsent,
          },
        });
      } catch (err: any) {
        void logEvent({
          action: "reservation.unpush.failed",
          level: "warning",
          resourceType: "reservation",
          resourceId: id,
          resourceName: reservation.hostname || reservation.ipAddress || undefined,
          message: `Reservation unpush from FortiGate "${deviceName}" failed — Polaris release proceeded but the device entry may be orphaned: ${err?.message || "Unknown error"}`,
          details: {
            deviceName,
            scopeId: reservation.pushedScopeId,
            entryId: reservation.pushedEntryId,
            discovered: discoveredUnpush,
            error: err?.message || String(err),
          },
        });
      }

      // Deleting the reserved-address only unbinds the MAC→IP reservation; a
      // client currently holding the IP keeps its lease until expiry. Drop it
      // too via the monitor `release-lease` endpoint so the address is fully
      // freed on the device. Independent best-effort step — a lease-release
      // failure doesn't undo the unpush or block the Polaris release.
      if (reservation.ipAddress) {
        await releaseLeaseBestEffort({
          integration,
          deviceName,
          ip: reservation.ipAddress,
          reservationId: id,
          reservationHostname: reservation.hostname,
          failureContext: "reservation entry removed but the device may still hold the lease",
        });
      }
    }
  }

  // Best-effort DHCP lease release for discovered dhcp_lease rows. Gated on
  // the originating integration's pushReservations toggle (the "DHCP Push"
  // tab) — both halves of the Polaris-to-FortiGate DHCP write path live
  // under that single toggle. The lease exists on the FortiGate's DHCP
  // server, not in any Polaris-pushed CMDB entry, so we hit the monitor
  // `release-lease` endpoint to expire it now. Device-side failure does not
  // block the Polaris release — the operator's intent has been recorded and
  // the next discovery pass will rediscover the lease if FortiOS still
  // holds it.
  if (
    !isQueued &&
    reservation.sourceType === "dhcp_lease" &&
    reservation.ipAddress &&
    reservation.subnet.integration &&
    reservation.subnet.fortigateDevice &&
    integrationConfig?.pushReservations === true
  ) {
    await releaseLeaseBestEffort({
      integration: reservation.subnet.integration,
      deviceName: reservation.subnet.fortigateDevice,
      ip: reservation.ipAddress,
      reservationId: id,
      reservationHostname: reservation.hostname,
      failureContext: "Polaris release proceeded but the device may still hold the lease",
    });
  }

  const releasedRow = await prisma.$transaction(async (tx) => {
    // The @@unique([subnetId, ipAddress, status]) constraint means we can't
    // have two released rows for the same IP. Reserve→unreserve→reserve→
    // unreserve cycles would otherwise collide on the second release. The
    // historical released row carries no information not already captured in
    // the audit log (reservation.released Event), so dropping it is safe.
    await tx.reservation.deleteMany({
      where: {
        id: { not: id },
        subnetId: reservation.subnetId,
        ipAddress: reservation.ipAddress,
        status: "released",
      },
    });

    const released = await tx.reservation.update({
      where: { id },
      data: {
        status: "released",
        // Clear push pointers — the device entry is gone (or orphaned and
        // logged) and a future re-reservation should make its own push.
        // Queue cols (pushQueuedAt/Attempts/LastAttemptAt/Error) cleared too
        // so a queued row that's released leaves a clean audit row.
        pushedToId: null,
        pushedScopeId: null,
        pushedEntryId: null,
        pushStatus: null,
        pushedAt: null,
        pushQueuedAt: null,
        pushAttempts: 0,
        pushLastAttemptAt: null,
        pushError: null,
      },
    });

    // If it was a full-subnet reservation, set subnet back to available
    if (!reservation.ipAddress) {
      await tx.subnet.update({
        where: { id: reservation.subnetId },
        data: { status: "available" },
      });
    }

    return released;
  });

  // Emitted after the transaction commits (phantom-on-rollback otherwise).
  // The queued path's reservation.push.queued.released Event above is the
  // push-lifecycle detail row; this is the top-level audit row — both fire,
  // matching the historical route + service split.
  void logEvent({
    action: "reservation.released",
    resourceType: "reservation",
    resourceId: id,
    resourceName: reservation.hostname || reservation.ipAddress || undefined,
    actor,
    message: `Reservation released`,
  });
  return releasedRow;
}

// ─── Managed-infra reservation release (device lifecycle) ─────────────────────

/**
 * Release the reservations a set of managed FortiSwitches / FortiAPs hold,
 * because those devices are being decommissioned or deleted.
 *
 * Why this exists: Phase 3a/3b create a reservation for every managed switch/AP,
 * but NOTHING in the device lifecycle ever released one. Phase 2a's controller
 * cascade and Phase 2b's stale-infra sweep flip asset status only
 * (`releaseAssetsForDecommission` is maintenance-window bookkeeping, not
 * reservations), and the asset DELETE routes don't either — so a removed AP left
 * its address claimed forever. That is merely untidy while the rows are
 * Polaris-local; once a reservation is PUSHED to a gate it becomes a real
 * orphaned MAC→IP binding, which is why this has to exist before any auto-push
 * feature does.
 *
 * Everything device-side is already handled by `releaseReservation`: it deletes
 * the CMDB reserved-address entry (pinned ids, or resolved-by-IP for a
 * discovered row when writeback is on) and expires the lease, both best-effort
 * with `reservation.unpush.failed` / `reservation.lease_release.*` Events when
 * the gate can't be reached. For a plain Polaris-local infra row neither branch
 * fires and the release is pure DB.
 *
 * Three guardrails, each covering a way this could take something that isn't its
 * to take:
 *   • Scope. Reservations are matched by IP, and RFC1918 space repeats behind
 *     different gates. When both sides know their integration the row's subnet
 *     must belong to the asset's, and when both sides name a FortiGate those
 *     must agree too (the same per-(device, ip) scoping business rule 17 applies
 *     to ARP evidence).
 *   • Ownership. Only a fortiswitch/fortinap row, or a Polaris-PUSHED row that
 *     `reservationBelongsToInfraDevice` ties to this device. An operator's own
 *     manual reservation at the address is never released by a device going away.
 *   • Bounding. `releaseReservation` can perform device I/O per row, and a
 *     controller cascade can cover hundreds of APs. Work is capped per
 *     invocation and the remainder is reported as `deferred` for the next pass —
 *     the release is idempotent (a released row stops matching), so retrying
 *     costs nothing. Never fans out over a whole fleet at once.
 *
 * Never throws: a decommission must not fail because a gate was unreachable.
 */
export interface InfraReservationReleaseResult {
  released: number;
  /** Eligible but over the per-invocation cap; picked up next time. */
  deferred: number;
  /** A row existed at the address but belongs to something else. */
  skipped: number;
  failed: number;
}

/** Per-invocation release cap. Sized like the discovery-side paced passes. */
const INFRA_RELEASE_CEILING = 100;

export async function releaseInfraReservationsForAssets(
  assetIds: string[],
  opts: { reason: string; actor?: string | null; limit?: number },
): Promise<InfraReservationReleaseResult> {
  // The whole body is guarded, not just the per-row releases: callers are
  // decommission paths mid-phase (discovery Phase 2a/2b) and delete routes, and
  // "the address wasn't given back" must never escalate into "the decommission
  // failed". A lost pass is picked up by reconcileInfraReservations.
  try {
    return await releaseInfraReservationsForAssetsInner(assetIds, opts);
  } catch (err) {
    logger.warn({ err, reason: opts.reason, assetCount: assetIds.length },
      "releaseInfraReservationsForAssets failed; the orphan reconcile will retry");
    return { released: 0, deferred: 0, skipped: 0, failed: 0 };
  }
}

async function releaseInfraReservationsForAssetsInner(
  assetIds: string[],
  opts: { reason: string; actor?: string | null; limit?: number },
): Promise<InfraReservationReleaseResult> {
  const out: InfraReservationReleaseResult = { released: 0, deferred: 0, skipped: 0, failed: 0 };
  if (assetIds.length === 0) return out;

  const assets = await prisma.asset.findMany({
    where: { id: { in: assetIds }, ipAddress: { not: null } },
    select: {
      id: true, hostname: true, ipAddress: true, macAddress: true,
      discoveredByIntegrationId: true, fortinetTopology: true,
    },
  });
  if (assets.length === 0) return out;

  const ips = Array.from(new Set(assets.map((a) => a.ipAddress!).filter(Boolean)));
  const candidates = await prisma.reservation.findMany({
    where: { ipAddress: { in: ips }, status: "active" },
    select: {
      id: true, ipAddress: true, sourceType: true, macAddress: true, hostname: true,
      pushedToId: true, dhcpBinding: true,
      subnet: { select: { discoveredBy: true, fortigateDevice: true } },
    },
  });
  if (candidates.length === 0) return out;

  const byIp = new Map<string, typeof candidates>();
  for (const c of candidates) {
    if (!c.ipAddress) continue;
    const list = byIp.get(c.ipAddress) || [];
    list.push(c);
    byIp.set(c.ipAddress, list);
  }

  const targets: { id: string; ip: string }[] = [];
  for (const asset of assets) {
    const topo = (asset.fortinetTopology as Record<string, unknown> | null) || null;
    const device = {
      mac: asset.macAddress,
      name: asset.hostname,
      integrationId: asset.discoveredByIntegrationId,
      controllerFortigate: (topo?.controllerFortigate as string | undefined) || null,
    };
    for (const row of byIp.get(asset.ipAddress!) || []) {
      // Scope + ownership both live in the pure predicate (unit-tested).
      const release = shouldReleaseInfraReservation(device, {
        sourceType: row.sourceType,
        macAddress: row.macAddress,
        hostname: row.hostname,
        pushedToId: row.pushedToId,
        subnetDiscoveredBy: row.subnet.discoveredBy,
        subnetFortigateDevice: row.subnet.fortigateDevice,
      });
      if (!release) { out.skipped++; continue; }

      targets.push({ id: row.id, ip: row.ipAddress! });
    }
  }
  if (targets.length === 0) return out;

  const cap = opts.limit ?? INFRA_RELEASE_CEILING;
  const batch = targets.slice(0, cap);
  out.deferred = targets.length - batch.length;

  const results = await mapSettledWithConcurrency(batch, 4, async (t) =>
    releaseReservation(t.id, opts.actor ?? undefined),
  );
  results.forEach((r, i) => {
    if (r.status === "fulfilled") { out.released++; return; }
    out.failed++;
    // Best-effort by design: a gate that refused the unpush already logged its
    // own warning Event, and the asset's decommission must still proceed.
    logger.warn(
      { reservationId: batch[i].id, ip: batch[i].ip, reason: opts.reason, err: (r as PromiseRejectedResult).reason },
      "releaseInfraReservationsForAssets: release failed",
    );
  });

  if (out.released > 0 || out.failed > 0) {
    // One summary row rather than a second per-row Event: releaseReservation
    // already writes `reservation.released` per row, and this carries the thing
    // that row can't — WHY the address was given up.
    void logEvent({
      action: "reservation.infra.released",
      resourceType: "reservation",
      actor: opts.actor ?? undefined,
      level: out.failed > 0 ? "warning" : "info",
      message: `Released ${out.released} managed-device reservation(s) — ${opts.reason}`
        + (out.failed > 0 ? `; ${out.failed} failed` : "")
        + (out.deferred > 0 ? `; ${out.deferred} deferred to the next pass` : ""),
      details: {
        reason: opts.reason,
        released: out.released,
        failed: out.failed,
        deferred: out.deferred,
        skipped: out.skipped,
        ips: batch.slice(0, 25).map((t) => t.ip),
      },
    });
  }
  return out;
}

/**
 * Safety net for managed-infra reservations whose device is gone.
 *
 * The lifecycle hooks above cover every path we know about, but they all run at
 * the moment the device goes away — so a decommission that happens while the
 * FortiGate is unreachable, a code path added later that forgets to call them,
 * or rows created before this feature existed all leak a claimed address (and,
 * once auto-push lands, a real MAC→IP binding on the gate). This sweep is the
 * backstop that converges those.
 *
 * Deliberately asymmetric about how much evidence each action needs, because the
 * two cases carry different costs:
 *   • Asset explicitly `decommissioned` → release, including a pushed row. The
 *     operator or a discovery sweep already made that judgement.
 *   • NO asset found at the address → release ONLY when the row was never pushed.
 *     "No asset" is the weaker signal (a transient discovery state, an asset
 *     create that failed after its reservation landed) and a false positive on a
 *     pushed row would mean an unnecessary WRITE to the gate. A Polaris-local row
 *     released in error costs nothing — the next discovery cycle re-creates it.
 *
 * Never releases a reservation that isn't a fortiswitch/fortinap row: an
 * operator's manual reservation for a device not yet in inventory is a normal,
 * intentional state and must survive forever.
 */
export async function reconcileOrphanedInfraReservations(
  opts: { limit?: number } = {},
): Promise<InfraReservationReleaseResult> {
  const out: InfraReservationReleaseResult = { released: 0, deferred: 0, skipped: 0, failed: 0 };

  const rows = await prisma.reservation.findMany({
    where: { status: "active", sourceType: { in: ["fortiswitch", "fortinap"] as any } },
    select: {
      id: true, ipAddress: true, hostname: true, pushedToId: true,
      subnet: { select: { discoveredBy: true } },
    },
  });
  if (rows.length === 0) return out;

  const ips = Array.from(new Set(rows.map((r) => r.ipAddress).filter((ip): ip is string => !!ip)));
  if (ips.length === 0) return out;

  const assets = await prisma.asset.findMany({
    where: { ipAddress: { in: ips }, assetType: { in: ["switch", "access_point"] } },
    select: { id: true, ipAddress: true, status: true, discoveredByIntegrationId: true },
  });
  const assetsByIp = new Map<string, typeof assets>();
  for (const a of assets) {
    if (!a.ipAddress) continue;
    const list = assetsByIp.get(a.ipAddress) || [];
    list.push(a);
    assetsByIp.set(a.ipAddress, list);
  }

  const orphans: { id: string; ip: string; why: string }[] = [];
  for (const row of rows) {
    if (!row.ipAddress) continue;
    // Same integration scoping as the release helper — overlapping RFC1918
    // space behind different gates must not cross-match.
    const matches = (assetsByIp.get(row.ipAddress) || []).filter(
      (a) =>
        !a.discoveredByIntegrationId ||
        !row.subnet.discoveredBy ||
        a.discoveredByIntegrationId === row.subnet.discoveredBy,
    );
    const verdict = classifyOrphanInfraRow(row, matches.map((a) => a.status));
    if (verdict === "keep") continue;
    if (verdict === "skip") { out.skipped++; continue; }
    orphans.push({
      id: row.id,
      ip: row.ipAddress,
      why: matches.length === 0 ? "no managed device holds this address" : "its managed device is decommissioned",
    });
  }
  if (orphans.length === 0) return out;

  const cap = opts.limit ?? INFRA_RELEASE_CEILING;
  const batch = orphans.slice(0, cap);
  out.deferred = orphans.length - batch.length;

  const results = await mapSettledWithConcurrency(batch, 4, async (o) =>
    releaseReservation(o.id, "system:infra-reservation-reconcile"),
  );
  results.forEach((r, i) => {
    if (r.status === "fulfilled") { out.released++; return; }
    out.failed++;
    logger.warn(
      { reservationId: batch[i].id, ip: batch[i].ip, err: (r as PromiseRejectedResult).reason },
      "reconcileOrphanedInfraReservations: release failed",
    );
  });

  if (out.released > 0 || out.failed > 0) {
    void logEvent({
      action: "reservation.infra.released",
      resourceType: "reservation",
      actor: "system:infra-reservation-reconcile",
      level: out.failed > 0 ? "warning" : "info",
      message: `Reconcile released ${out.released} orphaned managed-device reservation(s)`
        + (out.failed > 0 ? `; ${out.failed} failed` : "")
        + (out.deferred > 0 ? `; ${out.deferred} deferred to the next pass` : ""),
      details: {
        reason: "orphan-reconcile",
        released: out.released,
        failed: out.failed,
        deferred: out.deferred,
        skipped: out.skipped,
        sample: batch.slice(0, 25).map((o) => ({ ip: o.ip, why: o.why })),
      },
    });
  }
  return out;
}

// ─── Next Available IP ────────────────────────────────────────────────────────

/**
 * Ceiling on one bulk auto-allocation. The IP panel's multiple-IP mode builds
 * a row per address and each row is created with its own request, so this is
 * really a bound on how big a form an operator can be asked to fill in — not
 * a database limit. Bumping it costs nothing server-side; the UI is what gets
 * unwieldy first.
 */
export const MAX_BULK_ALLOCATE = 64;

/**
 * How far into a subnet the free-address scan will walk before giving up.
 * A /16 is 65534 hosts; anything larger is enumerated lazily by the IP panel
 * too, and an operator auto-allocating out of a /8 wants the low end of it
 * regardless. Bounds the memory this holds at ~a few MB of address strings.
 */
const SCAN_CEILING = 65536;

export interface NextAvailableReservationInput {
  subnetId: string;
  hostname?: string;
  owner?: string;
  projectRef?: string;
  expiresAt?: Date;
  notes?: string;
  createdBy?: string;
  macAddress?: string;
}

/**
 * The next `count` free host addresses in a subnet — the preview behind the
 * Auto-Allocate modal, and the picker behind `nextAvailableReservation`.
 *
 * `contiguous` asks for a single unbroken run rather than the first `count`
 * free addresses. When no such run exists the request is REFUSED with the
 * largest run that does — a short allocation is not a partial success, and
 * quietly falling back to scattered addresses would defeat the reason an
 * operator asked for a run in the first place (see the modal's hint text).
 *
 * Selection is pure and lives in `utils/ipAllocation.ts`; everything here is
 * the guards, the paged walk, and the message an operator reads when it can't
 * be satisfied.
 */
export async function findNextAvailableIps(
  subnetId: string,
  count: number,
  contiguous: boolean,
): Promise<string[]> {
  const subnet = await prisma.subnet.findUnique({ where: { id: subnetId } });
  if (!subnet) throw new AppError(404, `Subnet ${subnetId} not found`);
  if (subnet.status === "deprecated")
    throw new AppError(409, `Subnet ${subnet.cidr} is deprecated and cannot accept new reservations`);
  if (detectIpVersion(subnet.cidr) !== "v4")
    throw new AppError(400, "Auto-allocate is only supported for IPv4 subnets");
  if (!Number.isInteger(count) || count < 1)
    throw new AppError(400, "Count must be a positive whole number");
  if (count > MAX_BULK_ALLOCATE)
    throw new AppError(400, `Auto-allocate is limited to ${MAX_BULK_ALLOCATE} addresses at a time`);

  const activeReservations = await prisma.reservation.findMany({
    where: { subnetId, status: "active" },
    select: { ipAddress: true },
  });
  const reservedIps = new Set(
    activeReservations.map((r) => r.ipAddress).filter(Boolean) as string[],
  );

  const pageSize = 256;
  const hosts: string[] = [];
  let page = 1;
  let selection = selectAvailableIps(hosts, reservedIps, count, contiguous);

  while (hosts.length < SCAN_CEILING) {
    const { addresses, total } = enumerateSubnetIps(subnet.cidr, page, pageSize);
    for (const addr of addresses) {
      if (addr.type === "host") hosts.push(addr.address);
    }
    // Re-run the selection each page so a small ask out of a large subnet
    // stops walking as soon as it's satisfied. The earliest fitting run (or
    // the first `count` free addresses) can't move by scanning further, so
    // exiting here returns exactly what a full scan would have.
    if (hosts.length >= count) {
      selection = selectAvailableIps(hosts, reservedIps, count, contiguous);
      if (selection.ips.length === count) return selection.ips;
    }
    if (page * pageSize >= total) break;
    page++;
  }

  selection = selectAvailableIps(hosts, reservedIps, count, contiguous);
  if (selection.ips.length === count) return selection.ips;

  if (count === 1) {
    // Preserve the original single-IP wording — it's what the panel has
    // always said and what the tests assert.
    throw new AppError(409, `No available IP addresses in subnet ${subnet.cidr}`);
  }
  if (contiguous) {
    throw new AppError(
      409,
      `No run of ${count} consecutive free addresses in ${subnet.cidr} — the largest available run is ${selection.largestRun}`,
    );
  }
  throw new AppError(
    409,
    `Only ${selection.availableCount} free address${selection.availableCount === 1 ? "" : "es"} in ${subnet.cidr}`,
  );
}

export async function nextAvailableReservation(input: NextAvailableReservationInput) {
  const [found] = await findNextAvailableIps(input.subnetId, 1, false);
  return createReservation({ ...input, ipAddress: found as string, via: "auto-allocate" });
}

// ─── Expire (called by scheduled job) ────────────────────────────────────────

export async function expireStaleReservations(): Promise<number> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    // @@unique([subnetId, ipAddress, status]) permits only ONE `expired` row
    // per IP. A reserve → expire → re-reserve → expire cycle leaves a stale
    // `expired` row that collides when we flip the new active row to expired —
    // and because the flip is a single updateMany, ONE collision (P2002)
    // aborts the entire batch, so NOTHING expires and the job fails on every
    // 15-minute run (observed in prod: 10.0.80.24 wedged the whole sweep).
    // Drop the colliding historical `expired` rows first. Set-based
    // DELETE…USING so it scales to a large backlog without an N-clause OR; the
    // stale row carries nothing not already in the audit log — same rationale
    // as releaseReservation's pre-delete of prior `released` rows. NULL
    // ipAddress (full-subnet reservations) never collides — Postgres treats
    // NULL as distinct in unique indexes — and the `=` join excludes those.
    await tx.$executeRaw`
      DELETE FROM "reservations" AS stale
      USING "reservations" AS expiring
      WHERE stale.status::text = 'expired'
        AND expiring.status::text = 'active'
        AND expiring."expiresAt" < ${now}
        AND stale."subnetId" = expiring."subnetId"
        AND stale."ipAddress" = expiring."ipAddress"
    `;
    const result = await tx.reservation.updateMany({
      where: { status: "active", expiresAt: { lt: now } },
      data: { status: "expired" },
    });
    return result.count;
  });
}

// ─── Queued Push Queue View ──────────────────────────────────────────────────

/**
 * List every reservation currently in the queued-push state — pending
 * (awaiting a recovered FortiGate) or failed_permanent (terminal error that
 * needs operator action). Drives the global queue view page under Reservations
 * alerts. Joined with subnet + pushedTo so the UI can render hostname/IP/MAC
 * alongside the target integration name without N+1 fetches. Sorted by
 * pushQueuedAt asc (oldest first).
 */
export async function listPushQueue() {
  return prisma.reservation.findMany({
    where: {
      status: "active",
      pushStatus: { in: ["pending", "failed_permanent"] },
    },
    include: {
      subnet: {
        select: {
          id: true,
          cidr: true,
          name: true,
          vlan: true,
          fortigateDevice: true,
        },
      },
      pushedTo: { select: { id: true, name: true, type: true, enabled: true } },
    },
    orderBy: { pushQueuedAt: "asc" },
  });
}

export async function countPushQueue(): Promise<number> {
  return prisma.reservation.count({
    where: {
      status: "active",
      pushStatus: { in: ["pending", "failed_permanent"] },
    },
  });
}

// ─── Queued Push Retry ───────────────────────────────────────────────────────

const BACKOFF_BASE_SECONDS = 60;
const BACKOFF_CAP_SECONDS = 1800;

/**
 * Exponential backoff window for unmonitored FortiGates (or gates without an
 * Asset row). `min(60 * 2^(attempts-1), 1800)` seconds. attempts ≤ 0 → 30s,
 * 1 → 60s, 2 → 120s, … 6+ → 1800s (cap). Monitored gates bypass this — they
 * gate on `monitorStatus="up"` instead.
 */
function backoffSecondsFor(attempts: number): number {
  if (attempts <= 0) return BACKOFF_BASE_SECONDS / 2;
  const candidate = BACKOFF_BASE_SECONDS * Math.pow(2, attempts - 1);
  return Math.min(candidate, BACKOFF_CAP_SECONDS);
}

export type RetryOutcome =
  | "synced"
  | "transient"
  | "permanent"
  | "cancelled"
  | "superseded"
  | "skipped-monitored-down"
  | "skipped-backoff";

interface QueuedReservationRow {
  id: string;
  subnetId: string;
  ipAddress: string | null;
  hostname: string | null;
  notes: string | null;
  createdBy: string | null;
  macAddress: string | null;
  pushStatus: string | null;
  pushQueuedAt: Date | null;
  pushAttempts: number;
  pushLastAttemptAt: Date | null;
  subnet: {
    cidr: string;
    status: string;
    fortigateDevice: string | null;
    discoveredBy: string | null;
    integration:
      | {
          id: string;
          type: string;
          enabled: boolean;
          config: unknown;
        }
      | null;
  };
}

/**
 * Core per-row push attempt used by both the retry-tick (batch) and the
 * operator-triggered retry-now (single row) paths. Returns the outcome so the
 * caller can roll up counts and the route handler can return the fresh row.
 */
async function attemptQueuedPush(
  reservation: QueuedReservationRow,
  opts: { bypassReadinessGates: boolean; actor?: string | null },
): Promise<RetryOutcome> {
  const id = reservation.id;
  const integration = reservation.subnet.integration;
  const integrationConfig = (integration?.config ?? {}) as Record<string, unknown>;
  const cancelReason = (reason: string): "cancelled" => {
    void prisma.reservation
      .update({
        where: { id },
        data: {
          pushStatus: null,
          pushQueuedAt: null,
          pushAttempts: 0,
          pushLastAttemptAt: null,
          pushError: null,
          pushedToId: null,
        },
      })
      .catch(() => {/* best-effort */});
    void logEvent({
      action: "reservation.push.queued.cancelled",
      level: "info",
      resourceType: "reservation",
      resourceId: id,
      resourceName: reservation.hostname || reservation.ipAddress || undefined,
      actor: opts.actor ?? undefined,
      message: `Queued push cancelled — ${reason}; reservation kept as manual`,
      details: {
        reason,
        deviceName: reservation.subnet.fortigateDevice || null,
        ip: reservation.ipAddress,
      },
    });
    return "cancelled";
  };

  // 1. Eligibility re-check (Phase 5 drift).
  if (reservation.subnet.status === "deprecated") return cancelReason("subnet_deprecated");
  if (!reservation.subnet.fortigateDevice) return cancelReason("subnet_no_fortigateDevice");
  if (!reservation.ipAddress) return cancelReason("reservation_no_ip");
  if (!reservation.macAddress) return cancelReason("reservation_no_mac");
  if (!integration) return cancelReason("integration_deleted");
  if (!integration.enabled) return cancelReason("integration_disabled");
  if (integration.type !== "fortimanager" && integration.type !== "fortigate") {
    return cancelReason(`integration_type_${integration.type}_not_pushable`);
  }
  if (integrationConfig.pushReservations !== true) {
    return cancelReason("pushReservations_disabled");
  }

  // 2. Discovery-supersede: did a discovery cycle land a different row at our
  //    target IP while we were queued? If so, the device is authoritative —
  //    flip to failed_permanent so the operator can sort it out.
  const collider = await prisma.reservation.findFirst({
    where: {
      id: { not: id },
      subnetId: reservation.subnetId,
      ipAddress: reservation.ipAddress,
      status: "active",
    },
    select: { id: true, sourceType: true, macAddress: true },
  });
  if (collider) {
    const errMsg = `IP collided during queue — discovered ${collider.sourceType}${collider.macAddress ? ` by ${collider.macAddress}` : ""}`;
    await prisma.reservation.update({
      where: { id },
      data: {
        pushStatus: "failed_permanent",
        pushError: errMsg,
        pushLastAttemptAt: new Date(),
      },
    });
    void logEvent({
      action: "reservation.push.queued.collided",
      level: "warning",
      resourceType: "reservation",
      resourceId: id,
      resourceName: reservation.hostname || reservation.ipAddress || undefined,
      actor: opts.actor ?? undefined,
      message: `Queued push for ${reservation.ipAddress} aborted — ${errMsg}. Operator must release or pick a different IP.`,
      details: {
        ip: reservation.ipAddress,
        deviceName: reservation.subnet.fortigateDevice,
        colliderReservationId: collider.id,
        colliderSourceType: collider.sourceType,
        colliderMac: collider.macAddress,
      },
    });
    return "superseded";
  }

  // 3. Readiness gates (skipped on operator-triggered retry-now).
  if (!opts.bypassReadinessGates) {
    const firewallAsset = await prisma.asset.findFirst({
      where: {
        hostname: reservation.subnet.fortigateDevice!,
        assetType: "firewall",
        discoveredByIntegrationId: integration.id,
      },
      select: { monitored: true, monitorStatus: true },
    });
    // "passive" is exempt from the not-up deferral. A gate no down-detection
    // automation covers is never "up" BY CONSTRUCTION — Polaris renders no
    // verdict for it — so a bare `!== "up"` test would defer its reservation
    // pushes forever. Every other non-up state keeps deferring exactly as
    // before; passive is not evidence the gate is unreachable, it is the
    // absence of evidence either way.
    if (
      firewallAsset?.monitored &&
      firewallAsset.monitorStatus !== "up" &&
      firewallAsset.monitorStatus !== "passive"
    ) {
      return "skipped-monitored-down";
    }
    if (!firewallAsset?.monitored) {
      // Unmonitored or no Asset row → exponential backoff keyed on attempts.
      if (reservation.pushLastAttemptAt) {
        const ageMs = Date.now() - reservation.pushLastAttemptAt.getTime();
        const windowMs = backoffSecondsFor(reservation.pushAttempts) * 1000;
        if (ageMs < windowMs) {
          return "skipped-backoff";
        }
      }
    }
  }

  // 4. Attempt the push.
  await prisma.reservation.update({
    where: { id },
    data: {
      pushAttempts: { increment: 1 },
      pushLastAttemptAt: new Date(),
    },
  });

  try {
    const pushed: PushReservationResult = await pushReservation({
      reservationId: id,
      subnetCidr: reservation.subnet.cidr,
      ip: reservation.ipAddress!,
      mac: reservation.macAddress!,
      hostname: reservation.hostname ?? null,
      notes: reservation.notes ?? null,
      createdBy: reservation.createdBy ?? null,
      integration: { id: integration.id, type: integration.type, config: integration.config },
      deviceName: reservation.subnet.fortigateDevice!,
    });
    await prisma.reservation.update({
      where: { id },
      data: {
        sourceType: "dhcp_reservation",
        pushedToId: integration.id,
        pushedScopeId: pushed.scopeId,
        pushedEntryId: pushed.entryId,
        pushStatus: "synced",
        pushedAt: new Date(),
        pushError: null,
        pushQueuedAt: null,
        pushAttempts: 0,
        pushLastAttemptAt: null,
      },
    });
    void logEvent({
      action: "reservation.push.queued.succeeded",
      level: "info",
      resourceType: "reservation",
      resourceId: id,
      resourceName: reservation.hostname || reservation.ipAddress || undefined,
      actor: opts.actor ?? undefined,
      message: `Queued reservation pushed to FortiGate "${reservation.subnet.fortigateDevice}" (scope ${pushed.scopeId}, entry ${pushed.entryId})`,
      details: {
        deviceName: reservation.subnet.fortigateDevice,
        scopeId: pushed.scopeId,
        entryId: pushed.entryId,
        ip: reservation.ipAddress,
        mac: reservation.macAddress,
      },
    });
    return "synced";
  } catch (err: any) {
    const kind = classifyPushError(err);
    if (kind === "transient") {
      await prisma.reservation.update({
        where: { id },
        data: { pushError: err?.message || String(err) },
      });
      void logEvent({
        action: "reservation.push.queued.retry_failed",
        level: "info", // intentionally info — sustained outages would spam warning
        resourceType: "reservation",
        resourceId: id,
        resourceName: reservation.hostname || reservation.ipAddress || undefined,
        actor: opts.actor ?? undefined,
        message: `Retry push to FortiGate "${reservation.subnet.fortigateDevice}" failed (still queued): ${err?.message || "Unknown error"}`,
        details: {
          deviceName: reservation.subnet.fortigateDevice,
          ip: reservation.ipAddress,
          mac: reservation.macAddress,
          error: err?.message || String(err),
        },
      });
      return "transient";
    }
    await prisma.reservation.update({
      where: { id },
      data: {
        pushStatus: "failed_permanent",
        pushError: err?.message || String(err),
      },
    });
    void logEvent({
      action: "reservation.push.queued.failed_permanent",
      level: "warning",
      resourceType: "reservation",
      resourceId: id,
      resourceName: reservation.hostname || reservation.ipAddress || undefined,
      actor: opts.actor ?? undefined,
      message: `Queued push to FortiGate "${reservation.subnet.fortigateDevice}" hit a permanent error: ${err?.message || "Unknown error"}. Operator action required.`,
      details: {
        deviceName: reservation.subnet.fortigateDevice,
        ip: reservation.ipAddress,
        mac: reservation.macAddress,
        error: err?.message || String(err),
      },
    });
    return "permanent";
  }
}

const QUEUED_RESERVATION_INCLUDE = {
  subnet: {
    select: {
      cidr: true,
      status: true,
      fortigateDevice: true,
      discoveredBy: true,
      integration: {
        select: { id: true, type: true, enabled: true, config: true },
      },
    },
  },
} as const;

/**
 * Scan all `pushStatus="pending"` rows and try to push each one. Drives the
 * 60s background tick + the `monitor.status_changed → up` hook.
 */
export async function retryPendingReservations(): Promise<{
  attempted: number;
  succeeded: number;
  transient: number;
  permanent: number;
  cancelled: number;
  superseded: number;
  skippedMonitoredDown: number;
  skippedBackoff: number;
}> {
  const rows = await prisma.reservation.findMany({
    where: { pushStatus: "pending", status: "active" },
    orderBy: { pushQueuedAt: "asc" },
    include: QUEUED_RESERVATION_INCLUDE,
  });
  const counts = {
    attempted: 0,
    succeeded: 0,
    transient: 0,
    permanent: 0,
    cancelled: 0,
    superseded: 0,
    skippedMonitoredDown: 0,
    skippedBackoff: 0,
  };
  for (const row of rows) {
    counts.attempted += 1;
    const outcome = await attemptQueuedPush(row as QueuedReservationRow, {
      bypassReadinessGates: false,
    });
    if (outcome === "synced") counts.succeeded += 1;
    else if (outcome === "transient") counts.transient += 1;
    else if (outcome === "permanent") counts.permanent += 1;
    else if (outcome === "cancelled") counts.cancelled += 1;
    else if (outcome === "superseded") counts.superseded += 1;
    else if (outcome === "skipped-monitored-down") counts.skippedMonitoredDown += 1;
    else if (outcome === "skipped-backoff") counts.skippedBackoff += 1;
  }
  return counts;
}

/**
 * Operator-triggered single-row retry. Bypasses both the
 * `monitorStatus="up"` gate and the unmonitored-backoff window. Used by the
 * IP-panel "Retry now" button and the global push-queue page's per-row
 * action. Allowed on `pushStatus IN ("pending", "failed_permanent")` so an
 * operator can recover a `failed_permanent` row after fixing whatever the
 * permanent error called out (e.g. removing a colliding entry on the device).
 */
export async function retryReservationNow(
  id: string,
  actor: string | null | undefined,
): Promise<{ outcome: RetryOutcome; reservation: Awaited<ReturnType<typeof getReservation>> }> {
  const row = await prisma.reservation.findUnique({
    where: { id },
    include: QUEUED_RESERVATION_INCLUDE,
  });
  if (!row) throw new AppError(404, `Reservation ${id} not found`);
  if (row.status !== "active") throw new AppError(409, `Cannot retry a ${row.status} reservation`);
  if (row.pushStatus !== "pending" && row.pushStatus !== "failed_permanent") {
    throw new AppError(
      409,
      `Reservation ${id} is not queued (pushStatus=${row.pushStatus ?? "null"})`,
    );
  }
  // Flip failed_permanent back to pending so the retry path treats it
  // uniformly and the row joins the queue scan again.
  if (row.pushStatus === "failed_permanent") {
    await prisma.reservation.update({
      where: { id },
      data: {
        pushStatus: "pending",
        pushQueuedAt: row.pushQueuedAt ?? new Date(),
        pushError: row.pushError,
      },
    });
    void logEvent({
      action: "reservation.push.queued.retry_manual",
      level: "info",
      resourceType: "reservation",
      resourceId: id,
      resourceName: row.hostname || row.ipAddress || undefined,
      actor: actor ?? undefined,
      message: `Operator-triggered retry on a permanently-failed reservation — re-queued`,
      details: { ip: row.ipAddress, deviceName: row.subnet?.fortigateDevice ?? null },
    });
  } else {
    void logEvent({
      action: "reservation.push.queued.retry_manual",
      level: "info",
      resourceType: "reservation",
      resourceId: id,
      resourceName: row.hostname || row.ipAddress || undefined,
      actor: actor ?? undefined,
      message: `Operator-triggered retry of queued reservation`,
      details: { ip: row.ipAddress, deviceName: row.subnet?.fortigateDevice ?? null },
    });
  }
  const outcome = await attemptQueuedPush(row as QueuedReservationRow, {
    bypassReadinessGates: true,
    actor: actor ?? undefined,
  });
  const reservation = await getReservation(id);
  return { outcome, reservation };
}

/**
 * Called from the monitor `status_changed → up` hook. Cheaply checks whether
 * any pending reservations exist for the recovered FortiGate's subnets and
 * triggers a retry tick only if there are. Most up-transitions affect zero
 * queued rows, so the count gate keeps the hot status-change path cheap.
 */
export async function triggerRetryAfterStatusChange(assetId: string): Promise<void> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { hostname: true, assetType: true, discoveredByIntegrationId: true },
  });
  if (!asset || asset.assetType !== "firewall" || !asset.hostname || !asset.discoveredByIntegrationId) return;
  // Count pending reservations on any subnet this FortiGate owns through the
  // same integration. Cheap — uses the (pushStatus, pushQueuedAt) index plus
  // a subnet filter.
  const count = await prisma.reservation.count({
    where: {
      pushStatus: "pending",
      status: "active",
      subnet: {
        fortigateDevice: asset.hostname,
        discoveredBy: asset.discoveredByIntegrationId,
      },
    },
  });
  if (count === 0) return;
  // Fire and forget — outcome is logged per-row by attemptQueuedPush.
  void retryPendingReservations().catch(() => {/* logged inside */});
}
