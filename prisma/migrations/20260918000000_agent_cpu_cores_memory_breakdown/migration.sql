-- Per-core CPU + memory breakdown for the Polaris Agent.
--
-- Two additions to the shared telemetry stream, both agent-only today and
-- both null for every other transport (FortiOS, SNMP, WinRM, vCenter):
--
--   1. cpuCorePcts — a jsonb array of per-logical-core utilisation, index =
--      core id. jsonb rather than DOUBLE PRECISION[] because null has to mean
--      "this source does not break CPU down by core", which a Prisma scalar
--      list cannot express. DETAIL TIER ONLY — the rollups deliberately do
--      not carry it (element-wise averaging a variable-length array per
--      asset-bucket is the one aggregate that does not pay for itself at
--      fleet scale), so a rollup-tier range charts aggregate CPU alone.
--
--   2. The memory bands the existing memUsedBytes is NOT: buffers, cache,
--      free, plus swap / page-file used and total. The agent reconciles the
--      per-OS figures so the four physical bands sum exactly to
--      memTotalBytes; swap is backing store and stacks with nothing.
--
-- TimescaleDB / compressed-hypertable note: all three tables are hypertables
-- with an active compression policy. ADD COLUMN of a NULLABLE column with NO
-- DEFAULT is a catalog-only operation TimescaleDB supports with compressed
-- chunks present — no chunk rewrite, no decompression. Do not give any of
-- these a DEFAULT, and do not backfill: existing rows live in compressed
-- chunks where UPDATE is refused, and "no breakdown was collected" is the
-- honest reading of a null here anyway.

ALTER TABLE "asset_telemetry_samples"
  ADD COLUMN "cpuCorePcts"     JSONB,
  ADD COLUMN "memBuffersBytes" BIGINT,
  ADD COLUMN "memCachedBytes"  BIGINT,
  ADD COLUMN "memFreeBytes"    BIGINT,
  ADD COLUMN "swapUsedBytes"   BIGINT,
  ADD COLUMN "swapTotalBytes"  BIGINT;

ALTER TABLE "asset_telemetry_samples_hourly"
  ADD COLUMN "avgMemBuffersBytes" BIGINT,
  ADD COLUMN "avgMemCachedBytes"  BIGINT,
  ADD COLUMN "avgMemFreeBytes"    BIGINT,
  ADD COLUMN "avgSwapUsedBytes"   BIGINT,
  ADD COLUMN "lastSwapTotalBytes" BIGINT;

ALTER TABLE "asset_telemetry_samples_daily"
  ADD COLUMN "avgMemBuffersBytes" BIGINT,
  ADD COLUMN "avgMemCachedBytes"  BIGINT,
  ADD COLUMN "avgMemFreeBytes"    BIGINT,
  ADD COLUMN "avgSwapUsedBytes"   BIGINT,
  ADD COLUMN "lastSwapTotalBytes" BIGINT;
