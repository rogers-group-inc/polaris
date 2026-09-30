-- Firmware repository for switches and access points (business rule 87),
-- 2026-09-25. Three tables:
--
--   firmware_images             one uploaded .out, filed under a
--                               manufacturer › device type › model node; its
--                               PLATFORM (the image header's serial-prefix
--                               token) is what an asset is matched on.
--   firmware_credential_bindings which device-admin login (an `http`
--                               Credential in authMode "form") signs in at a
--                               manufacturer, a device type, or a model.
--   firmware_upgrade_runs       one row per flash, identity snapshotted so
--                               history survives the image being rotated out.
--
-- The constraints below the CREATE TABLEs are the parts Prisma cannot express
-- (the ManufacturerProfileMetricOverride precedent): CHECKs and PARTIAL unique
-- indexes. They ARE the rules — a model node holds one primary and one backup
-- image, a binding scope exists once, one live run per asset — so they live in
-- the database rather than as conventions the service has to remember.

CREATE TABLE "firmware_images" (
    "id"           TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "assetType"    TEXT NOT NULL,
    "model"        TEXT NOT NULL,
    "platform"     TEXT,
    "versionMajor" INTEGER,
    "versionMinor" INTEGER,
    "versionPatch" INTEGER,
    "build"        INTEGER,
    "versionLabel" TEXT NOT NULL,
    "parsedFrom"   TEXT NOT NULL,
    "role"         TEXT NOT NULL DEFAULT 'primary',
    "filename"     TEXT NOT NULL,
    "sizeBytes"    INTEGER NOT NULL,
    "sha256"       TEXT NOT NULL,
    "storagePath"  TEXT NOT NULL,
    "notes"        TEXT,
    "uploadedBy"   TEXT,
    "uploadedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "firmware_images_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "firmware_images_sha256_key" ON "firmware_images"("sha256");
CREATE INDEX "firmware_images_manufacturer_assetType_platform_idx" ON "firmware_images"("manufacturer", "assetType", "platform");
CREATE INDEX "firmware_images_manufacturer_assetType_model_idx" ON "firmware_images"("manufacturer", "assetType", "model");

-- Switches and access points only — the repository's whole scope.
ALTER TABLE "firmware_images"
    ADD CONSTRAINT "firmware_images_asset_type_check"
    CHECK ("assetType" IN ('switch', 'access_point'));
-- 'swapping' exists only INSIDE the make-primary transaction: the two partial
-- unique indexes below are checked per statement, so swapping two roles needs
-- a third value to step through. No row ever commits with it.
ALTER TABLE "firmware_images"
    ADD CONSTRAINT "firmware_images_role_check"
    CHECK ("role" IN ('primary', 'backup', 'swapping'));
-- The two-image cap: at most one primary and one backup per model node.
CREATE UNIQUE INDEX "firmware_images_primary_key"
    ON "firmware_images"("manufacturer", "assetType", "model") WHERE "role" = 'primary';
CREATE UNIQUE INDEX "firmware_images_backup_key"
    ON "firmware_images"("manufacturer", "assetType", "model") WHERE "role" = 'backup';

CREATE TABLE "firmware_credential_bindings" (
    "id"           TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "assetType"    TEXT,
    "model"        TEXT,
    "credentialId" TEXT,
    "createdBy"    TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "firmware_credential_bindings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "firmware_credential_bindings_manufacturer_assetType_model_idx" ON "firmware_credential_bindings"("manufacturer", "assetType", "model");

ALTER TABLE "firmware_credential_bindings"
    ADD CONSTRAINT "firmware_credential_bindings_credentialId_fkey"
    FOREIGN KEY ("credentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A model node lives under a device type, and the type is one of the two.
ALTER TABLE "firmware_credential_bindings"
    ADD CONSTRAINT "firmware_credential_bindings_scope_check"
    CHECK ("model" IS NULL OR "assetType" IS NOT NULL);
ALTER TABLE "firmware_credential_bindings"
    ADD CONSTRAINT "firmware_credential_bindings_type_check"
    CHECK ("assetType" IS NULL OR "assetType" IN ('switch', 'access_point'));
-- One binding per tree node. NULLs are distinct in a plain unique index, so
-- each scope shape gets its own partial index.
CREATE UNIQUE INDEX "firmware_bindings_manufacturer_key"
    ON "firmware_credential_bindings"("manufacturer") WHERE "assetType" IS NULL;
CREATE UNIQUE INDEX "firmware_bindings_type_key"
    ON "firmware_credential_bindings"("manufacturer", "assetType") WHERE "assetType" IS NOT NULL AND "model" IS NULL;
CREATE UNIQUE INDEX "firmware_bindings_model_key"
    ON "firmware_credential_bindings"("manufacturer", "assetType", "model") WHERE "model" IS NOT NULL;

CREATE TABLE "firmware_upgrade_runs" (
    "id"              TEXT NOT NULL,
    "assetId"         TEXT NOT NULL,
    "imageId"         TEXT,
    "platform"        TEXT NOT NULL,
    "fromVersion"     TEXT,
    "toVersion"       TEXT NOT NULL,
    "engine"          TEXT NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'queued',
    "stage"           TEXT,
    "progress"        JSONB,
    "log"             JSONB NOT NULL DEFAULT '[]',
    "result"          TEXT,
    "error"           TEXT,
    "verifiedVersion" TEXT,
    "startedBy"       TEXT NOT NULL,
    "heartbeatAt"     TIMESTAMP(3),
    "startedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt"      TIMESTAMP(3),

    CONSTRAINT "firmware_upgrade_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "firmware_upgrade_runs_assetId_startedAt_idx" ON "firmware_upgrade_runs"("assetId", "startedAt");
CREATE INDEX "firmware_upgrade_runs_status_idx" ON "firmware_upgrade_runs"("status");

ALTER TABLE "firmware_upgrade_runs"
    ADD CONSTRAINT "firmware_upgrade_runs_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "firmware_upgrade_runs"
    ADD CONSTRAINT "firmware_upgrade_runs_imageId_fkey"
    FOREIGN KEY ("imageId") REFERENCES "firmware_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One live run per asset. The service checks first and answers 409; this is
-- what makes two clicks a second apart still produce one flash.
CREATE UNIQUE INDEX "firmware_upgrade_runs_active_key"
    ON "firmware_upgrade_runs"("assetId") WHERE "status" IN ('queued', 'running');
