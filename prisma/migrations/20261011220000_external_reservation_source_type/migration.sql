-- New sourceType for an address allocated in ANOTHER IPAM (phpIPAM, NetBox,
-- an internal allocation system) and read by a Generic API integration's
-- network query — business rule 100(j). Written by
-- services/discovery/genericApiNetworkSync.ts; never pushed to a device.
--
-- ADD VALUE IF NOT EXISTS for the dns_resolved migration's reason: idempotent
-- when the type was altered by hand on a recovery path.

ALTER TYPE "ReservationSourceType" ADD VALUE IF NOT EXISTS 'external';
