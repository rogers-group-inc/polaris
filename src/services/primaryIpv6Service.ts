/**
 * src/services/primaryIpv6Service.ts — an asset's primary IPv6 (business rule 127).
 *
 * `Asset.ipv6Address` is the IPv6 shown beside the IPv4 on the asset's
 * General tab, and the address an asset with NO IPv4 is polled on
 * (utils/assetDialAddress.ts). It is chosen two ways:
 *
 *   - automatically: `reconcilePrimaryIpv6` picks the best of the asset's IPv6
 *     address-list rows (AssetAssociatedIp — interface IPv6 from rule 126) by
 *     the address-confidence evidence score (rule 103), newest sighting on a
 *     tie, and clears it when the asset no longer has one;
 *   - by an operator: `pinPrimaryIpv6` sets it and marks it pinned, and the
 *     reconcile leaves a pinned value alone until `unpinPrimaryIpv6`.
 *
 * While IPv6 is off for the install (services/ipv6GateService.ts) nothing is
 * chosen: the reconcile clears every UNPINNED value (an operator's pin is kept
 * — it is their data, and it comes back into force when IPv6 does), and a pin
 * is refused.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { canonicalIp, isIpamIpv6Address, isIpv6Address } from "../utils/cidr.js";
import { logEvent, logEventsBatch, type LogEventInput } from "./eventLogService.js";
import { buildAddressConfidence } from "./addressConfidenceService.js";
import { ipv6Enabled } from "./ipv6GateService.js";

/** Assets scored per confidence batch. */
const BATCH = 200;

export interface Ipv6Candidate {
  ip: string;
  evidenceScore: number;
  lastSeen: Date;
}

/**
 * The best candidate, or null: highest evidence score, then the most recent
 * sighting, then the lexically smallest address (a stable tie-break, so two
 * equal addresses do not swap on every run). Pure — exported for tests.
 */
export function pickPrimaryIpv6(candidates: readonly Ipv6Candidate[]): string | null {
  let best: Ipv6Candidate | null = null;
  for (const c of candidates) {
    if (!best
      || c.evidenceScore > best.evidenceScore
      || (c.evidenceScore === best.evidenceScore && c.lastSeen.getTime() > best.lastSeen.getTime())
      || (c.evidenceScore === best.evidenceScore && c.lastSeen.getTime() === best.lastSeen.getTime() && c.ip < best.ip)) {
      best = c;
    }
  }
  return best?.ip ?? null;
}

/**
 * Re-choose every unpinned asset's primary IPv6. One read for the fleet's IPv6
 * address-list rows, confidence scored per BATCH assets, and a write only for
 * an asset whose choice changed — the steady state writes nothing.
 */
export async function reconcilePrimaryIpv6(now: Date = new Date()): Promise<{ checked: number; changed: number; cleared: number }> {
  if (!ipv6Enabled()) {
    const res = await prisma.asset.updateMany({
      where: { ipv6Pinned: false, ipv6Address: { not: null } },
      data: { ipv6Address: null },
    });
    return { checked: 0, changed: 0, cleared: res.count };
  }

  const rows = await prisma.assetAssociatedIp.findMany({
    where: { ip: { contains: ":" } },
    select: { assetId: true, ip: true, lastSeen: true },
  });
  const byAsset = new Map<string, Array<{ ip: string; lastSeen: Date }>>();
  for (const r of rows) {
    if (!isIpamIpv6Address(r.ip)) continue;
    const list = byAsset.get(r.assetId) ?? [];
    list.push({ ip: canonicalIp(r.ip) ?? r.ip, lastSeen: r.lastSeen });
    byAsset.set(r.assetId, list);
  }
  // Assets holding an automatic value whose rows are gone get cleared too.
  const holders = await prisma.asset.findMany({
    where: { OR: [{ id: { in: [...byAsset.keys()] } }, { ipv6Address: { not: null } }], ipv6Pinned: false },
    select: { id: true, hostname: true, ipv6Address: true },
  });

  let changed = 0;
  let cleared = 0;
  const events: LogEventInput[] = [];
  for (let i = 0; i < holders.length; i += BATCH) {
    const batch = holders.slice(i, i + BATCH);
    const withRows = batch.filter((a) => byAsset.has(a.id)).map((a) => a.id);
    const scores = withRows.length > 0 ? await buildAddressConfidence(withRows, { now }) : new Map();
    const updates: Array<{ id: string; ipv6Address: string | null }> = [];
    for (const a of batch) {
      const candidates = (byAsset.get(a.id) ?? []).map((c) => ({
        ...c,
        evidenceScore: scores.get(a.id)?.get(c.ip)?.evidenceScore ?? 0,
      }));
      const next = pickPrimaryIpv6(candidates);
      if (next === (a.ipv6Address ?? null)) continue;
      updates.push({ id: a.id, ipv6Address: next });
      if (next === null) cleared++;
      else changed++;
      events.push({
        action: "asset.primary_ipv6.changed",
        resourceType: "asset",
        resourceId: a.id,
        resourceName: a.hostname || next || a.ipv6Address || a.id,
        actor: "system",
        level: "info",
        message: next
          ? `Primary IPv6 of "${a.hostname || a.id}" is now ${next}${a.ipv6Address ? ` (was ${a.ipv6Address})` : ""}`
          : `Primary IPv6 of "${a.hostname || a.id}" cleared — the asset no longer reports ${a.ipv6Address}`,
        details: { ipv6Address: next, previous: a.ipv6Address ?? null },
      });
    }
    if (updates.length > 0) {
      await prisma.$transaction(updates.map((u) => prisma.asset.update({ where: { id: u.id }, data: { ipv6Address: u.ipv6Address } })));
    }
  }
  if (events.length > 0) await logEventsBatch(events);
  return { checked: holders.length, changed, cleared };
}

