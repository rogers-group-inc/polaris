-- Business rule 196: a dial-up IPsec template's running byte total, kept
-- across sessions that end. Plain current-state table (not a hypertable).
CREATE TABLE "asset_ipsec_template_totals" (
    "assetId" TEXT NOT NULL,
    "tunnelName" TEXT NOT NULL,
    "incomingBytes" BIGINT NOT NULL DEFAULT 0,
    "outgoingBytes" BIGINT NOT NULL DEFAULT 0,
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_ipsec_template_totals_pkey" PRIMARY KEY ("assetId","tunnelName")
);

ALTER TABLE "asset_ipsec_template_totals" ADD CONSTRAINT "asset_ipsec_template_totals_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
