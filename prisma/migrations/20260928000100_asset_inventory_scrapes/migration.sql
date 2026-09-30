-- When each current-state inventory (processes, services) of an asset was last
-- scraped. asset_processes / asset_services move from delete-replace to a
-- delta write, so an unchanged row keeps its updatedAt and stops saying when
-- the host last reported. One row per (asset, kind), upserted with the write.
-- No FK to assets, matching asset_processes / asset_services.
--
-- Seeded from the existing inventories so a list that is already current is
-- not reported as undated until its host's next scrape.

CREATE TABLE "asset_inventory_scrapes" (
  "assetId"   TEXT NOT NULL,
  "kind"      TEXT NOT NULL,
  "scrapedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "asset_inventory_scrapes_pkey" PRIMARY KEY ("assetId", "kind")
);

INSERT INTO "asset_inventory_scrapes" ("assetId", "kind", "scrapedAt")
SELECT "assetId", 'processes', MAX("updatedAt") FROM "asset_processes" GROUP BY "assetId";

INSERT INTO "asset_inventory_scrapes" ("assetId", "kind", "scrapedAt")
SELECT "assetId", 'services', MAX("updatedAt") FROM "asset_services" GROUP BY "assetId";
