-- Business rule 137's two subnet columns join the archive, so an archived
-- network keeps the FortiGate interface it was served on and the interface its
-- VLAN sat on. Nullable, no backfill: rows archived before this carry NULL
-- ("not recorded").
ALTER TABLE "archived_subnets" ADD COLUMN "fortigateInterface" TEXT;
ALTER TABLE "archived_subnets" ADD COLUMN "fortigateVlanParent" TEXT;
