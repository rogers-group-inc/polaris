-- The last addressed IP each interface reported, carried across the
-- delete-replace in persistInterfaceRows (see AssetInterface.lastLearnedIp).
ALTER TABLE "asset_interfaces" ADD COLUMN "lastLearnedIp" TEXT;
ALTER TABLE "asset_interfaces" ADD COLUMN "lastLearnedIpAt" TIMESTAMP(3);

-- Seed from what each port reports right now, in the same bare form the
-- writer stores ("10.4.1.1/24" and the FortiOS CMDB pair "10.4.1.1
-- 255.255.255.0" both become "10.4.1.1" — utils/cidr.bareInterfaceIp).
-- An unaddressed port (0.0.0.0, blank, null) starts with nothing, exactly as
-- a port that has never been connected should. A port that is down at upgrade
-- time with a DHCP WAN's 0.0.0.0 therefore starts unlearned too; it learns on
-- its next addressed poll. One UPDATE over the current-state table, not the
-- sample hypertable.
UPDATE "asset_interfaces"
SET "lastLearnedIp"   = split_part(regexp_replace(btrim("ipAddress"), '/.*$', ''), ' ', 1),
    "lastLearnedIpAt" = "lastSeen"
WHERE "ipAddress" IS NOT NULL
  AND split_part(regexp_replace(btrim("ipAddress"), '/.*$', ''), ' ', 1) NOT IN ('', '0.0.0.0');
