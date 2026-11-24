BEGIN;

-- Business rule 200: a source that no longer finds its device says so.
-- A live row an opt-in sweep left in place carries the time it went missing;
-- a row a sweep removed leaves a last-known copy behind for the Sources tab.
ALTER TABLE "asset_sources" ADD COLUMN "missingSince" TIMESTAMP(3);

CREATE TABLE "asset_sources_retired" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "integrationId" TEXT,
    "observed" JSONB NOT NULL DEFAULT '{}',
    "syncedAt" TIMESTAMP(3),
    "firstSeen" TIMESTAMP(3) NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL,
    "missingSince" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_sources_retired_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_sources_retired_sourceKind_externalId_key" ON "asset_sources_retired"("sourceKind", "externalId");
CREATE INDEX "asset_sources_retired_assetId_idx" ON "asset_sources_retired"("assetId");

ALTER TABLE "asset_sources_retired" ADD CONSTRAINT "asset_sources_retired_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_sources_retired" ADD CONSTRAINT "asset_sources_retired_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
