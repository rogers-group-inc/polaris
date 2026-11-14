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
  const rows = await prisma.reservation.findMany({
    where: {
      createdBy: SYSTEM_ACTOR,
      sourceType: "dns_resolved" as any,
      status: "active",
      OR: ors,
    },
    select: { id: true, subnetId: true, ipAddress: true, hostname: true, macAddress: true },
  });
  // A hostname is not an identity (rule 91): a row matched only by name whose
  // MAC is ANOTHER asset's belongs to that namesake, not to us. Without this,
  // two live assets sharing a hostname each released the other's row on every
  // sweep. A row carrying a MAC no other asset holds is still ours — the
  // orphan our own MAC change left behind, which step 5 must clean up.
  if (!mac) return rows;
  const foreignMacs = Array.from(new Set(rows.map((r) => r.macAddress).filter((m): m is string => !!m && m !== mac)));
  if (!foreignMacs.length) return rows;
  const namesakes = await prisma.asset.findMany({
    where: { id: { not: a.id }, macAddress: { in: foreignMacs } },
    select: { macAddress: true },
  });
  const claimed = new Set(namesakes.map((n) => n.macAddress));
  return rows.filter((r) => !r.macAddress || r.macAddress === mac || !claimed.has(r.macAddress));
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
  const assets: AssetIdentity[] = await prisma.asset.findMany({
    where: { ipAddress: { not: null } },
    select: { id: true, ipAddress: true, hostname: true, dnsName: true, macAddress: true, status: true },
  });
  out.scanned = assets.length;

  // Only the assets the per-asset reconcile would CHANGE something for are
  // handed to it (efficiency audit group 3): the rest are settled in memory
  // from three shared reads instead of five queries each. The test is
  // conservative — anything not provably a no-op goes through the per-asset
  // path, which re-reads live and makes every decision as before.
  let pending: AssetIdentity[] = assets;
  try {
    pending = await assetsNeedingReconcile(assets);
  } catch (err) {
    logger.warn({ err }, "dns_resolved.reconcile: shared pre-read failed; reconciling every asset");
  }

  const BATCH = 25;
  for (const batch of chunkArray(pending, BATCH)) {
    const results = await Promise.all(
      batch.map((a) => reconcileDnsResolvedForAsset(a.id).catch(() => ({ created: 0, updated: 0, released: 0, skipped: true } as ReconcileResult)))
    );
    for (const r of results) {
      out.created += r.created;
      out.updated += r.updated;
      out.released += r.released;
    }
  }
  out.released += await releaseRowsOfIneligibleOwners();
  return out;
}

/**
 * The assets whose per-asset reconcile would do something. An asset is settled
 * — skipped — only when, read against the same snapshot, reconcileDnsResolvedForAsset
 * would neither create, update nor release:
 *   - ineligible, no containing subnet, or an authoritative row at its target:
 *     it owns no system row (nothing to release);
 *   - otherwise: a system row at its target already records its hostname and
 *     MAC, and it owns no system row anywhere else.
 * Ownership is findOwnedSystemRows' test (same MAC or same resolved hostname).
 * Three reads for the whole fleet: the active system rows, every containing
 * subnet (buildIpContexts, one query), and the active rows at the assets' IPs.
 */
async function assetsNeedingReconcile(assets: AssetIdentity[]): Promise<AssetIdentity[]> {
  const ips = assets.filter(assetEligible).map((a) => a.ipAddress as string);
  const [systemRows, contexts, atIps] = await Promise.all([
    prisma.reservation.findMany({
      where: { createdBy: SYSTEM_ACTOR, sourceType: "dns_resolved" as any, status: "active" },
      select: { id: true, subnetId: true, ipAddress: true, hostname: true, macAddress: true },
    }),
    buildIpContexts(ips),
    (async () => {
      const rows: Array<{ subnetId: string; ipAddress: string | null; sourceType: string; createdBy: string | null; hostname: string | null; macAddress: string | null }> = [];
      for (const chunk of chunkArray(Array.from(new Set(ips)), OWNER_CHUNK)) {
        rows.push(...await prisma.reservation.findMany({
          where: { status: "active", ipAddress: { in: chunk } },
          select: { subnetId: true, ipAddress: true, sourceType: true, createdBy: true, hostname: true, macAddress: true },
        }));
      }
      return rows;
    })(),
  ]);

  const byMac = new Map<string, typeof systemRows>();
  const byHost = new Map<string, typeof systemRows>();
  for (const r of systemRows) {
    if (r.macAddress) (byMac.get(r.macAddress) ?? byMac.set(r.macAddress, []).get(r.macAddress)!).push(r);
    if (r.hostname) (byHost.get(r.hostname) ?? byHost.set(r.hostname, []).get(r.hostname)!).push(r);
  }
  const atTarget = new Map<string, typeof atIps>();
  for (const r of atIps) {
    const k = `${r.subnetId}|${r.ipAddress}`;
    (atTarget.get(k) ?? atTarget.set(k, []).get(k)!).push(r);
  }

  const out: AssetIdentity[] = [];
  for (const a of assets) {
    const host = resolvedHostname(a);
    const ownedIds = new Set<string>();
    const owned: typeof systemRows = [];
    for (const r of [...(a.macAddress ? byMac.get(a.macAddress) ?? [] : []), ...(host ? byHost.get(host) ?? [] : [])]) {
      if (!ownedIds.has(r.id)) { ownedIds.add(r.id); owned.push(r); }
    }
    if (!assetEligible(a)) {
      if (owned.length > 0) out.push(a);
      continue;
    }
    const ip = a.ipAddress as string;
    const ctx = contexts.get(ip);
    if (!ctx) {
      if (owned.length > 0) out.push(a);
      continue;
    }
    const here = atTarget.get(`${ctx.subnetId}|${ip}`) ?? [];
    if (here.some((r) => r.sourceType !== "dns_resolved")) {
      if (owned.length > 0) out.push(a);
      continue;
    }
    const target = here.find((r) => r.sourceType === "dns_resolved" && r.createdBy === SYSTEM_ACTOR);
    const settled =
      !!target &&
      (target.hostname ?? null) === host &&
      (target.macAddress ?? null) === (a.macAddress ?? null) &&
      owned.every((r) => r.subnetId === ctx.subnetId && r.ipAddress === ip);
    if (!settled) out.push(a);
  }
  return out;
}

