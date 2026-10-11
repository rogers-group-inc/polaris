/**
 * src/services/discovery/genericApiNetworkSync.ts
 *
 * A Generic API integration as a NETWORK source (business rule 100(j)):
 * subnets, DHCP leases, DHCP reservations and addresses allocated in another
 * IPAM, read by its network queries (genericApiService.discoverGenericApiNetwork)
 * and written into IPAM under the same invariants every other discovery
 * writer obeys — plus the ones that follow from a feed ranking below every
 * first-party source (rule 100(c)).
 *
 * Subnets
 *   - Created only inside an existing block (rule 2 — discovery never makes a
 *     block), through createSubnetRowChecked: the per-block lock, the overlap
 *     refusal (rules 1 / 20a) and the exclusion list (rule 42). An excluded,
 *     overlapping, retired (deprecated) or block-less network is SKIPPED and
 *     named in the run log, never merged, resized or reactivated.
 *   - A live subnet with the same CIDR: this feed's own is refreshed (VLAN,
 *     lastDiscoveredAt); an UNOWNED (manual) one is claimed, keeping the
 *     operator's name and purpose and filling only blanks; one ANOTHER
 *     integration owns is left alone. Phase 1 of syncDhcpSubnets re-points
 *     ownership on every run — the feed must not, or it would silently turn
 *     off that integration's DHCP Push and Refresh for the network.
 *   - `fortigateDevice` / `fortigateSerial` are never written: rules 41 / 45 /
 *     55, the IPAM address re-check and the ARP matcher all read them as a
 *     FortiGate's name and chassis.
 *   - Deprecation is opt-in (`deprecateMissingSubnets`), on a complete read of
 *     every subnet query, past absenceExceedsGuard (rules 53 / 70 / 100(e)).
 *
 * Addresses (leases → dhcp_lease, reservations → dhcp_reservation,
 * assignments → external)
 *   - Written only into a subnet THIS FEED OWNS. A feed with no subnet query
 *     claims the unowned subnet an address falls in (a lease-only feed could
 *     otherwise write nothing); a feed that lists subnets writes only into
 *     those. A subnet another integration owns is never written into — its
 *     own sweep would release the feed's rows, and its rows are its own.
 *   - An existing MANUAL row is never overwritten (rule 7): the difference is
 *     a reservation Conflict, raised only against manual rows (accepting one
 *     against any other kind folds it into a VIP — conflictResolutionService).
 *     A VIP, an interface address, a managed-switch / AP row or a push in
 *     flight is authoritative and left alone. A dns_resolved fallback row is
 *     released first (rule 11).
 *   - Leases carry `expiresAt` (the feed's, else now + max(24 h, 2 × the
 *     discovery interval)) and age out through expireStaleReservations —
 *     never swept, so a missed run never wipes them. Reservations and
 *     assignments the feed stops listing are released on a complete read of
 *     their kind, past absenceExceedsGuard, when `releaseMissingAddresses`
 *     (on by default) — the Phase 5b posture.
 *   - Nothing is ever pushed to a device: a Generic API config cannot carry
 *     `pushReservations`, and integrationPushEnabled refuses the type.
 *   - A feed row is not presence: `lastSeenLeased` is never written (rule
 *     100(a)), so a feed reservation nothing else sees feeds the stale alert.
 */

import { prisma } from "../../db.js";
import { logEvent } from "../eventLogService.js";
import { createSubnetRowChecked } from "../subnetService.js";
import { releaseDnsResolvedAt } from "../dnsResolvedReservationService.js";
import { cidrContains, cidrOverlaps, detectIpVersion, ipInCidr, mostSpecificContaining } from "../../utils/cidr.js";
import { findCoveringExclusion } from "../../utils/subnetExclusion.js";
import { absenceExceedsGuard } from "../../utils/directoryAbsence.js";
import { GENERIC_API_LABEL, GENERIC_API_TYPE } from "../../utils/genericApiSource.js";
import {
  GENERIC_API_ADDRESS_SOURCE_TYPE,
  GENERIC_API_NETWORK_LIMITS,
  type GenericApiConfig,
  type GenericApiMappedAddress,
  type GenericApiMappedSubnet,
  type GenericApiNetworkKind,
  type GenericApiNetworkQueryResult,
} from "../genericApiService.js";
import { computeConflictFields, upsertConflict } from "./discoveryEngine.js";

