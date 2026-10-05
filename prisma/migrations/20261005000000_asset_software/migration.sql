-- Installed software per asset (the asset view's Software tab).
--
-- Current state, one row per (asset, source, program), where source is the
-- writer that owns the row: "agent" (the agent's softwareInventory stream),
-- "intune" (Intune detected apps, read during an Entra/Intune discovery run)
-- or "arc" (Azure Change Tracking's software inventory, read during an Azure
-- Arc discovery run). Delta-written like asset_services, so freshness per
-- source lives in asset_inventory_scrapes under the kinds "software",
-- "software:intune" and "software:arc".
--
-- Unlike asset_processes / asset_services this table has a real foreign key
-- to assets: deleting an asset deletes its software list.
--
-- Additive only: a new table and a nullable column. Nothing reads either until
-- a source writes, so an install that never enables one reads as before.

CREATE TABLE "asset_software" (
  "id"           TEXT         NOT NULL,
  "assetId"      TEXT         NOT NULL,
  "source"       TEXT         NOT NULL,
  "key"          TEXT         NOT NULL,
  "name"         TEXT         NOT NULL,
  "version"      TEXT,
  "publisher"    TEXT,
  "architecture" TEXT,
  "platform"     TEXT,
  "installDate"  DATE,
  "sizeBytes"    BIGINT,
  "firstSeenAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "asset_software_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_software_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "asset_software_assetId_source_key_key" ON "asset_software"("assetId", "source", "key");
CREATE INDEX "asset_software_assetId_idx" ON "asset_software"("assetId");

-- The source's own version of a list (Intune lastSyncDateTime), so a discovery
-- run skips a device whose detected apps cannot have changed.
ALTER TABLE "asset_inventory_scrapes" ADD COLUMN "stamp" TEXT;
