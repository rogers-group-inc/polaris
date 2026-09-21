/**
 * src/services/subnetRefreshService.ts — Per-subnet "discover from device"
 * action invoked by the Discover button in the IP panel slide-in. (The button
 * read "Refresh" until 2026-09-21; the route, this service and its Event action
 * keep the older spelling, which is a stable citation key for API clients and
 * for every `subnet.refresh` Event already in the log.)
 *
 * Queries the originating FortiGate for ONE DHCP scope (CMDB reservations +
 * live leases) and for the gate's firewall VIP table, reconciles both against
 * Polaris's reservation rows for the same subnet, and stamps
 * subnet.lastDiscoveredAt so the slide-in's "Discovered N minutes ago" line
 * updates. Reuses the same FMG-proxy / direct-FortiGate transport as
 * reservationPushService.
 *
 * Intentionally narrower than the full discoverDhcpSubnets pipeline — only
 * touches DHCP and VIP facts on this subnet, doesn't recompute asset sightings
 * / decommissions / map regions / etc. Those reconcile on the next full
 * integration discovery cycle.
 */

import { Netmask } from "netmask";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { ipInCidr } from "../utils/cidr.js";
import {
  parseVipRow,
  vipIpRoles,
  vipInfoSnapshot,
  vipInfoDiffers,
  decideVipDhcpBinding,
  type ParsedVip,
  type VipInfoSnapshot,
} from "../utils/vipAddressFacts.js";
import { logEvent } from "./eventLogService.js";
import {
  buildTransportForIntegration,
  findScopeIdForCidr,
  listReservedAddresses,
  callFortiOs,
  normalizeMac,
  type Transport,
  type FortiOsReservedAddress,
} from "./reservationPushService.js";

// ─── FortiOS live monitor shape (subset) ────────────────────────────────────

interface FortiOsDhcpLease {
  ip: string;
  mac?: string;
  hostname?: string;
  interface?: string;
  reserved?: boolean;
  expire_time?: number;
  access_point?: string;
  ssid?: string;
}

async function fetchLiveLeasesForScope(
  t: Transport,
  serverInterface: string | undefined,
  subnetCidr: string,
): Promise<FortiOsDhcpLease[]> {
  // /api/v2/monitor/system/dhcp returns every active lease on the device,
  // grouped by server entry; we filter to the matching server-interface (when
  // known) and fall back to a CIDR-contains check for safety.
  const res = await callFortiOs<unknown>(
    t,
    "GET",
    "/api/v2/monitor/system/dhcp?format=ip|mac|hostname|interface|reserved|expire_time|access_point|ssid",
  );
  // FortiOS returns either an array of { server_interface, leases: [...] }
  // groups or a flat list — handle both.
  const flat: FortiOsDhcpLease[] = [];
  const collect = (arr: unknown): void => {
    if (!Array.isArray(arr)) return;
    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (Array.isArray(e.leases)) {
        const iface = String((e.server_interface as string) ?? (e.interface as string) ?? "");
        for (const lease of e.leases as unknown[]) {
          if (lease && typeof lease === "object") {
            const l = lease as Record<string, unknown>;
            flat.push({
              ip: String(l.ip ?? ""),
              mac: l.mac ? String(l.mac) : undefined,
              hostname: l.hostname ? String(l.hostname) : undefined,
              interface: iface || (l.interface ? String(l.interface) : undefined),
              reserved: l.reserved === true,
              expire_time: typeof l.expire_time === "number" ? l.expire_time : undefined,
              access_point: l.access_point ? String(l.access_point) : undefined,
              ssid: l.ssid ? String(l.ssid) : undefined,
            });
          }
        }
      } else if (e.ip) {
        flat.push({
          ip: String(e.ip),
          mac: e.mac ? String(e.mac) : undefined,
          hostname: e.hostname ? String(e.hostname) : undefined,
          interface: e.interface ? String(e.interface) : undefined,
          reserved: e.reserved === true,
          expire_time: typeof e.expire_time === "number" ? e.expire_time : undefined,
          access_point: e.access_point ? String(e.access_point) : undefined,
          ssid: e.ssid ? String(e.ssid) : undefined,
        });
      }
    }
  };
  collect(res);
  // FortiOS sometimes wraps the results under .results
  if (res && typeof res === "object" && "results" in (res as Record<string, unknown>)) {
    collect((res as Record<string, unknown>).results);
  }

  // Filter to this scope: prefer server-interface match (authoritative);
  // fall back to CIDR-contains so old FortiOS builds that don't expose the
  // interface group still narrow correctly.
  let block: Netmask | null = null;
  try {
    block = new Netmask(subnetCidr);
  } catch {
    /* leave null */
  }
  return flat.filter((l) => {
    if (!l.ip || l.ip === "0.0.0.0") return false;
    if (serverInterface && l.interface && l.interface !== serverInterface) {
      // If the lease reports an interface and it doesn't match, only keep
      // when the IP still falls inside the subnet (handles VDOM weirdness).
      if (block && !block.contains(l.ip)) return false;
    } else if (block && !block.contains(l.ip)) {
      return false;
    }
    return true;
  });
}

