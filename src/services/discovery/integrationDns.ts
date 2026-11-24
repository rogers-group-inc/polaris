/**
 * src/services/discovery/integrationDns.ts — the post-sync DNS pass for the
 * asset-only integrations that never run syncDhcpSubnets' Phase 8: Active
 * Directory, Entra ID / Intune, Azure Arc, Unraid, TrueNAS SCALE, Proxmox VE.
 *
 * Two halves, over the assets that carry a source row from THIS integration:
 *
 *   1. PTR refresh — every eligible asset with an address goes through
 *      Phase 8's own `reverseDnsForAssets`, so the TTL cache, the one stamp
 *      per pass and the rename-only per-row write are identical to FortiGate
 *      discovery's.
 *   2. Forward fill (business rule 11(b)) — an eligible asset with NO address
 *      is looked up by `dnsName || hostname`, and the first IPv4 answer is
 *      written as `ipAddress` with `ipSource = "dns"` — the same write the
 *      per-asset Forward Lookup button makes. It never replaces an address:
 *      the asset must have none, no operator pin (address, blank or primary
 *      pair), not be Fortinet-managed (rule 111(c)), and not be a container
 *      (a bridged container shares its host's address — rule-of-the-sync in
 *      workloadSync). An answer another live asset already holds, or that two
 *      candidates both got, is not written — stale DNS must not mint a rule-40
 *      duplicate. A miss is negative-cached on `dnsNameFetchedAt` for the
 *      default PTR TTL so an unresolvable name is not retried every run.
 *
 * Any real source that later reports an address outranks this one: projected
 * addresses overwrite it, and the pins apply to it like any other write.
 *
 * Scale: one AssetSource read (this integration, ids only), assets read in
 * chunks of 500 with identity + DNS columns only, lookups through a bounded
 * pool. Never throws — a DNS outage costs this pass, not the discovery run.
 */

import { prisma } from "../../db.js";
import type { SyncLog } from "./syncLog.js";
import { reverseDnsForAssets } from "./dhcp/dnsOui.js";
import { getConfiguredResolver } from "../dnsService.js";
import { logEventsBatch, type LogEventInput } from "../eventLogService.js";
import { mapSettledWithConcurrency } from "../../utils/concurrency.js";
import { chunkArray } from "../../utils/chunk.js";
import { EXCLUDED_LIFECYCLE_STATUSES } from "../../utils/assetInvariants.js";
import { isValidIpAddress, detectIpVersion } from "../../utils/cidr.js";
import { isValidHostname } from "../../utils/probeTarget.js";
import { parseWorkloadSourceKind } from "../../utils/workloadSources.js";

/** The integration types whose discovery runs this pass. */
export const INTEGRATION_DNS_TYPES: ReadonlySet<string> = new Set([
  "activedirectory", "entraid", "azurearc", "unraid", "truenas", "proxmox",
]);

/** Fallback TTL (seconds) for a forward-lookup miss — Phase 8's PTR default. */
const DEFAULT_NEGATIVE_TTL_S = 3600;
/** Concurrent forward lookups — the assetLookupService fleet sweep's width. */
const FORWARD_LOOKUP_CONCURRENCY = 16;
const READ_CHUNK = 500;

/** Integration types whose assets are Fortinet-managed (rule 111(c) gate). */
const FORTINET_TYPES = new Set(["fortimanager", "fortigate"]);

export interface DnsPassAsset {
  id: string;
  ipAddress: string | null;
  hostname: string | null;
  dnsName: string | null;
  dnsNameFetchedAt: Date | string | null;
  dnsNameTtl: number | null;
  status: string;
  ipOverride: string | null;
  ipBlankPinned: boolean | null;
  primaryAddressIp: string | null;
  discoveredByIntegration?: { type: string } | null;
}

export interface ForwardCandidate {
  asset: DnsPassAsset;
  name: string;
}

