-- The map regions an account has hidden with the Device Map Regions panel's
-- eyes. Server-side so the desktop page and the phone's Map tab honour the
-- same choice (it was per-browser localStorage before). MapRegion ids, no FK:
-- a deleted region's id is simply never matched.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "hidden_map_region_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];
