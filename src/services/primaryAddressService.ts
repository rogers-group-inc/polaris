/**
 * src/services/primaryAddressService.ts — the operator-pinned primary address
 * (business rule 102).
 *
 * An asset's address list is its AssetAssociatedIp rows: one per IP, each
 * bound to a MAC, so a card with secondary addresses has several. Discovery
 * picks which address the asset is monitored on (business rule 101); an
 * operator can override that by pinning ONE (MAC, IP) pair from the list.
 *
 *   pin    — Asset.primaryAddressMac / primaryAddressIp, and ipAddress set to
 *            the pinned IP in the same write. Clears the typed IP override and
 *            the blank pin (the three are mutually exclusive) and closes any
 *            pending ip-override conflict.
 *   unpin  — clears the pin and re-projects ipAddress from the asset's
 *            sources, as "Revert to discovered IP" does for the typed pin.
 *
 * Enforcement lives in the src/db.ts guard (`applyPrimaryAddressPin` in
 * utils/assetInvariants.ts): a later write staging ipAddress is rewritten back
 * to the pinned IP — or, when the pinned IP has gone quiet and its card has
 * exactly one recent address, follows the card to it. `handlePrimaryAddressFollowed`
 * audits that move. Asset.macAddress (the identity MAC) is never moved by a pin.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { normalizeMacOrNull } from "../utils/mac.js";
import { projectAssetFromSources } from "../utils/assetProjection.js";
import { logEvent } from "./eventLogService.js";
import { resolvePendingIpOverrideConflicts } from "./ipOverrideService.js";
import { buildAddressConfidence } from "./addressConfidenceService.js";
import { pinReleaseVerdict } from "../utils/addressConfidence.js";

const INFRA_TYPES = new Set(["firewall", "switch", "access_point"]);

/** The data that clears a primary-address pin — for routes that set another pin. */
export const CLEAR_PRIMARY_ADDRESS_PIN = {
  primaryAddressMac: null,
  primaryAddressIp: null,
  primaryAddressPinnedAt: null,
  primaryAddressPinnedBy: null,
} as const;

export interface PinResult {
  assetId: string;
  mac: string;
  ip: string;
}

