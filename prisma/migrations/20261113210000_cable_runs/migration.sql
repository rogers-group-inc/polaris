-- Business rule 184: cable runs (fiber / ethernet along poles or in trenches)
-- drawn on a site's Topology view, and the `cableRuns` function key.
--
--   1. The `cable_runs` table. One row per run, owned by the SITE (the
--      FortiGate asset), cascade-deleted with it. `points` is WGS84
--      [[lng, lat, z?], ...]. The sync columns hold the one-way ArcGIS
--      write-back state; "off" until write-back is configured.
--   2. The `cableRuns` key on every role. A run is written to another
--      organisation's system (ArcGIS), so drawing one is an administrator's
--      grant, not a rung of deviceMap: admin gets fullwrite, readonly gets
--      read, every other role (built-in or custom) none until an admin grants
--      it. `updatedAt` is bumped so the role-version cache refetches and live
--      sessions see the key on their next request. Idempotent: only rows that
--      lack the key.

-- ─── 1. cable_runs ───────────────────────────────────────────────────────
CREATE TABLE "cable_runs" (
    "id"               TEXT             NOT NULL,
    "site_id"          TEXT             NOT NULL,
    "name"             TEXT             NOT NULL DEFAULT '',
    "medium"           TEXT             NOT NULL DEFAULT 'fiber',
    "placement"        TEXT             NOT NULL DEFAULT 'electric_pole',
    "points"           JSONB            NOT NULL,
    "source"           TEXT             NOT NULL DEFAULT 'drawn',
    "source_file"      TEXT,
    "notes"            TEXT             NOT NULL DEFAULT '',
    "length_m"         DOUBLE PRECISION NOT NULL DEFAULT 0,
    "version"          INTEGER          NOT NULL DEFAULT 1,
    "sync_status"      TEXT             NOT NULL DEFAULT 'off',
    "sync_error"       TEXT,
    "synced_at"        TIMESTAMP(3),
    "arcgis_object_id" INTEGER,
    "deleted_at"       TIMESTAMP(3),
    "created_by"       TEXT,
    "updated_by"       TEXT,
    "created_at"       TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3)     NOT NULL,

    CONSTRAINT "cable_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cable_runs_site_id_idx" ON "cable_runs"("site_id");
CREATE INDEX "cable_runs_sync_status_idx" ON "cable_runs"("sync_status");

ALTER TABLE "cable_runs"
  ADD CONSTRAINT "cable_runs_site_id_fkey"
  FOREIGN KEY ("site_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 2. Seed the `cableRuns` function key ────────────────────────────────
UPDATE "roles"
   SET "permissions" = jsonb_set(
         "permissions",
         '{cableRuns}',
         CASE lower("name")
           WHEN 'admin'    THEN '"fullwrite"'::jsonb
           WHEN 'readonly' THEN '"read"'::jsonb
           ELSE '"none"'::jsonb
         END,
         true),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE NOT ("permissions" ? 'cableRuns');
