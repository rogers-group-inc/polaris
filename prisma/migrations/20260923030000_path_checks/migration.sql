-- Agent-run path checks. 2026-09-23.
--
-- An operator defines a PathCheck (HTTP / HTTPS / TCP / ICMP against a
-- URL or host, plus an optional traceroute); every host whose Polaris Agent
-- matches the check's device filter runs it on its own cadence and pushes the
-- result. Automations then set SLAs on the results through the path* metrics.
-- A check carries no threshold of its own, and nothing here moves
-- Asset.monitorStatus: a host that cannot reach a target is not a host that is
-- down.
--
-- Five parts:
--   1. `path_checks` — the definition (plain table).
--   2. `path_check_sources` — materialized (check × agent host)
--      membership plus each pair's latest result (plain table; FK cascade on
--      both sides is safe, it is small and never compressed).
--   3. `asset_path_check_samples` + `_hourly` + `_daily` — the per-run
--      time-series and its rollups.
--   4. `asset_path_check_traceroutes` — traceroute snapshots, a standalone
--      detail-only table (a path has no meaningful average) on a flat retention
--      window.
--   5. The `pathChecks` function key seeded on every role.
--
-- The sample/traceroute tables are created PLAIN here; ensureSampleHypertables
-- (timescaleService.ts) converts them to hypertables and attaches compression
-- at boot, once their names are registered in SAMPLE_TABLES / ROLLUP_TABLES /
-- STANDALONE_SAMPLE_TABLES. No FK to `assets`: a cascade DELETE matching a
-- compressed chunk decompresses it into un-truncatable bloat (the migration
-- 20260615000000 invariant), so orphaned rows age out via drop_chunks instead.
-- Composite PK (id, <time>) because create_hypertable requires the partition
-- column in the PK.

