-- VIP / load-balance Virtual Server reservations: owner is the VIP's name.
--
-- Discovery wrote owner "fortimanager-vip" / "fortimanager-vs" on every VIP row,
-- including rows learned through a standalone FortiGate integration with no
-- FortiManager anywhere. The owner is now the VIP / Virtual Server's own name
-- as the FortiGate config spells it, whichever integration found it.
--
-- Rows still carrying the old placeholder take the name from their vipInfo
-- snapshot. The VIP-succession paths (discovery Phase 5, subnetRefreshService's
-- retire branch) recognise the name — or the discovery-written hostname — as
-- the canonical owner, so rewritten rows keep converting cleanly. A row with no
-- snapshot to read the name from falls back to its hostname, which discovery
-- set to the same name.

UPDATE "reservations"
   SET "owner" = COALESCE(NULLIF("vipInfo"->>'name', ''), "hostname", "owner")
 WHERE "owner" IN ('fortimanager-vip', 'fortimanager-vs');
