/**
 * src/services/ipOverrideService.ts — operator IP override (Asset.ipOverride)
 * lifecycle around discovery writes.
 *
 * The pure decision lives in applyIpOverride (src/utils/assetInvariants.ts),
 * called from the Prisma extension in src/db.ts on every asset update/upsert
 * that stages `ipAddress` without touching `ipOverride`. This service owns
 * the follow-up side effects, invoked fire-and-forget from db.ts AFTER the
 * guarded write lands:
 *
 *   released   → discovery converged on the overridden IP; the pin was
 *                cleared in the same write. Auto-resolve any pending
 *                ip-override Conflict for the asset (its proposal is moot)
 *                and stamp an `asset.ip_override.released` Event.
 *
 *   reasserted → discovery proposed a DIFFERENT IP; the write was rewritten
 *                back to the override. Raise (or refresh) ONE pending
 *                Conflict per asset — entityType="asset",
 *                proposedAssetFields.collisionReason="ip-override" — for the
 *                operator to resolve on the Conflicts tab:
 *                  accept → take the discovered IP + release the pin
 *                           (handled in src/api/routes/conflicts.ts)
 *                  reject → keep the override; the SAME discovered IP never
 *                           re-raises (a rejected row is the dedup marker),
 *                           but a NEW discovered IP does.
 *
 * Dedup model (per asset): at most one pending ip-override conflict — a
 * repeat sighting refreshes it (and re-points its proposal when the
 * discovered IP moved again); creation is skipped while the most recent
 * resolved ip-override conflict is a rejection of the same proposed IP.
 *
 * All entry points are best-effort: they run after the asset write already
 * landed and must never break it. Errors are logged and swallowed.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";

export const IP_OVERRIDE_COLLISION_REASON = "ip-override";

// Prisma JSON filter matching this feature's conflicts.
const IP_OVERRIDE_CONFLICT_WHERE = {
  entityType: "asset",
  proposedAssetFields: { path: ["collisionReason"], equals: IP_OVERRIDE_COLLISION_REASON },
};

/**
 * Discovery converged on the overridden IP and the pin was released in the
 * guarded write. Close out any pending ip-override conflict (its proposal is
 * stale — either it proposed this same IP, now applied, or an older IP the
 * device has since moved off) and audit the auto-release.
 */
export async function handleIpOverrideReleased(assetId: string, ip: string): Promise<void> {
  try {
    const resolved = await resolvePendingIpOverrideConflicts(assetId, "auto");
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      select: { hostname: true },
    });
    logEvent({
      action: "asset.ip_override.released",
      resourceType: "asset",
      resourceId: assetId,
      resourceName: asset?.hostname || ip,
      actor: "system",
      message: `IP override on "${asset?.hostname || assetId}" released — discovery reports the same address (${ip})`,
      details: resolved > 0 ? { autoResolvedConflicts: resolved } : undefined,
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), assetId },
      "ip-override release follow-up failed",
    );
  }
}

/**
 * Business rule 40(j): discovery staged an address on a row whose address an
 * operator had blanked from a duplicate-IP conflict card, and the db.ts guard
 * let it through — either a NEW address ("filled") or the blanked one once
 * nothing else held it ("returned"). The hold was released in that write;
 * this audits it.
 */
export async function handleIpClearedReleased(
  assetId: string,
  ip: string,
  how: "filled" | "returned",
): Promise<void> {
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      select: { hostname: true },
    });
    const label = asset?.hostname || assetId;
    logEvent({
      action: "asset.ip_cleared.filled",
      resourceType: "asset",
      resourceId: assetId,
      resourceName: asset?.hostname || ip,
      actor: "system",
      message: how === "filled"
        ? `Blank IP address on "${label}" filled by discovery — it now reports ${ip}`
        : `Blank IP address on "${label}" filled by discovery — ${ip} is no longer held by another asset`,
      details: { ipAddress: ip, how },
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), assetId },
      "ip-cleared release follow-up failed",
    );
  }
}

