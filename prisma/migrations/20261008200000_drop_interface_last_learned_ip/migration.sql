-- "Skip unused ports" (business rule 88) is retired in favour of the SD-WAN
-- member IP address filter (business rule 98). Its only reader was
-- isUnusedPort; nothing else uses the remembered address, so the columns go
-- with it rather than being kept up to date for nobody.
ALTER TABLE "asset_interfaces" DROP COLUMN IF EXISTS "lastLearnedIp";
ALTER TABLE "asset_interfaces" DROP COLUMN IF EXISTS "lastLearnedIpAt";
