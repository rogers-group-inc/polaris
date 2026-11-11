-- Topology views, second round (business rules 150-152):
--   region          — the one location region a view stands for (codes), or null
--   walls           — a Wall view's walls [{id, name, width, height, order}] (inches)
--   wall_placements — what is mounted on them: polygons in wall inches
--   layers          — a Topology view's floor layers [{level, name, background}]
-- All additive and defaulted, so existing views read exactly as before.

ALTER TABLE "topology_views" ADD COLUMN "region" JSONB;
ALTER TABLE "topology_views" ADD COLUMN "walls" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "topology_views" ADD COLUMN "wall_placements" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "topology_views" ADD COLUMN "layers" JSONB NOT NULL DEFAULT '[]';
