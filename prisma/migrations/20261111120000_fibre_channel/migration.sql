-- Fibre-channel switch ports and logins (business rule 156). New tables only:
-- nothing existing is touched. Filled by the SNMP system-info pass for a device
-- that publishes CISCO-FC-FE-MIB; empty everywhere else.

-- CreateTable
CREATE TABLE "asset_fc_ports" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "ifIndex" INTEGER NOT NULL,
    "ifName" TEXT,
    "errorCounters" JSONB,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_fc_ports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_fc_logins" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "ifIndex" INTEGER NOT NULL,
    "ifName" TEXT,
    "vsan" INTEGER NOT NULL,
    "portWwn" TEXT NOT NULL,
    "nodeWwn" TEXT,
    "fcid" TEXT,
    "symbolicName" TEXT,
    "hostName" TEXT,
    "hbaModel" TEXT,
    "hbaFirmware" TEXT,
    "hbaDriver" TEXT,
    "osInfo" TEXT,
    "matchedAssetId" TEXT,
    "matchMethod" TEXT,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_fc_logins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_fc_ports_assetId_idx" ON "asset_fc_ports"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_fc_ports_assetId_ifIndex_key" ON "asset_fc_ports"("assetId", "ifIndex");

-- CreateIndex
CREATE INDEX "asset_fc_logins_assetId_idx" ON "asset_fc_logins"("assetId");

-- CreateIndex
CREATE INDEX "asset_fc_logins_matchedAssetId_idx" ON "asset_fc_logins"("matchedAssetId");

-- CreateIndex
CREATE INDEX "asset_fc_logins_portWwn_idx" ON "asset_fc_logins"("portWwn");

-- CreateIndex
CREATE UNIQUE INDEX "asset_fc_logins_assetId_ifIndex_vsan_portWwn_key" ON "asset_fc_logins"("assetId", "ifIndex", "vsan", "portWwn");

-- AddForeignKey
ALTER TABLE "asset_fc_ports" ADD CONSTRAINT "asset_fc_ports_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_fc_logins" ADD CONSTRAINT "asset_fc_logins_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_fc_logins" ADD CONSTRAINT "asset_fc_logins_matchedAssetId_fkey" FOREIGN KEY ("matchedAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

