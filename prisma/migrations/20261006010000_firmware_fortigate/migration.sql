-- FortiGate firmware upgrades (business rule 87), 2026-10-06.
--
-- The repository's device types grow a third: "firewall". A FortiGate signs in
-- with a device-admin login like a switch, OR with a FortiOS API token — a
-- `restapi` Credential, or the token of the integration that discovered the
-- gate. The last has no Credential row, so a binding now says which it is.

ALTER TABLE "firmware_images" DROP CONSTRAINT "firmware_images_asset_type_check";
ALTER TABLE "firmware_images"
    ADD CONSTRAINT "firmware_images_asset_type_check"
    CHECK ("assetType" IN ('switch', 'access_point', 'firewall'));

ALTER TABLE "firmware_credential_bindings" DROP CONSTRAINT "firmware_credential_bindings_type_check";
ALTER TABLE "firmware_credential_bindings"
    ADD CONSTRAINT "firmware_credential_bindings_type_check"
    CHECK ("assetType" IS NULL OR "assetType" IN ('switch', 'access_point', 'firewall'));

ALTER TABLE "firmware_credential_bindings" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'credential';
ALTER TABLE "firmware_credential_bindings"
    ADD CONSTRAINT "firmware_credential_bindings_source_check"
    CHECK ("source" IN ('credential', 'integration-token'));
-- The integration's token signs in to a FortiGate and nothing else, and it is
-- not a Credential: no row to point at.
ALTER TABLE "firmware_credential_bindings"
    ADD CONSTRAINT "firmware_credential_bindings_token_scope_check"
    CHECK ("source" = 'credential' OR ("assetType" = 'firewall' AND "credentialId" IS NULL));
