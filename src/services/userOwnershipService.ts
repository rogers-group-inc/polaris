/**
 * src/services/userOwnershipService.ts — business rule 48(e): row ownership
 * dies with the actor that held it — an account, or an API token.
 *
 * Ownership is a bare `createdBy` stamp compared to the caller's actor
 * (`requestActor`: a username, or `api:<token name>`) by `assertOwnership`
 * and, since rule 141(e), by the write scope (`inWriteScope`). Deleting a user
 * used to leave those rows stamped with the name, so the next account to take
 * it — a re-hire, or anyone a `users:write` holder names that — inherited
 * every row (2026-10-13 re-scan F85). Deleting a user now rewrites those
 * stamps to a TOMBSTONE no actor can carry:
 * `deleted:<username>#<first 8 of the user id>`. The old name stays readable;
 * only a Full Read-Write holder can act on the rows, as for any row someone
 * else owns.
 *
 * Widened 2026-11-11: rule 141(e) made `createdBy` decide write reach on
 * assets, maintenance windows, path checks and group firmware bookings too,
 * and made a token an owner (`api:<name>`), without widening the tombstone —
 * so a re-created account inherited the old one's devices, and a new token
 * given a deleted token's name inherited everything that token had created.
 * Every model whose `createdBy` is COMPARED is now listed in
 * `OWNED_MODELS`, and deleting a token tombstones its rows the same way
 * (`deleted:api:<name>#<first 8 of the token id>`).
 *
 * `deleted:` and `api:` are reserved: local accounts may not be named with
 * either, and SSO / LDAP provisioning cannot produce them (its usernames are
 * `[a-z0-9._-]`).
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";

export const OWNERSHIP_TOMBSTONE_PREFIX = "deleted:";
/** The prefix `requestActor` gives a bearer token: `api:<token name>`. */
const API_TOKEN_ACTOR_PREFIX = "api:";

/**
 * Every model whose `createdBy` is compared to the caller to decide whether
 * they may write the row (`assertOwnership`, `inWriteScope`,
 * `scheduleCanEditMap`, the group-firmware cancel). A model whose `createdBy`
 * is only DISPLAYED (automations, channels, scripts…) is deliberately absent:
 * the name there is history, not a grant.
 *
 * When a new surface starts comparing `createdBy`, add its model here — the
 * `ownedModelsCoverage` unit test fails on a comparison this list misses.
 */
export const OWNED_MODELS = [
  "subnet",
  "reservation",
  "credential",
  "contact",
  "asset",
  "maintenanceSchedule",
  "pathCheck",
  "firmwareGroupSchedule",
] as const;

export interface TombstoneCounts {
  subnets: number;
  reservations: number;
  credentials: number;
  contacts: number;
  assets: number;
  maintenanceSchedules: number;
  pathChecks: number;
  firmwareGroupSchedules: number;
}

/** How many rows moved to the tombstone, across every kind. Pure. */
export function tombstoneTotal(c: TombstoneCounts): number {
  return c.subnets + c.reservations + c.credentials + c.contacts + c.assets
    + c.maintenanceSchedules + c.pathChecks + c.firmwareGroupSchedules;
}

/** The stamp a deleted user's rows carry. Pure. */
export function ownershipTombstone(username: string, userId: string): string {
  return `${OWNERSHIP_TOMBSTONE_PREFIX}${username}#${userId.slice(0, 8)}`;
}

/** The actor a token's rows are stamped with (`requestActor`). Pure. */
export function apiTokenActor(tokenName: string): string {
  return `${API_TOKEN_ACTOR_PREFIX}${tokenName}`;
}

/** The stamp a deleted token's rows carry. Pure. */
export function tokenOwnershipTombstone(tokenName: string, tokenId: string): string {
  return ownershipTombstone(apiTokenActor(tokenName), tokenId);
}

/** Refuse (400) a username that could match a tombstone or a token's actor. */
export function assertUsernameNotReserved(username: string): void {
  const u = username.trim().toLowerCase();
  for (const prefix of [OWNERSHIP_TOMBSTONE_PREFIX, API_TOKEN_ACTOR_PREFIX]) {
    if (u.startsWith(prefix)) throw new AppError(400, `Usernames starting with "${prefix}" are reserved`);
  }
}

/** The eight rewrites, in `OWNED_MODELS` order, for one transaction. */
function tombstoneOps(actor: string, stamp: string) {
  const where = { createdBy: actor };
  const data = { createdBy: stamp };
  return [
    prisma.subnet.updateMany({ where, data }),
    prisma.reservation.updateMany({ where, data }),
    prisma.credential.updateMany({ where, data }),
    prisma.contact.updateMany({ where, data }),
    prisma.asset.updateMany({ where, data }),
    prisma.maintenanceSchedule.updateMany({ where, data }),
    prisma.pathCheck.updateMany({ where, data }),
    prisma.firmwareGroupSchedule.updateMany({ where, data }),
  ] as const;
}

function toCounts(r: readonly { count: number }[]): TombstoneCounts {
  return {
    subnets: r[0].count,
    reservations: r[1].count,
    credentials: r[2].count,
    contacts: r[3].count,
    assets: r[4].count,
    maintenanceSchedules: r[5].count,
    pathChecks: r[6].count,
    firmwareGroupSchedules: r[7].count,
  };
}

/**
 * Delete a user and tombstone the rows they own, in one transaction. Returns
 * how many rows of each kind moved to the tombstone.
 */
export async function deleteUserAndTombstoneOwnership(
  user: { id: string; username: string },
): Promise<TombstoneCounts> {
  const results = await prisma.$transaction([
    ...tombstoneOps(user.username, ownershipTombstone(user.username, user.id)),
    prisma.user.delete({ where: { id: user.id } }),
  ]);
  return toCounts(results as unknown as { count: number }[]);
}

/**
 * Delete an API token and tombstone the rows it created, in one transaction —
 * a token owns what it creates (rule 141(e)), and its name is free for reuse
 * the moment the row is gone.
 */
export async function deleteTokenAndTombstoneOwnership(
  token: { id: string; name: string },
): Promise<TombstoneCounts> {
  const results = await prisma.$transaction([
    ...tombstoneOps(apiTokenActor(token.name), tokenOwnershipTombstone(token.name, token.id)),
    prisma.apiToken.delete({ where: { id: token.id } }),
  ]);
  return toCounts(results as unknown as { count: number }[]);
}
