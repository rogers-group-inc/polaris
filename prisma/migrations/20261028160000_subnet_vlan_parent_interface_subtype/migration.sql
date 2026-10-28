-- Business rule 137: the FortiGate interface a discovered network is served
-- on, and the interface its VLAN sits on, so two VLANs with one number on one
-- gate are told apart. Filled by the next FMG / FortiGate discovery run.
ALTER TABLE "subnets" ADD COLUMN "fortigateInterface" TEXT;
ALTER TABLE "subnets" ADD COLUMN "fortigateVlanParent" TEXT;

-- Which kind of bundle an "aggregate" interface is (FortiOS: aggregate,
-- redundant, hard-switch, switch, vap-switch). Filled by the next scrape.
ALTER TABLE "asset_interfaces" ADD COLUMN "ifSubtype" TEXT;
