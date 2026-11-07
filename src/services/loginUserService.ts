/**
 * src/services/loginUserService.ts — the User reads and writes the sign-in
 * flows make (password step, TOTP step, passkey sign-in, passkey second
 * factor, forced password change) and `/auth/me`.
 *
 * Extracted from src/api/routes/auth.ts on 2026-11-06 (CQ-B044, part 3). The
 * sign-in routes interleave these with session regeneration, the pending-MFA
 * token, the lockout counter and passkey ceremonies, and all of THAT stays in
 * the route, in its original order: this module is deliberately only the data
 * access plus the one decision the routes used to spell twice (the first-login
 * role-review stamp).
 */

import { prisma } from "../db.js";
import { hashPassword } from "../utils/password.js";

/** A user row with its role joined — the shape every sign-in step reads. */
export async function findUserWithRoleByUsername(username: string) {
  return prisma.user.findUnique({ where: { username }, include: { role: true } });
}

/** The same, by id (the TOTP / passkey / forced-change steps and /auth/me). */
export async function findUserWithRoleById(id: string) {
  return prisma.user.findUnique({ where: { id }, include: { role: true } });
}

export interface SuccessfulLoginOptions {
  /**
   * Stamp `needsRoleReview` when this is the account's FIRST login and it is
   * not an admin. Only the first step of a sign-in may ask: by the second
   * factor this write has already set `lastLogin`, so "first" can no longer
   * be seen. An admin reviewing their own role is noise (the first-run wizard
   * creates the seed admin this way).
   */
  stampFirstLogin?: boolean;
  /** Re-hash the password with the current parameters (the stored ones were weaker). */
  rehashPassword?: string;
  /** The backup codes left after one was spent at the TOTP step. */
  remainingBackupCodes?: string[] | null;
}

/** Record a successful sign-in step: `lastLogin`, plus whatever the step owes. */
export async function recordSuccessfulLogin(
  user: { id: string; lastLogin: Date | null; role: { name: string } },
  opts: SuccessfulLoginOptions = {},
): Promise<void> {
  const data: { lastLogin: Date; passwordHash?: string; needsRoleReview?: boolean; totpBackupCodes?: string[] } =
    { lastLogin: new Date() };
  if (opts.rehashPassword !== undefined) data.passwordHash = await hashPassword(opts.rehashPassword);
  if (opts.stampFirstLogin && user.lastLogin === null && user.role.name !== "admin") data.needsRoleReview = true;
  if (opts.remainingBackupCodes) data.totpBackupCodes = opts.remainingBackupCodes;
  await prisma.user.update({ where: { id: user.id }, data });
}

/** The forced password change's write (rule 61's policy check is the caller's, before this). */
export async function setPasswordHash(userId: string, newPassword: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword) } });
}
