-- Business rule 182: a floor plan imported from a DXF keeps what Polaris read from it.
ALTER TABLE "topology_background_images" ADD COLUMN "cad" JSONB;
