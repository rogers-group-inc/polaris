-- Business rule 40(k): a decommissioned asset holds no address. The src/db.ts
-- extension now clears the primary IPv4 address (and every pin on it) on the
-- write that decommissions an asset; this clears the assets that were
-- decommissioned before that, so a replacement device stops colliding with a
-- retired one. The address stays in the asset's IP history.
--
-- Timestamps are UTC explicitly: the columns are naive TIMESTAMPs and Prisma
-- writes UTC, while now() would be the server's local time.

-- 1. Make sure every address being released has its IP-history row. An
--    existing row keeps its firstSeen / lastSeen / source.
INSERT INTO "asset_ip_history" ("id", "assetId", "ip", "source", "firstSeen", "lastSeen")
SELECT
  gen_random_uuid()::text,
  a."id",
  a."ipAddress",
  COALESCE(NULLIF(a."ipSource", ''), 'manual'),
  (now() AT TIME ZONE 'UTC'),
  (now() AT TIME ZONE 'UTC')
FROM "assets" a
WHERE a."status" = 'decommissioned' AND a."ipAddress" IS NOT NULL
ON CONFLICT ("assetId", "ip") DO NOTHING;

-- 2. Audit row per asset, written before the clear so it can read the address.
INSERT INTO "events" ("id", "timestamp", "level", "levelRank", "action", "resourceType", "resourceId", "resourceName", "actor", "message", "details", "assetId")
SELECT
  gen_random_uuid()::text,
  (now() AT TIME ZONE 'UTC'),
  'info',
  0,
  'asset.ip_released',
  'asset',
  a."id",
  a."hostname",
  'system:migration',
  'Released ' || a."ipAddress" || ' from "' || COALESCE(a."hostname", a."id") || '" — a decommissioned asset holds no address; it stays in the IP history',
  jsonb_build_object('previousIpAddress', a."ipAddress", 'previousIpSource', a."ipSource", 'reason', 'decommissioned'),
  a."id"
FROM "assets" a
WHERE a."status" = 'decommissioned' AND a."ipAddress" IS NOT NULL;

-- 3. Clear the address and every pin on it.
UPDATE "assets"
SET "ipAddress" = NULL,
    "ipSource" = NULL,
    "ipOverride" = NULL,
    "ipBlankPinned" = false,
    "ipCleared" = NULL,
    "primaryAddressMac" = NULL,
    "primaryAddressIp" = NULL,
    "primaryAddressPinnedAt" = NULL,
    "primaryAddressPinnedBy" = NULL,
    "primaryAddressContestedAt" = NULL
WHERE "status" = 'decommissioned'
  AND ("ipAddress" IS NOT NULL OR "ipOverride" IS NOT NULL OR "ipBlankPinned" OR "ipCleared" IS NOT NULL
       OR "primaryAddressMac" IS NOT NULL OR "primaryAddressIp" IS NOT NULL);
