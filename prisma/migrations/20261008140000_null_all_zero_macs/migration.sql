-- The all-zero MAC (00:00:00:00:00:00) is how FortiOS, agents and DHCP tables
-- spell "no MAC"; it is never a device's address. Every writer now refuses it
-- (utils/mac.ts isAllZeroMac). This clears the values written before that.
--
-- Matching strips separators and case so 00-00-00-00-00-00 and bare hex are
-- caught too. Reservations are deliberately NOT touched: a zero there may be a
-- mirror of the FortiGate's own reserved-address entry, and nulling it would
-- make Polaris and the gate disagree; the reservation update path refuses a
-- zero only as a change, so those rows stay editable.

-- 1. Audit row per asset whose primary MAC is cleared, written first so it can
--    read the value being removed. Timestamp is UTC explicitly: the column is
--    a naive TIMESTAMP and Prisma writes UTC, while now() would be the
--    server's local time.
INSERT INTO "events" ("id", "timestamp", "level", "levelRank", "action", "resourceType", "resourceId", "resourceName", "actor", "message", "details", "assetId")
SELECT
  gen_random_uuid()::text,
  (now() AT TIME ZONE 'UTC'),
  'info',
  0,
  'asset.mac.cleared',
  'asset',
  a."id",
  a."hostname",
  'system:migration',
  'Cleared the MAC address on "' || COALESCE(a."hostname", a."id") || '" — ' || a."macAddress" || ' is the all-zero MAC, which means "no MAC", not an address',
  jsonb_build_object('previousMacAddress', a."macAddress", 'reason', 'all-zero MAC'),
  a."id"
FROM "assets" a
WHERE regexp_replace(upper(a."macAddress"), '[^0-9A-F]', '', 'g') = '000000000000';

-- 2. Clear the primary MAC.
UPDATE "assets"
SET "macAddress" = NULL
WHERE regexp_replace(upper("macAddress"), '[^0-9A-F]', '', 'g') = '000000000000';

-- 3. Drop zero rows from the per-asset MAC list. Writers now drop them too, so
--    a reconcile would remove most of these on its own; this covers assets no
--    source reconciles any more.
DELETE FROM "asset_mac_addresses"
WHERE regexp_replace(upper("mac"), '[^0-9A-F]', '', 'g') = '000000000000';
