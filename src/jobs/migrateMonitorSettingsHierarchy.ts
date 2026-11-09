/**
 * src/jobs/migrateMonitorSettingsHierarchy.ts
 *
 * One-shot startup migration for the four-tier monitor-settings hierarchy.
 *
 * Before this migration: a single global `monitorSettings` Setting row held the
 * top-level cadences/retentions plus two nested per-class blocks (`fortiswitch`,
 * `fortiap`). Edited from the FMG/FortiGate Monitoring tab UI but applied
 * globally to every monitored asset.
 *
 * After this migration:
 *   - Manual tier      → Setting "manualMonitorSettings" (orphan/non-integration assets)
 *   - Integration tier → Integration.config.monitorSettings JSON, per integration
 *   - Class override   → MonitorClassOverride row, per (integrationId, assetType)
 *
 * What this job does:
 *   1. Reads the legacy `monitorSettings` Setting row.
 *   2. Seeds `manualMonitorSettings` from the legacy top-level block.
 *   3. For every integration, seeds `Integration.config.monitorSettings` from
 *      the same legacy top-level block.
 *   4. For every FMG/FortiGate integration, creates a `MonitorClassOverride`
 *      row for `assetType=switch` if the legacy `fortiswitch` block differs
 *      from the top-level — copying ONLY the differing fields. Same for
 *      `fortiap` → `assetType=access_point`.
 *   5. Deletes the legacy `monitorSettings` Setting row.
 *   6. Stamps a `monitorSettingsHierarchyMigratedAt` Setting key so subsequent
 *      boots no-op.
 *   7. Invalidates the resolver cache so the next monitor pass reads fresh data.
 *
 * Idempotent. Safe on fresh installs (no legacy row → just stamps the marker).
 * Safe to re-run after a partial failure (each step checks for existing rows).
 */

import { toNonNegativeInt } from "../utils/num.js";
import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { invalidateMonitorSettingsCache } from "../services/monitoringService.js";
import { runInstrumentedJob } from "./_metrics.js";
import { hasRunMarker, stampRunMarker } from "./_runOnce.js";

const LEGACY_KEY   = "monitorSettings";
const MANUAL_KEY   = "manualMonitorSettings";
const MIGRATED_KEY = "monitorSettingsHierarchyMigratedAt";

interface TierShape {
  intervalSeconds:           number;
  failureThreshold:          number;
  probeTimeoutMs:            number;
  telemetryIntervalSeconds:  number;
  systemInfoIntervalSeconds: number;
  sampleRetentionDays:       number;
  telemetryRetentionDays:    number;
  systemInfoRetentionDays:   number;
}

const HARDCODED_FLOOR: TierShape = {
  intervalSeconds:           60,
  failureThreshold:          3,
  probeTimeoutMs:            5000,
  telemetryIntervalSeconds:  60,
  systemInfoIntervalSeconds: 600,
  sampleRetentionDays:       30,
  telemetryRetentionDays:    30,
  systemInfoRetentionDays:   30,
};

function readTier(v: Record<string, unknown> | null | undefined): TierShape {
  const o = v ?? {};
  return {
    intervalSeconds:           toNonNegativeInt(o.intervalSeconds,           HARDCODED_FLOOR.intervalSeconds),
    failureThreshold:          toNonNegativeInt(o.failureThreshold,          HARDCODED_FLOOR.failureThreshold),
    probeTimeoutMs:            toNonNegativeInt(o.probeTimeoutMs,            HARDCODED_FLOOR.probeTimeoutMs),
    telemetryIntervalSeconds:  toNonNegativeInt(o.telemetryIntervalSeconds,  HARDCODED_FLOOR.telemetryIntervalSeconds),
    systemInfoIntervalSeconds: toNonNegativeInt(o.systemInfoIntervalSeconds, HARDCODED_FLOOR.systemInfoIntervalSeconds),
    sampleRetentionDays:       toNonNegativeInt(o.sampleRetentionDays,       HARDCODED_FLOOR.sampleRetentionDays),
    telemetryRetentionDays:    toNonNegativeInt(o.telemetryRetentionDays,    HARDCODED_FLOOR.telemetryRetentionDays),
    systemInfoRetentionDays:   toNonNegativeInt(o.systemInfoRetentionDays,   HARDCODED_FLOOR.systemInfoRetentionDays),
  };
}

/** Diff the per-class block against the top-level baseline, returning only fields that differ. */
function tierToOverride(tier: TierShape, base: TierShape): Partial<TierShape> {
  const out: Partial<TierShape> = {};
  for (const k of Object.keys(tier) as Array<keyof TierShape>) {
    if (tier[k] !== base[k]) (out as any)[k] = tier[k];
  }
  return out;
}

