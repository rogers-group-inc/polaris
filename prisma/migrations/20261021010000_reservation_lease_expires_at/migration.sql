-- Lease expiry for lease-backed FortiSwitch / FortiAP rows, 2026-10-21.
--
-- Phase 5 of discovery reads each lease's expiry from the FortiGate but could
-- not store it: expiresAt on a fortiswitch/fortinap row would hand the row to
-- expireReservations and churn a live device's reservation. This column holds
-- the gate's lease clock for display only, so the IP panel's Lease Expiry
-- column shows it. NULL on every other row.

ALTER TABLE "reservations" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
