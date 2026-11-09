-- Max lines on rollup-tier charts. Two streams kept nothing a max line could
-- be drawn from once the detail rows aged out:
--
--   * per-core CPU: the telemetry rollups gain the bucket's per-core average
--     and per-core maximum, each a jsonb array indexed like the detail row's
--     "cpuCorePcts" (a core with no reading in the bucket is a JSON null in
--     its slot);
--   * interface throughput: the interface rollups gain the highest per-poll
--     rate inside the bucket, in bytes per second.
--
-- All four tables are TimescaleDB hypertables with a compression policy. A
-- plain nullable ADD COLUMN is metadata-only and safe on compressed chunks; a
-- DEFAULT is not (it rewrites them). So: no default and no backfill here.
-- Existing rows read NULL. The recent past (inside the detail window and the
-- uncompressed frontier) is rebuilt once by the rollupMaxLinesBackfill pass in
-- src/jobs/runSampleRollup.ts.

ALTER TABLE "asset_telemetry_samples_hourly" ADD COLUMN "avgCpuCorePcts" JSONB,
ADD COLUMN "maxCpuCorePcts" JSONB;

ALTER TABLE "asset_telemetry_samples_daily" ADD COLUMN "avgCpuCorePcts" JSONB,
ADD COLUMN "maxCpuCorePcts" JSONB;

ALTER TABLE "asset_interface_samples_hourly" ADD COLUMN "maxInBytesPerSec" DOUBLE PRECISION,
ADD COLUMN "maxOutBytesPerSec" DOUBLE PRECISION;

ALTER TABLE "asset_interface_samples_daily" ADD COLUMN "maxInBytesPerSec" DOUBLE PRECISION,
ADD COLUMN "maxOutBytesPerSec" DOUBLE PRECISION;