/** The sourceTypes this sync writes — and the only ones it ever updates or releases. */
export const GENERIC_API_FEED_SOURCE_TYPES = ["dhcp_lease", "dhcp_reservation", "external"] as const;
type FeedSourceType = (typeof GENERIC_API_FEED_SOURCE_TYPES)[number];

/** When one address is listed by several kinds, the more deliberate claim wins. */
const KIND_PRECEDENCE: Record<FeedSourceType, number> = { dhcp_reservation: 3, external: 2, dhcp_lease: 1 };

export interface GenericApiNetworkSummary {
  subnetsCreated: string[];
  subnetsClaimed: string[];
  subnetsUpdated: string[];
  subnetsDeprecated: string[];
  addressesCreated: number;
  addressesUpdated: number;
  addressesReleased: number;
  conflicts: number;
  /** "what — why", for the run log. */
  skipped: string[];
}

/** The lease expiry written when the feed gives none: long enough to outlive the gap to the next run. */
export function defaultLeaseExpiry(now: Date, pollIntervalHours: number | null | undefined): Date {
  const hours = Math.max(GENERIC_API_NETWORK_LIMITS.defaultLeaseHours, 2 * (pollIntervalHours ?? 0));
  return new Date(now.getTime() + hours * 3_600_000);
}

/** Which subnet an address belongs in: the MOST specific live one that contains it. */
export function pickSubnetForIp<T extends { cidr: string; status: string }>(subnets: readonly T[], ip: string): T | null {
  let best: T | null = null;
  for (const s of subnets) {
    if (s.status === "deprecated" || !ipInCidr(ip, s.cidr)) continue;
    if (!best || cidrContains(best.cidr, s.cidr)) best = s;
  }
  return best;
}

/**
 * One address per (subnet, IP), the most deliberate kind winning — a feed
 * that lists the same address as a reservation and as a lease means the
 * reservation.
 */
export function dedupeFeedAddresses(
  items: Array<{ kind: Exclude<GenericApiNetworkKind, "subnets">; addr: GenericApiMappedAddress }>,
): Map<string, { sourceType: FeedSourceType; addr: GenericApiMappedAddress }> {
  const out = new Map<string, { sourceType: FeedSourceType; addr: GenericApiMappedAddress }>();
  for (const { kind, addr } of items) {
    const sourceType = GENERIC_API_ADDRESS_SOURCE_TYPE[kind] as FeedSourceType;
    const prev = out.get(addr.ipAddress);
    if (!prev || KIND_PRECEDENCE[sourceType] > KIND_PRECEDENCE[prev.sourceType]) out.set(addr.ipAddress, { sourceType, addr });
  }
  return out;
}

interface SubnetRow {
  id: string;
  blockId: string;
  cidr: string;
  name: string;
  purpose: string | null;
  vlan: number | null;
  status: string;
  discoveredBy: string | null;
  tags: string[];
}

