-- Business rule 137: a switch that inherited a tag from a network its FortiGate
-- serves. Provenance only — the tag itself lives in assets.tags, and inherited
-- PORT tags are asset_interface_tags rows with source 'network'.
CREATE TABLE "network_tag_assignments" (
    "assetId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "network_tag_assignments_pkey" PRIMARY KEY ("assetId","tag")
);

CREATE INDEX "network_tag_assignments_tag_idx" ON "network_tag_assignments"("tag");
