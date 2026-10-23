/**
 * src/services/dnsResolvedReservationService.ts
 *
 * Auto-creates "DNS Resolved" reservations from Asset.ipAddress so IPs picked
 * up outside the DHCP/VIP/interface_ip discovery pipeline (AD forward-lookup,
 * Entra/Intune, manually-typed) still surface in the Networks IP panel.
 *
 * Behavior rules (see plan: dns-resolved reservations):
 *   - Only primary `Asset.ipAddress`; secondary AssetAssociatedIp is v1 OOS.
 *   - Eligible asset statuses: active / maintenance / storage / quarantined.
 *     decommissioned / disabled get their existing dns_resolved row released.
 *   - IPv4 only (the IP-panel UI and cidr helpers are IPv4-shaped).
 *   - Defers silently to any non-released authoritative reservation already
 *     at the same (subnetId, ipAddress) — manual / dhcp_reservation /
 *     dhcp_lease / interface_ip / vip / fortiswitch / fortinap / fortimanager
 *     / fortigate all win without raising a Conflict.
 *   - Never pushes to a FortiGate. createdBy = "system:dns-resolved".
 *   - When the asset's IP changes, the old row releases and a new one is
 *     created at the new IP. Same on asset delete (handled by the Prisma
 *     extension's pre-delete hook).
 */

import { chunkArray } from "../utils/chunk.js";
import { prisma } from "../db.js";
import { isValidIpAddress, detectIpVersion } from "../utils/cidr.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { buildIpContexts } from "./subnetService.js";

const SYSTEM_ACTOR = "system:dns-resolved";

const ELIGIBLE_STATUSES = new Set(["active", "maintenance", "storage", "quarantined"]);

interface AssetIdentity {
  id: string;
  ipAddress: string | null;
  hostname: string | null;
  dnsName: string | null;
  macAddress: string | null;
  status: string;
}

function assetEligible(a: AssetIdentity): boolean {
  if (!a.ipAddress) return false;
  if (!isValidIpAddress(a.ipAddress)) return false;
  if (detectIpVersion(a.ipAddress) !== "v4") return false;
  if (!ELIGIBLE_STATUSES.has(a.status)) return false;
  return true;
}

function resolvedHostname(a: AssetIdentity): string | null {
  const h = (a.hostname && a.hostname.trim()) || (a.dnsName && a.dnsName.trim()) || null;
  return h || null;
}

interface ContainingSubnet {
  subnet_id: string;
  subnet_cidr: string;
}

// Single most-specific containing subnet for one IP — delegates to the shared
// implementation in subnetService.buildIpContexts (`inet`/`cidr` containment
// with `masklen DESC` so nested subnets pick the tighter one). The reservation
// summary the shared query also returns is unused here — this reconciler
// classifies reservations itself (authoritative vs dns_resolved).
async function findContainingSubnet(ip: string): Promise<ContainingSubnet | null> {
  const ctx = (await buildIpContexts([ip])).get(ip);
  return ctx ? { subnet_id: ctx.subnetId, subnet_cidr: ctx.subnetCidr } : null;
}

interface SystemReservationRow {
  id: string;
  subnetId: string;
  ipAddress: string | null;
  hostname: string | null;
  macAddress: string | null;
}

// Stable identity match: an existing dns_resolved row "belongs to" this asset
// if it shares the asset's current MAC or hostname AND was written by the
// system actor. We can't FK to assetId (Reservation has no assetId column —
// it's keyed on subnetId by design), so this is the cheapest proxy.
async function findOwnedSystemRows(a: AssetIdentity): Promise<SystemReservationRow[]> {
  const mac = a.macAddress ?? null;
  const host = resolvedHostname(a);
  if (!mac && !host) return [];
  const ors: any[] = [];
  if (mac) ors.push({ macAddress: mac });
  if (host) ors.push({ hostname: host });
  return prisma.reservation.findMany({
    where: {
      createdBy: SYSTEM_ACTOR,
      sourceType: "dns_resolved" as any,
      status: "active",
      OR: ors,
    },
    select: { id: true, subnetId: true, ipAddress: true, hostname: true, macAddress: true },
  });
}