/**
 * The gate's whole `firewall/vip` table, read through whichever transport this
 * integration uses.
 *
 * One REST path for both transports on purpose: the FortiManager proxy forwards
 * a REST call to the device, so the response is the device's own encoding
 * rather than FortiManager's JSON-RPC flattening — and `parseVipRow` accepts
 * either, so the two integration types cannot drift here the way the two
 * full-discovery VIP readers once did.
 *
 * The table is device-wide (there is no per-scope VIP query), so it is filtered
 * to this subnet by the caller. A gate with hundreds of VIPs still returns one
 * response; this runs on an operator's click, not on a tick.
 */
async function fetchVipsForGate(t: Transport, deviceName: string): Promise<ParsedVip[]> {
  const res = await callFortiOs<unknown>(
    t,
    "GET",
    "/api/v2/cmdb/firewall/vip",
  );
  const rows = Array.isArray(res)
    ? res
    : Array.isArray((res as Record<string, unknown> | null)?.results)
      ? ((res as Record<string, unknown>).results as unknown[])
      : [];
  const out: ParsedVip[] = [];
  for (const row of rows) {
    const parsed = parseVipRow(row, deviceName);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * The owner and notes a discovery-created VIP row carries.
 *
 * Spelled the same way discovery Phase 3c spells them, because both the Phase 5
 * succession path and this service's own retire branch recognise a row as
 * "still carrying only what discovery wrote" by matching these exact strings.
 * A row whose owner is anything else was authored somewhere else and survives.
 */
function vipCanonicalOwner(snap: VipInfoSnapshot): string {
  return snap.isVirtualServer ? "fortimanager-vs" : "fortimanager-vip";
}

function vipCanonicalNotes(snap: VipInfoSnapshot): string {
  const kind = snap.isVirtualServer ? "Virtual server" : "Firewall VIP";
  return `${kind} "${snap.name}" (${snap.role}) on ${snap.device} — ext: ${snap.extip}`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface RefreshSubnetResult {
  lastDiscoveredAt: Date;
  created: number;
  updated: number;
  released: number;
  skipped: number;
  /** Addresses whose stored VIP snapshot was created or brought up to date. */
  vipsStamped: number;
  /** Addresses that carried a VIP this gate no longer reports. */
  vipsCleared: number;
  /**
   * The gate's VIP table could not be read. Every VIP decision is skipped for
   * the pass — never "no VIPs" — so an unreadable table can't retire the VIP
   * facts Polaris already holds (business rule 53). Null on a successful read.
   */
  vipError: string | null;
}

/**
 * Refresh ONE subnet's DHCP reservations + leases from the FortiGate that
 * owns it. Bumps subnet.lastDiscoveredAt on success.
 */
export async function refreshSubnet(
  subnetId: string,
  actor: string | null,
): Promise<RefreshSubnetResult> {
  const subnet = await prisma.subnet.findUnique({
    where: { id: subnetId },
    include: { integration: true, reservations: true },
  });
  if (!subnet) throw new AppError(404, "Subnet not found");
  if (!subnet.discoveredBy || !subnet.integration) {
    throw new AppError(
      400,
      "Refresh is only supported for subnets discovered by an integration",
    );
  }
  const integration = subnet.integration;
  if (integration.type !== "fortimanager" && integration.type !== "fortigate") {
    throw new AppError(
      400,
      `Refresh is not supported for integration type "${integration.type}"`,
    );
  }
  if (!subnet.fortigateDevice) {
    throw new AppError(
      400,
      "Subnet has no associated FortiGate device — cannot refresh",
    );
  }

  const t = await buildTransportForIntegration(
    { id: integration.id, type: integration.type, config: integration.config },
    subnet.fortigateDevice,
  );
  const { scopeId, serverInterface } = await findScopeIdForCidr(t, subnet.cidr);
  const [cmdb, leases, vipRead] = await Promise.all([
    listReservedAddresses(t, scopeId),
    fetchLiveLeasesForScope(t, serverInterface, subnet.cidr),
    // Settled rather than awaited alongside: a gate that answers for DHCP and
    // refuses `firewall/vip` (an API token scoped away from the firewall CMDB
    // is the common shape) must still complete the DHCP reconcile. The failure
    // is carried to the caller instead of being thrown, because "could not
    // read" and "there are none" mean opposite things here.
    fetchVipsForGate(t, subnet.fortigateDevice).then(
      (vips) => ({ ok: true as const, vips }),
      (err: unknown) => ({
        ok: false as const,
        error: (err as { message?: string })?.message || "Unknown error",
      }),
    ),
  ]);

  // Build the fresh view of this scope, keyed by IP. CMDB reservations are
  // authoritative — they win on overlap with a live lease for the same IP.
  interface Fresh {
    ip: string;
    mac: string | null;
    hostname: string | null;
    sourceType: "dhcp_reservation" | "dhcp_lease";
    // CMDB entry id for dhcp_reservation entries — needed to fast-path adopt
    // a queued Polaris row by stamping its pushedScopeId/pushedEntryId
    // pointers. Leases don't have CMDB ids; this stays undefined for them.
    entryId?: number;
  }
  const fresh = new Map<string, Fresh>();
  for (const r of cmdb) {
    if (!r.ip) continue;
    fresh.set(r.ip, {
      ip: r.ip,
      mac: r.mac ? normalizeMac(r.mac) : null,
      hostname: r.description ? extractHostnameFromDescription(r.description) : null,
      sourceType: "dhcp_reservation",
      entryId: r.id,
    });
  }
  for (const l of leases) {
    if (fresh.has(l.ip)) continue;
    fresh.set(l.ip, {
      ip: l.ip,
      mac: l.mac ? normalizeMac(l.mac) : null,
      hostname: l.hostname || null,
      sourceType: l.reserved ? "dhcp_reservation" : "dhcp_lease",
    });
  }

  // Existing dhcp_*-sourced active reservations on this subnet.
  const existing = subnet.reservations.filter(
    (r) =>
      r.status === "active" &&
      r.ipAddress &&
      (r.sourceType === "dhcp_reservation" || r.sourceType === "dhcp_lease"),
  );
  // Pending push-queued rows on this subnet. These have sourceType="manual"
  // and pushStatus="pending" — they reserve an IP in Polaris but haven't been
  // written to the device yet. Collide them against the fresh discovery view:
  // - same IP + same MAC + fresh is dhcp_reservation → fast-path adopt:
  //   promote the pending row in place to synced + stamp pushedScopeId/entryId.
  // - same IP but mismatched MAC, OR fresh is dhcp_lease → hard collision:
  //   flip the pending row to pushStatus="failed_permanent" so the operator
  //   can see what won the IP and either release or pick a different IP.
  //   The pending row stays status="active" so the @@unique constraint keeps
  //   blocking a duplicate discovery create on this IP; the discovery sync
  //   skips this IP (same as manualByIp) until the operator acts.
  const pendingByIp = new Map<string, (typeof subnet.reservations)[number]>();
  for (const r of subnet.reservations) {
    if (
      r.status === "active" &&
      r.ipAddress &&
      r.pushStatus === "pending"
    ) {
      pendingByIp.set(r.ipAddress, r);
    }
  }
  // Active manual rows on this subnet — we leave these alone and skip creating
  // a competing dhcp_* row on the same IP. The next full discovery is where
  // conflict detection (upsertConflict) runs. Pending push-queued rows are
  // filtered out here so they don't double-count under manualByIp; they're
  // handled by pendingByIp above. VIP rows are filtered out for a different
  // reason — see vipRowByIp.
  const manualByIp = new Map<string, (typeof subnet.reservations)[number]>();
  // Active `vip` rows on this subnet, split out of manualByIp because a VIP row
  // is the one authoritative row that must still LEARN from the DHCP view:
  // business rule 77 says a VIP describes an address without saying how the
  // gate hands it out, so a DHCP entry at a VIP address stamps `dhcpBinding`
  // rather than being discarded as a collision with an untouchable row.
  const vipRowByIp = new Map<string, (typeof subnet.reservations)[number]>();
  for (const r of subnet.reservations) {
    if (r.status !== "active" || !r.ipAddress) continue;
    if (r.sourceType === "vip") {
      vipRowByIp.set(r.ipAddress, r);
      continue;
    }
    if (
      r.sourceType !== "dhcp_reservation" &&
      r.sourceType !== "dhcp_lease" &&
      r.pushStatus !== "pending"
    ) {
      manualByIp.set(r.ipAddress, r);
    }
  }

  let created = 0;
  let updated = 0;
  let released = 0;
  let skipped = 0;

  // A busy /21 carries ~1500 leases, so the reconcile below accumulates its
  // writes and flushes them batched rather than one awaited round trip per IP.
  // The two pending-push paths stay inline: they are rare, and each pairs its
  // write with an Event that must name that row's outcome.
  const existingByIp = new Map<string, (typeof existing)[number]>();
  for (const r of existing) if (r.ipAddress) existingByIp.set(r.ipAddress, r);
  const diffUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const toCreate: Array<{
    subnetId: string; ipAddress: string; hostname: string | null; macAddress: string | null;
    status: "active"; sourceType: "dhcp_reservation" | "dhcp_lease"; lastSeenLeased: Date; createdBy: string;
  }> = [];

  // Upsert each fresh entry.
  for (const [ip, f] of fresh) {
    const pending = pendingByIp.get(ip);
    if (pending) {
      const pendingMac = pending.macAddress ? normalizeMac(pending.macAddress) : null;
      const macsMatch = !!pendingMac && !!f.mac && pendingMac === f.mac;
      if (f.sourceType === "dhcp_reservation" && macsMatch && f.entryId !== undefined) {
        // Fast-path adopt — operator added the entry on the device while we
        // were waiting, or the previous retry succeeded but Polaris missed
        // the response. Promote in place to synced; preserves operator-typed
        // hostname / notes / owner.
        await prisma.reservation.update({
          where: { id: pending.id },
          data: {
            sourceType: "dhcp_reservation",
            pushedToId: subnet.discoveredBy,
            pushedScopeId: scopeId,
            pushedEntryId: f.entryId,
            pushStatus: "synced",
            pushedAt: new Date(),
            pushError: null,
            pushQueuedAt: null,
            pushAttempts: 0,
            pushLastAttemptAt: null,
            lastSeenLeased: new Date(),
            ...(f.hostname && pending.hostname !== f.hostname ? { hostname: f.hostname } : {}),
          },
        });
        await logEvent({
          level: "info",
          action: "reservation.push.queued.adopted",
          resourceType: "reservation",
          resourceId: pending.id,
          resourceName: pending.hostname || ip,
          actor: actor || undefined,
          message: `Queued reservation adopted by discovery — entry already present on FortiGate "${subnet.fortigateDevice}" (scope ${scopeId}, entry ${f.entryId})`,
          details: {
            deviceName: subnet.fortigateDevice,
            scopeId,
            entryId: f.entryId,
            ip,
            mac: pendingMac,
          },
        });
        updated++;
        continue;
      }
      // Hard collision: pending row exists but discovery sees a different MAC
      // or a dhcp_lease. Flag the pending row permanently and skip the
      // discovery create on this IP — the @@unique constraint would block it
      // anyway. Operator must release the pending row to free the IP.
      const errMsg = `IP collided during queue — discovered ${f.sourceType}${f.mac ? ` by ${f.mac}` : ""}`;
      await prisma.reservation.update({
        where: { id: pending.id },
        data: {
          pushStatus: "failed_permanent",
          pushError: errMsg,
          pushLastAttemptAt: new Date(),
        },
      });
      await logEvent({
        level: "warning",
        action: "reservation.push.queued.collided",
        resourceType: "reservation",
        resourceId: pending.id,
        resourceName: pending.hostname || ip,
        actor: actor || undefined,
        message: `Queued push for ${ip} aborted — ${errMsg}. Release the reservation or pick a different IP.`,
        details: {
          deviceName: subnet.fortigateDevice,
          ip,
          pendingMac,
          discoveredSourceType: f.sourceType,
          discoveredMac: f.mac,
        },
      });
      skipped++;
      continue;
    }
    const vipRow = vipRowByIp.get(ip);
    if (vipRow) {
      // A VIP address the gate is ALSO serving over DHCP. The VIP keeps the
      // row (it is the device's own config and Polaris did not grant it), and
      // the DHCP fact lands in `dhcpBinding` — the same column, for the same
      // reason, as the managed-switch/AP case of business rule 23. sourceType
      // is not flipped and no expiry is stamped: the succession that converts
      // one of these rows belongs to the pass that can see the VIP is GONE,
      // which is the VIP reconcile below and Phase 5 in a full discovery.
      const patch = decideVipDhcpBinding(vipRow, {
        type: f.sourceType === "dhcp_reservation" ? "dhcp-reservation" : "dhcp-lease",
        macAddress: f.mac,
      });
      if (patch) {
        diffUpdates.push({ id: vipRow.id, data: patch as Record<string, unknown> });
        updated++;
      }
      continue;
    }
    if (manualByIp.has(ip)) {
      skipped++;
      continue;
    }
    const matched = existingByIp.get(ip);
    if (matched) {
      const diff: Record<string, unknown> = {};
      if (matched.sourceType !== f.sourceType) {
        diff.sourceType = f.sourceType;
        // Flip the conventional owner placeholder ("dhcp-lease" / "dhcp-
        // reservation") alongside the sourceType so the IP panel status pill
        // and the owner column don't disagree. Operator-stamped owners
        // (anything not in this allowlist) survive untouched.
        if (matched.owner === "dhcp-lease" || matched.owner === "dhcp-reservation") {
          diff.owner = f.sourceType === "dhcp_reservation" ? "dhcp-reservation" : "dhcp-lease";
        }
      }
      if (f.mac && matched.macAddress !== f.mac) diff.macAddress = f.mac;
      if (f.hostname && matched.hostname !== f.hostname) diff.hostname = f.hostname;
      if (f.sourceType === "dhcp_reservation" || matched.sourceType === "dhcp_lease") {
        diff.lastSeenLeased = new Date();
      }
      if (Object.keys(diff).length > 0) {
        diffUpdates.push({ id: matched.id, data: diff });
        updated++;
      }
    } else {
      toCreate.push({
        subnetId: subnet.id,
        ipAddress: ip,
        hostname: f.hostname,
        macAddress: f.mac,
        status: "active",
        sourceType: f.sourceType,
        lastSeenLeased: new Date(),
        createdBy: actor || "refresh",
      });
    }
  }

  // Flush the accumulated writes. Updates target disjoint rows, so ordering
  // within a chunk is irrelevant; chunked so one transaction never spans a
  // whole /21's diff.
  const UPDATE_CHUNK = 500;
  for (let i = 0; i < diffUpdates.length; i += UPDATE_CHUNK) {
    await prisma.$transaction(
      diffUpdates.slice(i, i + UPDATE_CHUNK).map((u) => prisma.reservation.update({ where: { id: u.id }, data: u.data })),
    );
  }
  if (toCreate.length > 0) {
    // skipDuplicates: a row created between our subnet read and this flush
    // (e.g. the dns_resolved auto-create racing on the @@unique) skips that
    // one IP instead of aborting the whole refresh, and `created` reports
    // what actually landed.
    const res = await prisma.reservation.createMany({ data: toCreate, skipDuplicates: true });
    created = res.count;
  }

  // Release dhcp_* rows that are no longer on the device — one write, the
  // staged value is identical for every row.
  const releasedIds = existing.filter((r) => !fresh.has(r.ipAddress!)).map((r) => r.id);
  if (releasedIds.length > 0) {
    await prisma.reservation.updateMany({ where: { id: { in: releasedIds } }, data: { status: "released" } });
    released = releasedIds.length;
  }

  // ── VIP facts ───────────────────────────────────────────────────────────
  // Business rule 77. Runs after the DHCP flush, and re-reads the subnet's
  // active rows rather than reusing the snapshot taken at the top: a row this
  // pass just created at a VIP address has to be able to receive its VIP
  // snapshot on the SAME pass, or the badge and the composed status pill would
  // not appear until the operator clicked Discover a second time.
  let vipsStamped = 0;
  let vipsCleared = 0;
  const vipError = vipRead.ok ? null : vipRead.error;
  if (vipRead.ok) {
    const vipByIp = new Map<string, VipInfoSnapshot>();
    for (const vip of vipRead.vips) {
      for (const { ip, role } of vipIpRoles(vip)) {
        if (!ipInCidr(ip, subnet.cidr)) continue;
        if (!vipByIp.has(ip)) vipByIp.set(ip, vipInfoSnapshot(vip, role));
      }
    }

    const liveRows = await prisma.reservation.findMany({
      where: { subnetId: subnet.id, status: "active" },
      select: { id: true, ipAddress: true, sourceType: true, owner: true, vipInfo: true },
    });
    const rowByIp = new Map<string, (typeof liveRows)[number]>();
    for (const r of liveRows) if (r.ipAddress) rowByIp.set(r.ipAddress, r);

    // Stamp: the snapshot rides whatever row already holds the address, and a
    // `vip` row is created only where nothing holds it. Stamping in place is
    // what lets one address carry both facts — the DHCP row keeps its own
    // sourceType and simply gains the VIP the gate reports at that address.
    const vipStamps: Array<{ id: string; data: Record<string, unknown> }> = [];
    const vipCreates: Array<Record<string, unknown>> = [];
    for (const [ip, snap] of vipByIp) {
      const row = rowByIp.get(ip);
      if (!row) {
        vipCreates.push({
          subnetId: subnet.id,
          ipAddress: ip,
          hostname: snap.name,
          owner: vipCanonicalOwner(snap),
          projectRef: `${snap.isVirtualServer ? "VS" : "VIP"}: ${snap.device}`,
          notes: vipCanonicalNotes(snap),
          status: "active",
          sourceType: "vip",
          vipInfo: snap as unknown as object,
        });
        vipsStamped++;
        continue;
      }
      if (vipInfoDiffers(row.vipInfo, snap)) {
        vipStamps.push({ id: row.id, data: { vipInfo: snap as unknown as object } });
        vipsStamped++;
      }
    }
    for (let i = 0; i < vipStamps.length; i += UPDATE_CHUNK) {
      await prisma.$transaction(
        vipStamps.slice(i, i + UPDATE_CHUNK).map((u) =>
          prisma.reservation.update({ where: { id: u.id }, data: u.data }),
        ),
      );
    }
    if (vipCreates.length > 0) {
      await prisma.reservation.createMany({
        data: vipCreates as never,
        skipDuplicates: true,
      });
    }

    // Retire: a stored VIP this gate no longer reports. Scoped to snapshots
    // naming THIS gate, because RFC1918 space repeats behind different
    // FortiGates and a VIP stamped by another gate's discovery is not this
    // pass's to judge — the same per-device scoping business rule 17 applies
    // to ARP evidence. Only reached when the VIP table actually READ.
    for (const row of liveRows) {
      const cur = row.vipInfo as VipInfoSnapshot | null;
      if (!cur || !row.ipAddress) continue;
      if (vipByIp.has(row.ipAddress)) continue;
      if (cur.device !== subnet.fortigateDevice) continue;

      if (row.sourceType !== "vip") {
        // The row owns the address on its own account; only the VIP fact goes.
        await prisma.reservation.update({ where: { id: row.id }, data: { vipInfo: Prisma.DbNull } });
        vipsCleared++;
        continue;
      }

      const dhcpAtIp = fresh.get(row.ipAddress);
      if (dhcpAtIp) {
        // VIP succession, the narrow form of discovery Phase 5's: the VIP is
        // gone and a DHCP entry has landed at the same address, so the row
        // converts in place and keeps its id. Only the canonical VIP-discovery
        // owner placeholder is overwritten — a `vip` row cannot be edited from
        // Polaris, so anything else on it came from discovery too.
        const isCanonicalVipOwner =
          row.owner === "fortimanager-vip" || row.owner === "fortimanager-vs";
        await prisma.reservation.update({
          where: { id: row.id },
          data: {
            sourceType: dhcpAtIp.sourceType,
            vipInfo: Prisma.DbNull,
            lastSeenLeased: new Date(),
            ...(isCanonicalVipOwner
              ? {
                  owner:
                    dhcpAtIp.sourceType === "dhcp_reservation"
                      ? "dhcp-reservation"
                      : "dhcp-lease",
                }
              : {}),
          },
        });
        await logEvent({
          level: "info",
          action: "reservation.vip.replaced",
          resourceType: "reservation",
          resourceId: row.id,
          resourceName: row.ipAddress,
          actor: actor || undefined,
          message: `VIP "${cur.name}" no longer on ${cur.device} — converted to ${dhcpAtIp.sourceType.replace("_", " ")} at ${row.ipAddress}`,
          details: {
            reservationId: row.id,
            ipAddress: row.ipAddress,
            priorVipInfo: cur,
            newSourceType: dhcpAtIp.sourceType,
            fortigateDevice: subnet.fortigateDevice,
            via: "subnet-discover",
          },
        });
        vipsCleared++;
        continue;
      }

      // The VIP is gone and nothing else claims the address — the row existed
      // only to report the VIP, so it goes back to Available.
      await prisma.reservation.update({
        where: { id: row.id },
        data: { status: "released", vipInfo: Prisma.DbNull },
      });
      await logEvent({
        level: "info",
        action: "reservation.vip.released",
        resourceType: "reservation",
        resourceId: row.id,
        resourceName: row.ipAddress,
        actor: actor || undefined,
        message: `VIP "${cur.name}" no longer on ${cur.device} — released ${row.ipAddress}`,
        details: {
          reservationId: row.id,
          ipAddress: row.ipAddress,
          priorVipInfo: cur,
          fortigateDevice: subnet.fortigateDevice,
          via: "subnet-discover",
        },
      });
      vipsCleared++;
    }
  }

  const lastDiscoveredAt = new Date();
  await prisma.subnet.update({
    where: { id: subnet.id },
    data: { lastDiscoveredAt },
  });

  await logEvent({
    level: "info",
    action: "subnet.refresh",
    resourceType: "subnet",
    resourceId: subnet.id,
    resourceName: `${subnet.name} (${subnet.cidr})`,
    actor: actor || undefined,
    message:
      `Discovered ${subnet.cidr} from ${integration.name} (${subnet.fortigateDevice})` +
      (vipError ? " — the firewall VIP table could not be read" : ""),
    details: {
      created, updated, released, skipped,
      vipsStamped, vipsCleared, vipError,
      scopeId, serverInterface,
    },
  });

  return {
    lastDiscoveredAt, created, updated, released, skipped,
    vipsStamped, vipsCleared, vipError,
  };
}

// Reverse of buildDescription() in reservationPushService. Two formats:
//   notes present:  "Polaris/<user>: <notes> [<hostname>]"
//   notes empty:    "Polaris/<user>: <hostname>"
// Try the bracketed form first so a hostname embedded after operator notes
// is recovered cleanly; fall through to the colon-only form for the legacy
// shape and for entries pushed before the notes field carried into the
// description. Returns null for non-Polaris descriptions.
function extractHostnameFromDescription(desc: string): string | null {
  const trimmed = desc.trim();
  const bracketed = /^Polaris(?:\/[^:]+)?:\s*.*\[(.+)\]\s*$/.exec(trimmed);
  if (bracketed) return bracketed[1].trim();
  const legacy = /^Polaris(?:\/[^:]+)?:\s*(.+)$/.exec(trimmed);
  return legacy ? legacy[1].trim() : null;
}
