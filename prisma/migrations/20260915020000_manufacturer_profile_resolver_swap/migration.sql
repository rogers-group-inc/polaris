-- Manufacturer profile: everything the hardcoded vendor constant could say
-- and the editable rows could not (Phase 4 of uniform SNMP).
--
-- `pickVendorProfileMerged` layered the operator's rows over a clone of
-- VENDOR_TELEMETRY_PROFILES because four facts had no column: how a walked
-- subtree collapses (Cisco memory pools are SUMMED, Juniper buffers AVERAGED),
-- the label a synthesized sample row carries (FortiSwitch flash is "flash"),
-- the model-identity query (FortiSwitch fsSysVersion, parsed by a JS
-- function), and which manufacturer strings a profile also applies to (the
-- constant's regex covered "hpe|hewlett|procurve|^hp"). And a device FAMILY
-- could only be expressed as a model regex, which matched an empty model only
-- through the Fortinet-specific `fortinetClassHint`.
--
-- After this migration every one of those is a row the operator owns:
--
--   manufacturer_profiles.matchPattern            "also applies when …"
--   manufacturer_profile_metrics.defaultAggregate  none | avg | sum
--   manufacturer_profile_metrics.defaultLabel      row label (mountPath / sensorName)
--   manufacturer_profile_metrics.defaultParse*     the `model` row's declarative parse
--   manufacturer_profile_metric_overrides.assetType  a DEVICE-TYPE default when
--                                                    modelPattern is null
--   …and the same aggregate / label / parse columns on overrides.
--
-- Every backfill UPDATE is guarded on the SEEDED symbol, so a row an operator
-- has retargeted is never touched. Rows are only ever ADDED.

-- ─── Columns ────────────────────────────────────────────────────────────────

ALTER TABLE "manufacturer_profiles"
  ADD COLUMN "matchPattern" TEXT;

ALTER TABLE "manufacturer_profile_metrics"
  ADD COLUMN "defaultAggregate"     TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "defaultLabel"         TEXT,
  ADD COLUMN "defaultParsePattern"  TEXT,
  ADD COLUMN "defaultParseTemplate" TEXT;

ALTER TABLE "manufacturer_profile_metric_overrides"
  ADD COLUMN "assetType"     TEXT,
  ADD COLUMN "aggregate"     TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "label"         TEXT,
  ADD COLUMN "parsePattern"  TEXT,
  ADD COLUMN "parseTemplate" TEXT;

ALTER TABLE "manufacturer_profile_metric_overrides"
  ALTER COLUMN "modelPattern" DROP NOT NULL;

-- A scoped row keys on a device type, a model pattern, or both — never neither.
ALTER TABLE "manufacturer_profile_metric_overrides"
  ADD CONSTRAINT "manufacturer_profile_metric_overrides_scope_check"
  CHECK ("assetType" IS NOT NULL OR "modelPattern" IS NOT NULL);

CREATE INDEX "manufacturer_profile_metric_overrides_metricRowId_assetType_idx"
  ON "manufacturer_profile_metric_overrides"("metricRowId", "assetType");

-- One device-type DEFAULT per (metric row, asset type). Partial, so a type
-- may carry as many per-model exceptions as needed. Name kept under
-- Postgres's 63-character identifier limit deliberately.
CREATE UNIQUE INDEX "mfg_profile_metric_overrides_type_default_key"
  ON "manufacturer_profile_metric_overrides"("metricRowId", "assetType")
  WHERE "modelPattern" IS NULL;

-- ─── Backfill: aggregate / label, guarded on the seeded symbol ─────────────

-- Cisco: cpmCPUTotal5secRev is a table column (one row per CPU) → averaged;
-- ciscoMemoryPool{Used,Free} are pool rows → summed. The merge hardcoded
-- walkSubtree=false on the double_scalar path, so seeded Cisco installs have
-- been doing a scalar GET of a table column and falling to HOST-RESOURCES-MIB
-- — this row is what fixes that.
UPDATE "manufacturer_profile_metrics"
   SET "defaultAggregate" = 'avg'
 WHERE "metricKey" = 'cpu' AND "defaultSymbol" = 'cpmCPUTotal5secRev' AND "defaultType" = 'table' AND "defaultAggregate" = 'none';
UPDATE "manufacturer_profile_metrics"
   SET "defaultAggregate" = 'sum'
 WHERE "metricKey" = 'memory' AND "defaultSymbol" = 'ciscoMemoryPoolUsed' AND "defaultAggregate" = 'none';

-- Juniper: jnxOperatingCPU / jnxOperatingBuffer are per-entity rows → averaged.
UPDATE "manufacturer_profile_metrics"
   SET "defaultAggregate" = 'avg'
 WHERE "metricKey" = 'cpu' AND "defaultSymbol" = 'jnxOperatingCPU' AND "defaultAggregate" = 'none';
UPDATE "manufacturer_profile_metrics"
   SET "defaultAggregate" = 'avg'
 WHERE "metricKey" = 'memory' AND "defaultSymbol" = 'jnxOperatingBuffer' AND "defaultAggregate" = 'none';

-- FortiSwitch flash is labelled "flash" (the StorageSample row key pins and
-- thresholds attach to); FortiAP's single temperature reading is "System".
UPDATE "manufacturer_profile_metric_overrides"
   SET "label" = 'flash'
 WHERE "symbol" = 'fsSysDiskUsage' AND "label" IS NULL;
UPDATE "manufacturer_profile_metric_overrides"
   SET "label" = 'System'
 WHERE "symbol" = 'fapTemperature' AND "label" IS NULL;

-- The Fortinet umbrella temperature row: the FortiOS constant carries no
-- temperature block, so this row seeded EMPTY, and the sensor-table walk was
-- dispatched by `/fortinet/i.test(manufacturer)` in the collector instead.
-- Give the row the fact the regex encoded — only where the row is still empty.
UPDATE "manufacturer_profile_metrics" m
   SET "defaultSymbol" = 'fgHwSensorTable', "defaultType" = 'table'
  FROM "manufacturer_profiles" p
 WHERE m."profileId" = p."id"
   AND lower(p."manufacturer") = 'fortinet'
   AND m."metricKey" = 'temperature'
   AND m."defaultSymbol" IS NULL AND m."defaultSymbolB" IS NULL AND m."defaultTransform" IS NULL;

-- ─── Backfill: matchPattern, seeded profiles only ──────────────────────────
-- The constant's alternations, so alias-canonical spellings the seed did not
-- key ("Aruba", "HPE" → the HP profile) and OS-only identity ("Cisco IOS" with
-- no manufacturer) keep resolving. Only where the operator has not set one.
UPDATE "manufacturer_profiles" SET "matchPattern" = 'cisco|ios-?xe|nx-?os'                 WHERE lower("manufacturer") = 'cisco'    AND "matchPattern" IS NULL AND "createdBy" = 'system:seed';
UPDATE "manufacturer_profiles" SET "matchPattern" = 'juniper|junos'                        WHERE lower("manufacturer") = 'juniper'  AND "matchPattern" IS NULL AND "createdBy" = 'system:seed';
UPDATE "manufacturer_profiles" SET "matchPattern" = 'mikrotik|routeros'                    WHERE lower("manufacturer") = 'mikrotik' AND "matchPattern" IS NULL AND "createdBy" = 'system:seed';
UPDATE "manufacturer_profiles" SET "matchPattern" = 'fortinet|fortigate|fortios'           WHERE lower("manufacturer") = 'fortinet' AND "matchPattern" IS NULL AND "createdBy" = 'system:seed';
UPDATE "manufacturer_profiles" SET "matchPattern" = 'aruba|hpe|hewlett|procurve|^hp\b'     WHERE lower("manufacturer") = 'hp'       AND "matchPattern" IS NULL AND "createdBy" = 'system:seed';
UPDATE "manufacturer_profiles" SET "matchPattern" = '\bdell\b|powerconnect|force10'        WHERE lower("manufacturer") = 'dell'     AND "matchPattern" IS NULL AND "createdBy" = 'system:seed';

-- ─── Family rows: add a DEVICE-TYPE default beside each model-pattern row ──
-- The seeded "FortiSwitch" / "FortiAP" rows matched an EMPTY model only through
-- fortinetClassHint. A type-default sibling (assetType set, modelPattern null)
-- says the same thing as data; the pattern row STAYS so a mis-typed asset whose
-- model states the family still routes by the model (tier 2 beats tier 3).
-- The sibling copies the row AS THE OPERATOR LEFT IT — symbols, MIB pin,
-- transform, label, aggregate.
INSERT INTO "manufacturer_profile_metric_overrides"
  ("id", "metricRowId", "assetType", "modelPattern", "symbol", "symbolB", "mibId", "mibStdKey", "type", "transform", "label", "aggregate", "order")
SELECT gen_random_uuid()::text, o."metricRowId",
       CASE o."modelPattern" WHEN 'FortiSwitch' THEN 'switch' ELSE 'access_point' END,
       NULL, o."symbol", o."symbolB", o."mibId", o."mibStdKey", o."type", o."transform", o."label", o."aggregate", o."order"
  FROM "manufacturer_profile_metric_overrides" o
  JOIN "manufacturer_profile_metrics" m ON m."id" = o."metricRowId"
  JOIN "manufacturer_profiles" p       ON p."id" = m."profileId"
 WHERE lower(p."manufacturer") = 'fortinet'
   AND o."modelPattern" IN ('FortiSwitch', 'FortiAP')
   AND o."assetType" IS NULL
ON CONFLICT DO NOTHING;

-- ─── The `model` metric row ───────────────────────────────────────────────
-- Identity query: which vendor scalar carries the hardware model, and how to
-- parse it. Every profile gets the (empty) row; only Fortinet's FortiSwitch
-- family has a query today — fsSysVersion, "S548DF-v7.2.5-…" → "FortiSwitch S548DF".
INSERT INTO "manufacturer_profile_metrics" ("id", "profileId", "metricKey", "defaultType")
SELECT gen_random_uuid()::text, p."id", 'model', 'scalar'
  FROM "manufacturer_profiles" p
 WHERE NOT EXISTS (
   SELECT 1 FROM "manufacturer_profile_metrics" m WHERE m."profileId" = p."id" AND m."metricKey" = 'model'
 );

-- FortiSwitch model query, both keyings (type default + model pattern), on the
-- Fortinet profile's model row. `WHERE NOT EXISTS` on the slot, never an update.
INSERT INTO "manufacturer_profile_metric_overrides"
  ("id", "metricRowId", "assetType", "modelPattern", "symbol", "type", "parsePattern", "parseTemplate", "order")
SELECT gen_random_uuid()::text, m."id", 'switch', NULL, 'fsSysVersion', 'scalar', '^(?!v\d)(.+?)[-\s]v\d', 'FortiSwitch $1', 0
  FROM "manufacturer_profile_metrics" m
  JOIN "manufacturer_profiles" p ON p."id" = m."profileId"
 WHERE lower(p."manufacturer") = 'fortinet' AND m."metricKey" = 'model'
   AND NOT EXISTS (
     SELECT 1 FROM "manufacturer_profile_metric_overrides" x
      WHERE x."metricRowId" = m."id" AND x."assetType" = 'switch' AND x."modelPattern" IS NULL
   );

INSERT INTO "manufacturer_profile_metric_overrides"
  ("id", "metricRowId", "assetType", "modelPattern", "symbol", "type", "parsePattern", "parseTemplate", "order")
SELECT gen_random_uuid()::text, m."id", NULL, 'FortiSwitch', 'fsSysVersion', 'scalar', '^(?!v\d)(.+?)[-\s]v\d', 'FortiSwitch $1', 0
  FROM "manufacturer_profile_metrics" m
  JOIN "manufacturer_profiles" p ON p."id" = m."profileId"
 WHERE lower(p."manufacturer") = 'fortinet' AND m."metricKey" = 'model'
   AND NOT EXISTS (
     SELECT 1 FROM "manufacturer_profile_metric_overrides" x
      WHERE x."metricRowId" = m."id" AND x."assetType" IS NULL AND x."modelPattern" = 'FortiSwitch'
   );
