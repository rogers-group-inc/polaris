-- New sourceType for an IPv6 address a FortiGate sees a client USING but did
-- not assign — a SLAAC or statically-configured address read from the device
-- inventory or the FortiSwitch detected-device table — business rule 125.
-- Written by services/discovery/discoveryEngine.ts (Phase 7c) with an
-- expiresAt the next sighting pushes forward, so expireReservations ages it
-- out once the address stops being seen. Never pushed to a device.
--
-- ADD VALUE IF NOT EXISTS for the dns_resolved migration's reason: idempotent
-- when the type was altered by hand on a recovery path.

ALTER TYPE "ReservationSourceType" ADD VALUE IF NOT EXISTS 'observed';
