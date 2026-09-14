-- Controller link state for FortiGate-managed FortiSwitches and FortiAPs
-- (business rule 59).
--
-- What the parent FortiGate says about its own session to the device: the
-- FortiLink session for a switch, the CAPWAP tunnel for an AP. Both transports
-- have always fetched it (`status` off managed-switch/status and managed_ap)
-- and both already store it in the AssetSource observed blob -- it simply had
-- no projected home, so nothing could display it and no automation could read
-- it.
--
-- Four columns rather than a key on `fortinetTopology`: that blob is rewritten
-- wholesale by discovery on every cycle, and the 60s sweep read-modify-writing
-- it would lose-update the discovery stamp. Scalar columns also let the
-- automation engine read the field straight off the scope row, the same way
-- monitorStatus / dependencySuppressed are read.
--
-- All four are nullable with no backfill, and null is meaningful: "never
-- swept". Every FortiGate-managed switch and AP acquires a value on the first
-- sweep tick after deploy (60s); everything else keeps null forever, which is
-- what the asset-details row and the automation resolver both read as "not
-- applicable".
--
-- No index: the sweep loads by (assetType, discoveredByIntegrationId), which
-- existing indexes already cover, and the automation engine filters in memory
-- off the scope row. An index here would be write cost on a hot column for no
-- reader.

ALTER TABLE "assets" ADD COLUMN "fortilinkStatus" TEXT;
ALTER TABLE "assets" ADD COLUMN "fortilinkStatusRaw" TEXT;
ALTER TABLE "assets" ADD COLUMN "fortilinkCheckedAt" TIMESTAMP(3);
ALTER TABLE "assets" ADD COLUMN "fortilinkChangedAt" TIMESTAMP(3);