/** An operator's pin. Refused while IPv6 is off. Audited. */
export async function pinPrimaryIpv6(input: { assetId: string; ip: string; actor: string }): Promise<{ assetId: string; ipv6Address: string }> {
  if (!ipv6Enabled()) throw new AppError(409, "IPv6 is off for this Polaris install (Server Settings → IPv6), so no primary IPv6 can be set");
  const raw = input.ip.trim();
  if (!isIpv6Address(raw)) throw new AppError(400, `${raw} is not an IPv6 address`);
  const ip = canonicalIp(raw)!;
  if (!isIpamIpv6Address(ip)) throw new AppError(400, `${ip} cannot be a device's address (loopback, link-local or multicast)`);
  const asset = await prisma.asset.findUnique({ where: { id: input.assetId }, select: { id: true, hostname: true, ipv6Address: true } });
  if (!asset) throw new AppError(404, "Asset not found");
  await prisma.asset.update({
    where: { id: asset.id },
    data: { ipv6Address: ip, ipv6Pinned: true, ipv6PinnedAt: new Date(), ipv6PinnedBy: input.actor },
  });
  logEvent({
    action: "asset.primary_ipv6.pinned",
    resourceType: "asset",
    resourceId: asset.id,
    resourceName: asset.hostname || ip,
    actor: input.actor,
    message: `Primary IPv6 of "${asset.hostname || asset.id}" pinned to ${ip}` +
      (asset.ipv6Address && asset.ipv6Address !== ip ? ` (was ${asset.ipv6Address})` : ""),
    details: { ipv6Address: ip, previous: asset.ipv6Address ?? null },
  });
  return { assetId: asset.id, ipv6Address: ip };
}

/**
 * Drop the pin and re-choose straight away (the automatic pick, or null), so
 * the panel shows the outcome rather than a stale pinned value until the job.
 */
export async function unpinPrimaryIpv6(input: { assetId: string; actor: string }): Promise<{ ipv6Address: string | null }> {
  const asset = await prisma.asset.findUnique({ where: { id: input.assetId }, select: { id: true, hostname: true, ipv6Address: true, ipv6Pinned: true } });
  if (!asset) throw new AppError(404, "Asset not found");
  if (!asset.ipv6Pinned) return { ipv6Address: asset.ipv6Address ?? null };
  let next: string | null = null;
  if (ipv6Enabled()) {
    const rows = await prisma.assetAssociatedIp.findMany({
      where: { assetId: asset.id, ip: { contains: ":" } },
      select: { ip: true, lastSeen: true },
    });
    const valid = rows.filter((r) => isIpamIpv6Address(r.ip)).map((r) => ({ ip: canonicalIp(r.ip) ?? r.ip, lastSeen: r.lastSeen }));
    const scores = valid.length > 0 ? (await buildAddressConfidence([asset.id])).get(asset.id) : undefined;
    next = pickPrimaryIpv6(valid.map((c) => ({ ...c, evidenceScore: scores?.get(c.ip)?.evidenceScore ?? 0 })));
  }
  await prisma.asset.update({
    where: { id: asset.id },
    data: { ipv6Address: next, ipv6Pinned: false, ipv6PinnedAt: null, ipv6PinnedBy: null },
  });
  logEvent({
    action: "asset.primary_ipv6.unpinned",
    resourceType: "asset",
    resourceId: asset.id,
    resourceName: asset.hostname || asset.ipv6Address || asset.id,
    actor: input.actor,
    message: `Primary IPv6 pin on "${asset.hostname || asset.id}" removed` +
      (next ? ` — now ${next}, chosen automatically` : " — no IPv6 to choose from"),
    details: { previous: asset.ipv6Address ?? null, ipv6Address: next },
  });
  return { ipv6Address: next };
}