(async () => {
  try {
    await runInstrumentedJob("migrateMonitorSettingsHierarchy", async () => {
    // Idempotency guard.
    if (await hasRunMarker(MIGRATED_KEY)) return;

    const legacyRow = await prisma.setting.findUnique({ where: { key: LEGACY_KEY } });

    // Fresh install path: nothing to migrate, just stamp the marker so we
    // don't re-check on every boot.
    if (!legacyRow) {
      await stampRunMarker(MIGRATED_KEY, { nothingToMigrate: true });
      logger.info("Monitor-settings hierarchy migration: no legacy row found (fresh install) — marker stamped");
      return;
    }

    const legacyValue = (legacyRow.value as Record<string, unknown> | null) ?? null;
    const topLevel    = readTier(legacyValue);
    const fortiswitch = readTier((legacyValue?.fortiswitch as Record<string, unknown> | null) ?? null);
    const fortiap     = readTier((legacyValue?.fortiap     as Record<string, unknown> | null) ?? null);

    let integrationsSeeded     = 0;
    let switchOverridesCreated = 0;
    let apOverridesCreated     = 0;

    // Step 1: Seed the manual tier (skip if already present from a partial prior run).
    const existingManual = await prisma.setting.findUnique({ where: { key: MANUAL_KEY } });
    const manualSeeded   = !existingManual;
    if (!existingManual) {
      await prisma.setting.create({ data: { key: MANUAL_KEY, value: topLevel as any } });
    }

    // Step 2: Seed each integration's tier (only when not already present).
    const integrations = await prisma.integration.findMany({
      select: { id: true, name: true, type: true, config: true },
    });
    for (const integ of integrations) {
      const cfg = (integ.config && typeof integ.config === "object" ? integ.config : {}) as Record<string, unknown>;
      if (cfg.monitorSettings) continue;
      const newCfg = { ...cfg, monitorSettings: topLevel };
      await prisma.integration.update({ where: { id: integ.id }, data: { config: newCfg as any } });
      integrationsSeeded++;
    }

    // Step 3: Create class overrides where the legacy per-class block diverged
    // from the top-level. Only applies to FMG/FortiGate integrations because
    // those are the only places the fortiswitch/fortiap blocks meaningfully
    // applied — Cisco SNMP switches under a non-Fortinet integration were
    // never matched by the legacy pickMonitorClass.
    const fortinetIntegrations = integrations.filter(
      (i) => i.type === "fortimanager" || i.type === "fortigate",
    );

    const switchOverride = tierToOverride(fortiswitch, topLevel);
    if (Object.keys(switchOverride).length > 0) {
      for (const integ of fortinetIntegrations) {
        const existing = await prisma.monitorClassOverride.findFirst({
          where: { integrationId: integ.id, assetType: "switch" },
        });
        if (existing) continue;
        await prisma.monitorClassOverride.create({
          data: { integrationId: integ.id, assetType: "switch", ...switchOverride },
        });
        switchOverridesCreated++;
      }
    }

    const apOverride = tierToOverride(fortiap, topLevel);
    if (Object.keys(apOverride).length > 0) {
      for (const integ of fortinetIntegrations) {
        const existing = await prisma.monitorClassOverride.findFirst({
          where: { integrationId: integ.id, assetType: "access_point" },
        });
        if (existing) continue;
        await prisma.monitorClassOverride.create({
          data: { integrationId: integ.id, assetType: "access_point", ...apOverride },
        });
        apOverridesCreated++;
      }
    }

    // Step 4: Delete the legacy monitorSettings row. Doing this AFTER the new
    // tiers are seeded means the resolver's transitional fallback (reading
    // the legacy row when no tier-3 is present) keeps working until the very
    // last step — no window where the resolver sees defaults instead of
    // the operator's tuned values.
    await prisma.setting.delete({ where: { key: LEGACY_KEY } });

    // Step 5: Stamp the migration marker.
    await stampRunMarker(MIGRATED_KEY, {
      manualSeeded,
      integrationsSeeded,
      switchOverridesCreated,
      apOverridesCreated,
    });

    // Step 6: Drop the resolver cache so the next monitor pass reads through
    // the new tier rows instead of any in-memory legacy values cached during
    // the brief startup window before this job ran.
    invalidateMonitorSettingsCache();

    logger.info(
      {
        manualSeeded,
        integrationsSeeded,
        switchOverridesCreated,
        apOverridesCreated,
      },
      "Monitor-settings hierarchy migration complete",
    );
    });
  } catch (err) {
    logger.error(
      { err },
      "Monitor-settings hierarchy startup migration failed — existing settings may need manual review (rerun cleanly: delete the monitorSettingsHierarchyMigratedAt Setting row and restart)",
    );
  }
})();