/** The name a forward lookup should ask for, or null when there is no usable one. */
export function forwardLookupName(a: Pick<DnsPassAsset, "dnsName" | "hostname">): string | null {
  for (const raw of [a.dnsName, a.hostname]) {
    const v = (raw ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (v && !isValidIpAddress(v) && isValidHostname(v)) return v;
  }
  return null;
}

/**
 * Which IP-less assets the forward fill may look up (pure). `containerOnly`
 * is the set of asset ids whose only sources from this integration are
 * container kinds.
 */
export function pickForwardCandidates(
  assets: readonly DnsPassAsset[],
  containerOnly: ReadonlySet<string>,
  nowMs: number,
): ForwardCandidate[] {
  const out: ForwardCandidate[] = [];
  for (const a of assets) {
    if (a.ipAddress) continue;
    if ((EXCLUDED_LIFECYCLE_STATUSES as string[]).includes(a.status)) continue;
    if (a.ipOverride || a.ipBlankPinned || a.primaryAddressIp) continue;
    if (a.discoveredByIntegration && FORTINET_TYPES.has(a.discoveredByIntegration.type)) continue;
    if (containerOnly.has(a.id)) continue;
    if (a.dnsNameFetchedAt) {
      const fetched = new Date(a.dnsNameFetchedAt).getTime();
      const ttlMs = (a.dnsNameTtl ?? DEFAULT_NEGATIVE_TTL_S) * 1000;
      if (nowMs - fetched <= ttlMs) continue;
    }
    const name = forwardLookupName(a);
    if (name) out.push({ asset: a, name });
  }
  return out;
}

/** The first IPv4 answer of a forward lookup, or null (rule 126: IPv4 is the polled family). */
export function firstIpv4(records: ReadonlyArray<{ address: string }>): string | null {
  for (const r of records) {
    const v = (r?.address ?? "").trim();
    if (v && isValidIpAddress(v) && detectIpVersion(v) === "v4") return v;
  }
  return null;
}

/**
 * Split resolved answers into the ones that may be written and the ones that
 * collide (pure): an address another live asset already holds, or one two
 * candidates both resolved to, is never written.
 */
export function partitionResolved(
  resolved: ReadonlyArray<{ assetId: string; ip: string }>,
  heldByOthers: ReadonlySet<string>,
): { write: Array<{ assetId: string; ip: string }>; collided: Array<{ assetId: string; ip: string }> } {
  const counts = new Map<string, number>();
  for (const r of resolved) counts.set(r.ip, (counts.get(r.ip) ?? 0) + 1);
  const write: Array<{ assetId: string; ip: string }> = [];
  const collided: Array<{ assetId: string; ip: string }> = [];
  for (const r of resolved) {
    if (heldByOthers.has(r.ip) || (counts.get(r.ip) ?? 0) > 1) collided.push(r);
    else write.push(r);
  }
  return { write, collided };
}

export interface IntegrationDnsResult {
  ptrResolved: number;
  forwardFilled: number;
  forwardMissed: number;
  forwardCollided: number;
}

async function loadIntegrationAssets(integrationId: string): Promise<{ assets: DnsPassAsset[]; containerOnly: Set<string> }> {
  const rows = await prisma.assetSource.findMany({
    where: { integrationId },
    select: { assetId: true, sourceKind: true },
  });
  const nonContainer = new Set<string>();
  const all = new Set<string>();
  for (const r of rows) {
    all.add(r.assetId);
    if (parseWorkloadSourceKind(r.sourceKind)?.role !== "container") nonContainer.add(r.assetId);
  }
  const containerOnly = new Set([...all].filter((id) => !nonContainer.has(id)));
  const assets: DnsPassAsset[] = [];
  for (const chunk of chunkArray([...all], READ_CHUNK)) {
    assets.push(...(await prisma.asset.findMany({
      where: { id: { in: chunk }, status: { notIn: EXCLUDED_LIFECYCLE_STATUSES } },
      select: {
        id: true, ipAddress: true, hostname: true, dnsName: true, dnsNameFetchedAt: true, dnsNameTtl: true,
        status: true, ipOverride: true, ipBlankPinned: true, primaryAddressIp: true,
        discoveredByIntegration: { select: { type: true } },
      },
    })) as DnsPassAsset[]);
  }
  return { assets, containerOnly };
}

/** The forward fill: look up, drop collisions, write, negative-cache the misses. */
async function forwardFill(
  candidates: ForwardCandidate[],
  syncLog: SyncLog,
  actor: string | undefined,
): Promise<Omit<IntegrationDnsResult, "ptrResolved">> {
  const out = { forwardFilled: 0, forwardMissed: 0, forwardCollided: 0 };
  if (candidates.length === 0) return out;
  syncLog("info", `Forward DNS: resolving ${candidates.length} asset name(s) with no address`);
  const resolver = await getConfiguredResolver();
  const stamp = new Date();
  const settled = await mapSettledWithConcurrency(candidates, FORWARD_LOOKUP_CONCURRENCY, async (c) => ({
    c, ip: firstIpv4(await resolver.lookup(c.name)),
  }));

  const resolved: Array<{ assetId: string; ip: string }> = [];
  const byId = new Map(candidates.map((c) => [c.asset.id, c]));
  const missedIds: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.ip) resolved.push({ assetId: r.value.c.asset.id, ip: r.value.ip });
    else missedIds.push(candidates[i]!.asset.id);
  });

  const ips = [...new Set(resolved.map((r) => r.ip))];
  const held = new Set<string>();
  for (const chunk of chunkArray(ips, READ_CHUNK)) {
    const rows = await prisma.asset.findMany({
      where: { ipAddress: { in: chunk }, status: { notIn: EXCLUDED_LIFECYCLE_STATUSES } },
      select: { ipAddress: true },
    });
    for (const row of rows) if (row.ipAddress) held.add(row.ipAddress);
  }
  const { write, collided } = partitionResolved(resolved, held);

  // One write per asset: the db.ts extension runs the pin guards and the
  // dns_resolved reservation reconcile (rule 11) on each.
  const writes = await mapSettledWithConcurrency(write, FORWARD_LOOKUP_CONCURRENCY, (w) =>
    prisma.asset.update({ where: { id: w.assetId }, data: { ipAddress: w.ip, ipSource: "dns", dnsNameFetchedAt: stamp, dnsNameTtl: null } }),
  );
  const events: LogEventInput[] = [];
  writes.forEach((r, i) => {
    const w = write[i]!;
    if (r.status !== "fulfilled") { missedIds.push(w.assetId); return; }
    out.forwardFilled++;
    const c = byId.get(w.assetId)!;
    events.push({
      action: "asset.dns.forward_resolved", resourceType: "asset", resourceId: w.assetId,
      resourceName: c.asset.hostname || c.asset.dnsName || undefined, actor,
      message: `Forward DNS: ${c.name} → ${w.ip} (discovery)`,
      details: { name: c.name, ipAddress: w.ip, ipSource: "dns" },
    });
  });
  await logEventsBatch(events);

  // Misses AND collisions are negative-cached: a collision is stale DNS until
  // the record or the other asset moves, and asking again next run changes nothing.
  const stampIds = [...missedIds, ...collided.map((c) => c.assetId)];
  for (const chunk of chunkArray(stampIds, 1000)) {
    try {
      await prisma.asset.updateMany({ where: { id: { in: chunk } }, data: { dnsNameFetchedAt: stamp, dnsNameTtl: null } });
    } catch (err: any) {
      syncLog("error", `Forward DNS: failed to record the lookup time on ${chunk.length} asset(s): ${err?.message || "Unknown error"}`);
    }
  }
  out.forwardMissed = missedIds.length;
  out.forwardCollided = collided.length;
  if (collided.length > 0) {
    syncLog("warning", `Forward DNS: ${collided.length} answer(s) not written — the address is already another asset's (${collided.slice(0, 5).map((c) => `${byId.get(c.assetId)!.name} → ${c.ip}`).join(", ")}${collided.length > 5 ? ", …" : ""})`);
  }
  syncLog("info", `Forward DNS: filled ${out.forwardFilled} of ${candidates.length} address(es)`);
  return out;
}

/** Run the pass for one integration's assets. Never throws. */
export async function runIntegrationDnsPass(
  integrationId: string,
  syncLog: SyncLog,
  actor: string | undefined,
): Promise<IntegrationDnsResult> {
  const result: IntegrationDnsResult = { ptrResolved: 0, forwardFilled: 0, forwardMissed: 0, forwardCollided: 0 };
  try {
    const { assets, containerOnly } = await loadIntegrationAssets(integrationId);
    const candidates = pickForwardCandidates(assets, containerOnly, Date.now());
    Object.assign(result, await forwardFill(candidates, syncLog, actor));
    // PTR after the fill, over the rows that had an address before it: a
    // freshly filled row was just stamped and its PTR waits for the next run.
    result.ptrResolved = await reverseDnsForAssets(assets.filter((a) => a.ipAddress), syncLog);
  } catch (err: any) {
    syncLog("error", `DNS pass failed: ${err?.message || "Unknown error"}`);
  }
  return result;
}
