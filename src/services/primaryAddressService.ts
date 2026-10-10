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
    select: { id: true, hostname: true, ipAddress: true, primaryAddressMac: true, primaryAddressIp: true },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  if (!asset.primaryAddressMac) return { ipAddress: asset.ipAddress };

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
  // No source with an opinion (a manually created asset) keeps the address it
  // has rather than blanking it.
  const nextIp = projected.ipAddress ?? asset.ipAddress;
  await prisma.asset.update({
    where: { id: asset.id },
    data: {
      ...CLEAR_PRIMARY_ADDRESS_PIN,
      ipAddress: nextIp,
      ipSource: projected.ipAddress ? (provenance.ipAddress ?? "discovery") : (nextIp ? "manual" : null),
    },
  });
  logEvent({
    action: "asset.primary_address.unpinned",
    resourceType: "asset",
    resourceId: asset.id,
    resourceName: asset.hostname || asset.primaryAddressIp || asset.id,
    actor: input.actor,
    message: `Primary address pin on "${asset.hostname || asset.id}" released (was ${asset.primaryAddressIp} on ${asset.primaryAddressMac})`,
    details: { mac: asset.primaryAddressMac, ipAddress: asset.primaryAddressIp, nextIp },
  });
  return { ipAddress: nextIp };
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
