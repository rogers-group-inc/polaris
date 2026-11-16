-- ArcGIS becomes read only (business rule 188; rules 184 and 185 retired 2026-11-16).
--
-- Polaris no longer draws its own cable runs or writes them to ArcGIS. It reads
-- operator-picked ArcGIS feature layers and draws them on Topology views, and a
-- device connection can still be routed through an ArcGIS line (rule 188(a)).
--
--   1. Drop `cable_runs` (the Polaris-drawn runs and their write-back state).
--      Runs drawn since 2026-11-13 are discarded; they were never the record.
--   2. Empty `cable_run_links`: its `run_ids` named those runs. The column now
--      holds ArcGIS feature references `<layerId>/<featureId>`.
--   3. Remove the `cableRuns` function key from every role (precedent:
--      20260703000000_remove_reservation_push_key). updatedAt is bumped so the
--      role-snapshot cache refetches.
--   4. Strip the write-back keys from stored ArcGIS integration configs.
--   5. `topology_views.arcgis_layers`: the layers each view draws (none by default).

-- 1.
DROP TABLE IF EXISTS "cable_runs";

-- 2.
DELETE FROM "cable_run_links";

-- 3.
UPDATE "roles"
   SET "permissions" = "permissions" - 'cableRuns',
       "updatedAt"   = NOW()
 WHERE "permissions" ? 'cableRuns';

-- 4.
UPDATE "integrations"
   SET "config" = "config" - 'writeBackEnabled' - 'writeBackMode' - 'featureLayerUrl' - 'fieldMap' - 'valueMap'
 WHERE "type" = 'arcgis';

-- 5.
ALTER TABLE "topology_views" ADD COLUMN "arcgis_layers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
