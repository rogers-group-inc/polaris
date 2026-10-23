-- Manufacturer custom widgets poll only the assets they are switched on for
-- (business rule 130), on their own cadence timed by the hardware-sensor
-- interval rather than riding the CPU/memory telemetry pass.

-- Presence of a row = the widget polls that asset. Both FKs cascade.
CREATE TABLE "asset_custom_widget_enables" (
    "assetId"   TEXT NOT NULL,
    "widgetId"  TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enabledBy" TEXT,
    CONSTRAINT "asset_custom_widget_enables_pkey" PRIMARY KEY ("assetId", "widgetId")
);
CREATE INDEX "asset_custom_widget_enables_widgetId_idx" ON "asset_custom_widget_enables"("widgetId");
ALTER TABLE "asset_custom_widget_enables"
    ADD CONSTRAINT "asset_custom_widget_enables_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_custom_widget_enables"
    ADD CONSTRAINT "asset_custom_widget_enables_widgetId_fkey"
    FOREIGN KEY ("widgetId") REFERENCES "manufacturer_custom_widgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The dedicated cadence's due anchor (rule 118: the scheduler reads the
-- ATTEMPT stamp; lastCustomWidgetAt stays the last success).
ALTER TABLE "assets" ADD COLUMN "lastCustomWidgetAttemptAt" TIMESTAMP(3);

-- An upgrade must not silently stop a widget that is collecting today: switch
-- on every (asset, widget) pair that produced a sample in the last 7 days.
-- New widgets, and pairs with no recent data, start OFF. The joins keep only
-- manufacturer widgets and live assets (Generic API widget ids never join).
INSERT INTO "asset_custom_widget_enables" ("assetId", "widgetId", "enabledBy")
SELECT DISTINCT s."assetId", s."widgetId", 'upgrade'
  FROM (
        SELECT "assetId", "widgetId" FROM "asset_custom_widget_samples"
         WHERE "timestamp" > CURRENT_TIMESTAMP - INTERVAL '7 days'
        UNION
        SELECT "assetId", "probeId" AS "widgetId" FROM "asset_state_samples"
         WHERE "timestamp" > CURRENT_TIMESTAMP - INTERVAL '7 days'
       ) s
  JOIN "manufacturer_custom_widgets" w ON w."id" = s."widgetId"
  JOIN "assets" a ON a."id" = s."assetId"
ON CONFLICT DO NOTHING;
