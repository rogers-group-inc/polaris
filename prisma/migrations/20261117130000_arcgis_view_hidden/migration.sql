-- Rule 188(c): a Topology view no longer lists the ArcGIS layers it draws.
-- Every layer whose area covers the map is drawn, and a view stores only what
-- it HIDES (`<layerId>`, `<layerId>:<type value>`, `<layerId>#other`), so a
-- layer or type added later shows by itself. The per-view layer lists saved
-- since 2026-11-16 are dropped: every view starts automatic.
ALTER TABLE "topology_views" DROP COLUMN "arcgis_layers";
ALTER TABLE "topology_views" ADD COLUMN "arcgis_hidden" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
