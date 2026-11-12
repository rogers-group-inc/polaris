-- Fibre-channel port counters as a sampled series, and the port's own WWN
-- (business rule 159(a)).
--
-- asset_interface_samples and its two rollups are TimescaleDB hypertables with
-- a compression policy: a plain nullable ADD COLUMN is metadata-only and safe
-- on compressed chunks, while a DEFAULT is not (it rewrites compressed chunks).
-- So no default and no backfill, for the interface_ipv6_address migration's
-- reason. Existing rows read NULL, which is also what every non-FC interface
-- writes going forward.

ALTER TABLE "asset_interface_samples"        ADD COLUMN "fcErrors"      JSONB;

ALTER TABLE "asset_interface_samples_hourly" ADD COLUMN "firstFcErrors" JSONB;
ALTER TABLE "asset_interface_samples_hourly" ADD COLUMN "lastFcErrors"  JSONB;
ALTER TABLE "asset_interface_samples_daily"  ADD COLUMN "firstFcErrors" JSONB;
ALTER TABLE "asset_interface_samples_daily"  ADD COLUMN "lastFcErrors"  JSONB;

-- asset_interfaces is the plain current-state table, full-replaced per scrape.
ALTER TABLE "asset_interfaces" ADD COLUMN "wwn" TEXT;
