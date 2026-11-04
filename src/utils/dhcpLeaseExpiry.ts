/**
 * src/utils/dhcpLeaseExpiry.ts — keep an existing DHCP row's `expiresAt` in
 * step with what the gate reports on every discovery pass.
 *
 * Discovery used to stamp `expiresAt` only when it CREATED a `dhcp_lease` row.
 * A device that renewed its lease kept the row's original expiry, so
 * `expireStaleReservations` retired a live lease, the next pass re-created it
 * under a new id, and everything keyed on the row id saw a new binding — the
 * duplicate-reservation sweep (rule 139) closed and re-raised its conflict,
 * logging the same "holds N DHCP bindings" notice once per lease period.
 *
 * The rule: a lease row carries the gate's current lease end; any other DHCP
 * source (a reservation, a FortiSwitch / FortiAP row) never expires on a clock.
 * Pure — the caller folds the patch into the write it already makes.
 */

/** Ignore jitter below this when comparing lease ends, so a steady state writes nothing. */
const LEASE_EXPIRY_TOLERANCE_MS = 60_000;

/**
 * The `expiresAt` change an existing DHCP row needs, or `null` when it has the
 * right value already. `proposedExpiresAt` is the gate's lease end for a lease
 * entry (undefined when the gate reported none — the row is then left alone).
 */
export function dhcpExpiryPatch(
  existingExpiresAt: Date | null | undefined,
  proposedSourceType: string,
  proposedExpiresAt: Date | undefined,
): { expiresAt: Date | null } | null {
  if (proposedSourceType !== "dhcp_lease") {
    return existingExpiresAt ? { expiresAt: null } : null;
  }
  if (!proposedExpiresAt || Number.isNaN(proposedExpiresAt.getTime())) return null;
  if (
    existingExpiresAt &&
    Math.abs(existingExpiresAt.getTime() - proposedExpiresAt.getTime()) < LEASE_EXPIRY_TOLERANCE_MS
  ) {
    return null;
  }
  return { expiresAt: proposedExpiresAt };
}
