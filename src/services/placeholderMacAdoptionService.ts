/**
 * src/services/placeholderMacAdoptionService.ts
 *
 * Replace a reservation's PLACEHOLDER MAC with the real one once discovery sees
 * an actual device answering at that reserved IP — in Polaris and on the gate.
 *
 * The problem it solves: a DHCP reservation is a MAC→IP binding, so reserving an
 * IP for a device that isn't racked yet needs a MAC before there is a device to
 * supply one. The IP panel's "Generate" button synthesizes one. That entry then
 * sits on the FortiGate matching nothing: when the device finally arrives it
 * DHCPs with its real MAC, misses the reservation, and takes a pool address
 * instead. The reservation looks correct on both sides and silently does
 * nothing, forever, until a human notices and retypes the MAC.
 *
 * SAFETY — this overwrites a stored MAC and writes DHCP configuration to
 * production network devices on a schedule:
 *   • Opt-in twice. `config.pushReservations` is the transport gate and
 *     `config.adoptDiscoveredMac` is this feature; both must be on. Off by
 *     default, on both Fortinet integration types.
 *   • Only ever overwrites a PLACEHOLDER. `isPlaceholderMac` against the
 *     operator's configured prefix is the single condition that makes an
 *     unattended overwrite defensible — an operator-typed real MAC is never
 *     touched, whatever discovery saw. The prefix is required to be
 *     locally-administered (see utils/mac.ts) precisely so no real device's
 *     factory MAC can fall inside that space.
 *   • Device-scoped evidence only. ARP and device-inventory rows are keyed by
 *     the FortiGate that reported them, so overlapping RFC1918 subnets behind
 *     different gates can't cross-match — the same rule Phase 7.6 already
 *     follows for ARP presence.
 *   • Device first, Polaris second. The gate write goes through
 *     `updatePushedReservation` (which verifies by read-back) BEFORE the Polaris
 *     row changes, so the two views can't diverge. This is why the pass lives
 *     here rather than as another bare `prisma.reservation.update` inside the
 *     discovery engine.
 *   • Bounded + paced, per RUN. See `AdoptionBudget` below — in FMG mode the
 *     sync runs once per managed FortiGate, so a per-call ceiling would multiply
 *     by gate count.
 *   • No retry into the ground. A permanent refusal is recorded as
 *     `failed_permanent` on the row, which also removes it from the candidate
 *     set; transient failures are simply retried next cycle.
 *
 * Deliberately NOT evidence: DHCP lease entries (a device whose MAC doesn't
 * match the reservation never gets the reserved address, so it can't appear
 * there) and `Asset.ipAddress` (not device-scoped, and an asset's IP can be
 * learned from an unrelated source).
 */

import { prisma } from "../db.js";
import { logEvent } from "./eventLogService.js";
import { logger } from "../utils/logger.js";
import { mapSettledWithConcurrency } from "../utils/concurrency.js";
import { isPlaceholderMac, normalizeMacOrNull, macHexKeyOrNull } from "../utils/mac.js";
import { getPlaceholderPrefix } from "./reservationMacService.js";
import {
  updatePushedReservation,
  classifyPushError,
  integrationPushEnabled,
  normalizeMac,
} from "./reservationPushService.js";

/**
 * Device writes per DISCOVERY RUN. In FMG mode `syncDhcpSubnets` is invoked once
 * per managed FortiGate, so the budget is created by the caller once per run and
 * threaded through every gate — a per-call ceiling would become
 * ceiling × gate-count writes in one cycle, which is exactly the burst against
 * the FMG proxy lane that this kind of ceiling exists to prevent.
 */
export const ADOPTION_RUN_CEILING = 50;

/** Concurrent pushes. Low on purpose: these share the FMG worker lanes. */
const PUSH_CONCURRENCY = 2;

/** Rejection reason for a row the run was aborted before reaching. */
const ABORTED = new Error("aborted");