export async function pinPrimaryAddress(input: {
  assetId: string;
  mac: string;
  ip: string;
  actor: string;
}): Promise<PinResult> {
  const mac = normalizeMacOrNull(input.mac);
  const ip = input.ip.trim();
  if (!mac) throw new AppError(400, "Not a valid MAC address");
  if (!ip) throw new AppError(400, "An IP address is required");

  const asset = await prisma.asset.findUnique({
    where: { id: input.assetId },
    select: {
      id: true, hostname: true, assetType: true, fortinetTopology: true,
      ipAddress: true, ipOverride: true, ipBlankPinned: true,
      primaryAddressMac: true, primaryAddressIp: true,
    },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  // Fortinet infrastructure is monitored on its management IP, which its own
  // discovery loop owns.
  if (INFRA_TYPES.has(asset.assetType) && asset.fortinetTopology != null) {
    throw new AppError(409, "A FortiGate, FortiSwitch or FortiAP is monitored on its management IP; its primary address can't be pinned");
  }
  const row = await prisma.assetAssociatedIp.findFirst({
    where: { assetId: asset.id, ip, mac },
    select: { id: true },
  });
  if (!row) {
    throw new AppError(409, `${ip} is not an address of ${mac} on this asset — pick a pair from its address list, or type the address in Edit`);
  }

  await prisma.asset.update({
    where: { id: asset.id },
    data: {
      primaryAddressMac: mac,
      primaryAddressIp: ip,
      primaryAddressPinnedAt: new Date(),
      primaryAddressPinnedBy: input.actor,
      ipAddress: ip,
      ipSource: "pinned",
      ipOverride: null,
      ipBlankPinned: false,
      ipCleared: null,
    },
  });
  const resolved = (asset.ipOverride || asset.ipBlankPinned)
    ? await resolvePendingIpOverrideConflicts(asset.id, input.actor)
    : 0;

  logEvent({
    action: "asset.primary_address.pinned",
    resourceType: "asset",
    resourceId: asset.id,
    resourceName: asset.hostname || ip,
    actor: input.actor,
    message: `Primary address of "${asset.hostname || asset.id}" pinned to ${ip} on ${mac}` +
      (asset.ipAddress && asset.ipAddress !== ip ? ` (was ${asset.ipAddress})` : ""),
    details: {
      mac, ipAddress: ip, previousIp: asset.ipAddress,
      ...(asset.primaryAddressMac ? { previousPin: { mac: asset.primaryAddressMac, ip: asset.primaryAddressIp } } : {}),
      ...(asset.ipOverride ? { releasedIpOverride: asset.ipOverride } : {}),
      ...(asset.ipBlankPinned ? { releasedBlankPin: true } : {}),
      ...(resolved > 0 ? { autoResolvedConflicts: resolved } : {}),
    },
  });
  return { assetId: asset.id, mac, ip };
}

export async function unpinPrimaryAddress(input: { assetId: string; actor: string }): Promise<{ ipAddress: string | null }> {
  const asset = await prisma.asset.findUnique({
    where: { id: input.assetId },
    select: {
      id: true, hostname: true, ipAddress: true, primaryAddressMac: true, primaryAddressIp: true,
      associatedIpRows: { select: { ip: true, device: true } },
    },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  if (!asset.primaryAddressMac) return { ipAddress: asset.ipAddress };

  // The address list decides (business rule 103(b)): the listed address with
  // the highest network-evidence score — the score the operator saw on the
  // chips, minus their own pin. Re-projecting from the AssetSource blobs
  // instead could land on an address that is not on the list at all: a source
  // keeps the IP from its last sync after the operator removed that MAC and
  // its addresses (prod 2026-10-11).
  const pick = await bestListedAddress(asset.id, asset.associatedIpRows.map((r) => r.ip), asset.ipAddress);
  let nextIp: string | null;
  let nextSource: string | null;
  if (pick) {
    nextIp = pick.ip;
    nextSource = asset.associatedIpRows.find((r) => r.ip === pick.ip)?.device || "discovery";
  } else {
    // An empty list (nothing discovered, nothing typed) falls back to the
    // projection; no source with an opinion keeps the address it has.
    const sources = await prisma.assetSource.findMany({
      where: { assetId: asset.id },
      select: { sourceKind: true, inferred: true, observed: true, lastSeen: true },
    });
    const { projected, provenance } = projectAssetFromSources(
      sources.map((s) => ({
        sourceKind: s.sourceKind,
        inferred: s.inferred,
        observed: s.observed as Record<string, unknown> | null,
        lastSeen: s.lastSeen,
      })),
    );
    nextIp = projected.ipAddress ?? asset.ipAddress;
    nextSource = projected.ipAddress ? (provenance.ipAddress ?? "discovery") : (nextIp ? "manual" : null);
  }
  await prisma.asset.update({
    where: { id: asset.id },
    data: {
      ...CLEAR_PRIMARY_ADDRESS_PIN,
      ipAddress: nextIp,
      ipSource: nextSource,
    },
  });
  logEvent({
    action: "asset.primary_address.unpinned",
    resourceType: "asset",
    resourceId: asset.id,
    resourceName: asset.hostname || asset.primaryAddressIp || asset.id,
    actor: input.actor,
    message: `Primary address pin on "${asset.hostname || asset.id}" released (was ${asset.primaryAddressIp} on ${asset.primaryAddressMac})`,
    details: {
      mac: asset.primaryAddressMac, ipAddress: asset.primaryAddressIp, nextIp,
      ...(pick ? { chosenBy: "address-confidence", evidenceScore: pick.evidenceScore } : { chosenBy: "projection" }),
    },
  });
  return { ipAddress: nextIp };
}

/**
 * The listed address with the highest network-evidence score (no operator
 * weight; polling counts — the address monitoring has relied on keeps that
 * credit). Ties keep the current address, then the lowest IP string, so a
 * re-run picks the same one. Null when the list is empty.
 */
async function bestListedAddress(
  assetId: string,
  listed: string[],
  current: string | null,
): Promise<{ ip: string; evidenceScore: number } | null> {
  const candidates = [...new Set(listed)];
  if (candidates.length === 0) return null;
  const scores = (await buildAddressConfidence([assetId])).get(assetId);
  let best: { ip: string; evidenceScore: number } | null = null;
  for (const ip of candidates.sort()) {
    const s = scores?.get(ip)?.evidenceScore ?? 0;
    if (!best || s > best.evidenceScore || (s === best.evidenceScore && ip === current)) {
      best = { ip, evidenceScore: s };
    }
  }
  return best;
}

/** Pinned assets scored per batch by the release sweep. */
const RELEASE_BATCH = 200;

/**
 * Business rule 103(a): release every pin the network has come to back on its
 * own — the pinned address's discovery score (no operator weight, no polling)
 * reaches the warn line and beats every other address the asset has. The
 * address stays where it is; only the pin goes, so discovery owns it again.
 * Pinned assets are few, so this reads them all and scores them in batches.
 */
export async function releaseConfirmedPins(now: Date = new Date()): Promise<{ checked: number; released: number }> {
  const pinned = await prisma.asset.findMany({
    where: { primaryAddressIp: { not: null }, primaryAddressMac: { not: null } },
    select: { id: true, hostname: true, primaryAddressIp: true, primaryAddressMac: true },
  });
  let released = 0;
  for (let i = 0; i < pinned.length; i += RELEASE_BATCH) {
    const batch = pinned.slice(i, i + RELEASE_BATCH);
    const scores = await buildAddressConfidence(batch.map((a) => a.id), { now });
    for (const a of batch) {
      const perIp = scores.get(a.id);
      if (!perIp || !a.primaryAddressIp) continue;
      const verdict = pinReleaseVerdict(a.primaryAddressIp, perIp);
      if (!verdict.release) continue;
      // Conditional on the pin still being the one we scored: an operator
      // re-pinning between the read and this write keeps their new pin.
      const strongest = perIp.get(a.primaryAddressIp)?.parts.find((p) => p.kind !== "operator" && p.kind !== "polling");
      const res = await prisma.asset.updateMany({
        where: { id: a.id, primaryAddressIp: a.primaryAddressIp, primaryAddressMac: a.primaryAddressMac },
        data: { ...CLEAR_PRIMARY_ADDRESS_PIN, ipSource: strongest?.device || "discovery" },
      });
      if (res.count === 0) continue;
      released++;
      logEvent({
        action: "asset.primary_address.released",
        resourceType: "asset",
        resourceId: a.id,
        resourceName: a.hostname || a.primaryAddressIp,
        actor: "system",
        message: `Primary address pin on "${a.hostname || a.id}" released — the network now backs ${a.primaryAddressIp} on its own ` +
          `(confidence ${verdict.pinnedScore}${verdict.bestOther ? `, next best ${verdict.bestOther.ip} at ${verdict.bestOther.score}` : ""})`,
        details: {
          ipAddress: a.primaryAddressIp, mac: a.primaryAddressMac,
          discoveryScore: verdict.pinnedScore, bestOther: verdict.bestOther,
        },
      });
    }
  }
  return { checked: pinned.length, released };
}

/**
 * The db.ts guard moved a pin to its card's new address (the pinned IP went
 * quiet and the card has exactly one recent address). Best-effort audit.
 */
export async function handlePrimaryAddressFollowed(assetId: string, fromIp: string, ip: string): Promise<void> {
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      select: { hostname: true, primaryAddressMac: true },
    });
    logEvent({
      action: "asset.primary_address.followed",
      resourceType: "asset",
      resourceId: assetId,
      resourceName: asset?.hostname || ip,
      actor: "system",
      message: `Pinned primary address of "${asset?.hostname || assetId}" moved from ${fromIp} to ${ip} — ` +
        `the pinned card${asset?.primaryAddressMac ? ` (${asset.primaryAddressMac})` : ""} reports only that address now`,
      details: { fromIp, ipAddress: ip, mac: asset?.primaryAddressMac ?? null },
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), assetId },
      "primary-address follow audit failed",
    );
  }
}
