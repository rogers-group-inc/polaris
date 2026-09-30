-- Serial-claim conflict review, 2026-09-22 (business rule 83).
--
-- One row per (managed device serial, claiming controller FortiGate). Discovery
-- re-asserts a claim on every pass; the sweep in
-- services/duplicateSerialConflictService.ts reads the FRESH ones and raises a
-- `serial-two-controllers` Conflict when one serial has two claimants that are
-- not the same gate.
--
-- Why a table and not a column: `asset_sources` is unique on
-- (source_kind, external_id) and external_id for a fortiswitch/fortiap IS the
-- serial, so the second gate's claim overwrote the first's with no trace. There
-- was nothing to detect the collision FROM.
--
-- Nothing is backfilled: a claim means "a gate said this on a discovery pass we
-- observed", and inventing one from the current topology stamp would assert
-- exactly the single-claimant view this table exists to stop trusting. Every
-- row arrives from the next discovery run, and the table is empty (so the sweep
-- silent) until then.
CREATE TABLE "asset_controller_claims" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "deviceSerial" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "controllerSerial" TEXT,
    "controllerDevice" TEXT NOT NULL,
    "controllerKey" TEXT NOT NULL,
    "integrationId" TEXT,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_controller_claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_controller_claims_deviceSerial_controllerKey_key"
    ON "asset_controller_claims"("deviceSerial", "controllerKey");

CREATE INDEX "asset_controller_claims_assetId_idx"
    ON "asset_controller_claims"("assetId");

-- The sweep's read: every fresh claim, grouped by the contested serial.
CREATE INDEX "asset_controller_claims_deviceSerial_lastSeen_idx"
    ON "asset_controller_claims"("deviceSerial", "lastSeen");

CREATE INDEX "asset_controller_claims_integrationId_idx"
    ON "asset_controller_claims"("integrationId");

ALTER TABLE "asset_controller_claims"
    ADD CONSTRAINT "asset_controller_claims_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "asset_controller_claims"
    ADD CONSTRAINT "asset_controller_claims_integrationId_fkey"
    FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
