/**
 * src/services/projectionDriftService.ts
 *
 * Phase 3b.0 — shadow projection drift detection. After every successful
 * AssetSource upsert (which itself follows a successful Asset write), this
 * service computes what `projectAssetFromSources` would say about the
 * asset's discovery-owned fields and compares against the values currently
 * on the Asset row. Disagreements are logged to the structured logger.
 *
 * The goal of this phase is *observability*, not behavior change — find out
 * where the projection rules diverge from the legacy integration merge
 * logic before committing to writing the projection in Phase 3b.1.
 *
 * Drift output is logged via pino (logger.info with `event: "asset.projection.drift"`)
 * rather than written to the Event audit table; volume can be high during a
 * full discovery sweep and we don't want to pollute the 7-day retained
 * audit log. Operators grep their app logs to see drift.
 *
 * "Drift" is asymmetric:
 *   - projection has value X, asset has value Y, X != Y → drift logged
 *   - projection has value X, asset is null/empty            → drift logged
 *     (asset is missing data the projection has)
 *   - projection is null (no source has an opinion)         → NOT drift
 *     (treats projection silence as no-comment, never as a disagreement)
 *
 * Best-effort: any error inside the detector is swallowed via logger.warn
 * so a drift-detection bug can never break the underlying Asset write.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import {
  projectAssetFromSources,
  type ProjectedAsset,
} from "../utils/assetProjection.js";

// Asset fields the projection layer owns. Must match keys on ProjectedAsset.
const PROJECTED_FIELDS: (keyof ProjectedAsset)[] = [
  "hostname",
  "serialNumber",
  "manufacturer",
  "model",
  "os",
  "osVersion",
  "learnedLocation",
  "ipAddress",
  "latitude",
  "longitude",
];

interface DriftEntry {
  field: keyof ProjectedAsset;
  projected: string | number | null;
  current: string | number | null;
  winningSource: string | null;
}

/**
 * Compare the projection from sources against the asset's current values
 * and log any disagreements. `integrationKind` is included in the log
 * payload so operators can filter drift by which integration's write
 * triggered the check.
 */
export async function detectAndLogDrift(
  assetId: string,
  integrationKind: string,
): Promise<void> {
  try {
    const [asset, sources] = await Promise.all([
      prisma.asset.findUnique({
        where: { id: assetId },
        select: {
          id: true,
          hostname: true,
          hostnameOverride: true,
          ipOverride: true,
          ipBlankPinned: true,
          serialNumber: true,
          manufacturer: true,
          model: true,
          os: true,
          osVersion: true,
          learnedLocation: true,
          ipAddress: true,
          latitude: true,
          longitude: true,
          coordSource: true,
        },
      }),
      prisma.assetSource.findMany({
        where: { assetId },
        select: { sourceKind: true, inferred: true, observed: true, lastSeen: true },
      }),
    ]);

    if (!asset) return; // Asset deleted between write and drift check — fine.

    const { projected, provenance } = projectAssetFromSources(
      sources.map((s) => ({
        sourceKind: s.sourceKind,
        inferred: s.inferred,
        observed: s.observed as Record<string, unknown> | null,
        lastSeen: s.lastSeen,
      })),
    );

    const drifts: DriftEntry[] = [];
    for (const field of PROJECTED_FIELDS) {
      // Operator-pinned manual coordinates deliberately diverge from the
      // projection (discovery skips its coord write while the pin is set) —
      // not drift, don't log it every cycle.
      if ((field === "latitude" || field === "longitude") && asset.coordSource === "manual") continue;
      // Same for the operator hostname pin — the db.ts guard keeps the row
      // diverged from the projection on purpose; logging it every cycle is
      // pure noise.
      if (field === "hostname" && asset.hostnameOverride) continue;
      // Same for the operator IP pin — while it's set, the divergence is the
      // feature (the guard re-asserts the pin and the disagreement already
      // surfaces as an ip-override Conflict, not a drift log line).
      if (field === "ipAddress" && (asset.ipOverride || asset.ipBlankPinned)) continue;
      const projVal = projected[field];
      if (projVal === null || projVal === undefined) continue; // No source opinion — skip
      const curVal = (asset as Record<string, unknown>)[field] ?? null;
      if (!valuesEqual(projVal, curVal)) {
        drifts.push({
          field,
          projected: projVal as string | number,
          current: (curVal ?? null) as string | number | null,
          winningSource: provenance[field] ?? null,
        });
      }
    }

    if (drifts.length > 0) {
      logger.info(
        {
          event: "asset.projection.drift",
          assetId,
          integrationKind,
          drifts,
        },
        `Projection drift on asset ${assetId} (${drifts.length} field${drifts.length === 1 ? "" : "s"})`,
      );
    }
  } catch (err: unknown) {
    // Best-effort. Drift detection failure must never break the Asset
    // write that already landed.
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        assetId,
        integrationKind,
      },
      "Projection drift detection failed",
    );
  }
}

// Strict equality with type-aware string comparison: case-sensitive, but
// trim whitespace-only differences. Numbers compare with === (NaN never
// equals anything, which matches our "null = no opinion" semantics —
// projection can't return NaN since obsNumber checks Number.isFinite).
function valuesEqual(
  a: string | number | null | undefined,
  b: unknown,
): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === "string" && typeof b === "string") {
    return a.trim() === b.trim();
  }
  if (typeof a === "number" && typeof b === "number") {
    return a === b;
  }
  return false;
}
