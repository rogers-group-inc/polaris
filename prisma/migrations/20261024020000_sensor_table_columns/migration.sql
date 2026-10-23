-- Business rule 132: a Hardware Sensors table row is declarative. Its own
-- symbol is the table's VALUE column, and these JSON columns name the
-- siblings — the row-name column, an optional alarm column and how its reading
-- becomes alarm / ok, an optional fixed sensor class, an optional scale.
-- Until now a `table` row's symbol was ignored: the collector walked
-- FortiGate's fgHwSensorTable columns from OID literals in code, for every
-- Fortinet device and for any profile whose temperature row said `table`.
ALTER TABLE "manufacturer_profile_metrics" ADD COLUMN "defaultSensorColumns" JSONB;
ALTER TABLE "manufacturer_profile_metric_overrides" ADD COLUMN "sensorColumns" JSONB;

-- The rows that pointed at fgHwSensorTable — the Phase 4 seed and its
-- migration wrote exactly this — become the same walk stated as data, so an
-- upgraded install keeps reading the sensors it read before (now resolved
-- from the uploaded FORTINET-FORTIGATE-MIB, like every other vendor symbol).
-- Any other `table` temperature row keeps its symbol, which is now honoured
-- as its value column.
UPDATE "manufacturer_profile_metrics"
SET "defaultSymbol" = 'fgHwSensorEntValue',
    "defaultSensorColumns" = '{"nameSymbol":"fgHwSensorEntName","alarmSymbol":"fgHwSensorEntAlarmStatus","alarmMap":{"mode":"nonzero","values":[],"trueLabel":"Alarm","falseLabel":"OK","trueIsProblem":true},"sensorClass":null,"transform":null}'::jsonb
WHERE "metricKey" = 'temperature'
  AND "defaultType" = 'table'
  AND lower("defaultSymbol") = 'fghwsensortable';

UPDATE "manufacturer_profile_metric_overrides" o
SET "symbol" = 'fgHwSensorEntValue',
    "sensorColumns" = '{"nameSymbol":"fgHwSensorEntName","alarmSymbol":"fgHwSensorEntAlarmStatus","alarmMap":{"mode":"nonzero","values":[],"trueLabel":"Alarm","falseLabel":"OK","trueIsProblem":true},"sensorClass":null,"transform":null}'::jsonb
FROM "manufacturer_profile_metrics" m
WHERE o."metricRowId" = m."id"
  AND m."metricKey" = 'temperature'
  AND o."type" = 'table'
  AND lower(o."symbol") = 'fghwsensortable';
