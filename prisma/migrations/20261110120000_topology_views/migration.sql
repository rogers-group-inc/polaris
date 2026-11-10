-- Topology views (business rules 147-149): named per-site Device Map views,
-- one mode each (layer2 / topology / rack), plus the uploaded background
-- image of a topology-mode view.

CREATE TABLE "topology_views" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'layer2',
    "shown_types" TEXT[] DEFAULT ARRAY['firewall', 'router', 'switch', 'access_point']::TEXT[],
    "background" JSONB,
    "polygons" JSONB NOT NULL DEFAULT '[]',
    "racks" JSONB NOT NULL DEFAULT '[]',
    "rack_placements" JSONB NOT NULL DEFAULT '[]',
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topology_views_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "topology_views_site_id_idx" ON "topology_views"("site_id");
CREATE UNIQUE INDEX "topology_views_site_id_name_key" ON "topology_views"("site_id", "name");
-- At most one default view per site (not expressible in Prisma's schema).
CREATE UNIQUE INDEX "topology_views_one_default" ON "topology_views"("site_id") WHERE "is_default";

ALTER TABLE "topology_views" ADD CONSTRAINT "topology_views_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "topology_background_images" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "view_id" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploaded_by" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topology_background_images_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "topology_background_images_view_id_idx" ON "topology_background_images"("view_id");
CREATE INDEX "topology_background_images_site_id_idx" ON "topology_background_images"("site_id");

ALTER TABLE "topology_background_images" ADD CONSTRAINT "topology_background_images_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "topology_background_images" ADD CONSTRAINT "topology_background_images_view_id_fkey"
    FOREIGN KEY ("view_id") REFERENCES "topology_views"("id") ON DELETE CASCADE ON UPDATE CASCADE;
