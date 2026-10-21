-- Per-interface IPv6 address (business rule 126). Every interface row held ONE
-- bare address in "ipAddress"; IPv4 stays there, and the interface's first
-- reportable IPv6 address (never loopback / link-local) goes in its own column.
--
-- asset_interfaces is an ordinary table. asset_interface_samples and its two
-- rollups are TimescaleDB hypertables with a compression policy: a plain
-- nullable ADD COLUMN is metadata-only and safe on compressed chunks, while a
-- DEFAULT is not (it forces a rewrite of compressed chunks — the bloat failure
-- recorded against these tables). So: no default, and no backfill, for the
-- interface_poe migration's reason. Existing rows read NULL, which is also
-- what an IPv4-only interface writes going forward.

ALTER TABLE "asset_interfaces"               ADD COLUMN "ipv6Address"     TEXT;

ALTER TABLE "asset_interface_samples"        ADD COLUMN "ipv6Address"     TEXT;

ALTER TABLE "asset_interface_samples_hourly" ADD COLUMN "lastIpv6Address" TEXT;
ALTER TABLE "asset_interface_samples_daily"  ADD COLUMN "lastIpv6Address" TEXT;
