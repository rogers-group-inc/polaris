-- Archived host pins on decommission (business rule 123), 2026-10-20.
--
-- While an agent host's asset is decommissioned, the SSH host keys and TLS
-- certificates Polaris pinned for its addresses are moved off ssh_host_keys /
-- tls_cert_pins and kept on its managed_agents row, then put back verbatim
-- when the asset returns. Both columns are NULL outside that state.

ALTER TABLE "managed_agents" ADD COLUMN "archivedHostPins" JSONB;
ALTER TABLE "managed_agents" ADD COLUMN "hostPinsArchivedAt" TIMESTAMP(3);

CREATE INDEX "managed_agents_hostPinsArchivedAt_idx" ON "managed_agents"("hostPinsArchivedAt");
