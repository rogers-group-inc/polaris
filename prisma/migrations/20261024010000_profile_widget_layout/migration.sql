-- The Custom MIB tab's widget arrangement, per manufacturer profile (the
-- dashboard's column model, edited with the tab's pencil button). NULL keeps
-- the default auto-fit grid, so existing profiles render exactly as before.
ALTER TABLE "manufacturer_profiles" ADD COLUMN "widgetLayout" JSONB;