interface ActiveAuthoritativeRow {
  id: string;
  sourceType: string;
}

async function findActiveAuthoritativeAt(subnetId: string, ipAddress: string): Promise<ActiveAuthoritativeRow | null> {
  const row = await prisma.reservation.findFirst({
    where: {
      subnetId,
      ipAddress,
      status: "active",
      NOT: { sourceType: "dns_resolved" as any },
    },
    select: { id: true, sourceType: true },
  });
  return row;
}

interface ExistingSystemAtTarget {
  id: string;
  hostname: string | null;
  macAddress: string | null;
}

async function findSystemRowAt(subnetId: string, ipAddress: string): Promise<ExistingSystemAtTarget | null> {
  return prisma.reservation.findFirst({
    where: {
      subnetId,
      ipAddress,
      status: "active",
      sourceType: "dns_resolved" as any,
      createdBy: SYSTEM_ACTOR,
    },
    select: { id: true, hostname: true, macAddress: true },
  });
}

// True when another eligible asset at the same IP is exactly what the row
// already records (its hostname and MAC) — the row is that asset's, not stale.
async function rowHeldByAnotherAsset(row: ExistingSystemAtTarget, assetId: string, ipAddress: string): Promise<boolean> {
  const others = await prisma.asset.findMany({
    where: { id: { not: assetId }, ipAddress, status: { in: [...ELIGIBLE_STATUSES] as any } },
    select: { id: true, ipAddress: true, hostname: true, dnsName: true, macAddress: true, status: true },
  });
  return others.some(
    (o) => resolvedHostname(o) === (row.hostname ?? null) && (o.macAddress ?? null) === (row.macAddress ?? null),
  );
}

async function releaseRows(ids: string[], reason: string, assetId: string): Promise<number> {
  if (ids.length === 0) return 0;
  // Hard-delete instead of flipping to status="released". dns_resolved rows
  // are system-created fallback markers with no audit value once they're
  // gone, and the `@@unique([subnetId, ipAddress, status])` constraint
  // applies to every status (released included), so accumulating
  // released-state rows permanently occupies the (sub, ip, "released")
  // slot. That blocks both this updateMany and the discovery-side P2002
  // retry from completing later transitions at the same target.
  const res = await prisma.reservation.deleteMany({
    where: { id: { in: ids }, status: "active" },
  });
  if (res.count > 0) {
    await logEvent({
      action: "reservation.dns_resolved.released",
      resourceType: "asset",
      resourceId: assetId,
      actor: SYSTEM_ACTOR,
      level: "info",
      message: `Released ${res.count} dns_resolved reservation(s): ${reason}`,
      details: { reason, count: res.count, ids },
    });
  }
  return res.count;
}

export interface ReconcileResult {
  created: number;
  updated: number;
  released: number;
  skipped: boolean;
}

/**
 * Real-time + per-asset reconcile path. Called from:
 *   - Prisma extension hook on asset.create/update/upsert (post-write)
 *   - Periodic reconcileDnsResolvedReservations job (per-row sweep)
 *
 * Best-effort throughout — every DB call is wrapped so a transient failure
 * can't propagate into the asset write path that triggered the call.
 */
