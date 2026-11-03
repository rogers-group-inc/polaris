-- One FortiGate sighting row per (asset, gate, binding kind), not per (asset,
-- gate): a gate holding both a DHCP lease and a reservation for the device
-- keeps both rows, so the asset's Firewall Sightings shows each. Existing rows
-- are already unique on the narrower key, so nothing needs folding.
DROP INDEX IF EXISTS "asset_fortigate_sightings_assetId_fortigateDevice_key";

CREATE UNIQUE INDEX "asset_fortigate_sightings_assetId_fortigateDevice_source_key"
  ON "asset_fortigate_sightings" ("assetId", "fortigateDevice", "source");
