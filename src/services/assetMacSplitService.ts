/**
 * src/services/assetMacSplitService.ts — MAC edits on an asset: the split (rule 91(j)) and the one-shot removal (rule 79, removeAssetMac).
 *
 * Business rule 91(j): split a MAC off an asset onto an asset of its own — the
 * recovery for devices fused before 91(f) stopped matching DHCP hostnames
 * (one "iPhone" asset holding a hundred phones' MACs).
 *
 * What moves with each MAC: its `AssetMacAddress` row, every address row on it
 * (`AssetAssociatedIp` with that `mac`), the `AssetIpHistory` rows for those
 * addresses that no address left on the original still holds, and the
 * `fortigate-endpoint` AssetSource keyed on it. Reservations follow by
 * themselves (rule 102(b): a reservation names its asset by MAC). Monitoring,
 * credentials, tags, notes, sightings and quarantine stay.
 *
 * The new asset's primary MAC IS the split MAC: discovery's fortigate-endpoint
 * upsert re-binds that source to whichever asset holds the MAC as primary, so
 * anything else would pull it back on the next run.
 *
 * Refused: the original's primary MAC (it is what the original is), a MAC the
 * device itself reports (an interface port, an agent / Intune / vCenter NIC —
 * those are the device's own, never another device), a range row, a
 * quarantined asset (its pushed MACs would be orphaned on the gate), and a
 * split that would leave the original with no MAC.
 *
 * Naming goes through rule 91(i) (`planHostnameMacSuffixes`): the new assets
 * are named `<name>-<last 3 MAC octets>`, and the original is renamed the
 * same way when its name is discovery's.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import {
  HARDWARE_MAC_SOURCES,
  INTERFACE_MAC_SOURCE,
  MAC_ROW_SELECT,
  selectPrimaryMac,
  shapeMacRows,
} from "../utils/macAddresses.js";
import { normalizeMacOrNull } from "../utils/mac.js";
import { isHostnameFamilyMember } from "../utils/hostnameMacSuffix.js";
import { isIpv6Address } from "../utils/cidr.js";
import { CLEAR_PRIMARY_ADDRESS_PIN, bestListedAddress } from "./primaryAddressService.js";
import { planHostnameMacSuffixes, type PlannedRename } from "./hostnameMacSuffixService.js";
import { logEvent } from "./eventLogService.js";
import { DISCOVERED_ADDRESS_SOURCES } from "./assetAddressService.js";

export interface MacSplitResult {
  originalAssetId: string;
  created: Array<{ id: string; mac: string; hostname: string | null; ipAddress: string | null; movedIps: number; movedHistory: number }>;
  renamed: PlannedRename[];
}

/** Why a MAC row may not be split off, or null when it may. */
export function macSplitRefusal(
  row: { mac: string; macEnd?: string | null; source?: string | null },
  primaryMac: string | null,
): string | null {
  if (row.macEnd) return "a MAC range is the device's own ports";
  if (primaryMac && row.mac.toUpperCase() === primaryMac.toUpperCase()) return "the primary MAC stays: split the others off";
  if (row.source === INTERFACE_MAC_SOURCE || (row.source && HARDWARE_MAC_SOURCES.has(row.source))) {
    return "the device reports this MAC as its own";
  }
  return null;
}

/** "iPhone" for "iPhone-F2BC27" when the suffix is a MAC suffix, else the name. */
export function hostnameBase(hostname: string | null): string | null {
  if (!hostname) return null;
  const m = /^(.+)-(?:[0-9a-f]{6}|[0-9a-f]{12})$/i.exec(hostname);
  return m && isHostnameFamilyMember(hostname, m[1]!) ? m[1]! : hostname;
}