export async function reconcileDnsResolvedForAsset(assetId: string): Promise<ReconcileResult> {
  const out: ReconcileResult = { created: 0, updated: 0, released: 0, skipped: false };
  let asset: AssetIdentity | null;
  try {
    asset = await prisma.asset.findUnique({
      where: { id: assetId },
      select: { id: true, ipAddress: true, hostname: true, dnsName: true, macAddress: true, status: true },
    });
  } catch (err) {
    logger.warn({ err, assetId }, "dns_resolved.reconcile: asset load failed");
    out.skipped = true;
    return out;
  }
  if (!asset) {
    out.skipped = true;
    return out;
  }

  // Step 1: pre-release any owned system rows that don't match the asset's
  // current eligibility/target. Always-runs first so a freshly-decommissioned
  // asset or an asset whose IP just changed loses its stale row even when no
  // new row is going to be created.
  const owned = await findOwnedSystemRows(asset).catch(() => [] as SystemReservationRow[]);

  if (!assetEligible(asset)) {
    const ids = owned.map((r) => r.id);
    out.released = await releaseRows(ids, "asset ineligible (decommissioned/disabled/IPv6/no-ip)", assetId).catch(() => 0);
    out.skipped = true;
    return out;
  }

  const ip = asset.ipAddress as string;

  // Step 2: find target subnet for the asset's current IP.
  const subnet = await findContainingSubnet(ip).catch(() => null);
  if (!subnet) {
    // IP is real but not in any known subnet — release stale system rows we
    // owned at previous IPs, but don't create anything new.
    const ids = owned.map((r) => r.id);
    out.released = await releaseRows(ids, "no containing subnet for current IP", assetId).catch(() => 0);
    out.skipped = true;
    return out;
  }

  // Step 3: defer to any authoritative (non-dns_resolved) active reservation
  // already at this (subnet, ip). dns_resolved is a fallback, never competes.
  const authoritative = await findActiveAuthoritativeAt(subnet.subnet_id, ip).catch(() => null);
  if (authoritative) {
    // Release any owned system rows ANYWHERE for this asset — the authoritative
    // row covers this IP, and stale rows at other IPs should still clean up.
    const ids = owned.map((r) => r.id);
    out.released = await releaseRows(ids, `authoritative ${authoritative.sourceType} reservation exists at target`, assetId).catch(() => 0);
    out.skipped = true;
    return out;
  }

  // Step 4: upsert the system row at the target.
  const desiredHostname = resolvedHostname(asset);
  const desiredMac = asset.macAddress ?? null;
  const existingAtTarget = await findSystemRowAt(subnet.subnet_id, ip).catch(() => null);

  try {
    if (existingAtTarget) {
      const needsUpdate =
        (existingAtTarget.hostname ?? null) !== desiredHostname ||
        (existingAtTarget.macAddress ?? null) !== desiredMac;
      if (needsUpdate && (await rowHeldByAnotherAsset(existingAtTarget, assetId, ip).catch(() => false))) {
        // Two eligible assets share this IP (a duplicate, or a real address
        // conflict). The row already describes the other one — leave it, or
        // the two reconciles rewrite it on every pass and log an event each
        // time. It frees up when that asset leaves the IP.
      } else if (needsUpdate) {
        await prisma.reservation.update({
          where: { id: existingAtTarget.id },
          data: { hostname: desiredHostname, macAddress: desiredMac },
        });
        out.updated = 1;
        await logEvent({
          action: "reservation.dns_resolved.updated",
          resourceType: "reservation",
          resourceId: existingAtTarget.id,
          actor: SYSTEM_ACTOR,
          level: "info",
          message: `Updated dns_resolved reservation at ${ip}`,
          details: { assetId, subnetId: subnet.subnet_id, ipAddress: ip, hostname: desiredHostname, macAddress: desiredMac },
        });
      }
    } else {
      const created = await prisma.reservation.create({
        data: {
          subnetId: subnet.subnet_id,
          ipAddress: ip,
          hostname: desiredHostname,
          macAddress: desiredMac,
          status: "active",
          sourceType: "dns_resolved" as any,
          createdBy: SYSTEM_ACTOR,
          notes: "Auto-discovered from asset inventory; no DHCP record exists yet.",
        },
      });
      out.created = 1;
      await logEvent({
        action: "reservation.dns_resolved.created",
        resourceType: "reservation",
        resourceId: created.id,
        actor: SYSTEM_ACTOR,
        level: "info",
        message: `Created dns_resolved reservation at ${ip}`,
        details: { assetId, subnetId: subnet.subnet_id, ipAddress: ip, hostname: desiredHostname, macAddress: desiredMac },
      });
    }
  } catch (err) {
    // Two realistic failures: (a) unique constraint race with another writer
    // (extremely unlikely on the dns_resolved sourceType but the unique key is
    // (subnetId, ipAddress, status)); (b) enum value not yet migrated. Log and
    // move on — the periodic sweep will retry on its next tick.
    logger.warn({ err, assetId, ip, subnetId: subnet.subnet_id }, "dns_resolved.reconcile: upsert failed");
  }

  // Step 5: release stale rows owned by this asset that are NOT the target
  // we just upserted/found at (subnet.subnet_id, ip). Covers IP-moved-within-
  // same-subnet, MAC change, hostname change leaving an orphan row behind.
  const staleIds = owned
    .filter((r) => !(r.subnetId === subnet.subnet_id && r.ipAddress === ip))
    .map((r) => r.id);
  out.released += await releaseRows(staleIds, "stale row replaced by current target", assetId).catch(() => 0);

  return out;
}

