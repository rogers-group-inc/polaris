/**
 * src/services/discovery/dhcp/dnsOui.ts — syncDhcpSubnets Phases 8 and 9
 * (CQ-B060: the 5,700-line function is being split phase by phase; the
 * bodies below moved verbatim, their free variables made parameters and
 * their counters return values).
 *
 * Both run over `finalizeAssets` — the run's assets, or on a scoped run only
 * the assets its gate reported (rule 142) — which the caller builds once.
 * Each mutates the in-memory asset rows it updates, as before, so later
 * phases (10, 11) read the new values.
 */

import type { SyncLog } from "../syncLog.js";
import { prisma } from "../../../db.js";
import { getConfiguredResolver } from "../../dnsService.js";
import { lookupOui, lookupOuiOverride } from "../../ouiService.js";
import { mapSettledWithConcurrency } from "../../../utils/concurrency.js";

/** syncDhcpSubnets' bounded fan-out (its BATCH_SIZE). */
const BATCH_SIZE = 50;
const DEFAULT_PTR_TTL_S = 3600;

/** Phase 8 — DNS reverse lookup for assets missing dnsName (or past its PTR TTL). Returns how many resolved. */
export async function reverseDnsForAssets(finalizeAssets: any[], syncLog: SyncLog): Promise<number> {
  let dnsResolved = 0;
  const nowMs = Date.now();
  const assetsNeedingDns = finalizeAssets.filter((a: any) => {
    if (!a.ipAddress) return false;
    if (!a.dnsNameFetchedAt) return true;
    const fetchedMs = new Date(a.dnsNameFetchedAt).getTime();
    const ttlMs = ((a.dnsNameTtl ?? DEFAULT_PTR_TTL_S) * 1000);
    return (nowMs - fetchedMs) > ttlMs;
  });
  if (assetsNeedingDns.length > 0) {
    syncLog("info", `DNS lookup: resolving ${assetsNeedingDns.length} assets with expired/missing PTR`);
    const dnsResolver = await getConfiguredResolver();
    const dnsResults = await mapSettledWithConcurrency(assetsNeedingDns, BATCH_SIZE, async (asset: any) => {
      const fetchedAt = new Date();
      const records = await dnsResolver.reverse(asset.ipAddress);
      if (records.length > 0) {
        await prisma.asset.update({ where: { id: asset.id }, data: { dnsName: records[0].name, dnsNameFetchedAt: fetchedAt, dnsNameTtl: records[0].ttl } });
        asset.dnsName = records[0].name;
        return records[0].name;
      }
      await prisma.asset.update({ where: { id: asset.id }, data: { dnsNameFetchedAt: fetchedAt, dnsNameTtl: null } });
      return null;
    });
    for (const r of dnsResults) {
      if (r.status === "fulfilled" && r.value) dnsResolved++;
    }
    if (dnsResolved > 0) {
      syncLog("info", `DNS lookup: resolved ${dnsResolved} of ${assetsNeedingDns.length} assets`);
    }
  }
  return dnsResolved;
}

/** Phase 9 — OUI manufacturer lookup & override application. Returns the 9a / 9b counts. */
export async function applyOuiManufacturers(
  finalizeAssets: any[],
  syncLog: SyncLog,
): Promise<{ ouiOverridden: number; ouiResolved: number }> {
  let ouiOverridden = 0;
  let ouiResolved = 0;

  // 9a — Apply OUI overrides to assets that already have a manufacturer
  //       (e.g. "Fortinet" from FMG can be overridden to a custom name; an
  //       optional device field overrides the asset's model too)
  const assetsWithMacAndMfg = finalizeAssets.filter((a: any) => a.macAddress && a.manufacturer);
  if (assetsWithMacAndMfg.length > 0) {
    const overrideResults = await mapSettledWithConcurrency(assetsWithMacAndMfg, BATCH_SIZE, async (asset: any) => {
      const override = await lookupOuiOverride(asset.macAddress);
      if (!override) return null;
      const data: { manufacturer?: string; model?: string } = {};
      if (override.manufacturer !== asset.manufacturer) data.manufacturer = override.manufacturer;
      if (override.device && override.device !== asset.model) data.model = override.device;
      if (Object.keys(data).length === 0) return null;
      await prisma.asset.update({ where: { id: asset.id }, data });
      if (data.manufacturer) asset.manufacturer = data.manufacturer;
      if (data.model) asset.model = data.model;
      return data;
    });
    for (const r of overrideResults) {
      if (r.status === "fulfilled" && r.value) ouiOverridden++;
    }
    if (ouiOverridden > 0) {
      syncLog("info", `OUI overrides: applied to ${ouiOverridden} assets`);
    }
  }

  // 9b — OUI lookup for assets still missing a manufacturer.
  //       Also pick up the override's device field when present (applies
  //       even if asset already has a model — override wins by design).
  const assetsNeedingOui = finalizeAssets.filter((a: any) => a.macAddress && !a.manufacturer);
  if (assetsNeedingOui.length > 0) {
    syncLog("info", `OUI lookup: resolving ${assetsNeedingOui.length} assets missing manufacturer`);
    const ouiResults = await mapSettledWithConcurrency(assetsNeedingOui, BATCH_SIZE, async (asset: any) => {
      const vendor = await lookupOui(asset.macAddress);
      if (!vendor) return null;
      const override = await lookupOuiOverride(asset.macAddress);
      const data: { manufacturer: string; model?: string } = { manufacturer: vendor };
      if (override?.device && override.device !== asset.model) data.model = override.device;
      await prisma.asset.update({ where: { id: asset.id }, data });
      asset.manufacturer = vendor;
      if (data.model) asset.model = data.model;
      return vendor;
    });
    for (const r of ouiResults) {
      if (r.status === "fulfilled" && r.value) ouiResolved++;
    }
    if (ouiResolved > 0) {
      syncLog("info", `OUI lookup: resolved ${ouiResolved} of ${assetsNeedingOui.length} assets`);
    }
  }
  return { ouiOverridden, ouiResolved };
}