/** Mutable per-run write budget. Create with `createAdoptionBudget()`. */
export interface AdoptionBudget {
  remaining: number;
}

export function createAdoptionBudget(ceiling: number = ADOPTION_RUN_CEILING): AdoptionBudget {
  return { remaining: Math.max(0, ceiling) };
}

/** What discovery observed at a reserved IP, and which pass saw it. */
export interface MacEvidence {
  mac: string;
  source: "arp" | "device-inventory";
  /**
   * The reporting FortiGate's name in its ORIGINAL case. The index key
   * lower-cases it for matching, but `Subnet.fortigateDevice` is stored
   * case-preserved, so the DB scope filter has to come from here.
   */
  device: string;
}

export interface AdoptionResult {
  attempted: number;
  adopted: number;
  failed: number;
  /** Eligible but over this run's budget. */
  deferred: number;
}

/** The per-row facts the eligibility decision needs. Pure — see below. */
export interface AdoptionCandidateRow {
  status: string;
  ipAddress?: string | null;
  macAddress?: string | null;
  pushStatus?: string | null;
  subnetDiscoveredBy?: string | null;
  subnetFortigateDevice?: string | null;
}

/**
 * Build the (device, ip) → MAC index this pass matches against.
 *
 * Precedence: an ARP hit beats a device-inventory hit for the same key, because
 * ARP is a live L2 binding the gate resolved within the last few minutes,
 * whereas the inventory table is a cache whose `is_online` is known to lag. Among
 * inventory rows for one key, an online row beats an offline one; among ARP rows
 * the first wins (the table holds one binding per IP per device).
 *
 * Keys are `<device lowercased>|<ip>` — the same shape Phase 7.6 uses, so the
 * two passes can't disagree about what "the same address on the same gate" means.
 */
export function buildMacEvidenceIndex(
  arpRows: ReadonlyArray<{ fortigateDevice?: string | null; ip?: string | null; mac?: string | null }>,
  inventoryRows: ReadonlyArray<{
    device?: string | null;
    ipAddress?: string | null;
    macAddress?: string | null;
    isOnline?: boolean;
  }>,
): Map<string, MacEvidence> {
  const index = new Map<string, MacEvidence>();
  // Inventory first so ARP overwrites it — cheaper than checking precedence per row.
  const onlineKeys = new Set<string>();
  for (const row of inventoryRows) {
    if (!row.device || !row.ipAddress) continue;
    const mac = normalizeMacOrNull(row.macAddress);
    if (!mac) continue;
    const key = `${row.device.toLowerCase()}|${row.ipAddress}`;
    // An offline row must not displace an online one for the same address.
    if (onlineKeys.has(key) && row.isOnline !== true) continue;
    if (row.isOnline === true) onlineKeys.add(key);
    index.set(key, { mac, source: "device-inventory", device: row.device });
  }
  // Two ARP rows claiming the same address with DIFFERENT MACs means a
  // duplicate IP on the wire. Neither answer is safe to burn into DHCP config,
  // so the key is dropped permanently — a later row must not resurrect it.
  const ambiguous = new Set<string>();
  for (const row of arpRows) {
    if (!row.fortigateDevice || !row.ip) continue;
    const mac = normalizeMacOrNull(row.mac);
    if (!mac) continue;
    const key = `${row.fortigateDevice.toLowerCase()}|${row.ip}`;
    if (ambiguous.has(key)) continue;
    const prior = index.get(key);
    if (prior?.source === "arp") {
      if (prior.mac !== mac) { ambiguous.add(key); index.delete(key); }
      continue;
    }
    index.set(key, { mac, source: "arp", device: row.fortigateDevice });
  }
  return index;
}

