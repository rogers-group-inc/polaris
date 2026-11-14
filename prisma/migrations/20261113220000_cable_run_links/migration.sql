-- Business rule 184(a): a device link routed through cable runs.
--
-- One row per link that rides at least one run: the link's Topology path key
-- (the key its bends already use) → the ordered run ids it is drawn through.
-- Owned by the SITE like the runs, cascade-deleted with it. Polaris-only
-- layout: never written to ArcGIS.

CREATE TABLE "cable_run_links" (
    "id"         TEXT         NOT NULL,
    "site_id"    TEXT         NOT NULL,
    "path_key"   TEXT         NOT NULL,
    "run_ids"    TEXT[],
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cable_run_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cable_run_links_site_id_path_key_key" ON "cable_run_links"("site_id", "path_key");

ALTER TABLE "cable_run_links"
  ADD CONSTRAINT "cable_run_links_site_id_fkey"
  FOREIGN KEY ("site_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
