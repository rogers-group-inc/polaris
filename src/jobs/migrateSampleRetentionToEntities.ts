/**
 * src/jobs/migrateSampleRetentionToEntities.ts
 *
 * One-shot startup migration. Converts the legacy CLASS-shaped
 * `Setting("sampleRetention")` —
 *
 *   { sample|telemetry|systemInfo: { detail|hourly|daily:
 *       { default, switch, accessPoint } } }
 *
 * — into the new per-ENTITY shape:
 *
 *   { assets|cpuMem|temperature|interfaces|storage|ipsec:
 *       { detail, hourly, daily } }
 *
 * Mapping (takes the `default` class of each legacy tier — the per-class
 * switch/AP refinement is retired; cadence selection is the new volume lever):
 *   sample     → assets
 *   telemetry  → cpuMem AND temperature   (split into two entities)
 *   systemInfo → interfaces, storage, ipsec
 *
 * Encoding flip: legacy 0 meant "keep forever"; the new model uses FOREVER (-1)
 * for that and 0 for "tier off". So legacy 0 → FOREVER here.
 *
 * Idempotent via the `sampleRetentionEntityMigratedAt` marker AND a shape
 * sniff (a value that already has an `assets` key is left untouched). Safe on
 * fresh installs (no row → seeds entity defaults).
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import {
  defaultSampleRetention,
  invalidateSampleRetentionCache,
  FOREVER,
  RETENTION_ENTITIES,
  FLAT_RETENTION_ENTITIES,
  type FlatRetentionEntity,
  SETTING_KEY as RETENTION_KEY,
  type SampleRetention,
  type TierRetention,
} from "../services/sampleRetentionService.js";
import { runInstrumentedJob } from "./_metrics.js";
import { hasRunMarker, stampRunMarker } from "./_runOnce.js";

const MIGRATED_KEY = "sampleRetentionEntityMigratedAt";

/** Legacy 0 ("keep forever") → FOREVER; otherwise pass the day count through. */
function legacyToEncoded(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  if (v === 0) return FOREVER;
  if (v < 0) return fallback;
  return Math.trunc(v);
}

/** Pull the `default` class out of a legacy class-shaped tier bundle
 *  ({ detail:{default,..}, hourly:{..}, daily:{..} }) into a flat TierRetention. */
function legacyStreamToTier(raw: unknown, fallback: TierRetention): TierRetention {
  const r = (raw ?? {}) as Record<string, any>;
  return {
    detail: legacyToEncoded(r.detail?.default, fallback.detail),
    hourly: legacyToEncoded(r.hourly?.default, fallback.hourly),
    daily:  legacyToEncoded(r.daily?.default,  fallback.daily),
  };
}

(async () => {
  try {
    await runInstrumentedJob("migrateSampleRetentionToEntities", async () => {
      if (await hasRunMarker(MIGRATED_KEY)) return;

      const row = await prisma.setting.findUnique({ where: { key: RETENTION_KEY } });
      const raw = (row?.value ?? null) as Record<string, any> | null;
      const def = defaultSampleRetention();

      let migrated: SampleRetention;
      if (raw && RETENTION_ENTITIES.some((e) => e in raw)) {
        // Already entity-shaped (e.g. re-run or fresh install seeded new) — leave it.
        migrated = raw as SampleRetention;
      } else if (raw && ("sample" in raw || "systemInfo" in raw || "telemetry" in raw)) {
        // Legacy class shape → entity shape.
        migrated = {
          assets:      legacyStreamToTier(raw.sample,     def.assets),
          cpuMem:      legacyStreamToTier(raw.telemetry,  def.cpuMem),
          hardware:    legacyStreamToTier(raw.telemetry,  def.hardware),
          interfaces:  legacyStreamToTier(raw.systemInfo, def.interfaces),
          storage:     legacyStreamToTier(raw.systemInfo, def.storage),
          ipsec:       legacyStreamToTier(raw.systemInfo, def.ipsec),
          // The SD-WAN SLA-metrics stream also rides the system-info pass.
          // (SD-WAN rules are current-state now, not a retention entity.)
          perfSla:     legacyStreamToTier(raw.systemInfo, def.perfSla),
          // Process telemetry postdates the legacy class shape — no legacy key
          // to migrate; take the default.
          process:     def.process,
          // Connectivity checks likewise postdate it.
          connectivity: def.connectivity,
          // Flat (non-tiered) entities likewise postdate the legacy shape and
          // have no stream to derive from. Spread the defaults rather than
          // naming each one, so a future flat entity can't be forgotten here.
          ...Object.fromEntries(FLAT_RETENTION_ENTITIES.map((e) => [e, def[e]])) as
            Pick<SampleRetention, FlatRetentionEntity>,
        };
      } else {
        // No row / unrecognized → seed entity defaults.
        migrated = def;
      }

      await prisma.setting.upsert({
        where:  { key: RETENTION_KEY },
        update: { value: migrated as any },
        create: { key: RETENTION_KEY, value: migrated as any },
      });
      invalidateSampleRetentionCache();

      await stampRunMarker(MIGRATED_KEY, { migrated });

      logger.info({ migrated }, "Sample retention migrated to per-entity shape");
    });
  } catch (err) {
    logger.error(
      { err },
      "Sample-retention entity migration failed — rerun by deleting the sampleRetentionEntityMigratedAt Setting row and restarting",
    );
  }
})();