-- ─── 1. Definitions ─────────────────────────────────────────────────────
CREATE TABLE "path_checks" (
    "id"               TEXT         NOT NULL,
    "name"             TEXT         NOT NULL,
    "description"      TEXT,
    "enabled"          BOOLEAN      NOT NULL DEFAULT true,
    "kind"             TEXT         NOT NULL,
    "target"           TEXT         NOT NULL,
    "intervalSec"      INTEGER      NOT NULL DEFAULT 60,
    "timeoutMs"        INTEGER      NOT NULL DEFAULT 5000,
    "http"             JSONB,
    "traceroute"       JSONB        NOT NULL,
    "keepBodyExcerpt"  BOOLEAN      NOT NULL DEFAULT false,
    "scope"            JSONB        NOT NULL,
    "assetIds"         TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "definitionSha256" TEXT         NOT NULL,
    "createdBy"        TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    "lastReconciledAt" TIMESTAMP(3),

    CONSTRAINT "path_checks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "path_checks_name_key" ON "path_checks" ("name");

-- ─── 2. Membership + latest result ──────────────────────────────────────
CREATE TABLE "path_check_sources" (
    "id"                     TEXT         NOT NULL,
    "checkId"                TEXT         NOT NULL,
    "assetId"                TEXT         NOT NULL,
    "explicit"               BOOLEAN      NOT NULL DEFAULT false,
    "lastOk"                 BOOLEAN,
    "lastSampleAt"           TIMESTAMP(3),
    "lastLatencyMs"          DOUBLE PRECISION,
    "lastHttpStatus"         INTEGER,
    "lastError"              TEXT,
    "lastResolvedIp"         TEXT,
    "lastFailAt"             TIMESTAMP(3),
    "lastHopCount"           INTEGER,
    "lastTracerouteComplete" BOOLEAN,
    "lastPathHash"           TEXT,
    "lastTracerouteAt"       TIMESTAMP(3),
    "lastPathChangeEventAt"  TIMESTAMP(3),
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "path_check_sources_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "path_check_sources_checkId_assetId_key" ON "path_check_sources" ("checkId", "assetId");
CREATE INDEX "path_check_sources_assetId_idx" ON "path_check_sources" ("assetId");
ALTER TABLE "path_check_sources"
  ADD CONSTRAINT "path_check_sources_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "path_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "path_check_sources"
  ADD CONSTRAINT "path_check_sources_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 3. Samples + rollups ───────────────────────────────────────────────
CREATE TABLE "asset_path_check_samples" (
    "id"          TEXT             NOT NULL,
    "assetId"     TEXT             NOT NULL,
    "timestamp"   TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkId"     TEXT             NOT NULL,
    "ok"          BOOLEAN          NOT NULL,
    "latencyMs"   DOUBLE PRECISION,
    "dnsMs"       DOUBLE PRECISION,
    "connectMs"   DOUBLE PRECISION,
    "tlsMs"       DOUBLE PRECISION,
    "ttfbMs"      DOUBLE PRECISION,
    "httpStatus"  INTEGER,
    "bodyMatched" BOOLEAN,
    "bodySha256"  TEXT,
    "bodyBytes"   INTEGER,
    "bodyExcerpt" TEXT,
    "error"       TEXT,
    "resolvedIp"  TEXT,
    "tlsNotAfter" TIMESTAMP(3),
    "tlsIssuer"   TEXT,
    "hopCount"    INTEGER,
    "cadence"     TEXT,

    CONSTRAINT "asset_path_check_samples_pkey" PRIMARY KEY ("id","timestamp")
);
CREATE INDEX "asset_path_check_samples_assetId_timestamp_idx" ON "asset_path_check_samples" ("assetId", "timestamp");
CREATE INDEX "asset_path_check_samples_assetId_checkId_timestamp_idx" ON "asset_path_check_samples" ("assetId", "checkId", "timestamp");
CREATE INDEX "asset_path_check_samples_checkId_timestamp_idx" ON "asset_path_check_samples" ("checkId", "timestamp");

CREATE TABLE "asset_path_check_samples_hourly" (
    "id"                 TEXT             NOT NULL,
    "assetId"            TEXT             NOT NULL,
    "bucketStart"        TIMESTAMP(3)     NOT NULL,
    "checkId"            TEXT             NOT NULL,
    "sampleCount"        INTEGER          NOT NULL,
    "okCount"            INTEGER          NOT NULL DEFAULT 0,
    "failCount"          INTEGER          NOT NULL DEFAULT 0,
    "avgLatencyMs"       DOUBLE PRECISION,
    "minLatencyMs"       DOUBLE PRECISION,
    "maxLatencyMs"       DOUBLE PRECISION,
    "avgDnsMs"           DOUBLE PRECISION,
    "avgConnectMs"       DOUBLE PRECISION,
    "avgTlsMs"           DOUBLE PRECISION,
    "avgTtfbMs"          DOUBLE PRECISION,
    "avgHopCount"        DOUBLE PRECISION,
    "maxHopCount"        INTEGER,
    "modeHttpStatus"     INTEGER,
    "lastBucketSampleAt" TIMESTAMP(3)     NOT NULL,

    CONSTRAINT "asset_path_check_samples_hourly_pkey" PRIMARY KEY ("id","bucketStart")
);
CREATE UNIQUE INDEX "asset_path_check_samples_hourly_bucketStart_assetId_check_key" ON "asset_path_check_samples_hourly" ("bucketStart", "assetId", "checkId");
CREATE INDEX "asset_path_check_samples_hourly_assetId_bucketStart_idx" ON "asset_path_check_samples_hourly" ("assetId", "bucketStart");
CREATE INDEX "asset_path_check_samples_hourly_assetId_checkId_bucketSta_idx" ON "asset_path_check_samples_hourly" ("assetId", "checkId", "bucketStart");

CREATE TABLE "asset_path_check_samples_daily" (
    "id"                 TEXT             NOT NULL,
    "assetId"            TEXT             NOT NULL,
    "bucketStart"        TIMESTAMP(3)     NOT NULL,
    "checkId"            TEXT             NOT NULL,
    "sampleCount"        INTEGER          NOT NULL,
    "okCount"            INTEGER          NOT NULL DEFAULT 0,
    "failCount"          INTEGER          NOT NULL DEFAULT 0,
    "avgLatencyMs"       DOUBLE PRECISION,
    "minLatencyMs"       DOUBLE PRECISION,
    "maxLatencyMs"       DOUBLE PRECISION,
    "avgDnsMs"           DOUBLE PRECISION,
    "avgConnectMs"       DOUBLE PRECISION,
    "avgTlsMs"           DOUBLE PRECISION,
    "avgTtfbMs"          DOUBLE PRECISION,
    "avgHopCount"        DOUBLE PRECISION,
    "maxHopCount"        INTEGER,
    "modeHttpStatus"     INTEGER,
    "lastBucketSampleAt" TIMESTAMP(3)     NOT NULL,

    CONSTRAINT "asset_path_check_samples_daily_pkey" PRIMARY KEY ("id","bucketStart")
);
CREATE UNIQUE INDEX "asset_path_check_samples_daily_bucketStart_assetId_checkI_key" ON "asset_path_check_samples_daily" ("bucketStart", "assetId", "checkId");
CREATE INDEX "asset_path_check_samples_daily_assetId_bucketStart_idx" ON "asset_path_check_samples_daily" ("assetId", "bucketStart");
CREATE INDEX "asset_path_check_samples_daily_assetId_checkId_bucketStar_idx" ON "asset_path_check_samples_daily" ("assetId", "checkId", "bucketStart");

-- ─── 4. Traceroutes ─────────────────────────────────────────────────────
CREATE TABLE "asset_path_check_traceroutes" (
    "id"            TEXT         NOT NULL,
    "assetId"       TEXT         NOT NULL,
    "timestamp"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkId"       TEXT         NOT NULL,
    "destinationIp" TEXT,
    "complete"      BOOLEAN      NOT NULL,
    "hopCount"      INTEGER      NOT NULL,
    "hops"          JSONB        NOT NULL,
    "pathHash"      TEXT         NOT NULL,
    "reason"        TEXT         NOT NULL DEFAULT 'scheduled',
    "note"          TEXT,

    CONSTRAINT "asset_path_check_traceroutes_pkey" PRIMARY KEY ("id","timestamp")
);
CREATE INDEX "asset_path_check_traceroutes_assetId_checkId_timestamp_idx" ON "asset_path_check_traceroutes" ("assetId", "checkId", "timestamp");

-- ─── 5. Seed the `pathChecks` function key ──────────────────────
-- A check directs every matching agent to send traffic at an operator-chosen
-- destination, so it is its own grant (the networkScan precedent) rather than
-- a rung of automationManagement. Seeded FROM applicationMap: Path Monitor is
-- the page beside Application Map in the sidebar, and a role gets the same
-- level on both (built-ins: admin write, every other built-in read). The key
-- is UP_TO_WRITE, so a fullwrite folds to write; read -> read; anything else
-- -> none. `updatedAt` is bumped so the in-process role-version cache refetches
-- and live sessions see the key on their next request. Idempotent: only rows
-- that lack the key.
UPDATE "roles"
   SET "permissions" = jsonb_set(
         "permissions",
         '{pathChecks}',
         CASE "permissions" ->> 'applicationMap'
           WHEN 'fullwrite' THEN '"write"'::jsonb
           WHEN 'write'     THEN '"write"'::jsonb
           WHEN 'read'      THEN '"read"'::jsonb
           ELSE '"none"'::jsonb
         END,
         true),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE NOT ("permissions" ? 'pathChecks');
