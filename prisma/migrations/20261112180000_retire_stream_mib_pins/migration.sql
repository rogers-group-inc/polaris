-- Per-stream MIB pins are retired (business rule 170). Which MIB a stream
-- reads is decided by the asset's manufacturer profile; the per-stream "MIB"
-- dropdown is gone from every monitoring form, the resolver no longer reads
-- the columns and the write schemas drop them.
--
-- Only ONE pin ever did anything: an UPLOADED MIB on the CPU/Memory or
-- Hardware Sensors stream. A MIB uploaded under a manufacturer switched the
-- asset into that manufacturer's profile; one uploaded with none added its
-- module name to the profiles' "Also applies when" match. Each such pin that
-- could have changed the profile is recorded first as a warning Event on the
-- asset (or the class setting), naming the MIB, so the operator can set the
-- asset's Manufacturer instead. A pin whose MIB names the asset's own
-- manufacturer changed nothing; standard-MIB pins ("std:…") and pins on the
-- other four streams changed nothing either. Those are cleared silently.
--
-- The columns stay for one release so a rollback finds them; nothing reads
-- them. Timestamps are UTC explicitly (naive TIMESTAMP column; Prisma writes
-- UTC).

-- 1. Audit: assets whose uploaded-MIB pin was choosing their profile.
INSERT INTO "events" ("id", "timestamp", "level", "levelRank", "action", "resourceType", "resourceId", "resourceName", "actor", "message", "details", "assetId")
SELECT
  gen_random_uuid()::text,
  (now() AT TIME ZONE 'UTC'),
  'warning',
  1,
  'asset.stream_mib_pin.retired',
  'asset',
  a."id",
  a."hostname",
  'system:migration',
  'Removed the ' || s.stream || ' MIB pin (' || m."moduleName" || ') on "' || COALESCE(a."hostname", a."ipAddress", a."id") ||
    '". ' || CASE WHEN m."manufacturer" IS NOT NULL
      THEN 'It made this asset use the ' || m."manufacturer" || ' manufacturer profile; per-stream MIB pins are retired, so set the asset''s Manufacturer to ' || m."manufacturer" || ' to keep it.'
      ELSE 'It let a profile''s "Also applies when" pattern match the module name; per-stream MIB pins are retired, so set the asset''s Manufacturer if it used one.'
    END,
  jsonb_build_object('stream', s.stream, 'mibId', m."id", 'moduleName', m."moduleName",
                     'mibManufacturer', m."manufacturer", 'mibModel', m."model",
                     'assetManufacturer', a."manufacturer"),
  a."id"
FROM "assets" a
CROSS JOIN LATERAL (VALUES ('CPU/Memory', a."cpuMemoryMibId"), ('Hardware Sensors', a."temperatureMibId")) AS s(stream, mib_id)
JOIN "mib_files" m ON m."id" = s.mib_id
WHERE m."manufacturer" IS NULL OR a."manufacturer" IS NULL OR lower(m."manufacturer") <> lower(a."manufacturer");

-- 2. The same for a class monitoring setting (asset type × integration).
INSERT INTO "events" ("id", "timestamp", "level", "levelRank", "action", "resourceType", "resourceId", "resourceName", "actor", "message", "details")
SELECT
  gen_random_uuid()::text,
  (now() AT TIME ZONE 'UTC'),
  'warning',
  1,
  'monitor_class_override.stream_mib_pin.retired',
  'monitor_class_override',
  c."id",
  c."assetType",
  'system:migration',
  'Removed the ' || s.stream || ' MIB pin (' || m."moduleName" || ') from the "' || c."assetType" ||
    '" class monitoring setting. ' || CASE WHEN m."manufacturer" IS NOT NULL
      THEN 'It made those assets use the ' || m."manufacturer" || ' manufacturer profile; per-stream MIB pins are retired, so set their Manufacturer to ' || m."manufacturer" || ' to keep it.'
      ELSE 'It let a profile''s "Also applies when" pattern match the module name; per-stream MIB pins are retired, so set the assets'' Manufacturer if they used one.'
    END,
  jsonb_build_object('stream', s.stream, 'mibId', m."id", 'moduleName', m."moduleName",
                     'mibManufacturer', m."manufacturer", 'integrationId', c."integrationId")
FROM "monitor_class_overrides" c
CROSS JOIN LATERAL (VALUES ('CPU/Memory', c."cpuMemoryMibId"), ('Hardware Sensors', c."temperatureMibId")) AS s(stream, mib_id)
JOIN "mib_files" m ON m."id" = s.mib_id;

-- 3. Clear every pin on assets and class settings.
UPDATE "assets"
SET "responseTimeMibId" = NULL, "cpuMemoryMibId" = NULL, "temperatureMibId" = NULL,
    "interfacesMibId" = NULL, "lldpMibId" = NULL, "processesMibId" = NULL
WHERE COALESCE("responseTimeMibId", "cpuMemoryMibId", "temperatureMibId",
               "interfacesMibId", "lldpMibId", "processesMibId") IS NOT NULL;

UPDATE "monitor_class_overrides"
SET "responseTimeMibId" = NULL, "cpuMemoryMibId" = NULL, "temperatureMibId" = NULL,
    "interfacesMibId" = NULL, "lldpMibId" = NULL, "processesMibId" = NULL
WHERE COALESCE("responseTimeMibId", "cpuMemoryMibId", "temperatureMibId",
               "interfacesMibId", "lldpMibId", "processesMibId") IS NOT NULL;

-- 4. The integration and manual tiers keep the same keys inside a JSON blob
--    (Integration.config.monitorSettings, the manualMonitorSettings Setting;
--    `telemetryMibId` is the pre-split spelling). Drop them.
UPDATE "integrations"
SET "config" = jsonb_set("config"::jsonb, '{monitorSettings}',
      ("config"::jsonb -> 'monitorSettings') - 'responseTimeMibId' - 'cpuMemoryMibId' - 'temperatureMibId'
        - 'interfacesMibId' - 'lldpMibId' - 'processesMibId' - 'telemetryMibId')
WHERE jsonb_typeof("config"::jsonb -> 'monitorSettings') = 'object'
  AND ("config"::jsonb -> 'monitorSettings') ?| ARRAY['responseTimeMibId', 'cpuMemoryMibId', 'temperatureMibId',
        'interfacesMibId', 'lldpMibId', 'processesMibId', 'telemetryMibId'];

UPDATE "settings"
SET "value" = "value"::jsonb - 'responseTimeMibId' - 'cpuMemoryMibId' - 'temperatureMibId'
      - 'interfacesMibId' - 'lldpMibId' - 'processesMibId' - 'telemetryMibId'
WHERE "key" = 'manualMonitorSettings'
  AND jsonb_typeof("value"::jsonb) = 'object'
  AND "value"::jsonb ?| ARRAY['responseTimeMibId', 'cpuMemoryMibId', 'temperatureMibId',
        'interfacesMibId', 'lldpMibId', 'processesMibId', 'telemetryMibId'];