/**
 * May this reservation's MAC be replaced with `discoveredMac`?
 *
 * Pure so every condition that keeps this from overwriting something real is
 * unit-testable without a FortiGate:
 *   • the row must be live and addressable,
 *   • its stored MAC must be a PLACEHOLDER under the configured prefix — the
 *     one condition that makes an unattended overwrite defensible at all,
 *   • the discovered MAC must NOT be a placeholder (never swap one synthetic
 *     value for another — that would mean some other Polaris-managed entry is
 *     answering, not a real device),
 *   • it must actually differ, so a settled row isn't rewritten every cycle,
 *   • it must belong to this integration and name a gate to write to,
 *   • and it must not already carry a permanent push refusal, which is what
 *     stops a gate that rejects the write from being asked again every cycle.
 *
 * `sourceType` is deliberately NOT checked: a placeholder MAC can sit on a
 * `manual` row that discovery hasn't adopted into `dhcp_reservation` yet, and
 * that is in fact the common case for a device that never arrived.
 */
export function isAdoptionCandidate(
  row: AdoptionCandidateRow,
  discoveredMac: string | null | undefined,
  prefix: string,
  integrationId: string,
): boolean {
  if (row.status !== "active") return false;
  if (!row.ipAddress || !row.macAddress) return false;
  if (!isPlaceholderMac(row.macAddress, prefix)) return false;

  const discovered = macHexKeyOrNull(discoveredMac);
  if (!discovered) return false;
  if (isPlaceholderMac(discoveredMac, prefix)) return false;
  if (discovered === macHexKeyOrNull(row.macAddress)) return false;

  if (row.pushStatus === "failed_permanent") return false;
  if (row.subnetDiscoveredBy !== integrationId) return false;
  return !!row.subnetFortigateDevice;
}

/**
 * Run the adoption pass for one batch of FortiGates' discovery data.
 *
 * Called from discovery Phase 7.7 with the ARP + device-inventory rows for the
 * gate(s) just synced. Returns counts; never throws for a per-row failure.
 */
