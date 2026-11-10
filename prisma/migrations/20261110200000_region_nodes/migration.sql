-- A site's region tree (business rule 153). New table only: no existing
-- row, column or description is touched. Empty until an operator builds it
-- from the site's descriptions or adds regions, and until then every
-- device's location reads exactly as before.

CREATE TABLE "region_nodes" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" TEXT,
    "unique_key" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "region_nodes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "region_nodes_site_id_idx" ON "region_nodes"("site_id");
CREATE UNIQUE INDEX "region_nodes_site_id_unique_key_key" ON "region_nodes"("site_id", "unique_key");

ALTER TABLE "region_nodes" ADD CONSTRAINT "region_nodes_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "region_nodes" ADD CONSTRAINT "region_nodes_parent_id_fkey"
    FOREIGN KEY ("parent_id") REFERENCES "region_nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