export async function syncGenericApiNetwork(
  integrationId: string,
  integrationName: string,
  integrationConfig: Record<string, unknown> | null,
  results: GenericApiNetworkQueryResult[],
  opts: { actor?: string; pollIntervalHours?: number | null } = {},
): Promise<GenericApiNetworkSummary> {
  const cfg = (integrationConfig ?? {}) as unknown as GenericApiConfig;
  const actor = opts.actor;
  const now = new Date();
  const summary: GenericApiNetworkSummary = {
    subnetsCreated: [], subnetsClaimed: [], subnetsUpdated: [], subnetsDeprecated: [],
    addressesCreated: 0, addressesUpdated: 0, addressesReleased: 0, conflicts: 0, skipped: [],
  };
  if (results.length === 0) return summary;
  const syncLog = (level: "info" | "error" | "warning", message: string) => {
    logEvent({ action: "integration.sync", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
  };
  for (const r of results) {
    if (r.error) syncLog("error", `Network query "${r.query.name || r.query.kind}" failed: ${r.error}`);
  }

  // ── Preload (once — 2000-asset scale is a non-issue here, but a big
  //    inventory can carry thousands of subnets and leases) ────────────────
  const [blocks, subnetRows, exclusions] = await Promise.all([
    prisma.ipBlock.findMany({ select: { id: true, cidr: true } }),
    prisma.subnet.findMany({ select: { id: true, blockId: true, cidr: true, name: true, purpose: true, vlan: true, status: true, discoveredBy: true, tags: true } }),
    prisma.subnetExclusion.findMany({ select: { cidr: true, name: true } }),
  ]);
  const subnets: SubnetRow[] = subnetRows.map((s) => ({ ...s, status: String(s.status) }));
  const v4Blocks = blocks.filter((b) => detectIpVersion(b.cidr) === "v4");

  // ── Subnets ──────────────────────────────────────────────────────────────
  const subnetResults = results.filter((r) => r.query.kind === "subnets");
  const listedSubnets = new Map<string, GenericApiMappedSubnet>();
  for (const r of subnetResults) for (const s of r.subnets) if (!listedSubnets.has(s.cidr)) listedSubnets.set(s.cidr, s);

  for (const s of listedSubnets.values()) {
    const ex = findCoveringExclusion(s.cidr, exclusions);
    if (ex) { summary.skipped.push(`${s.cidr} — excluded (${ex.name || ex.cidr})`); continue; }
    const live = subnets.find((x) => x.cidr === s.cidr && x.status !== "deprecated");
    if (live) {
      if (live.discoveredBy && live.discoveredBy !== integrationId) {
        summary.skipped.push(`${s.cidr} — owned by another integration`);
        continue;
      }
      const data: Record<string, unknown> = { lastDiscoveredAt: now };
      const claiming = live.discoveredBy === null;
      if (claiming) {
        data.discoveredBy = integrationId;
        if (!live.tags.includes(GENERIC_API_TYPE)) data.tags = [...live.tags, GENERIC_API_TYPE];
        if (!live.purpose && s.purpose) data.purpose = s.purpose;
        if (live.vlan === null && s.vlan !== null) data.vlan = s.vlan;
      } else if (s.vlan !== null && s.vlan !== live.vlan) {
        data.vlan = s.vlan;
      }
      try {
        await prisma.subnet.update({ where: { id: live.id }, data });
        Object.assign(live, data);
        if (claiming) {
          summary.subnetsClaimed.push(s.cidr);
          logEvent({
            action: "subnet.claimed", resourceType: "subnet", resourceId: live.id, resourceName: s.cidr, actor,
            message: `Subnet ${s.cidr} claimed by ${GENERIC_API_LABEL} integration "${integrationName}" — its name and purpose kept`,
            details: { integrationId, integrationName, reason: "first-claim" },
          });
        } else {
          summary.subnetsUpdated.push(s.cidr);
        }
      } catch (err: any) {
        syncLog("error", `Failed to update subnet ${s.cidr}: ${err.message || "Unknown error"}`);
      }
      continue;
    }
    const block = mostSpecificContaining(v4Blocks, s.cidr);
    if (!block) { summary.skipped.push(`${s.cidr} — no block contains it (Polaris never creates a block)`); continue; }
    if (subnets.some((x) => x.blockId === block.id && x.cidr === s.cidr && x.status === "deprecated")) {
      summary.skipped.push(`${s.cidr} — retired (deprecated) here; discovery does not reactivate a network somebody retired`);
      continue;
    }
    const overlap = subnets.find((x) => x.blockId === block.id && cidrOverlaps(x.cidr, s.cidr));
    if (overlap) { summary.skipped.push(`${s.cidr} — overlaps ${overlap.cidr}`); continue; }
    try {
      const row = await createSubnetRowChecked({
        blockId: block.id,
        cidr: s.cidr,
        name: s.name || `${integrationName}: ${s.cidr}`,
        purpose: s.purpose || `Discovered from ${GENERIC_API_LABEL} "${integrationName}"`,
        status: "available",
        discoveredBy: integrationId,
        lastDiscoveredAt: now,
        tags: [GENERIC_API_TYPE],
        ...(s.vlan !== null ? { vlan: s.vlan } : {}),
      }, { exclusions });
      subnets.push({ id: row.id, blockId: block.id, cidr: s.cidr, name: row.name, purpose: row.purpose, vlan: row.vlan, status: "available", discoveredBy: integrationId, tags: [GENERIC_API_TYPE] });
      summary.subnetsCreated.push(s.cidr);
      logEvent({
        action: "subnet.created", resourceType: "subnet", resourceId: row.id, resourceName: s.cidr, actor,
        message: `Subnet ${s.cidr} created from ${GENERIC_API_LABEL} integration "${integrationName}"`,
        details: { integrationId, integrationName, blockId: block.id, source: "generic-api" },
      });
    } catch (err: any) {
      // 409 = overlap / duplicate / exclusion caught under the lock: a skip.
      if (err?.httpStatus === 409 || err?.status === 409) summary.skipped.push(`${s.cidr} — ${err.message}`);
      else syncLog("error", `Failed to create subnet ${s.cidr}: ${err.message || "Unknown error"}`);
    }
  }

  // Opt-in deprecation of this feed's subnets a complete read no longer lists.
  if (cfg.deprecateMissingSubnets === true && subnetResults.length > 0) {
    const complete = subnetResults.every((r) => r.complete);
    const owned = subnets.filter((x) => x.discoveredBy === integrationId && x.status !== "deprecated" && !findCoveringExclusion(x.cidr, exclusions));
    const gone = owned.filter((x) => !listedSubnets.has(x.cidr));
    if (!complete) {
      if (gone.length) syncLog("warning", `Subnet deprecation skipped — a subnet query was not read to the end. ${gone.length} subnet(s) left untouched.`);
    } else if (listedSubnets.size === 0 && owned.length > 0) {
      syncLog("warning", `Subnet deprecation skipped — the subnet queries returned nothing. ${owned.length} subnet(s) left untouched.`);
    } else if (gone.length > 0 && absenceExceedsGuard(gone.length, owned.length)) {
      syncLog("warning", `Subnet deprecation refused — ${gone.length} of ${owned.length} subnet(s) vanished in one read, more than the guard allows.`);
    } else {
      for (const x of gone) {
        try {
          await prisma.subnet.update({ where: { id: x.id }, data: { status: "deprecated" } });
          x.status = "deprecated";
          summary.subnetsDeprecated.push(x.cidr);
          logEvent({
            action: "subnet.deprecated", resourceType: "subnet", resourceId: x.id, resourceName: x.cidr, actor,
            message: `Subnet ${x.cidr} deprecated — no longer listed by ${GENERIC_API_LABEL} integration "${integrationName}"`,
            details: { integrationId, integrationName, reason: "missing-from-generic-api-feed" },
          });
        } catch (err: any) {
          syncLog("error", `Failed to deprecate subnet ${x.cidr}: ${err.message || "Unknown error"}`);
        }
      }
    }
  }

  // ── Addresses ────────────────────────────────────────────────────────────
  const addressResults = results.filter((r) => r.query.kind !== "subnets");
  if (addressResults.length > 0) {
    const mayClaimForAddresses = subnetResults.length === 0;
    const deduped = dedupeFeedAddresses(addressResults.flatMap((r) =>
      r.addresses.map((addr) => ({ kind: r.query.kind as Exclude<GenericApiNetworkKind, "subnets">, addr }))));

    // Place each address in a subnet this feed owns (claiming an unowned one
    // when the feed lists no subnets of its own).
    type Placed = { subnet: SubnetRow; sourceType: FeedSourceType; addr: GenericApiMappedAddress };
    const placed: Placed[] = [];
    const skippedNoSubnet: string[] = [];
    let skippedForeign = 0;
    let skippedUnowned = 0;
    for (const { sourceType, addr } of deduped.values()) {
      const subnet = pickSubnetForIp(subnets, addr.ipAddress);
      if (!subnet) { skippedNoSubnet.push(addr.ipAddress); continue; }
      if (subnet.discoveredBy && subnet.discoveredBy !== integrationId) { skippedForeign++; continue; }
      if (!subnet.discoveredBy) {
        if (!mayClaimForAddresses) { skippedUnowned++; continue; }
        try {
          const tags = subnet.tags.includes(GENERIC_API_TYPE) ? subnet.tags : [...subnet.tags, GENERIC_API_TYPE];
          await prisma.subnet.update({ where: { id: subnet.id }, data: { discoveredBy: integrationId, lastDiscoveredAt: now, tags } });
          subnet.discoveredBy = integrationId;
          subnet.tags = tags;
          summary.subnetsClaimed.push(subnet.cidr);
          logEvent({
            action: "subnet.claimed", resourceType: "subnet", resourceId: subnet.id, resourceName: subnet.cidr, actor,
            message: `Subnet ${subnet.cidr} claimed by ${GENERIC_API_LABEL} integration "${integrationName}" for the addresses it lists — its name and purpose kept`,
            details: { integrationId, integrationName, reason: "first-claim-addresses" },
          });
        } catch (err: any) {
          syncLog("error", `Failed to claim subnet ${subnet.cidr}: ${err.message || "Unknown error"}`);
          continue;
        }
      }
      placed.push({ subnet, sourceType, addr });
    }
    if (skippedNoSubnet.length) summary.skipped.push(`${skippedNoSubnet.length} address(es) in no known subnet (e.g. ${skippedNoSubnet.slice(0, 3).join(", ")})`);
    if (skippedForeign) summary.skipped.push(`${skippedForeign} address(es) in subnets another integration owns`);
    if (skippedUnowned) summary.skipped.push(`${skippedUnowned} address(es) in subnets this feed does not list`);

    const ownedSubnetIds = subnets.filter((x) => x.discoveredBy === integrationId).map((x) => x.id);
    const active = ownedSubnetIds.length === 0 ? [] : await prisma.reservation.findMany({
      where: { subnetId: { in: ownedSubnetIds }, status: "active", ipAddress: { not: null } },
      select: {
        id: true, subnetId: true, ipAddress: true, sourceType: true, hostname: true, owner: true, projectRef: true,
        notes: true, macAddress: true, expiresAt: true, pushStatus: true,
      },
    });
    const activeByKey = new Map(active.map((r) => [`${r.subnetId}|${r.ipAddress}`, r]));
    const projectRef = `${GENERIC_API_LABEL}: ${integrationName}`;
    const leaseDefault = defaultLeaseExpiry(now, opts.pollIntervalHours);

    const creates: Array<Record<string, unknown>> = [];
    const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
    const dnsResolvedToRelease: Array<{ subnetId: string; ip: string }> = [];
    const reported = new Set<string>();
    for (const { subnet, sourceType, addr } of placed) {
      const key = `${subnet.id}|${addr.ipAddress}`;
      reported.add(key);
      const expiresAt = sourceType === "dhcp_lease" ? (addr.expiresAt ? new Date(addr.expiresAt) : leaseDefault) : null;
      if (expiresAt && expiresAt.getTime() <= now.getTime()) continue; // an expired lease is not an address in use
      const notes = addr.notes ?? defaultNotes(sourceType, integrationName, addr.macAddress);
      const existing = activeByKey.get(key);
      if (!existing || existing.sourceType === "dns_resolved") {
        if (existing) dnsResolvedToRelease.push({ subnetId: subnet.id, ip: addr.ipAddress });
        creates.push({
          subnetId: subnet.id, ipAddress: addr.ipAddress, hostname: addr.hostname, owner: addr.owner, projectRef, notes,
          macAddress: addr.macAddress, status: "active", sourceType, expiresAt,
        });
        continue;
      }
      if (existing.sourceType === "manual") {
        // Rule 7: never overwrite — a Conflict to review. A manual row with a
        // push in flight is the push pipeline's, not ours.
        if (existing.pushStatus) continue;
        // Offer only what the feed actually says: a field it does not carry
        // (or the integration label it would stamp) is never a reason to put
        // a card in front of the operator, and accepting one must never blank
        // an operator-typed owner.
        const proposed = {
          hostname: addr.hostname ?? existing.hostname,
          owner: addr.owner ?? existing.owner,
          projectRef: existing.projectRef,
          notes: addr.notes ?? existing.notes,
          sourceType,
        };
        try {
          await upsertConflict(existing.id, integrationId, proposed, existing);
          if (computeConflictFields(proposed, existing).length > 0) summary.conflicts++;
        } catch (err: any) {
          syncLog("error", `Failed to raise a conflict for ${addr.ipAddress}: ${err.message || "Unknown error"}`);
        }
        continue;
      }
      if (!(GENERIC_API_FEED_SOURCE_TYPES as readonly string[]).includes(existing.sourceType)) continue; // vip / interface_ip / infra: authoritative
      const data: Record<string, unknown> = {};
      if (existing.sourceType !== sourceType) data.sourceType = sourceType;
      if ((addr.hostname ?? null) !== (existing.hostname ?? null) && addr.hostname) data.hostname = addr.hostname;
      if (addr.macAddress && addr.macAddress !== existing.macAddress) data.macAddress = addr.macAddress;
      if (sourceType === "external") {
        if (addr.owner && addr.owner !== existing.owner) data.owner = addr.owner;
        if (addr.notes && addr.notes !== existing.notes) data.notes = addr.notes;
      }
      const prevExp = existing.expiresAt ? existing.expiresAt.getTime() : null;
      const nextExp = expiresAt ? expiresAt.getTime() : null;
      if (prevExp !== nextExp) data.expiresAt = expiresAt;
      if (Object.keys(data).length > 0) updates.push({ id: existing.id, data });
    }

    for (const d of dnsResolvedToRelease) {
      try { await releaseDnsResolvedAt(d.subnetId, d.ip); } catch { /* the createMany below skips the address if it is still held */ }
    }
    for (let i = 0; i < creates.length; i += 500) {
      try {
        const res = await prisma.reservation.createMany({ data: creates.slice(i, i + 500) as any, skipDuplicates: true });
        summary.addressesCreated += res.count;
      } catch (err: any) {
        syncLog("error", `Failed to write ${Math.min(500, creates.length - i)} address(es): ${err.message || "Unknown error"}`);
      }
    }
    for (let i = 0; i < updates.length; i += 200) {
      const chunk = updates.slice(i, i + 200);
      try {
        await prisma.$transaction(chunk.map((u) => prisma.reservation.update({ where: { id: u.id }, data: u.data })));
        summary.addressesUpdated += chunk.length;
      } catch (err: any) {
        syncLog("error", `Failed to update ${chunk.length} address(es): ${err.message || "Unknown error"}`);
      }
    }

    // Release reservations / assignments this feed wrote and a complete read
    // of their kind no longer lists. Leases are never swept — they expire.
    if (cfg.releaseMissingAddresses !== false) {
      const ownedSet = new Set(ownedSubnetIds);
      for (const [kind, sourceType] of [["reservations", "dhcp_reservation"], ["assignments", "external"]] as const) {
        const kindResults = addressResults.filter((r) => r.query.kind === kind);
        if (kindResults.length === 0) continue;
        const prior = active.filter((r) => r.sourceType === sourceType && ownedSet.has(r.subnetId));
        const gone = prior.filter((r) => !reported.has(`${r.subnetId}|${r.ipAddress}`));
        if (gone.length === 0) continue;
        const label = kind === "reservations" ? "DHCP reservation" : "external assignment";
        if (!kindResults.every((r) => r.complete)) {
          syncLog("warning", `Release of missing ${label}s skipped — a ${kind} query was not read to the end. ${gone.length} left untouched.`);
          continue;
        }
        if (absenceExceedsGuard(gone.length, prior.length)) {
          syncLog("warning", `Release of missing ${label}s refused — ${gone.length} of ${prior.length} vanished in one read, more than the guard allows.`);
          continue;
        }
        for (const row of gone) {
          try {
            await prisma.$transaction([
              // One active / released / expired row per IP (the unique key) —
              // an older released row at the address gives way, as in releaseReservation.
              prisma.reservation.deleteMany({ where: { subnetId: row.subnetId, ipAddress: row.ipAddress, status: "released" } }),
              prisma.reservation.update({ where: { id: row.id }, data: { status: "released" } }),
              prisma.conflict.updateMany({ where: { reservationId: row.id, status: "pending" }, data: { status: "rejected", resolvedBy: "auto", resolvedAt: now } }),
            ]);
            summary.addressesReleased++;
            logEvent({
              action: "reservation.genericapi.released", resourceType: "reservation", resourceId: row.id, resourceName: row.ipAddress ?? "", actor,
              message: `${label[0].toUpperCase()}${label.slice(1)} for ${row.ipAddress} no longer listed by ${GENERIC_API_LABEL} integration "${integrationName}" — released`,
              details: { integrationId, integrationName, reservationId: row.id, ipAddress: row.ipAddress, sourceType },
            });
          } catch (err: any) {
            syncLog("error", `Failed to release ${row.ipAddress}: ${err.message || "Unknown error"}`);
          }
        }
      }
    }
  }

  const notes: string[] = [];
  for (const r of results) {
    if (r.unmapped > 0) notes.push(`${r.query.name || r.query.kind}: ${r.unmapped} unmapped (${r.unmappedReasons.join("; ")})`);
    if (!r.complete && !r.error) notes.push(`${r.query.name || r.query.kind}: not read to the end`);
  }
  if (summary.skipped.length) notes.push(`skipped: ${summary.skipped.slice(0, 10).join("; ")}${summary.skipped.length > 10 ? ` (+${summary.skipped.length - 10} more)` : ""}`);
  syncLog(
    results.some((r) => r.error || !r.complete) ? "warning" : "info",
    `${GENERIC_API_LABEL} network sync: subnets ${summary.subnetsCreated.length} created, ${summary.subnetsClaimed.length} claimed, ${summary.subnetsUpdated.length} refreshed, ${summary.subnetsDeprecated.length} deprecated; addresses ${summary.addressesCreated} created, ${summary.addressesUpdated} updated, ${summary.addressesReleased} released, ${summary.conflicts} conflict(s)${notes.length ? `. ${notes.join(". ")}` : ""}`,
  );
  return summary;
}

function defaultNotes(sourceType: FeedSourceType, integrationName: string, mac: string | null): string {
  const what = sourceType === "dhcp_lease" ? "DHCP lease" : sourceType === "dhcp_reservation" ? "DHCP reservation" : "Assignment";
  return `${what} from ${GENERIC_API_LABEL} "${integrationName}"${mac ? ` — MAC: ${mac}` : ""}`;
}
