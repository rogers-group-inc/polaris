-- A manufacturer profile's `serial` identity row (business rule 171): which
-- vendor scalar carries the device's own serial number, for a device whose
-- serial is in no standard MIB (an APC Smart-UPS's upsAdvIdentSerialNumber).
-- One empty row per existing profile, like every other metric key; a new or
-- seeded profile gets it from METRIC_KEYS. Additive, and a no-op on a profile
-- that already has one.
INSERT INTO "manufacturer_profile_metrics" ("id", "profileId", "metricKey", "defaultType")
SELECT gen_random_uuid()::text, p."id", 'serial', 'scalar'
  FROM "manufacturer_profiles" p
 WHERE NOT EXISTS (
   SELECT 1 FROM "manufacturer_profile_metrics" m WHERE m."profileId" = p."id" AND m."metricKey" = 'serial'
 );
