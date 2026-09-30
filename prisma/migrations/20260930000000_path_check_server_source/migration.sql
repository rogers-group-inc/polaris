-- A path check can also run from the Polaris server itself
-- (PathCheck.runOnServer). The server is not an asset, so its membership row
-- in path_check_sources carries assetId NULL; its samples and traceroutes use
-- the reserved subject id 'polaris-server' in their (FK-less) assetId column.
ALTER TABLE "path_checks" ADD COLUMN "runOnServer" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "path_check_sources" ALTER COLUMN "assetId" DROP NOT NULL;

-- (checkId, assetId) is unique, but NULLs are distinct in a unique index, so
-- the one-server-row-per-check rule needs its own partial index.
CREATE UNIQUE INDEX "path_check_sources_server_key"
  ON "path_check_sources" ("checkId")
  WHERE "assetId" IS NULL;
