-- Drop the retired per-stream MIB pin columns (business rule 173).
--
-- 20261112180000_retire_stream_mib_pins logged every pin that could have
-- switched an asset's manufacturer profile and cleared them all; since then
-- nothing reads or writes these columns (the write schemas accept the keys
-- and drop them). The JSON tiers were cleared by the same migration. IF EXISTS
-- so a database that never had one of them still upgrades.
ALTER TABLE "assets"
  DROP COLUMN IF EXISTS "responseTimeMibId",
  DROP COLUMN IF EXISTS "cpuMemoryMibId",
  DROP COLUMN IF EXISTS "temperatureMibId",
  DROP COLUMN IF EXISTS "interfacesMibId",
  DROP COLUMN IF EXISTS "lldpMibId",
  DROP COLUMN IF EXISTS "processesMibId";

ALTER TABLE "monitor_class_overrides"
  DROP COLUMN IF EXISTS "responseTimeMibId",
  DROP COLUMN IF EXISTS "cpuMemoryMibId",
  DROP COLUMN IF EXISTS "temperatureMibId",
  DROP COLUMN IF EXISTS "interfacesMibId",
  DROP COLUMN IF EXISTS "lldpMibId",
  DROP COLUMN IF EXISTS "processesMibId";