export async function runPlaceholderMacAdoption(params: {
  integrationId: string;
  integrationName: string;
  evidence: Map<string, MacEvidence>;
  budget: AdoptionBudget;
  actor?: string;
  signal?: AbortSignal;
}): Promise<AdoptionResult> {
  const out: AdoptionResult = { attempted: 0, adopted: 0, failed: 0, deferred: 0 };
  if (params.evidence.size === 0 || params.budget.remaining <= 0) return out;

  const integration = await prisma.integration.findUnique({
    where: { id: params.integrationId },
    select: { id: true, type: true, config: true },
  });
  if (!integration) return out;

  // Both gates. integrationPushEnabled is the shared transport nucleus — the
  // feature flag alone must never be enough to write to a device.
  if (!integrationPushEnabled(integration)) return out;
  const cfg = (integration.config ?? {}) as Record<string, unknown>;
  if (cfg.adoptDiscoveredMac !== true) return out;

  const prefix = await getPlaceholderPrefix();

  // Only the gates this batch carries evidence for. One indexed query bounded by
  // those gates' reservation count — the same shape and scale profile as the
  // Phase 7.6 ARP query, which is documented safe at 2000+ reservations.
  const devices = Array.from(new Set(
    Array.from(params.evidence.values()).map((e) => e.device),
  ));
  if (devices.length === 0) return out;

  const rows = await prisma.reservation.findMany({
    where: {
      status: "active",
      ipAddress: { not: null },
      macAddress: { not: null },
      // Scoped to the gates this batch actually carries evidence for. Without
      // the device filter, FMG mode (one call per gate) would re-read the whole
      // integration's reservations once per gate — O(gates × reservations).
      subnet: { discoveredBy: params.integrationId, fortigateDevice: { in: devices } },
    },
    select: {
      id: true, subnetId: true, ipAddress: true, hostname: true, notes: true, macAddress: true,
      createdBy: true, pushStatus: true, pushedScopeId: true, pushedEntryId: true,
      subnet: { select: { cidr: true, discoveredBy: true, fortigateDevice: true } },
    },
  });

  // Every MAC already spoken for on each subnet, built from the SAME rows —
  // no second query, and hex-keyed so the mixed storage case in this column
  // (operator paths write colon-lower, discovery writes colon-upper) can't make
  // a real collision look like a free MAC. Adopting onto a MAC another active
  // reservation in the same scope already holds would be refused by FortiOS
  // anyway (updatePushedReservation's same-scope collision check), and that
  // refusal is PERMANENT — it would park the row at failed_permanent and take
  // it out of the candidate set for good. Cheaper to never ask.
  const occupiedBySubnet = new Map<string, Set<string>>();
  for (const r of rows) {
    const hex = macHexKeyOrNull(r.macAddress);
    if (!hex) continue;
    let set = occupiedBySubnet.get(r.subnetId);
    if (!set) { set = new Set(); occupiedBySubnet.set(r.subnetId, set); }
    set.add(hex);
  }

  type Candidate = (typeof rows)[number] & { evidence: MacEvidence };
  const eligible: Candidate[] = [];
  let skippedCollision = 0;
  for (const r of rows) {
    const dev = r.subnet.fortigateDevice;
    if (!dev || !r.ipAddress) continue;
    const evidence = params.evidence.get(`${dev.toLowerCase()}|${r.ipAddress}`);
    if (!evidence) continue;
    const evidenceHex = macHexKeyOrNull(evidence.mac);
    // Already adopted: the row itself holds the observed MAC. Nothing to do,
    // and it is not a collision with anything (it was logged as one every cycle).
    if (evidenceHex && evidenceHex === macHexKeyOrNull(r.macAddress)) continue;
    if (evidenceHex && occupiedBySubnet.get(r.subnetId)?.has(evidenceHex)) {
      skippedCollision++;
      continue;
    }
    const ok = isAdoptionCandidate(
      {
        status: "active",
        ipAddress: r.ipAddress,
        macAddress: r.macAddress,
        pushStatus: r.pushStatus,
        subnetDiscoveredBy: r.subnet.discoveredBy,
        subnetFortigateDevice: dev,
      },
      evidence.mac,
      prefix,
      params.integrationId,
    );
    if (ok) {
      eligible.push({ ...r, evidence });
      // Claim the MAC for this subnet now, so a second placeholder whose
      // evidence is the same card (one NIC at two addresses) is skipped as a
      // collision this run — until 2026-11-14 both were pushed and FortiOS's
      // permanent duplicate refusal parked the second at failed_permanent.
      if (evidenceHex) {
        let set = occupiedBySubnet.get(r.subnetId);
        if (!set) { set = new Set(); occupiedBySubnet.set(r.subnetId, set); }
        set.add(evidenceHex);
      }
    }
  }
  if (skippedCollision > 0) {
    logger.info(
      { integrationId: params.integrationId, skippedCollision },
      "placeholderMacAdoption: skipped candidate(s) whose observed MAC is already reserved elsewhere in the same subnet",
    );
  }
  if (eligible.length === 0) return out;

  const batch = eligible.slice(0, params.budget.remaining);
  out.deferred = eligible.length - batch.length;
  out.attempted = batch.length;
  params.budget.remaining -= batch.length;

  const results = await mapSettledWithConcurrency(batch, PUSH_CONCURRENCY, async (row) => {
    if (params.signal?.aborted) throw ABORTED;
    // Stored colon-LOWER, matching what updateReservation persists — this is
    // the same semantic operation, just performed by discovery instead of an
    // operator, and the column should not gain a second spelling because of it.
    const newMac = normalizeMac(row.evidence.mac);

    // A queued row has never reached the device, so there is nothing to
    // correct there — rewrite the payload and let retryQueuedReservationPushes
    // push the real MAC on its next attempt. Mirrors updateReservation().
    if (row.pushStatus === "pending") {
      await prisma.reservation.update({ where: { id: row.id }, data: { macAddress: newMac } });
      return row;
    }

    // Device first, then Polaris — a failed gate write must leave the row
    // untouched rather than pointing at a MAC the device doesn't have.
    const result = await updatePushedReservation({
      reservationId: row.id,
      subnetCidr: row.subnet.cidr,
      ip: row.ipAddress!,
      newMac,
      hostname: row.hostname,
      notes: row.notes,
      createdBy: row.createdBy,
      scopeId: row.pushedScopeId,
      entryId: row.pushedEntryId,
      integration,
      deviceName: row.subnet.fortigateDevice!,
    });
    await prisma.reservation.update({
      where: { id: row.id },
      data: {
        macAddress: newMac,
        pushedToId: integration.id,
        pushedScopeId: result.scopeId,
        pushedEntryId: result.entryId,
        pushStatus: "synced",
        pushedAt: new Date(),
        pushError: null,
      },
    });
    return row;
  });

  let aborted = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const row = batch[i]!;
    // A row the run stopped before reaching was never tried: not a failure,
    // no Event, and its budget slot is handed back below.
    if (r.status === "rejected" && r.reason === ABORTED) { aborted++; continue; }
    if (r.status === "fulfilled") {
      out.adopted++;
      void logEvent({
        action: "reservation.mac.adopted",
        resourceType: "reservation",
        resourceId: row.id,
        resourceName: row.hostname || row.ipAddress || undefined,
        actor: params.actor,
        level: "info",
        message:
          `Placeholder MAC on ${row.ipAddress} replaced with the discovered device's MAC `
          + `${row.macAddress} → ${row.evidence.mac} (seen via ${row.evidence.source} on `
          + `"${row.subnet.fortigateDevice}")`,
        details: {
          integrationId: params.integrationId,
          deviceName: row.subnet.fortigateDevice,
          ip: row.ipAddress,
          previousMac: row.macAddress,
          newMac: row.evidence.mac,
          evidence: row.evidence.source,
          queuedOnly: row.pushStatus === "pending",
        },
      });
      continue;
    }

    out.failed++;
    const err = (r as PromiseRejectedResult).reason;
    const kind = classifyPushError(err);
    // Permanent refusals are recorded ON the row: it drops the reservation out
    // of the candidate set and surfaces in the IP panel as "Push failed" with
    // the device's own message. Transient failures are left alone — the next
    // discovery cycle retries.
    if (kind === "permanent") {
      await prisma.reservation.update({
        where: { id: row.id },
        data: {
          pushStatus: "failed_permanent",
          pushError: String(err?.message || err).slice(0, 500),
          pushLastAttemptAt: new Date(),
        },
      }).catch(() => { /* the Event below still records the failure */ });
    }
    void logEvent({
      action: "reservation.mac.adopt_failed",
      resourceType: "reservation",
      resourceId: row.id,
      resourceName: row.hostname || row.ipAddress || undefined,
      actor: params.actor,
      level: "warning",
      message:
        `Failed to replace the placeholder MAC on ${row.ipAddress} with ${row.evidence.mac} `
        + `on FortiGate "${row.subnet.fortigateDevice}": ${err?.message || "Unknown error"}`,
      details: {
        integrationId: params.integrationId,
        deviceName: row.subnet.fortigateDevice,
        ip: row.ipAddress,
        previousMac: row.macAddress,
        attemptedMac: row.evidence.mac,
        evidence: row.evidence.source,
        kind,
        error: String(err?.message || err),
      },
    });
    logger.warn(
      { reservationId: row.id, ip: row.ipAddress, kind, err },
      "placeholderMacAdoption: push failed",
    );
  }

  if (aborted > 0) {
    out.attempted -= aborted;
    params.budget.remaining += aborted;
  }

  if (out.deferred > 0) {
    // Never let a truncated cycle read as "everything was covered".
    logger.info(
      { integrationId: params.integrationId, deferred: out.deferred },
      "placeholderMacAdoption: run budget exhausted; remaining candidates deferred to the next cycle",
    );
  }

  return out;
}