/**
 * Discovery proposed a different IP than the override; the write was
 * re-asserted back to the pin. Raise or refresh the asset's single pending
 * ip-override conflict.
 *
 * `ipSource` is the provenance string the writer staged alongside the IP
 * ("fortimanager", "fortigate", "agent", ...) — surfaced on the conflict
 * card so the operator knows which pathway disagrees.
 */
export async function raiseIpOverrideConflict(
  assetId: string,
  discoveredIp: string,
  ipSource?: string | null,
): Promise<void> {
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      select: {
        id: true,
        hostname: true,
        ipAddress: true,
        ipOverride: true,
        ipSource: true,
        discoveredByIntegrationId: true,
      },
    });
    // Race guards: the override may have been cleared (or moved onto the
    // discovered IP) between the guarded write and this follow-up.
    if (!asset?.ipOverride) return;
    if (asset.ipOverride === discoveredIp) return;

    const proposedAssetFields = {
      collisionReason: IP_OVERRIDE_COLLISION_REASON,
      hostname: asset.hostname ?? null, // conflict-queue widget subtitle
      ipAddress: discoveredIp,
      ipSource: ipSource || null,
      overrideIp: asset.ipOverride,
    };
    const existingAssetSnapshot = {
      hostname: asset.hostname ?? null,
      ipAddress: asset.ipAddress ?? null,
      ipOverride: asset.ipOverride,
      ipSource: asset.ipSource ?? null,
    };

    const prior = await prisma.conflict.findMany({
      where: { ...IP_OVERRIDE_CONFLICT_WHERE, assetId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, status: true, proposedAssetFields: true, resolvedAt: true },
    });

    const pending = prior.find((c) => c.status === "pending");
    if (pending) {
      // Refresh the open conflict — re-point the proposal when the
      // discovered IP moved again, and keep the existing-side snapshot
      // current while it's unresolved (same policy as the discovery asset
      // conflicts).
      await prisma.conflict.update({
        where: { id: pending.id },
        data: { proposedAssetFields, existingAssetSnapshot },
      });
      return;
    }

    // Operator already rejected this exact proposal — don't nag every cycle.
    const lastResolved = prior.find((c) => c.status !== "pending");
    if (lastResolved?.status === "rejected") {
      const lastProposed = lastResolved.proposedAssetFields as Record<string, unknown> | null;
      if (lastProposed?.ipAddress === discoveredIp) return;
    }

    await prisma.conflict.create({
      data: {
        entityType: "asset",
        assetId,
        integrationId: asset.discoveredByIntegrationId ?? null,
        conflictFields: ["ipAddress"],
        proposedAssetFields,
        existingAssetSnapshot,
      },
    });
    logEvent({
      action: "conflict.detected",
      resourceType: "asset",
      resourceId: assetId,
      resourceName: asset.hostname || asset.ipOverride,
      actor: "system",
      message: `IP override conflict on "${asset.hostname || assetId}" — discovery reports ${discoveredIp}${ipSource ? ` (via ${ipSource})` : ""} but the address is pinned to ${asset.ipOverride}`,
      details: { collisionReason: IP_OVERRIDE_COLLISION_REASON, discoveredIp, overrideIp: asset.ipOverride, ipSource: ipSource || null },
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), assetId, discoveredIp },
      "ip-override conflict raise failed",
    );
  }
}

/**
 * Close every pending ip-override conflict for an asset. Used when the pin
 * stops existing in its conflicted form: discovery converged (release path),
 * or the operator set a new override / cleared it / edited the IP via the
 * asset form (the PUT route calls this with the operator as actor).
 *
 * Follows the auto-resolution convention (resolveStaleReservationConflicts):
 * status="rejected" — the existing value was kept as of resolution time.
 * Returns the number of conflicts closed.
 */
export async function resolvePendingIpOverrideConflicts(
  assetId: string,
  resolvedBy: string,
): Promise<number> {
  const result = await prisma.conflict.updateMany({
    where: { ...IP_OVERRIDE_CONFLICT_WHERE, assetId, status: "pending" },
    data: { status: "rejected", resolvedBy, resolvedAt: new Date() },
  });
  return result.count;
}
