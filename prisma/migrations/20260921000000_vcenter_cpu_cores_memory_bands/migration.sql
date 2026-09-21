-- vCenter per-core CPU + its own memory breakdown.
--
-- `cpuCorePcts` needs no column: vCenter fills the jsonb array the
-- 20260918 agent migration added, with a VM's per-vCPU usage or an ESXi
-- host's per-physical-core usage, read from the PerformanceManager's
-- REAL-TIME (20s) interval. Real-time is the only interval that carries
-- per-instance data on a default install — the historical rollups are gated
-- on the vCenter statistics level, which is 1 out of the box and keeps the
-- aggregate alone. Same detail-tier-only rule as the agent's: the rollups
-- below deliberately do not carry the vector.
--
-- The memory bands DO need columns, because vSphere measures something the
-- agent's buffers/cache/free vocabulary cannot express. It reports how the
-- HYPERVISOR is backing the guest's RAM, so the two band sets are disjoint
-- and a row carries one or the other, never both:
--
--   VM, against its configured RAM:
--     private + shared + ballooned + swapped + compressed + untouched
--   ESXi host, against installed RAM:
--     consumed + ballooned + swapped + free
--
-- A host never sets private/shared/compressed and a VM never sets consumed.
-- Host "shared" is a subset of consumed and is deliberately NOT collected —
-- stacking both would double-count the same machine pages.
--
-- TimescaleDB / compressed-hypertable note: all three tables are hypertables
-- with an active compression policy. ADD COLUMN of a NULLABLE column with NO
-- DEFAULT is a catalog-only operation TimescaleDB supports with compressed
-- chunks present — no chunk rewrite, no decompression. Do not give any of
-- these a DEFAULT, and do not backfill: existing rows live in compressed
-- chunks where UPDATE is refused, and "no breakdown was collected" is the
-- honest reading of a null here anyway.

ALTER TABLE "asset_telemetry_samples"
  ADD COLUMN "memPrivateBytes"    BIGINT,
  ADD COLUMN "memSharedBytes"     BIGINT,
  ADD COLUMN "memBalloonedBytes"  BIGINT,
  ADD COLUMN "memSwappedBytes"    BIGINT,
  ADD COLUMN "memCompressedBytes" BIGINT,
  ADD COLUMN "memConsumedBytes"   BIGINT;

ALTER TABLE "asset_telemetry_samples_hourly"
  ADD COLUMN "avgMemPrivateBytes"    BIGINT,
  ADD COLUMN "avgMemSharedBytes"     BIGINT,
  ADD COLUMN "avgMemBalloonedBytes"  BIGINT,
  ADD COLUMN "avgMemSwappedBytes"    BIGINT,
  ADD COLUMN "avgMemCompressedBytes" BIGINT,
  ADD COLUMN "avgMemConsumedBytes"   BIGINT;

ALTER TABLE "asset_telemetry_samples_daily"
  ADD COLUMN "avgMemPrivateBytes"    BIGINT,
  ADD COLUMN "avgMemSharedBytes"     BIGINT,
  ADD COLUMN "avgMemBalloonedBytes"  BIGINT,
  ADD COLUMN "avgMemSwappedBytes"    BIGINT,
  ADD COLUMN "avgMemCompressedBytes" BIGINT,
  ADD COLUMN "avgMemConsumedBytes"   BIGINT;
