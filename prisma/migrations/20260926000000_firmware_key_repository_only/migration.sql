-- The `firmware` function key now governs the Firmware Repository only
-- (business rule 87, operator decision 2026-09-26): Read sees it, Read-Write
-- uploads and manages images. Starting an upgrade moved to `assets:write`, so
-- the key's ladder is none / read / write and its Full Read-Write rung is gone.
--
-- normalizePermissions already clamps a stored `fullwrite` down to `write` on
-- every read, so nothing breaks without this. It rewrites the stored matrices
-- so the rows say what the app enforces — a role export or a direct SQL read
-- would otherwise still show a rung no route asks for. Idempotent.
UPDATE "roles"
   SET "permissions" = jsonb_set("permissions", '{firmware}', '"write"'::jsonb, false),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "permissions" ->> 'firmware' = 'fullwrite';
