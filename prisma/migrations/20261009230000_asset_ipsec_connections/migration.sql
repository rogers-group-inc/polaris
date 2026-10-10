-- Current-state table of who is connected through a FortiGate's IPsec /
-- SSL-VPN: a hub's ADVPN spokes and dial-up peers, a spoke's on-demand ADVPN
-- shortcuts, FortiClient remote-access users. One row per dynamic child
-- FortiOS reports under a phase-1 in /api/v2/monitor/vpn/ipsec (named
-- "<template>_<n>"), plus one per SSL-VPN session ("ssl:<index>").
--
-- Replaced per full system-info pass by persistIpsecConnections — the IPsec
-- half and the SSL-VPN half independently, each only when its own read
-- answered. NOT a TimescaleDB hypertable: plain Postgres, so
-- delete-replace-per-asset is safe (no compressed chunks), and not a
-- retention entity. The remote peer is matched to an asset at read time.

CREATE TABLE "asset_ipsec_connections" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "parentTunnel" TEXT,
    "peerId" TEXT,
    "userName" TEXT,
    "remoteGateway" TEXT,
    "tunnelIp" TEXT,
    "status" TEXT NOT NULL,
    "incomingBytes" BIGINT,
    "outgoingBytes" BIGINT,
    "connectedSince" TIMESTAMP(3),
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_ipsec_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_ipsec_connections_assetId_name_key"
    ON "asset_ipsec_connections"("assetId", "name");

CREATE INDEX "asset_ipsec_connections_assetId_idx"
    ON "asset_ipsec_connections"("assetId");

ALTER TABLE "asset_ipsec_connections"
    ADD CONSTRAINT "asset_ipsec_connections_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
