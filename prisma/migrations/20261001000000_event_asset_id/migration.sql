-- The asset an Event is ABOUT, independent of the resource it is filed under.
-- An alert's fire / clear is filed under resourceType=notification (its id is
-- the alert's), so the asset-details Events tab — which asked for
-- resourceType=asset AND resourceId=<asset> — never showed it. logEvent now
-- stamps this column; the backfill applies the same rule to the rows already
-- inside the retention window (eventAssetIdOf in eventLogService.ts).
ALTER TABLE "events" ADD COLUMN "assetId" TEXT;

UPDATE "events"
SET "assetId" = CASE
  WHEN "resourceType" = 'asset' AND "resourceId" IS NOT NULL THEN "resourceId"
  ELSE NULLIF("details"->>'assetId', '')
END
WHERE ("resourceType" = 'asset' AND "resourceId" IS NOT NULL)
   OR (jsonb_typeof("details") = 'object' AND jsonb_typeof("details"->'assetId') = 'string');

-- After the backfill, so the UPDATE is not maintaining the index row by row.
CREATE INDEX "events_assetId_timestamp_idx" ON "events"("assetId", "timestamp");