/**
 * Periodic sweep. Loops every monitored-or-actively-managed asset with an IP
 * and runs the per-asset reconcile in batches of 25 to stay polite to the
 * connection pool. Returns counts for the job's log line.
 */
export async function reconcileDnsResolvedForAllAssets(): Promise<{
  created: number;
  updated: number;
  released: number;
  scanned: number;
}> {
  const out = { created: 0, updated: 0, released: 0, scanned: 0 };

  // We deliberately ALSO scan ineligible assets so a now-decommissioned asset
  // that still has a stale dns_resolved row gets cleaned up. The eligibility
  // gate inside reconcileDnsResolvedForAsset releases-without-creating.
  const assets = await prisma.asset.findMany({
    where: { ipAddress: { not: null } },
    select: { id: true },
  });

  const BATCH = 25;
  for (const batch of chunkArray(assets, BATCH)) {
    const results = await Promise.all(
      batch.map((a) => reconcileDnsResolvedForAsset(a.id).catch(() => ({ created: 0, updated: 0, released: 0, skipped: true } as ReconcileResult)))
    );
    for (const r of results) {
      out.created += r.created;
      out.updated += r.updated;
      out.released += r.released;
      out.scanned += 1;
    }
  }
  return out;
}

/**
 * Asset-delete hook. The Prisma extension's pre-delete branch calls this
 * BEFORE the row is removed so we still have hostname/MAC to find owned rows.
 */
export async function releaseDnsResolvedForAsset(assetId: string): Promise<void> {
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      select: { id: true, ipAddress: true, hostname: true, dnsName: true, macAddress: true, status: true },
    });
    if (!asset) return;
    const owned = await findOwnedSystemRows(asset);
    await releaseRows(owned.map((r) => r.id), "asset deleted", assetId);
  } catch (err) {
    logger.warn({ err, assetId }, "dns_resolved.releaseOnDelete failed");
  }
}

/**
 * Discovery hand-off. Called by integrations.ts immediately before creating
 * an authoritative reservation (dhcp_reservation / dhcp_lease / interface_ip /
 * vip / fortiswitch / fortinap / etc.) at a target (subnetId, ipAddress) so
 * the existing dns_resolved row releases cleanly and the unique-on-active
 * constraint is satisfied.
 */
export async function releaseDnsResolvedAt(subnetId: string, ipAddress: string): Promise<void> {
  try {
    // Hard-delete (see releaseRows above for the rationale). The
    // status-slot-collision otherwise causes this updateMany to fail
    // silently and leaves the dns_resolved row holding the (sub, ip,
    // "active") slot, which is exactly what blocks Phase 5's create.
    const res = await prisma.reservation.deleteMany({
      where: {
        subnetId,
        ipAddress,
        status: "active",
        sourceType: "dns_resolved" as any,
      },
    });
    if (res.count > 0) {
      await logEvent({
        action: "reservation.dns_resolved.released",
        resourceType: "reservation",
        resourceName: ipAddress,
        actor: SYSTEM_ACTOR,
        level: "info",
        message: `Released dns_resolved reservation at ${ipAddress}: authoritative discovery row takes over`,
        details: { reason: "discovery_handoff", subnetId, ipAddress, count: res.count },
      });
    }
  } catch (err) {
    logger.warn({ err, subnetId, ipAddress }, "dns_resolved.releaseAt failed");
  }
}