export async function splitMacsToNewAssets(opts: {
  assetId: string;
  macs: string[];
  actor: string | null;
}): Promise<MacSplitResult> {
  const wanted = [...new Set(opts.macs.map((m) => normalizeMacOrNull(m)).filter((m): m is string => !!m))];
  if (wanted.length === 0) throw new AppError(400, "Name at least one MAC to split");

  const asset = await prisma.asset.findUnique({
    where: { id: opts.assetId },
    select: {
      id: true, hostname: true, macAddress: true, ipAddress: true, assetType: true, os: true, osVersion: true,
      manufacturer: true, status: true, quarantinedAt: true, primaryAddressMac: true, discoveredByIntegrationId: true,
      macAddressRows: { select: MAC_ROW_SELECT },
      associatedIpRows: { select: { ip: true, mac: true, device: true, lastSeen: true } },
    },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  if (asset.status === "decommissioned") throw new AppError(409, "Reactivate the asset before splitting it");
  if (asset.quarantinedAt) throw new AppError(409, "Release the asset from quarantine before splitting it: its MACs are pushed to the gate");

  const rows = asset.macAddressRows;
  const byMac = new Map(rows.map((r) => [r.mac.toUpperCase(), r]));
  for (const mac of wanted) {
    const row = byMac.get(mac);
    if (!row) throw new AppError(404, `${mac} is not on this asset`);
    const why = macSplitRefusal(row, asset.macAddress);
    if (why) throw new AppError(409, `${mac} cannot be split: ${why}`);
  }
  const remainingRows = rows.filter((r) => !wanted.includes(r.mac.toUpperCase()));
  if (remainingRows.length === 0) throw new AppError(409, "Splitting every MAC would leave this asset with none");

  const base = hostnameBase(asset.hostname);
  const now = new Date();
  const movedIpsAll = new Set<string>();
  const keptIps = new Set(asset.associatedIpRows.filter((a) => !a.mac || !wanted.includes(a.mac.toUpperCase())).map((a) => a.ip));

  const created = await prisma.$transaction(async (tx) => {
    const out: MacSplitResult["created"] = [];
    for (const mac of wanted) {
      const row = byMac.get(mac)!;
      const addrs = asset.associatedIpRows
        .filter((a) => a.mac?.toUpperCase() === mac)
        .sort((a, b) => (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0));
      const freshest = addrs.find((a) => !isIpv6Address(a.ip)) ?? null;
      const newAsset = await tx.asset.create({
        data: {
          hostname: base,
          assetType: asset.assetType,
          status: "active",
          statusChangedAt: now,
          statusChangedBy: opts.actor || "system",
          os: asset.os,
          osVersion: asset.osVersion,
          manufacturer: asset.manufacturer,
          macAddress: mac,
          ipAddress: freshest?.ip ?? null,
          ...(freshest?.device ? { ipSource: freshest.device, learnedLocation: freshest.device } : {}),
          lastSeen: row.lastSeen ?? null,
          tags: ["split-from-asset", "auto-discovered"],
          notes: `Split from asset ${asset.hostname || asset.id} (MAC ${mac}) on ${now.toISOString()}`,
          ...(asset.discoveredByIntegrationId ? { discoveredByIntegrationId: asset.discoveredByIntegrationId } : {}),
          createdBy: opts.actor || null,
        } as any,
      });
      await tx.assetMacAddress.update({
        where: { assetId_mac: { assetId: asset.id, mac: row.mac } },
        data: { assetId: newAsset.id },
      });
      const movedIps = addrs.map((a) => a.ip);
      for (const ip of movedIps) movedIpsAll.add(ip);
      if (movedIps.length) {
        await tx.assetAssociatedIp.updateMany({
          where: { assetId: asset.id, ip: { in: movedIps } },
          data: { assetId: newAsset.id },
        });
      }
      // History follows an address only when nothing left on the original holds it.
      const historyIps = movedIps.filter((ip) => !keptIps.has(ip));
      const hist = historyIps.length
        ? await tx.assetIpHistory.updateMany({ where: { assetId: asset.id, ip: { in: historyIps } }, data: { assetId: newAsset.id } })
        : { count: 0 };
      await tx.assetSource.updateMany({
        where: { assetId: asset.id, sourceKind: "fortigate-endpoint", externalId: mac },
        data: { assetId: newAsset.id },
      });
      out.push({ id: newAsset.id, mac, hostname: newAsset.hostname, ipAddress: newAsset.ipAddress, movedIps: movedIps.length, movedHistory: hist.count });
    }

    // The original keeps its primary MAC — a split never takes it — and is
    // given one by the usual rule only when it had none. The address pin is
    // released if it named a moved MAC, the monitored address moved off a
    // split address.
    const update: Record<string, unknown> = {};
    if (!asset.macAddress) update.macAddress = selectPrimaryMac(shapeMacRows(remainingRows));
    if (asset.primaryAddressMac && wanted.includes(asset.primaryAddressMac.toUpperCase())) Object.assign(update, CLEAR_PRIMARY_ADDRESS_PIN);
    if (asset.ipAddress && movedIpsAll.has(asset.ipAddress)) {
      const listed = asset.associatedIpRows.filter((a) => keptIps.has(a.ip)).map((a) => a.ip);
      const best = listed.length ? await bestListedAddress(asset.id, listed, null) : null;
      update.ipAddress = best?.ip ?? null;
    }
    await tx.asset.update({ where: { id: asset.id }, data: update });
    return out;
  });

  // Rule 91(i): the new assets are named apart, and the original with them
  // when its name is discovery's. Single-row updates so open alerts follow (rule 134).
  let renamed: PlannedRename[] = [];
  if (base) {
    renamed = await planHostnameMacSuffixes(created.map((c) => ({ id: c.id, hostname: c.hostname })));
    for (const r of renamed) {
      await prisma.asset.update({ where: { id: r.id }, data: { hostname: r.to } });
      const c = created.find((x) => x.id === r.id);
      if (c) c.hostname = r.to;
    }
  }

  for (const c of created) {
    void logEvent({
      action: "asset.mac_split",
      resourceType: "asset",
      resourceId: asset.id,
      resourceName: asset.hostname || undefined,
      actor: opts.actor || undefined,
      level: "info",
      message: `Split MAC ${c.mac} off ${asset.hostname || asset.id} onto new asset ${c.hostname || c.id} (${c.movedIps} address(es), ${c.movedHistory} history row(s))`,
      details: { originalAssetId: asset.id, newAssetId: c.id, mac: c.mac, movedIps: c.movedIps, movedHistory: c.movedHistory },
    });
  }
  for (const r of renamed) {
    void logEvent({
      action: "asset.renamed_by_mac",
      resourceType: "asset",
      resourceId: r.id,
      resourceName: r.to,
      actor: opts.actor || undefined,
      level: "info",
      message: `Renamed ${r.from} to ${r.to}: devices that share a name are named apart by MAC (rule 91(i))`,
      details: { from: r.from, to: r.to },
    });
  }

  return { originalAssetId: asset.id, created, renamed };
}

/**
 * DELETE /assets/:id/macs/:mac — remove one MAC row (a RANGE row whole) from
 * an asset: one transaction drops the row, the discovery addresses recorded
 * under it (rule 102) and a primary-address pin on it, and re-picks
 * `Asset.macAddress` through selectPrimaryMac (rule 79). One-shot by design: no
 * tombstone. Writes asset.mac_removed. `normalized` is upper-case, colon-
 * separated. Moved out of routes/assets/addresses.ts (CQ-B062 slice 2).
 */
export async function removeAssetMac(id: string, normalized: string, actor: string | undefined) {
  const existing = await prisma.asset.findUnique({
    where: { id },
    include: { macAddressRows: { select: MAC_ROW_SELECT } },
  });
  if (!existing) throw new AppError(404, "Asset not found");

  const allRows = existing.macAddressRows;
  const target = allRows.find((m) => m.mac.toUpperCase().replace(/-/g, ":") === normalized);
  if (!target) {
    throw new AppError(404, "MAC address not found on this asset");
  }

  // Compute the new primary `Asset.macAddress` scalar after removal, or null
  // if nothing usable survives. Side-table delete + scalar-column update run
  // as a single transaction so the asset never points at a MAC that no longer
  // exists.
  //
  // This goes through `selectPrimaryMac` rather than a local freshest-wins
  // sort (business rule 79) so the promotion obeys the same two rules every other writer does:
  // hardware-truth sources (agent / Intune / vCenter vNIC) outrank network
  // sightings, and a RANGE row is never primary — it is a port block, not a
  // device identity. The hand-rolled sort this replaced honoured neither, so
  // removing an asset's primary MAC could promote the start of an
  // interface-scrape range into `Asset.macAddress`, which the next discovery
  // reconcile would then overwrite again.
  let primary = existing.macAddress;
  if (primary && primary.toUpperCase().replace(/-/g, ":") === normalized) {
    primary = selectPrimaryMac(shapeMacRows(allRows.filter((m) => m.mac !== target.mac)));
  }

  // The addresses discovery recorded under that MAC go with it (business
  // rule 102) — like the MAC itself, they come back on the next read if the
  // gate still reports them. Manual and interface-scrape rows stay. A pin on
  // the removed MAC is released: the pair it named is no longer on the list.
  const [, , updated] = await prisma.$transaction([
    prisma.assetMacAddress.deleteMany({
      where: { assetId: id, mac: target.mac },
    }),
    prisma.assetAssociatedIp.deleteMany({
      where: { assetId: id, mac: target.mac, source: { in: [...DISCOVERED_ADDRESS_SOURCES] } },
    }),
    prisma.asset.update({
      where: { id },
      data: {
        macAddress: primary,
        ...(existing.primaryAddressMac === target.mac ? CLEAR_PRIMARY_ADDRESS_PIN : {}),
      },
    }),
  ]);

  // Name the RANGE when the removed row was one — "removed MAC AA:…:00" for a
  // row that took 48 port MACs with it reads as a far smaller act than it was.
  const removedLabel = target.macEnd ? `MAC range ${target.mac} – ${target.macEnd}` : `MAC ${normalized}`;
  logEvent({
    action: "asset.mac_removed",
    resourceType: "asset",
    resourceId: id,
    resourceName: updated.hostname || updated.ipAddress || undefined,
    actor,
    message: `Removed ${removedLabel} from asset "${updated.hostname || updated.ipAddress || "unknown"}"`,
    details: {
      mac: target.mac, macEnd: target.macEnd, source: target.source, primaryAfter: primary,
      ...(existing.primaryAddressMac === target.mac ? { releasedPrimaryAddressPin: existing.primaryAddressIp } : {}),
    },
  });
  return updated;
}
