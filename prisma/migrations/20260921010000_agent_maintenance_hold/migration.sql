-- Downtime Polaris itself causes (business rule 80): an agent upgrade /
-- reinstall / uninstall holds the asset in maintenance for the duration so the
-- agent.disconnected the operator asked for does not page anyone.
--
-- The hold is the INTENT; maintenance_holds rows are what the 30s reconcile
-- diffs open windows against, exactly as it does for a schedule. expiresAt is
-- the cap that stops a release that never runs from leaving a production asset
-- unwatched forever.

CREATE TABLE "maintenance_holds" (
    "id"        TEXT NOT NULL,
    "assetId"   TEXT NOT NULL,
    "kind"      TEXT NOT NULL,
    "label"     TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "maintenance_holds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "maintenance_holds_assetId_kind_key" ON "maintenance_holds"("assetId", "kind");
CREATE INDEX "maintenance_holds_expiresAt_idx" ON "maintenance_holds"("expiresAt");

ALTER TABLE "maintenance_holds"
    ADD CONSTRAINT "maintenance_holds_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Which holder keeps a window open. NULL = schedule-driven, which is every
-- existing row: the reconcile closes a window whose holder it cannot find, so
-- a hold's window has to be able to say it belongs to a hold.
ALTER TABLE "asset_maintenance_windows" ADD COLUMN "holdKind" TEXT;
