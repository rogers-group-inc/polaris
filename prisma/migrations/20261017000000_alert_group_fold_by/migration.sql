-- Alert groups may fold by subnet as well as by device (business rule 75).
ALTER TABLE "alert_groups" ADD COLUMN "foldBy" TEXT NOT NULL DEFAULT 'device';
