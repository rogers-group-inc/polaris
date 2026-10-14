/**
 * src/services/userOwnershipService.ts — business rule 48(e): row ownership
 * dies with the account.
 *
 * Ownership on networks, reservations, credentials and address-book entries
 * is a bare `createdBy` username, compared to the caller's username by
 * `assertOwnership`. Deleting a user used to leave those rows stamped with
 * the name, so the next account to take it — a re-hire, or anyone a
 * `users:write` holder names that — inherited every row (2026-10-13 re-scan
 * F85). Deleting a user now rewrites those stamps to a TOMBSTONE no account
 * can carry: `deleted:<username>#<first 8 of the user id>`. The old name
 * stays readable; only a Full Read-Write holder can act on the rows, as for
 * any row someone else owns.
 *
 * `deleted:` is reserved: local accounts may not be named with it, and SSO /
 * LDAP provisioning cannot produce it (its usernames are `[a-z0-9._-]`).
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";

export const OWNERSHIP_TOMBSTONE_PREFIX = "deleted:";

/** The stamp a deleted user's rows carry. Pure. */
export function ownershipTombstone(username: string, userId: string): string {
  return `${OWNERSHIP_TOMBSTONE_PREFIX}${username}#${userId.slice(0, 8)}`;
}

/** Refuse (400) a username that could match a tombstone. */
export function assertUsernameNotReserved(username: string): void {
  if (username.trim().toLowerCase().startsWith(OWNERSHIP_TOMBSTONE_PREFIX)) {
    throw new AppError(400, `Usernames starting with "${OWNERSHIP_TOMBSTONE_PREFIX}" are reserved`);
  }
}

/**
 * Delete a user and tombstone the rows they own, in one transaction. Returns
 * how many rows of each kind moved to the tombstone.
 */
export async function deleteUserAndTombstoneOwnership(
  user: { id: string; username: string },
): Promise<{ subnets: number; reservations: number; credentials: number; contacts: number }> {
  const stamp = ownershipTombstone(user.username, user.id);
  const where = { createdBy: user.username };
  const [subnets, reservations, credentials, contacts] = await prisma.$transaction([
    prisma.subnet.updateMany({ where, data: { createdBy: stamp } }),
    prisma.reservation.updateMany({ where, data: { createdBy: stamp } }),
    prisma.credential.updateMany({ where, data: { createdBy: stamp } }),
    prisma.contact.updateMany({ where, data: { createdBy: stamp } }),
    prisma.user.delete({ where: { id: user.id } }),
  ] as const);
  return { subnets: subnets.count, reservations: reservations.count, credentials: credentials.count, contacts: contacts.count };
}
