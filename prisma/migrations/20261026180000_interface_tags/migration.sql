-- Tags on individual interfaces (business rule 133). Keyed by ifName rather
-- than an asset_interfaces row, which is delete-replaced on every full scrape.
-- source = 'manual' (operator) | 'auto' (a tag filter's nativeVlan leaf, with
-- tagId as provenance).
CREATE TABLE "asset_interface_tags" (
    "assetId" TEXT NOT NULL,
    "ifName" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "tagId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_interface_tags_pkey" PRIMARY KEY ("assetId","ifName","tag")
);

CREATE INDEX "asset_interface_tags_tag_idx" ON "asset_interface_tags"("tag");
CREATE INDEX "asset_interface_tags_tagId_idx" ON "asset_interface_tags"("tagId");

ALTER TABLE "asset_interface_tags" ADD CONSTRAINT "asset_interface_tags_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
