-- New function key `firmware` — the firmware repository for switches and
-- access points (business rule 87), 2026-09-25.
--
-- Ladder: none | read | write | fullwrite.
--   read      see the Repository tab and whether an asset has an upgrade
--   write     upload / delete images, bind a device-admin login at a
--             manufacturer, device-type or model node
--   fullwrite START AN UPGRADE — the named act rule 43(d) requires for a
--             fourth rung. A flash reboots a switch or an access point and
--             everything behind it; it is the most consequential thing an
--             operator can do to network hardware from here.
--
-- SEEDING. "Nobody gains anything they could not already do" — and nothing in
-- the catalogue implied this act before now, so there is no existing rung to
-- derive from (the `authentication` key could derive from serverSettingsSystem
-- because its routes MOVED; nothing moves here). Admin-equivalent roles —
-- users=fullwrite AND roles=fullwrite, the same definition the last-admin
-- guard uses — get fullwrite, because they can already grant themselves any
-- key. Every other role, including the built-in `readonly`, gets none: even
-- the read rung shows new information (which devices are behind on firmware),
-- and that is a grant an admin should make on purpose.
--
-- `updatedAt` is bumped so the in-process role-version cache refetches and live
-- sessions see the key on their next request. One correlated expression per
-- row, never `UPDATE ... FROM (VALUES …)` — see 20260922000000_rbac_catalogue_hygiene.

UPDATE "roles"
   SET "permissions" = jsonb_set(
         "permissions",
         '{firmware}',
         CASE
           WHEN "permissions" ->> 'users' = 'fullwrite' AND "permissions" ->> 'roles' = 'fullwrite'
             THEN '"fullwrite"'::jsonb
           ELSE '"none"'::jsonb
         END,
         true),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE NOT ("permissions" ? 'firmware');
