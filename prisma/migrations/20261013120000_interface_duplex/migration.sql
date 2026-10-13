-- Negotiated duplex per interface ("full" | "half" | NULL), read by the
-- interface up / down events (interfaceLinkEventService).
--
-- asset_interface_samples is a TimescaleDB hypertable with a compression
-- policy. Plain nullable ADD COLUMN is metadata-only and safe on compressed
-- chunks; a DEFAULT is not, and there is no backfill — sample rows that could
-- sit in a compressed chunk are never row-UPDATEd. Existing rows read NULL,
-- which is also what a source with no duplex reading writes going forward.
-- The hourly / daily rollups do not carry it: duplex is current state, not a
-- trend.

ALTER TABLE "asset_interface_samples" ADD COLUMN "duplex" TEXT;

-- asset_interfaces is the plain current-state table, full-replaced per scrape.
ALTER TABLE "asset_interfaces" ADD COLUMN "duplex" TEXT;
