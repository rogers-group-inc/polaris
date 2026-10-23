-- Business rule 87, amended 2026-10-23: the primary / backup pair belongs to a PLATFORM under a
-- model node, not to the node. A node can hold several platforms (a standalone FortiGate
-- integration files every gate under the literal model "FortiGate"), and the per-node pair let
-- an upload for one platform demote, and the next one delete, another platform's primary.
--
-- An image with no recognised platform (NULL) is never offered to a device; those rows share
-- one pair per node, through COALESCE, as before.

DROP INDEX IF EXISTS "firmware_images_primary_key";
DROP INDEX IF EXISTS "firmware_images_backup_key";

-- Repair what the per-node pair already did: a backup whose platform has no primary under its
-- node was a primary demoted by another platform's upload, and a backup alone is never offered.
-- The old index allowed one backup per node, so this promotes at most one row per node and the
-- new per-platform primary index below cannot be violated by it.
UPDATE "firmware_images" b
SET "role" = 'primary'
WHERE b."role" = 'backup'
  AND NOT EXISTS (
    SELECT 1 FROM "firmware_images" p
    WHERE p."role" = 'primary'
      AND p."manufacturer" = b."manufacturer"
      AND p."assetType" = b."assetType"
      AND p."model" = b."model"
      AND COALESCE(p."platform", '') = COALESCE(b."platform", '')
  );

CREATE UNIQUE INDEX "firmware_images_primary_key"
    ON "firmware_images"("manufacturer", "assetType", "model", (COALESCE("platform", ''))) WHERE "role" = 'primary';
CREATE UNIQUE INDEX "firmware_images_backup_key"
    ON "firmware_images"("manufacturer", "assetType", "model", (COALESCE("platform", ''))) WHERE "role" = 'backup';
