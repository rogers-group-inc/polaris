-- Clear Manufacturer Profile transforms that were stored but never applied.
-- 2026-09-23.
--
-- WHY. Until now a metric row (cpu / memory / temperature / storage / …) and
-- its overrides accepted any unary transform from the registry, showed it in
-- the profile table's Transform column, and no collector ever applied it. The
-- owner's production install carried `celsius_to_fahrenheit` on a FortiAP
-- temperature row for months without a single reading converting.
--
-- From this release a metric row may carry only the unary transforms its
-- collector actually applies (METRIC_ROW_TRANSFORMS in
-- src/utils/symbolTransforms.ts) — today `tenths_to_units` on a SCALAR
-- temperature row. Every other unary value on a metric row or override is
-- cleared here, so the Transform column stops describing work that does not
-- happen. Nothing a collector reads changes: those values were already inert.
--
-- Combiners on `double_scalar` rows are left alone — they are a statement of
-- which two of used/total/free the row's symbols are, and the memory and disk
-- collectors do read them.
--
-- CELSIUS <-> FAHRENHEIT is removed from the registry outright. Polaris stores
-- and alerts in Celsius and converts at render (branding.temperatureUnit). A
-- custom widget carrying either value DID convert, so clearing it there is a
-- visible change: that widget now shows the raw reading.

UPDATE "manufacturer_profile_metrics"
   SET "defaultTransform" = NULL
 WHERE "defaultTransform" IS NOT NULL
   AND "defaultType" <> 'double_scalar'
   AND NOT ("metricKey" = 'temperature' AND "defaultType" = 'scalar' AND "defaultTransform" = 'tenths_to_units');

UPDATE "manufacturer_profile_metric_overrides" o
   SET "transform" = NULL
  FROM "manufacturer_profile_metrics" m
 WHERE o."metricRowId" = m."id"
   AND o."transform" IS NOT NULL
   AND o."type" <> 'double_scalar'
   AND NOT (m."metricKey" = 'temperature' AND o."type" = 'scalar' AND o."transform" = 'tenths_to_units');

UPDATE "manufacturer_custom_widgets"
   SET "transform" = NULL
 WHERE "transform" IN ('celsius_to_fahrenheit', 'fahrenheit_to_celsius');
