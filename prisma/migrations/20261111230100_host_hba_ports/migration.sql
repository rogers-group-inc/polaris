-- Host-side fibre-channel HBA ports (business rule 159): what the Polaris Agent
-- and vCenter report about a server's own HBAs. New table only.

-- CreateTable
CREATE TABLE "asset_hba_ports" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "portWwn" TEXT NOT NULL,
    "nodeWwn" TEXT,
    "name" TEXT,
    "portState" TEXT,
    "speed" TEXT,
    "fabricWwn" TEXT,
    "model" TEXT,
    "firmware" TEXT,
    "driver" TEXT,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_hba_ports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_hba_ports_portWwn_idx" ON "asset_hba_ports"("portWwn");

-- CreateIndex
CREATE UNIQUE INDEX "asset_hba_ports_assetId_source_portWwn_key" ON "asset_hba_ports"("assetId", "source", "portWwn");

-- AddForeignKey
ALTER TABLE "asset_hba_ports" ADD CONSTRAINT "asset_hba_ports_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