/** Rows-per-statement when matching reservations back to their owners. */
const OWNER_CHUNK = 500;

/**
 * Which of these system rows should go: a row is released when at least one
 * asset owns it (same MAC, or same resolved hostname — `findOwnedSystemRows`'
 * test, read the other way) and NO owner is eligible. A row with an eligible
 * owner stays, even beside a retired namesake: a replacement device that kept
 * its predecessor's hostname must not lose its row on every sweep. A row with
 * no owner at all is not this pass's business. Pure.
 */
export function rowsOfIneligibleOwners(
  rows: ReadonlyArray<{ id: string; hostname: string | null; macAddress: string | null }>,
  assets: ReadonlyArray<AssetIdentity>,
): Array<{ rowId: string; assetId: string }> {
  const byMac = new Map<string, AssetIdentity[]>();
  const byHost = new Map<string, AssetIdentity[]>();
  const push = (m: Map<string, AssetIdentity[]>, k: string | null, a: AssetIdentity) => {
    if (!k) return;
    const list = m.get(k);
    if (list) list.push(a); else m.set(k, [a]);
  };
  for (const a of assets) {
    push(byMac, a.macAddress, a);
    push(byHost, resolvedHostname(a), a);
  }
  const out: Array<{ rowId: string; assetId: string }> = [];
  for (const r of rows) {
    const owners = [
      ...(r.macAddress ? byMac.get(r.macAddress) ?? [] : []),
      ...(r.hostname ? byHost.get(r.hostname) ?? [] : []),
    ];
    if (owners.length === 0 || owners.some(assetEligible)) continue;
    out.push({ rowId: r.id, assetId: owners[0]!.id });
  }
  return out;
}

/**
 * Business rule 11(a): the owners the per-asset sweep above cannot see.
 *
 * That sweep scans assets that HAVE an address. A decommission clears the
 * address in the same write (rule 40(k)), and the sweeps that decommission in
 * bulk go through `updateMany`, which runs no per-asset reconcile — so a
 * device retired by a sweep kept its system reservation for ever: nothing
 * scanned it again. This pass starts from the reservations instead, finds who
 * owns each, and releases the ones whose every owner is ineligible.
 *
 * Scale: one read of the active system rows (tight select), then their
 * candidate owners in chunks of OWNER_CHUNK — identity columns only. Deletes
 * are batched per chunk. Runs on the periodic job, never on a write path.
 * Never throws.
 */
async function releaseRowsOfIneligibleOwners(): Promise<number> {
  let released = 0;
  try {
    const rows = await prisma.reservation.findMany({
      where: { createdBy: SYSTEM_ACTOR, sourceType: "dns_resolved" as any, status: "active" },
      select: { id: true, hostname: true, macAddress: true },
    });
    for (const chunk of chunkArray(rows, OWNER_CHUNK)) {
      const macs = [...new Set(chunk.map((r) => r.macAddress).filter((m): m is string => !!m))];
      const hosts = [...new Set(chunk.map((r) => r.hostname).filter((h): h is string => !!h))];
      if (macs.length === 0 && hosts.length === 0) continue;
      const assets = await prisma.asset.findMany({
        where: {
          OR: [
            ...(macs.length ? [{ macAddress: { in: macs } }] : []),
            ...(hosts.length ? [{ hostname: { in: hosts } }, { dnsName: { in: hosts } }] : []),
          ],
        },
        select: { id: true, ipAddress: true, hostname: true, dnsName: true, macAddress: true, status: true },
      });
      const gone = rowsOfIneligibleOwners(chunk, assets);
      if (gone.length === 0) continue;
      released += await releaseRows(
        gone.map((g) => g.rowId),
        "the device that held it is decommissioned, disabled or has no address",
        gone[0]!.assetId,
      );
    }
  } catch (err) {
    logger.warn({ err }, "dns_resolved.sweep: releasing rows of ineligible owners failed");
  }
  return released;
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
